import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startNeMcpHttpServer } from "../src/http.js";
import type { NeMcpHttpServer } from "../src/http.js";
import { createLiveEvmTool, restrictedBaseRpcFetch, LIVE_EVM_MAX_RPC_BYTES } from "../src/live-evm.js";
import { createMultichainTool, LIVE_MULTICHAIN_TOOL } from "../src/live-multichain.js";
import { simulatedHostFetch } from "./helpers.js";

const MAINNET = "https://mainnet.base.org";
const SEPOLIA = "https://sepolia.base.org";
// Real recorded Base mainnet capture of the x402 #1062 USDC transfer (F1
// authority fixture): subject, chain ID, receipt, block and transaction all
// come from this one capture; no identifier is paired with foreign bytes.
const F1 = JSON.parse(readFileSync(new URL(
  "../../../examples/historical-compat/authority/fixtures/F1-x402-1062-partial/source/network-evidence/fixtures/base-mainnet-x402-1062-usdc-transfer.fixture.json",
  import.meta.url), "utf8")) as {
  source: { networkId: string; chainId: number }; subject: { txHash: string };
  captures: { rpcMethod: string; rpcParams: unknown[]; resultJson: string }[];
};
const TX = F1.subject.txHash;
const HOST = "mcp.example.org";
const ORIGIN = "https://mcp.example.org";
const ERROR_TEXT = "SECRET_INTERNAL_PROVIDER_MESSAGE_NEVER_EXPOSED";

/**
 * Offline replay: serves the F1 capture's exact resultJson bytes per
 * rpcMethod for the exact recorded params (no live read). Each option is a
 * SIMULATED negative, used only by tests titled SIMULATED:
 * - nullReceipt: receipt and transaction answers replaced by null.
 * - chain: the eth_chainId answer replaced by this value.
 * - redirect: the response URL replaced by this value.
 * - oversized: the body replaced by LIVE_EVM_MAX_RPC_BYTES + 1 bytes.
 * Any origin other than Base mainnet gets a SIMULATED null result; it only
 * exercises origin admission and is never Base mainnet evidence.
 */
function provider(simulated: { nullReceipt?: boolean; chain?: string; redirect?: string; oversized?: boolean } = {}) {
  const methods: string[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const req = JSON.parse(init?.body as string) as { method: string; id: number; params?: unknown[] };
    methods.push(req.method);
    let resultText = "null";
    if (new URL(url).href === new URL(MAINNET).href) {
      const found = F1.captures.find(c => c.rpcMethod === req.method);
      if (!found) throw Error("Unexpected mock Base method");
      if (JSON.stringify(req.params ?? []) !== JSON.stringify(found.rpcParams)) throw Error("Unexpected mock Base params");
      resultText = found.resultJson;
      if (req.method === "eth_chainId" && simulated.chain !== undefined) resultText = JSON.stringify(simulated.chain);
      if ((req.method === "eth_getTransactionReceipt" || req.method === "eth_getTransactionByHash") && simulated.nullReceipt) resultText = "null";
    }
    const responseBody = simulated.oversized
      ? "x".repeat(LIVE_EVM_MAX_RPC_BYTES + 1)
      : `{"jsonrpc":"2.0","id":${JSON.stringify(req.id)},"result":${resultText}}`;
    const result = new Response(responseBody, { status: 200, headers: { "content-type": "application/json" } });
    Object.defineProperty(result, "url", { value: simulated.redirect ?? new URL(url).href });
    return result;
  };
  return { methods, fetchFn };
}

describe("opt-in read-only live EVM source", () => {
  it("defaults to offline; never makes a fetch or exposes a fourth tool", async () => {
    const server = await startNeMcpHttpServer({ port: 0 });
    try {
      const health = await (await fetch(server.url + "/healthz")).json() as any;
      expect(health).toMatchObject({ liveObservation: false, networkIo: "none" });
      expect(health.tools).toHaveLength(3);
      await expect(startNeMcpHttpServer({ port: 0, liveEvidence: createMultichainTool(provider().fetchFn) })).rejects.toThrow(/hosted mode/);
    } finally { await server.close(); }
  });

  it("accepts exactly two known origins and the strict read-only method allowlist, rejecting SSRF and methods that write", async () => {
    const p = provider();
    const scoped = restrictedBaseRpcFetch(p.fetchFn, "base-mainnet");
    const read = JSON.stringify({ jsonrpc: "2.0", method: "eth_chainId", id: 1 });
    const write = JSON.stringify({ jsonrpc: "2.0", method: "eth_sendRawTransaction", id: 1 });
    await expect(scoped("https://127.0.0.1/admin", { method: "POST", body: read })).rejects.toMatchObject({code:"MCP_LIVE_EVM_RPC_FAILED"});
    await expect(scoped("https://mainnet.base.org.evil.tld", { method: "POST", body: read })).rejects.toMatchObject({code:"MCP_LIVE_EVM_RPC_FAILED"});
    await expect(scoped(MAINNET + "/private", { method: "POST", body: read })).rejects.toMatchObject({code:"MCP_LIVE_EVM_RPC_FAILED"});
    await expect(scoped(MAINNET, { method: "GET", body: read })).rejects.toMatchObject({code:"MCP_LIVE_EVM_RPC_FAILED"});
    await expect(scoped(MAINNET, { method: "POST", body: write })).rejects.toMatchObject({code:"MCP_LIVE_EVM_RPC_FAILED"});
    await expect(scoped(MAINNET, { method: "POST", body: JSON.stringify({jsonrpc:"2.0",id:1,method:"eth_getTransactionReceipt",params:[]}) })).rejects.toMatchObject({code:"MCP_LIVE_EVM_RPC_FAILED"});
    await expect(scoped(MAINNET, { method: "POST", body: JSON.stringify({jsonrpc:"2.0",id:1,method:"eth_getBlockByHash",params:[TX,true]}) })).rejects.toMatchObject({code:"MCP_LIVE_EVM_RPC_FAILED"});
    expect(p.methods).toEqual([]);
    const valid = await scoped(MAINNET + "/", { method: "POST", body: read });
    expect(valid.status).toBe(200);
    expect(p.methods).toEqual(["eth_chainId"]);
    const q = restrictedBaseRpcFetch(provider().fetchFn, "base-sepolia");
    await expect(q(MAINNET, { method: "POST", body: read })).rejects.toMatchObject({code:"MCP_LIVE_EVM_RPC_FAILED"});
    await expect(q(SEPOLIA + "/", { method: "POST", body: read })).resolves.toHaveProperty("status",200);
  });

  it("SIMULATED null receipt: preserves it as insufficient and makes only chainId + receipt reads", async () => {
    const p = provider({ nullReceipt: true });
    const value = await createLiveEvmTool(p.fetchFn)({ network: "base-mainnet", txHash: TX });
    expect(p.methods).toEqual(["eth_chainId","eth_getTransactionReceipt"]);
    expect(value).toMatchObject({
      liveObservation: true, observationBasis: "source_observation",
      networkId: "eip155:8453", acquisition: { receiptObserved: false, blockObserved: false, consistent: true },
    });
    expect((value.fragment as any).networkEvidence.execution.verdict).toBe("insufficient");
    expect((value.fragment as any).networkEvidence).not.toHaveProperty("finality");
    expect((value.fragment as any).networkEvidence).not.toHaveProperty("settlement");
    expect(value.acquisition.captures).toHaveLength(2);
    expect(value.nonClaims.some(x => x.includes("untrusted provider-supplied DATA"))).toBe(true);
    expect(value.acquisition.captures.every(x=> x.contentDigest.startsWith("sha256:"))).toBe(true);
    expect(JSON.stringify(value)).not.toContain(MAINNET);
  });

  it("returns a validated supported fragment for the recorded real F1 Base mainnet capture (offline replay) through the modern MCP SDK", async () => {
    expect(TX).toBe("0x8e01aace01ced4155b30d636b547727becdbb8a700f9b7f54ed02c4d629ae696");
    expect(F1.source).toMatchObject({ networkId: "eip155:8453", chainId: 8453 });
    const p = provider();
    const server = await startNeMcpHttpServer({
      host: "127.0.0.1", port: 0, hosted: {publicOrigin: ORIGIN},
      liveEvidence: createMultichainTool(p.fetchFn),
    });
    try {
      const transport = new StreamableHTTPClientTransport(new URL(ORIGIN + "/mcp"),{fetch:simulatedHostFetch(server.port, HOST)});
      const client = new Client({name:"live-mcp-modern-test",version:"1"},{versionNegotiation:{mode:"auto"}});
      await client.connect(transport);
      try {
        expect(client.getProtocolEra()).toBe("modern");
        const result = await client.callTool({name:LIVE_MULTICHAIN_TOOL,arguments:{subject:{type:"transaction",networkId:"eip155:8453",txId:TX}}});
        expect(result.isError).toBeFalsy();
        const value = result.structuredContent as any;
        expect(value.acquisition).toMatchObject({transactionObserved:true,blockObserved:true,consistent:true});
        expect(value.acquisition.captures.map((x:any)=>x.rpcMethod)).toEqual(["eth_chainId","eth_getTransactionReceipt","eth_getBlockByHash","eth_getTransactionByHash"]);
        expect(value.fragment.networkEvidence.execution.verdict).toBe("supported");
        expect(value.fragment.networkEvidence.dataBinding.verdict).toBe("supported");
        expect(value.fragment.networkEvidence).not.toHaveProperty("finality");
        expect(value.fragment.networkEvidence).not.toHaveProperty("settlement");
        expect(p.methods).toEqual(["eth_chainId","eth_getTransactionReceipt","eth_getBlockByHash","eth_getTransactionByHash"]);
      } finally { await client.close(); }
    } finally { await server.close(); }
  });

  it("SIMULATED wrong chain ID: fails closed without asking for a receipt", async () => {
    const p = provider({ chain: "0x1" });
    await expect(createLiveEvmTool(p.fetchFn)({ network: "base-mainnet", txHash: TX }))
      .rejects.toMatchObject({ code: "MCP_LIVE_EVM_RPC_FAILED" });
    expect(p.methods).toEqual(["eth_chainId"]);
  });

  it("SIMULATED redirect/oversized/throwing provider: rejects them and invalid tx hash without leaking upstream content", async () => {
    const p = provider({ redirect: "https://evil.example/mcp" });
    await expect(createLiveEvmTool(p.fetchFn)({network:"base-mainnet",txHash:TX})).rejects.toMatchObject({code:"MCP_LIVE_EVM_RPC_FAILED"});
    expect(p.methods).toEqual(["eth_chainId"]);
    const giant = provider({ oversized: true });
    // NE-L014 (H-10a fixed): the guard's oversize code is retained out of band.
    await expect(createLiveEvmTool(giant.fetchFn)({network:"base-mainnet",txHash:TX})).rejects.toMatchObject({code:"MCP_LIVE_EVM_TOO_LARGE"});
    expect(giant.methods).toHaveLength(1);
    const malicious: typeof fetch = async () => { throw new Error(ERROR_TEXT); };
    let err: any;
    try { await createLiveEvmTool(malicious)({network:"base-mainnet",txHash:TX}); } catch(e) { err=e; }
    expect(err?.code).toBe("MCP_LIVE_EVM_RPC_FAILED");
    expect(JSON.stringify({name:err.name,message:err.message})).not.toContain(ERROR_TEXT);
    await expect(createLiveEvmTool(provider().fetchFn)({network:"base-mainnet",txHash:"0xAB" })).rejects.toMatchObject({code:"MCP_LIVE_EVM_INPUT"});
  });

  it("SIMULATED null receipts: bounds live RPC acquisitions independently of the general MCP request budget", async () => {
    const p = provider({ nullReceipt: true });
    const query = createLiveEvmTool(p.fetchFn);
    for (let i=0; i<8; i++) {
      const x=await query({ network:"base-mainnet", txHash:TX });
      expect(x.acquisition.receiptObserved).toBe(false);
    }
    expect(p.methods).toHaveLength(16);
    await expect(query({network:"base-mainnet",txHash:TX})).rejects.toMatchObject({code:"MCP_LIVE_EVM_RATE_LIMIT"});
    expect(p.methods).toHaveLength(16);
  });

  it("SIMULATED null receipt: exposes exactly one extra truthful open-world tool in explicit hosted opt-in mode", async () => {
    const p = provider({ nullReceipt: true });
    const server: NeMcpHttpServer = await startNeMcpHttpServer({
      host: "127.0.0.1", port: 0, hosted: { publicOrigin: ORIGIN },
      liveEvidence: createMultichainTool(p.fetchFn),
    });
    try {
      const fetchLocal = simulatedHostFetch(server.port, HOST);
      const health = await (await fetchLocal(new URL(ORIGIN + "/health"))).json() as any;
      expect(health.tools).toContain(LIVE_MULTICHAIN_TOOL);
      expect(health.liveObservation).toBe(true);
      expect(health.networkIo).toBe("bounded_evm_solana_rpc");
      const client = new Client({name:"live-mcp-test",version:"1"}, {versionNegotiation:{mode:"legacy"}});
      await client.connect(new StreamableHTTPClientTransport(new URL(ORIGIN + "/mcp"),{fetch:fetchLocal}));
      try {
        const {tools} = await client.listTools();
        expect(tools.map(x=>x.name)).toEqual(["list_network_profiles","discover_network_candidates","get_reviewed_evidence_case","preflight_live_network_evidence","discover_live_network_evidence",LIVE_MULTICHAIN_TOOL]);
        const live = tools.find(x=>x.name===LIVE_MULTICHAIN_TOOL)!;
        expect(live.annotations).toMatchObject({readOnlyHint:true,destructiveHint:false,idempotentHint:false,openWorldHint:true});
        const result = await client.callTool({name:LIVE_MULTICHAIN_TOOL,arguments:{subject:{type:"transaction",networkId:"eip155:8453",txId:TX}}});
        expect(result.isError).toBeFalsy();
        expect((result.structuredContent as any).acquisition.transactionObserved).toBe(false);
        expect(p.methods).toEqual(["eth_chainId","eth_getTransactionReceipt","eth_getTransactionByHash"]);
        const prior = p.methods.length;
        const invalid = await client.callTool({name:LIVE_MULTICHAIN_TOOL,arguments:{subject:{type:"transaction",networkId:"eip155:57057",txId:TX}}});
        expect(invalid.isError).toBe(true);
        expect(p.methods.length).toBe(prior);
      } finally {await client.close();}
    } finally {await server.close();}
  });
});
