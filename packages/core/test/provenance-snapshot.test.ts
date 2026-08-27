import { describe, expect, it } from "vitest";

import {
  COMPOSITION_WARNING_CODES,
  composeProposition,
  composeVerdict,
  NecValidationError,
  RESOURCE_LIMITS,
  type ComposeOptions,
  type VerdictInput,
} from "../src/index.js";
import type { Conflict, EvidenceRef, PropositionScope } from "../src/index.js";
import { conflict, evidenceRef } from "./fixtures.js";

const EXECUTION: PropositionScope = { kind: "dimension", dimension: "execution" };

const table: EvidenceRef[] = [
  evidenceRef({ id: "ev_good" }),
  evidenceRef({ id: "ev_1" }),
  evidenceRef({ id: "ev_2", sourceId: "src2" }),
  evidenceRef({ id: "ev_3", sourceId: "src3" }),
];

// ===========================================================================
// ORIGINAL (reproduced) Hy3 EXPLOIT
// An ordinary VerdictInput getter can mutate caller-owned semantic data AFTER
// EvidenceRef proof closure and BEFORE final provenance emission. The fix
// snapshots the contribution descriptor-first BEFORE validation, so the
// getter is either rejected without invocation or, if it had been a data
// property, captured exactly once and never re-read.
// ===========================================================================

describe("root invariant: VALIDATE EXACTLY WHAT YOU LATER USE (descriptor-first snapshot)", () => {
  it("ORIGINAL EXPLOIT: a live scope/evidence getter cannot launder ev_ghost into the result", () => {
    const evidence = ["ev_good"];
    let scopeReads = 0;
    const hostileInput: VerdictInput = {
      get scope() {
        scopeReads++;
        return { kind: "dimension", dimension: "execution" };
      },
      applicability: "applicable",
      verdict: "supported",
      basis: ["source_observation"],
      evidence,
    } as unknown as VerdictInput;

    // The getter must never be invoked: we reject accessor inputs via
    // descriptors only.
    expect(() => composeVerdict([hostileInput], { evidenceRefs: table })).toThrow(
      NecValidationError,
    );
    expect(scopeReads).toBe(0);
  });

  it("ORIGINAL EXPLOIT variant: evidence getter mutating the array after validation", () => {
    const evidence = ["ev_good"];
    let reads = 0;
    const hostileInput = {
      scope: EXECUTION,
      applicability: "applicable",
      verdict: "supported",
      basis: ["source_observation"],
      get evidence() {
        reads++;
        if (reads >= 2) {
          evidence[0] = "ev_ghost";
        }
        return evidence;
      },
    } as unknown as VerdictInput;

    expect(() => composeVerdict([hostileInput], { evidenceRefs: table })).toThrow(
      NecValidationError,
    );
    // Accessor rejected without invocation.
    expect(reads).toBe(0);
  });

  // -------------------------------------------------------------------------
  // A. root VerdictInput accessors — each separately must be rejected with
  //    counter === 0.
  // -------------------------------------------------------------------------
  function accessorTest(label: string, build: (counter: { n: number }) => VerdictInput): void {
    it(`A.${label}: accessor rejected, getter counter === 0`, () => {
      const counter = { n: 0 };
      const input = build(counter);
      expect(() => composeVerdict([input], { evidenceRefs: table })).toThrow(NecValidationError);
      expect(counter.n).toBe(0);
    });
  }

  accessorTest("get scope()", (c) =>
    ({
      get scope() {
        c.n++;
        return EXECUTION;
      },
      applicability: "applicable",
      verdict: "supported",
      basis: ["source_observation"],
      evidence: ["ev_good"],
    }) as unknown as VerdictInput,
  );
  accessorTest("get applicability()", (c) =>
    ({
      scope: EXECUTION,
      get applicability() {
        c.n++;
        return "applicable";
      },
      verdict: "supported",
      basis: ["source_observation"],
      evidence: ["ev_good"],
    }) as unknown as VerdictInput,
  );
  accessorTest("get verdict()", (c) =>
    ({
      scope: EXECUTION,
      applicability: "applicable",
      get verdict() {
        c.n++;
        return "supported";
      },
      basis: ["source_observation"],
      evidence: ["ev_good"],
    }) as unknown as VerdictInput,
  );
  accessorTest("get basis()", (c) =>
    ({
      scope: EXECUTION,
      applicability: "applicable",
      verdict: "supported",
      get basis() {
        c.n++;
        return ["source_observation"];
      },
      evidence: ["ev_good"],
    }) as unknown as VerdictInput,
  );
  accessorTest("get evidence()", (c) =>
    ({
      scope: EXECUTION,
      applicability: "applicable",
      verdict: "supported",
      basis: ["source_observation"],
      get evidence() {
        c.n++;
        return ["ev_good"];
      },
    }) as unknown as VerdictInput,
  );

  // -------------------------------------------------------------------------
  // B. exact Hy3 exploit (ev_good validated, getter tries ev_ghost).
  // -------------------------------------------------------------------------
  it("B. exact Hy3 exploit must NOT produce a result citing ev_ghost", () => {
    const evidence = ["ev_good"];
    let scopeReads = 0;
    const hostileInput = {
      get scope() {
        scopeReads++;
        return EXECUTION;
      },
      applicability: "applicable",
      verdict: "supported",
      basis: ["source_observation"],
      evidence,
    } as unknown as VerdictInput;

    expect(() => composeVerdict([hostileInput], { evidenceRefs: table })).toThrow(
      NecValidationError,
    );
    expect(scopeReads).toBe(0);
    // Sanity: a normal ev_good contribution is accepted and cites only ev_good.
    const ok = composeVerdict(
      [
        {
          scope: EXECUTION,
          applicability: "applicable",
          verdict: "supported",
          basis: ["source_observation"],
          evidence: ["ev_good"],
        },
      ],
      { evidenceRefs: table },
    );
    expect(ok.verdict).toBe("supported");
    expect(ok.evidence).toEqual(["ev_good"]);
  });

  // -------------------------------------------------------------------------
  // C. basis laundering — cannot validate one basis and emit another.
  // -------------------------------------------------------------------------
  it("C. basis laundering via getter is rejected", () => {
    const basis = ["source_observation"];
    let reads = 0;
    const hostileInput = {
      scope: EXECUTION,
      applicability: "applicable",
      verdict: "supported",
      get basis() {
        reads++;
        if (reads >= 2) return ["cryptographic_verification"];
        return basis;
      },
      evidence: ["ev_good"],
    } as unknown as VerdictInput;
    expect(() => composeVerdict([hostileInput], { evidenceRefs: table })).toThrow(
      NecValidationError,
    );
    expect(reads).toBe(0);
  });

  // -------------------------------------------------------------------------
  // D. verdict laundering — cannot validate one verdict and aggregate another.
  // -------------------------------------------------------------------------
  it("D. verdict laundering via getter is rejected", () => {
    let reads = 0;
    const hostileInput = {
      scope: EXECUTION,
      applicability: "applicable",
      get verdict() {
        reads++;
        return reads >= 2 ? "contradicted" : "supported";
      },
      basis: ["source_observation"],
      evidence: ["ev_good"],
    } as unknown as VerdictInput;
    expect(() => composeVerdict([hostileInput], { evidenceRefs: table })).toThrow(
      NecValidationError,
    );
    expect(reads).toBe(0);
  });

  // -------------------------------------------------------------------------
  // E. scope laundering — cannot validate/match one scope and aggregate under another.
  // -------------------------------------------------------------------------
  it("E. scope laundering via getter is rejected", () => {
    let reads = 0;
    const hostileInput = {
      get scope() {
        reads++;
        return reads >= 2
          ? { kind: "dimension", dimension: "settlement" }
          : { kind: "dimension", dimension: "execution" };
      },
      applicability: "applicable",
      verdict: "supported",
      basis: ["source_observation"],
      evidence: ["ev_good"],
    } as unknown as VerdictInput;
    expect(() => composeVerdict([hostileInput], { evidenceRefs: table })).toThrow(
      NecValidationError,
    );
    expect(reads).toBe(0);
  });

  // -------------------------------------------------------------------------
  // F. ComposeOptions getter rejection — get evidenceRefs() / get conflicts()
  //    with counter === 0.
  // -------------------------------------------------------------------------
  it("F. ComposeOptions getters are rejected without invocation", () => {
    let refReads = 0;
    let conflictReads = 0;
    const options = {
      get evidenceRefs() {
        refReads++;
        return table;
      },
      get conflicts() {
        conflictReads++;
        return [];
      },
    } as unknown as ComposeOptions;

    expect(() =>
      composeVerdict(
        [{
          scope: EXECUTION,
          applicability: "applicable",
          verdict: "supported",
          basis: ["source_observation"],
          evidence: ["ev_good"],
        } as unknown as VerdictInput],
        options,
      ),
    ).toThrow(NecValidationError);
    expect(refReads).toBe(0);
    expect(conflictReads).toBe(0);
  });

  // -------------------------------------------------------------------------
  // G. nested scope accessor — must fail without executing the getter.
  // -------------------------------------------------------------------------
  it("G. nested scope accessor (get kind()) rejected, counter === 0", () => {
    let counter = 0;
    const hostileInput = {
      scope: {
        get kind() {
          counter++;
          return "dimension";
        },
        dimension: "execution",
      },
      applicability: "applicable",
      verdict: "supported",
      basis: ["source_observation"],
      evidence: ["ev_good"],
    } as unknown as VerdictInput;
    expect(() => composeVerdict([hostileInput], { evidenceRefs: table })).toThrow(
      NecValidationError,
    );
    expect(counter).toBe(0);
  });

  // -------------------------------------------------------------------------
  // H. custom prototype VerdictInput — controlled NecValidationError.
  // -------------------------------------------------------------------------
  it("H. custom-prototype VerdictInput fails closed", () => {
    const proto = { tag: "hostile" };
    const hostileInput = Object.create(proto);
    hostileInput.scope = EXECUTION;
    hostileInput.applicability = "applicable";
    hostileInput.verdict = "supported";
    hostileInput.basis = ["source_observation"];
    hostileInput.evidence = ["ev_good"];
    expect(() => composeVerdict([hostileInput as VerdictInput], { evidenceRefs: table })).toThrow(
      NecValidationError,
    );
  });

  // -------------------------------------------------------------------------
  // I. caller-owned plain arrays remain unfrozen / unmodified.
  // -------------------------------------------------------------------------
  it("I. caller-owned arrays are neither frozen nor mutated", () => {
    const evidence = ["ev_good"];
    const basis = ["source_observation"];
    const input: VerdictInput = {
      scope: EXECUTION,
      applicability: "applicable",
      verdict: "supported",
      basis,
      evidence,
    };
    composeVerdict([input], { evidenceRefs: table });
    expect(Object.isFrozen(evidence)).toBe(false);
    expect(Object.isFrozen(basis)).toBe(false);
    expect(evidence).toEqual(["ev_good"]);
    expect(basis).toEqual(["source_observation"]);
  });

  // -------------------------------------------------------------------------
  // J. normal ordinary data-only composeVerdict behavior unchanged.
  // -------------------------------------------------------------------------
  it("J. ordinary data-only composition still behaves correctly", () => {
    const ok = composeVerdict(
      [
        {
          scope: EXECUTION,
          applicability: "applicable",
          verdict: "supported",
          basis: ["source_observation"],
          evidence: ["ev_good"],
        },
      ],
      { evidenceRefs: table },
    );
    expect(ok).toEqual({
      applicability: "applicable",
      verdict: "supported",
      basis: ["source_observation"],
      evidence: ["ev_good"],
      warnings: [],
    });
  });

  // -------------------------------------------------------------------------
  // K. composeProposition inherits the same protection.
  // -------------------------------------------------------------------------
  it("K. composeProposition rejects hostile accessors too", () => {
    let reads = 0;
    const hostileInput = {
      scope: EXECUTION,
      applicability: "applicable",
      verdict: "supported",
      basis: ["source_observation"],
      get evidence() {
        reads++;
        return ["ev_good"];
      },
    } as unknown as VerdictInput;
    expect(() => composeProposition(hostileInput, { evidenceRefs: table })).toThrow(
      NecValidationError,
    );
    expect(reads).toBe(0);
  });

  // -------------------------------------------------------------------------
  // L. previously-green hostile array / iterator tests remain green: a
  //    hostile evidence array with a custom Symbol.iterator is rejected and
  //    its iterator is never consulted.
  // -------------------------------------------------------------------------
  it("L. hostile evidence-array iterator still rejected without invocation", () => {
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
      composeVerdict(
        [
          {
            scope: EXECUTION,
            applicability: "applicable",
            verdict: "supported",
            basis: ["source_observation"],
            evidence: hostileEvidence,
          } as unknown as VerdictInput,
        ],
        { evidenceRefs: table },
      ),
    ).toThrow(NecValidationError);
    expect(iteratorRuns).toBe(0);
  });

  it("L2. hostile basis iterator still rejected without invocation", () => {
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
      composeVerdict(
        [
          {
            scope: EXECUTION,
            applicability: "applicable",
            verdict: "supported",
            basis: hostileBasis,
            evidence: ["ev_good"],
          } as unknown as VerdictInput,
        ],
        { evidenceRefs: table },
      ),
    ).toThrow(NecValidationError);
    expect(iteratorRuns).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Additional adversarial self-checks (section 7): every TOCTOU variant
  // must have no path where representation A is validated but B influences
  // the result.
  // -------------------------------------------------------------------------
  it("self-check: getter swaps applicability after validation", () => {
    let reads = 0;
    const hostileInput = {
      scope: EXECUTION,
      get applicability() {
        reads++;
        return reads >= 2 ? "unknown" : "applicable";
      },
      verdict: "supported",
      basis: ["source_observation"],
      evidence: ["ev_good"],
    } as unknown as VerdictInput;
    expect(() => composeVerdict([hostileInput], { evidenceRefs: table })).toThrow(
      NecValidationError,
    );
    expect(reads).toBe(0);
  });

  it("self-check: getter swaps supported -> contradicted", () => {
    let reads = 0;
    const hostileInput = {
      scope: EXECUTION,
      applicability: "applicable",
      get verdict() {
        reads++;
        return reads >= 2 ? "contradicted" : "supported";
      },
      basis: ["source_observation"],
      evidence: ["ev_good"],
    } as unknown as VerdictInput;
    expect(() => composeVerdict([hostileInput], { evidenceRefs: table })).toThrow(
      NecValidationError,
    );
    expect(reads).toBe(0);
  });

  it("self-check: getter replaces basis array", () => {
    let reads = 0;
    const hostileInput = {
      scope: EXECUTION,
      applicability: "applicable",
      verdict: "supported",
      get basis() {
        reads++;
        return reads >= 2 ? ["vibes"] : ["source_observation"];
      },
      evidence: ["ev_good"],
    } as unknown as VerdictInput;
    expect(() => composeVerdict([hostileInput], { evidenceRefs: table })).toThrow(
      NecValidationError,
    );
    expect(reads).toBe(0);
  });

  it("self-check: getter replaces evidence array", () => {
    let reads = 0;
    const hostileInput = {
      scope: EXECUTION,
      applicability: "applicable",
      verdict: "supported",
      basis: ["source_observation"],
      get evidence() {
        reads++;
        return reads >= 2 ? ["ev_ghost"] : ["ev_good"];
      },
    } as unknown as VerdictInput;
    expect(() => composeVerdict([hostileInput], { evidenceRefs: table })).toThrow(
      NecValidationError,
    );
    expect(reads).toBe(0);
  });

  it("self-check: getter mutates existing evidence array", () => {
    const evidence = ["ev_good"];
    let reads = 0;
    const hostileInput = {
      scope: EXECUTION,
      applicability: "applicable",
      verdict: "supported",
      basis: ["source_observation"],
      get evidence() {
        reads++;
        if (reads >= 2) evidence[0] = "ev_ghost";
        return evidence;
      },
    } as unknown as VerdictInput;
    expect(() => composeVerdict([hostileInput], { evidenceRefs: table })).toThrow(
      NecValidationError,
    );
    expect(reads).toBe(0);
  });

  it("self-check: getter swaps scope after conflict matching", () => {
    let reads = 0;
    const hostileInput = {
      get scope() {
        reads++;
        return reads >= 2
          ? { kind: "dimension", dimension: "settlement" }
          : { kind: "dimension", dimension: "execution" };
      },
      applicability: "applicable",
      verdict: "supported",
      basis: ["source_observation"],
      evidence: ["ev_good"],
    } as unknown as VerdictInput;
    const material = conflict({
      id: "c_exec",
      material: true,
      scope: EXECUTION,
      evidence: ["ev_3"],
    });
    expect(() =>
      composeVerdict([hostileInput], { conflicts: [material], evidenceRefs: table }),
    ).toThrow(NecValidationError);
    expect(reads).toBe(0);
  });

  it("self-check: options getter swaps EvidenceRef table", () => {
    let reads = 0;
    const options = {
      get evidenceRefs() {
        reads++;
        return reads >= 2
          ? [evidenceRef({ id: "ev_ghost", sourceId: "ghost" })]
          : table;
      },
    } as unknown as ComposeOptions;
    const input: VerdictInput = {
      scope: EXECUTION,
      applicability: "applicable",
      verdict: "supported",
      basis: ["source_observation"],
      evidence: ["ev_good"],
    };
    expect(() => composeVerdict([input], options)).toThrow(NecValidationError);
    expect(reads).toBe(0);
  });

  it("self-check: options getter swaps conflicts", () => {
    let reads = 0;
    const options = {
      evidenceRefs: table,
      get conflicts() {
        reads++;
        return reads >= 2
          ? [conflict({ id: "c_ghost", material: true, scope: EXECUTION, evidence: ["ev_3"] })]
          : [];
      },
    } as unknown as ComposeOptions;
    const input: VerdictInput = {
      scope: EXECUTION,
      applicability: "applicable",
      verdict: "supported",
      basis: ["source_observation"],
      evidence: ["ev_good"],
    };
    expect(() => composeVerdict([input], options)).toThrow(NecValidationError);
    expect(reads).toBe(0);
  });

  it("self-check: shared object mutation between two contributions", () => {
    const sharedEvidence = ["ev_good"];
    let reads = 0;
    const a = {
      scope: EXECUTION,
      applicability: "applicable",
      verdict: "supported",
      basis: ["source_observation"],
      evidence: sharedEvidence,
    } as unknown as VerdictInput;
    const b = {
      scope: EXECUTION,
      applicability: "applicable",
      verdict: "supported",
      basis: ["source_observation"],
      get evidence() {
        reads++;
        return reads >= 2 ? ["ev_ghost"] : sharedEvidence;
      },
    } as unknown as VerdictInput;
    expect(() =>
      composeVerdict([a, b], { evidenceRefs: table }),
    ).toThrow(NecValidationError);
    expect(reads).toBe(0);
  });
});

// ===========================================================================
// FINAL TINY FIX PASS: snapshotComposeOptions must bound arrays through THE
// inert-array predicate (assertInertArray) BEFORE copying elements, so
//
//   1. over-limit arrays fail closed immediately (no giant descriptor-copy
//      loop for hostile `{length: N}`-style containers), and
//   2. non-array array-likes (`{0: ref, length: 1}`) are rejected as
//      NON-ARRAYS instead of entering inertArrayElements.
//
// Map support is unchanged: genuine Maps pass through and are still read
// ONLY through built-in Map intrinsics.
// ===========================================================================

describe("snapshotComposeOptions: inert-array bounding BEFORE element copy", () => {
  const supportedInput: VerdictInput = {
    scope: EXECUTION,
    applicability: "applicable",
    verdict: "supported",
    basis: ["source_observation"],
    evidence: ["ev_good"],
  };

  // A. exactly MAX_CONTAINER_ENTRIES entries -> accepted (reaches normal
  //    semantic validation; no resource-limit rejection).
  it("A. evidenceRefs array with exactly MAX_CONTAINER_ENTRIES is accepted", () => {
    const maxTable: EvidenceRef[] = [
      evidenceRef({ id: "ev_good" }),
      ...Array.from({ length: RESOURCE_LIMITS.MAX_CONTAINER_ENTRIES - 1 }, (_, i) =>
        evidenceRef({ id: `ev_${i}`, sourceId: `src_${i}` }),
      ),
    ];
    const result = composeVerdict([supportedInput], { evidenceRefs: maxTable });
    expect(result.applicability).toBe("applicable");
    expect(result.verdict).toBe("supported");
    expect(result.evidence).toEqual(["ev_good"]);
  });

  // B. MAX_CONTAINER_ENTRIES + 1 -> immediate controlled NecValidationError
  //    naming the normative constant.
  it("B. evidenceRefs array with MAX_CONTAINER_ENTRIES + 1 fails closed immediately", () => {
    const oversized: unknown[] = new Array(RESOURCE_LIMITS.MAX_CONTAINER_ENTRIES + 1).fill(
      evidenceRef({ id: "ev_good" }),
    );
    const attempt = () =>
      composeVerdict(
        [supportedInput],
        { evidenceRefs: oversized as ComposeOptions["evidenceRefs"] },
      );
    expect(attempt).toThrow(NecValidationError);
    expect(attempt).toThrow(/MAX_CONTAINER_ENTRIES/);
  });

  // C. conflicts beyond the bound -> immediate controlled NecValidationError.
  it("C. conflicts array with MAX_CONTAINER_ENTRIES + 1 fails closed immediately", () => {
    const oversizedConflicts: unknown[] = new Array(RESOURCE_LIMITS.MAX_CONTAINER_ENTRIES + 1)
      .fill(conflict());
    const attempt = () => composeVerdict([], { conflicts: oversizedConflicts as Conflict[] });
    expect(attempt).toThrow(NecValidationError);
    expect(attempt).toThrow(/MAX_CONTAINER_ENTRIES/);
  });

  // D. pseudo-array evidenceRefs must be rejected as NON-ARRAY — including
  //    the hostile `{length: 2_000_000}` resource-bypass shape.
  it("D. pseudo-array evidenceRefs fails closed as a non-array", () => {
    const pseudoArray = {
      0: evidenceRef({ id: "ev_good" }),
      length: 1,
    } as unknown as ComposeOptions["evidenceRefs"];
    const attempt = () => composeVerdict([supportedInput], { evidenceRefs: pseudoArray });
    expect(attempt).toThrow(NecValidationError);
    expect(attempt).toThrow(/must be an array/);

    // The regression shape from the finding: a huge-length array-like must
    // be rejected WITHOUT any descriptor-copy loop over its length.
    const hostileLengthOnly = { length: 2_000_000 } as unknown as ComposeOptions["evidenceRefs"];
    const hostileAttempt = () =>
      composeVerdict([supportedInput], { evidenceRefs: hostileLengthOnly });
    expect(hostileAttempt).toThrow(NecValidationError);
    expect(hostileAttempt).toThrow(/must be an array/);
  });

  // E. pseudo-array conflicts must be rejected as NON-ARRAY.
  it("E. pseudo-array conflicts fails closed as a non-array", () => {
    const pseudoConflicts = {
      0: conflict(),
      length: 1,
    } as unknown as ComposeOptions["conflicts"];
    const attempt = () => composeVerdict([supportedInput], { conflicts: pseudoConflicts });
    expect(attempt).toThrow(NecValidationError);
    expect(attempt).toThrow(/must be an array/);
  });

  // F. hostile accessor/index arrays on BOTH options fields are rejected via
  //    descriptors only — getter invocation count stays 0.
  it("F. hostile accessor-index option arrays are rejected with getter count === 0", () => {
    let refGets = 0;
    const hostileRefs: unknown[] = [];
    Object.defineProperty(hostileRefs, 0, {
      enumerable: true,
      get() {
        refGets++;
        return evidenceRef({ id: "ev_ghost" });
      },
    });
    let conflictGets = 0;
    const hostileConflicts: unknown[] = [conflict()];
    Object.defineProperty(hostileConflicts, 0, {
      enumerable: true,
      get() {
        conflictGets++;
        return conflict();
      },
    });

    const refAttempt = () =>
      composeVerdict(
        [supportedInput],
        { evidenceRefs: hostileRefs as ComposeOptions["evidenceRefs"] },
      );
    expect(refAttempt).toThrow(NecValidationError);
    expect(refGets).toBe(0);

    const conflictAttempt = () =>
      composeVerdict([], { conflicts: hostileConflicts as ComposeOptions["conflicts"] });
    expect(conflictAttempt).toThrow(NecValidationError);
    expect(conflictGets).toBe(0);
  });

  // G/H/I. ordinary valid inputs keep working unchanged.
  it("G. ordinary valid EvidenceRef[] still composes normally", () => {
    const result = composeVerdict([supportedInput], { evidenceRefs: table });
    expect(result.verdict).toBe("supported");
    expect(result.evidence).toEqual(["ev_good"]);
  });

  it("H. ordinary valid Conflict[] still forces ambiguous normally", () => {
    const material = conflict({
      id: "c_exec",
      material: true,
      scope: EXECUTION,
      evidence: ["ev_3"],
    });
    const result = composeVerdict([supportedInput], {
      conflicts: [material],
      evidenceRefs: table,
    });
    expect(result.applicability).toBe("applicable");
    expect(result.verdict).toBe("ambiguous");
    expect(result.warnings.map((w) => w.code)).toContain(
      COMPOSITION_WARNING_CODES.materialConflictBlocksConclusion,
    );
  });

  it("I. ordinary valid Map<string, EvidenceRef> evidence index still works", () => {
    const refs = new Map<string, EvidenceRef>([["ev_good", evidenceRef({ id: "ev_good" })]]);
    const result = composeVerdict([supportedInput], { evidenceRefs: refs });
    expect(result.verdict).toBe("supported");
    expect(result.evidence).toEqual(["ev_good"]);
  });

  // J. caller-overridden Map traversal surfaces cannot alter semantics:
  //    composition reads the map ONLY through built-in Map intrinsics.
  it("J. overridden Map.entries / Symbol.iterator / forEach cannot alter semantics", () => {
    const refs = new Map<string, EvidenceRef>([["ev_good", evidenceRef({ id: "ev_good" })]]);
    Object.defineProperty(refs, "entries", {
      configurable: true,
      value: function* () {
        throw new Error("caller-controlled entries override must never run");
      },
    });
    Object.defineProperty(refs, Symbol.iterator, {
      configurable: true,
      value: function* () {
        throw new Error("caller-controlled iterator override must never run");
      },
    });
    Object.defineProperty(refs, "forEach", {
      configurable: true,
      value: () => {
        throw new Error("caller-controlled forEach override must never run");
      },
    });
    Object.defineProperty(refs, "map", {
      configurable: true,
      value: () => {
        throw new Error("caller-controlled map override must never run");
      },
    });

    const result = composeVerdict([supportedInput], { evidenceRefs: refs });
    expect(result.verdict).toBe("supported");
    expect(result.evidence).toEqual(["ev_good"]);
  });
});
