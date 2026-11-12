import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { decodeNecWireJson } from "@nec/core";
import { startNeMcpHttpServer } from "../src/http.js";
import { createMultichainTool, LIVE_MULTICHAIN_TOOL } from "../src/live-multichain.js";
import { createLiveBeforeTool, LIVE_BEFORE_TOOL_NAME } from "../src/live-before.js";
import { simulatedHostFetch } from "./helpers.js";

const ORIGIN = "https://mcp.example.org";
const HOST = "mcp.example.org";
const BASE_ID = "eip155:8453";
const SOLANA_ID = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
// Real pinned Base mainnet capture: subject, receipt, block and transaction
// all come from this one fixture; no identifier is paired with foreign bytes.
const evm = JSON.parse(readFileSync(new URL("./fixtures/base-mainnet-l2-finalized-positive-evm.json", import.meta.url), "utf8")) as
  { source: { networkId: string; chainId: number }; subject: { txHash: string };
    captures: { rpcMethod: string; rpcParams: unknown[]; resultJson: string }[] };
const TX = evm.subject.txHash;
const SYNTHETIC_OTHER_TX = "0x" + "f".repeat(64);
const sol = JSON.parse(readFileSync(new URL("../../resolver-solana/test/fixtures/solana-mainnet-x402-real.json", import.meta.url), "utf8")) as
  { subject: { signature: string }; captures: { rpcMethod: string; resultJson: string }[] };
const EVM_SUBJECT = { type: "transaction", networkId: BASE_ID, txId: TX } as const;
const SOL_SUBJECT = { type: "transaction", networkId: SOLANA_ID, txId: sol.subject.signature } as const;
const REQUIREMENTS = { requirements: [
  { capability: "execution", strength: "required" },
  { capability: "finality", strength: "desired" },
] };
const INPUT = { requestId: "ne_mcp_live_before_fixture_1", requirements: REQUIREMENTS, subjects: [EVM_SUBJECT, SOL_SUBJECT] };

/**
 * Serves the real pinned captures verbatim (exact resultJson bytes) for the
 * exact recorded params. Each option is a SYNTHETIC, documented mutation of
 * that real capture, used only by tests titled SYNTHETIC:
 * - missingEvmReceipt: receipt and transaction responses replaced by null.
 * - wrongEvmTx: the real transaction response with only `hash` replaced by
 *   a non-real all-f hash (no real identifier is introduced).
 * - wrongEvmChain: the eth_chainId response replaced by 0x14a34 (84532).
 * - solanaStatus / missingSolanaBlock: real Solana status/block responses
 *   with confirmationStatus "confirmed", value [null], or a null block.
 */
function mockedSources(missingEvmReceipt = false, options: {
  wrongEvmTx?: boolean;
  wrongEvmChain?: boolean;
  solanaStatus?: "confirmed" | "null";
  missingSolanaBlock?: boolean;
} = {}) {
  const methods: string[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const query = JSON.parse(init?.body as string) as {id:number; method:string; params?:unknown[]};
    methods.push(query.method);
    let resultText: string;
    if (url.includes("mainnet.base.org")) {
      const found = evm.captures.find(c => c.rpcMethod === query.method);
      if (!found) throw Error("Unexpected mock Base method");
      if (JSON.stringify(query.params ?? []) !== JSON.stringify(found.rpcParams)) throw Error("Unexpected mock Base params");
      resultText = found.resultJson;
      if (query.method === "eth_chainId" && options.wrongEvmChain) resultText = JSON.stringify("0x14a34");
      if (query.method === "eth_getTransactionReceipt" && missingEvmReceipt) resultText = "null";
      if (query.method === "eth_getTransactionByHash" && missingEvmReceipt) resultText = "null";
      if (query.method === "eth_getTransactionByHash" && options.wrongEvmTx) {
        resultText = JSON.stringify({...JSON.parse(found.resultJson) as Record<string,unknown>, hash:SYNTHETIC_OTHER_TX});
      }
    } else if (url.includes("api.mainnet-beta.solana.com")) {
      const found = sol.captures.find(c => c.rpcMethod === query.method);
      if (!found) throw Error("Unexpected mock Solana method");
      let result: unknown = JSON.parse(found.resultJson);
      if (query.method === "getSignatureStatuses" && options.solanaStatus === "confirmed") {
        (result as {value:{confirmationStatus:string}[]}).value[0]!.confirmationStatus = "confirmed";
      }
      if (query.method === "getSignatureStatuses" && options.solanaStatus === "null") {
        (result as {value:unknown[]}).value = [null];
      }
      if (query.method === "getBlock" && options.missingSolanaBlock) result = null;
      resultText = JSON.stringify(result);
    } else throw Error("Unapproved fake endpoint");
    const response = new Response(`{"jsonrpc":"2.0","id":${JSON.stringify(query.id)},"result":${resultText}}`, {
      status:200, headers:{"content-type":"application/json"},
    });
    Object.defineProperty(response,"url",{value:new URL(url).href});
    return response;
  };
  return {fetchFn,methods};
}

const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async () => {
    throw new Error("network I/O is forbidden in live-before tests");
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("opt-in live BEFORE/Discovery over exact multichain source acquisitions", () => {
  it("builds two Core-verified candidate snapshots and classifies through the existing Discovery engine", async () => {
    expect(TX).toBe("0x71c9e27a7195bdecf1c63e73d5f959c96ddb35a27f6f1308835494c3156d625c");
    expect(evm.source).toMatchObject({networkId:BASE_ID,chainId:8453});
    const m=mockedSources();
    const out=await createLiveBeforeTool(createMultichainTool(m.fetchFn))(INPUT);
    expect(out).toMatchObject({
      schema:"ne-mcp-live-discovery/v0.1",observationKind:"live_source_observation",
      builtAndVerifiedBy:"@nec/discovery + @nec/core",
    });
    const [base,solana]=out.candidates;
    // Same classifications as the previous synthetic-bytes mock: the real Base
    // capture yields execution/dataBinding available, generic EVM finality
    // unsupported, hence conditional with finality only desired.
    expect(out.candidates.map(c=>[c.id,c.classification])).toEqual([
      ["base-mainnet","conditional"],["solana-mainnet","eligible"],
    ]);
    expect(base?.capabilities.execution.availability).toBe("available");
    expect(base?.capabilities.dataBinding.availability).toBe("available");
    expect(base?.capabilities.finality.availability).toBe("unavailable");
    expect(solana?.capabilities.finality.availability).toBe("available");
    expect(base?.evidenceCaptures.map(c=>c.rpcMethod)).toEqual([
      "eth_chainId","eth_getTransactionReceipt","eth_getBlockByHash","eth_getTransactionByHash",
    ]);
    expect(solana?.evidenceCaptures.map(c=>c.rpcMethod)).toEqual([
      "getGenesisHash","getTransaction","getSignatureStatuses","getBlock",
    ]);
    expect(m.methods).toHaveLength(8);
    for(const c of out.candidates) {
      expect(c.evidenceCaptures.every(x=>x.contentDigest.startsWith("sha256:"))).toBe(true);
      expect(c.snapshotDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
    const core=decodeNecWireJson("discovery-result",JSON.stringify(out.result));
    expect(core.matches.map(m=>m.classification)).toEqual(["conditional","eligible"]);
    expect(core.matches[0]?.capabilitySnapshot.digest).toBe(base?.snapshotDigest);
    expect(core.matches[1]?.capabilitySnapshot.digest).toBe(solana?.snapshotDigest);
    expect(JSON.stringify(out)).not.toContain("mainnet.base.org");
    expect(JSON.stringify(out)).not.toContain("api.mainnet-beta.solana.com");
  });

  it("SYNTHETIC (real capture, receipt+transaction nulled): absent Base receipt is not converted into supported execution or finality", async () => {
    const m=mockedSources(true);
    const out=await createLiveBeforeTool(createMultichainTool(m.fetchFn))({
      requestId:"ne_before_absent_receipt_1",requirements:REQUIREMENTS,subjects:[EVM_SUBJECT],
    });
    expect(out.candidates[0]?.classification).toBe("ineligible");
    expect(out.candidates[0]?.capabilities.execution.availability).toBe("unavailable");
    expect(out.candidates[0]?.capabilities.finality.availability).toBe("unavailable");
    expect(m.methods).toEqual(["eth_chainId","eth_getTransactionReceipt","eth_getTransactionByHash"]);
    expect(out.nonClaims.some(x=>x.includes("not proof of network unavailability"))).toBe(true);
  });

  it("rejects forged input requirements, unsupported networks and duplicate subjects before reading", async () => {
    const m=mockedSources();
    const tool=createLiveBeforeTool(createMultichainTool(m.fetchFn));
    await expect(tool({...INPUT,requirements:{requirements:[{capability:"bogus",strength:"required"}]}}))
      .rejects.toMatchObject({code:"MCP_LIVE_BEFORE_INPUT"});
    await expect(tool({...INPUT,subjects:[{type:"transaction",networkId:"eip155:57057" as any,txId:TX}]}))
      .rejects.toMatchObject({code:"MCP_LIVE_BEFORE_INPUT"});
    // Duplicates must fail before any provider call, including shared budgets.
    await expect(tool({...INPUT,subjects:[EVM_SUBJECT,EVM_SUBJECT]}))
      .rejects.toMatchObject({code:"MCP_LIVE_BEFORE_INPUT"});
    expect(m.methods).toHaveLength(0);
  });

  it("SYNTHETIC (real capture, transaction hash set to all-f): rejects mismatched EVM tx identity instead of promoting a source capability", async () => {
    const m=mockedSources(false,{wrongEvmTx:true});
    await expect(createLiveBeforeTool(createMultichainTool(m.fetchFn))({
      requestId:"ne_before_wrong_tx_1",requirements:REQUIREMENTS,subjects:[EVM_SUBJECT],
    })).rejects.toMatchObject({code:"MCP_LIVE_BEFORE_UNAVAILABLE"});
    expect(m.methods).toContain("eth_getTransactionByHash");
  });

  it("SYNTHETIC (real capture, eth_chainId set to 0x14a34): rejects wrong Base chain identity before promoting capability availability", async () => {
    const m=mockedSources(false,{wrongEvmChain:true});
    await expect(createLiveBeforeTool(createMultichainTool(m.fetchFn))({
      requestId:"ne_before_wrong_chain_1",requirements:REQUIREMENTS,subjects:[EVM_SUBJECT],
    })).rejects.toMatchObject({code:"MCP_LIVE_BEFORE_UNAVAILABLE"});
    expect(m.methods).toEqual(["eth_chainId"]);
  });

  it("SYNTHETIC (real Solana capture, status/block mutated): uses the native Solana probe projection for confirmed, missing status and missing block", async () => {
    for (const options of [
      {solanaStatus:"confirmed" as const},
      {solanaStatus:"null" as const},
      {missingSolanaBlock:true},
    ]) {
      const m=mockedSources(false,options);
      const resolver=createMultichainTool(m.fetchFn);
      const observed=await resolver({subject:SOL_SUBJECT});
      expect(observed.acquisition.solanaProbe?.paths.signaturestatus).toBe(
        options.solanaStatus==="null" ? "not_established" : "usable",
      );
      if(options.missingSolanaBlock)expect(observed.acquisition.solanaProbe?.paths.finalizedblock).toBe("not_established");
      const outcome=await createLiveBeforeTool(resolver)({
        requestId:"ne_before_partial_sol_1",requirements:REQUIREMENTS,subjects:[SOL_SUBJECT],
      });
      expect(outcome.candidates[0]?.capabilities.finality.availability).not.toBe("available");
      expect(outcome.candidates[0]?.capabilities.settlement.support).toBe("unsupported");
      if(options.solanaStatus==="null" || options.missingSolanaBlock){
        expect(outcome.candidates[0]?.capabilities.execution.availability).not.toBe("available");
        expect(outcome.candidates[0]?.classification).toBe("ineligible");
      } else {
        expect(outcome.candidates[0]?.classification).toBe("conditional");
      }
    }
  });

  it("prevalidates the full batch and keeps a rate-limit error distinguishable", async () => {
    const m=mockedSources();
    const before=createLiveBeforeTool(createMultichainTool(m.fetchFn));
    await expect(before({...INPUT,requestId:"!"})).rejects.toMatchObject({code:"MCP_LIVE_BEFORE_INPUT"});
    await expect(before({...INPUT,subjects:[EVM_SUBJECT,{...SOL_SUBJECT,txId:"bad"}]}))
      .rejects.toMatchObject({code:"MCP_LIVE_BEFORE_INPUT"});
    expect(m.methods).toHaveLength(0);
    const {NeMcpError}=await import("../src/errors.js");
    const throttled=createLiveBeforeTool(async () => {
      throw new NeMcpError("MCP_MULTICHAIN_RATE_LIMIT","shared budget exhausted");
    });
    await expect(throttled({...INPUT,subjects:[EVM_SUBJECT]}))
      .rejects.toMatchObject({code:"MCP_MULTICHAIN_RATE_LIMIT"});
  });

  it("makes both AFTER and BEFORE visible only in explicit hosted opt-in mode (legacy/modern MCP)", async () => {
    const m=mockedSources();
    const server=await startNeMcpHttpServer({
      host:"127.0.0.1",port:0,hosted:{publicOrigin:ORIGIN},liveEvidence:createMultichainTool(m.fetchFn),
    });
    try {
      const hostFetch=simulatedHostFetch(server.port,HOST);
      const health=await (await hostFetch(new URL(ORIGIN+"/health"))).json() as any;
      expect(health.tools).toHaveLength(6);
      expect(health.tools).toContain(LIVE_BEFORE_TOOL_NAME);
      expect(health.tools).toContain(LIVE_MULTICHAIN_TOOL);
      for (const mode of ["legacy","auto"] as const) {
        const client = new Client({name:"live-before-fixture-test",version:"1"},{versionNegotiation:{mode}});
        await client.connect(new StreamableHTTPClientTransport(new URL(ORIGIN+"/mcp"),{fetch:hostFetch}));
        try {
          const {tools}=await client.listTools();
          const before=tools.find(t=>t.name===LIVE_BEFORE_TOOL_NAME);
          expect(before?.annotations).toMatchObject({readOnlyHint:true,openWorldHint:true,destructiveHint:false,idempotentHint:false});
          const result=await client.callTool({name:LIVE_BEFORE_TOOL_NAME,arguments:INPUT});
          expect(result.isError).toBeFalsy();
          expect((result.structuredContent as any).candidates.map((x:any)=>x.id)).toEqual(["base-mainnet","solana-mainnet"]);
          const invalid=await client.callTool({name:LIVE_BEFORE_TOOL_NAME,arguments:{
            ...INPUT,subjects:[{type:"transaction",networkId:"eip155:57057",txId:TX}],
          }});
          expect(invalid.isError).toBe(true);
        } finally {await client.close();}
      }
    } finally {await server.close();}
  });
});
