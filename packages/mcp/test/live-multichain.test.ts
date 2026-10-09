import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeNecWireJson, encodeNecWireJson } from "@nec/core";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMultichainTool, LIVE_MULTICHAIN_TOOL } from "../src/live-multichain.js";
import { SOLANA_NETWORKS, restrictedSolanaRpcFetch, SOLANA_RESPONSE_MAX_BYTES } from "../src/live-solana.js";
import { startNeMcpHttpServer } from "../src/http.js";
import { simulatedHostFetch } from "./helpers.js";

const origin = "https://mcp.example.org";
const host = "mcp.example.org";
const network = SOLANA_NETWORKS["solana-mainnet"].networkId;
const fixture = JSON.parse(readFileSync(new URL("../../resolver-solana/test/fixtures/solana-mainnet-x402-real.json", import.meta.url), "utf8")) as {
  subject: { signature: string };
  captures: { rpcMethod: string; rpcParams: unknown[]; resultJson: string }[];
};
const subject = { type: "transaction" as const, networkId: network, txId: fixture.subject.signature };

function mockedSolana(overrides: { genesis?: string; transaction?: unknown; redirect?: string; oversize?: boolean } = {}) {
  const methods: string[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const req = JSON.parse(init?.body as string) as { jsonrpc: string; id: number; method: string; params: unknown[] };
    methods.push(req.method);
    const found = fixture.captures.find(c => c.rpcMethod === req.method);
    if (!found) throw new Error("unexpected call");
    const value = req.method === "getGenesisHash" && overrides.genesis !== undefined ? overrides.genesis
      : req.method === "getTransaction" && overrides.transaction !== undefined ? overrides.transaction
      : JSON.parse(found.resultJson);
    const text = overrides.oversize ? "x".repeat(SOLANA_RESPONSE_MAX_BYTES+1) : JSON.stringify({jsonrpc:"2.0",id:req.id,result:value});
    const result = new Response(text, {status:200,headers:{"content-type":"application/json"}});
    Object.defineProperty(result,"url",{value:overrides.redirect ?? new URL(url).href});
    return result;
  };
  return { transport, methods };
}

describe("single opt-in multichain MCP boundary", () => {
  it("replays a checked-in Solana mainnet source through the resolver, with native Core fragment", async () => {
    const p = mockedSolana();
    const result = await createMultichainTool(p.transport)({subject});
    expect(p.methods).toEqual(["getGenesisHash","getTransaction","getSignatureStatuses","getBlock"]);
    expect(result).toMatchObject({
      observationKind:"live_source_observation",toolStatus:"observed",
      evidenceBasis:"source_observation",artifactType:"network-evidence-fragment",
      subject,acquisition:{transactionObserved:true,blockObserved:true,consistent:true},
    });
    const dimension = (result.fragment as any).networkEvidence;
    expect(dimension.execution.verdict).toBe("supported");
    expect(dimension.dataBinding.verdict).toBe("supported");
    expect(dimension.finality.verdict).toBe("supported");
    expect(dimension.finality.metadata.economicIrreversibilityEstablished).toBe(false);
    expect(dimension).not.toHaveProperty("settlement");
    expect(result.acquisition.captures).toHaveLength(4);
    expect(Object.keys(result.source).sort()).toEqual(["independenceGroup","networkId","sourceId","sourceType"]);
    expect((result.fragment as any).subject.networkId).toBe(subject.networkId);
    expect((result.fragment as any).subject.txId).toBe(subject.txId);
    expect(result.acquisition.captures.every(x=>x.contentDigest.startsWith("sha256:"))).toBe(true);
    expect(decodeNecWireJson("network-evidence-fragment",encodeNecWireJson("network-evidence-fragment",decodeNecWireJson("network-evidence-fragment",JSON.stringify(result.fragment))))).toEqual(decodeNecWireJson("network-evidence-fragment",JSON.stringify(result.fragment)));
    expect(JSON.stringify(result)).not.toContain(SOLANA_NETWORKS["solana-mainnet"].url);
  });

  it("mismatched genesis stops immediately; rejects unsupported network, invalid signature without outbound reads", async () => {
    const p=mockedSolana({genesis:"11111111111111111111111111111111"});
    await expect(createMultichainTool(p.transport)({subject})).rejects.toMatchObject({code:"MCP_MULTICHAIN_SOURCE_FAILED"});
    expect(p.methods).toEqual(["getGenesisHash"]);
    const no=mockedSolana();
    const resolve=createMultichainTool(no.transport);
    await expect(resolve({subject:{...subject,networkId:"eip155:57057" as any}})).rejects.toMatchObject({code:"MCP_MULTICHAIN_INPUT"});
    await expect(resolve({subject:{...subject,txId:"not-a-valid-solana-signature"}})).rejects.toMatchObject({code:"MCP_MULTICHAIN_INPUT"});
    await expect(resolve({subject:{type:"transaction",networkId:"eip155:8453",txId:"0x" + "A".repeat(64)}})).rejects.toMatchObject({code:"MCP_MULTICHAIN_INPUT"});
    expect(no.methods).toEqual([]);
  });

  it("null/pruned transaction never becomes contradicted; chain snapshot remains source-attributed", async () => {
    const p=mockedSolana({transaction:null});
    const result=await createMultichainTool(p.transport)({subject});
    expect(p.methods).toEqual(["getGenesisHash","getTransaction","getSignatureStatuses"]);
    expect(result.acquisition).toMatchObject({transactionObserved:false,blockObserved:false,consistent:true});
    const e=(result.fragment as any).networkEvidence;
    expect(e.execution.verdict).toBe("insufficient");
    expect(e.finality.verdict).toBe("insufficient");
    expect(result.nonClaims.some(v=>v.includes("not proof of nonexistence"))).toBe(true);
  });

  it("Solana fetch guard rejects custom URLs, write methods, inflated replies and unrequested call parameters", async () => {
    const p=mockedSolana();
    const f=restrictedSolanaRpcFetch(p.transport,"solana-mainnet");
    const read=JSON.stringify({jsonrpc:"2.0",id:1,method:"getGenesisHash",params:[]});
    const forbidden=JSON.stringify({jsonrpc:"2.0",id:1,method:"sendTransaction",params:["signed-blob"]});
    await expect(f("http://127.0.0.1:8899",{method:"POST",body:read})).rejects.toMatchObject({code:"MCP_MULTICHAIN_SOURCE_FAILED"});
    await expect(f("https://api.mainnet-beta.solana.com.attacker.example",{method:"POST",body:read})).rejects.toMatchObject({code:"MCP_MULTICHAIN_SOURCE_FAILED"});
    await expect(f(SOLANA_NETWORKS["solana-mainnet"].url,{method:"POST",body:forbidden})).rejects.toMatchObject({code:"MCP_MULTICHAIN_SOURCE_FAILED"});
    await expect(f(SOLANA_NETWORKS["solana-mainnet"].url,{method:"POST",body:JSON.stringify({jsonrpc:"2.0",id:1,method:"getBlock",params:[0,{transactionDetails:"full"}]})})).rejects.toMatchObject({code:"MCP_MULTICHAIN_SOURCE_FAILED"});
    expect(p.methods).toHaveLength(0);
    await expect(f(SOLANA_NETWORKS["solana-mainnet"].url,{method:"POST",body:read})).resolves.toHaveProperty("status",200);
    const redirect=mockedSolana({redirect:"https://127.0.0.1/"});
    await expect(restrictedSolanaRpcFetch(redirect.transport,"solana-mainnet")(SOLANA_NETWORKS["solana-mainnet"].url,{method:"POST",body:read})).rejects.toMatchObject({code:"MCP_MULTICHAIN_SOURCE_FAILED"});
    const giant=mockedSolana({oversize:true});
    await expect(restrictedSolanaRpcFetch(giant.transport,"solana-mainnet")(SOLANA_NETWORKS["solana-mainnet"].url,{method:"POST",body:read})).rejects.toMatchObject({code:"MCP_MULTICHAIN_TOO_LARGE"});
    // The existing Solana RPC reader wraps fetch-layer errors into its own
    // family type; the external MCP boundary safely collapses the detail.
    await expect(createMultichainTool(giant.transport)({subject})).rejects.toMatchObject({code:"MCP_MULTICHAIN_SOURCE_FAILED"});
  });

  it("accepts devnet only with its pinned genesis and does not fabricate a missing transaction", async () => {
    const dev = mockedSolana({
      genesis: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
      transaction: null,
    });
    const subjectDev = { type: "transaction" as const, networkId: SOLANA_NETWORKS["solana-devnet"].networkId, txId: subject.txId };
    const result = await createMultichainTool(dev.transport)({subject:subjectDev});
    expect(result.acquisition.transactionObserved).toBe(false);
    expect(result.fragment).toMatchObject({
      network: { networkId: subjectDev.networkId },
      subject: { type:"transaction", networkId:subjectDev.networkId, txId:subjectDev.txId },
    });
    expect((result.fragment as any).networkEvidence.execution.verdict).toBe("insufficient");
    expect(dev.methods).toEqual(["getGenesisHash","getTransaction","getSignatureStatuses"]);
  });

  it("rejects a Base Sepolia chain mismatch before receipt reads", async () => {
    const methods: string[] = [];
    const wrong:typeof fetch = async (input,init) => {
      const req=JSON.parse(init?.body as string) as {method:string,id:number};
      methods.push(req.method);
      const url=typeof input==="string"?input:input instanceof URL?input.href:input.url;
      const response=new Response(JSON.stringify({jsonrpc:"2.0",id:req.id,result:"0x2105"}),{status:200});
      Object.defineProperty(response,"url",{value:new URL(url).href});
      return response;
    };
    const claim={type:"transaction" as const,networkId:"eip155:84532" as const,txId:"0x"+"1".repeat(64)};
    await expect(createMultichainTool(wrong)({subject:claim})).rejects.toMatchObject({code:"MCP_LIVE_EVM_RPC_FAILED"});
    expect(methods).toEqual(["eth_chainId"]);
  });

  it("a single shared quota is enforced across Base and Solana sources", async () => {
    const p=mockedSolana({transaction:null});
    const originFetch:typeof fetch=async (input,init) => {
      const url=typeof input==="string"?input:input instanceof URL?input.href:input.url;
      if(url.includes("solana"))return p.transport(input,init);
      const q=JSON.parse(init?.body as string) as {id:number;method:string};
      const res=new Response(JSON.stringify({jsonrpc:"2.0",id:q.id,result:q.method==="eth_chainId"?"0x2105":null}),{status:200,headers:{"content-type":"application/json"}});
      Object.defineProperty(res,"url",{value:new URL(url).href});
      return res;
    };
    const live=createMultichainTool(originFetch);
    for(let i=0;i<7;i++)await live({subject:{type:"transaction",networkId:"eip155:8453",txId:"0x"+"1".repeat(64)}});
    await live({subject});
    expect(p.methods).toHaveLength(3);
    await expect(live({subject})).rejects.toMatchObject({code:"MCP_MULTICHAIN_RATE_LIMIT"});
    expect(p.methods).toHaveLength(3);
  });

  it("legacy + modern MCP client tools include four active profiles but no Tanenbaum", async () => {
    const p=mockedSolana();
    const hosted=await startNeMcpHttpServer({
      host:"127.0.0.1",port:0,hosted:{publicOrigin:origin},liveEvidence:createMultichainTool(p.transport),
    });
    try{
      const fetchLocal=simulatedHostFetch(hosted.port,host);
      const health=await (await fetchLocal(new URL(origin+"/health"))).json() as any;
      expect(health).toMatchObject({networkIo:"bounded_evm_solana_rpc",liveObservation:true});
      expect(health.tools).toHaveLength(5);
      for(const era of ["legacy","auto"] as const){
        const client=new Client({name:"multichain-integration-test",version:"1"}, {versionNegotiation:{mode:era}});
        await client.connect(new StreamableHTTPClientTransport(new URL(origin+"/mcp"),{fetch:fetchLocal}));
        try{
          const {tools}=await client.listTools();
          expect(tools.map(t=>t.name)).toContain(LIVE_MULTICHAIN_TOOL);
          const v=tools.find(t=>t.name===LIVE_MULTICHAIN_TOOL)!;
          expect(v.annotations).toMatchObject({readOnlyHint:true,openWorldHint:true,destructiveHint:false,idempotentHint:false});
          const profiles=await client.callTool({name:"list_network_profiles",arguments:{}});
          expect((profiles.structuredContent as any).profiles.map((x:any)=>x.family)).toEqual(["opstack","opstack","solana","solana"]);
          const result=await client.callTool({name:LIVE_MULTICHAIN_TOOL,arguments:{subject}});
          expect(result.isError).toBeFalsy();
          expect((result.structuredContent as any).artifactType).toBe("network-evidence-fragment");
          const invalid=await client.callTool({name:LIVE_MULTICHAIN_TOOL,arguments:{subject:{...subject,networkId:"eip155:57057"}}});
          expect(invalid.isError).toBe(true);
        }finally{await client.close();}
      }
    }finally{await hosted.close();}
  });
});
