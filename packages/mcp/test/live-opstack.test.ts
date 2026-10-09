import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { replayTransactionAcquisition, evaluateTransactionAcquisition } from "@nec/resolver-evm";
import {
  replayOpStackFinalityObservation,
  evaluateOpStackFinality,
  BASE_MAINNET_OPSTACK_BEFORE_PROFILE,
} from "@nec/resolver-opstack";
import { decodeNecWireJson, encodeNecWireJson } from "@nec/core";
import { startNeMcpHttpServer } from "../src/http.js";
import {
  createMultichainTool, LIVE_MULTICHAIN_TOOL,
} from "../src/live-multichain.js";
import {
  restrictedBaseRpcFetch, LIVE_OPSTACK_MAX_ANCESTRY_DEPTH, LIVE_OPSTACK_MAX_RPC_READS,
} from "../src/live-evm.js";
import { simulatedHostFetch } from "./helpers.js";
import { resolveWithOptionalClaim } from "../src/live-claim.js";

const EVM_ID = "eip155:8453" as const;
const SOL_ID = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" as const;
const TX = "0xcf496bca417f033e3ce5ad167e82a5bf95b2d815e4493de2f4943d3058b85afb";
const SOL_TX = "4DYWUMExSrMNxYLjUuH9G8feN4fmYXm4ToCx7gGaAEjJRf2QNrE8LsvoFSGhXwQJrchhgrnGpUFwjxrci9PRLF71";
const subject = {type:"transaction" as const,networkId:EVM_ID,txId:TX};
const fixture=JSON.parse(readFileSync(new URL("../../resolver-opstack/test/fixtures/base-mainnet-usdc-transfer.fixture.json",import.meta.url),"utf8")) as
  {captures:{rpcMethod:string;resultJson:string}[]};
const rawReceipt=JSON.parse(fixture.captures[1]!.resultJson) as {blockHash:string;blockNumber:string};
const rawBlock=JSON.parse(fixture.captures[2]!.resultJson) as {hash:string;number:string;parentHash:string};
const origin="https://mcp.example.org", host="mcp.example.org";
const x402={
 protocol:"x402-evm" as const,
 claim:{
  requirement:{x402Version:"2",scheme:"exact",network:EVM_ID,
    asset:"0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    payTo:"0x11f591c3496c0632e7b173184f5bc71dc941125d",amount:"1000"},
  paymentTxHash:TX,
 },
};

function source(mode:"subject-finalized"|"over-budget"|"finalized-null"|"finalized-below"|"rpc-fail"|"no-receipt"|"canonical-different"|"walk-1"|"walk-8"|"broken-parent"|"changed-head"|"op-wrong-chain"="subject-finalized") {
  const calls:{method:string;params:unknown[]}[]=[];
  const s=BigInt(rawBlock.number);
  const futureBlock={...rawBlock,number:"0x"+(s+BigInt(LIVE_OPSTACK_MAX_ANCESTRY_DEPTH+1)).toString(16),
    hash:"0x"+"b".repeat(64),parentHash:"0x"+"c".repeat(64)};
  const belowBlock={...rawBlock,number:"0x"+(s-1n).toString(16),hash:"0x"+"d".repeat(64)};
  const steps=mode==="walk-8" ? 8 : ["walk-1","broken-parent","changed-head"].includes(mode)?1:0;
  const nativeChain=[rawBlock];
  for(let i=1;i<=steps;i++){
    const parent=nativeChain[i-1]!;
    nativeChain.push({...rawBlock,number:"0x"+(s+BigInt(i)).toString(16),
      hash:"0x"+i.toString(16).padStart(64,"0"),parentHash:parent.hash});
  }
  const lookup=new Map(nativeChain.map(b=>[b.hash,b]));
  let finalityPhase=false;
  let finalizedReads=0;
  const fetchFn:typeof fetch=async (input,init)=>{
    const url=typeof input==="string"?input:input instanceof URL?input.href:input.url;
    if(new URL(url).origin!=="https://mainnet.base.org")throw Error("Unexpected outbound destination");
    const q=JSON.parse(init?.body as string) as {id:number;method:string;params:unknown[]};
    calls.push({method:q.method,params:q.params??[]});
    if(mode==="rpc-fail"&&q.method==="eth_getBlockByNumber")throw Error("Mock provider unavailable");
    let result:unknown;
    switch(q.method) {
      case "eth_chainId":
        result=mode==="op-wrong-chain"&&calls.filter(x=>x.method==="eth_chainId").length>=2?"0x1":"0x2105";
        break;
      case "eth_getTransactionReceipt":result=mode==="no-receipt"?null:JSON.parse(fixture.captures[1]!.resultJson);break;
      case "eth_getBlockByHash":
        result=lookup.get(String(q.params[0]))??rawBlock;
        if(finalityPhase&&mode==="broken-parent")result={...rawBlock,hash:"0x"+"f".repeat(64)};
        break;
      case "eth_getTransactionByHash":result=JSON.parse(fixture.captures[3]!.resultJson);break;
      case "eth_getBlockByNumber": {
        finalityPhase=true;
        const tag=q.params[0];
        if(tag==="finalized") {
          finalizedReads++;
          result=mode==="over-budget"?futureBlock:
            mode==="finalized-null"?null:mode==="finalized-below"?belowBlock:
            mode==="changed-head"&&finalizedReads>1?{...nativeChain[steps],hash:"0x"+"e".repeat(64)}:
            nativeChain[steps];
        }
        else if(tag==="safe"||tag==="latest")result=mode==="over-budget"?futureBlock:nativeChain[steps];
        else if(tag===rawBlock.number)result=mode==="canonical-different"?
          {...rawBlock,hash:"0x"+"e".repeat(64)}:rawBlock;
        else throw Error("Unexpected block tag: "+String(tag));
        break;
      }
      default:throw Error("Unexpected method: "+q.method);
    }
    const r=new Response(JSON.stringify({jsonrpc:"2.0",id:q.id,result}),{status:200,
      headers:{"content-type":"application/json"}});
    Object.defineProperty(r,"url",{value:new URL(url).href});
    return r;
  };
  return {fetchFn,calls};
}
function opReads(calls:{method:string}[]) {return calls.filter(x=>x.method==="eth_getBlockByNumber").length;}
function coreFragment(out:any) {return out.opStackFinality?.fragment;}

describe("opt-in Base L2 block finality reuses native OP Stack resolver, separate from settlement",()=>{
  it("replays TWO public read-only live capture fixtures deterministically into source-reported supported L2 finality",async()=>{
    // This fixture pair was captured by the native resolvers from Base mainnet
    // at the same fixed transaction/containing block, and is replayable long
    // after the live finalized head has moved beyond the bounded 8-link walk.
    const evmRaw=JSON.parse(readFileSync(new URL("./fixtures/base-mainnet-l2-finalized-positive-evm.json",import.meta.url),"utf8"));
    const opRaw=JSON.parse(readFileSync(new URL("./fixtures/base-mainnet-l2-finalized-positive-opstack.json",import.meta.url),"utf8"));
    expect(evmRaw.subject.txHash).toBe("0x71c9e27a7195bdecf1c63e73d5f959c96ddb35a27f6f1308835494c3156d625c");
    expect(evmRaw.source.networkId).toBe(EVM_ID);
    expect(opRaw.source.networkId).toBe(EVM_ID);
    expect(opRaw.source.sourceId).toBe(evmRaw.source.sourceId);
    expect(opRaw.source.chainId).toBe(8453);
    const evm=await replayTransactionAcquisition(evmRaw,{includeTransaction:true});
    const op=await replayOpStackFinalityObservation(opRaw);
    expect(evm.block).not.toBeNull();
    expect(op.subjectBlock.hash).toBe(evm.block?.hash);
    expect(op.subjectBlock.number).toBe(evm.block?.number);
    expect(op.captures).toHaveLength(6);
    const native=evaluateOpStackFinality({
      config:BASE_MAINNET_OPSTACK_BEFORE_PROFILE.config,evm,finality:op,
    });
    const orig=evaluateTransactionAcquisition(evm);
    expect(orig.fragment.networkEvidence.execution?.verdict).toBe("supported");
    expect(native.fragment.networkEvidence.finality?.verdict).toBe("supported");
    expect(native.fragment.networkEvidence.finality?.basis).toEqual(["source_observation"]);
    expect(native.fragment.networkEvidence).not.toHaveProperty("settlement");
    expect(native.fragment.networkEvidence).not.toHaveProperty("execution");
    expect(native.fragment.warnings.map(x=>x.code)).toContain("WITHDRAWAL_FINALIZATION_NOT_EVALUATED");
    const artifact=encodeNecWireJson("network-evidence-fragment",native.fragment);
    expect(decodeNecWireJson("network-evidence-fragment",artifact).networkEvidence.finality?.verdict).toBe("supported");
    const replayAgain=evaluateOpStackFinality({
      config:BASE_MAINNET_OPSTACK_BEFORE_PROFILE.config,
      evm:await replayTransactionAcquisition(evmRaw,{includeTransaction:true}),
      finality:await replayOpStackFinalityObservation(opRaw),
    });
    expect(encodeNecWireJson("network-evidence-fragment",replayAgain.fragment)).toBe(artifact);
    expect(JSON.stringify(evmRaw)+JSON.stringify(opRaw)).not.toContain("https://");
    expect(JSON.stringify(evmRaw)+JSON.stringify(opRaw)).not.toContain("authorization");
  });

  it("does not add any finality RPC when not requested; opt-in positive requires exact stabilized heads/canonical block",async()=>{
    const m=source();
    const resolve=createMultichainTool(m.fetchFn);
    const baseline=await resolve({subject});
    expect(baseline).not.toHaveProperty("opStackFinality");
    expect(m.calls).toHaveLength(4);
    const result=await resolve({subject,includeL2Finality:true});
    expect(result.opStackFinality).toMatchObject({
      toolStatus:"evaluated",ruleset:"opstack.rpc-finalized-head-v1",
      networkId:EVM_ID,withdrawalFinalization:"not_evaluated",
      ethereumSettlement:"not_evaluated",maxAncestryDepth:LIVE_OPSTACK_MAX_ANCESTRY_DEPTH,
    });
    expect(coreFragment(result)?.networkEvidence).toHaveProperty("finality.verdict","supported");
    expect(coreFragment(result)?.networkEvidence).not.toHaveProperty("settlement");
    expect(coreFragment(result)?.networkEvidence).not.toHaveProperty("execution");
    expect(coreFragment(result)?.subject).toEqual(subject);
    expect(coreFragment(result)?.networkEvidence?.finality?.basis).toEqual(["source_observation"]);
    expect(result.opStackFinality?.captures?.map(c=>c.rpcMethod)).toEqual([
      "eth_chainId","eth_getBlockByNumber","eth_getBlockByNumber",
      "eth_getBlockByNumber","eth_getBlockByNumber","eth_getBlockByNumber",
    ]);
    expect(opReads(m.calls)).toBe(5);
    expect(result.opStackFinality?.captures?.filter(c=>c.rpcMethod==="eth_getBlockByNumber").map(c=>c.rpcParams))
      .toEqual([["finalized",false],["safe",false],["latest",false],[rawBlock.number,false],["finalized",false]]);
    expect((result.fragment as any).networkEvidence).not.toHaveProperty("finality");
    expect((result.fragment as any).networkEvidence.execution.verdict).toBe("supported");
    expect(coreFragment(result)?.warnings.map((x:any)=>x.code)).toContain("WITHDRAWAL_FINALIZATION_NOT_EVALUATED");
    expect(JSON.stringify(result)).not.toContain("mainnet.base.org");
    const fragment=coreFragment(result);
    for(const c of result.opStackFinality?.captures??[]){
      expect(fragment?.evidence.some((e:any)=>e.contentDigest===c.contentDigest&&e.sourceId===result.source.sourceId)).toBe(true);
    }
  });

  it("walks EXACT parent hashes at depths 1 and 8, checks stability, and never substitutes heights",async()=>{
    for(const [mode,depth] of [["walk-1",1],["walk-8",8]] as const){
      const m=source(mode);
      const out=await createMultichainTool(m.fetchFn)({subject,includeL2Finality:true});
      expect(out.opStackFinality?.toolStatus).toBe("evaluated");
      expect((coreFragment(out) as any).networkEvidence.finality.verdict).toBe("supported");
      expect(out.opStackFinality?.captures?.filter(c=>c.rpcMethod==="eth_getBlockByHash")).toHaveLength(depth);
      expect(out.opStackFinality?.captures?.length).toBe(6+depth);
      expect(m.calls.filter(x=>x.method==="eth_getBlockByHash")).toHaveLength(depth+1);
      expect((coreFragment(out) as any).networkEvidence).not.toHaveProperty("settlement");
    }
  });

  it("never supports broken parent links or finalized-head instability",async()=>{
    for(const mode of ["broken-parent","changed-head"] as const){
      const m=source(mode);
      const out=await createMultichainTool(m.fetchFn)({subject,includeL2Finality:true});
      expect(out.opStackFinality?.toolStatus).toBe("evaluated");
      expect((coreFragment(out) as any).networkEvidence.finality.verdict).toBe("ambiguous");
      expect((coreFragment(out) as any).conflicts.length).toBeGreaterThan(0);
      expect((out.fragment as any).networkEvidence.execution.verdict).toBe("supported");
      expect((coreFragment(out) as any).networkEvidence).not.toHaveProperty("settlement");
    }
  });

  it("wrong chain ID from OP finality source is unavailable and cannot borrow generic EVM success",async()=>{
    const m=source("op-wrong-chain");
    const out=await createMultichainTool(m.fetchFn)({subject,includeL2Finality:true});
    expect(out.opStackFinality?.toolStatus).toBe("source_unavailable");
    expect(out.opStackFinality).not.toHaveProperty("fragment");
    expect((out.fragment as any).networkEvidence.execution.verdict).toBe("supported");
  });

  it("enforces the EXACT extra RPC request budget inside the finality-scoped fetch guard",async()=>{
    const m=source();
    const scoped=restrictedBaseRpcFetch(m.fetchFn,"base-mainnet",{
      opStackSubjectBlockNumber:BigInt(rawBlock.number),
    });
    const args={method:"POST",body:JSON.stringify({jsonrpc:"2.0",id:1,method:"eth_chainId",params:[]})};
    for(let i=0;i<LIVE_OPSTACK_MAX_RPC_READS;i++)
      expect((await scoped("https://mainnet.base.org/",args)).status).toBe(200);
    await expect(scoped("https://mainnet.base.org/",args))
      .rejects.toMatchObject({code:"MCP_LIVE_EVM_RATE_LIMIT"});
    expect(m.calls).toHaveLength(LIVE_OPSTACK_MAX_RPC_READS);
  });

  it("does not infer OP finality from a finalized height far above the anchored transaction",async()=>{
    const m=source("over-budget");
    const out=await createMultichainTool(m.fetchFn)({subject,includeL2Finality:true});
    expect(out.opStackFinality?.toolStatus).toBe("evaluated");
    expect((coreFragment(out) as any).networkEvidence.finality.verdict).toBe("insufficient");
    expect((coreFragment(out) as any).warnings.map((x:any)=>x.code)).toContain("OP_ANCESTRY_DEPTH_EXCEEDED");
    expect(m.calls.filter(x=>x.method==="eth_getBlockByHash")).toHaveLength(1); // generic block only; no guessed ancestry
    expect(out.opStackFinality?.captures).toHaveLength(5);
  });

  it("keeps missing finalized head and safe-but-not-final as INSUFFICIENT",async()=>{
    for(const mode of ["finalized-null","finalized-below"] as const){
      const m=source(mode);
      const out=await createMultichainTool(m.fetchFn)({subject,includeL2Finality:true});
      expect(out.opStackFinality?.toolStatus).toBe("evaluated");
      expect((coreFragment(out) as any).networkEvidence.finality.verdict).toBe("insufficient");
      expect((coreFragment(out) as any).networkEvidence).not.toHaveProperty("settlement");
    }
  });

  it("native OP Stack detects canonical hash contradiction independently from transaction execution",async()=>{
    const m=source("canonical-different");
    const out=await createMultichainTool(m.fetchFn)({subject,includeL2Finality:true});
    expect(out.opStackFinality?.toolStatus).toBe("evaluated");
    expect((coreFragment(out) as any).networkEvidence.finality.verdict).toBe("contradicted");
    expect((out.fragment as any).networkEvidence.execution.verdict).toBe("supported");
  });

  it("source failure is explicit UNAVAILABLE while generic evidence remains independently useful",async()=>{
    const m=source("rpc-fail");
    const out=await createMultichainTool(m.fetchFn)({subject,includeL2Finality:true});
    expect(out.opStackFinality).toMatchObject({
      toolStatus:"source_unavailable",reason:"opstack_source_unavailable",
      withdrawalFinalization:"not_evaluated",ethereumSettlement:"not_evaluated",
    });
    expect(out.opStackFinality).not.toHaveProperty("fragment");
    expect((out.fragment as any).networkEvidence.execution.verdict).toBe("supported");
  });

  it("missing receipt cannot trigger finality probe or imply transaction absence/finality",async()=>{
    const m=source("no-receipt");
    const out=await createMultichainTool(m.fetchFn)({subject,includeL2Finality:true});
    expect(out.opStackFinality).toMatchObject({
      toolStatus:"not_evaluated",reason:"missing_exact_block_anchor",
    });
    expect(out.opStackFinality).not.toHaveProperty("fragment");
    expect(opReads(m.calls)).toBe(0);
    expect((out.fragment as any).networkEvidence.execution.verdict).toBe("insufficient");
  });

  it("denies Solana opt-in, invalid flag, and unsupported read methods BEFORE network egress",async()=>{
    const m=source();
    const resolve=createMultichainTool(m.fetchFn);
    const sol={type:"transaction" as const,networkId:SOL_ID,txId:SOL_TX};
    await expect(resolve({subject:sol,includeL2Finality:true})).rejects.toMatchObject({code:"MCP_MULTICHAIN_INPUT"});
    await expect(resolve({subject,includeL2Finality:"true" as any})).rejects.toMatchObject({code:"MCP_MULTICHAIN_INPUT"});
    expect(m.calls).toHaveLength(0);
    const plain=restrictedBaseRpcFetch(m.fetchFn,"base-mainnet");
    const params=(method:string,p:unknown[])=>JSON.stringify({jsonrpc:"2.0",id:1,method,params:p});
    await expect(plain("https://mainnet.base.org",{
      method:"POST",body:params("eth_getBlockByNumber",["finalized",false]),
    })).rejects.toMatchObject({code:"MCP_LIVE_EVM_RPC_FAILED"});
    const scoped=restrictedBaseRpcFetch(m.fetchFn,"base-mainnet",{opStackSubjectBlockNumber:BigInt(rawBlock.number)});
    for(const p of [["pending",false],[rawBlock.number,true],["0xdeadbeef",false]]){
      await expect(scoped("https://mainnet.base.org",{
        method:"POST",body:params("eth_getBlockByNumber",p),
      })).rejects.toMatchObject({code:"MCP_LIVE_EVM_RPC_FAILED"});
    }
    expect(m.calls).toHaveLength(0);
  });

  it("keeps strict native x402 EVM claim assessment and OP finality as distinct evaluations",async()=>{
    const m=source();
    const out=await resolveWithOptionalClaim(createMultichainTool(m.fetchFn),{
      subject,includeL2Finality:true,claim:x402,
    });
    expect(out.claimAssessment?.evaluation).toHaveProperty("outcome.verdict","supported");
    expect((coreFragment(out) as any).networkEvidence.finality.verdict).toBe("supported");
    expect(out.claimAssessment?.assessmentType).toBe("adapter_local_protocol_assessment");
    expect((out.claimAssessment?.evaluation as any).settlement).toBeUndefined();
    expect(out.opStackFinality?.ethereumSettlement).toBe("not_evaluated");
  });

  it("supports both SDK protocol generations without increasing tool count",async()=>{
    const m=source();
    const server=await startNeMcpHttpServer({host:"127.0.0.1",port:0,
      hosted:{publicOrigin:origin},liveEvidence:createMultichainTool(m.fetchFn)});
    try{
      const fetch=simulatedHostFetch(server.port,host);
      for(const mode of ["legacy","auto"] as const){
        const cli=new Client({name:"opstack-finality-test",version:"1"},{versionNegotiation:{mode}});
        await cli.connect(new StreamableHTTPClientTransport(new URL(origin+"/mcp"),{fetch}));
        try{
          const tools=(await cli.listTools()).tools;
          expect(tools).toHaveLength(5);
          const tool=tools.find(x=>x.name===LIVE_MULTICHAIN_TOOL);
          expect(tool?.annotations).toMatchObject({readOnlyHint:true,destructiveHint:false});
          const o=await cli.callTool({name:LIVE_MULTICHAIN_TOOL,arguments:{subject,includeL2Finality:true}});
          expect(o.isError).toBeFalsy();
          expect((o.structuredContent as any).opStackFinality).toMatchObject({
            toolStatus:"evaluated",withdrawalFinalization:"not_evaluated",
          });
          const count=m.calls.length;
          const invalid=await cli.callTool({name:LIVE_MULTICHAIN_TOOL,
            arguments:{subject:{type:"transaction",networkId:SOL_ID,txId:SOL_TX},includeL2Finality:true}});
          expect(invalid.isError).toBe(true);
          expect(m.calls).toHaveLength(count);
        }finally{await cli.close();}
      }
    }finally{await server.close();}
  });
});
