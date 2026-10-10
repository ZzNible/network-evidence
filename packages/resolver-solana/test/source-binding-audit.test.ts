import {readFileSync} from "node:fs";
import {describe,expect,it} from "vitest";
import {evaluateSolanaTransaction,replaySolanaTransaction} from "../src/index.js";
import {parseSignatureStatusesResult,parseTransactionResult} from "../src/normalize.js";

const FIXTURE=JSON.parse(readFileSync(new URL("./fixtures/solana-mainnet-x402-real.json",import.meta.url),"utf8"));
type Fixture=any;
function fixture():Fixture{return structuredClone(FIXTURE);}
function mutate(f:Fixture,method:string,fn:(value:any)=>void):void{
 const c=f.captures.find((x:any)=>x.rpcMethod===method);
 if(!c)throw Error("no capture: "+method);
 const v=JSON.parse(c.resultJson);fn(v);c.resultJson=JSON.stringify(v);
}
function get(f:Fixture,method:string):any{
 const c=f.captures.find((x:any)=>x.rpcMethod===method);
 return JSON.parse(c.resultJson);
}
function expectMalformed(fn:()=>unknown):void {
  let caught:unknown;
  try {fn();} catch (error) {caught=error;}
  expect(caught).toMatchObject({code:"SOLANA_MALFORMED_RESPONSE"});
}

describe("Solana forensic binding security (historical source bytes unchanged)",()=>{
 it("a foreign-signature getTransaction cannot support execution for the requested signature",async()=>{
  const f=fixture();
  mutate(f,"getTransaction",(v)=>{v.transaction.signatures[0]=v.transaction.signatures[1];});
  const a=await replaySolanaTransaction(f);
  expect(a.transaction?.successful).toBe(true);
  expect(a.checks.find(c=>c.code==="TRANSACTION_SIGNATURE_MATCHES_SUBJECT")?.passed).toBe(false);
  const out=evaluateSolanaTransaction(a).fragment;
  expect(out.networkEvidence.execution?.verdict).not.toBe("supported");
  expect(out.networkEvidence.dataBinding?.verdict).not.toBe("supported");
  expect(out.networkEvidence.finality?.verdict).not.toBe("supported");
  expect(out.networkEvidence.observedEffects).toEqual([]);
 });

 it("a foreign-signature failed getTransaction cannot contradict EXECUTION of the requested signature",async()=>{
  const f=fixture(),err={InstructionError:[2,{"Custom":18}]};
  mutate(f,"getTransaction",(v)=>{v.transaction.signatures[0]=v.transaction.signatures[1];v.meta.err=err;});
  mutate(f,"getSignatureStatuses",(v)=>{v.value[0].err=err;v.value[0].status={Err:err};});
  const a=await replaySolanaTransaction(f);
  const out=evaluateSolanaTransaction(a).fragment;
  expect(out.networkEvidence.execution?.verdict).not.toBe("contradicted");
  expect(out.networkEvidence.execution?.verdict).not.toBe("supported");
  expect(out.networkEvidence.observedEffects).toEqual([]);
 });

 it("disputed getSignatureStatuses.err cannot emit a clean positive observed TransferChecked effect",async()=>{
  const f=fixture();
  mutate(f,"getSignatureStatuses",(v)=>{v.value[0].err={InstructionError:[2,{"Custom":12}]};v.value[0].status={Err:v.value[0].err};});
  const a=await replaySolanaTransaction(f);
  expect(a.checks.find(c=>c.code==="STATUS_ERROR_MATCHES_TRANSACTION")?.passed).toBe(false);
  const out=evaluateSolanaTransaction(a).fragment;
  expect(out.networkEvidence.execution?.verdict).not.toBe("supported");
  expect(out.networkEvidence.observedEffects).toEqual([]);
 });

 it("missing getTransaction meta.err must be rejected by the normalizer before any failed-execution verdict",()=>{
  const tx=get(fixture(),"getTransaction");delete tx.meta.err;
  expectMalformed(()=>parseTransactionResult(tx));
 });

 it("missing getSignatureStatuses value[0].err must be rejected by normalizer",()=>{
  const st=get(fixture(),"getSignatureStatuses");delete st.value[0].err;
  expectMalformed(()=>parseSignatureStatusesResult(st));
 });

 for(const invalid of [false,0,[],true]){
  it("meta.err malformed type cannot be treated as a valid Solana TransactionError: "+JSON.stringify(invalid),()=>{
   const tx=get(fixture(),"getTransaction");tx.meta.err=invalid;
   expectMalformed(()=>parseTransactionResult(tx));
  });
  it("signature status.err malformed type rejected: "+JSON.stringify(invalid),()=>{
   const st=get(fixture(),"getSignatureStatuses");st.value[0].err=invalid;
   expectMalformed(()=>parseSignatureStatusesResult(st));
  });
 }

 it("negative failed execution with matched subject + status err remains contradicted, no effects",async()=>{
  const f=fixture(),err={InstructionError:[2,{"Custom":18}]};
  mutate(f,"getTransaction",(v)=>{v.meta.err=err;});
  mutate(f,"getSignatureStatuses",(v)=>{v.value[0].err=err;v.value[0].status={Err:err};});
  const out=evaluateSolanaTransaction(await replaySolanaTransaction(f)).fragment;
  expect(out.networkEvidence.execution?.verdict).toBe("contradicted");
  expect(out.networkEvidence.observedEffects).toEqual([]);
 });

 it("compact getBlock(source, transactionDetails:none) does NOT carry a signature membership list",()=>{
  const f=fixture();
  const cap=f.captures.find((c:any)=>c.rpcMethod==="getBlock");
  expect(cap.rpcParams[1].transactionDetails).toBe("none");
  const block=JSON.parse(cap.resultJson);
  expect(block.transactions).toBeUndefined();
  expect(block.signatures).toBeUndefined();
 });

 it("rejects getSignatureStatuses err=null while its status explicitly reports Err",()=>{
  const st=get(fixture(),"getSignatureStatuses");
  st.value[0].status={Err:{"InstructionError":[2,{"Custom":19}]}};
  expectMalformed(()=>parseSignatureStatusesResult(st));
 });

 it("rejects getSignatureStatuses err=TransactionError while status explicitly reports Ok",()=>{
  const st=get(fixture(),"getSignatureStatuses");
  st.value[0].err={"InstructionError":[2,{"Custom":19}]};
  st.value[0].status={Ok:null};
  expectMalformed(()=>parseSignatureStatusesResult(st));
 });

 it("accepts a missing DEPRECATED status discriminator if mandatory err is valid",()=>{
  const st=get(fixture(),"getSignatureStatuses");
  delete st.value[0].status;
  expect(parseSignatureStatusesResult(st).value?.err).toBeNull();
 });

 it("accepts a coherent Solana status.Err and status.err for genuine failed execution",()=>{
  const st=get(fixture(),"getSignatureStatuses");
  const failed={"InstructionError":[2,{"Custom":19}]};
  st.value[0].err=failed;
  st.value[0].status={Err:failed};
  const parsed=parseSignatureStatusesResult(st);
  expect(parsed.value?.err).toEqual(failed);
 });

 it("a foreign getTransaction with different status.err must not make the SUBJECT execution ambiguous",async()=>{
  const f=fixture();
  mutate(f,"getTransaction",(v)=>{
    v.transaction.signatures[0]=v.transaction.signatures[1];
    v.meta.err={"InstructionError":[2,{"Custom":18}]};
  });
  const a=await replaySolanaTransaction(f);
  const out=evaluateSolanaTransaction(a).fragment;
  expect(a.checks.find(c=>c.code==="STATUS_ERROR_MATCHES_TRANSACTION")?.passed).toBe(false);
  expect(out.networkEvidence.execution?.verdict).toBe("insufficient");
  expect(out.networkEvidence.dataBinding?.verdict).not.toBe("supported");
  expect(out.networkEvidence.observedEffects).toEqual([]);
 });


 it("unchanged actual public Solana F3 fixture retains exact execution/binding/finality/effect semantics",async()=>{
  const out=evaluateSolanaTransaction(await replaySolanaTransaction(fixture())).fragment;
  expect(out.networkEvidence.execution?.verdict).toBe("supported");
  expect(out.networkEvidence.dataBinding?.verdict).toBe("supported");
  expect(out.networkEvidence.finality?.verdict).toBe("supported");
  expect(out.networkEvidence.finality?.basis).toEqual(["source_observation"]);
  expect(out.networkEvidence.finality?.metadata?.economicIrreversibilityEstablished).toBe(false);
  expect(out.networkEvidence.observedEffects?.map(x=>x.id))
    .toEqual(["solana-transfer-checked-ce276d84a060fd3e"]);
 });

 it("an internally contradictory duplicate signature check in a caller-created acquisition cannot support any subject dimension",async()=>{
  const original=await replaySolanaTransaction(fixture());
  const tampered={...original,
    checks:[...original.checks,{code:"TRANSACTION_SIGNATURE_MATCHES_SUBJECT",passed:false}],
  };
  const out=evaluateSolanaTransaction(tampered).fragment;
  expect(out.networkEvidence.execution?.verdict).not.toBe("supported");
  expect(out.networkEvidence.dataBinding?.verdict).not.toBe("supported");
  expect(out.networkEvidence.finality?.verdict).not.toBe("supported");
  expect(out.networkEvidence.observedEffects).toEqual([]);
 });

 it("originally successful transaction cannot be relabeled contradicted by a forged signature assertion",async()=>{
  const original=await replaySolanaTransaction(fixture());
  const tx=original.transaction!;
  const tampered={...original,transaction:{...tx,
    signatures:[tx.signatures[1]!,...tx.signatures.slice(1)]}};
  const out=evaluateSolanaTransaction(tampered).fragment;
  expect(out.networkEvidence.execution?.verdict).toBe("insufficient");
  expect(out.networkEvidence.finality?.verdict).not.toBe("supported");
  expect(out.networkEvidence.observedEffects).toEqual([]);
 });

});
