import { describe, expect, it } from "vitest";

import { buildNetworkEvidenceResult, NecValidationError } from "../src/index.js";
import type { EvidenceDimension } from "../src/index.js";
import {
  dimension,
  effect,
  fullSnapshot,
  validResultContent,
  conflict as mkConflict,
  evidenceRef,
  resultContext,
} from "./fixtures.js";

/**
 * DECISION: normative applicability / verdict state machine.
 *
 *   applicability "applicable"      -> verdict REQUIRED
 *   applicability "not_applicable"  -> verdict MUST be absent
 *   applicability "unknown"         -> verdict MUST be absent
 *
 *   For an applicable proposition:
 *     supported     -> non-empty basis + non-empty refs + NO material
 *                      conflict scoped to the proposition
 *     contradicted  -> same
 *     ambiguous     -> non-empty basis + non-empty refs + >=1 material
 *                      conflict scoped to the proposition (result-scoped counts)
 *     insufficient  -> basis/evidence may be empty
 */

function contentWithExecutionDimension(dim: EvidenceDimension) {
  const content = validResultContent();
  content.networkEvidence.execution = dim;
  return content;
}

describe("applicability/verdict pairing", () => {
  it("applicable requires a verdict", () => {
    expect(() =>
      buildNetworkEvidenceResult(
        contentWithExecutionDimension({
          applicability: "applicable",
          basis: ["source_observation"],
          evidence: ["ev_receipt_1"],
        }),
        resultContext(),
      ),
    ).toThrow(/required when applicability is "applicable"/);
  });

  it("not_applicable forbids a verdict", () => {
    expect(() =>
      buildNetworkEvidenceResult(
        contentWithExecutionDimension({
          applicability: "not_applicable",
          verdict: "insufficient",
          basis: [],
          evidence: [],
        }),
        resultContext(),
      ),
    ).toThrow(/MUST be absent when applicability is "not_applicable"/);
  });

  it("unknown forbids a verdict", () => {
    expect(() =>
      buildNetworkEvidenceResult(
        contentWithExecutionDimension({
          applicability: "unknown",
          verdict: "insufficient",
          basis: [],
          evidence: [],
        }),
        resultContext(),
      ),
    ).toThrow(/MUST be absent when applicability is "unknown"/);
  });
});

describe("all material verdict state combinations for an applicable proposition", () => {
  const scopedMaterial = () =>
    mkConflict({ id: "c1", material: true, scope: { kind: "dimension", dimension: "execution" }, evidence: ["ev_receipt_1"] });

  it("supported: ok without scoped conflict; blocked with scoped or result-scoped conflict", () => {
    expect(() => buildNetworkEvidenceResult(validResultContent(), resultContext())).not.toThrow();

    const withScoped = validResultContent();
    withScoped.conflicts = [scopedMaterial()];
    expect(() => buildNetworkEvidenceResult(withScoped, resultContext())).toThrow(
      /prevent "supported".*ambiguous required/,
    );

    const withResult = validResultContent();
    withResult.conflicts = [
      mkConflict({ id: "c2", material: true, scope: { kind: "result" }, evidence: ["ev_receipt_1"] }),
    ];
    expect(() => buildNetworkEvidenceResult(withResult, resultContext())).toThrow(/prevent "supported"/);
  });

  it("contradicted: same rules as supported", () => {
    const contradicted = contentWithExecutionDimension({
      applicability: "applicable",
      verdict: "contradicted",
      basis: ["source_observation"],
      evidence: ["ev_receipt_1"],
    });
    expect(() => buildNetworkEvidenceResult(contradicted, resultContext())).not.toThrow();

    const withConflict = { ...contradicted, conflicts: [scopedMaterial()] };
    expect(() => buildNetworkEvidenceResult(withConflict, resultContext())).toThrow(/prevent "contradicted"/);
  });

  it("ambiguous: REQUIRES a scoped material conflict; basis/evidence non-empty", () => {
    const ambiguous = contentWithExecutionDimension({
      applicability: "applicable",
      verdict: "ambiguous",
      basis: ["source_observation"],
      evidence: ["ev_receipt_1"],
    });

    // Without any scoped conflict -> rejected.
    expect(() => buildNetworkEvidenceResult(ambiguous, resultContext())).toThrow(
      /"ambiguous" requires at least one explicit material Conflict/,
    );

    // With the scoped material conflict -> accepted.
    const justified = { ...ambiguous, conflicts: [scopedMaterial()] };
    expect(() => buildNetworkEvidenceResult(justified, resultContext())).not.toThrow();

    // Result-scoped conflict justifies ambiguity for every proposition.
    const resultJustified = {
      ...ambiguous,
      conflicts: [
        mkConflict({ id: "c3", material: true, scope: { kind: "result" }, evidence: ["ev_receipt_1"] }),
      ],
    };
    expect(() => buildNetworkEvidenceResult(resultJustified, resultContext())).not.toThrow();

    // Ambiguous without basis/evidence -> rejected.
    const empty = contentWithExecutionDimension({
      applicability: "applicable",
      verdict: "ambiguous",
      basis: [],
      evidence: [],
    });
    expect(() =>
      buildNetworkEvidenceResult(
        { ...empty, conflicts: [scopedMaterial()] },
        resultContext(),
      ),
    ).toThrow(/non-empty basis required/);
  });

  it("insufficient: basis/evidence may be empty — but a material conflict scoped to this proposition FORCES ambiguous", () => {
    // PHASE B CONTRACT CHANGE: a material unresolved conflict affecting the
    // proposition can coexist with NO verdict at all — it forces AMBIGUOUS
    // and never silently coexists with `insufficient` (which would understate
    // an unresolved contradiction as mere lack of evidence). The Phase A
    // artifact accepted insufficient + scoped conflict; that test encoded a
    // semantic this freeze deliberately rejects.
    const insufficient = contentWithExecutionDimension({
      applicability: "applicable",
      verdict: "insufficient",
      basis: [],
      evidence: [],
    });
    expect(() => buildNetworkEvidenceResult(insufficient, resultContext())).not.toThrow();

    const withConflict = { ...insufficient, conflicts: [scopedMaterial()] };
    expect(() => buildNetworkEvidenceResult(withConflict, resultContext())).toThrow(
      /prevent "insufficient".*ambiguous required/,
    );

    // The honest artifact under unresolved disagreement is ambiguous WITH
    // the conflict attached.
    const honest = contentWithExecutionDimension({
      applicability: "applicable",
      verdict: "ambiguous",
      basis: ["source_observation"],
      evidence: ["ev_receipt_1"],
    });
    expect(() =>
      buildNetworkEvidenceResult({ ...honest, conflicts: [scopedMaterial()] }, resultContext()),
    ).not.toThrow();
  });

  it("a foreign-scoped material conflict does not affect this proposition", () => {
    const content = validResultContent();
    content.conflicts = [
      mkConflict({
        id: "c_foreign",
        material: true,
        scope: { kind: "dimension", dimension: "settlement" },
        evidence: ["ev_receipt_1"],
      }),
    ];
    expect(() => buildNetworkEvidenceResult(content, resultContext())).not.toThrow();
  });

  it("conflicts scoped to observed effects must reference existing effects", () => {
    const content = validResultContent();
    content.conflicts = [
      mkConflict({
        id: "c_effect",
        material: true,
        scope: { kind: "observed_effect", effectId: "effect_1" },
        evidence: ["ev_receipt_1"],
      }),
    ];
    // Does not block the execution dimension...
    expect(() => buildNetworkEvidenceResult(content, resultContext())).not.toThrow();

    // ...but a dangling effect reference fails closed.
    const dangling = validResultContent();
    dangling.conflicts = [
      mkConflict({
        id: "c_effect_ghost",
        material: false,
        scope: { kind: "observed_effect", effectId: "ghost" },
        evidence: [],
      }),
    ];
    expect(() => buildNetworkEvidenceResult(dangling, resultContext())).toThrow(
      /does not exist in networkEvidence.observedEffects/,
    );
  });

  it("observed effects keep unique ids, non-empty basis and resolvable evidence", () => {
    const dupes = validResultContent();
    dupes.networkEvidence.observedEffects = [effect(), effect({})];
    expect(() => buildNetworkEvidenceResult(dupes, resultContext())).toThrow(/duplicate observed-effect id/);

    const noBasis = validResultContent();
    noBasis.networkEvidence.observedEffects = [effect({ basis: [] })];
    expect(() => buildNetworkEvidenceResult(noBasis, resultContext())).toThrow(/non-empty basis/);

    const ghost = validResultContent();
    ghost.networkEvidence.observedEffects = [effect({ evidence: ["ev_ghost"] })];
    expect(() => buildNetworkEvidenceResult(ghost, resultContext())).toThrow(/dangling provenance/);
  });

  it("fake/unvalidated EvidenceRefs can never back composition results in artifacts", async () => {
    const { composeVerdict } = await import("../src/index.js");
    const fake = { id: "ev_fake", nonsense: true };
    expect(() =>
      composeVerdict(
        [
          {
            scope: { kind: "dimension", dimension: "execution" as const },
            applicability: "applicable",
            verdict: "supported",
            evidence: ["ev_fake"],
          },
        ],
        { evidenceRefs: [fake as never] },
      ),
    ).toThrow(NecValidationError);
  });

  it("evidence citations must be unique inside set-like citation lists", () => {
    const content = validResultContent();
    content.networkEvidence.execution.evidence = ["ev_receipt_1", "ev_receipt_1"];
    expect(() => buildNetworkEvidenceResult(content, resultContext())).toThrow(/duplicate evidence id/);
  });
});
