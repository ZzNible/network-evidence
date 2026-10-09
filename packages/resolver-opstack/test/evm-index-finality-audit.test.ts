import {describe,expect,it} from "vitest";
import {acquireOpStackFinalityObservation,evaluateOpStackFinality} from "../src/index.js";
import {
  config,genericAcquisition,opstackResponses,opstackSource,
  NOW,scriptedOpstackFetch,SUBJECT_HASH,SUBJECT_NUMBER,
} from "./helpers.js";

describe("OP Stack exact transaction membership is a prerequisite for L2 finality",()=>{
  it("refuses to infer subject finality when generic EVM block-index membership explicitly fails",async()=>{
    const evm=await genericAcquisition();
    expect(evm.checks.find(c=>c.code==="RECEIPT_TRANSACTION_AT_BLOCK_INDEX")?.passed).toBe(true);
    const {fetchFn}=scriptedOpstackFetch(opstackResponses({}));
    const observed=await acquireOpStackFinalityObservation({
      source:opstackSource(),
      subjectBlock:{number:SUBJECT_NUMBER,hash:SUBJECT_HASH},
      now:NOW,fetchFn,
    });
    const valid=evaluateOpStackFinality({config:config(),evm,finality:observed});
    expect(valid.dimension.dimension.verdict).toBe("supported");
    const invalid={
      ...evm,
      checks:evm.checks.map(c=>c.code==="RECEIPT_TRANSACTION_AT_BLOCK_INDEX"
        ? {...c,passed:false,detail:"receipt transaction absent from ordered block hashes"} : c),
      consistent:false,
    };
    const result=evaluateOpStackFinality({config:config(),evm:invalid,finality:observed});
    expect(result.dimension.dimension.applicability).toBe("unknown");
    expect(result.dimension.dimension.verdict).toBeUndefined();
    expect(result.warnings.some(w=>w.code==="OP_GENERIC_BINDING_NOT_ESTABLISHED")).toBe(true);
    expect(result.fragment.networkEvidence.finality?.verdict).toBeUndefined();
  });
  it("does not silently allow a missing mandatory membership check",async()=>{
    const evm=await genericAcquisition();
    const {fetchFn}=scriptedOpstackFetch(opstackResponses({}));
    const observed=await acquireOpStackFinalityObservation({
      source:opstackSource(),
      subjectBlock:{number:SUBJECT_NUMBER,hash:SUBJECT_HASH},
      now:NOW,fetchFn,
    });
    const without={...evm,
      checks:evm.checks.filter(c=>c.code!=="RECEIPT_TRANSACTION_AT_BLOCK_INDEX")};
    const result=evaluateOpStackFinality({config:config(),evm:without,finality:observed});
    expect(result.dimension.dimension.applicability).toBe("unknown");
    expect(result.dimension.dimension.verdict).toBeUndefined();
  });
});
