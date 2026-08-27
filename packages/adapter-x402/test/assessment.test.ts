/**
 * PRIMARY-PATH FIXTURES: assessX402ExactPayment over frozen-core
 * NetworkEvidenceFragment evidence (exactly what a generic network resolver
 * returns). Each fixture maps to the v0.1 required scenario matrix.
 */
import { describe, expect, it } from "vitest";
import { canonicalJson } from "@nec/core";

import {
  X402_CLAIM_LABELS,
  X402_NON_CLAIMS,
  X402_WARNING_CODES,
  assessX402ExactPayment,
  evaluateX402ExactSettlement,
  parseX402PaymentClaim,
} from "../src/index.js";
import type { X402PaymentClaim } from "../src/index.js";
import {
  AMOUNT_DEFAULT,
  CHAIN_ID,
  NETWORK_ID,
  OTHER_NETWORK_ID,
  OTHER_RECIPIENT,
  OTHER_SENDER,
  PAYER,
  RECIPIENT,
  TX,
  buildFragment,
  buildResult,
  padTopic,
  transferEffect,
} from "./helpers.js";
import { TRANSFER_TOPIC } from "./helpers.js";

const REQUIREMENT = {
  x402Version: "2",
  scheme: "exact",
  network: NETWORK_ID,
  asset: `0x${"cc".repeat(20)}`,
  payTo: RECIPIENT,
  amount: AMOUNT_DEFAULT,
};

const OTHER_TX = `0x${"6b".repeat(32)}`;

function claim(
  requirementOverrides: Record<string, unknown> = {},
  paymentTxHash: string = TX,
): X402PaymentClaim {
  return parseX402PaymentClaim({
    requirement: { ...REQUIREMENT, ...requirementOverrides },
    paymentTxHash,
  });
}

// ---------------------------------------------------------------------------
// 1. x402-erc20-happy
// ---------------------------------------------------------------------------

describe("1. x402-erc20-happy", () => {
  const fragment = buildFragment({ effects: [transferEffect("eff_1")] });

  it("supports the proposition when the correlated Transfer matches all terms", () => {
    const evaluation = assessX402ExactPayment(claim(), fragment);
    expect(evaluation.outcome.verdict).toBe("supported");
    expect(evaluation.claim).toBe(
      "OBSERVED_CORRELATED_TRANSFER_MATCHES_EXPECTED_X402_PAYMENT_REQUIREMENT",
    );
    expect(evaluation.subjectMatchesClaim).toBe(true);
    expect(evaluation.paymentTxHash).toBe(TX.toLowerCase());
    expect(evaluation.matchingTransfers).toHaveLength(1);
    // Phase-3 verification triple: transaction subject / network / txId.
    expect(fragment.subject).toMatchObject({
      type: "transaction",
      networkId: NETWORK_ID,
      txId: TX,
    });
    expect(evaluation.execution.verdict).toBe("supported");
  });

  it("supports with a bound payer too when the sender matches", () => {
    const bound = claim({ payer: PAYER });
    expect(assessX402ExactPayment(bound, fragment).outcome.verdict).toBe("supported");
    const wrongPayer = claim({ payer: OTHER_SENDER });
    const evaluation = assessX402ExactPayment(wrongPayer, fragment);
    expect(evaluation.outcome.verdict).toBe("ambiguous");
    expect(evaluation.expectationConflictIds).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 2. x402-false-success-null-receipt
// ---------------------------------------------------------------------------

describe("2. x402-false-success-null-receipt", () => {
  it("is insufficient — NEVER contradicted merely from absence", () => {
    // A null receipt means the resolver can provide NO execution dimension.
    const fragment = buildFragment({ omitExecution: true, effects: [] });
    const evaluation = assessX402ExactPayment(claim(), fragment);
    expect(evaluation.outcome.verdict).toBe("insufficient");
    expect(evaluation.execution.providedByFragment).toBe(false);
    expect(evaluation.warnings.map((w) => w.code)).toContain(
      X402_WARNING_CODES.executionDimensionAbsent,
    );
  });
});

// ---------------------------------------------------------------------------
// 3. x402-reverted-payment
// ---------------------------------------------------------------------------

describe("3. x402-reverted-payment", () => {
  it("contradicts execution on revert; the payment cannot be supported", () => {
    // A reverted receipt emits no logs; the resolver reports only the
    // contradicted execution dimension.
    const fragment = buildFragment({
      effects: [],
      executionDim: {
        applicability: "applicable",
        verdict: "contradicted",
        basis: ["source_observation"],
        evidence: ["ev_receipt_1"],
      },
    });
    const evaluation = assessX402ExactPayment(claim(), fragment);
    expect(evaluation.execution.verdict).toBe("contradicted");
    expect(evaluation.outcome.verdict).toBe("contradicted");
    expect(evaluation.matchingTransfers).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4 + 5. wrong recipient / wrong amount (execution separation)
// ---------------------------------------------------------------------------

describe("4/5. successful execution to the wrong payee or amount", () => {
  it("keeps execution supported while the payment expectation conflicts", () => {
    const wrongRecipient = assessX402ExactPayment(
      claim(),
      buildFragment({ effects: [transferEffect("eff_1", { to: OTHER_RECIPIENT })] }),
    );
    expect(wrongRecipient.execution.verdict).toBe("supported");
    expect(wrongRecipient.outcome.verdict).toBe("ambiguous");
    expect(wrongRecipient.expectationConflictIds).toHaveLength(1);
    expect(wrongRecipient.outcome.materialConflictIds).toEqual(wrongRecipient.expectationConflictIds);

    const wrongAmount = assessX402ExactPayment(
      claim(),
      buildFragment({ effects: [transferEffect("eff_1", { amount: "999999" })] }),
    );
    expect(wrongAmount.execution.verdict).toBe("supported");
    expect(wrongAmount.outcome.verdict).toBe("ambiguous");
    expect(wrongAmount.expectationConflictIds).toHaveLength(1);

    for (const evaluation of [wrongRecipient, wrongAmount]) {
      expect(evaluation.outcome.verdict === "supported").toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. x402-network-mismatch
// ---------------------------------------------------------------------------

describe("6. x402-network-mismatch", () => {
  it("fails closed with an explicit contradiction at the proposition level", () => {
    const fragment = buildFragment({ effects: [transferEffect("eff_1")] });
    const evaluation = assessX402ExactPayment(
      claim({ network: OTHER_NETWORK_ID }),
      fragment,
    );
    expect(evaluation.outcome.verdict).toBe("contradicted");
    expect(evaluation.observedNetwork.matchedRequirement).toBe(false);
    expect(evaluation.observedNetwork.networkId).toBe(NETWORK_ID);
    // Never reinterpreted as settlement/finality knowledge:
    expect(evaluation.nonClaims).toContain("TRANSACTION_FINALITY_NOT_ESTABLISHED");
    expect(evaluation.nonClaims).toContain("ECONOMIC_IRREVERSIBILITY_NOT_ESTABLISHED");
    expect(evaluation.warnings.map((w) => w.code)).toContain(
      X402_WARNING_CODES.finalityNotEstablished,
    );
  });
});

// ---------------------------------------------------------------------------
// 7. x402-transaction-hash-mismatch (recovered P1 regression)
// ---------------------------------------------------------------------------

describe("7. x402-transaction-hash-mismatch (P1 regression)", () => {
  it("NEVER lets another transaction's matching-shape Transfer reach supported", () => {
    // THE OLD FALSE-POSITIVE SHAPE: every field matches, but the log belongs
    // to transaction Y while the claim (and subject) name transaction X.
    const fragment = buildFragment({
      effects: [transferEffect("eff_foreign", { transactionHash: OTHER_TX })],
    });
    const evaluation = assessX402ExactPayment(claim(), fragment);
    expect(evaluation.outcome.verdict === "supported").toBe(false);
    expect(evaluation.outcome.verdict).toBe("ambiguous"); // explicit conflict
    expect(evaluation.transactionHashMismatches).toEqual([
      { effectId: "eff_foreign", observedTransactionHash: OTHER_TX },
    ]);
    expect(evaluation.matchingTransfers).toHaveLength(0);
    expect(evaluation.candidateCount).toBe(0);
  });

  it("regresses the old wrapper shape identically", () => {
    const result = buildResult({
      effects: [transferEffect("eff_foreign", { transactionHash: OTHER_TX })],
    });
    const evaluation = evaluateX402ExactSettlement(REQUIREMENT, result);
    expect(evaluation.outcome.verdict === "supported").toBe(false);
    expect(evaluation.outcome.verdict).toBe("ambiguous");
    expect(evaluation.transactionHashMismatches).toHaveLength(1);
  });

  it("stays non-supported even when a genuine match exists alongside contamination", () => {
    const fragment = buildFragment({
      effects: [
        transferEffect("eff_real"),
        transferEffect("eff_foreign_duplicate", { transactionHash: OTHER_TX }),
      ],
    });
    const evaluation = assessX402ExactPayment(claim(), fragment);
    expect(evaluation.matchingTransfers.map((t) => t.effectId)).toEqual(["eff_real"]);
    expect(evaluation.outcome.verdict).toBe("ambiguous");
  });
});

// ---------------------------------------------------------------------------
// 8. malformed / removed Transfers
// ---------------------------------------------------------------------------

describe("8. malformed and removed Transfers are never positive evidence", () => {
  it("excludes removed logs", () => {
    const evaluation = assessX402ExactPayment(
      claim(),
      buildFragment({ effects: [transferEffect("eff_gone", { removed: true })] }),
    );
    expect(evaluation.outcome.verdict).toBe("insufficient");
    expect(evaluation.excludedCandidates[0]).toMatchObject({ reason: "removed" });
  });

  it("excludes malformed transfer claims", () => {
    const evaluation = assessX402ExactPayment(
      claim(),
      buildFragment({
        effects: [
          transferEffect("eff_bad", { topicsOverride: [TRANSFER_TOPIC, padTopic(PAYER)] }),
        ],
      }),
    );
    expect(evaluation.outcome.verdict).toBe("insufficient");
    expect(evaluation.excludedCandidates[0]).toMatchObject({ reason: "malformed" });
  });
});

// ---------------------------------------------------------------------------
// 9. determinism
// ---------------------------------------------------------------------------

describe("9. determinism", () => {
  it("produces deep-equal assessments for identical normalized inputs", () => {
    const fragment = buildFragment({
      effects: [
        transferEffect("eff_noise", { address: `0x${"dd".repeat(20)}` }),
        transferEffect("eff_1"),
        transferEffect("eff_wrong_recipient", { to: OTHER_RECIPIENT }),
      ],
    });
    const a = assessX402ExactPayment(claim(), fragment);
    const b = assessX402ExactPayment(claim(), fragment);
    expect(canonicalJson(a as unknown as Record<string, unknown>)).toBe(
      canonicalJson(b as unknown as Record<string, unknown>),
    );
  });
});

// ---------------------------------------------------------------------------
// 10. standing non-claims
// ---------------------------------------------------------------------------

describe("10. standing non-claims", () => {
  it("emits every permanent non-claim regardless of outcome", () => {
    for (const fragment of [
      buildFragment({ effects: [transferEffect("eff_1")] }), // supported world
      buildFragment({ omitExecution: true }), // insufficient world
      buildFragment({
        effects: [transferEffect("eff_1")],
        executionDim: {
          applicability: "applicable",
          verdict: "contradicted",
          basis: ["source_observation"],
          evidence: ["ev_receipt_1"],
        },
      }), // contradicted world
    ]) {
      const evaluation = assessX402ExactPayment(claim(), fragment);
      expect(evaluation.nonClaims).toEqual(X402_NON_CLAIMS);
      expect(evaluation.nonClaims).toContain("TOKEN_CONTRACT_HONESTY_NOT_ESTABLISHED");
      expect(evaluation.nonClaims).toContain("FACILITATOR_VERIFY_OUTCOME_NOT_ESTABLISHED");
      expect(evaluation.nonClaims).toContain("FACILITATOR_SETTLE_OUTCOME_NOT_ESTABLISHED");
      expect(evaluation.nonClaims).toContain("PROTOCOL_SUCCESS_CLAIM_NOT_ESTABLISHED");
      expect(evaluation.nonClaims).toContain("TRANSACTION_FINALITY_NOT_ESTABLISHED");
      expect(evaluation.nonClaims).toContain("ECONOMIC_IRREVERSIBILITY_NOT_ESTABLISHED");
    }
  });
});

// ---------------------------------------------------------------------------
// Subject-correlation family (Phase 3 verification)
// ---------------------------------------------------------------------------

describe("subject correlation failures never reach supported", () => {
  it("conflicts explicitly when the fragment subject names another transaction", () => {
    const fragment = buildFragment({
      effects: [transferEffect("eff_1", { transactionHash: OTHER_TX })],
      subject: { type: "transaction", networkId: NETWORK_ID, txId: OTHER_TX },
    });
    const evaluation = assessX402ExactPayment(claim(), fragment);
    expect(evaluation.subjectMatchesClaim).toBe(false);
    expect(evaluation.outcome.verdict === "supported").toBe(false);
    expect(evaluation.outcome.verdict).toBe("ambiguous");
    expect(evaluation.outcome.materialConflictIds).toContain(
      "x402.adapter:X402_SUBJECT_NOT_PAYMENT_TRANSACTION",
    );
  });

  it("fails closed when the fragment subject is not a transaction at all", () => {
    const fragment = buildFragment({
      effects: [],
      subject: { type: "block", networkId: NETWORK_ID, blockNumber: 1000n },
    });
    const evaluation = assessX402ExactPayment(claim(), fragment);
    expect(evaluation.subjectMatchesClaim).toBe(false);
    expect(evaluation.outcome.verdict === "supported").toBe(false);
  });

  it("rejects malformed claims instead of assessing them", () => {
    expect(() =>
      assessX402ExactPayment({ hello: "world" }, buildFragment()),
    ).toThrowError();
  });
});
