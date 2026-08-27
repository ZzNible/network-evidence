import { describe, expect, it } from "vitest";

import {
  buildEvidenceSnapshot,
  buildNetworkEvidenceResult,
  computeEvidencePolicyDigest,
  computeResolverManifestDigest,
  verifyNetworkEvidenceContext,
  verifyNetworkEvidenceResult,
  verifyNetworkEvidenceResultIntegrity,
  verifyNetworkEvidenceResultSemantics,
  NecValidationError,
} from "../src/index.js";
import type { EvidenceAnchor } from "../src/index.js";
import {
  CROSS_NETWORK,
  evidenceRef,
  fingerprint,
  fullPolicy,
  fullSnapshot,
  fullManifest,
  policyContent,
  manifestContent,
  snapshotContent,
  evidenceRequestContent,
  validResultContent,
} from "./fixtures.js";

/**
 * DECISION: cross-artifact coherence. Result construction/verification
 * validates the ACTUAL artifacts behind refs (policy digest, snapshot
 * digest, resolver digest) via contextual builder/verifier inputs — never a
 * shape check. Cross-network evidence is ALLOWED with an explicit snapshot
 * anchor and invalid without one.
 */

describe("cross-artifact ref verification", () => {
  it("builds only against the complete coherent artifacts", () => {
    const built = buildNetworkEvidenceResult(validResultContent(), {
      policy: fullPolicy(),
      snapshot: fullSnapshot(),
      resolver: fullManifest(),
      request: evidenceRequestContent(),
    });
    expect(built.semanticDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(built.artifactDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(Object.isFrozen(built)).toBe(true);
  });

  it("rejects subject/network mismatch", () => {
    const content = validResultContent();
    // PHASE B: the result binds its complete EvidenceRequest; a substituted
    // subject breaks REQUEST continuity first (fail closed either way).
    content.subject = { ...content.subject, networkId: "eip155:1" } as never;
    expect(() =>
      buildNetworkEvidenceResult(content, {
        policy: fullPolicy(),
        snapshot: fullSnapshot(),
        resolver: fullManifest(),
        request: evidenceRequestContent(),
      }),
    ).toThrow(NecValidationError);
  });

  it("rejects policy ref mismatch", () => {
    const content = validResultContent();
    content.policy = { id: fullPolicy().id, version: fullPolicy().version, digest: `sha256:${"ff".repeat(32)}` };
    expect(() =>
      buildNetworkEvidenceResult(content, {
        policy: fullPolicy(),
        snapshot: fullSnapshot(),
        resolver: fullManifest(),
        request: evidenceRequestContent(),
      }),
    ).toThrow(/reference does not exactly match/);
  });

  it("rejects resolver ref mismatch", () => {
    const content = validResultContent();
    content.resolver = { ...content.resolver, version: "0.2.0" };
    expect(() =>
      buildNetworkEvidenceResult(content, {
        policy: fullPolicy(),
        snapshot: fullSnapshot(),
        resolver: fullManifest(),
        request: evidenceRequestContent(),
      }),
    ).toThrow(/resolver.version: reference does not exactly match/);
  });

  it("rejects snapshot digest/context mismatch", () => {
    const content = validResultContent();
    content.snapshot = { id: "snap_1", digest: `sha256:${"ee".repeat(32)}` };
    expect(() =>
      buildNetworkEvidenceResult(content, {
        policy: fullPolicy(),
        snapshot: fullSnapshot(),
        resolver: fullManifest(),
        request: evidenceRequestContent(),
      }),
    ).toThrow(/snapshot.digest: reference does not exactly match/);

    // Snapshot whose bound network context differs from result.network.
    const otherFingerprintContext = validResultContent();
    otherFingerprintContext.network = fingerprint({ observedAt: { blockNumber: 2000n } });
    const tamperedSnapshot = fullSnapshot();
    // Build content against the real snapshot but claim another network ctx.
    expect(() =>
      buildNetworkEvidenceResult(otherFingerprintContext, {
        policy: fullPolicy(),
        snapshot: tamperedSnapshot,
        resolver: fullManifest(),
        request: evidenceRequestContent(),
      }),
    ).toThrow(/snapshot.networkFingerprint must equal the result primary network context/);
  });

  it("rejects snapshot bindings to wrong policy/resolver digests", () => {
    const otherPolicy = { ...policyContent(), version: "2", digest: "" };
    (otherPolicy as { digest: string }).digest = computeEvidencePolicyDigest(otherPolicy);
    const mismatchedSnapshot = fullSnapshot();
    const rebuilt = {
      ...mismatchedSnapshot,
      policyDigest: `sha256:${"12".repeat(32)}`,
    };
    // A snapshot claiming a different policy digest cannot be verified
    // against the provided artifacts at all (self-digest breaks too).
    expect(() =>
      verifyNetworkEvidenceContext(
        { ...validResultContent(), request: { requestId: "req_1", digest: `sha256:${"aa".repeat(32)}` } },
        {
          policy: fullPolicy(),
          snapshot: rebuilt,
          resolver: fullManifest(),
          request: evidenceRequestContent(),
        },
      ),
    ).toThrow(NecValidationError);
    expect(otherPolicy.digest).not.toBe(fullPolicy().digest);
  });

  it("cross-network evidence is VALID with an explicit snapshot anchor", () => {
    const crossAnchor: EvidenceAnchor = {
      networkId: CROSS_NETWORK,
      blockNumber: 42n,
      role: "settlement_observation",
    };
    // Snapshot/result closure: the snapshot binds the same evidence table.
    const snapshot = buildEvidenceSnapshot({
      ...snapshotContent([crossAnchor]),
      evidence: [
        evidenceRef(),
        evidenceRef({ id: "ev_cross", sourceId: "src.cross", networkId: CROSS_NETWORK }),
      ],
    });
    const content = validResultContent();
    content.snapshot = { id: snapshot.id, digest: snapshot.digest };
    content.evidence = [evidenceRef(), evidenceRef({ id: "ev_cross", sourceId: "src.cross", networkId: CROSS_NETWORK })];
    const built = buildNetworkEvidenceResult(content, {
      policy: fullPolicy(),
      snapshot,
      resolver: fullManifest(),
      request: evidenceRequestContent(),
    });
    expect(verifyNetworkEvidenceResult(built, {
      policy: fullPolicy(),
      snapshot,
      resolver: fullManifest(),
      request: evidenceRequestContent(),
    })).toBe(true);
  });

  it("cross-network evidence WITHOUT an anchor is rejected; never implied atomic state", () => {
    // The ref exists identically in the snapshot (closure satisfied), but no
    // EvidenceAnchor covers its foreign network.
    const snapshot = buildEvidenceSnapshot({
      ...snapshotContent(),
      evidence: [
        evidenceRef(),
        evidenceRef({ id: "ev_cross", sourceId: "src.cross", networkId: CROSS_NETWORK }),
      ],
    });
    const content = validResultContent();
    content.snapshot = { id: snapshot.id, digest: snapshot.digest };
    content.evidence = [
      evidenceRef(),
      evidenceRef({ id: "ev_cross", sourceId: "src.cross", networkId: CROSS_NETWORK }),
    ];
    expect(() =>
      buildNetworkEvidenceResult(content, {
        policy: fullPolicy(),
        snapshot,
        resolver: fullManifest(),
        request: evidenceRequestContent(),
      }),
    ).toThrow(/no explicit EvidenceAnchor in the snapshot/);
  });
});

describe("caller-supplied self-digest fields are rejected, never overwritten", () => {
  it("semantic/artifact digest smuggling fails closed", () => {
    for (const field of ["semanticDigest", "artifactDigest"]) {
      const content = validResultContent() as Record<string, unknown>;
      content[field] = `sha256:${"ab".repeat(32)}`;
      expect(() =>
        buildNetworkEvidenceResult(content as never, {
          policy: fullPolicy(),
          snapshot: fullSnapshot(),
          resolver: fullManifest(),
          request: evidenceRequestContent(),
        }),
      ).toThrow(new RegExp(`self-digest field "${field}"`));
    }
  });

  it("snapshot/policy/manifest self-digest smuggling fails closed", async () => {
    const { buildEvidenceSnapshot } = await import("../src/index.js");
    const snap = { ...fullSnapshot(), digest: `sha256:${"11".repeat(32)}` };
    expect(() => buildEvidenceSnapshot(snap)).toThrow(/self-digest field "digest"/);

    const { validateEvidencePolicy, validateResolverManifest } = await import("../src/index.js");
    const badPolicy = { ...policyContent(), digest: `sha256:${"22".repeat(32)}` };
    expect(() => validateEvidencePolicy(badPolicy)).toThrow(/self-digest mismatch/);
    const badManifest = { ...manifestContent(), digest: `sha256:${"33".repeat(32)}` };
    expect(() => validateResolverManifest(badManifest)).toThrow(/self-digest mismatch/);
  });
});

describe("integrity vs semantics verifiers", () => {
  it("artifactDigest verification detects ANY logical mutation incl. requestId/generatedAt", () => {
    const built = buildNetworkEvidenceResult(validResultContent(), {
      policy: fullPolicy(),
      snapshot: fullSnapshot(),
      resolver: fullManifest(),
      request: evidenceRequestContent(),
    });
    expect(
      verifyNetworkEvidenceResultIntegrity({ ...built, requestId: "req_other" } as never),
    ).toBe(false);
    expect(
      verifyNetworkEvidenceResultIntegrity({ ...built, generatedAt: "2030-06-01T00:00:00.000Z" } as never),
    ).toBe(false);
    expect(
      verifyNetworkEvidenceResultIntegrity({
        ...built,
        semanticDigest: `sha256:${"aa".repeat(32)}`,
      }),
    ).toBe(false);
    expect(verifyNetworkEvidenceResultIntegrity(built)).toBe(true);
  });

  it("full verification requires context for cross-artifact guarantees", () => {
    const built = buildNetworkEvidenceResult(validResultContent(), {
      policy: fullPolicy(),
      snapshot: fullSnapshot(),
      resolver: fullManifest(),
      request: evidenceRequestContent(),
    });
    // Digest-consistent but referencing nonexistent artifacts still passes
    // internal verification without context...
    expect(verifyNetworkEvidenceResultIntegrity(built)).toBe(true);
    // ...and the CONTEXTUAL claim verifier (required context) fails with an
    // unrelated context.
    expect(
      verifyNetworkEvidenceResult(built, {
        policy: fullPolicy(),
        snapshot: fullSnapshot([{ networkId: "eip155:10", blockNumber: 5n }]),
        resolver: fullManifest(),
        request: evidenceRequestContent(),
      }),
    ).toBe(false);
  });

  it("semantic verification is stable while artifact identity moves", () => {
    const built = buildNetworkEvidenceResult(validResultContent(), {
      policy: fullPolicy(),
      snapshot: fullSnapshot(),
      resolver: fullManifest(),
      request: evidenceRequestContent(),
    });
    const replayed = buildNetworkEvidenceResult(
      { ...validResultContent(), requestId: "req_other", generatedAt: "2033-01-01T00:00:00.000Z" },
      {
        policy: fullPolicy(),
        snapshot: fullSnapshot(),
        resolver: fullManifest(),
        request: evidenceRequestContent({ requestId: "req_other" }),
      },
    );
    expect(replayed.semanticDigest).toBe(built.semanticDigest);
    expect(replayed.artifactDigest).not.toBe(built.artifactDigest);
    expect(verifyNetworkEvidenceResultSemantics(built)).toBe(true);
  });
});
