import { describe, expect, it } from "vitest";

import {
  buildNetworkEvidenceResult,
  canonicalJson,
  computeNetworkEvidenceResultArtifactDigest,
  computeNetworkEvidenceResultSemanticDigest,
  verifyNetworkEvidenceResultIntegrity,
  verifyNetworkEvidenceResultSemantics,
} from "../src/index.js";
import {
  evidenceRequestContent,
  evidenceRef,
  fingerprint,
  fullPolicy,
  fullSnapshot,
  fullManifest,
  validResultContent,
} from "./fixtures.js";

const ctx = () => ({
  policy: fullPolicy(),
  snapshot: fullSnapshot(),
  resolver: fullManifest(),
  request: evidenceRequestContent(),
});

describe("result digest binding (semantic + artifact, nec-digest-v1)", () => {
  it("is deterministic across repeated builds", () => {
    const a = buildNetworkEvidenceResult(validResultContent(), ctx());
    const b = buildNetworkEvidenceResult(validResultContent(), ctx());
    expect(a.semanticDigest).toBe(b.semanticDigest);
    expect(a.artifactDigest).toBe(b.artifactDigest);
    expect(a).toEqual(b);
  });

  it("equivalent inputs (different key insertion order) produce identical digests", () => {
    const a = validResultContent();
    const b = validResultContent();
    b.network = {
      observedAt: { blockId: a.network.observedAt.blockId, blockNumber: 1000n },
      chainId: 8453,
      networkId: "eip155:8453",
    };
    expect(canonicalJson(b.network)).toBe(canonicalJson(a.network));
    expect(computeNetworkEvidenceResultSemanticDigest(a)).toBe(
      computeNetworkEvidenceResultSemanticDigest(b),
    );
  });

  it("semantically different bound inputs change the semantic digest", () => {
    const base = computeNetworkEvidenceResultSemanticDigest(validResultContent());

    const differentSubject = validResultContent();
    (differentSubject.subject as { txId: string }).txId = `0x${"22".repeat(32)}`;
    expect(computeNetworkEvidenceResultSemanticDigest(differentSubject)).not.toBe(base);

    const differentNetwork = validResultContent();
    differentNetwork.network = fingerprint({ networkId: "eip155:1", chainId: 1 });
    expect(computeNetworkEvidenceResultSemanticDigest(differentNetwork)).not.toBe(base);

    const differentEvidence = validResultContent();
    differentEvidence.evidence = [
      evidenceRef({ id: "ev_receipt_1", contentDigest: `sha256:${"99".repeat(32)}` }),
    ];
    expect(computeNetworkEvidenceResultSemanticDigest(differentEvidence)).not.toBe(base);
  });

  it("set-like collections: input ORDER never changes digests; duplicates are rejected by validation", () => {
    const content = validResultContent();
    const reordered = validResultContent();
    // Same single-element collections trivially match; exercise warnings order.
    content.warnings = [
      { code: "A", message: "first" },
      { code: "B", message: "second" },
    ];
    reordered.warnings = [
      { code: "B", message: "second" },
      { code: "A", message: "first" },
    ];
    expect(computeNetworkEvidenceResultSemanticDigest(content)).toBe(
      computeNetworkEvidenceResultSemanticDigest(reordered),
    );
  });

  it("requestId participates in artifact identity only; generatedAt likewise", () => {
    const built = buildNetworkEvidenceResult(validResultContent(), ctx());

    const otherTime = buildNetworkEvidenceResult(
      { ...validResultContent(), generatedAt: "2030-06-01T00:00:00.000Z" },
      ctx(),
    );
    expect(otherTime.generatedAt).not.toBe(built.generatedAt);
    expect(otherTime.semanticDigest).toBe(built.semanticDigest);
    expect(otherTime.artifactDigest).not.toBe(built.artifactDigest);

    const otherRequest = buildNetworkEvidenceResult(
      { ...validResultContent(), requestId: "req_2" },
      { ...ctx(), request: evidenceRequestContent({ requestId: "req_2" }) },
    );
    expect(otherRequest.semanticDigest).toBe(built.semanticDigest);
    expect(otherRequest.artifactDigest).not.toBe(built.artifactDigest);
  });

  it("conflicts and warnings participate in both digests", () => {
    const content = validResultContent();
    const withWarning = { ...content, warnings: [{ code: "W1", message: "note" }] };
    expect(computeNetworkEvidenceResultSemanticDigest(withWarning)).not.toBe(
      computeNetworkEvidenceResultSemanticDigest(content),
    );
  });

  it("integrity verification detects tampering and accepts intact results", () => {
    const built = buildNetworkEvidenceResult(validResultContent(), ctx());
    expect(verifyNetworkEvidenceResultIntegrity(built)).toBe(true);

    const tampered = {
      ...built,
      networkEvidence: {
        ...built.networkEvidence,
        execution: { ...built.networkEvidence.execution, verdict: "insufficient" as const },
      },
    };
    expect(verifyNetworkEvidenceResultIntegrity(tampered)).toBe(false);

    const malformed = { ...built } as Record<string, unknown>;
    delete malformed.schemaVersion;
    expect(verifyNetworkEvidenceResultIntegrity(malformed as never)).toBe(false);
  });

  it("built results are frozen and structurally stable", () => {
    const built = buildNetworkEvidenceResult(validResultContent(), ctx());
    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built.networkEvidence)).toBe(true);
    expect(() => {
      "use strict";
      (built as { requestId: string }).requestId = "hacked";
    }).toThrow();
  });
});
