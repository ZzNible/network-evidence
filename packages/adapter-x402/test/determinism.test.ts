import { describe, expect, it } from "vitest";
import { canonicalJson } from "@nec/core";

import {
  computeRequirementDigest,
  evaluateX402ExactSettlement,
  parseX402ExactPaymentRequirement,
} from "../src/index.js";
import { AMOUNT_DEFAULT, NETWORK_ID, RECIPIENT, buildResult, transferEffect } from "./helpers.js";

const BASE_REQUIREMENT = {
  x402Version: "2",
  scheme: "exact",
  network: NETWORK_ID,
  asset: `0x${"cc".repeat(20)}`,
  payTo: RECIPIENT,
  amount: AMOUNT_DEFAULT,
};

describe("determinism", () => {
  it("produces identical evaluations for identical inputs", () => {
    const result = buildResult({ effects: [transferEffect("eff_1")] });
    const a = evaluateX402ExactSettlement(BASE_REQUIREMENT, result);
    const b = evaluateX402ExactSettlement(BASE_REQUIREMENT, result);
    expect(canonicalJson(a as unknown as Record<string, unknown>)).toBe(
      canonicalJson(b as unknown as Record<string, unknown>),
    );
  });

  it("is invariant to observed-effect order for outcome and warnings", () => {
    const effects = [
      transferEffect("eff_noise", { address: `0x${"dd".repeat(20)}` }),
      transferEffect("eff_match"),
      // Unrelated-token activity: ordinary noise even inside the claimed
      // payment transaction (right-token wrong-terms transfers would be an
      // explicit expectation conflict instead — covered in assessment tests).
      transferEffect("eff_other_recipient", {
        address: `0x${"dd".repeat(20)}`,
        to: `0x${"11".repeat(20)}`,
      }),
    ];
    const forward = buildResult({ effects });
    const shuffled = buildResult({ effects: [effects[2]!, effects[0]!, effects[1]!] });

    const a = evaluateX402ExactSettlement(BASE_REQUIREMENT, forward);
    const b = evaluateX402ExactSettlement(BASE_REQUIREMENT, shuffled);

    // The composed conclusion and its provenance are order-independent.
    expect(a.outcome).toEqual(b.outcome);
    expect(a.warnings).toEqual(b.warnings);
    expect(b.outcome.verdict).toBe("supported");
    // Matching transfers follow artifact order by construction.
    expect(b.matchingTransfers.map((t) => t.effectId)).toEqual(["eff_match"]);
  });

  it("binds requirement identity to content, not spelling", () => {
    const r1 = parseX402ExactPaymentRequirement(BASE_REQUIREMENT);
    const r2 = parseX402ExactPaymentRequirement({
      ...BASE_REQUIREMENT,
      amount: "01000000", // same numeric amount with a leading zero
    });
    expect(computeRequirementDigest(r1)).toBe(computeRequirementDigest(r2));

    const r3 = parseX402ExactPaymentRequirement({
      ...BASE_REQUIREMENT,
      amount: `${AMOUNT_DEFAULT}0`,
    });
    expect(computeRequirementDigest(r1)).not.toBe(computeRequirementDigest(r3));
  });

  it("never embeds timestamps, clocks or randomness in the evaluation", () => {
    const result = buildResult({ effects: [transferEffect("eff_1")] });
    const evaluation = evaluateX402ExactSettlement(BASE_REQUIREMENT, result);
    const json = canonicalJson(evaluation as unknown as Record<string, unknown>);
    expect(json).not.toContain("generatedAt");
    expect(/20\d\d-\d\d-\d\dT/.test(json)).toBe(false);
  });
});
