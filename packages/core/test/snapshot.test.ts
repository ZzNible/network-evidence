import { describe, expect, it } from "vitest";

import {
  buildEvidenceSnapshot,
  computeEvidencePolicyDigest,
  computeResolverManifestDigest,
  verifyEvidenceSnapshotIntegrity,
} from "../src/index.js";
import { T0, evidenceRef, fullPolicy, fullManifest, snapshotContent } from "./fixtures.js";
import type { EvidencePolicy, ResolverManifest } from "../src/index.js";

describe("snapshot, policy and manifest digest binding", () => {
  it("snapshot digest binds content including createdAt and anchors, excluding its own digest", () => {
    const a = buildEvidenceSnapshot(snapshotContent());
    const b = buildEvidenceSnapshot(snapshotContent());
    expect(a.digest).toBe(b.digest);
    expect(a.digest).toMatch(/^sha256:[0-9a-f]{64}$/);

    // createdAt participates for snapshots (time-anchored artifact).
    const later = buildEvidenceSnapshot({ ...snapshotContent(), createdAt: "2027-01-01T00:00:00.000Z" });
    expect(later.digest).not.toBe(a.digest);

    // Different anchors -> different snapshot identity.
    const otherAnchor = snapshotContent();
    otherAnchor.anchors = [{ ...otherAnchor.anchors[0]!, blockNumber: 2001n }];
    expect(buildEvidenceSnapshot(otherAnchor).digest).not.toBe(a.digest);

    // Different bound policy digest -> different snapshot identity.
    const otherPolicy = snapshotContent();
    otherPolicy.policyDigest = `sha256:${"11".repeat(32)}`;
    expect(buildEvidenceSnapshot(otherPolicy).digest).not.toBe(a.digest);
  });

  it("snapshot integrity verification fails closed on tamper or malformed data", () => {
    const built = buildEvidenceSnapshot(snapshotContent());
    expect(verifyEvidenceSnapshotIntegrity(built)).toBe(true);

    const tampered = {
      ...built,
      evidence: [evidenceRef({ id: "ev_receipt_1", retrievedAt: T0, locator: "changed" })],
    };
    expect(verifyEvidenceSnapshotIntegrity(tampered)).toBe(false);

    const malformed = { ...built } as Record<string, unknown>;
    delete malformed.anchors;
    expect(verifyEvidenceSnapshotIntegrity(malformed as never)).toBe(false);
  });

  it("set-like collections: anchor/evidence order does not change the snapshot digest", () => {
    const base = buildEvidenceSnapshot({
      ...snapshotContent(),
      anchors: [
        ...snapshotContent().anchors,
        { networkId: "eip155:42161", blockNumber: 7n },
      ],
      evidence: [...snapshotContent().evidence, evidenceRef({ id: "ev_2", sourceId: "s2" })],
    });
    const reordered = buildEvidenceSnapshot({
      ...snapshotContent(),
      anchors: [
        { networkId: "eip155:42161", blockNumber: 7n },
        ...snapshotContent().anchors,
      ],
      evidence: [evidenceRef({ id: "ev_2", sourceId: "s2" }), ...snapshotContent().evidence],
    });
    expect(base.digest).toBe(reordered.digest);
  });

  it("policy and manifest digests ignore their self-referential digest field only", () => {
    const policy: Omit<EvidencePolicy, "digest"> = {
      id: "payment-basic",
      version: "1",
      requiredDimensions: ["execution", "observedEffects"],
      desiredDimensions: ["finality"],
      rules: { maxSourceSkewSeconds: 30 },
    };
    const d1 = computeEvidencePolicyDigest(policy);
    const d2 = computeEvidencePolicyDigest({ ...policy, digest: `sha256:${"aa".repeat(32)}` });
    expect(d1).toBe(d2);

    // Dimension order is canonical (set-like): reordering changes nothing.
    const d3 = computeEvidencePolicyDigest({
      ...policy,
      requiredDimensions: ["observedEffects", "execution"],
    });
    expect(d3).toBe(d1);

    const changed = computeEvidencePolicyDigest({ ...policy, version: "2" });
    expect(changed).not.toBe(d1);

    const manifest: Omit<ResolverManifest, "digest"> = {
      id: "resolver-evm",
      version: "0.1.0",
      networkFamilies: ["eip155"],
      implementation: { package: "@nec/resolver-evm" },
      supportedCapabilities: ["execution", "observedEffects"],
      sourceRequirements: [{ sourceType: "evm_rpc", required: true }],
    };
    const m1 = computeResolverManifestDigest(manifest);
    const m2 = computeResolverManifestDigest({ ...manifest, digest: `sha256:${"bb".repeat(32)}` });
    expect(m1).toBe(m2);
    expect(
      computeResolverManifestDigest({
        ...manifest,
        supportedCapabilities: ["execution", "observedEffects", "finality"],
      }),
    ).not.toBe(m1);
    // Self-digests of the full fixtures bind their real content.
    expect(fullPolicy().digest).toBe(computeEvidencePolicyDigest(fullPolicy()));
    expect(fullManifest().digest).toBe(computeResolverManifestDigest(fullManifest()));
  });
});
