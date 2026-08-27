import { describe, expect, it } from "vitest";

import {
  composeVerdict,
  conflictAffectsProposition,
  isPropositionScope,
  NecValidationError,
  samePropositionScope,
} from "../src/index.js";
import type { Conflict, PropositionScope } from "../src/index.js";
import { conflict as mkConflict, evidenceRef } from "./fixtures.js";

/**
 * DECISION: explicit typed proposition scope for semantic conflicts.
 *
 * EvidenceId overlap is PROVENANCE ONLY and never defines scope:
 *   - material conflict scoped to proposition P prevents supported or
 *     contradicted for P (ambiguous required);
 *   - material conflict scoped to a different proposition does not affect P;
 *   - result-scoped material conflict affects EVERY proposition;
 *   - missing/invalid scope fails closed;
 *   - scope is never inferred from shared EvidenceIds.
 */

const EXECUTION: PropositionScope = { kind: "dimension", dimension: "execution" };
const SETTLEMENT: PropositionScope = { kind: "dimension", dimension: "settlement" };
const RESULT: PropositionScope = { kind: "result" };
const EFFECT_A: PropositionScope = { kind: "observed_effect", effectId: "effect_1" };
const CUSTOM_A: PropositionScope = { kind: "custom", namespace: "vendor.x", id: "claim-1" };

const refs = [evidenceRef({ id: "ev_shared" }), evidenceRef({ id: "ev_other", sourceId: "s2" })];

function verdictFor(
  inputScope: PropositionScope,
  inputEvidence: readonly string[],
  claimedVerdict: "supported" | "contradicted",
  conflicts: readonly Conflict[],
): string {
  const outcome = composeVerdict(
    [
      {
        scope: inputScope,
        applicability: "applicable",
        verdict: claimedVerdict,
        basis: ["source_observation"],
        evidence: inputEvidence,
      },
    ],
    { conflicts, evidenceRefs: refs },
  );
  if (outcome.verdict === undefined) throw new Error("expected a verdict");
  return outcome.verdict;
}

describe("proposition scope guards and equality", () => {
  it("accepts exactly the four scope variants with exact field sets", () => {
    expect(isPropositionScope({ kind: "result" })).toBe(true);
    expect(isPropositionScope({ kind: "dimension", dimension: "execution" })).toBe(true);
    expect(isPropositionScope({ kind: "observed_effect", effectId: "e1" })).toBe(true);
    expect(isPropositionScope({ kind: "custom", namespace: "a.b", id: "c" })).toBe(true);
  });

  it("rejects invalid scopes fail-closed", () => {
    expect(isPropositionScope(undefined)).toBe(false);
    expect(isPropositionScope(null)).toBe(false);
    expect(isPropositionScope({})).toBe(false);
    expect(isPropositionScope({ kind: "galaxy" })).toBe(false);
    expect(isPropositionScope({ kind: "dimension", dimension: "observedEffects" })).toBe(false);
    expect(isPropositionScope({ kind: "dimension", dimension: "execution", extra: 1 })).toBe(false);
    expect(isPropositionScope({ kind: "result", extra: true })).toBe(false);
    expect(isPropositionScope({ kind: "observed_effect", effectId: "" })).toBe(false);
    expect(isPropositionScope({ kind: "custom", namespace: "a", id: "" })).toBe(false);
  });

  it("samePropositionScope distinguishes propositions precisely", () => {
    expect(samePropositionScope(EXECUTION, EXECUTION)).toBe(true);
    expect(samePropositionScope(EXECUTION, SETTLEMENT)).toBe(false);
    expect(samePropositionScope(RESULT, RESULT)).toBe(true);
    expect(samePropositionScope(EFFECT_A, { kind: "observed_effect", effectId: "effect_1" })).toBe(true);
    expect(samePropositionScope(EFFECT_A, { kind: "observed_effect", effectId: "effect_2" })).toBe(false);
    expect(samePropositionScope(CUSTOM_A, { kind: "custom", namespace: "vendor.x", id: "claim-2" })).toBe(false);
  });

  it("conflictAffectsProposition: result scope affects everything; others only equal scopes", () => {
    expect(conflictAffectsProposition(RESULT, EXECUTION)).toBe(true);
    expect(conflictAffectsProposition(RESULT, EFFECT_A)).toBe(true);
    expect(conflictAffectsProposition(EXECUTION, SETTLEMENT)).toBe(false);
    expect(conflictAffectsProposition(EXECUTION, EXECUTION)).toBe(true);
  });
});

describe("scope-based conflict blocking in composition", () => {
  const executionConflict = mkConflict({
    id: "c_exec",
    material: true,
    scope: EXECUTION,
    evidence: ["ev_shared"],
  });
  const settlementConflict = mkConflict({
    id: "c_settle",
    material: true,
    scope: SETTLEMENT,
    evidence: ["ev_shared"],
  });

  it("same proposition + DIFFERENT EvidenceRefs: still blocks (scope is semantic, ids are provenance)", () => {
    // The conflict cites ev_other; the claim cites ev_shared. Under the old
    // overlap rule this silently passed; with explicit scope it blocks.
    const supported = verdictFor(EXECUTION, ["ev_shared"], "supported", [executionConflict]);
    const contradicted = verdictFor(EXECUTION, ["ev_shared"], "contradicted", [executionConflict]);
    expect(supported).toBe("ambiguous");
    expect(contradicted).toBe("ambiguous");
  });

  it("different propositions + SAME EvidenceRef: does NOT affect the other proposition", () => {
    // The settlement-scoped conflict cites ev_shared, which also backs the
    // execution claim — but scope, not provenance, decides.
    expect(verdictFor(EXECUTION, ["ev_shared"], "supported", [settlementConflict])).toBe("supported");
    expect(verdictFor(EXECUTION, ["ev_shared"], "contradicted", [settlementConflict])).toBe(
      "contradicted",
    );
  });

  it("result-scoped material conflict affects EVERY proposition", () => {
    for (const scope of [EXECUTION, SETTLEMENT, EFFECT_A, CUSTOM_A]) {
      expect(verdictFor(scope, ["ev_shared"], "supported", [
        mkConflict({ id: "c_res", material: true, scope: RESULT, evidence: ["ev_other"] }),
      ])).toBe("ambiguous");
    }
  });

  it("non-material scoped conflicts never block", () => {
    const soft = mkConflict({ id: "c_soft", material: false, scope: EXECUTION, evidence: ["ev_shared"] });
    expect(verdictFor(EXECUTION, ["ev_shared"], "supported", [soft])).toBe("supported");
  });
});

describe("missing/invalid scope fails closed", () => {
  it("composition rejects inputs without a valid scope", () => {
    for (const badScope of [undefined, null, {}, { kind: "nope" }, { kind: "result", x: 1 }]) {
      expect(() =>
        composeVerdict([
          {
            scope: badScope as never,
            applicability: "applicable",
            verdict: "supported",
            evidence: ["ev_shared"],
          },
        ]),
      ).toThrow(NecValidationError);
    }
  });

  it("artifact-level validation rejects conflicts without an explicit scope", async () => {
    const { buildNetworkEvidenceResult } = await import("../src/index.js");
    const { validResultContent, resultContext } = await import("./fixtures.js");
    const noScope = {
      ...validResultContent(),
      conflicts: [
        {
          id: "c1",
          code: "X",
          description: "d",
          evidence: ["ev_receipt_1"],
          material: false,
        },
      ],
    };
    // @ts-expect-error deliberately missing scope
    expect(() => buildNetworkEvidenceResult(noScope, resultContext())).toThrow(NecValidationError);
  });
});
