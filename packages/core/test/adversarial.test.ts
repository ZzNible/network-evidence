import { describe, expect, it } from "vitest";

import {
  assertPlainRecord,
  buildEvidenceSnapshot,
  buildNetworkEvidenceResult,
  canonicalJson,
  NecCanonicalizationError,
  NecValidationError,
  validateEvidenceSnapshot,
  validateNetworkEvidenceResult,
} from "../src/index.js";
import {
  conflict as mkConflict,
  evidenceRef,
  fullPolicy,
  fullManifest,
  fullSnapshot,
  resultContext,
  snapshotContent,
  validResultContent,
  evidenceRequestContent,
} from "./fixtures.js";

/**
 * Adversarial regression tests: builder isolation, exact schemas, no
 * smuggling, referential integrity — pinned so they cannot regress.
 */

describe("adversarial: assertPlainRecord acceptance domain", () => {
  it("rejects primitives, null and arrays (the asserted type is a plain record)", () => {
    for (const bad of [42, "x", true, false, null, [], [1, 2], 0, 123n]) {
      let threw: unknown;
      try {
        assertPlainRecord(bad, "meta");
      } catch (e) {
        threw = e;
      }
      expect(threw, `expected rejection for ${String(bad)}`).toBeInstanceOf(NecValidationError);
    }
  });

  it("accepts genuine plain records with canonical content", () => {
    expect(() =>
      assertPlainRecord({ a: 1, b: ["x", true, null], c: { d: 42 } }, "meta"),
    ).not.toThrow();
    expect(() => assertPlainRecord({}, "meta")).not.toThrow();
  });

  it("mirrors nec-canonical-json-v1 exactly for numbers, accessors and depth", () => {
    for (const badNumber of [Number.NaN, Number.POSITIVE_INFINITY, -0, 1.5, 2 ** 53]) {
      expect(() => assertPlainRecord({ x: badNumber }, "meta")).toThrow(NecValidationError);
      expect(() => canonicalJson({ x: badNumber })).toThrow(NecCanonicalizationError);
    }

    const withGetter = {
      get a() {
        return 1;
      },
    };
    expect(() => assertPlainRecord(withGetter, "meta")).toThrow(NecValidationError);

    let deep: unknown = 1;
    for (let i = 0; i < 200; i++) deep = { v: deep };
    expect(() => assertPlainRecord(deep, "meta")).toThrow(NecValidationError);
  });
});

describe("adversarial: builders never mutate caller-owned state", () => {
  it("freezing a built result does not freeze caller-supplied nested objects", () => {
    const content = validResultContent();
    const myFingerprint = content.network;
    const myMetadata = { note: "mine" };
    // The snapshot must bind the SAME enriched ref (snapshot/result closure).
    const snapshot = buildEvidenceSnapshot({
      ...snapshotContent(),
      evidence: [evidenceRef({ metadata: structuredClone(myMetadata) })],
    });
    (content.evidence[0] as { metadata?: Record<string, unknown> }).metadata = myMetadata;
    content.snapshot = { id: snapshot.id, digest: snapshot.digest };

    const built = buildNetworkEvidenceResult(content, {
      policy: fullPolicy(),
      snapshot,
      resolver: fullManifest(),
      request: evidenceRequestContent(),
    });

    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built.network.observedAt)).toBe(true);
    expect(Object.isFrozen((built.evidence[0] as { metadata?: Record<string, unknown> }).metadata)).toBe(true);

    expect(Object.isFrozen(myFingerprint)).toBe(false);
    expect(Object.isFrozen(myFingerprint.observedAt)).toBe(false);
    expect(Object.isFrozen(myMetadata)).toBe(false);
    myMetadata.note = "still mine";
    expect(myMetadata.note).toBe("still mine");
  });

  it("cyclic input fails closed with NecValidationError instead of a stack overflow", () => {
    const content = validResultContent();
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    (content.evidence[0] as { metadata?: Record<string, unknown> }).metadata = cyclic;

    expect(() => buildNetworkEvidenceResult(content, resultContext())).toThrow(
      NecValidationError,
    );

    const arrContent = validResultContent();
    const cycArr: unknown[] = [1];
    cycArr.push(cycArr);
    arrContent.warnings = [{ code: "W", message: "m", metadata: { list: cycArr } }];
    expect(() => buildNetworkEvidenceResult(arrContent, resultContext())).toThrow(NecValidationError);
  });

  it("post-build mutation of caller structures cannot alter the frozen result", () => {
    const content = validResultContent();
    const before = buildNetworkEvidenceResult(content, resultContext());
    (content.network.observedAt as { blockNumber?: bigint }).blockNumber = 999n;
    content.requestId = "tampered";
    expect(before.requestId).toBe("req_1");
    expect(before.network.observedAt.blockNumber).toBe(1000n);
    expect(before.semanticDigest).toBe(
      buildNetworkEvidenceResult(validResultContent(), resultContext()).semanticDigest,
    );
  });
});

describe("adversarial: exact v0.1 field sets (no smuggling)", () => {
  it("rejects unknown top-level fields on NetworkEvidenceResult", () => {
    const content = validResultContent() as Record<string, unknown>;
    content.extraField = { anything: true };
    expect(() => buildNetworkEvidenceResult(content as never, resultContext())).toThrow(
      /unknown field/,
    );
  });

  it("reserved score keys cannot be smuggled in via unknown fields", () => {
    const content = validResultContent() as Record<string, unknown>;
    content.smuggled = { confidence: "high", trustScore: "99", vendor: { probability: "0.9" } };
    expect(() => buildNetworkEvidenceResult(content as never, resultContext())).toThrow(
      NecValidationError,
    );
  });

  it("rejects missing required top-level fields", () => {
    const broken = validResultContent() as Record<string, unknown>;
    delete broken.policy;
    expect(() => buildNetworkEvidenceResult(broken as never, resultContext())).toThrow(
      /missing required field "policy"/,
    );

    // Content that never carried the digest field fails closed too.
    expect(() => validateEvidenceSnapshot(snapshotContent() as never)).toThrow(
      /missing required field "digest"/,
    );
  });

  it("rejects unknown fields on EvidenceSnapshot", () => {
    const snap = { ...fullSnapshot(), extra: 1 } as Record<string, unknown>;
    expect(() => validateEvidenceSnapshot(snap as never)).toThrow(/unknown field/);
  });
});

describe("adversarial: referential integrity (no dangling provenance)", () => {
  function withExecutionEvidence(evidence: string[]) {
    const content = validResultContent();
    content.conflicts = [];
    content.networkEvidence.execution.evidence = evidence;
    return content;
  }

  it("rejects ghost evidence ids behind every dimension verdict", () => {
    for (const verdict of ["contradicted", "insufficient"] as const) {
      const content = withExecutionEvidence(["ev_ghost"]);
      content.networkEvidence.execution.verdict = verdict;
      expect(() => buildNetworkEvidenceResult(content, resultContext())).toThrow(
        /dangling provenance/,
      );
    }
  });

  it("observed effects without evidence or with unresolvable evidence are rejected", () => {
    const noEvidence = validResultContent();
    noEvidence.networkEvidence.observedEffects = [];
    // Empty observedEffects is legal.
    expect(() => buildNetworkEvidenceResult(noEvidence, resultContext())).not.toThrow();

    const ghost = validResultContent();
    ghost.networkEvidence.observedEffects = [
      {
        id: "effect_1",
        type: "erc20.transfer",
        fields: {},
        basis: ["source_observation"],
        evidence: ["ev_ghost"],
      },
    ];
    expect(() => buildNetworkEvidenceResult(ghost, resultContext())).toThrow(/dangling provenance/);
  });

  it("material conflicts must scope evidence; all conflict evidence must resolve", () => {
    const unscopeable = validResultContent();
    unscopeable.conflicts = [
      mkConflict({
        id: "c1",
        material: true,
        scope: { kind: "dimension", dimension: "settlement" },
        evidence: [],
      }),
    ];
    expect(() => buildNetworkEvidenceResult(unscopeable, resultContext())).toThrow(
      /must scope at least one EvidenceRef/,
    );

    const dangling = validResultContent();
    dangling.conflicts = [
      mkConflict({ id: "c1", material: false, evidence: ["ev_ghost"] }),
    ];
    expect(() => buildNetworkEvidenceResult(dangling, resultContext())).toThrow(/dangling provenance/);
  });

  it("warning evidence ids must resolve when present", () => {
    const content = validResultContent();
    content.warnings = [{ code: "W", message: "m", evidence: ["ev_ghost"] }];
    expect(() => buildNetworkEvidenceResult(content, resultContext())).toThrow(/dangling provenance/);
  });

  it("duplicate warnings are rejected, not silently deduplicated into artifacts", () => {
    const content = validResultContent();
    content.warnings = [
      { code: "W", message: "same" },
      { code: "W", message: "same" },
    ];
    expect(() => buildNetworkEvidenceResult(content, resultContext())).toThrow(/duplicate warning/);
  });

  it("empty evidence arrays on non-supported dimensions remain legal", () => {
    expect(() => buildNetworkEvidenceResult(validResultContent(), resultContext())).not.toThrow();
  });
});

describe("adversarial: scope-based validation consistency", () => {
  it("a material conflict scoped to another proposition does not block the supported one at artifact level either", () => {
    const enriched = [evidenceRef(), evidenceRef({ id: "ev_other", sourceId: "s2" })];
    // The snapshot binds the same evidence table (snapshot/result closure).
    const snapshot = buildEvidenceSnapshot({
      ...snapshotContent(),
      evidence: enriched.map((ref) => structuredClone(ref)),
    });
    const context = { policy: fullPolicy(), snapshot, resolver: fullManifest(), request: evidenceRequestContent() };

    const content = validResultContent();
    content.snapshot = { id: snapshot.id, digest: snapshot.digest };
    content.evidence = enriched.map((ref) => structuredClone(ref));
    content.conflicts = [
      mkConflict({
        id: "c_settle",
        material: true,
        scope: { kind: "dimension", dimension: "dataBinding" },
        evidence: ["ev_other"],
      }),
    ];
    expect(() => buildNetworkEvidenceResult(content, context)).not.toThrow();

    // Same conflict re-scoped to execution blocks.
    const blocking = validResultContent();
    blocking.snapshot = { id: snapshot.id, digest: snapshot.digest };
    blocking.evidence = enriched.map((ref) => structuredClone(ref));
    blocking.conflicts = [
      mkConflict({
        id: "c_exec",
        material: true,
        scope: { kind: "dimension", dimension: "execution" },
        evidence: ["ev_other"],
      }),
    ];
    expect(() => buildNetworkEvidenceResult(blocking, context)).toThrow(/prevent "supported"/);
  });
});
