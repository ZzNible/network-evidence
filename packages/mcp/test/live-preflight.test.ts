import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  computeEvidencePolicyDigest, decodeNecWireJson,
  verifyCapabilitySnapshot, verifyPreflightResult,
} from "@nec/core";
import type { EvidencePolicy, PolicyDimension, PreflightRequest } from "@nec/core";
import { startNeMcpHttpServer } from "../src/http.js";
import { createMultichainTool } from "../src/live-multichain.js";
import { createLivePreflightTool, LIVE_PREFLIGHT_TOOL_NAME } from "../src/live-preflight.js";
import { NeMcpError } from "../src/errors.js";
import { simulatedHostFetch } from "./helpers.js";

const ORIGIN = "https://mcp.example.org", HOST = "mcp.example.org";
const BASE = "eip155:8453" as const, SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" as const;
const TX = "0x8e01aace01ced4155b30d636b547727becdbb8a700f9b7f54ed02c4d629ae696";
const evm=JSON.parse(readFileSync(new URL("../../resolver-evm/test/fixtures/sepolia-success.json",import.meta.url),"utf8")) as
  {captures:{rpcMethod:string;resultJson:string}[]};
const sol=JSON.parse(readFileSync(new URL("../../resolver-solana/test/fixtures/solana-mainnet-x402-real.json",import.meta.url),"utf8")) as
  {subject:{signature:string};captures:{rpcMethod:string;resultJson:string}[]};
const baseSubject={type:"transaction" as const,networkId:BASE,txId:TX};
const solSubject={type:"transaction" as const,networkId:SOL,txId:sol.subject.signature};

function policy(requiredDimensions: PolicyDimension[], desiredDimensions: PolicyDimension[]=[]): EvidencePolicy {
  const content={
    id:"external_policy_1",version:"1",requiredDimensions,desiredDimensions,
  };
  return {...content,digest:computeEvidencePolicyDigest(content)};
}
function request(networkId:string, required:PolicyDimension[], desired:PolicyDimension[]=[]):PreflightRequest{
  return {
    schemaVersion:"0.1",requestId:"external_preflight_1",networkId,
    action:networkId.startsWith("eip155:")
      ? {kind:"erc20.transfer",target:"0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",fields:{expectedAmount:"1000"}}
      : {kind:"spl_token.transfer_checked",target:"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",fields:{expectedAmount:"5000"}},
    evidencePolicy:policy(required,desired),
  };
}
function fakeProvider(options: {
  nullBaseReceipt?:boolean; wrongBaseChain?:boolean;
  confirmedSolana?:boolean; nullSolanaStatus?:boolean; nullSolanaBlock?:boolean;
}={}) {
  const methods:string[]=[];
  const receipt=JSON.parse(evm.captures[1]!.resultJson.replaceAll("0x"+"1".repeat(64),TX)) as
    {blockHash:string;blockNumber:string;transactionIndex:string;from:string;to:string};
  const block=JSON.parse(evm.captures[2]!.resultJson.replaceAll("0x"+"1".repeat(64),TX));
  const tx={
    hash:TX,nonce:"0x0",blockHash:receipt.blockHash,blockNumber:receipt.blockNumber,
    transactionIndex:receipt.transactionIndex,from:receipt.from,to:receipt.to,
    value:"0x0",gas:"0x5208",input:"0x",
  };
  const fetchFn:typeof fetch=async(input,init)=>{
    const url=typeof input==="string"?input:input instanceof URL?input.href:input.url;
    const query=JSON.parse(init?.body as string) as {id:number;method:string;params:unknown[]};
    methods.push(query.method);
    let result:unknown;
    if(url.includes("mainnet.base.org")){
      const byMethod:Record<string,unknown>={
        eth_chainId:options.wrongBaseChain?"0x1":"0x2105",
        eth_getTransactionReceipt:options.nullBaseReceipt?null:receipt,
        eth_getBlockByHash:block,
        eth_getTransactionByHash:options.nullBaseReceipt?null:tx,
      };
      result=byMethod[query.method];
    } else if (url.includes("api.mainnet-beta.solana.com")) {
      const found=sol.captures.find(c=>c.rpcMethod===query.method);
      if(!found)throw Error("unapproved method");
      result=JSON.parse(found.resultJson);
      if(query.method==="getSignatureStatuses" && options.nullSolanaStatus)
        (result as {value:unknown[]}).value=[null];
      if(query.method==="getSignatureStatuses" && options.confirmedSolana)
        (result as {value:{confirmationStatus:string}[]}).value[0]!.confirmationStatus="confirmed";
      if(query.method==="getBlock" && options.nullSolanaBlock)result=null;
    } else throw Error("unapproved destination");
    const r=new Response(JSON.stringify({jsonrpc:"2.0",id:query.id,result}),
      {status:200,headers:{"content-type":"application/json"}});
    Object.defineProperty(r,"url",{value:new URL(url).href});
    return r;
  };
  return {fetchFn,methods};
}
const baseInput={
  selectedNetworkId:BASE,probeSubject:baseSubject,
  request:request(BASE,["execution","observedEffects"],["finality"]),
} as const;
const solInput={
  selectedNetworkId:SOL,probeSubject:solSubject,
  request:request(SOL,["execution","finality"]),
} as const;

describe("explicit caller-selected live evidence preflight (native Core contextual verification)",()=>{
  it("produces ready on Base with a valid caller policy, but never confuses desired finality with L1 settlement",async()=>{
    const m=fakeProvider();
    const out=await createLivePreflightTool(createMultichainTool(m.fetchFn))(baseInput);
    expect(out).toMatchObject({
      schema:"ne-mcp-live-preflight/v0.1",choiceSource:"caller",
      selectedNetworkId:BASE,probeSubject:baseSubject,verifiedBy:"@nec/core",
    });
    const result=decodeNecWireJson("preflight-result",JSON.stringify(out.preflight));
    const snapshot=decodeNecWireJson("capability-snapshot",JSON.stringify(out.capabilitySnapshot));
    const manifest=decodeNecWireJson("resolver-manifest",JSON.stringify(out.resolverManifest));
    expect(verifyCapabilitySnapshot(snapshot,{resolver:manifest,networkId:BASE})).toBe(true);
    expect(verifyPreflightResult(result,{resolver:manifest,capabilitySnapshot:snapshot})).toBe(true);
    expect(result).toMatchObject({status:"ready",request:baseInput.request,
      evidenceReadiness:{execution:{status:"ready"},observedEffects:{status:"ready"},
        finality:{status:"not_applicable"},settlement:{status:"not_applicable"}},
    });
    expect(result.capabilitySnapshot?.digest).toBe(snapshot.artifactDigest);
    expect(result.resolver.digest).toBe(manifest.digest);
    expect(result.request).toEqual(baseInput.request);
    expect(out.evidenceCaptures.map(x=>x.rpcMethod)).toEqual([
      "eth_chainId","eth_getTransactionReceipt","eth_getBlockByHash","eth_getTransactionByHash",
    ]);
    expect(out.nonClaims.join(" ")).toMatch(/wallet readiness|NOT the future intended action/);
    expect(JSON.stringify(out)).not.toContain("mainnet.base.org");
    expect(out).not.toHaveProperty("networkEvidenceResult");
    expect(m.methods).toHaveLength(4);
    const forged={...result,artifactDigest:"sha256:"+"0".repeat(64)};
    expect(verifyPreflightResult(forged,{resolver:manifest,capabilitySnapshot:snapshot})).toBe(false);
  });

  it("blocks required EVM finality or settlement and does not use the AFTER L2 finality probe as preflight support",async()=>{
    for(const dim of ["finality","settlement"] as PolicyDimension[]){
      const m=fakeProvider();
      const out=await createLivePreflightTool(createMultichainTool(m.fetchFn))({
        ...baseInput,request:request(BASE,["execution",dim]),
      });
      const p=decodeNecWireJson("preflight-result",JSON.stringify(out.preflight));
      expect(p.status).toBe("blocked");
      expect(p.evidenceReadiness[dim].status).toBe("not_applicable");
      expect(m.methods).toHaveLength(4);
    }
  });

  it("preserves source-reported Solana finalized only with complete source paths; never infers settlement",async()=>{
    const m=fakeProvider();
    const out=await createLivePreflightTool(createMultichainTool(m.fetchFn))(solInput);
    const p=decodeNecWireJson("preflight-result",JSON.stringify(out.preflight));
    const snap=decodeNecWireJson("capability-snapshot",JSON.stringify(out.capabilitySnapshot));
    const manifest=decodeNecWireJson("resolver-manifest",JSON.stringify(out.resolverManifest));
    expect(p.status).toBe("ready");
    expect(p.evidenceReadiness.finality).toMatchObject({status:"ready",metadata:{doesNotEstablish:expect.arrayContaining(["settlement","independent_cryptographic_verification"])}});
    expect(p.evidenceReadiness.settlement.status).toBe("not_applicable");
    expect(verifyPreflightResult(p,{resolver:manifest,capabilitySnapshot:snap})).toBe(true);
    expect(out.evidenceCaptures.map(x=>x.rpcMethod)).toEqual(["getGenesisHash","getTransaction","getSignatureStatuses","getBlock"]);
    expect(JSON.stringify(out)).not.toContain("api.mainnet-beta.solana.com");
    expect(m.methods).toHaveLength(4);
  });

  it("rejects confirmed/null/unavailable Solana probe, NOT a false network BLOCKED/ready verdict",async()=>{
    for(const options of [{confirmedSolana:true},{nullSolanaStatus:true},{nullSolanaBlock:true}]) {
      const m=fakeProvider(options);
      await expect(createLivePreflightTool(createMultichainTool(m.fetchFn))(solInput))
        .rejects.toMatchObject({code:"MCP_LIVE_PREFLIGHT_UNAVAILABLE"});
      expect(m.methods).toEqual(["getGenesisHash","getTransaction","getSignatureStatuses","getBlock"]);
    }
  });

  it("rejects null EVM receipt as a failed probe, not a statement about network readiness",async()=>{
    const m=fakeProvider({nullBaseReceipt:true});
    await expect(createLivePreflightTool(createMultichainTool(m.fetchFn))(baseInput))
      .rejects.toMatchObject({code:"MCP_LIVE_PREFLIGHT_UNAVAILABLE"});
    expect(m.methods).toEqual(["eth_chainId","eth_getTransactionReceipt","eth_getTransactionByHash"]);
    const bad=fakeProvider({wrongBaseChain:true});
    await expect(createLivePreflightTool(createMultichainTool(bad.fetchFn))(baseInput))
      .rejects.toMatchObject({code:"MCP_LIVE_PREFLIGHT_UNAVAILABLE"});
    expect(bad.methods).toEqual(["eth_chainId"]);
  });

  it("validates COMPLETE caller selection/action/policy BEFORE any source fetch or RPC budget use",async()=>{
    const m=fakeProvider();
    const tool=createLivePreflightTool(createMultichainTool(m.fetchFn));
    const bads=[
      {...baseInput,selectedNetworkId:SOL},
      {...baseInput,selectedNetworkId:"eip155:57057"},
      {...baseInput,probeSubject:{...baseSubject,txId:"notahash"}},
      {...baseInput,request:{...baseInput.request,networkId:SOL}},
      {...baseInput,request:{...baseInput.request,action:{kind:"../bad",target:"x"}}},
      {...baseInput,request:{...baseInput.request,evidencePolicy:{...baseInput.request.evidencePolicy,digest:"sha256:"+"0".repeat(64)}}},
      {...baseInput,request:{...baseInput.request,evidencePolicy:{...baseInput.request.evidencePolicy,requiredDimensions:["finality","bogus"]}}},
      {...baseInput,request:{...baseInput.request,preflight:{requestId:"bad",digest:"sha256:"+"0".repeat(64)}}},
      {...baseInput,unknownField:"abc"},
      {...baseInput,request:{...baseInput.request,metadata:{padding:"x".repeat(32000)}}},
      {...solInput,probeSubject:baseSubject},
    ];
    for(const candidate of bads){
      await expect(tool(candidate as any)).rejects.toMatchObject({code:"MCP_LIVE_PREFLIGHT_INPUT"});
    }
    expect(m.methods).toHaveLength(0);
  });

  it("preserves shared RPC budget rejection without translating to readiness or unavailability",async()=>{
    const throttled=createLivePreflightTool(async()=>{
      throw new NeMcpError("MCP_MULTICHAIN_RATE_LIMIT","shared budget reached");
    });
    await expect(throttled(baseInput)).rejects.toMatchObject({code:"MCP_MULTICHAIN_RATE_LIMIT"});
  });

  it("fails closed on incomplete or forged EVM/Solana acquisition path maps",async()=>{
    const a=fakeProvider();
    const underlying=createMultichainTool(a.fetchFn);
    const goodSol=await underlying({subject:solSubject});
    const emptyPaths={
      ...goodSol,acquisition:{
        ...goodSol.acquisition,solanaProbe:{
          ...goodSol.acquisition.solanaProbe!,paths:{} as any,
        },
      },
    };
    await expect(createLivePreflightTool(async()=>emptyPaths)(solInput))
      .rejects.toMatchObject({code:"MCP_LIVE_PREFLIGHT_UNAVAILABLE"});
    const goodEvm=await underlying({subject:baseSubject});
    const withoutBlockCapture={
      ...goodEvm,acquisition:{
        ...goodEvm.acquisition,
        captures:goodEvm.acquisition.captures.filter(x=>x.rpcMethod!=="eth_getBlockByHash"),
      },
    };
    await expect(createLivePreflightTool(async()=>withoutBlockCapture)(baseInput))
      .rejects.toMatchObject({code:"MCP_LIVE_PREFLIGHT_UNAVAILABLE"});
  });

  it("shares the actual 8-per-minute live acquisition budget with AFTER",async()=>{
    const m=fakeProvider();
    const resolve=createMultichainTool(m.fetchFn);
    for(let n=0;n<8;n++) await resolve({subject:baseSubject});
    expect(m.methods).toHaveLength(32);
    await expect(createLivePreflightTool(resolve)(baseInput))
      .rejects.toMatchObject({code:"MCP_MULTICHAIN_RATE_LIMIT"});
    expect(m.methods).toHaveLength(32); // no physical RPC read after the budget
  });

  it("is opt-in only, presents 6 read-only tools in both MCP protocol versions and keeps offline 3",async()=>{
    const m=fakeProvider();
    const server=await startNeMcpHttpServer({host:"127.0.0.1",port:0,
      hosted:{publicOrigin:ORIGIN},liveEvidence:createMultichainTool(m.fetchFn)});
    try{
      const hostFetch=simulatedHostFetch(server.port,HOST);
      const health=await (await hostFetch(new URL(ORIGIN+"/health"))).json() as any;
      expect(health.tools).toHaveLength(6);
      expect(health.tools).toContain(LIVE_PREFLIGHT_TOOL_NAME);
      for(const mode of ["legacy","auto"] as const){
        const client=new Client({name:"live-preflight-smoke",version:"1"},{versionNegotiation:{mode}});
        await client.connect(new StreamableHTTPClientTransport(new URL(ORIGIN+"/mcp"),{fetch:hostFetch}));
        try{
          const tools=(await client.listTools()).tools;
          expect(tools).toHaveLength(6);
          const current=tools.find(x=>x.name===LIVE_PREFLIGHT_TOOL_NAME);
          expect(current?.annotations).toMatchObject({readOnlyHint:true,destructiveHint:false,openWorldHint:true,idempotentHint:false});
          const result=await client.callTool({name:LIVE_PREFLIGHT_TOOL_NAME,arguments:baseInput});
          expect(result.isError).toBeFalsy();
          expect((result.structuredContent as any).preflight.status).toBe("ready");
          const before=m.methods.length;
          const invalid=await client.callTool({name:LIVE_PREFLIGHT_TOOL_NAME,arguments:{
            ...baseInput,request:{...baseInput.request,evidencePolicy:{...baseInput.request.evidencePolicy,digest:"sha256:"+"0".repeat(64)}},
          }});
          expect(invalid.isError).toBe(true);
          expect(m.methods.length).toBe(before);
        }finally{await client.close();}
      }
    }finally{await server.close();}
  });
});
