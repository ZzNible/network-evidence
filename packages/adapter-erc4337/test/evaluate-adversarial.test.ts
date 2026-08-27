import { describe, expect, it } from "vitest";

import {
  assessErc4337UserOperation,
  ERC4337_CONFLICT_CODES,
  EXPECTED_EFFECT_KIND_ERC1155_BURN,
  USER_OPERATION_EVENT_TOPIC0,
} from "../src/index.js";
import type { Conflict } from "@nec/core";

import {
  buildFragment,
  CREDITS_CONTRACT,
  ENTRY_POINT,
  FAKE_ENTRY_POINT,
  NETWORK_ID,
  OTHER_ACCOUNT,
  OTHER_USER_OP_HASH,
  SENDER,
  TOKEN_ID,
  transferSingleEffect,
  TX,
  userOpEventEffect,
  USER_OP_HASH,
} from "./helpers.js";

const CLAIM = {
  network: NETWORK_ID,
  bundleTransactionHash: TX,
  entryPoint: ENTRY_POINT,
  entryPointProfile: "v0.7",
  userOperation: { userOpHash: USER_OP_HASH, sender: SENDER },
};

const BURN = {
  kind: EXPECTED_EFFECT_KIND_ERC1155_BURN as typeof EXPECTED_EFFECT_KIND_ERC1155_BURN,
  contract: CREDITS_CONTRACT,
  from: SENDER,
  tokenId: TOKEN_ID,
  value: "1",
};

describe("malformed relevant evidence fails closed", () => {
  it("a malformed UserOperationEvent beside an exact valid target forces ambiguity", () => {
    // The malformed event's userOpHash is undecodable: it COULD be a second
    // emission of the target hash (replay/double-execution), so competing
    // interpretations remain and a clean positive is refused.
    const good = userOpEventEffect("good");
    const broken = userOpEventEffect("broken", { dataOverride: `0x${"ab".repeat(120)}` });
    const fragment = buildFragment({ effects: [good, broken] });
    const evaluation = assessErc4337UserOperation(CLAIM, fragment);
    expect(evaluation.outcome.verdict).toBe("ambiguous");
    expect(
      evaluation.outcome.materialConflictIds.some((id) =>
        id.includes(ERC4337_CONFLICT_CODES.malformedUserOperationEvent),
      ),
    ).toBe(true);
  });

  it("malformed UserOperationEvent evidence never becomes a clean negative", () => {
    // No usable event at all besides the malformed one: INSUFFICIENT would
    // be "absence"; the conflict forces AMBIGUOUS instead.
    const broken = userOpEventEffect("broken", {
      // Correct pinned topic0 but missing the three indexed topics.
      topicsOverride: [USER_OPERATION_EVENT_TOPIC0],
    });
    const fragment = buildFragment({ effects: [broken] });
    const evaluation = assessErc4337UserOperation(CLAIM, fragment);
    expect(evaluation.outcome.verdict).toBe("ambiguous");
    expect(evaluation.selectedUserOperation).toBeUndefined();
  });

  it("malformed burn evidence turns an otherwise-supported claim ambiguous", () => {
    const good = userOpEventEffect("uop");
    const exactBurn = transferSingleEffect("burn");
    // 65 bytes of data: not exactly two uint256 words -> malformed relevant.
    const trulyMalformed = transferSingleEffect("broken-burn", {
      dataOverride: `0x${"cd".repeat(130)}`,
    });
    const fragment = buildFragment({ effects: [good, exactBurn, trulyMalformed] });
    const evaluation = assessErc4337UserOperation(
      { ...CLAIM, expectedEffect: BURN },
      fragment,
    );
    expect(evaluation.outcome.verdict).toBe("ambiguous");
  });

  it("removed UserOperationEvents are excluded in BOTH directions", () => {
    const removedFailed = userOpEventEffect("removed-failed", {
      userOpHash: OTHER_USER_OP_HASH,
      sender: OTHER_ACCOUNT,
      success: false,
      removed: true,
    });
    const mine = userOpEventEffect("mine");
    const fragment = buildFragment({ effects: [mine, removedFailed] });
    // The removed FAILED event for another op must not contradict anything…
    const evalMine = assessErc4337UserOperation(CLAIM, fragment);
    expect(evalMine.outcome.verdict).toBe("supported");
    // …nor may it stand in as positive evidence for its own proposition.
    const evalOther = assessErc4337UserOperation(
      { ...CLAIM, userOperation: { userOpHash: OTHER_USER_OP_HASH, sender: OTHER_ACCOUNT } },
      fragment,
    );
    expect(evalOther.outcome.verdict).toBe("insufficient");
  });

  it("a forged emitter cannot satisfy the claim even with identical fields", () => {
    const forged = userOpEventEffect("forged", { emitter: FAKE_ENTRY_POINT });
    const fragment = buildFragment({ effects: [forged] });
    const evaluation = assessErc4337UserOperation(CLAIM, fragment);
    expect(evaluation.outcome.verdict).toBe("insufficient");
    expect(evaluation.candidateCount).toBe(0);
    expect(evaluation.nonEntryEmitterCount).toBe(1);
  });
});

describe("compounding and provider disputes", () => {
  it("failed op + refuted burn compose to a single clean contradiction (no crash)", () => {
    const failedOp = userOpEventEffect("failed-op", { success: false });
    const wrongValueBurn = transferSingleEffect("wrong-value", { value: "7" });
    const fragment = buildFragment({ effects: [failedOp, wrongValueBurn] });
    const evaluation = assessErc4337UserOperation(
      { ...CLAIM, expectedEffect: BURN },
      fragment,
    );
    expect(evaluation.outcome.verdict).toBe("contradicted");
    expect(evaluation.selectedUserOperationFailure?.reason).toBe("userOperationFailed");
    expect(evaluation.conflictingBurns).toHaveLength(1);
  });

  it("successful op + malformed burn stays ambiguous (no supported laundering)", () => {
    const goodOp = userOpEventEffect("good-op");
    const malformedBurn = transferSingleEffect("bad-burn", {
      dataOverride: `0x${"ab".repeat(120)}`,
    });
    const fragment = buildFragment({ effects: [goodOp, malformedBurn] });
    const evaluation = assessErc4337UserOperation(
      { ...CLAIM, expectedEffect: BURN },
      fragment,
    );
    expect(evaluation.outcome.verdict).toBe("ambiguous");
  });

  it("a pre-existing provider conflict about an inspected effect forces ambiguity", () => {
    const good = userOpEventEffect("uop");
    const dispute: Conflict = {
      id: "conflict-provider-disagreement",
      code: "OBSERVED_EFFECT_DISAGREEMENT",
      description: "Independent observations disagree about this log.",
      scope: { kind: "observed_effect", effectId: "uop" },
      evidence: ["ev_uop"],
      material: true,
    };
    const fragment = buildFragment({ effects: [good], conflicts: [dispute] });
    const evaluation = assessErc4337UserOperation(CLAIM, fragment);
    expect(evaluation.outcome.verdict).toBe("ambiguous");
  });

  it("a settlement-scoped provider dispute never crashes nor ambiguates (out of layer)", () => {
    // Regression: network mismatch + matched op + a material conflict
    // scoped to a dimension this adapter never evaluates must compose to a
    // clean contradiction, never an aggregation failure.
    const good = userOpEventEffect("uop");
    const fragment = buildFragment({
      networkId: "eip155:84532",
      chainId: 84532,
      effects: [good],
      conflicts: [
        {
          id: "conflict-settlement-dispute",
          code: "SETTLEMENT_DISAGREEMENT",
          description: "settlement sources disagree",
          scope: { kind: "dimension", dimension: "settlement" },
          evidence: ["ev_receipt_1"],
          material: true,
        },
      ],
    });
    const evaluation = assessErc4337UserOperation(
      { ...CLAIM, expectedEffect: BURN },
      fragment,
    );
    expect(evaluation.outcome.verdict).toBe("contradicted");
  });

  it("chainId mismatch under same family is a clean contradiction", () => {
    const fragment = buildFragment({
      chainId: 84532,
      networkId: "eip155:84532",
      effects: [userOpEventEffect("uop")],
    });
    const evaluation = assessErc4337UserOperation(CLAIM, fragment);
    expect(evaluation.outcome.verdict).toBe("contradicted");
  });

  it("carried finality is reported verbatim and never asserted by this adapter", () => {
    const withFinality = buildFragment({
      effects: [userOpEventEffect("uop")],
      finalityDim: { applicability: "applicable", verdict: "supported", basis: ["source_observation"], evidence: ["ev_receipt_1"] },
    });
    const evaluation = assessErc4337UserOperation(CLAIM, withFinality);
    // Even WITH a supported carried finality dimension, the adapter's own
    // standing non-claims stay identical — finality composition happens
    // above this package.
    expect(evaluation.nonClaims).toContain("L2_BLOCK_FINALITY_NOT_ESTABLISHED");
    expect(evaluation.outcome.verdict).toBe("supported");
  });
});
