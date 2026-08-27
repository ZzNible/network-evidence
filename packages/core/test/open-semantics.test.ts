import { describe, expect, it } from "vitest";

import {
  buildNetworkEvidenceResult,
  composeVerdict,
  canonicalJson,
  decodeNecWireJson,
  encodeNecWireJson,
  parseNecWireJson,
  verifyNetworkEvidenceResultIntegrity,
  verifyNetworkEvidenceResultSemantics,
} from "../src/index.js";
import type { PropositionScope } from "../src/index.js";
import {
  conflict as mkConflict,
  evidenceRequestContent,
  evidenceRef,
  fullSnapshot,
  resultContext,
  validResultContent,
} from "./fixtures.js";

/**
 * Freeze-point semantics that REPLACE the earlier v0.1 audit limitations:
 *
 *   - CONFLICT SCOPE is now explicit (`PropositionScope`); the old
 *     EvidenceId-overlap failure modes (over-/under-blocking) are gone.
 *   - TWO digests: `semanticDigest` (replay identity) and `artifactDigest`
 *     (logical artifact integrity incl. requestId/generatedAt).
 *   - WIRE profile `nec-wire-json-v1`: schema-aware decimal strings for
 *     unbounded integers; JSON.stringify no longer throws on artifacts.
 */

const EXECUTION: PropositionScope = { kind: "dimension", dimension: "execution" };
const EFFECTS: PropositionScope = { kind: "observed_effect", effectId: "effect_1" };

describe("scope replaces EvidenceId-overlap scoping", () => {
  const refs = [evidenceRef({ id: "ev_shared" }), evidenceRef({ id: "ev_other", sourceId: "s2" })];

  it("a transfer-effects conflict no longer over-blocks the execution proposition sharing one ref", () => {
    const effectsConflict = mkConflict({
      id: "c_transfer_logs",
      material: true,
      scope: EFFECTS,
      evidence: ["ev_shared"],
    });
    const outcome = composeVerdict(
      [
        {
          scope: EXECUTION,
          applicability: "applicable",
          verdict: "supported",
          basis: ["source_observation"],
          evidence: ["ev_shared"],
        },
      ],
      { conflicts: [effectsConflict], evidenceRefs: refs },
    );
    expect(outcome.verdict).toBe("supported");
  });

  it("an execution-scoped conflict with DISJOINT refs still blocks the execution proposition (no under-blocking)", () => {
    const conflictA = mkConflict({
      id: "c_receipts",
      material: true,
      scope: EXECUTION,
      evidence: ["ev_a"],
    });
    const refsAB = [evidenceRef({ id: "ev_a" }), evidenceRef({ id: "ev_b", sourceId: "s2" })];
    const outcome = composeVerdict(
      [
        {
          scope: EXECUTION,
          applicability: "applicable",
          verdict: "supported",
          basis: ["source_observation"],
          evidence: ["ev_b"],
        },
      ],
      { conflicts: [conflictA], evidenceRefs: refsAB },
    );
    expect(outcome.verdict).toBe("ambiguous");
  });

  it("artifact-level: scoped conflict forces ambiguous; different scope stays silent", () => {
    const snapshot = fullSnapshot();
    const content = validResultContent();
    content.snapshot = { id: snapshot.id, digest: snapshot.digest };
    content.conflicts = [
      mkConflict({
        id: "c_exec",
        material: true,
        scope: EXECUTION,
        evidence: ["ev_receipt_1"],
      }),
    ];
    // supported + scoped conflict cannot coexist...
    expect(() => buildNetworkEvidenceResult(content, resultContext())).toThrow(/prevent "supported"/);
    // ...the honest artifact is ambiguous WITH the conflict attached.
    content.networkEvidence.execution.verdict = "ambiguous";
    const built = buildNetworkEvidenceResult(content, resultContext());
    expect(built.networkEvidence.execution.verdict).toBe("ambiguous");
    expect(verifyNetworkEvidenceResultSemantics(built)).toBe(true);

    // Same conflict re-scoped to a foreign proposition leaves execution supported.
    const foreign = validResultContent();
    foreign.conflicts = [
      mkConflict({
        id: "c_foreign",
        material: true,
        scope: { kind: "dimension", dimension: "dataBinding" },
        evidence: ["ev_receipt_1"],
      }),
    ];
    const builtForeign = buildNetworkEvidenceResult(foreign, resultContext());
    expect(builtForeign.networkEvidence.execution.verdict).toBe("supported");
  });
});

describe("semanticDigest vs artifactDigest", () => {
  it("semanticDigest is stable under requestId AND generatedAt changes; artifactDigest changes under either", () => {
    const built = buildNetworkEvidenceResult(validResultContent(), resultContext());

    const replayed = buildNetworkEvidenceResult(
      { ...validResultContent(), generatedAt: "1999-12-31T23:59:59.000Z" },
      resultContext(),
    );
    expect(replayed.semanticDigest).toBe(built.semanticDigest);
    expect(replayed.artifactDigest).not.toBe(built.artifactDigest);

    const otherRequest = buildNetworkEvidenceResult(
      { ...validResultContent(), requestId: "req_other" },
      {
        ...resultContext(),
        request: evidenceRequestContent({ requestId: "req_other" }),
      },
    );
    expect(otherRequest.semanticDigest).toBe(built.semanticDigest);
    expect(otherRequest.artifactDigest).not.toBe(built.artifactDigest);
  });

  it("any bound semantic field changes BOTH digests as appropriate", () => {
    const built = buildNetworkEvidenceResult(validResultContent(), resultContext());
    const changedSubject = validResultContent();
    changedSubject.subject = { ...changedSubject.subject } as never;
    (changedSubject.subject as { txId: string }).txId = `0x${"22".repeat(32)}`;
    // The bound request moves with the subject (continuity is enforced).
    const rebuilt = buildNetworkEvidenceResult(changedSubject, {
      ...resultContext(),
      request: evidenceRequestContent({
        subject: { type: "transaction", networkId: "eip155:8453", txId: `0x${"22".repeat(32)}` },
      }),
    });
    expect(rebuilt.semanticDigest).not.toBe(built.semanticDigest);
    expect(rebuilt.artifactDigest).not.toBe(built.artifactDigest);

    // Mutating an artifact field breaks integrity verification of the copy.
    // PHASE B: emission metadata must move consistently — a lone requestId
    // mutation breaks the bound-request pairing (structural fail closed).
    const tampered = { ...built, requestId: "x" };
    expect(verifyNetworkEvidenceResultIntegrity(tampered)).toBe(false);
    expect(verifyNetworkEvidenceResultSemantics(tampered)).toBe(false);
    const consistent = {
      ...built,
      requestId: "x",
      request: { ...built.request, requestId: "x" },
    };
    expect(verifyNetworkEvidenceResultIntegrity(consistent)).toBe(false);
    // Semantic identity survives CONSISTENT emission-metadata mutation.
    expect(verifyNetworkEvidenceResultSemantics(consistent)).toBe(true);
  });

  it("canonical form remains the lossless digest input domain", () => {
    expect(canonicalJson({ blockNumber: 1000n })).toBe('{"blockNumber":1000}');
    expect(canonicalJson({ blockNumber: 1000n })).toBe(canonicalJson({ blockNumber: 1000 }));
  });
});

describe("wire transport replaces raw JSON.stringify failure modes", () => {
  it("artifacts now serialize losslessly via nec-wire-json-v1", () => {
    const built = buildNetworkEvidenceResult(validResultContent(), resultContext());
    const wire = encodeNecWireJson("network-evidence-result", built);
    const decoded = decodeNecWireJson("network-evidence-result", wire);
    expect(decoded).toEqual(built);
    // Raw JSON.stringify still throws on bigints — the wire profile exists
    // precisely because generic serialization cannot be trusted.
    expect(() => JSON.stringify(built)).toThrow(TypeError);
  });

  it("raw JSON number tokens silently corrupt >2^53; wire decimal strings do not", () => {
    const parsed: { h: number } = JSON.parse('{"h":1152921504606846977}');
    expect(BigInt(parsed.h)).not.toBe(2n ** 60n + 1n); // precision destroyed

    // The wire profile carries the exact value.
    const wire = '{"blockNumber":"1152921504606846977"}';
    expect(() => parseNecWireJson(wire)).not.toThrow();
  });
});
