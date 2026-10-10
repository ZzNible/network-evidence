import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
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
const TX = "0x8e01aace01ced4155b30d636b547727becdbb8a700f9b7f54ed02c4d629ae696";
const evm = JSON.parse(readFileSync(new URL("../../resolver-evm/test/fixtures/sepolia-success.json", import.meta.url), "utf8")) as
  { captures: { rpcMethod: string; resultJson: string }[] };
const sol = JSON.parse(readFileSync(new URL("../../resolver-solana/test/fixtures/solana-mainnet-x402-real.json", import.meta.url), "utf8")) as
  { subject: { signature: string }; captures: { rpcMethod: string; resultJson: string }[] };
const EVM_SUBJECT = { type: "transaction", networkId: BASE_ID, txId: TX } as const;
const SOL_SUBJECT = { type: "transaction", networkId: SOLANA_ID, txId: sol.subject.signature } as const;
const REQUIREMENTS = { requirements: [
  { capability: "execution", strength: "required" },
  { capability: "finality", strength: "desired" },
] };
const INPUT = { requestId: "ne_mcp_live_before_fixture_1", requirements: REQUIREMENTS, subjects: [EVM_SUBJECT, SOL_SUBJECT] };

function mockedSources(missingEvmReceipt = false, options: {
  wrongEvmTx?: boolean;
  wrongEvmChain?: boolean;
  solanaStatus?: "confirmed" | "null";
  missingSolanaBlock?: boolean;
} = {}) {
  const methods: string[] = [];
  const receipt = JSON.parse(evm.captures[1]!.resultJson.replaceAll("0x" + "1".repeat(64), TX)) as
    { blockHash: string; blockNumber: string; transactionIndex: string; from: string; to: string };
  const block = JSON.parse(evm.captures[2]!.resultJson.replaceAll("0x" + "1".repeat(64), TX));
  const tx = {
    hash: options.wrongEvmTx ? "0x" + "f".repeat(64) : TX,
    nonce: "0x0", blockHash: receipt.blockHash, blockNumber: receipt.blockNumber,
    transactionIndex: receipt.transactionIndex, from: receipt.from, to: receipt.to,
    value: "0x0", gas: "0x5208", input: "0x",
  };
  const fetchFn: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const query = JSON.parse(init?.body as string) as {id:number; method:string; params:unknown[]};
    methods.push(query.method);
    let result: unknown;
    if (url.includes("mainnet.base.org")) {
      const byMethod: Record<string,unknown> = {
        eth_chainId:options.wrongEvmChain ? "0x14a34" : "0x2105",
        eth_getTransactionReceipt:missingEvmReceipt ? null : receipt,
        eth_getBlockByHash:block, eth_getTransactionByHash:missingEvmReceipt ? null : tx,
      };
      result = byMethod[query.method];
    } else if (url.includes("api.mainnet-beta.solana.com")) {
      const found = sol.captures.find(c => c.rpcMethod === query.method);
      if (!found) throw Error("Unexpected mock Solana method");
      result = JSON.parse(found.resultJson);
      if (query.method === "getSignatureStatuses" && options.solanaStatus === "confirmed") {
        (result as {value:{confirmationStatus:string}[]}).value[0]!.confirmationStatus = "confirmed";
      }
      if (query.method === "getSignatureStatuses" && options.solanaStatus === "null") {
        (result as {value:unknown[]}).value = [null];
      }
      if (query.method === "getBlock" && options.missingSolanaBlock) result = null;
    } else throw Error("Unapproved fake endpoint");
    const response = new Response(JSON.stringify({jsonrpc:"2.0",id:query.id,result}), {
      status:200, headers:{"content-type":"application/json"},
    });
    Object.defineProperty(response,"url",{value:new URL(url).href});
    return response;
  };
  return {fetchFn,methods};
}

describe("opt-in live BEFORE/Discovery over exact multichain source acquisitions", () => {
  it("builds two Core-verified candidate snapshots and classifies through the existing Discovery engine", async () => {
    const m=mockedSources();
    const out=await createLiveBeforeTool(createMultichainTool(m.fetchFn))(INPUT);
    expect(out).toMatchObject({
      schema:"ne-mcp-live-discovery/v0.1",observationKind:"live_source_observation",
      builtAndVerifiedBy:"@nec/discovery + @nec/core",
    });
    const [base,solana]=out.candidates;
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

  it("absent Base receipt is not converted into supported execution or finality", async () => {
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

  it("rejects mismatched EVM tx identity instead of promoting a source capability", async () => {
    const m=mockedSources(false,{wrongEvmTx:true});
    await expect(createLiveBeforeTool(createMultichainTool(m.fetchFn))({
      requestId:"ne_before_wrong_tx_1",requirements:REQUIREMENTS,subjects:[EVM_SUBJECT],
    })).rejects.toMatchObject({code:"MCP_LIVE_BEFORE_UNAVAILABLE"});
    expect(m.methods).toContain("eth_getTransactionByHash");
  });

  it("rejects wrong Base chain identity before promoting capability availability", async () => {
    const m=mockedSources(false,{wrongEvmChain:true});
    await expect(createLiveBeforeTool(createMultichainTool(m.fetchFn))({
      requestId:"ne_before_wrong_chain_1",requirements:REQUIREMENTS,subjects:[EVM_SUBJECT],
    })).rejects.toMatchObject({code:"MCP_LIVE_BEFORE_UNAVAILABLE"});
    expect(m.methods).toEqual(["eth_chainId"]);
  });

  it("uses the native Solana probe projection for confirmed, missing status and missing block", async () => {
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
