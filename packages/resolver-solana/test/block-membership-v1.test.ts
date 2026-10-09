import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {describe,expect,it} from "vitest";
import {
  acquireSolanaBlockSignatureMembershipV1,
  replaySolanaTransaction,
  SOLANA_BLOCK_MEMBERSHIP_PROFILE,
  SOLANA_BLOCK_SIGNATURE_MAX_COUNT,
} from "../src/index.js";
import type {SolanaTransactionAcquisition,SolanaRpcSourceDescriptor} from "../src/index.js";

const oldBytes=readFileSync(new URL("./fixtures/solana-mainnet-x402-real.json",import.meta.url));
const old=JSON.parse(oldBytes.toString("utf8"));
const newFixtureBytes=readFileSync(new URL("./fixtures/solana-mainnet-f3-block-signatures-v1.json",import.meta.url));
const actualCapture=JSON.parse(newFixtureBytes.toString("utf8"));
type Json = any;
const network=old.networkId as string;
const sig=old.subject.signature as string;
const source:SolanaRpcSourceDescriptor={
 sourceId:old.source.sourceId,sourceType:"svm_rpc",
 networkId:network,independenceGroup:old.source.independenceGroup,
 transport:{url:"https://api.mainnet-beta.solana.com"},
};
const exactParams=actualCapture.rpcParams;
function fixtureBlock():Json{return JSON.parse(actualCapture.resultJson);}
function rpc(block:Json, seen:string[]=[]):typeof fetch{
 return (async (input,init)=>{
  expect(input).toBe(source.transport.url);
  expect(init?.method).toBe("POST");
  const q=JSON.parse(String(init?.body));
  expect(q.jsonrpc).toBe("2.0");
  expect(q.method).toBe("getBlock");
  expect(q.params).toEqual(exactParams);
  seen.push(q.method);
  return new Response(JSON.stringify({jsonrpc:"2.0",id:q.id,result:block}),{
    status:200,headers:{"content-type":"application/json"},
  });
 }) as typeof fetch;
}
async function verify(args:{
 original?:SolanaTransactionAcquisition,
 source?:SolanaRpcSourceDescriptor,
 block?:Json,
 seen?:string[],
 now?:string,
}={}){
 const acquisition=args.original??await replaySolanaTransaction(old);
 return acquireSolanaBlockSignatureMembershipV1({
  acquisition,source:args.source??source,now:args.now??actualCapture.observedAt,
  fetchFn:rpc(args.block===undefined?fixtureBlock():args.block,args.seen),
 });
}

describe("versioned Solana source-reported exact block-signature membership",()=>{
 it("pins the unchanged immutable historical F3 bytes and real mainnet signatures-bearing capture",()=>{
  expect(createHash("sha256").update(oldBytes).digest("hex")).toBe("62b5191f62b61e9514f4be785d480828c496c199ef88ca763db51caf667d720a");
  expect(createHash("sha256").update(newFixtureBytes).digest("hex")).toBe("3f0c3497d9ec567d09145516e692727d07c9fdf8df8a8b78a5f2ca68cbf50c01");
  expect(actualCapture.schemaVersion).toBe("nec-resolver-solana-block-signature-observation-v1");
  expect(actualCapture.networkId).toBe(network);
  expect(actualCapture.signature).toBe(sig);
  expect(actualCapture.slot).toBe(418897974);
  expect(actualCapture.expectedBlockhash).toBe("5n9NnMBpvH2SVjG4rfdZNFQaHUuKejeK4wXcdmEKG9LV");
  expect(actualCapture.rpcMethod).toBe("getBlock");
  expect(actualCapture.rpcParams).toEqual([418897974,{
    commitment:"finalized",transactionDetails:"signatures",rewards:false,maxSupportedTransactionVersion:0,
  }]);
  const signatures=fixtureBlock().signatures as string[];
  expect(signatures).toHaveLength(1304);
  expect(signatures.indexOf(sig)).toBe(1295);
  expect(SOLANA_BLOCK_SIGNATURE_MAX_COUNT).toBeGreaterThan(signatures.length);
  expect(JSON.stringify(actualCapture)).not.toMatch(/https?:\/\/|api[_-]?key|access[_-]?token|authorization|credential|\/home\//i);
 });

 it("replays real public source and verifies exact signature in SAME source-reported block",async()=>{
  const seen:string[]=[];
  const oldAcquisition=await replaySolanaTransaction(old);
  const verified=await verify({original:oldAcquisition,seen});
  expect(oldAcquisition.profile).toBe("nec-resolver-solana-acquisition-v1");
  expect(oldAcquisition.consistent).toBe(true);
  expect(verified.profile).toBe(SOLANA_BLOCK_MEMBERSHIP_PROFILE);
  expect(verified.verdict).toBe("supported");
  expect(verified.reason).toBe("SIGNATURE_IN_EXACT_BLOCK");
  expect(verified.subject).toEqual({signature:sig,slot:418897974n});
  expect(verified.basis).toEqual(["source_observation","deterministic_derivation"]);
  expect(verified.observedBlockhash).toBe(actualCapture.expectedBlockhash);
  expect(verified.signatureIndex).toBe(1295);
  expect(verified.signatureCount).toBe(1304);
  expect(seen).toEqual(["getBlock"]);
  expect(verified.baselineCaptureDigests).toEqual(oldAcquisition.captures.map(c=>c.contentDigest));
  expect(verified.captures).toHaveLength(1);
  expect(verified.captures[0]?.rpcMethod).toBe("getBlock");
  expect(verified.captures[0]?.rpcParams).toEqual(exactParams);
  expect(verified.captures[0]?.sourceId).toBe(old.source.sourceId);
  expect(verified.captures[0]?.networkId).toBe(network);
  expect(verified.captures[0]?.contentDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(verified.captures[0]?.resultText).toBe(actualCapture.resultJson);
  expect(Object.isFrozen(verified)).toBe(true);
 });

 it("repeatable replay has identical capture and full structured assessment",async()=>{
  expect(await verify()).toEqual(await verify());
 });

 it("missing exact requested signature is a MATERIAL source conflict, NOT proof of non-existence",async()=>{
  const block=fixtureBlock();
  block.signatures=block.signatures.filter((x:string)=>x!==sig);
  const out=await verify({block});
  expect(out.verdict).toBe("ambiguous");
  expect(out.reason).toBe("SIGNATURE_ABSENT_FROM_REPORTED_BLOCK");
  expect(out.signatureCount).toBe(1303);
  expect(out.signatureIndex).toBeUndefined();
  expect(out.captures).toHaveLength(1);
 });

 it("same slot but DIFFERENT blockhash cannot support exact subject membership",async()=>{
  const block=fixtureBlock();
  block.blockhash=block.previousBlockhash;
  block.signatures=[sig];
  const out=await verify({block});
  expect(out.verdict).toBe("ambiguous");
  expect(out.reason).toBe("BLOCK_IDENTITY_DISAGREEMENT");
  expect(out.signatureIndex).toBeUndefined();
 });

 it("different parentSlot is a cross-slot/containing-block contradiction, not supported",async()=>{
  const block=fixtureBlock();
  block.parentSlot=block.parentSlot-1;
  block.signatures=[sig];
  const out=await verify({block});
  expect(out.verdict).toBe("ambiguous");
  expect(out.reason).toBe("BLOCK_IDENTITY_DISAGREEMENT");
 });

 it("null finalized block means INSUFFICIENT, not contradicted",async()=>{
  const out=await verify({block:null});
  expect(out.verdict).toBe("insufficient");
  expect(out.reason).toBe("BLOCK_UNAVAILABLE");
  expect(out.captures).toHaveLength(1);
 });

 for(const [name,alter] of [
  ["missing list",(b:Json)=>{delete b.signatures;}],
  ["null list",(b:Json)=>{b.signatures=null;}],
  ["malformed signature",(b:Json)=>{b.signatures=["not-canonical"]; }],
  ["duplicate signature",(b:Json)=>{b.signatures=[sig,sig];}],
  ["more than bounded signatures",(b:Json)=>{b.signatures=Array(SOLANA_BLOCK_SIGNATURE_MAX_COUNT+1).fill(sig);}],
 ] as const){
  it("rejects "+name+" as structurally MALFORMED rather than false negative",async()=>{
   const block=fixtureBlock(); alter(block);
   await expect(verify({block})).rejects.toMatchObject({code:"SOLANA_MALFORMED_RESPONSE"});
  });
 }

 it("refuses a different source identity or network (not a second independent provider)",async()=>{
  await expect(verify({source:{...source,sourceId:"wrong-rpc-source"}}))
   .rejects.toMatchObject({code:"SOLANA_NETWORK_MISMATCH"});
  await expect(verify({source:{...source,networkId:"solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"}}))
   .rejects.toMatchObject({code:"SOLANA_NETWORK_MISMATCH"});
 });

 it("refuses to read after a forged slot/status mismatch even with matching signature",async()=>{
  const orig=await replaySolanaTransaction(old);
  const tampered={...orig,transaction:{...orig.transaction!,slot:orig.transaction!.slot+1n}};
  const seen:string[]=[];
  const out=await verify({original:tampered,seen});
  expect(out.verdict).toBe("ambiguous");
  expect(out.reason).toBe("BASELINE_INCONSISTENT");
  expect(seen).toEqual([]);
 });

 it("refuses foreign normalized signature even with lying consistent=true/checks passed",async()=>{
  const orig=await replaySolanaTransaction(old);
  const tampered={...orig,transaction:{...orig.transaction!,signatures:[orig.transaction!.signatures[1]!, ...orig.transaction!.signatures.slice(1)]}};
  const seen:string[]=[];
  const out=await verify({original:tampered,seen});
  expect(out.verdict).toBe("ambiguous");
  expect(out.reason).toBe("BASELINE_INCONSISTENT");
  expect(seen).toEqual([]);
 });

 it("missing originally observed block is INSUFFICIENT and does not make a new source call",async()=>{
  const orig=await replaySolanaTransaction(old);
  const seen:string[]=[];
  const out=await verify({original:{...orig,block:null},seen});
  expect(out.verdict).toBe("insufficient");
  expect(out.reason).toBe("BASELINE_INSUFFICIENT");
  expect(out.captures).toEqual([]);
  expect(seen).toEqual([]);
 });

 it("no transaction means insufficient with NO invented slot, NO new request and pinned baseline digests",async()=>{
  const orig=await replaySolanaTransaction(old);
  const seen:string[]=[];
  const out=await verify({original:{...orig,transaction:null},seen});
  expect(out.verdict).toBe("insufficient");
  expect(out.reason).toBe("BASELINE_INSUFFICIENT");
  expect(out.subject.slot).toBeUndefined();
  expect(out.baselineCaptureDigests).toEqual(orig.captures.map(c=>c.contentDigest));
  expect(seen).toEqual([]);
 });

 it("a malformed caller-created acquisition fails with controlled source INPUT code",async()=>{
  const orig=await replaySolanaTransaction(old);
  const tampered={...orig,captures:undefined} as any;
  await expect(verify({original:tampered})).rejects.toMatchObject({code:"SOLANA_INPUT_INVALID"});
 });

 it("a bounded source JSON-RPC error fails CLOSED without success or contradictory claim",async()=>{
  const orig=await replaySolanaTransaction(old);
  const fetchFn=(async(_input:any,init:any)=>{
    const q=JSON.parse(String(init?.body));
    return new Response(JSON.stringify({jsonrpc:"2.0",id:q.id,error:{code:-32007,message:"slot not available"}}),{status:200});
  }) as typeof fetch;
  await expect(acquireSolanaBlockSignatureMembershipV1({
    acquisition:orig,source,now:actualCapture.observedAt,fetchFn,
  })).rejects.toMatchObject({code:"SOLANA_RPC_ERROR_RESPONSE"});
 });

 it("blockTime-only or blockHeight-only contradictory source values are ambiguous",async()=>{
  const src=fixtureBlock();
  const changedTime={...src,blockTime:src.blockTime+1};
  const changedHeight={...src,blockHeight:src.blockHeight+1};
  for (const block of [changedTime,changedHeight]){
    const out=await verify({block});
    expect(out.verdict).toBe("ambiguous");
    expect(out.reason).toBe("BLOCK_IDENTITY_DISAGREEMENT");
  }
 });

 it("an authentic FAILED transaction may still be in the signature list (NOT success)",async()=>{
  const changed=structuredClone(old);
  const failed={InstructionError:[2,{Custom:19}]};
  const txcap=changed.captures.find((c:any)=>c.rpcMethod==="getTransaction");
  const tx=JSON.parse(txcap.resultJson);tx.meta.err=failed;txcap.resultJson=JSON.stringify(tx);
  const statuscap=changed.captures.find((c:any)=>c.rpcMethod==="getSignatureStatuses");
  const status=JSON.parse(statuscap.resultJson);
  status.value[0].err=failed;status.value[0].status={Err:failed};statuscap.resultJson=JSON.stringify(status);
  const orig=await replaySolanaTransaction(changed);
  expect(orig.transaction?.successful).toBe(false);
  expect(orig.consistent).toBe(true);
  const found=await verify({original:orig});
  expect(found.verdict).toBe("supported");
  expect(found.reason).toBe("SIGNATURE_IN_EXACT_BLOCK");
  expect(found.signatureIndex).toBe(1295);
 });

 it("old immutable F3 replay STILL performs only historic NONE-block RPC and never opts into this path",async()=>{
  const observed=await replaySolanaTransaction(old);
  expect(observed.captures.map(c=>c.rpcMethod))
   .toEqual(["getGenesisHash","getTransaction","getSignatureStatuses","getBlock"]);
  expect((observed.captures[3]?.rpcParams?.[1] as any).transactionDetails).toBe("none");
  expect(observed.captures[3]?.resultText).toBe(old.captures[3].resultJson);
  expect(observed.transaction?.signatures[0]).toBe(sig);
  expect(observed.consistent).toBe(true);
 });
});
