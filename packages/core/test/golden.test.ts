import { describe, expect, it } from "vitest";

import {
  buildEvidenceSnapshot,
  buildNetworkEvidenceResult,
  canonicalJson,
  canonicalJsonBytes,
  digestBytes,
  digestCanonicalJson,
  encodeNecWireJson,
} from "../src/index.js";
import type { EvidencePolicy, Hex, ResolverManifest } from "../src/index.js";

/**
 * GOLDEN DETERMINISTIC VECTORS — `nec-canonical-json-v1` / `nec-digest-v1` /
 * `nec-wire-json-v1`.
 *
 * REGENERATED AT THE v0.1 FREEZE POINT. The previous vectors were NOT kept:
 * the freeze adjudicated contract changes that intentionally alter every
 * bound artifact —
 *
 *   - NetworkEvidenceResult.resultDigest was REPLACED by two explicit,
 *     separately domain-separated digests (semanticDigest over the replay
 *     identity excluding requestId/generatedAt; artifactDigest binding every
 *     logical field except itself);
 *   - EVM-specific hex-hash fields were renamed to family-neutral opaque
 *     identifiers (txHash -> txId, blockHash -> blockId);
 *   - conflicts carry an explicit PropositionScope;
 *   - unpaired surrogates are now rejected by nec-canonical-json-v1 (the old
 *     lone-surrogate vector pinned lossy behavior).
 *
 * PHASE B REGENERATION RATIONALE (first prior regeneration):
 *   - NetworkEvidenceResult gained the REQUIRED bound-request reference
 *     `request: EvidenceRequestRef {requestId, digest}` where digest =
 *     computeEvidenceRequestDigest(complete request). The ARTIFACT digest
 *     changed (the request ref participates in artifact integrity); the
 *     SEMANTIC digest did not (the request reference is emission/
 *     correlation metadata, excluded from the semantic projection).
 *
 * R3 REGENERATION RATIONALE (contract-closure pass 3):
 *   - NetworkEvidenceResult gained the semantic `action: ActionDescriptor`
 *     field. The expected action now participates in BOTH digests: the
 *     semantic replay identity BINDS the action (same subject/policy/
 *     evidence + different expected action => different semanticDigest),
 *     so the golden semantic vector was regenerated. The artifact digest
 *     regenerated for the same reason plus the embedded request's action.
 *
 * These vectors are the conformance targets for any other language
 * implementation of the three profiles. Cross-language rules pinned here:
 *   - object keys sorted by UTF-16 CODE-UNIT order (NOT Unicode code-point
 *     order; see the astral-plane vector below);
 *   - strings escaped exactly like JSON.stringify, no Unicode normalization,
 *     unpaired surrogates REJECTED;
 *   - numbers: safe integers only; bigints: decimal tokens; 123n == 123;
 *   - digests: SHA-256 over "nec-digest-v1\n<domain>\n<byteLength>\n<payload>";
 *   - wire: schema-declared integer quantities as quoted decimal strings.
 */

describe("golden vectors: canonical JSON text", () => {
  it("pins ASCII key ordering (UTF-16 code-unit order)", () => {
    expect(canonicalJson({ b: 1, a: 2, C: 3, "0": 4, _: 5 })).toBe(
      '{"0":4,"C":3,"_":5,"a":2,"b":1}',
    );
  });

  it("pins astral-plane ordering: UTF-16 surrogates sort BELOW U+FFFD/U+FFFF", () => {
    // Code-point order would place U+1F600 after U+FFFD/U+FFFF.
    // UTF-16 code-unit order places its leading surrogate 0xD83D before both.
    expect(canonicalJson({ "\u{1F600}": "a", "\uFFFD": "b", "\uFFFF": "c", A: 1 })).toBe(
      '{"A":1,"\u{1F600}":"a","\uFFFD":"b","\uFFFF":"c"}',
    );
  });

  it("pins string escaping incl. combining marks and control chars; lone surrogates are rejected", () => {
    expect(canonicalJson("é e\u0301 \u0000 \" \\ \n\t")).toBe(
      '"é e\u0301 \\u0000 \\" \\\\ \\n\\t"',
    );
    // FREEZE CHANGE: unpaired surrogates fail closed instead of being escaped.
    expect(() => canonicalJson("lone\ud800")).toThrow(/unpaired/);
  });

  it("pins bigint tokens and number/bigint byte-equality", () => {
    expect(canonicalJson([3n, 1, true, null])).toBe("[3,1,true,null]");
    const u256max =
      "115792089237316195423570985008687907853269984665640564039457584007913129639935";
    expect(canonicalJson(2n ** 256n - 1n)).toBe(u256max);
    expect(canonicalJson({ x: 123n })).toBe(canonicalJson({ x: 123 }));
  });
});

describe("golden vectors: digest profile", () => {
  it("pins digestBytes for an explicit preimage", () => {
    // Preimage: "nec-digest-v1\ntest-vector\n17\nnec golden payload"
    expect(digestBytes("test-vector", new TextEncoder().encode("nec golden payload"))).toBe(
      "sha256:fa65525d975d6c2eac4fd9e437cf75c838a4b75962df1414f30de60a5292805e",
    );
  });

  it("pins canonical-JSON digests over bigint-bearing payloads", () => {
    expect(digestCanonicalJson("evidence-ref", { blockNumber: 123n, id: "e" })).toBe(
      "sha256:0f52625994ab48d9cd47f1d32deb493016835914c3a9335819fd4bb1f8288fea",
    );
    expect(digestCanonicalJson("evidence-policy", { b: 2, a: 1 })).toBe(
      "sha256:ef01f6bc2d58dda27f250687be4f007b70d838eba1c2d965565abfff75ec5b36",
    );
  });

  it("pins domain separation between the two result digest domains", () => {
    const payload = { same: "payload" };
    expect(digestCanonicalJson("network-evidence-result-semantic", payload)).not.toBe(
      digestCanonicalJson("network-evidence-result-artifact", payload),
    );
  });
});

// ---------------------------------------------------------------------------
// Self-contained artifact literals (byte-equivalent to fixtures.ts defaults).
// ---------------------------------------------------------------------------

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-02T12:30:00.000Z";
const AB32: Hex = `0x${"ab".repeat(32)}`;
const TX32: Hex = `0x${"11".repeat(32)}`;
const TARGET20: Hex = `0x${"aa".repeat(20)}`;

const POLICY_CONTENT: Omit<EvidencePolicy, "digest"> = {
  id: "payment-basic",
  version: "1",
  requiredDimensions: ["execution", "observedEffects"],
  desiredDimensions: ["finality"],
};
const MANIFEST_CONTENT: Omit<ResolverManifest, "digest"> = {
  id: "resolver-evm",
  version: "0.1.0",
  networkFamilies: ["eip155"],
  implementation: { package: "@nec/resolver-evm" },
  supportedCapabilities: ["execution", "observedEffects"],
  sourceRequirements: [{ sourceType: "evm_rpc", required: true }],
};

const GOLDEN_EVIDENCE = [
  {
    id: "ev_receipt_1",
    sourceId: "src.rpc.primary",
    sourceType: "evm_rpc",
    retrievedAt: T0,
    contentDigest: `sha256:${"dd".repeat(32)}`,
    locator: "eth_getTransactionReceipt/0x11...",
    independenceGroup: "rpc-primary",
  },
];

function goldenSnapshotContent() {
  return {
    id: "snap_1",
    createdAt: T0,
    networkFingerprint: {
      networkId: "eip155:8453",
      chainId: 8453,
      observedAt: { blockNumber: 1000n, blockId: AB32 },
    },
    anchors: [
      {
        networkId: "eip155:8453",
        blockNumber: 1000n,
        blockId: AB32,
        timestamp: T0,
        role: "execution_observation",
      },
    ],
    evidence: GOLDEN_EVIDENCE.map((ref) => ({ ...ref })),
    resolverManifestDigest: MANIFEST_DIGEST,
    policyDigest: POLICY_DIGEST,
  };
}

import { computeEvidencePolicyDigest, computeResolverManifestDigest } from "../src/index.js";
import type { NetworkEvidenceResultContent } from "../src/index.js";
// Self-referential digests of the context artifacts (computed via the same
// public profile; stable across runs because inputs are pure literals above).
const POLICY_DIGEST = computeEvidencePolicyDigest(POLICY_CONTENT);
const MANIFEST_DIGEST = computeResolverManifestDigest(MANIFEST_CONTENT);

function goldenResultContent(): NetworkEvidenceResultContent {
  const snapshotDigest = buildEvidenceSnapshot(goldenSnapshotContent()).digest;
  return {
    schemaVersion: "0.1" as const,
    requestId: "req_1",
    generatedAt: T1,
    network: {
      networkId: "eip155:8453",
      chainId: 8453,
      observedAt: { blockNumber: 1000n, blockId: AB32 },
    },
    subject: { type: "transaction" as const, networkId: "eip155:8453", txId: TX32 },
    action: { kind: "erc20.transfer", target: TARGET20, value: "0" },
    policy: { id: POLICY_CONTENT.id, version: POLICY_CONTENT.version, digest: POLICY_DIGEST },
    snapshot: { id: "snap_1", digest: snapshotDigest },
    networkEvidence: {
      execution: {
        applicability: "applicable" as const,
        verdict: "supported" as const,
        basis: ["source_observation"],
        evidence: ["ev_receipt_1"],
      },
      observedEffects: [
        {
          id: "effect_1",
          type: "erc20.transfer",
          fields: { asset: "0xtoken", from: "0xa", to: "0xb", amount: "10000000" },
          basis: ["source_observation"],
          evidence: ["ev_receipt_1"],
        },
      ],
      dataBinding: { applicability: "not_applicable" as const, basis: [], evidence: [] },
      settlement: {
        applicability: "unknown" as const,
        basis: [],
        evidence: [],
        reason: "No network-specific finality resolver active.",
      },
      finality: { applicability: "unknown" as const, basis: [], evidence: [] },
    },
    evidence: GOLDEN_EVIDENCE.map((ref) => ({ ...ref })),
    conflicts: [] as never[],
    warnings: [] as never[],
    resolver: { id: MANIFEST_CONTENT.id, version: MANIFEST_CONTENT.version, digest: MANIFEST_DIGEST },
  };
}

// The bound EvidenceRequest of every golden result (matches
// fixtures.evidenceRequestContent(): requestId req_1, network eip155:8453,
// subject 0x11x32 transaction, expected ACTION, POLICY_CONTENT policy).
function goldenRequest() {
  return {
    schemaVersion: "0.1" as const,
    requestId: "req_1",
    networkId: "eip155:8453",
    subject: { type: "transaction" as const, networkId: "eip155:8453", txId: TX32 },
    action: { kind: "erc20.transfer", target: TARGET20, value: "0" },
    evidencePolicy: { ...POLICY_CONTENT, digest: POLICY_DIGEST },
  };
}

function goldenContext() {
  return {
    policy: { ...POLICY_CONTENT, digest: POLICY_DIGEST },
    snapshot: buildEvidenceSnapshot(goldenSnapshotContent()),
    resolver: { ...MANIFEST_CONTENT, digest: MANIFEST_DIGEST },
    request: goldenRequest(),
  };
}

describe("golden vectors: bound artifacts (regenerated at the v0.1 freeze point)", () => {
  it("pins BOTH result digests with their declared stability rules", () => {
    const built = buildNetworkEvidenceResult(goldenResultContent(), goldenContext());
    expect(built.semanticDigest).toBe(
      "sha256:ee7263927cf3470ecd524f6321287bd056b3f444e5285a5d355a07d8440bc1ef",
    );
    // Phase B regeneration: the bound EvidenceRequestRef now participates
    // in artifact integrity (see the header rationale above).
    expect(built.artifactDigest).toBe(
      "sha256:5569171adbbe7a31dd82c363134e21532e5ad0bd7b8f2cf80e97ad4a49f29f7d",
    );

    // Replay stability: neither emission time nor request id changes the
    // SEMANTIC identity...
    const replayed = buildNetworkEvidenceResult(
      { ...goldenResultContent(), generatedAt: "2030-06-01T00:00:00.000Z", requestId: "req_other" },
      {
        ...goldenContext(),
        request: {
          ...goldenRequest(),
          requestId: "req_other",
        },
      },
    );
    expect(replayed.semanticDigest).toBe(built.semanticDigest);
    // ...but both change the logical ARTIFACT integrity digest.
    expect(replayed.artifactDigest).not.toBe(built.artifactDigest);

    // Any semantic field changes both digests (the bound request moves with
    // the subject — continuity is enforced).
    const otherSubject = goldenResultContent();
    otherSubject.subject = { type: "transaction" as const, networkId: "eip155:8453", txId: `0x${"22".repeat(32)}` };
    const rebuilt = buildNetworkEvidenceResult(otherSubject, {
      ...goldenContext(),
      request: {
        ...goldenRequest(),
        subject: { type: "transaction" as const, networkId: "eip155:8453", txId: `0x${"22".repeat(32)}` },
      },
    });
    expect(rebuilt.semanticDigest).not.toBe(built.semanticDigest);
    expect(rebuilt.artifactDigest).not.toBe(built.artifactDigest);

    // R3: the expected ACTION is part of the semantic replay identity —
    // same subject/policy/evidence but a different action => different
    // semanticDigest (and a different artifactDigest via the bound request).
    const otherAction = goldenResultContent();
    otherAction.action = { kind: "erc20.approve", target: TARGET20, value: "5" };
    const reapproved = buildNetworkEvidenceResult(otherAction, {
      ...goldenContext(),
      request: {
        ...goldenRequest(),
        action: { kind: "erc20.approve", target: TARGET20, value: "5" },
      },
    });
    expect(reapproved.semanticDigest).not.toBe(built.semanticDigest);
    expect(reapproved.artifactDigest).not.toBe(built.artifactDigest);
  });

  it("pins the evidence-snapshot digest (createdAt included)", () => {
    const digest = buildEvidenceSnapshot(goldenSnapshotContent()).digest;
    expect(digest).toBe("sha256:69dbcf0a6138116d7924a955dafe6f4099c79e09ed1128c1792562d3413dfc27");

    const later = buildEvidenceSnapshot({
      ...goldenSnapshotContent(),
      createdAt: "2027-01-01T00:00:00.000Z",
    });
    expect(later.digest).not.toBe(digest);
  });

  it("pins the exact nec-wire-json-v1 encoding of the built result (INDEPENDENT literals)", () => {
    const built = buildNetworkEvidenceResult(goldenResultContent(), goldenContext());
    const wire = encodeNecWireJson("network-evidence-result", built);
    // Schema-declared integer quantities appear as QUOTED decimal strings;
    // keys are emitted in UTF-16 sorted order; output is byte-stable.
    expect(wire).toContain('"blockNumber":"1000"');
    // R3: the wire shape carries the complete expected ActionDescriptor.
    expect(wire).toContain('"action":{"kind":"erc20.transfer"');
    // INDEPENDENT LITERAL EXPECTATIONS (never copied from `built`): the
    // digests below were derived from the pure literal world above and are
    // pinned so a regression in any projection breaks THIS assertion, not
    // a tautology.
    expect(built.semanticDigest).toBe(
      "sha256:ee7263927cf3470ecd524f6321287bd056b3f444e5285a5d355a07d8440bc1ef",
    );
    expect(built.artifactDigest).toBe(
      "sha256:5569171adbbe7a31dd82c363134e21532e5ad0bd7b8f2cf80e97ad4a49f29f7d",
    );
    expect(built.snapshot.digest).toBe(
      "sha256:69dbcf0a6138116d7924a955dafe6f4099c79e09ed1128c1792562d3413dfc27",
    );
    expect(built.request.digest).toBe(
      "sha256:87663ee6ec3a50d859c08da2be28b4cc97b8fc6853f1f217a68176408ac0d70d",
    );
    expect(JSON.parse(wire)).toEqual({
      action: { fields: undefined, kind: "erc20.transfer", target: TARGET20, value: "0", },
      artifactDigest: "sha256:5569171adbbe7a31dd82c363134e21532e5ad0bd7b8f2cf80e97ad4a49f29f7d",
      conflicts: [],
      evidence: [
        {
          contentDigest: `sha256:${"dd".repeat(32)}`,
          id: "ev_receipt_1",
          independenceGroup: "rpc-primary",
          locator: "eth_getTransactionReceipt/0x11...",
          retrievedAt: T0,
          sourceId: "src.rpc.primary",
          sourceType: "evm_rpc",
        },
      ],
      generatedAt: T1,
      network: {
        chainId: 8453,
        networkId: "eip155:8453",
        observedAt: { blockId: AB32, blockNumber: "1000" },
      },
      networkEvidence: {
        dataBinding: { applicability: "not_applicable", basis: [], evidence: [] },
        execution: {
          applicability: "applicable",
          basis: ["source_observation"],
          evidence: ["ev_receipt_1"],
          verdict: "supported",
        },
        finality: { applicability: "unknown", basis: [], evidence: [] },
        observedEffects: [
          {
            basis: ["source_observation"],
            evidence: ["ev_receipt_1"],
            fields: { amount: "10000000", asset: "0xtoken", from: "0xa", to: "0xb" },
            id: "effect_1",
            type: "erc20.transfer",
          },
        ],
        settlement: {
          applicability: "unknown",
          basis: [],
          evidence: [],
          reason: "No network-specific finality resolver active.",
        },
      },
      policy: { digest: POLICY_DIGEST, id: "payment-basic", version: "1" },
      // Phase B wire shape: the digest-qualified bound-request reference
      // (pinned as an independent literal).
      request: {
        requestId: "req_1",
        digest: "sha256:87663ee6ec3a50d859c08da2be28b4cc97b8fc6853f1f217a68176408ac0d70d",
      },
      requestId: "req_1",
      resolver: { digest: MANIFEST_DIGEST, id: "resolver-evm", version: "0.1.0" },
      schemaVersion: "0.1",
      semanticDigest: "sha256:ee7263927cf3470ecd524f6321287bd056b3f444e5285a5d355a07d8440bc1ef",
      snapshot: {
        digest: "sha256:69dbcf0a6138116d7924a955dafe6f4099c79e09ed1128c1792562d3413dfc27",
        id: "snap_1",
      },
      subject: { networkId: "eip155:8453", txId: TX32, type: "transaction" },
      warnings: [],
    });
    // Byte-stable re-encoding.
    expect(encodeNecWireJson("network-evidence-result", built)).toBe(wire);
  });

  it("pins exact canonical bytes of a mixed-type structure", () => {
    const value = { k: [1n, "s", false], nested: { z: null, a: 1 } };
    const expectedText = '{"k":[1,"s",false],"nested":{"a":1,"z":null}}';
    expect(canonicalJson(value)).toBe(expectedText);
    expect(Array.from(canonicalJsonBytes(value)).map((b) => b.toString(16).padStart(2, "0")).join(""))
      .toBe(
        "7b226b223a5b312c2273222c66616c73655d2c226e6573746564223a7b2261223a312c227a223a6e756c6c7d7d",
      );
  });
});
