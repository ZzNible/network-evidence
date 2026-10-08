/**
 * Opt-in hosted mode: configuration refusal, exact Host/Origin admission over
 * genuine HTTP requests (simulated public Host as an HTTPS-terminating
 * platform forwards it), MCP protocol through hosted guards (raw JSON-RPC and
 * the official SDK client, both eras), and the global abuse limiter.
 *
 * Hostnames are RFC 2606 documentation names (example.org / example.net):
 * simulated, never a real deployment URL.
 */

import { request as httpRequest } from "node:http";
import { connect } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import { HOSTED_BIND_HOST, resolveServeConfig, validateHostedOrigin } from "../src/hosted.js";
import { HEALTH_SCOPE, startNeMcpHttpServer, validateHttpOptions } from "../src/http.js";
import type { NeMcpHttpServer } from "../src/http.js";
import { GlobalAbuseLimiter, HOSTED_DEFAULT_LIMITS, LOCAL_DEFAULT_LIMITS, resolveLimits } from "../src/limits.js";
import { TOOL_NAMES } from "../src/tools.js";
import { clone, loadWireDemo, simulatedHostFetch } from "./helpers.js";
import type { WireDemo } from "./helpers.js";

const PUBLIC_ORIGIN = "https://mcp.example.org";
const PUBLIC_HOST = "mcp.example.org";
const CUSTOM_ORIGIN = "https://evidence.example.net";
const CUSTOM_HOST = "evidence.example.net";
const STACK = /\n\s+at |node_modules|\/home\/|\.ts:\d+/;
const DEFAULTS = { host: "127.0.0.1", port: 4178 };

interface Reply {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

function send(port: number, path: string, method: string, headers: Record<string, string>, body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const all = { ...headers, ...(body === undefined ? {} : { "content-length": String(Buffer.byteLength(body)) }) };
    const req = httpRequest({ host: "127.0.0.1", port, path, method, headers: all }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

function rpcMessage(reply: Reply): any {
  if (String(reply.headers["content-type"] ?? "").includes("text/event-stream")) {
    const data = reply.body.split("\n").filter((line) => line.startsWith("data: "));
    return JSON.parse(data.at(-1)!.slice(6));
  }
  return reply.body.length > 0 ? JSON.parse(reply.body) : undefined;
}

const JSON_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const LEGACY = { ...JSON_HEADERS, "mcp-protocol-version": "2025-11-25" };

describe("hosted configuration fails closed", () => {
  it("accepts only an exact canonical public https origin", () => {
    expect(validateHostedOrigin(PUBLIC_ORIGIN, "X")).toBe(PUBLIC_HOST);
    expect(validateHostedOrigin("https://ne-mcp-1.onrender-like.example.com", "X")).toBe("ne-mcp-1.onrender-like.example.com");
    const bad = [
      undefined,
      "",
      "mcp.example.org",
      "http://mcp.example.org",
      "https://mcp.example.org/",
      "https://mcp.example.org/mcp",
      "https://mcp.example.org?x=1",
      "https://mcp.example.org#x",
      "https://mcp.example.org:443",
      "https://mcp.example.org:8443",
      "https://MCP.example.org",
      "https://user:pw@mcp.example.org",
      "https://*.example.org",
      "https://*",
      "https://1.2.3.4",
      "https://[::1]",
      "https://localhost",
      "https://app.localhost",
      "https://printer.local",
      "https://svc.internal",
      "https://intranet",
      "https://mcp.example.org.",
      "https://x.test",
      "https://-bad.example.org",
    ];
    for (const value of bad) expect(() => validateHostedOrigin(value, "NE_MCP_PUBLIC_ORIGIN"), String(value)).toThrow(/NE_MCP_PUBLIC_ORIGIN/);
  });

  it("CLI/env resolution: local by default, hosted only with the explicit flag + origin + PORT", () => {
    expect(resolveServeConfig([], {}, DEFAULTS)).toMatchObject({ mode: "local", host: "127.0.0.1", port: 4178 });
    // PORT (platform variable) does not move a local server.
    expect(resolveServeConfig([], { PORT: "10000" }, DEFAULTS)).toMatchObject({ mode: "local", host: "127.0.0.1", port: 4178 });
    expect(resolveServeConfig(["--port", "4300"], {}, DEFAULTS)).toMatchObject({ mode: "local", port: 4300 });

    const hosted = resolveServeConfig([], { NE_MCP_MODE: "hosted", NE_MCP_PUBLIC_ORIGIN: PUBLIC_ORIGIN, PORT: "10000" }, DEFAULTS);
    expect(hosted).toMatchObject({ mode: "hosted", host: HOSTED_BIND_HOST, port: 10000, hosted: { publicOrigin: PUBLIC_ORIGIN } });
    expect(HOSTED_BIND_HOST).toBe("0.0.0.0");

    const refuse: [string[], Record<string, string>, RegExp][] = [
      [[], { NE_MCP_MODE: "public" }, /NE_MCP_MODE/],
      [[], { NE_MCP_MODE: "HOSTED", NE_MCP_PUBLIC_ORIGIN: PUBLIC_ORIGIN, PORT: "1" }, /NE_MCP_MODE/],
      [[], { NE_MCP_PUBLIC_ORIGIN: PUBLIC_ORIGIN }, /not "hosted"/],
      [[], { NE_MCP_MODE: "local", NE_MCP_CUSTOM_ORIGIN: CUSTOM_ORIGIN }, /not "hosted"/],
      [[], { NE_MCP_MODE: "hosted", PORT: "10000" }, /NE_MCP_PUBLIC_ORIGIN is required/],
      [[], { NE_MCP_MODE: "hosted", NE_MCP_PUBLIC_ORIGIN: PUBLIC_ORIGIN }, /requires PORT/],
      [[], { NE_MCP_MODE: "hosted", NE_MCP_PUBLIC_ORIGIN: PUBLIC_ORIGIN, PORT: "0" }, /1\.\.65535/],
      [[], { NE_MCP_MODE: "hosted", NE_MCP_PUBLIC_ORIGIN: PUBLIC_ORIGIN, PORT: "70000" }, /1\.\.65535/],
      [[], { NE_MCP_MODE: "hosted", NE_MCP_PUBLIC_ORIGIN: PUBLIC_ORIGIN, PORT: "10000x" }, /decimal/],
      [[], { NE_MCP_MODE: "hosted", NE_MCP_PUBLIC_ORIGIN: PUBLIC_ORIGIN, PORT: "10000", NE_MCP_HOST: "0.0.0.0" }, /refused/],
      [[], { NE_MCP_MODE: "hosted", NE_MCP_PUBLIC_ORIGIN: PUBLIC_ORIGIN, PORT: "10000", NE_MCP_PORT: "1" }, /refused/],
      [["--host", "::"], { NE_MCP_MODE: "hosted", NE_MCP_PUBLIC_ORIGIN: PUBLIC_ORIGIN, PORT: "10000" }, /refused/],
      [[], { NE_MCP_MODE: "hosted", NE_MCP_PUBLIC_ORIGIN: "https://*.onrender.com", PORT: "10000" }, /wildcard/],
      [[], { NE_MCP_MODE: "hosted", NE_MCP_PUBLIC_ORIGIN: "http://localhost:10000", PORT: "10000" }, /https/],
      [[], { NE_MCP_MODE: "hosted", NE_MCP_PUBLIC_ORIGIN: PUBLIC_ORIGIN, NE_MCP_CUSTOM_ORIGIN: PUBLIC_ORIGIN, PORT: "10000" }, /differ/],
      [[], { NE_MCP_MODE: "hosted", NE_MCP_PUBLIC_ORIGIN: PUBLIC_ORIGIN, NE_MCP_CUSTOM_ORIGIN: "https://127.0.0.1", PORT: "1" }, /NE_MCP_CUSTOM_ORIGIN/],
      [[], { NE_MCP_RATE_LIMIT_PER_MINUTE: "-1" }, /decimal/],
    ];
    for (const [argv, env, pattern] of refuse) expect(() => resolveServeConfig(argv, env, DEFAULTS), JSON.stringify(env)).toThrow(pattern);
  });

  it("server options: hosted never binds a non-loopback address other than 0.0.0.0; local stays loopback-only", () => {
    expect(validateHttpOptions({ hosted: { publicOrigin: PUBLIC_ORIGIN } })).toMatchObject({ mode: "hosted", host: "0.0.0.0" });
    expect(validateHttpOptions({}).limits).toEqual(LOCAL_DEFAULT_LIMITS);
    expect(validateHttpOptions({ hosted: { publicOrigin: PUBLIC_ORIGIN } }).limits).toEqual(HOSTED_DEFAULT_LIMITS);
    expect(validateHttpOptions({}).maxBodyBytes).toBeLessThanOrEqual(1_048_576);
    for (const host of ["::", "192.168.1.10", "example.com"]) {
      expect(() => validateHttpOptions({ host, hosted: { publicOrigin: PUBLIC_ORIGIN } })).toThrow(/hosted mode binds/);
    }
    expect(() => validateHttpOptions({ host: "0.0.0.0" })).toThrow(/loopback/);
    expect(() => validateHttpOptions({ hosted: { publicOrigin: "https://localhost" } })).toThrow(/localhost-class/);
    expect(() => validateHttpOptions({ limits: { maxConcurrent: 0 } })).toThrow(/maxConcurrent/);
    expect(() => validateHttpOptions({ limits: { maxConcurrent: 65 } })).toThrow(/maxConcurrent/);
    expect(() => validateHttpOptions({ limits: { maxRequestsPerMinute: 6001 } })).toThrow(/maxRequestsPerMinute/);
  });
});

describe("GlobalAbuseLimiter (no caller identity)", () => {
  it("enforces a fixed 60 s window and a concurrency ceiling with idempotent release", () => {
    let now = 1_000;
    const limiter = new GlobalAbuseLimiter(resolveLimits({ maxConcurrent: 2, maxRequestsPerMinute: 3 }, HOSTED_DEFAULT_LIMITS), () => now);
    const a = limiter.admit();
    const b = limiter.admit();
    expect(a.ok && b.ok).toBe(true);
    const c = limiter.admit();
    expect(c).toEqual({ ok: false, retryAfterSeconds: 1 }); // concurrency
    if (a.ok) {
      a.release();
      a.release();
    }
    expect(limiter.current.inFlight).toBe(1);
    const d = limiter.admit();
    expect(d.ok).toBe(true);
    if (d.ok) d.release();
    if (b.ok) b.release();
    now += 15_000;
    expect(limiter.admit()).toEqual({ ok: false, retryAfterSeconds: 45 }); // window budget (3) spent
    now += 45_000;
    const e = limiter.admit();
    expect(e.ok).toBe(true);
    expect(limiter.current).toEqual({ inFlight: 1, windowCount: 1 });
    expect(Object.keys(limiter).sort()).toEqual(["inFlight", "limits", "now", "windowCount", "windowStart"]);
  });
});

describe("hosted mode over genuine HTTP (0.0.0.0 bind, simulated public Host)", () => {
  let server: NeMcpHttpServer;
  let demo: WireDemo;
  const logLines: string[] = [];
  const H = { host: PUBLIC_HOST };

  beforeAll(async () => {
    demo = await loadWireDemo();
    server = await startNeMcpHttpServer({
      port: 0,
      hosted: { publicOrigin: PUBLIC_ORIGIN, customOrigin: CUSTOM_ORIGIN },
      log: (line) => logLines.push(line),
    });
  });

  afterAll(async () => {
    await server.close();
  });

  it("binds 0.0.0.0 and reports the hosted-preview scope on /healthz", async () => {
    expect(server.mode).toBe("hosted");
    expect(server.host).toBe("0.0.0.0");
    const res = await send(server.port, "/healthz", "GET", H);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({ status: "ok", mode: "hosted", readOnly: true, liveObservation: false, networkIo: "none", tools: [...TOOL_NAMES] });
    expect(body.scope).toBe(HEALTH_SCOPE.hosted);
    expect(body.scope).toMatch(/not a reviewed production service/);
    expect(JSON.stringify(body)).not.toMatch(/https?:\/\//);
  });

  it("admits only the exact configured Host names", async () => {
    expect((await send(server.port, "/healthz", "GET", { host: CUSTOM_HOST })).status).toBe(200);
    expect((await send(server.port, "/healthz", "GET", { host: "MCP.Example.ORG" })).status).toBe(200);
    for (const host of [
      `127.0.0.1:${server.port}`,
      `localhost:${server.port}`,
      "localhost",
      `[::1]:${server.port}`,
      `0.0.0.0:${server.port}`,
      `${PUBLIC_HOST}:443`,
      `${PUBLIC_HOST}:${server.port}`,
      `evil.${PUBLIC_HOST}`,
      `${PUBLIC_HOST}.evil.example`,
      "evil.example",
      "*",
    ]) {
      const res = await send(server.port, "/mcp", "POST", { ...LEGACY, host }, '{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
      expect(res.status, host).toBe(403);
      expect(res.body, host).not.toContain(host.replace(/:\d+$/, ""));
    }
  });

  it("never trusts caller-supplied X-Forwarded-* / Forwarded headers", async () => {
    const spoof = {
      "x-forwarded-host": PUBLIC_HOST,
      "x-forwarded-proto": "https",
      "x-forwarded-for": "203.0.113.7",
      forwarded: `host=${PUBLIC_HOST};proto=https`,
    };
    expect((await send(server.port, "/healthz", "GET", { host: "evil.example", ...spoof })).status).toBe(403);
    expect((await send(server.port, "/healthz", "GET", { host: `localhost:${server.port}`, ...spoof })).status).toBe(403);
    expect((await send(server.port, "/healthz", "GET", { host: PUBLIC_HOST, "x-forwarded-host": "evil.example" })).status).toBe(200);
  });

  it("refuses a request without any Host header (HTTP/1.0)", async () => {
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = connect(server.port, "127.0.0.1", () => socket.end("GET /healthz HTTP/1.0\r\n\r\n"));
      let text = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => (text += chunk));
      socket.on("end", () => resolve(text));
      socket.on("error", reject);
    });
    expect(raw).toMatch(/^HTTP\/1\.[01] 403/);
  });

  it("Origin: absent passes (server-to-server); any present value must be an exact configured https origin", async () => {
    const list = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}';
    expect((await send(server.port, "/mcp", "POST", { ...LEGACY, ...H }, list)).status).toBe(200);
    expect((await send(server.port, "/mcp", "POST", { ...LEGACY, ...H, origin: PUBLIC_ORIGIN }, list)).status).toBe(200);
    expect((await send(server.port, "/mcp", "POST", { ...LEGACY, ...H, origin: CUSTOM_ORIGIN }, list)).status).toBe(200);
    for (const origin of [
      "http://mcp.example.org",
      "https://mcp.example.org:8443",
      "https://mcp.example.org/",
      "https://MCP.example.org",
      "https://evil.example",
      "https://mcp.example.org.evil.example",
      `http://localhost:${server.port}`,
      `http://127.0.0.1:${server.port}`,
      "http://localhost",
      "null",
      "*",
      "",
    ]) {
      const res = await send(server.port, "/mcp", "POST", { ...LEGACY, ...H, origin }, list);
      expect(res.status, origin).toBe(403);
      if (origin.length > 4) expect(res.body, origin).not.toContain(origin);
    }
  });

  it("raw JSON-RPC (2025 era) initialize -> initialized -> tools/list -> tools/call through hosted guards", async () => {
    const init = await send(
      server.port,
      "/mcp",
      "POST",
      { ...JSON_HEADERS, ...H },
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "hosted-raw", version: "0" } },
      }),
    );
    expect(init.status).toBe(200);
    const initMsg = rpcMessage(init);
    expect(initMsg.result.protocolVersion).toBe("2025-11-25");
    expect(initMsg.result.serverInfo).toEqual({ name: "network-evidence-mcp", version: "0.0.1" });
    expect(initMsg.result.instructions).toContain("hosted preview");
    expect(initMsg.result.instructions).toContain("read-only, offline");
    expect(initMsg.result.instructions).not.toMatch(/— local,/);
    expect((await send(server.port, "/mcp", "POST", { ...LEGACY, ...H }, '{"jsonrpc":"2.0","method":"notifications/initialized"}')).status).toBe(202);
    const list = rpcMessage(await send(server.port, "/mcp", "POST", { ...LEGACY, ...H }, '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'));
    expect(list.result.tools.map((t: any) => t.name)).toEqual([...TOOL_NAMES]);
    expect(list.result.tools.find((t: any) => t.name === "discover_network_candidates").inputSchema.properties.candidates.maxItems).toBe(16);

    const call = async (name: string, args: unknown) =>
      rpcMessage(
        await send(server.port, "/mcp", "POST", { ...LEGACY, ...H }, JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: args } })),
      );
    const discovery = await call("discover_network_candidates", demo.wire);
    expect(discovery.result.isError).toBeUndefined();
    expect(discovery.result.structuredContent.liveObservation).toBe(false);
    expect(discovery.result.structuredContent.coreVerification.resultArtifactDigest).toBe(
      "sha256:d85c2fe5ff876acf3413a25986b6a78b2eaac7fc66cc998193e72deb14dee68b",
    );
    const f2 = await call("get_reviewed_evidence_case", { caseId: "f2" });
    expect(f2.result.structuredContent.currentAvailability).toBe("unknown");
    expect(f2.result.structuredContent.liveObservation).toBe(false);

    const pathy = await call("get_reviewed_evidence_case", { caseId: "../../etc/passwd" });
    expect(pathy.result.isError).toBe(true);
    const tooMany = clone(demo.wire) as any;
    tooMany.candidates = Array.from({ length: 17 }, (_, i) => ({ ...tooMany.candidates[0], id: `c${i}` }));
    expect((await call("discover_network_candidates", tooMany)).result.isError).toBe(true);
    const unknownTool = await call("fetch_url", { url: "https://example.com" });
    expect(unknownTool.error).toBeDefined();
    for (const reply of [pathy, unknownTool]) expect(JSON.stringify(reply)).not.toMatch(STACK);
  });

  it("malformed requests fail closed exactly as in local mode", async () => {
    expect((await send(server.port, "/mcp", "POST", { ...LEGACY, ...H, "content-type": "text/plain" }, "{}")).status).toBe(415);
    const dup = await send(server.port, "/mcp", "POST", { ...LEGACY, ...H }, '{"jsonrpc":"2.0","id":1,"id":2,"method":"tools/list"}');
    expect(dup.status).toBe(400);
    expect(JSON.parse(dup.body).error.code).toBe(-32700);
    expect((await send(server.port, "/mcp", "POST", { ...LEGACY, ...H }, '{"jsonrpc":')).status).toBe(400);
    const big = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { pad: "x".repeat(1_048_576) } });
    expect((await send(server.port, "/mcp", "POST", { ...LEGACY, ...H }, big)).status).toBe(413);
    expect((await send(server.port, "/mcp", "GET", { ...H, accept: "text/event-stream" })).status).toBe(405);
    expect((await send(server.port, "/etc/passwd", "GET", H)).status).toBe(404);
    for (const line of logLines) {
      expect(line).toMatch(/^(GET|POST|HEAD|DELETE|PUT|\?) (\/mcp|\/healthz|\(other\)) \d{3} \d+ms$|^mcp (handler|adapter) error: \w+$/);
      expect(line).not.toMatch(/example|127\.0\.0\.1|203\.0\.113/);
    }
  });

  for (const mode of ["legacy", "auto"] as const) {
    it(`official SDK client (${mode}) through the hosted guards: list + positive + negative calls`, async () => {
      const client = new Client({ name: `ne-mcp-hosted-${mode}`, version: "0" }, { versionNegotiation: { mode } });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`https://${PUBLIC_HOST}/mcp`), { fetch: simulatedHostFetch(server.port, PUBLIC_HOST) }),
      );
      try {
        expect(client.getProtocolEra()).toBe(mode === "legacy" ? "legacy" : "modern");
        const { tools } = await client.listTools();
        expect(tools.map((t) => t.name)).toEqual([...TOOL_NAMES]);
        const profiles = (await client.callTool({ name: "list_network_profiles", arguments: {} })).structuredContent as any;
        expect(profiles.profiles.every((p: any) => p.capabilities.every((c: any) => c.currentAvailability === "not_assessed"))).toBe(true);
        const synthetic = (await client.callTool({ name: "get_reviewed_evidence_case", arguments: { caseId: "synthetic-local-core-golden" } }))
          .structuredContent as any;
        expect(synthetic.evidenceClass).toBe("synthetic-local-fixture");
        const archived = clone(demo.wire) as any;
        archived.candidates.find((c: any) => c.id === "solana-devnet").snapshot.evidenceCapabilities.execution.availability = "available";
        const rejected = await client.callTool({ name: "discover_network_candidates", arguments: archived });
        expect(rejected.isError).toBe(true);
        expect(JSON.parse((rejected.content as any)[0].text).error.code).toBe("MCP_WIRE_DECODE_FAILED");
      } finally {
        await client.close();
      }
    });
  }

  it("the SDK client is refused when it reaches the server under a foreign Host", async () => {
    const client = new Client({ name: "ne-mcp-hosted-foreign", version: "0" }, { versionNegotiation: { mode: "legacy" } });
    await expect(
      client.connect(new StreamableHTTPClientTransport(new URL("https://evil.example/mcp"), { fetch: simulatedHostFetch(server.port, "evil.example") })),
    ).rejects.toThrow();
    await client.close();
  });
});

describe("hosted abuse controls over genuine HTTP", () => {
  const list = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}';
  const H = { host: PUBLIC_HOST };

  it("global rate budget answers 429 with Retry-After; /healthz stays available", async () => {
    const server = await startNeMcpHttpServer({ port: 0, host: "127.0.0.1", hosted: { publicOrigin: PUBLIC_ORIGIN }, limits: { maxRequestsPerMinute: 3 } });
    try {
      for (let i = 0; i < 3; i += 1) expect((await send(server.port, "/mcp", "POST", { ...LEGACY, ...H }, list)).status).toBe(200);
      const limited = await send(server.port, "/mcp", "POST", { ...LEGACY, ...H }, list);
      expect(limited.status).toBe(429);
      const retry = Number(limited.headers["retry-after"]);
      expect(Number.isInteger(retry) && retry >= 1 && retry <= 60).toBe(true);
      expect(JSON.parse(limited.body).error.message).toMatch(/Too Many Requests/);
      // A foreign Host is refused before it can consume or observe the budget.
      expect((await send(server.port, "/mcp", "POST", { ...LEGACY, host: "evil.example" }, list)).status).toBe(403);
      expect((await send(server.port, "/healthz", "GET", H)).status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it("global concurrency ceiling answers 429 while a request is in flight, then recovers", async () => {
    const server = await startNeMcpHttpServer({ port: 0, host: "127.0.0.1", hosted: { publicOrigin: PUBLIC_ORIGIN }, limits: { maxConcurrent: 1 } });
    try {
      // Hold one /mcp request open: headers sent, body incomplete.
      let held: Promise<Reply> | undefined;
      let finishHeld: () => void = () => {};
      held = new Promise<Reply>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: server.port, path: "/mcp", method: "POST", headers: { ...LEGACY, ...H, "content-length": String(list.length) } },
          (res) => {
            let text = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => (text += chunk));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
          },
        );
        req.on("error", reject);
        req.write(list.slice(0, 5));
        req.flushHeaders();
        finishHeld = () => req.end(list.slice(5));
      });
      let limited: Reply | undefined;
      for (let attempt = 0; attempt < 100 && limited === undefined; attempt += 1) {
        const res = await send(server.port, "/mcp", "POST", { ...LEGACY, ...H }, list);
        if (res.status === 429) limited = res;
        else await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(limited?.status).toBe(429);
      expect(limited?.headers["retry-after"]).toBe("1");
      finishHeld();
      expect((await held).status).toBe(200);
      expect((await send(server.port, "/mcp", "POST", { ...LEGACY, ...H }, list)).status).toBe(200);
    } finally {
      await server.close();
    }
  });
});
