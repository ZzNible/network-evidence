import {readFileSync} from "node:fs";
import {describe,expect,it} from "vitest";
import {Client,StreamableHTTPClientTransport} from "@modelcontextprotocol/client";
import {ENTRY_POINT_V0_7_OBSERVED_ON_BASE} from "@nec/adapter-erc4337";
import {startNeMcpHttpServer} from "../src/http.js";
import {createMultichainTool, LIVE_MULTICHAIN_TOOL} from "../src/live-multichain.js";
import {prepareLiveClaim, resolveWithOptionalClaim} from "../src/live-claim.js";
import {simulatedHostFetch} from "./helpers.js";

const ORIGIN="https://mcp.example.org", HOST="mcp.example.org";
const EVM="eip155:8453" as const, SOL="solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" as const;
const usdc=JSON.parse(readFileSync(new URL("../../resolver-opstack/test/fixtures/base-mainnet-usdc-transfer.fixture.json",import.meta.url),"utf8"));
const erc=JSON.parse(readFileSync(new URL("../../adapter-erc4337/test/fixtures/base-mainnet-redeem-bundle.json",import.meta.url),"utf8"));
const sol=JSON.parse(readFileSync(new URL("../../resolver-solana/test/fixtures/solana-mainnet-x402-real.json",import.meta.url),"utf8"));
const usdcSubject={type:"transaction" as const,networkId:EVM,txId:usdc.subject.txHash as string};
const ercSubject={type:"transaction" as const,networkId:EVM,txId:erc.subject.txHash as string};
const solSubject={type:"transaction" as const,networkId:SOL,txId:sol.subject.signature as string};
const x402Native={
  // SYNTHETIC claimant requirement assembled for this test from a public USDC
  // Transfer observation. It is NOT original x402 PaymentRequirements.
  requirement:{
    x402Version:"2",scheme:"exact",network:EVM,
    asset:"0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    payTo:"0x11f591c3496c0632e7b173184f5bc71dc941125d",
    amount:"1000",
  },paymentTxHash:usdcSubject.txId,
};
const ercNative={
  // Structured expectation copied from pinned public on-chain UserOperationEvent.
  network:EVM,bundleTransactionHash:ercSubject.txId,
  entryPoint:ENTRY_POINT_V0_7_OBSERVED_ON_BASE,
  entryPointProfile:"v0.7",
  userOperation:{userOpHash:"0x94e3b302718e1f594c903cdb8237741c02edf12495cc78b34e30b9cfcfe5ae31",
    sender:"0xf64dd2892370f6d75aa1bd0f10da312235a06a1e"},
};
const svmNative={
  // SYNTHETIC claimant requirement; the contemporaneous x402 handshake
  // artifacts were NOT recovered for this historical Solana transaction.
  requirement:{
    x402Version:2,scheme:"exact",network:SOL,
    asset:"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    payTo:"CNkB2jCHvnjF6zzmK2QeL9qEWBcq2oSq5t1DBnD59yJj",
    amount:"5000",maxTimeoutSeconds:300,
    extra:{feePayer:"BENrLoUbndxoNMUS5JXApGMtNykLjFXXixMtpDwDR9SP"},
  },paymentSignature:solSubject.txId,
};
const x402={protocol:"x402-evm" as const,claim:x402Native};
const erc4337={protocol:"erc4337" as const,claim:ercNative};
const svm={protocol:"x402-svm" as const,claim:svmNative};

function capturedSources() {
  const methods:string[]=[];
  let activeEvmFixture:any=usdc;
  const fetchFn:typeof fetch=async (input,init)=>{
    const url=typeof input==="string"?input:input instanceof URL?input.href:input.url;
    const q=JSON.parse(init?.body as string) as {method:string;id:number;params:unknown[]};
    const hash=String(q.params?.[0]??"");
    let fixture:any;
    if(url.includes("mainnet.base.org")) {
      if(q.method==="eth_getTransactionReceipt") activeEvmFixture=hash===ercSubject.txId?erc:usdc;
      fixture=activeEvmFixture;
    }
    else if(url.includes("api.mainnet-beta.solana.com"))fixture=sol;
    else throw Error("not a declared fake RPC destination");
    const found=fixture.captures.find((c:any)=>c.rpcMethod===q.method);
    if(!found)throw Error("unexpected RPC method "+q.method);
    methods.push(q.method);
    const result=new Response(JSON.stringify({jsonrpc:"2.0",id:q.id,result:JSON.parse(found.resultJson)}),{
      status:200,headers:{"content-type":"application/json"}});
    Object.defineProperty(result,"url",{value:new URL(url).href});
    return result;
  };
  return {fetchFn,methods};
}

describe("optional native protocol claims on one existing hosted read-only AFTER tool",()=>{
  it("rejects malformed/mismatched claims and cross-family dispatch BEFORE any source fetch",async()=>{
    const p=capturedSources();
    const resolve=createMultichainTool(p.fetchFn);
    await expect(resolveWithOptionalClaim(resolve,{subject:usdcSubject,claim:{protocol:"x402-evm",claim:{paymentTxHash:usdcSubject.txId}}}))
      .rejects.toMatchObject({code:"MCP_CLAIM_INVALID"});
    await expect(resolveWithOptionalClaim(resolve,{subject:usdcSubject,claim:{...x402,claim:{...x402Native,paymentTxHash:ercSubject.txId}}}))
      .rejects.toMatchObject({code:"MCP_CLAIM_INVALID"});
    await expect(resolveWithOptionalClaim(resolve,{subject:usdcSubject,claim:{protocol:"x402-svm",claim:svmNative}}))
      .rejects.toMatchObject({code:"MCP_CLAIM_INVALID"});
    await expect(resolveWithOptionalClaim(resolve,{subject:usdcSubject,claim:{
      ...x402,claim:{...x402Native,requirement:{...x402Native.requirement,network:"eip155:84532"}},
    }})).rejects.toMatchObject({code:"MCP_CLAIM_INVALID"});
    await expect(resolveWithOptionalClaim(resolve,{subject:solSubject,claim:{protocol:"erc4337",claim:ercNative}}))
      .rejects.toMatchObject({code:"MCP_CLAIM_INVALID"});
    await expect(resolveWithOptionalClaim(resolve,{subject:ercSubject,claim:{protocol:"erc4337",claim:{...ercNative,userOperation:{sender:"bad"}}}}))
      .rejects.toMatchObject({code:"MCP_CLAIM_INVALID"});
    await expect(resolveWithOptionalClaim(resolve,{subject:solSubject,claim:{...svm,claim:{...svmNative,requirement:{...svmNative.requirement,network:EVM}}}}))
      .rejects.toMatchObject({code:"MCP_CLAIM_INVALID"});
    expect(p.methods).toEqual([]);
  });

  it("assesses real Base USDC transfer versus SYNTHETIC supplied x402 terms, no settlement claim",async()=>{
    const p=capturedSources(), resolve=createMultichainTool(p.fetchFn);
    const out=await resolveWithOptionalClaim(resolve,{subject:usdcSubject,claim:x402});
    expect(out.fragment).toHaveProperty("subject");
    expect(out.claimAssessment).toMatchObject({
      protocol:"x402-evm",assessmentType:"adapter_local_protocol_assessment",
      evaluation:{subjectMatchesClaim:true,outcome:{verdict:"supported"},requirementDigest:expect.stringMatching(/^sha256:/)},
    });
    expect(out.claimAssessment?.nonClaims.join(" ")).toContain("not independently established");
    expect((out.claimAssessment?.evaluation as any).nonClaims.join(" ")).toMatch(/settlement|facilitator/i);
    expect(out.claimAssessment?.evaluation).not.toHaveProperty("settlement");
    expect(out.claimAssessment?.evaluation).not.toHaveProperty("finality");
    expect((out.fragment as any).networkEvidence).not.toHaveProperty("settlement");
    const cited=(out.claimAssessment?.evaluation as any).outcome.evidence as string[];
    expect(cited.length).toBeGreaterThan(0);
    for(const id of cited){
      const ref=(out.fragment as any).evidence.find((e:any)=>e.id===id);
      expect(ref.sourceId).toBe(out.source.sourceId);
      expect(out.acquisition.captures.some(c=>c.contentDigest===ref.contentDigest)).toBe(true);
    }
    expect(p.methods).toEqual(["eth_chainId","eth_getTransactionReceipt","eth_getBlockByHash","eth_getTransactionByHash"]);
    const wrong=await resolveWithOptionalClaim(resolve,{
      subject:usdcSubject,claim:{...x402,claim:{...x402Native,requirement:{...x402Native.requirement,amount:"2000"}}},
    });
    expect((wrong.claimAssessment?.evaluation as any).outcome.verdict).not.toBe("supported");
    expect((wrong.fragment as any).networkEvidence.execution.verdict).toBe("supported");
  });

  it("assesses pinned real ERC-4337 bundle with exact UserOperation hash and cannot borrow a different userOp",async()=>{
    const p=capturedSources(),resolve=createMultichainTool(p.fetchFn);
    const out=await resolveWithOptionalClaim(resolve,{subject:ercSubject,claim:erc4337});
    expect(out.claimAssessment).toMatchObject({protocol:"erc4337",evaluation:{
      subjectMatchesClaim:true,correlationStrength:"same_bundle_only",
      outcome:{verdict:"supported"},
    }});
    expect(out.claimAssessment?.nonClaims.join(" ")).toContain("not establish x402 facilitator");
    expect((out.claimAssessment?.evaluation as any).nonClaims.join(" ")).toMatch(/finality|settlement/i);
    expect(out.claimAssessment?.evaluation).not.toHaveProperty("settlement");
    expect(out.claimAssessment?.evaluation).not.toHaveProperty("finality");
    const absent=await resolveWithOptionalClaim(resolve,{subject:ercSubject,claim:{
      ...erc4337,claim:{...ercNative,userOperation:{...ercNative.userOperation,userOpHash:"0x"+"77".repeat(32)}},
    }});
    expect((absent.claimAssessment?.evaluation as any).outcome.verdict).not.toBe("supported");
    expect((absent.fragment as any).networkEvidence.execution.verdict).toBe("supported");
  });

  it("assesses pinned Solana TransferChecked against SYNTHETIC x402-SVM terms and keeps finality separate",async()=>{
    const p=capturedSources(),resolve=createMultichainTool(p.fetchFn);
    const out=await resolveWithOptionalClaim(resolve,{subject:solSubject,claim:svm});
    expect(out.claimAssessment).toMatchObject({protocol:"x402-svm",evaluation:{
      subjectMatchesClaim:true,settlementInferred:false,outcome:{verdict:"supported"},
    }});
    expect((out.fragment as any).networkEvidence.finality).toHaveProperty("basis");
    const wrong=await resolveWithOptionalClaim(resolve,{subject:solSubject,claim:{
      ...svm,claim:{...svmNative,requirement:{...svmNative.requirement,amount:"999999999"}},
    }});
    expect((wrong.claimAssessment?.evaluation as any).outcome.verdict).not.toBe("supported");
    expect((wrong.fragment as any).networkEvidence.execution.verdict).toBe("supported");
  });

  it("rejects source spoofing and an oversized post-assessment response",async()=>{
    const p=capturedSources();
    const base=await createMultichainTool(p.fetchFn)({subject:usdcSubject});
    const spoof=async()=>({...base,source:{...base.source,sourceId:"src.evil.uncaptured"}});
    await expect(resolveWithOptionalClaim(spoof,{subject:usdcSubject,claim:x402}))
      .rejects.toMatchObject({code:"MCP_CLAIM_ASSESSMENT_FAILED"});
    const oversized=async()=>({...base,nonClaims:["x".repeat(500000)]});
    await expect(resolveWithOptionalClaim(oversized,{subject:usdcSubject,claim:x402}))
      .rejects.toMatchObject({code:"MCP_MULTICHAIN_TOO_LARGE"});
    expect(prepareLiveClaim(usdcSubject,{...x402,claim:{
      ...x402Native,paymentTxHash:"0x"+usdcSubject.txId.slice(2).toUpperCase(),
    }}).protocol).toBe("x402-evm"); // Native parser permits uppercase and normalizes.
  });

  it("no-claim request preserves original AFTER response shape and source semantics",async()=>{
    const p=capturedSources(),resolve=createMultichainTool(p.fetchFn);
    const before=await resolve({subject:usdcSubject});
    const after=await resolveWithOptionalClaim(resolve,{subject:usdcSubject});
    expect(after).not.toHaveProperty("claimAssessment");
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    expect((after.fragment as any).networkEvidence.execution.verdict).toEqual((before.fragment as any).networkEvidence.execution.verdict);
    expect((after.fragment as any).networkEvidence.observedEffects.map((x:any)=>x.fields)).toEqual((before.fragment as any).networkEvidence.observedEffects.map((x:any)=>x.fields));
    // Acquired-at timestamps make independent capture digests differ; comparing
    // those would incorrectly require two distinct live RPC reads to share bytes.
  });

  it("exposes OPTIONAL native claim through both MCP protocol generations, no new tool count",async()=>{
    const p=capturedSources();
    const server=await startNeMcpHttpServer({host:"127.0.0.1",port:0,
      hosted:{publicOrigin:ORIGIN},liveEvidence:createMultichainTool(p.fetchFn)});
    try{
      const hostFetch=simulatedHostFetch(server.port,HOST);
      for(const mode of ["legacy","auto"] as const){
        const client=new Client({name:"protocol-claim-client",version:"1"},{versionNegotiation:{mode}});
        await client.connect(new StreamableHTTPClientTransport(new URL(ORIGIN+"/mcp"),{fetch:hostFetch}));
        try{
          const tools=(await client.listTools()).tools;
          expect(tools).toHaveLength(6);
          const live=tools.find(x=>x.name===LIVE_MULTICHAIN_TOOL);
          expect(live?.annotations).toMatchObject({readOnlyHint:true,destructiveHint:false});
          const result=await client.callTool({name:LIVE_MULTICHAIN_TOOL,arguments:{subject:ercSubject,claim:erc4337}});
          expect(result.isError).toBeFalsy();
          expect((result.structuredContent as any).claimAssessment).toMatchObject({protocol:"erc4337",assessmentType:"adapter_local_protocol_assessment"});
          const count=p.methods.length;
          const invalid=await client.callTool({name:LIVE_MULTICHAIN_TOOL,arguments:{
            subject:ercSubject,claim:{protocol:"erc4337",claim:{...ercNative,bundleTransactionHash:usdcSubject.txId}},
          }});
          expect(invalid.isError).toBe(true);
          expect((invalid.content[0] as any).text).toContain("MCP_CLAIM_INVALID");
          expect(p.methods.length).toBe(count);
        } finally{await client.close();}
      }
    }finally{await server.close();}
  });
});
