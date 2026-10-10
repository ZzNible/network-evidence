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
const TX = "0x8e01aace01ced4155b30d636b547727becdbb8a700f9b7f54ed02c4d629ae696";
const HOST = "mcp.example.org";
const ORIGIN = "https://mcp.example.org";
const ERROR_TEXT = "SECRET_INTERNAL_PROVIDER_MESSAGE_NEVER_EXPOSED";

function provider(overrides: { chain?: string; receipt?: unknown; block?: unknown; transaction?: unknown; redirect?: string; oversized?: boolean } = {}) {
  const methods: string[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const req = JSON.parse(init?.body as string) as { method: string; id: number };
    methods.push(req.method);
    const responseBody = overrides.oversized
      ? "x".repeat(LIVE_EVM_MAX_RPC_BYTES + 1)
      : JSON.stringify({ jsonrpc: "2.0", id: req.id, result:
        req.method === "eth_chainId" ? (overrides.chain ?? "0x2105")
          : req.method === "eth_getBlockByHash" ? (overrides.block ?? null)
          : req.method === "eth_getTransactionByHash" ? (overrides.transaction ?? null)
          : (overrides.receipt ?? null) });
    const result = new Response(responseBody, { status: 200, headers: { "content-type": "application/json" } });
    Object.defineProperty(result, "url", { value: overrides.redirect ?? new URL(url).href });
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

  it("preserves null receipt as insufficient and makes only chainId + receipt reads", async () => {
    const p = provider();
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

  it("returns a validated supported fragment for coherent mined receipt+block through the modern MCP SDK", async () => {
    const fixture = JSON.parse(readFileSync(
      new URL("../../resolver-evm/test/fixtures/sepolia-success.json", import.meta.url), "utf8",
    )) as { captures: { resultJson: string }[] };
    const oldTx = "0x" + "1".repeat(64);
    const receipt = JSON.parse(fixture.captures[1]!.resultJson.replaceAll(oldTx, TX));
    const block = JSON.parse(fixture.captures[2]!.resultJson.replaceAll(oldTx, TX));
    const transaction = {
      hash: TX, nonce: "0x0", blockHash: receipt.blockHash,
      blockNumber: receipt.blockNumber, transactionIndex: receipt.transactionIndex,
      from: receipt.from, to: receipt.to, value: "0x0",
      gas: "0x5208", input: "0x",
    };
    const p = provider({ receipt, block, transaction });
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

  it("fails closed on a mismatched chain ID without asking for a receipt", async () => {
    const p = provider({ chain: "0x1" });
    await expect(createLiveEvmTool(p.fetchFn)({ network: "base-mainnet", txHash: TX }))
      .rejects.toMatchObject({ code: "MCP_LIVE_EVM_RPC_FAILED" });
    expect(p.methods).toEqual(["eth_chainId"]);
  });

  it("rejects provider redirect, oversized bodies, invalid tx hash without leaking upstream content", async () => {
    const p = provider({ redirect: "https://evil.example/mcp" });
    await expect(createLiveEvmTool(p.fetchFn)({network:"base-mainnet",txHash:TX})).rejects.toMatchObject({code:"MCP_LIVE_EVM_RPC_FAILED"});
    expect(p.methods).toEqual(["eth_chainId"]);
    const giant = provider({ oversized: true });
    await expect(createLiveEvmTool(giant.fetchFn)({network:"base-mainnet",txHash:TX})).rejects.toMatchObject({code:"MCP_LIVE_EVM_RPC_FAILED"});
    expect(giant.methods).toHaveLength(1);
    const malicious: typeof fetch = async () => { throw new Error(ERROR_TEXT); };
    let err: any;
    try { await createLiveEvmTool(malicious)({network:"base-mainnet",txHash:TX}); } catch(e) { err=e; }
    expect(err?.code).toBe("MCP_LIVE_EVM_RPC_FAILED");
    expect(JSON.stringify({name:err.name,message:err.message})).not.toContain(ERROR_TEXT);
    await expect(createLiveEvmTool(provider().fetchFn)({network:"base-mainnet",txHash:"0xAB" })).rejects.toMatchObject({code:"MCP_LIVE_EVM_INPUT"});
  });

  it("bounds live RPC acquisitions independently of the general MCP request budget", async () => {
    const p = provider();
    const query = createLiveEvmTool(p.fetchFn);
    for (let i=0; i<8; i++) {
      const x=await query({ network:"base-mainnet", txHash:TX });
      expect(x.acquisition.receiptObserved).toBe(false);
    }
    expect(p.methods).toHaveLength(16);
    await expect(query({network:"base-mainnet",txHash:TX})).rejects.toMatchObject({code:"MCP_LIVE_EVM_RATE_LIMIT"});
    expect(p.methods).toHaveLength(16);
  });

  it("exposes exactly one extra truthful open-world tool in explicit hosted opt-in mode", async () => {
    const p = provider();
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
