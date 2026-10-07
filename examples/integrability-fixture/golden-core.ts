import {
  buildEvidenceSnapshot,
  buildNetworkEvidenceResult,
  computeEvidencePolicyDigest,
  computeResolverManifestDigest,
  encodeNecWireJson,
} from "@nec/core";
import type {
  EvidencePolicy,
  Hex,
  NetworkEvidenceResult,
  NetworkEvidenceResultContent,
  ResolverManifest,
} from "@nec/core";

export const SYNTHETIC_SEMANTIC_DIGEST =
  "sha256:ee7263927cf3470ecd524f6321287bd056b3f444e5285a5d355a07d8440bc1ef";
export const SYNTHETIC_ARTIFACT_DIGEST =
  "sha256:5569171adbbe7a31dd82c363134e21532e5ad0bd7b8f2cf80e97ad4a49f29f7d";

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
const POLICY_DIGEST = computeEvidencePolicyDigest(POLICY_CONTENT);
const MANIFEST_DIGEST = computeResolverManifestDigest(MANIFEST_CONTENT);
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

function snapshotContent() {
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

function request() {
  return {
    schemaVersion: "0.1" as const,
    requestId: "req_1",
    networkId: "eip155:8453",
    subject: { type: "transaction" as const, networkId: "eip155:8453", txId: TX32 },
    action: { kind: "erc20.transfer", target: TARGET20, value: "0" },
    evidencePolicy: { ...POLICY_CONTENT, digest: POLICY_DIGEST },
  };
}

function resultContent(): NetworkEvidenceResultContent {
  const snapshot = buildEvidenceSnapshot(snapshotContent());
  return {
    schemaVersion: "0.1",
    requestId: "req_1",
    generatedAt: T1,
    network: {
      networkId: "eip155:8453",
      chainId: 8453,
      observedAt: { blockNumber: 1000n, blockId: AB32 },
    },
    subject: { type: "transaction", networkId: "eip155:8453", txId: TX32 },
    action: { kind: "erc20.transfer", target: TARGET20, value: "0" },
    policy: { id: POLICY_CONTENT.id, version: POLICY_CONTENT.version, digest: POLICY_DIGEST },
    snapshot: { id: snapshot.id, digest: snapshot.digest },
    networkEvidence: {
      execution: {
        applicability: "applicable",
        verdict: "supported",
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
      dataBinding: { applicability: "not_applicable", basis: [], evidence: [] },
      settlement: {
        applicability: "unknown",
        basis: [],
        evidence: [],
        reason: "No network-specific finality resolver active.",
      },
      finality: { applicability: "unknown", basis: [], evidence: [] },
    },
    evidence: GOLDEN_EVIDENCE.map((ref) => ({ ...ref })),
    conflicts: [],
    warnings: [],
    resolver: { id: MANIFEST_CONTENT.id, version: MANIFEST_CONTENT.version, digest: MANIFEST_DIGEST },
  };
}

export function buildSyntheticCoreResult(): NetworkEvidenceResult {
  const snapshot = buildEvidenceSnapshot(snapshotContent());
  const result = buildNetworkEvidenceResult(resultContent(), {
    policy: { ...POLICY_CONTENT, digest: POLICY_DIGEST },
    snapshot,
    resolver: { ...MANIFEST_CONTENT, digest: MANIFEST_DIGEST },
    request: request(),
  });
  if (result.semanticDigest !== SYNTHETIC_SEMANTIC_DIGEST || result.artifactDigest !== SYNTHETIC_ARTIFACT_DIGEST) {
    throw new Error("synthetic Core golden vector drifted from the reviewed v0.1 golden world");
  }
  return result;
}

export function buildSyntheticCoreWire(): string {
  return encodeNecWireJson("network-evidence-result", buildSyntheticCoreResult());
}
