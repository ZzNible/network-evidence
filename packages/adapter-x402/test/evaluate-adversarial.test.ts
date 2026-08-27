import { describe, expect, it } from "vitest";

import {
  X402_CLAIM_LABELS,
  X402_NON_CLAIMS,
  X402_WARNING_CODES,
  NecAdapterX402Error,
  eip55ChecksumAddress,
  evaluateX402ExactSettlement,
} from "../src/index.js";
import type { X402PaymentEvaluation } from "../src/index.js";
import {
  AMOUNT_DEFAULT,
  CHAIN_ID,
  NETWORK_ID,
  OTHER_RECIPIENT,
  OTHER_SENDER,
  OTHER_TOKEN,
  PAYER,
  RECIPIENT,
  T1,
  TX,
  buildResult,
  conflict,
  evidenceRef,
  padTopic,
  transferEffect,
  unrelatedEffect,
} from "./helpers.js";
import type { NetworkEvidenceResult } from "@nec/core";
import { TRANSFER_TOPIC } from "./helpers.js";

const BASE_REQUIREMENT = {
  x402Version: "2",
  scheme: "exact",
  network: NETWORK_ID,
  asset: `0x${"cc".repeat(20)}`,
  payTo: RECIPIENT,
  amount: AMOUNT_DEFAULT,
};

function happyWorld() {
  return buildResult({ effects: [transferEffect("eff_1")] });
}

function warningsOf(evaluation: X402PaymentEvaluation): string[] {
  return evaluation.warnings.map((w) => w.code);
}

describe("happy path (strongest positive result)", () => {
  const requirement = BASE_REQUIREMENT;
  const result = happyWorld();
  const evaluation = evaluateX402ExactSettlement(requirement, result);

  it("reports the observed-match claim, never verified settlement", () => {
    expect(evaluation.outcome.verdict).toBe("supported");
    expect(evaluation.claim).toBe(
      "OBSERVED_CORRELATED_TRANSFER_MATCHES_EXPECTED_X402_PAYMENT_REQUIREMENT",
    );
    expect(evaluation.claim).not.toContain("VERIFIED");
    expect(evaluation.claim).not.toContain("SETTLEMENT_ESTABLISHED");
  });

  it("emits every permanent non-claim", () => {
    expect(evaluation.nonClaims).toEqual(X402_NON_CLAIMS);
    expect(evaluation.nonClaims).toContain("TOKEN_CONTRACT_HONESTY_NOT_ESTABLISHED");
    expect(evaluation.nonClaims).toContain("FACILITATOR_SETTLE_OUTCOME_NOT_ESTABLISHED");
    expect(evaluation.nonClaims).toContain("ECONOMIC_IRREVERSIBILITY_NOT_ESTABLISHED");
  });

  it("decodes the matching transfer deterministically", () => {
    expect(evaluation.candidateCount).toBe(1);
    expect(evaluation.matchingTransfers).toHaveLength(1);
    expect(evaluation.matchingTransfers[0]).toMatchObject({
      asset: `0x${"cc".repeat(20)}`,
      from: PAYER,
      to: RECIPIENT,
      amount: "1000000",
    });
    expect(evaluation.excludedCandidates).toHaveLength(0);
    expect(evaluation.observedNetwork.matchedRequirement).toBe(true);
  });

  it("warns that finality and settlement are not established despite support", () => {
    const codes = warningsOf(evaluation);
    expect(codes).toContain(X402_WARNING_CODES.finalityNotEstablished);
    expect(codes).toContain(X402_WARNING_CODES.settlementNotEstablished);
  });

  it("binds the proposition to the requirement digest and the subject transaction", () => {
    expect(evaluation.requirementDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(evaluation.paymentTxHash).toBe(TX.toLowerCase());
    expect(evaluation.subjectMatchesClaim).toBe(true);
  });
});

describe("adversarial: wrong network / token / recipient / amount / payer", () => {
  it("contradicts on a different chain id", () => {
    const result = happyWorld();
    const evaluation = evaluateX402ExactSettlement(
      { ...BASE_REQUIREMENT, network: "eip155:1" },
      result,
    );
    expect(evaluation.outcome.verdict).toBe("contradicted");
    expect(evaluation.observedNetwork.matchedRequirement).toBe(false);
    expect(evaluation.claim).toBe(X402_CLAIM_LABELS.contradicted);
  });

  it("is insufficient (not contradicted) on a different token (ordinary noise)", () => {
    const result = buildResult({
      effects: [transferEffect("eff_1", { address: OTHER_TOKEN })],
    });
    const evaluation = evaluateX402ExactSettlement(BASE_REQUIREMENT, result);
    expect(evaluation.outcome.verdict).toBe("insufficient");
    expect(evaluation.matchingTransfers).toHaveLength(0);
    expect(evaluation.candidateCount).toBe(1);
    // Other-token activity is near-miss noise: no expectation conflict.
    expect(evaluation.expectationConflictIds).toHaveLength(0);
  });

  it("explicitly conflicts on a different recipient (execution stays supported)", () => {
    const result = buildResult({
      effects: [transferEffect("eff_1", { to: OTHER_RECIPIENT })],
    });
    const evaluation = evaluateX402ExactSettlement(BASE_REQUIREMENT, result);
    // The payment expectation is NOT supported — surfaced deterministically
    // as an explicit claim-vs-network conflict, never silent "no match".
    expect(evaluation.outcome.verdict).toBe("ambiguous");
    expect(evaluation.expectationConflictIds).toHaveLength(1);
    // Execution semantics are NEVER rewritten by the failed expectation.
    expect(evaluation.execution).toMatchObject({
      providedByFragment: true,
      applicability: "applicable",
      verdict: "supported",
    });
  });

  it("explicitly conflicts on a one-unit amount difference (exactness)", () => {
    const result = buildResult({
      effects: [transferEffect("eff_1", { amount: "999999" })],
    });
    const evaluation = evaluateX402ExactSettlement(BASE_REQUIREMENT, result);
    expect(evaluation.outcome.verdict).toBe("ambiguous");
    expect(evaluation.expectationConflictIds).toHaveLength(1);
  });

  it("fails closed when the requirement binds a payer and the sender differs", () => {
    const result = buildResult({ effects: [transferEffect("eff_1")] });
    const bound = { ...BASE_REQUIREMENT, payer: PAYER };
    expect(evaluateX402ExactSettlement(bound, result).outcome.verdict).toBe("supported");

    const wrongPayer = { ...BASE_REQUIREMENT, payer: OTHER_SENDER };
    const evaluation = evaluateX402ExactSettlement(wrongPayer, result);
    expect(evaluation.outcome.verdict).toBe("ambiguous");
    expect(evaluation.expectationConflictIds).toHaveLength(1);
  });

  it("supports an unbound payer requirement even when payer info is absent from the log", () => {
    // x402 binds the payer ONLY when the expectation says so.
    const result = happyWorld();
    const evaluation = evaluateX402ExactSettlement(BASE_REQUIREMENT, result);
    expect(evaluation.outcome.verdict).toBe("supported");
  });
});

describe("adversarial: execution evidence", () => {
  it("contradicts when the generic execution dimension shows revert", () => {
    const result = buildResult({
      effects: [transferEffect("eff_1")],
      executionDim: {
        applicability: "applicable",
        verdict: "contradicted",
        basis: ["source_observation"],
        evidence: ["ev_receipt_revert"],
      },
      extraRefs: [evidenceRef("ev_receipt_revert")],
    });
    const evaluation = evaluateX402ExactSettlement(BASE_REQUIREMENT, result);
    expect(evaluation.outcome.verdict).toBe("contradicted");
    // Proof non-laundering: provenance comes only from the contradicted side.
    expect(evaluation.outcome.evidence).toContain("ev_receipt_revert");
  });

  it("becomes unknown when execution evidence itself is undetermined", () => {
    const result = buildResult({
      effects: [transferEffect("eff_1")],
      executionDim: { applicability: "unknown", verdict: undefined },
    });
    const evaluation = evaluateX402ExactSettlement(BASE_REQUIREMENT, result);
    expect(evaluation.outcome.applicability).toBe("unknown");
    expect(evaluation.outcome.verdict).toBeUndefined();
    expect(evaluation.claim).toBe(X402_CLAIM_LABELS.undetermined);
  });

  it("demotes not_applicable execution to insufficient with a warning", () => {
    const result = buildResult({
      effects: [transferEffect("eff_1")],
      executionDim: {
        applicability: "not_applicable",
        verdict: undefined,
        basis: [],
        evidence: [],
      },
    });
    const evaluation = evaluateX402ExactSettlement(BASE_REQUIREMENT, result);
    expect(evaluation.outcome.verdict).toBe("insufficient");
    expect(warningsOf(evaluation)).toContain(
      X402_WARNING_CODES.executionDimensionNotApplicable,
    );
  });
});

describe("adversarial: log population", () => {
  it("is insufficient when no Transfer-shaped log exists", () => {
    const result = buildResult({ effects: [unrelatedEffect("eff_u")] });
    const evaluation = evaluateX402ExactSettlement(BASE_REQUIREMENT, result);
    expect(evaluation.outcome.verdict).toBe("insufficient");
    expect(warningsOf(evaluation)).toContain(X402_WARNING_CODES.noTransferObserved);
    expect(evaluation.unrelatedEffectCount).toBe(1);
  });

  it("finds the match among multiple candidate logs", () => {
    const result = buildResult({
      effects: [
        transferEffect("eff_noise", { address: OTHER_TOKEN }),
        unrelatedEffect("eff_u"),
        transferEffect("eff_match"),
      ],
    });
    const evaluation = evaluateX402ExactSettlement(BASE_REQUIREMENT, result);
    expect(evaluation.outcome.verdict).toBe("supported");
    expect(evaluation.matchingTransfers.map((t) => t.effectId)).toEqual(["eff_match"]);
    expect(evaluation.candidateCount).toBe(2);
  });

  it("excludes removed logs from positive proof", () => {
    const result = buildResult({
      effects: [transferEffect("eff_gone", { removed: true })],
    });
    const evaluation = evaluateX402ExactSettlement(BASE_REQUIREMENT, result);
    expect(evaluation.outcome.verdict).toBe("insufficient");
    expect(evaluation.excludedCandidates[0]).toMatchObject({ reason: "removed" });
    expect(warningsOf(evaluation)).toContain(X402_WARNING_CODES.removedCandidateExcluded);
  });

  it("excludes malformed transfer claims instead of interpreting them", () => {
    const result = buildResult({
      effects: [
        transferEffect("eff_bad_topics", { topicsOverride: [TRANSFER_TOPIC, padTopic(PAYER)] }),
      ],
    });
    const evaluation = evaluateX402ExactSettlement(BASE_REQUIREMENT, result);
    expect(evaluation.outcome.verdict).toBe("insufficient");
    expect(evaluation.excludedCandidates[0]).toMatchObject({ reason: "malformed" });
    expect(warningsOf(evaluation)).toContain(X402_WARNING_CODES.malformedCandidateExcluded);
  });

  it("flags duplicate fully-matching transfers as double-payment risk but stays supported", () => {
    const result = buildResult({
      effects: [transferEffect("eff_a"), transferEffect("eff_b")],
    });
    const evaluation = evaluateX402ExactSettlement(BASE_REQUIREMENT, result);
    expect(evaluation.outcome.verdict).toBe("supported");
    expect(evaluation.matchingTransfers).toHaveLength(2);
    expect(warningsOf(evaluation)).toContain(X402_WARNING_CODES.duplicateMatchingTransfers);
  });
});

describe("adversarial: conflicts drive ambiguity through the frozen ladder", () => {
  it("goes ambiguous on a material conflict scoped to a relied-upon effect", () => {
    const c = conflict({
      id: "conflict_eff_1",
      scope: { kind: "observed_effect", effectId: "eff_1" },
      evidence: ["ev_eff_1"],
    });
    const result = buildResult({ effects: [transferEffect("eff_1")], conflicts: [c] });
    const evaluation = evaluateX402ExactSettlement(BASE_REQUIREMENT, result);
    expect(evaluation.outcome.verdict).toBe("ambiguous");
    expect(evaluation.claim).toBe(X402_CLAIM_LABELS.ambiguous);
    expect(evaluation.outcome.materialConflictIds).toEqual(["conflict_eff_1"]);
    expect(warningsOf(evaluation)).toContain("MATERIAL_CONFLICT_BLOCKS_CONCLUSION");
  });

  it("ignores material conflicts about unrelated effects", () => {
    // The disputed effect must exist in the artifact (core referential
    // integrity) but is not Transfer-shaped, so it cannot affect payment.
    const c = conflict({
      id: "conflict_other",
      scope: { kind: "observed_effect", effectId: "eff_unrelated" },
      evidence: ["ev_eff_unrelated"],
    });
    const result = buildResult({
      effects: [transferEffect("eff_1"), unrelatedEffect("eff_unrelated")],
      conflicts: [c],
    });
    const evaluation = evaluateX402ExactSettlement(BASE_REQUIREMENT, result);
    expect(evaluation.outcome.verdict).toBe("supported");
  });

  it("goes ambiguous on a result-scoped material conflict", () => {
    // Core's state machine requires every applicable dimension of an
    // artifact carrying a result-scoped material conflict to be "ambiguous"
    // (a result-scoped conflict affects EVERY proposition).
    const c = conflict({
      id: "conflict_global",
      scope: { kind: "result" },
      evidence: ["ev_receipt_1"],
    });
    const result = buildResult({
      effects: [transferEffect("eff_1")],
      executionDim: {
        applicability: "applicable",
        verdict: "ambiguous",
        basis: ["source_observation"],
        evidence: ["ev_receipt_1"],
      },
      conflicts: [c],
    });
    const evaluation = evaluateX402ExactSettlement(BASE_REQUIREMENT, result);
    expect(evaluation.outcome.verdict).toBe("ambiguous");
  });

  it("goes ambiguous when a material conflict disputes the execution dimension", () => {
    const c = conflict({
      id: "conflict_exec",
      scope: { kind: "dimension", dimension: "execution" },
      evidence: ["ev_receipt_1"],
    });
    const result = buildResult({
      effects: [transferEffect("eff_1")],
      executionDim: {
        applicability: "applicable",
        // The disputed-dimension representation core's state machine
        // REQUIRES alongside an affecting material conflict.
        verdict: "ambiguous",
        basis: ["source_observation"],
        evidence: ["ev_receipt_1"],
      },
      conflicts: [c],
    });
    const evaluation = evaluateX402ExactSettlement(BASE_REQUIREMENT, result);
    expect(evaluation.outcome.verdict).toBe("ambiguous");
  });

  it("contradicts when finality evidence shows reversal", () => {
    const result = buildResult({
      effects: [transferEffect("eff_1")],
      finalityDim: {
        applicability: "applicable",
        verdict: "contradicted",
        basis: ["source_observation"],
        evidence: ["ev_finality_reorg"],
      },
      extraRefs: [evidenceRef("ev_finality_reorg")],
    });
    const evaluation = evaluateX402ExactSettlement(BASE_REQUIREMENT, result);
    expect(evaluation.outcome.verdict).toBe("contradicted");
  });

  it("stays supported without any finality signal (non-claim instead)", () => {
    const result = happyWorld();
    const evaluation = evaluateX402ExactSettlement(BASE_REQUIREMENT, result);
    expect(evaluation.outcome.verdict).toBe("supported");
    expect(evaluation.nonClaims).toContain("TRANSACTION_FINALITY_NOT_ESTABLISHED");
  });
});

describe("adversarial: artifact intake fails closed", () => {
  it("rejects artifacts whose conflicts cite absent effects (core validation)", () => {
    const valid = happyWorld();
    const tampered = {
      ...valid,
      generatedAt: T1,
      conflicts: [
        conflict({
          scope: { kind: "observed_effect", effectId: "eff_ghost" },
          evidence: ["ev_eff_1"],
        }),
      ],
    } as unknown as NetworkEvidenceResult;
    // The ghost effect does not exist in the artifact's effect table.
    expect(() => evaluateX402ExactSettlement(BASE_REQUIREMENT, tampered)).toThrowError(
      /effectId/,
    );
  });

  it("rejects non-artifact garbage instead of evaluating it", () => {
    expect(() =>
      evaluateX402ExactSettlement(BASE_REQUIREMENT, { hello: "world" } as unknown as NetworkEvidenceResult),
    ).toThrowError();
    expect(() =>
      evaluateX402ExactSettlement(BASE_REQUIREMENT, null as unknown as NetworkEvidenceResult),
    ).toThrowError();
  });
});

describe("adversarial: precision and case handling", () => {
  it("compares huge amounts exactly (no float precision loss)", () => {
    const huge = "12345678901234567890123456789012345678901234567890123456789012345678901";
    const almostHuge = `${huge.slice(0, -1)}2`;
    const matching = buildResult({
      effects: [transferEffect("eff_huge", { amount: huge })],
    });
    expect(evaluateX402ExactSettlement({ ...BASE_REQUIREMENT, amount: huge }, matching).outcome.verdict).toBe(
      "supported",
    );
    const differing = buildResult({
      effects: [transferEffect("eff_huge2", { amount: almostHuge })],
    });
    // Right token, wrong (1-atom) amount: explicit expectation conflict.
    expect(evaluateX402ExactSettlement({ ...BASE_REQUIREMENT, amount: huge }, differing).outcome.verdict).toBe(
      "ambiguous",
    );
  });

  it("matches checksummed/uppercase requirement addresses against lowercase evidence", () => {
    const tokenLower = `0x${"cc".repeat(20)}`;
    const reqChecksummed = {
      ...BASE_REQUIREMENT,
      payTo: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
      asset: eip55(tokenLower),
    };
    // Evidence log pays the checksummed-address recipient in lowercase form.
    const result = buildResult({
      effects: [
        transferEffect("eff_case", { to: "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed" }),
      ],
    });
    const evaluation = evaluateX402ExactSettlement(reqChecksummed, result);
    expect(evaluation.outcome.verdict).toBe("supported");
    expect(evaluation.requirement.payTo).toBe("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed");
  });

  it("rejects a bad EIP-55 checksum outright", () => {
    expect(() =>
      evaluateX402ExactSettlement(
        { ...BASE_REQUIREMENT, asset: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD" },
        happyWorld(),
      ),
    ).toThrowError(new RegExp("X402_ADDRESS_CHECKSUM_INVALID"));
  });
});

function eip55(lower: string): string {
  // Local helper alias (validated against published vectors in
  // keccak-address.test).
  return eip55ChecksumAddress(lower);
}

describe("requirement-side rejections surface through evaluation too", () => {
  it("rejects unsupported schemes at evaluation time", () => {
    expect(() =>
      evaluateX402ExactSettlement({ ...BASE_REQUIREMENT, scheme: "upto" }, happyWorld()),
    ).toThrowError(NecAdapterX402Error);
  });

  it("never mutates or trusts the artifact subject tx id beyond reporting", () => {
    const result = happyWorld();
    const evaluation = evaluateX402ExactSettlement(BASE_REQUIREMENT, result);
    expect((result.subject as { txId: string }).txId).toBe(TX);
    expect(evaluation.observedNetwork.networkId).toBe(NETWORK_ID);
    expect(evaluation.observedNetwork.chainId).toBe(CHAIN_ID);
  });

  it("recognizes uppercase hex inside evidence fields defensively", () => {
    // Even though generic acquisition emits lowercase, the adapter normalizes.
    const upperToken = `0x${"CC".repeat(20)}`;
    const result = buildResult({
      effects: [transferEffect("eff_upper", { address: upperToken })],
    });
    const evaluation = evaluateX402ExactSettlement(BASE_REQUIREMENT, result);
    expect(evaluation.matchingTransfers[0]!.asset).toBe(`0x${"cc".repeat(20)}`);
    expect(evaluation.outcome.verdict).toBe("supported");
  });
});
