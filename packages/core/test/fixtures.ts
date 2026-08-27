import {
  buildCapabilitySnapshot,
  buildEvidenceSnapshot,
  computeEvidencePolicyDigest,
  computeResolverManifestDigest,
} from "../src/index.js";
import type {
  CapabilityState,
  CapabilitySnapshot,
  Conflict,
  DiscoveryRequirements,
  EvidenceAnchor,
  EvidenceDimension,
  EvidencePolicy,
  EvidenceRef,
  EvidenceRequest,
  EvidenceSnapshot,
  NetworkDiscoveryMatch,
  NetworkEvidenceResult,
  NetworkFingerprint,
  ObservedEffect,
  PreflightBlocker,
  PreflightRequest,
  PreflightResult,
  ReadinessCheck,
  RequirementEvaluation,
  ResolverManifest,
  SubjectRef,
  Warning,
} from "../src/index.js";

export const T0 = "2026-01-01T00:00:00.000Z";
export const T1 = "2026-01-02T12:30:00.000Z";

export const NETWORK = "eip155:8453";
export const CROSS_NETWORK = "eip155:42161";

// ---------------------------------------------------------------------------
// Core shapes
// ---------------------------------------------------------------------------

export function fingerprint(overrides: Partial<NetworkFingerprint> = {}): NetworkFingerprint {
  return {
    networkId: NETWORK,
    chainId: 8453,
    observedAt: { blockNumber: 1000n, blockId: `0x${"ab".repeat(32)}` },
    ...overrides,
  };
}

export function subject(overrides: Partial<Extract<SubjectRef, { type: "transaction" }>> = {}): SubjectRef {
  return {
    type: "transaction",
    networkId: NETWORK,
    txId: `0x${"11".repeat(32)}`,
    ...overrides,
  };
}

export function evidenceRef(overrides: Partial<EvidenceRef> & { id?: string } = {}): EvidenceRef {
  return {
    id: "ev_receipt_1",
    sourceId: "src.rpc.primary",
    sourceType: "evm_rpc",
    retrievedAt: T0,
    contentDigest: `sha256:${"dd".repeat(32)}`,
    locator: "eth_getTransactionReceipt/0x11...",
    independenceGroup: "rpc-primary",
    ...overrides,
  };
}

export function dimension(overrides: Partial<EvidenceDimension> = {}): EvidenceDimension {
  return { applicability: "unknown", basis: [], evidence: [], ...overrides };
}

export function effect(overrides: Partial<ObservedEffect> = {}): ObservedEffect {
  return {
    id: "effect_1",
    type: "erc20.transfer",
    fields: { asset: "0xtoken", from: "0xa", to: "0xb", amount: "10000000" },
    basis: ["source_observation"],
    evidence: ["ev_receipt_1"],
    ...overrides,
  };
}

/** Default scope: the execution-dimension proposition. */
export function conflict(overrides: Partial<Conflict> = {}): Conflict {
  return {
    id: "conflict_1",
    code: "BLOCK_HASH_DISAGREEMENT",
    description: "Independent observations disagree on block hash.",
    scope: { kind: "dimension", dimension: "execution" },
    evidence: [],
    material: false,
    ...overrides,
  };
}

export function warn(overrides: Partial<Warning> = {}): Warning {
  return { code: "TEST_WARNING", message: "test warning", ...overrides };
}

export function blocker(overrides: Partial<PreflightBlocker> = {}): PreflightBlocker {
  return { code: "GAS_UNAVAILABLE", reason: "no gas estimation source available", ...overrides };
}

export function readiness(status: ReadinessCheck["status"], overrides: Partial<ReadinessCheck> = {}): ReadinessCheck {
  return { status, ...overrides };
}

// ---------------------------------------------------------------------------
// Coherent cross-artifact world (policy / manifest / snapshot)
// ---------------------------------------------------------------------------

export function policyContent(): Omit<EvidencePolicy, "digest"> {
  return {
    id: "payment-basic",
    version: "1",
    requiredDimensions: ["execution", "observedEffects"],
    desiredDimensions: ["finality"],
  };
}

export function fullPolicy(): EvidencePolicy {
  return { ...policyContent(), digest: computeEvidencePolicyDigest(policyContent()) };
}

export function manifestContent(): Omit<ResolverManifest, "digest"> {
  return {
    id: "resolver-evm",
    version: "0.1.0",
    networkFamilies: ["eip155"],
    implementation: { package: "@nec/resolver-evm" },
    // R3: must cover every supported/conditional claim of the fixture
    // capability snapshot (manifest-authority invariant).
    supportedCapabilities: ["execution", "observedEffects", "dataBinding", "executionModel"],
    sourceRequirements: [{ sourceType: "evm_rpc", required: true }],
  };
}

export function fullManifest(): ResolverManifest {
  return { ...manifestContent(), digest: computeResolverManifestDigest(manifestContent()) };
}

export function baseAnchors(): EvidenceAnchor[] {
  return [
    {
      networkId: NETWORK,
      blockNumber: 1000n,
      blockId: `0x${"ab".repeat(32)}`,
      timestamp: T0,
      role: "execution_observation",
    },
  ];
}

export function snapshotContent(extraAnchors: EvidenceAnchor[] = []): Omit<EvidenceSnapshot, "digest"> {
  return {
    id: "snap_1",
    createdAt: T0,
    networkFingerprint: fingerprint(),
    anchors: [...baseAnchors(), ...extraAnchors],
    evidence: [evidenceRef()],
    resolverManifestDigest: fullManifest().digest,
    policyDigest: fullPolicy().digest,
  };
}

/** Fully coherent snapshot whose digest fields bind the real policy/manifest. */
export function fullSnapshot(extraAnchors: EvidenceAnchor[] = []): EvidenceSnapshot {
  return buildEvidenceSnapshot(snapshotContent(extraAnchors));
}

// ---------------------------------------------------------------------------
// NetworkEvidenceResult content (coherent against the world above)
// ---------------------------------------------------------------------------

export function validResultContent(): NetworkEvidenceResultContentAlias {
  const snapshot = fullSnapshot();
  return {
    schemaVersion: "0.1",
    requestId: "req_1",
    generatedAt: T1,
    network: fingerprint(),
    subject: subject(),
    action: { kind: "erc20.transfer", target: `0x${"aa".repeat(20)}`, value: "0" },
    policy: { id: fullPolicy().id, version: fullPolicy().version, digest: fullPolicy().digest },
    snapshot: { id: snapshot.id, digest: snapshot.digest },
    networkEvidence: {
      execution: dimension({
        applicability: "applicable",
        verdict: "supported",
        basis: ["source_observation"],
        evidence: ["ev_receipt_1"],
      }),
      observedEffects: [effect()],
      dataBinding: dimension({ applicability: "not_applicable", basis: [], evidence: [] }),
      settlement: dimension({ applicability: "unknown", basis: [], evidence: [] }),
      finality: dimension({
        applicability: "unknown",
        basis: [],
        evidence: [],
        reason: "No network-specific finality resolver active.",
      }),
    },
    evidence: [evidenceRef()],
    conflicts: [],
    warnings: [],
    resolver: {
      id: fullManifest().id,
      version: fullManifest().version,
      digest: fullManifest().digest,
    },
  };
}

export type NetworkEvidenceResultContentAlias = Omit<
  NetworkEvidenceResult,
  "semanticDigest" | "artifactDigest" | "request"
>;

// ---------------------------------------------------------------------------
// EvidenceRequest (the resolve-surface request bound by every result)
// ---------------------------------------------------------------------------

/** The default expected action shared by requests, preflights and results. */
export function defaultAction(): { kind: string; target: string; value: string } {
  return { kind: "erc20.transfer", target: `0x${"aa".repeat(20)}`, value: "0" };
}

export function evidenceRequestContent(
  overrides: Partial<EvidenceRequest> = {},
): EvidenceRequest {
  return {
    schemaVersion: "0.1",
    requestId: "req_1",
    networkId: NETWORK,
    subject: subject(),
    action: defaultAction(),
    evidencePolicy: fullPolicy(),
    ...overrides,
  };
}

export function resultContext() {
  return {
    policy: fullPolicy(),
    snapshot: fullSnapshot(),
    resolver: fullManifest(),
    request: evidenceRequestContent(),
  };
}

// ---------------------------------------------------------------------------
// Capability snapshot / discovery / preflight contents
// ---------------------------------------------------------------------------

function cap(support: CapabilityState["support"], availability: CapabilityState["availability"]): CapabilityState {
  return { support, availability };
}

export function validCapabilitySnapshotContent(
  overrides: Partial<Omit<import("../src/index.js").CapabilitySnapshot, "artifactDigest">> = {},
): import("../src/index.js").CapabilitySnapshotContent {
  return {
    schemaVersion: "0.1",
    id: "capsnap_1",
    generatedAt: T0,
    network: fingerprint(),
    evidenceCapabilities: {
      execution: cap("supported", "available"),
      observedEffects: cap("supported", "available"),
      dataBinding: cap("conditional", "available"),
      settlement: cap("unsupported", "unavailable"),
      finality: cap("unknown", "unknown"),
    },
    executionCapabilities: {
      executionModel: { support: "supported", availability: "available", evidence: ["ev_receipt_1"] },
    },
    evidence: [evidenceRef()],
    resolver: { id: fullManifest().id, version: fullManifest().version, digest: fullManifest().digest },
    ...overrides,
  };
}

export function discoveryRequirements(overrides: Partial<DiscoveryRequirements> = {}): DiscoveryRequirements {
  return {
    requirements: [{ capability: "execution", strength: "required" }],
    ...overrides,
  };
}

export function evaluation(overrides: Partial<RequirementEvaluation> = {}): RequirementEvaluation {
  return {
    requirement: { capability: "execution", strength: "required" },
    status: "satisfied",
    evidence: ["ev_receipt_1"],
    // Deterministic composer reason for `satisfied` (R3: contextual
    // discovery verification compares reasons exactly).
    reason: "capability is usable",
    ...overrides,
  };
}

export function discoveryMatch(overrides: Partial<NetworkDiscoveryMatch> = {}): NetworkDiscoveryMatch {
  return {
    network: fingerprint(),
    classification: "eligible",
    evaluations: [evaluation()],
    capabilitySnapshot: { id: "capsnap_1", digest: `sha256:${"cc".repeat(32)}` },
    evidence: [evidenceRef()],
    ...overrides,
  };
}

export function preflightRequestContent(
  overrides: Partial<Omit<PreflightRequest, "schemaVersion" | "networkId" | "action" | "evidencePolicy">> = {},
): PreflightRequest {
  return {
    schemaVersion: "0.1",
    // THE preflight-request identity (R3): lives on the REQUEST; the result
    // embeds the complete request and carries no independent id.
    requestId: "pf_req_1",
    networkId: NETWORK,
    action: defaultAction(),
    evidencePolicy: fullPolicy(),
    ...overrides,
  };
}

export function validPreflightResultContent(
  overrides: Partial<Omit<PreflightResult, "artifactDigest" | "status">> = {},
): Omit<PreflightResult, "artifactDigest" | "status"> {
  const request = preflightRequestContent();
  // R3 section 8: the capability snapshot fingerprint used to derive
  // readiness is stored/referenced unambiguously and verified as the exact
  // context used.
  const derivationSnapshot = preflightCapabilitySnapshot();
  return {
    capabilitySnapshot: { id: derivationSnapshot.id, digest: derivationSnapshot.artifactDigest },
    schemaVersion: "0.1",
    generatedAt: T1,
    network: fingerprint(),
    request,
    evidenceReadiness: {
      execution: readiness("ready", { evidence: ["ev_receipt_1"] }),
      // The default policy REQUIRES observedEffects; a required dimension
      // must be "ready" (never not_applicable) for an overall ready status.
      // FREEZE-FINAL provenance binding: ready citations are a NON-EMPTY
      // SUBSET of the justifying CapabilityState evidence.
      observedEffects: readiness("ready", { evidence: ["ev_receipt_1"] }),
      dataBinding: readiness("not_applicable"),
      settlement: readiness("not_applicable"),
      finality: readiness("not_applicable"),
    },
    blockers: [],
    warnings: [],
    evidence: [evidenceRef()],
    evidencePolicy: { id: request.evidencePolicy.id, version: request.evidencePolicy.version, digest: request.evidencePolicy.digest },
    resolver: { id: fullManifest().id, version: fullManifest().version, digest: fullManifest().digest },
    ...overrides,
  };
}

/**
 * R3: a `ready` readiness check must be DERIVABLE from the supplied
 * capability context. This snapshot makes exactly the default policy's
 * REQUIRED dimensions (execution, observedEffects) derivably usable; the
 * remaining dimensions are deterministically negative or unknown.
 */
export function preflightCapabilitySnapshot(): CapabilitySnapshot {
  return buildCapabilitySnapshot(
    {
      ...validCapabilitySnapshotContent(),
      evidenceCapabilities: {
        execution: { support: "supported", availability: "available", evidence: ["ev_receipt_1"] },
        observedEffects: { support: "supported", availability: "available", evidence: ["ev_receipt_1"] },
        dataBinding: { support: "unsupported", availability: "unavailable" },
        settlement: { support: "unsupported", availability: "unavailable" },
        finality: { support: "unknown", availability: "unknown" },
      },
      executionCapabilities: {},
      id: "capsnap_pf",
    },
    { resolver: fullManifest(), networkId: NETWORK },
  );
}

/** Complete preflight claim-verification context for the default fixture. */
export function preflightContext(): {
  resolver: ResolverManifest;
  capabilitySnapshot: CapabilitySnapshot;
} {
  return { resolver: fullManifest(), capabilitySnapshot: preflightCapabilitySnapshot() };
}
