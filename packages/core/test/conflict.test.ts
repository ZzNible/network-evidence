import { describe, expect, it } from "vitest";

import {
  blockingConflicts,
  conflictAffectsProposition,
  hasBlockingMaterialConflict,
  isMaterialConflict,
  isPropositionScope,
  mergeConflicts,
  mergeWarnings,
  samePropositionScope,
} from "../src/index.js";
import type { PropositionScope } from "../src/index.js";
import { conflict as mkConflict, warn } from "./fixtures.js";

const EXECUTION: PropositionScope = { kind: "dimension", dimension: "execution" };
const FINALITY: PropositionScope = { kind: "dimension", dimension: "finality" };

describe("conflict handling", () => {
  it("identifies material conflicts explicitly", () => {
    const a = mkConflict({ id: "a", material: false });
    const b = mkConflict({ id: "b", material: true });
    expect(isMaterialConflict(a)).toBe(false);
    expect(blockingConflicts([a, b])).toEqual([b]);
    expect(hasBlockingMaterialConflict([a])).toBe(false);
    expect(hasBlockingMaterialConflict([a, b])).toBe(true);
  });

  it("scopes conflicts by EXPLICIT proposition scope (never EvidenceId overlap)", () => {
    const c = mkConflict({ id: "c", material: true, scope: EXECUTION, evidence: ["ev_2"] });
    expect(conflictAffectsProposition(c.scope, EXECUTION)).toBe(true);
    expect(conflictAffectsProposition(c.scope, FINALITY)).toBe(false);
    // Even when the evidence ids overlap, a different proposition is untouched.
    expect(c.evidence).toEqual(["ev_2"]);
  });

  it("scope equality helpers behave precisely", () => {
    expect(samePropositionScope(EXECUTION, { kind: "dimension", dimension: "execution" })).toBe(true);
    expect(
      samePropositionScope({ kind: "custom", namespace: "a", id: "1" }, { kind: "custom", namespace: "a", id: "1" }),
    ).toBe(true);
    expect(
      samePropositionScope({ kind: "custom", namespace: "a", id: "1" }, { kind: "custom", namespace: "a", id: "2" }),
    ).toBe(false);
    expect(isPropositionScope({ kind: "result" })).toBe(true);
  });

  it("merges deterministically: sorted by id, exact duplicates deduplicated", () => {
    const x = mkConflict({ id: "b" });
    const y = mkConflict({ id: "a" });
    const dupX = mkConflict({ id: "b" });
    expect(mergeConflicts([x], [y, dupX]).map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("fails closed on same-id different-content collisions instead of silently merging", () => {
    const a1 = mkConflict({ id: "same", description: "one" });
    const a2 = mkConflict({ id: "same", description: "two" });
    expect(() => mergeConflicts([a1], [a2])).toThrow();
  });

  it("never drops distinct warnings and keeps order stable", () => {
    const w1 = warn({ code: "A", message: "first" });
    const w2 = warn({ code: "B", message: "second" });
    const merged = mergeWarnings([w2], [w1]);
    expect(merged).toHaveLength(2);
    expect(merged.map((w) => w.code)).toEqual(["A", "B"]);
    // Structural duplicates collapse.
    expect(mergeWarnings([w1], [warn({ code: "A", message: "first" })])).toHaveLength(1);
  });

  it("preserves every conflict and warning in output (nothing normalized away)", () => {
    const conflicts = [
      mkConflict({ id: "z" }),
      mkConflict({ id: "m" }),
      mkConflict({ id: "a", material: true }),
    ];
    const merged = mergeConflicts(conflicts, []);
    expect(merged).toHaveLength(3);
    expect(hasBlockingMaterialConflict(merged)).toBe(true);
  });
});
