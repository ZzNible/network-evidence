import { describe, expect, it } from "vitest";

import {
  COMPOSITION_WARNING_CODES,
  composeProposition,
  composeVerdict,
  NecValidationError,
  assertNormativePropositionState,
  validateEvidenceDimension,
} from "../src/index.js";
import type { ComposedProposition, PropositionScope } from "../src/index.js";
import { conflict, evidenceRef } from "./fixtures.js";

const EXECUTION: PropositionScope = { kind: "dimension", dimension: "execution" };
// Complete, validated EvidenceRefs backing every positive claim below.
const refs = [
  evidenceRef({ id: "ev_1" }),
  evidenceRef({ id: "ev_2", sourceId: "src2" }),
  evidenceRef({ id: "ev_3", sourceId: "src3" }),
];

const SUPPORTED = {
  scope: EXECUTION,
  applicability: "applicable",
  verdict: "supported",
  basis: ["source_observation"],
  evidence: ["ev_1"],
} as const;
const CONTRADICTED = {
  scope: EXECUTION,
  applicability: "applicable",
  verdict: "contradicted",
  basis: ["local_consensus_engine"],
  evidence: ["ev_2"],
} as const;

function verdictOf(inputs: Parameters<typeof composeVerdict>[0]): {
  applicability: string;
  verdict?: string;
} {
  const outcome = composeVerdict(inputs, { evidenceRefs: refs });
  return { applicability: outcome.applicability, verdict: outcome.verdict };
}

describe("verdict composition (THE normative applicability/verdict state machine)", () => {
  it("emits SUPPORTED only with its own resolvable VALIDATED EvidenceRef backing", () => {
    const ok = composeProposition(SUPPORTED, { evidenceRefs: refs });
    expect(ok.applicability).toBe("applicable");
    expect(ok.verdict).toBe("supported");
    expect(ok.warnings).toEqual([]);
    // Provenance comes from the agreeing contribution only.
    expect(ok.evidence).toEqual(["ev_1"]);
  });

  it("R3: an unproved supported input is INVALID, never silently downgraded", () => {
    for (const bad of [
      // no citations at all
      { ...SUPPORTED, evidence: [] },
      // citations that resolve nowhere
      { ...SUPPORTED, evidence: ["ev_missing"] },
      // no basis
      { ...SUPPORTED, basis: [] },
    ]) {
      expect(() => composeVerdict([bad], { evidenceRefs: refs })).toThrow(NecValidationError);
    }
    // No index supplied at all: nothing can be proven.
    expect(() => composeVerdict([{ ...SUPPORTED }])).toThrow(NecValidationError);
  });

  it("R3: a valid contradicted contribution needs its own proof", () => {
    const ok = composeProposition(CONTRADICTED, { evidenceRefs: refs });
    expect(ok.verdict).toBe("contradicted");
    expect(ok.evidence).toEqual(["ev_2"]);
    for (const bad of [
      { ...CONTRADICTED, evidence: [] },
      { ...CONTRADICTED, evidence: ["ev_ghost"] },
      { ...CONTRADICTED, basis: [] },
    ]) {
      expect(() => composeVerdict([bad], { evidenceRefs: refs })).toThrow(NecValidationError);
    }
  });

  it("R3 PROOF NON-LAUNDERING: supported proof + unproved contradicted input CANNOT produce contradicted", () => {
    // The contradicted contribution is invalid -> composition fails closed;
    // it can never aggregate into a contradicted (or any) conclusion, and
    // the supported side's evidence can never become its provenance.
    expect(() =>
      composeVerdict(
        [
          SUPPORTED,
          { ...CONTRADICTED, evidence: [] },
        ],
        { evidenceRefs: refs },
      ),
    ).toThrow(/"contradicted" contribution/);
  });

  it("R3 PROOF NON-LAUNDERING: contradicted proof + unproved supported input CANNOT produce supported", () => {
    expect(() =>
      composeVerdict(
        [
          CONTRADICTED,
          { ...SUPPORTED, evidence: ["ev_ghost"] },
        ],
        { evidenceRefs: refs },
      ),
    ).toThrow(/"supported" contribution/);
  });

  it("R3: valid supported + valid contradicted WITHOUT an explicit material conflict FAILS CLOSED", () => {
    expect(() =>
      composeVerdict([SUPPORTED, CONTRADICTED], { evidenceRefs: refs }),
    ).toThrow(/represent the disagreement explicitly as a Conflict/);
  });

  it("R3: same pair WITH an explicit affecting material conflict => ambiguous carrying both sides' observations", () => {
    const material = conflict({
      id: "c_disagree",
      material: true,
      scope: EXECUTION,
      evidence: ["ev_3"],
    });
    const out = composeVerdict([SUPPORTED, CONTRADICTED], {
      conflicts: [material],
      evidenceRefs: refs,
    });
    expect(out.verdict).toBe("ambiguous");
    expect(out.warnings.map((w) => w.code)).toContain(
      COMPOSITION_WARNING_CODES.materialConflictBlocksConclusion,
    );
    // The ambiguous basis/evidence may include the validated conflicting
    // observations of every considered contribution plus the conflict's.
    expect(out.evidence).toEqual(["ev_1", "ev_2", "ev_3"]);
  });

  it("a material conflict scoped to the SAME proposition blocks supported and contradicted", () => {
    const material = conflict({ id: "c1", material: true, scope: EXECUTION, evidence: ["ev_1"] });
    for (const claimed of [SUPPORTED, CONTRADICTED]) {
      const out = composeVerdict([claimed], { conflicts: [material], evidenceRefs: refs });
      expect(out.applicability).toBe("applicable");
      expect(out.verdict).toBe("ambiguous");
      expect(out.warnings.map((w) => w.code)).toContain(
        COMPOSITION_WARNING_CODES.materialConflictBlocksConclusion,
      );
      // Ambiguity is self-documenting: the conflict citations are attached.
      expect(out.evidence.length).toBeGreaterThan(0);
    }
    // An insufficient contribution alongside the conflict is forced to
    // ambiguous too (material conflicts coexist with no other verdict).
    // The forced-ambiguous outcome must still satisfy THE normative state
    // machine, so the contribution carries the basis of its observation.
    const ins = composeVerdict(
      [
        {
          scope: EXECUTION,
          applicability: "applicable",
          verdict: "insufficient",
          basis: ["source_observation"],
          evidence: [],
        },
      ],
      { conflicts: [material], evidenceRefs: refs },
    );
    expect(ins.verdict).toBe("ambiguous");
    // FREEZE-FINAL CLOSURE: a forced-ambiguous outcome with NO basis at all
    // can never satisfy the normative machine -> fail closed (no silent
    // fabrication of basis).
    expect(() =>
      composeVerdict(
        [
          {
            scope: EXECUTION,
            applicability: "applicable",
            verdict: "insufficient",
            evidence: [],
          },
        ],
        { conflicts: [material], evidenceRefs: refs },
      ),
    ).toThrow(/non-empty basis required for "ambiguous"/);
  });

  it("a result-scoped material conflict blocks every proposition", () => {
    const global = conflict({ id: "cg", material: true, scope: { kind: "result" }, evidence: ["ev_2"] });
    for (const scope of [
      EXECUTION,
      { kind: "dimension", dimension: "settlement" } as const,
      { kind: "observed_effect", effectId: "e9" } as const,
    ]) {
      const out = composeVerdict(
        [{ ...SUPPORTED, scope }],
        { conflicts: [global], evidenceRefs: refs },
      );
      expect(out.verdict).toBe("ambiguous");
    }
  });

  it("non-material conflicts do not block conclusions", () => {
    const nonMaterial = conflict({ id: "c1", material: false, scope: EXECUTION });
    const out = composeVerdict([SUPPORTED], { conflicts: [nonMaterial], evidenceRefs: refs });
    expect(out.verdict).toBe("supported");
    expect(out.warnings).toHaveLength(0);
  });

  it("not_applicable != insufficient: excluded inputs never degrade the result", () => {
    const naOutcome = composeVerdict([
      { scope: EXECUTION, applicability: "not_applicable", evidence: [] },
      { scope: EXECUTION, applicability: "not_applicable", evidence: [] },
    ]);
    expect(naOutcome).toEqual({
      applicability: "not_applicable",
      basis: [],
      evidence: [],
      warnings: [],
    });
    expect(naOutcome.verdict).toBeUndefined();

    const mixed = composeVerdict([SUPPORTED, { scope: EXECUTION, applicability: "not_applicable", evidence: [] }], {
      evidenceRefs: refs,
    });
    expect(mixed.verdict).toBe("supported");

    // unknown + not_applicable: nothing decidable -> unknown, NO verdict.
    const mostlyUnknown = composeVerdict([
      { scope: EXECUTION, applicability: "unknown", evidence: [] },
      { scope: EXECUTION, applicability: "not_applicable", evidence: [] },
    ]);
    expect(mostlyUnknown.applicability).toBe("unknown");
    expect(mostlyUnknown.verdict).toBeUndefined();
  });

  it("no inputs at all -> unknown with an explicit warning (nothing established)", () => {
    const empty = composeVerdict([]);
    expect(empty.applicability).toBe("unknown");
    expect(empty.verdict).toBeUndefined();
    expect(empty.warnings.map((w) => w.code)).toContain(
      COMPOSITION_WARNING_CODES.noDimensionsEvaluated,
    );
  });

  it("UNKNOWN propagates: unknown + supported is never silently converted into supported or insufficient", () => {
    const out = composeVerdict([SUPPORTED, { scope: EXECUTION, applicability: "unknown", evidence: [] }], {
      evidenceRefs: refs,
    });
    expect(out.applicability).toBe("unknown");
    expect(out.verdict).toBeUndefined();
    expect(out.warnings).toEqual([]);
  });

  it("follows the documented aggregation ladder over independently-valid contributions", () => {
    const insufficient = {
      scope: EXECUTION,
      applicability: "applicable",
      verdict: "insufficient",
      evidence: [],
    } as const;
    const noVerdict = { scope: EXECUTION, applicability: "applicable", evidence: [] } as const;

    expect(verdictOf([SUPPORTED])).toMatchObject({ verdict: "supported" });
    expect(verdictOf([CONTRADICTED])).toMatchObject({ verdict: "contradicted" });
    expect(verdictOf([SUPPORTED, insufficient])).toMatchObject({ verdict: "insufficient" });
    expect(verdictOf([SUPPORTED, noVerdict])).toMatchObject({ verdict: "insufficient" });

    // R3 provenance precision: an insufficient outcome cites ONLY the
    // insufficient contributions' observations — never the supported side's.
    const mixed = composeVerdict([SUPPORTED, insufficient], { evidenceRefs: refs });
    expect(mixed.verdict).toBe("insufficient");
    expect(mixed.evidence).toEqual([]);
    expect(mixed.basis).toEqual([]);
  });

  it("an unjustified ambiguous INPUT fails closed (ambiguous requires a material conflict)", () => {
    expect(() =>
      composeVerdict([
        {
          scope: EXECUTION,
          applicability: "applicable",
          verdict: "ambiguous",
          basis: ["source_observation"],
          evidence: ["ev_1"],
        },
      ], { evidenceRefs: refs }),
    ).toThrow(/requires at least one material Conflict/);
  });

  it("R3: nonsense runtime verdict strings are rejected, never converted to insufficient", () => {
    for (const nonsense of ["nonsense", "verified", "", null]) {
      expect(() =>
        composeVerdict([
          { scope: EXECUTION, applicability: "applicable", verdict: nonsense as never, evidence: ["ev_1"] },
        ]),
      ).toThrow(/unknown runtime verdict/);
    }
  });

  it("the outcome is EvidenceDimension-compatible and satisfies the artifact state machine", () => {
    const out: ComposedProposition = composeProposition(SUPPORTED, { evidenceRefs: refs });
    expect(out.basis).toEqual(["source_observation"]);
    // verdict present iff applicable; unknown/not_applicable carry no verdict.
    const na = composeVerdict([{ scope: EXECUTION, applicability: "not_applicable", evidence: [] }]);
    const un = composeVerdict([{ scope: EXECUTION, applicability: "unknown", evidence: [] }]);
    expect(na.verdict).toBeUndefined();
    expect(un.verdict).toBeUndefined();
  });

  it("fails closed on missing/invalid scopes, unknown applicability or unknown basis values", () => {
    expect(() =>
      composeVerdict([
        { applicability: "applicable", verdict: "supported", evidence: [] } as never,
      ]),
    ).toThrow(NecValidationError);
    expect(() =>
      composeVerdict([
        { scope: { kind: "bogus" } as never, applicability: "applicable", evidence: [] },
      ]),
    ).toThrow();
    expect(() =>
      composeVerdict([{ scope: EXECUTION, applicability: "maybe", evidence: [] } as never]),
    ).toThrow();
    expect(() =>
      composeVerdict([
        { scope: EXECUTION, applicability: "applicable", basis: ["vibes"], evidence: [] } as never,
      ]),
    ).toThrow(/unknown evidence basis/);
  });

  it("rejects arbitrary objects in the caller-supplied Map (keys must match ref.id)", async () => {
    const { composeVerdict } = await import("../src/index.js");
    // A fake ref object that was never validated cannot back conclusions.
    expect(() =>
      composeVerdict(
        [{ ...SUPPORTED, evidence: ["x"] }],
        { evidenceRefs: new Map([["x", { id: "x", fake: true } as never]]) },
      ),
    ).toThrow(NecValidationError);

    // Key/ref identity mismatch fails closed.
    expect(() =>
      composeVerdict(
        [{ ...SUPPORTED, evidence: ["y"] }],
        { evidenceRefs: new Map([["wrong-key", evidenceRef({ id: "y" })]]) },
      ),
    ).toThrow(/does not match ref.id/);
  });

  it("is pure: identical inputs give identical outputs across calls", () => {
    const a = JSON.stringify(composeVerdict([SUPPORTED], { evidenceRefs: refs }));
    const b = JSON.stringify(composeVerdict([SUPPORTED], { evidenceRefs: refs }));
    expect(a).toBe(b);
  });
});

/**
 * FREEZE-FINAL HOSTILE CLOSURE — adversarial multi-contribution suite.
 * Every finding from the final review is reproduced here so it cannot
 * return: complete snapshot-before-aggregation, inert contributions,
 * EvidenceRef closure (no duplicates), complete Conflict validation,
 * exact scope association, proof non-movement, fail-closed disagreement,
 * and the single normative gate on every output branch.
 */
describe("freeze-final hostile closure (multi-contribution)", () => {
  const EXECUTION: PropositionScope = { kind: "dimension", dimension: "execution" };
  const table = [
    evidenceRef({ id: "ev_1" }),
    evidenceRef({ id: "ev_2", sourceId: "src2" }),
    evidenceRef({ id: "ev_3", sourceId: "src3" }),
  ];
  const OK_SUPPORTED = {
    scope: EXECUTION,
    applicability: "applicable",
    verdict: "supported",
    basis: ["source_observation"],
    evidence: ["ev_1"],
  } as const;
  const OK_CONTRADICTED = {
    scope: EXECUTION,
    applicability: "applicable",
    verdict: "contradicted",
    basis: ["local_consensus_engine"],
    evidence: ["ev_2"],
  } as const;
  const UNKNOWN_IN = { scope: EXECUTION, applicability: "unknown", evidence: [] } as const;
  const materialConflict = () =>
    conflict({ id: "c_hostile", material: true, scope: EXECUTION, evidence: ["ev_3"] });

  it("valid unknown + MALFORMED LATER supported => throws (no early return past an invalid input)", () => {
    expect(() =>
      composeVerdict(
        [UNKNOWN_IN, { ...OK_SUPPORTED, evidence: ["ev_ghost"] }],
        { evidenceRefs: table },
      ),
    ).toThrow(/does not resolve against complete validated EvidenceRefs/);
  });

  it("MALFORMED FIRST supported + valid unknown => throws", () => {
    expect(() =>
      composeVerdict(
        [{ ...OK_SUPPORTED, basis: [] }, UNKNOWN_IN],
        { evidenceRefs: table },
      ),
    ).toThrow(/non-empty basis/);
  });

  it("malicious evidence-array iterator yielding a valid ID cannot mask the ghost behind index 0", () => {
    let iteratorRuns = 0;
    const hostileEvidence = ["ev_ghost"];
    Object.defineProperty(hostileEvidence, Symbol.iterator, {
      value: function* () {
        iteratorRuns += 1;
        yield "ev_1";
      },
      configurable: true,
    });
    expect(() =>
      composeVerdict([{ ...OK_SUPPORTED, evidence: hostileEvidence as never }], {
        evidenceRefs: table,
      }),
    ).toThrow(NecValidationError);
    // The caller-controlled iterator was NEVER consulted.
    expect(iteratorRuns).toBe(0);
  });

  it("malicious basis iterator => throws without invoking the iterator", () => {
    let iteratorRuns = 0;
    const hostileBasis = ["vibes"];
    Object.defineProperty(hostileBasis, Symbol.iterator, {
      value: function* () {
        iteratorRuns += 1;
        yield "source_observation";
      },
      configurable: true,
    });
    expect(() =>
      composeVerdict([{ ...OK_SUPPORTED, basis: hostileBasis as never }], {
        evidenceRefs: table,
      }),
    ).toThrow(NecValidationError);
    expect(iteratorRuns).toBe(0);
  });

  it("array index getters are NEVER invoked by composition (invocation count == 0)", () => {
    let invocations = 0;
    const getterEvidence: unknown[] = [];
    Object.defineProperty(getterEvidence, 0, {
      enumerable: true,
      configurable: true,
      get() {
        invocations += 1;
        return "ev_1";
      },
    });
    getterEvidence.length = 1;
    expect(() =>
      composeVerdict([{ ...OK_SUPPORTED, evidence: getterEvidence as never }], {
        evidenceRefs: table,
      }),
    ).toThrow(NecValidationError);
    expect(invocations).toBe(0);
  });

  it("duplicate EvidenceIds across the supplied EvidenceRef ARRAY are rejected (no last-write-wins)", () => {
    expect(() =>
      composeVerdict([OK_SUPPORTED], {
        evidenceRefs: [evidenceRef({ id: "ev_1" }), evidenceRef({ id: "ev_1", sourceId: "dup" })],
      }),
    ).toThrow(/duplicate EvidenceId/);
  });

  it("a caller-overridden Map.entries CANNOT alter what composition observes (built-in intrinsics only)", () => {
    const shadowed = new Map<string, unknown>([["ev_1", evidenceRef({ id: "ev_1" })]]);
    // Shadow the instance method with a lying iterator smuggling a ghost ID.
    Object.defineProperty(shadowed, "entries", {
      value: function* () {
        yield ["ev_ghost", evidenceRef({ id: "ev_ghost", sourceId: "ghost" })];
      },
      configurable: true,
    });
    // The intrinsic read sees ONLY the real contents: ev_1 resolves...
    expect(composeVerdict([OK_SUPPORTED], { evidenceRefs: shadowed as never }).verdict).toBe(
      "supported",
    );
    // ...and the smuggled ghost never exists.
    expect(() =>
      composeVerdict([{ ...OK_SUPPORTED, evidence: ["ev_ghost"] }], {
        evidenceRefs: shadowed as never,
      }),
    ).toThrow(/does not resolve against complete validated EvidenceRefs/);
  });

  it("a MALFORMED conflict alongside otherwise valid inputs => throws (never forces ambiguous)", () => {
    for (const malformed of [
      conflict({ id: "c_bad", material: true, scope: EXECUTION }), // material without evidence
      conflict({ id: "c_bad", scope: { kind: "bogus" } as never }), // invalid scope
      { ...conflict({ id: "c_ok" }), material: "yes" } as never, // non-boolean material
    ]) {
      expect(() =>
        composeVerdict([OK_SUPPORTED], { conflicts: [malformed], evidenceRefs: table }),
      ).toThrow(NecValidationError);
    }
  });

  it("a conflict citing a DANGLING EvidenceId => throws", () => {
    expect(() =>
      composeVerdict([OK_SUPPORTED], {
        conflicts: [conflict({ id: "c_dangle", material: false, scope: EXECUTION, evidence: ["ev_ghost"] })],
        evidenceRefs: table,
      }),
    ).toThrow(/does not resolve against complete validated EvidenceRefs/);
  });

  it("malformed custom-scope namespace/id grammar => throws", () => {
    expect(() =>
      composeVerdict([UNKNOWN_IN], {
        conflicts: [
          conflict({
            id: "c_custom",
            material: false,
            scope: { kind: "custom", namespace: "BAD Namespace", id: "x" },
          }),
        ],
      }),
    ).toThrow(NecValidationError);
    expect(() =>
      composeVerdict([UNKNOWN_IN], {
        conflicts: [
          conflict({
            id: "c_custom",
            material: false,
            scope: { kind: "custom", namespace: "vendor.receipt", id: "bad id!" },
          }),
        ],
      }),
    ).toThrow(NecValidationError);
  });

  it("duplicate Conflict IDs are rejected", () => {
    expect(() =>
      composeVerdict([UNKNOWN_IN], {
        conflicts: [
          conflict({ id: "c_dup", material: false, scope: EXECUTION }),
          conflict({ id: "c_dup", code: "OTHER", material: false, scope: EXECUTION }),
        ],
      }),
    ).toThrow(/duplicate Conflict id/);
  });

  it("valid supported + INVALID contradicted => throws (and vice versa)", () => {
    expect(() =>
      composeVerdict([OK_SUPPORTED, { ...OK_CONTRADICTED, evidence: [] }], {
        evidenceRefs: table,
      }),
    ).toThrow(/"contradicted" contribution/);
    expect(() =>
      composeVerdict([{ ...OK_SUPPORTED, evidence: ["ev_ghost"] }, OK_CONTRADICTED], {
        evidenceRefs: table,
      }),
    ).toThrow(/"supported" contribution/);
  });

  it("valid supported + valid contradicted WITHOUT a conflict => throws; WITH one => ambiguous derived from the actual conflicting observations", () => {
    expect(() => composeVerdict([OK_SUPPORTED, OK_CONTRADICTED], { evidenceRefs: table })).toThrow(
      /represent the disagreement explicitly as a Conflict/,
    );
    const out = composeVerdict([OK_SUPPORTED, OK_CONTRADICTED], {
      conflicts: [materialConflict()],
      evidenceRefs: table,
    });
    expect(out.verdict).toBe("ambiguous");
    // Derived from the ACTUAL validated observations + conflict citations.
    expect(out.evidence).toEqual(["ev_1", "ev_2", "ev_3"]);
  });

  it("scope association is EXACT: a foreign-scoped conflict does not force ambiguous; result-scoped does", () => {
    const foreign = conflict({
      id: "c_foreign",
      material: true,
      scope: { kind: "dimension", dimension: "settlement" },
      evidence: ["ev_3"],
    });
    expect(composeVerdict([OK_SUPPORTED], { conflicts: [foreign], evidenceRefs: table }).verdict).toBe(
      "supported",
    );
    // No inference from EvidenceId overlap: the foreign conflict shares no
    // id with ev_1 yet would over-block if overlap were used.
    const global = conflict({ id: "c_global", material: true, scope: { kind: "result" }, evidence: ["ev_3"] });
    expect(composeVerdict([OK_SUPPORTED], { conflicts: [global], evidenceRefs: table }).verdict).toBe(
      "ambiguous",
    );
  });

  it("EVERY output branch passes THE normative state-machine gate (dimension-compatible outputs)", () => {
    const material = [materialConflict()];
    const branches: Array<[string, () => ComposedProposition, typeof material | []]> = [
      ["empty", () => composeVerdict([], {}), []],
      [
        "not_applicable",
        () => composeVerdict([{ scope: EXECUTION, applicability: "not_applicable", evidence: [] }]),
        [],
      ],
      ["unknown", () => composeVerdict([UNKNOWN_IN]), []],
      [
        "insufficient",
        () =>
          composeVerdict(
            [
              {
                scope: EXECUTION,
                applicability: "applicable",
                verdict: "insufficient",
                basis: ["source_observation"],
                evidence: [],
              },
            ],
            { evidenceRefs: table },
          ),
        [],
      ],
      ["supported", () => composeVerdict([OK_SUPPORTED], { evidenceRefs: table }), []],
      ["contradicted", () => composeVerdict([OK_CONTRADICTED], { evidenceRefs: table }), []],
      [
        "ambiguous",
        () =>
          composeVerdict([OK_SUPPORTED, OK_CONTRADICTED], {
            conflicts: material,
            evidenceRefs: table,
          }),
        material,
      ],
    ];
    for (const [name, branch, affecting] of branches) {
      const out = branch();
      const dimension = {
        applicability: out.applicability,
        ...(out.verdict !== undefined ? { verdict: out.verdict } : {}),
        basis: [...out.basis],
        evidence: [...out.evidence],
      };
      // The artifact-level validator accepts EVERY composer output.
      expect(() => validateEvidenceDimension(dimension), name).not.toThrow();
      // And the shared normative helper accepts it under the SAME
      // affecting-conflict set that produced it.
      expect(() =>
        assertNormativePropositionState(dimension, affecting, "branch"),
        name,
      ).not.toThrow();
    }
  });

  it("ADVERSARIAL MULTI-CONTRIBUTION CROSS PRODUCT: effective contributions x conflict presence", () => {
    const insufficient = {
      scope: EXECUTION,
      applicability: "applicable",
      verdict: "insufficient",
      basis: ["source_observation"],
      evidence: [],
    } as const;
    const unproved = { scope: EXECUTION, applicability: "applicable", evidence: [] } as const;
    const combos: Array<[string, Parameters<typeof composeVerdict>[0]]> = [
      ["S+S", [OK_SUPPORTED, { ...OK_SUPPORTED, evidence: ["ev_2"], basis: ["local_consensus_engine"] }]],
      ["C+C", [OK_CONTRADICTED, { ...OK_CONTRADICTED, evidence: ["ev_3"], basis: ["local_consensus_engine"] }]],
      ["I+I", [insufficient, insufficient]],
      ["U+U", [UNKNOWN_IN, UNKNOWN_IN]],
      ["S+I", [OK_SUPPORTED, insufficient]],
      ["C+I", [OK_CONTRADICTED, insufficient]],
      ["S+U", [OK_SUPPORTED, UNKNOWN_IN]],
      ["S+noVerdict", [OK_SUPPORTED, unproved]],
      ["C+noVerdict", [OK_CONTRADICTED, unproved]],
    ];
    for (const [name, inputs] of combos) {
      const opts = { conflicts: [] as never[], evidenceRefs: table };
      if (name === "S+U" || name === "U+U") {
        // UNKNOWN dominance: an undecidable contribution keeps the whole
        // proposition unknown — a conflict never upgrades it to ambiguous.
        expect(composeVerdict(inputs, opts).verdict, name).toBeUndefined();
        expect(
          composeVerdict(inputs, { ...opts, conflicts: [materialConflict()] }).verdict,
          `${name}+conflict`,
        ).toBeUndefined();
        continue;
      }
      // Remaining decided combos: any affecting material conflict forces
      // ambiguous — and since each carries at least one basis-bearing
      // contribution, the forced output stays normatively legal.
      expect(
        composeVerdict(inputs, { ...opts, conflicts: [materialConflict()] }).verdict,
        `${name}+conflict`,
      ).toBe("ambiguous");
      const expected: Record<string, string> = {
        "S+S": "supported",
        "C+C": "contradicted",
        "I+I": "insufficient",
        "S+I": "insufficient",
        "C+I": "contradicted",
        // A verdict-less applicable input is an INSUFFICIENT contribution
        // (absence of proof), so it downgrades — never launders.
        "S+noVerdict": "insufficient",
        "C+noVerdict": "contradicted",
      };
      expect(composeVerdict(inputs, opts).verdict, name).toBe(expected[name]);
    }
  });
});
