import { request as httpRequest } from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import { startNeMcpHttpServer, validateHttpOptions } from "../src/http.js";
import type { NeMcpHttpServer } from "../src/http.js";
import { TOOL_NAMES } from "../src/tools.js";
import { clone, loadWireDemo } from "./helpers.js";
import type { WireDemo } from "./helpers.js";

const STACK = /\n\s+at |node_modules|\/home\/|\.ts:\d+/;

let server: NeMcpHttpServer;
let demo: WireDemo;
const logLines: string[] = [];

beforeAll(async () => {
  demo = await loadWireDemo();
  server = await startNeMcpHttpServer({ port: 0, log: (line) => logLines.push(line) });
});

afterAll(async () => {
  await server.close();
});

interface RpcReply {
  readonly status: number;
  readonly message: any;
  readonly text: string;
}

async function post(body: unknown, headers: Record<string, string> = {}): Promise<RpcReply> {
  const res = await fetch(server.mcpUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let message: unknown = undefined;
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const data = text.split("\n").filter((line) => line.startsWith("data: "));
    if (data.length > 0) message = JSON.parse(data.at(-1)!.slice(6));
  } else if (text.length > 0) {
    message = JSON.parse(text);
  }
  return { status: res.status, message, text };
}

const LEGACY = { "mcp-protocol-version": "2025-11-25" };

async function legacyCall(name: string, args: unknown, id = 10): Promise<any> {
  const reply = await post({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }, LEGACY);
  expect(reply.status).toBe(200);
  return reply.message;
}

function rawRequest(path: string, headers: Record<string, string>, method = "GET"): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port: server.port, path, method, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("HTTP host", () => {
  it("binds loopback only and refuses non-loopback configuration", () => {
    expect(server.host).toBe("127.0.0.1");
    for (const host of ["0.0.0.0", "::", "192.168.1.10", "example.com"]) {
      expect(() => validateHttpOptions({ host })).toThrow(/loopback/);
    }
    expect(() => validateHttpOptions({ maxBodyBytes: 64 * 1024 * 1024 })).toThrow(/maxBodyBytes/);
  });

  it("serves /healthz with a static, non-evidential body", async () => {
    const res = await fetch(`${server.url}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ status: "ok", tools: [...TOOL_NAMES], readOnly: true, liveObservation: false, networkIo: "none" });
    expect(body.mode).toBe("local");
    expect(body.scope).toBe("local v0; not a public endpoint");
    expect(server.mode).toBe("local");
    expect((await fetch(`${server.url}/health`)).status).toBe(404); // Hosted-only Cloud Run health alias
  });

  it("rejects DNS-rebinding Host and foreign Origin headers", async () => {
    expect((await rawRequest("/healthz", { host: "evil.example" })).status).toBe(403);
    expect((await rawRequest("/mcp", { host: `localhost:${server.port}`, origin: "https://evil.example" }, "POST")).status).toBe(403);
    expect((await rawRequest("/healthz", { host: `localhost:${server.port}` })).status).toBe(200);
    // Caller-supplied forwarding headers never widen the loopback Host check.
    expect((await rawRequest("/healthz", { host: "evil.example", "x-forwarded-host": "localhost" })).status).toBe(403);
  });

  it("accepts only the exact same-port loopback Origin (cross-port localhost pages are refused)", async () => {
    const host = `127.0.0.1:${server.port}`;
    for (const origin of [`http://127.0.0.1:${server.port}`, `http://localhost:${server.port}`, `http://[::1]:${server.port}`]) {
      expect((await rawRequest("/healthz", { host, origin })).status, origin).toBe(200);
    }
    const otherPort = server.port === 65535 ? 65534 : server.port + 1;
    for (const origin of [
      `http://localhost:${otherPort}`,
      `http://127.0.0.1:${otherPort}`,
      "http://localhost",
      "http://localhost:6274",
      `https://localhost:${server.port}`,
      `http://localhost:${server.port}/`,
      "null",
    ]) {
      expect((await rawRequest("/healthz", { host, origin })).status, origin).toBe(403);
    }
  });

  it("fails closed on content type, duplicate keys, malformed JSON and oversized bodies", async () => {
    const wrongType = await post("{}", { "content-type": "text/plain" });
    expect(wrongType.status).toBe(415);
    const dup = await post('{"jsonrpc":"2.0","id":1,"id":2,"method":"tools/list"}');
    expect(dup.status).toBe(400);
    expect(dup.message.error.code).toBe(-32700);
    const malformed = await post('{"jsonrpc":"2.0",');
    expect(malformed.status).toBe(400);
    const small = await startNeMcpHttpServer({ port: 0, maxBodyBytes: 2048 });
    try {
      const res = await fetch(small.mcpUrl, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { pad: "x".repeat(4096) } }),
      });
      expect(res.status).toBe(413);
    } finally {
      await small.close();
    }
    for (const reply of [wrongType, dup, malformed]) expect(reply.text).not.toMatch(STACK);
  });

  it("answers 405 for GET /mcp (stateless) and 404 elsewhere", async () => {
    expect((await fetch(server.mcpUrl, { headers: { accept: "text/event-stream" } })).status).toBe(405);
    expect((await fetch(`${server.url}/etc/passwd`)).status).toBe(404);
  });

  it("logs only method, route, status and duration", () => {
    expect(logLines.length).toBeGreaterThan(0);
    for (const line of logLines) {
      expect(line).toMatch(/^(GET|POST|HEAD|DELETE|PUT|\?) (\/mcp|\/healthz|\(other\)) \d{3} \d+ms$|^mcp (handler|adapter) error: \w+$/);
    }
  });
});

describe("raw MCP JSON-RPC (Inspector-style): initialize -> tools/list -> tools/call", () => {
  it("negotiates via initialize and lists exactly three read-only tools", async () => {
    const init = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "raw-inspector", version: "0" } },
    });
    expect(init.status).toBe(200);
    expect(init.message.result.protocolVersion).toBe("2025-11-25");
    expect(init.message.result.serverInfo).toEqual({ name: "network-evidence-mcp", version: "0.0.1" });
    expect(init.message.result.capabilities).toHaveProperty("tools");
    expect(init.message.result.instructions).toMatch(/performs no network I\/O/);

    const initialized = await post({ jsonrpc: "2.0", method: "notifications/initialized" }, LEGACY);
    expect(initialized.status).toBe(202);

    const list = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, LEGACY);
    const tools = list.message.result.tools as any[];
    expect(tools.map((t) => t.name)).toEqual([...TOOL_NAMES]);
    for (const tool of tools) {
      expect(tool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.outputSchema.type).toBe("object");
    }
    const discover = tools.find((t) => t.name === "discover_network_candidates");
    expect(discover.inputSchema.required).toEqual(["requestId", "generatedAt", "requirements", "candidates"]);
    expect(discover.inputSchema.properties.candidates.maxItems).toBe(16);
    expect(discover.inputSchema.properties.candidates.items.required).toEqual(["id", "environment", "network", "manifest", "snapshot"]);
    const caseTool = tools.find((t) => t.name === "get_reviewed_evidence_case");
    expect(caseTool.inputSchema.properties.caseId.enum).toEqual(["f1", "f2", "f3", "synthetic-local-core-golden"]);
  });

  it("tools/call positive: profiles, discovery and a synthetic case", async () => {
    const profiles = await legacyCall("list_network_profiles", {});
    expect(profiles.result.isError).toBeUndefined();
    expect(profiles.result.structuredContent.profiles).toHaveLength(5);
    expect(JSON.parse(profiles.result.content[0].text)).toEqual(profiles.result.structuredContent);

    const discovery = await legacyCall("discover_network_candidates", demo.wire);
    expect(discovery.result.isError).toBeUndefined();
    const out = discovery.result.structuredContent;
    expect(out.liveObservation).toBe(false);
    expect(out.candidates.map((c: any) => [c.id, c.classification])).toEqual([
      ["base-mainnet", "eligible"],
      ["base-sepolia", "conditional"],
      ["solana-devnet", "ineligible"],
      ["solana-mainnet", "eligible"],
    ]);

    const synthetic = await legacyCall("get_reviewed_evidence_case", { caseId: "synthetic-local-core-golden" });
    expect(synthetic.result.structuredContent.evidenceClass).toBe("synthetic-local-fixture");
    expect(synthetic.result.structuredContent.label).toMatch(/not a network observation/);
    expect(synthetic.result.structuredContent.liveObservation).toBe(false);
  });

  it("tools/call negative: invalid contexts, paths, unknown ids and unknown tools fail closed", async () => {
    const mismatch = clone(demo.wire) as any;
    mismatch.candidates[0].network.chainId = 1;
    const bad = await legacyCall("discover_network_candidates", mismatch);
    expect(bad.result.isError).toBe(true);
    expect(JSON.parse(bad.result.content[0].text).error.code).toBe("MCP_CANDIDATE_NETWORK_MISMATCH");

    // Attempt to make the ARCHIVED replay look currently available: Core's self-digest rejects it.
    const tampered = clone(demo.wire) as any;
    const archived = tampered.candidates.find((c: any) => c.id === "solana-devnet");
    expect(archived.snapshot.evidenceCapabilities.execution.availability).toBe("unknown");
    archived.snapshot.evidenceCapabilities.execution.availability = "available";
    const tamperedReply = await legacyCall("discover_network_candidates", tampered);
    expect(tamperedReply.result.isError).toBe(true);
    expect(JSON.parse(tamperedReply.result.content[0].text).error.code).toBe("MCP_WIRE_DECODE_FAILED");

    const empty = await legacyCall("discover_network_candidates", { ...demo.wire, candidates: [] });
    expect(empty.result.isError).toBe(true);

    const pathy = await legacyCall("get_reviewed_evidence_case", { caseId: "../../../etc/passwd" });
    expect(pathy.result.isError).toBe(true);
    const extra = await legacyCall("get_reviewed_evidence_case", { caseId: "f1", path: "/etc/passwd" });
    expect(extra.result.isError).toBe(true);
    const profilesWithArgs = await legacyCall("list_network_profiles", { url: "https://example.com" });
    expect(profilesWithArgs.result.isError).toBe(true);

    const unknownTool = await legacyCall("fetch_url", { url: "https://example.com" });
    expect(unknownTool.error).toBeDefined();

    for (const reply of [bad, tamperedReply, empty, pathy, extra, profilesWithArgs, unknownTool]) {
      expect(JSON.stringify(reply)).not.toMatch(STACK);
    }
  });
});

describe("official MCP SDK client (@modelcontextprotocol/client 2.3.1)", () => {
  for (const mode of ["legacy", "auto"] as const) {
    it(`${mode} negotiation: list tools and call positive + negative`, async () => {
      const client = new Client({ name: `ne-mcp-test-${mode}`, version: "0" }, { versionNegotiation: { mode } });
      await client.connect(new StreamableHTTPClientTransport(new URL(server.mcpUrl)));
      try {
        expect(client.getProtocolEra()).toBe(mode === "legacy" ? "legacy" : "modern");
        const { tools } = await client.listTools();
        expect(tools.map((t) => t.name)).toEqual([...TOOL_NAMES]);
        for (const tool of tools) {
          expect(tool.annotations?.readOnlyHint).toBe(true);
          expect(tool.annotations?.destructiveHint).toBe(false);
          expect(tool.annotations?.openWorldHint).toBe(false);
        }

        const f1 = await client.callTool({ name: "get_reviewed_evidence_case", arguments: { caseId: "f1" } });
        expect(f1.isError).toBeFalsy();
        const f1Out = f1.structuredContent as any;
        expect(f1Out.evidenceClass).toBe("historical-reviewed-public-network-fixture");
        expect(f1Out.currentAvailability).toBe("unknown");

        const discovery = await client.callTool({ name: "discover_network_candidates", arguments: demo.wire as any });
        expect(discovery.isError).toBeFalsy();
        expect((discovery.structuredContent as any).coreVerification.reverifiedAtMcpBoundary).toBe(true);

        const dupId = clone(demo.wire) as any;
        dupId.candidates[1].id = dupId.candidates[0].id;
        const rejected = await client.callTool({ name: "discover_network_candidates", arguments: dupId });
        expect(rejected.isError).toBe(true);
        expect(JSON.parse((rejected.content as any)[0].text).error.code).toBe("DISCOVERY_CANDIDATE_ID_DUPLICATE");

        const unknownCase = await client.callTool({ name: "get_reviewed_evidence_case", arguments: { caseId: "f9" } });
        expect(unknownCase.isError).toBe(true);
      } finally {
        await client.close();
      }
    });
  }
});
