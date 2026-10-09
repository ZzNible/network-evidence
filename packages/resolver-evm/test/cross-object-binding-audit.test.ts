import { describe, expect, it } from "vitest";
import { acquireTransactionObservation, evaluateTransactionAcquisition } from "../src/index.js";
import { deriveEvmBeforeFoundation } from "../src/before.js";
import type { EvmCapabilityProbeObservation, EvmProbePath } from "../src/before.js";
import {
  happyPathResponses, NOW, TX, OTHER_TX, source, scriptedFetch,
  successBlockResultText, successReceiptResultText,
} from "./helpers.js";

const NET = "eip155:8453";

function beforeObservation(overrides: Partial<EvmCapabilityProbeObservation> = {}): EvmCapabilityProbeObservation {
  const paths: EvmProbePath[] = ["chainidentity","receipt","block","transaction"];
  return {
    network: NET,
    chainId: 8453,
    source: {sourceId:"src.base.test",sourceType:"evm_rpc"},
    observedAt: NOW, rpcReachable: true,
    chainIdentityObserved: true, receiptLookupUsable: true,
    blockLookupUsable: true, transactionLookupUsable: true,
    evidence: paths.map((path,i)=>({
      id: "ev-"+path,
      sourceId: "src.base.test", sourceType:"evm_rpc",
      locator:"rpc:"+path, retrievedAt:NOW,
      contentDigest:"sha256:"+String(i+1).repeat(64),
      networkId:NET, metadata: {probePath:path},
    })),
    ...overrides,
  };
}

describe("security audit EVM cross-object source bindings",()=>{
  for(const item of [
    {name:"block containing a DIFFERENT transaction", txs:[OTHER_TX], ix:"0x0"},
    {name:"matching hash exists at WRONG index", txs:[OTHER_TX, TX], ix:"0x0"},
    {name:"receipt index OUT OF BOUNDS", txs:[TX], ix:"0x1"},
    {name:"EMPTY block transaction list", txs:[], ix:"0x0"},
  ]){
    it("fails closed on "+item.name+" even if receipt hash, block hash/number and status agree", async()=>{
      const {fetchFn}=scriptedFetch(happyPathResponses({
        receipt:successReceiptResultText({transactionIndex:item.ix}),
        block:successBlockResultText({transactions:item.txs}),
      }));
      const obs=await acquireTransactionObservation({source:source(),txHash:TX,now:NOW,fetchFn});
      expect(obs.receipt?.transactionHash).toBe(TX);
      expect(obs.block?.hash).toBe(obs.receipt?.blockHash);
      expect(obs.checks.find(c=>c.code==="RECEIPT_TRANSACTION_AT_BLOCK_INDEX")?.passed).toBe(false);
      expect(obs.consistent).toBe(false);
      const assessed=evaluateTransactionAcquisition(obs);
      expect(assessed.dimensions.execution.dimension.verdict).not.toBe("supported");
      expect(assessed.dimensions.dataBinding.dimension.verdict).not.toBe("supported");
      expect(assessed.conflicts.some(c=>c.material && c.scope.kind==="dimension" &&
        c.scope.dimension==="execution")).toBe(true);
      expect(assessed.conflicts.some(c=>c.material && c.scope.kind==="dimension" &&
        c.scope.dimension==="dataBinding")).toBe(true);
    });
  }

  it("preserves valid actual indexed membership and no new RPC reads",async()=>{
    const {fetchFn,seen}=scriptedFetch(happyPathResponses({block:successBlockResultText()}));
    const obs=await acquireTransactionObservation({source:source(),txHash:TX,now:NOW,fetchFn});
    expect(obs.checks.find(c=>c.code==="RECEIPT_TRANSACTION_AT_BLOCK_INDEX")?.passed).toBe(true);
    expect(obs.consistent).toBe(true);
    expect(evaluateTransactionAcquisition(obs).dimensions.execution.dimension.verdict).toBe("supported");
    expect(seen.methods).toEqual(["eth_chainId","eth_getTransactionReceipt","eth_getBlockByHash"]);
  });

  it("rejects an observed chainId DIFFERENT from the declared CAIP eip155 target, BEFORE snapshots",()=>{
    const spoof=beforeObservation({chainId:1});
    expect(()=>deriveEvmBeforeFoundation({networkId:NET,observation:spoof}))
      .toThrow(/chainId.*network|chainId.*8453|chain identity/i);
  });

  it("rejects positive chainIdentityObserved without an actual numeric chainId",()=>{
    const spoof=beforeObservation({chainId:undefined});
    expect(()=>deriveEvmBeforeFoundation({networkId:NET,observation:spoof}))
      .toThrow(/chainId/);
  });

  it("treats an unobserved chainId as unknown evidence readiness, not network failure",()=>{
    const absent=beforeObservation({chainId:undefined,chainIdentityObserved:false});
    const actual=deriveEvmBeforeFoundation({networkId:NET,observation:absent});
    expect(actual.snapshot.evidenceCapabilities.execution.availability).toBe("unknown");
    expect(actual.snapshot.evidenceCapabilities.dataBinding.availability).toBe("unknown");
  });

  it("does not accept a contradictory claimed chainId even if chainIdentityObserved=false",()=>{
    const spoof=beforeObservation({chainId:1,chainIdentityObserved:false});
    expect(()=>deriveEvmBeforeFoundation({networkId:NET,observation:spoof}))
      .toThrow(/chainId.*network|chainId.*8453|chain identity/i);
  });

  it("keeps a FOREIGN receipt as insufficient execution, not a forged block-index contradiction",async()=>{
    const {fetchFn}=scriptedFetch(happyPathResponses({
      receipt:successReceiptResultText({transactionHash:OTHER_TX}),
      block:successBlockResultText({transactions:[TX]}),
    }));
    const obs=await acquireTransactionObservation({source:source(),txHash:TX,now:NOW,fetchFn});
    expect(obs.checks.find(c=>c.code==="RECEIPT_TX_HASH_MATCHES_SUBJECT")?.passed).toBe(false);
    expect(obs.checks.find(c=>c.code==="RECEIPT_TRANSACTION_AT_BLOCK_INDEX")?.passed).toBe(false);
    const assessed=evaluateTransactionAcquisition(obs);
    expect(assessed.dimensions.execution.dimension.verdict).toBe("insufficient");
    expect(assessed.dimensions.dataBinding.dimension.verdict).toBe("ambiguous");
    expect(assessed.conflicts.every(c=>c.code!=="RECEIPT_TRANSACTION_AT_BLOCK_INDEX")).toBe(true);
  });

  it("rejects a receipt without its mandatory index as malformed RPC input, not negative evidence",async()=>{
    const {fetchFn}=scriptedFetch(happyPathResponses({
      receipt:successReceiptResultText({transactionIndex:undefined}),
      block:successBlockResultText(),
    }));
    await expect(acquireTransactionObservation({source:source(),txHash:TX,now:NOW,fetchFn}))
      .rejects.toMatchObject({code:"EVM_MALFORMED_RESPONSE"});
  });

  it("rejects uppercase/noncanonical transaction hashes structurally BEFORE membership evaluation",async()=>{
    const {fetchFn}=scriptedFetch(happyPathResponses({
      block:successBlockResultText({transactions:[TX.toUpperCase()]}),
    }));
    await expect(acquireTransactionObservation({source:source(),txHash:TX,now:NOW,fetchFn}))
      .rejects.toMatchObject({code:"EVM_MALFORMED_RESPONSE"});
  });

  it("rejects a rounded unsafe JavaScript chainId before any eip155 BigInt comparison",()=>{
    const spoof=beforeObservation({chainId:Number.MAX_SAFE_INTEGER+1});
    expect(()=>deriveEvmBeforeFoundation({networkId:NET,observation:spoof}))
      .toThrow(/chainId must be a safe positive integer/);
  });

  it("rejects a self-consistent observation of ANOTHER chain against the explicitly selected target",()=>{
    const spoof=beforeObservation({
      network:"eip155:1",chainId:1,
      evidence:beforeObservation().evidence.map(ref=>({...ref,networkId:"eip155:1"})),
    });
    expect(()=>deriveEvmBeforeFoundation({networkId:NET,observation:spoof}))
      .toThrow(/does not match the explicitly requested target/);
  });

  it("does not report successful execution when the source returns NO containing block",async()=>{
    const {fetchFn}=scriptedFetch(happyPathResponses({block:"null"}));
    const obs=await acquireTransactionObservation({source:source(),txHash:TX,now:NOW,fetchFn});
    const assessed=evaluateTransactionAcquisition(obs);
    expect(obs.consistent).toBe(false);
    expect(assessed.dimensions.execution.dimension.verdict).not.toBe("supported");
  });

});
