import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import { startNeMcpHttpServer } from "../src/http.js";
import { createMultichainTool } from "../src/live-multichain.js";
import { LIVE_TOOL_NAMES, TOOL_NAMES } from "../src/tools.js";
import type { NeMcpHttpServer } from "../src/http.js";

const servers: NeMcpHttpServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

describe("opt-in local live MCP", () => {
  it("keeps the local default offline with exactly 3 tools", async () => {
    const server = await startNeMcpHttpServer({ port: 0 });
    servers.push(server);
    const health = await (await fetch(server.url + "/healthz")).json() as Record<string, unknown>;
    expect(health).toMatchObject({ mode: "local", liveObservation: false, networkIo: "none", tools: [...TOOL_NAMES] });
  });

  it("offers 6 read-only tools over loopback with explicit injected live resolver, never widens Host/Origin", async () => {
    let actualRpcReads = 0;
    const fakeFetch: typeof fetch = (async () => {
      actualRpcReads += 1;
      throw new Error("Live provider network is denied in this test");
    }) as typeof fetch;
    const server = await startNeMcpHttpServer({ port: 0, liveEvidence: createMultichainTool(fakeFetch) });
    servers.push(server);
    expect(server.host).toBe("127.0.0.1");
    expect(server.mode).toBe("local");
    for (const forbiddenHost of ["0.0.0.0", "::", "192.168.1.9"]) {
      await expect(startNeMcpHttpServer({
        host: forbiddenHost, port: 0, liveEvidence: createMultichainTool(fakeFetch),
      })).rejects.toThrow(/loopback/);
    }
    const health = await (await fetch(server.url + "/healthz")).json() as Record<string, unknown>;
    expect(health).toMatchObject({ mode: "local", liveObservation: true, networkIo: "bounded_evm_solana_rpc", tools: [...LIVE_TOOL_NAMES] });
    expect((await fetch(server.url + "/health")).status).toBe(404);

    const foreignHostStatus = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ hostname: "127.0.0.1", port: server.port, path: "/healthz", headers: { host: "evil.example" } }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      });
      req.on("error", reject);
      req.end();
    });
    expect(foreignHostStatus).toBe(403);
    expect((await fetch(server.url + "/healthz", { headers: { origin: "https://untrusted.example" } })).status).toBe(403);
    expect((await fetch(server.url + "/healthz", { headers: { origin: "http://127.0.0.1:1" } })).status).toBe(403);
    expect((await fetch(server.url + "/healthz", { headers: { origin: server.url } })).status).toBe(200);

    const client = new Client({ name: "local-live-qa", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(server.mcpUrl)));
    try {
      const { tools } = await client.listTools();
      expect(new Set(tools.map((tool) => tool.name))).toEqual(new Set(LIVE_TOOL_NAMES));
      expect(tools.every((tool) => tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint === false)).toBe(true);
      const historical = await client.callTool({ name: "get_reviewed_evidence_case", arguments: { caseId: "f2" } });
      expect(historical.isError).not.toBe(true);
      expect((historical.structuredContent as Record<string, unknown>).liveObservation).toBe(false);
      const invalid = await client.callTool({
        name: "resolve_transaction_evidence",
        arguments: { subject: { type: "transaction", networkId: "eip155:84532", txId: "not-a-tx-hash" } },
      });
      expect(invalid.isError).toBe(true);
      expect(actualRpcReads).toBe(0);
    } finally {
      await client.close();
    }
  });
});
