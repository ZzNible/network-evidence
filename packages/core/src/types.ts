/**
 * NEC v0.1 public contracts (freeze point).
 *
 * Derived from `NEC_CONTRACTS_v0.1.md` with the adjudicated v0.1 freeze
 * decisions applied:
 *
 *   - Conflicts carry an EXPLICIT typed proposition scope
 *     (`PropositionScope`); EvidenceId overlap is provenance only.
 *   - `NetworkEvidenceResult` carries TWO digests: `semanticDigest`
 *     (stable semantic replay identity) and `artifactDigest` (logical
 *     artifact integrity).
 *   - Network-native identifiers are opaque bounded canonical strings
 *     (`NativeId`): core is network-family-neutral. EVM-specific hex-hash
 *     fields were renamed (txHash -> txId, blockHash -> blockId,
 *     genesisHash -> genesisId); their detailed format is validated by the
 *     resolver of the network family, never by core.
 *   - Source-native content travels as an explicit opaque
 *     `NativeSourcePayload` on `EvidenceRef`; NEC never interprets it.
 *
 * Do not rename or extend enum values without changing the contracts first.
 */

// ---------------------------------------------------------------------------
// Primitive aliases
// ---------------------------------------------------------------------------

/**
 * Generic byte-string primitive: lowercase hexadecimal with 0x prefix and an
 * even number of digits. NOT used for network-native identifiers — those are
 * `NativeId` and are validated by the owning resolver family.
 */
export type Hex = `0x${string}`;

/** Canonical UTC timestamp: exactly YYYY-MM-DDTHH:mm:ss.sssZ. */
export type Iso8601 = string;

/** NEC digest: "sha256:<64 lowercase hex chars>" under an explicit domain. */
export type Digest = string;

export type NetworkId = string;
export type SourceId = string;
export type EvidenceId = string;

/**
 * Opaque, bounded, canonical network-native identifier (transaction id,
 * block id, genesis id, account, target...). Core validates only that it is
 * a non-empty well-formed bounded string; the resolver for the network
 * family validates the detailed format (e.g. an EVM resolver may require
 * 0x + 32-byte lowercase hash; Bitcoin-like resolvers use other forms).
 */
export type NativeId = string;

// ---------------------------------------------------------------------------
// Core enums
// ---------------------------------------------------------------------------

export type Applicability = "applicable" | "not_applicable" | "unknown";

export type EvidenceVerdict = "supported" | "contradicted" | "insufficient" | "ambiguous";

export type EvidenceBasis =
  | "source_observation"
  | "deterministic_derivation"
  | "local_content_verification"
  | "local_consensus_engine"
  | "cryptographic_verification";

export type CapabilitySupport = "supported" | "conditional" | "unsupported" | "unknown";

export type CapabilityAvailability = "available" | "degraded" | "unavailable" | "unknown";

export type RequirementStrength = "required" | "desired";
export type DiscoveryClassification = "eligible" | "conditional" | "ineligible";
/**
 * FROZEN three-state v0.1 preflight outcome (R3): `partial` was removed —
 * an aggregate that is neither ready, nor blocked, nor fully undetermined
 * is `unknown` (NEC cannot derive readiness). Composition is normative:
 * see `composePreflightStatus`.
 */
export type PreflightStatus = "ready" | "blocked" | "unknown";

/**
 * CLOSED v0.1 capability vocabulary. It covers exactly the capability slots
 * represented by `CapabilitySnapshot`: the evidence capability family
 * (required slots of `EvidenceCapabilitySet`) and the execution capability
 * family (optional slots of `ExecutionCapabilitySet`). No other capability
 * string is accepted anywhere in v0.1 — unknown names fail closed, and no
 * generic custom-capability escape hatch exists (a namespaced extension
 * mechanism can only arrive with a versioned contract change).
 */
export type CapabilityName =
  | "execution"
  | "observedEffects"
  | "dataBinding"
  | "settlement"
  | "finality"
  | "executionModel"
  | "accountModel"
  | "gasModel"
  | "simulation"
  | "batching";

/**
 * CLOSED v0.1 evidence-policy dimension vocabulary. These are exactly the
 * dimensions NEC can preflight (evidenceReadiness) and resolve
 * (networkEvidence); unknown policy dimensions fail closed. No generic
 * custom dimensions exist in v0.1.
 */
export type PolicyDimension =
  | "execution"
  | "observedEffects"
  | "dataBinding"
  | "settlement"
  | "finality";

// ---------------------------------------------------------------------------
// Proposition scope (explicit semantic conflict scope)
// ---------------------------------------------------------------------------

/** The four fixed evidence dimensions of a NetworkEvidenceResult. */
export type EvidenceDimensionName = "execution" | "dataBinding" | "settlement" | "finality";

/**
 * Explicit semantic proposition scope. A Conflict MUST carry a non-empty
 * scope; composition inputs identify the proposition they evaluate.
 * EvidenceIds NEVER define scope — they remain provenance only.
 */
export type PropositionScope =
  | { kind: "result" }
  | { kind: "dimension"; dimension: EvidenceDimensionName }
  | { kind: "observed_effect"; effectId: string }
  | { kind: "custom"; namespace: string; id: string };

// ---------------------------------------------------------------------------
// Native source payload (opaque source-native content boundary)
// ---------------------------------------------------------------------------

/**
 * Opaque source-native content attached to an `EvidenceRef`. The payload is
 * exact bytes, base64-encoded; its `contentDigest` binds the DECODED bytes.
 * NEC never parses or interprets the inner semantic fields — vendor terms
 * such as "confidence" inside native bytes are inert data, never NEC scores.
 */
export interface NativeSourcePayload {
  namespace: string;
  mediaType: string;
  encoding: "base64";
  payload: string;
  contentDigest: Digest;
  schema?: string;
}

// ---------------------------------------------------------------------------
// Network fingerprint
// ---------------------------------------------------------------------------

export interface NetworkAnchor {
  blockNumber?: bigint;
  blockId?: NativeId;
  timestamp?: Iso8601;
}

export interface NetworkFingerprint {
  networkId: NetworkId;
  chainId?: number;
  genesisId?: NativeId;
  protocolVersion?: string;
  deploymentDigest?: Digest;
  observedAt: NetworkAnchor;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Evidence references
// ---------------------------------------------------------------------------

export interface EvidenceRef {
  id: EvidenceId;
  sourceId: SourceId;
  sourceType: string;
  independenceGroup?: string;
  locator?: string;
  retrievedAt: Iso8601;
  contentDigest?: Digest;
  networkId?: NetworkId;
  blockNumber?: bigint;
  blockId?: NativeId;
  metadata?: Record<string, unknown>;
  nativeSource?: NativeSourcePayload;
}

// ---------------------------------------------------------------------------
// Evidence dimension
// ---------------------------------------------------------------------------

export interface EvidenceDimension {
  applicability: Applicability;
  verdict?: EvidenceVerdict;
  basis: EvidenceBasis[];
  evidence: EvidenceId[];
  reason?: string;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Observed effect
// ---------------------------------------------------------------------------

export interface ObservedEffect {
  id: string;
  type: string;
  fields: Record<string, unknown>;
  basis: EvidenceBasis[];
  evidence: EvidenceId[];
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Subject reference
// ---------------------------------------------------------------------------

export type SubjectRef =
  | {
      type: "transaction";
      networkId: NetworkId;
      txId: NativeId;
    }
  | {
      type: "block";
      networkId: NetworkId;
      blockNumber?: bigint;
      blockId?: NativeId;
    }
  | {
      type: "batch";
      networkId: NetworkId;
      batchId: string;
    }
  | {
      type: "custom";
      networkId: NetworkId;
      namespace: string;
      value: string;
    };

// ---------------------------------------------------------------------------
// Resolver manifest
// ---------------------------------------------------------------------------

export interface ResolverManifestRef {
  id: string;
  version: string;
  digest: Digest;
}

export interface ResolverManifest extends ResolverManifestRef {
  networkFamilies: string[];
  implementation: {
    package?: string;
    commit?: string;
  };
  /** CLOSED v0.1 vocabulary (`CapabilityName`); unknown names fail closed. */
  supportedCapabilities: CapabilityName[];
  sourceRequirements: Array<{
    sourceType: string;
    required: boolean;
  }>;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

export interface CapabilityState {
  support: CapabilitySupport;
  availability: CapabilityAvailability;
  reason?: string;
  evidence?: EvidenceId[];
  metadata?: Record<string, unknown>;
}

export interface EvidenceCapabilitySet {
  execution: CapabilityState;
  observedEffects: CapabilityState;
  dataBinding: CapabilityState;
  settlement: CapabilityState;
  finality: CapabilityState;
}

export interface ExecutionCapabilitySet {
  executionModel?: CapabilityState;
  accountModel?: CapabilityState;
  gasModel?: CapabilityState;
  simulation?: CapabilityState;
  batching?: CapabilityState;
}

/** Digest-qualified reference to a CapabilitySnapshot artifact. */
export interface CapabilitySnapshotRef {
  id: string;
  digest: Digest;
}

export interface CapabilitySnapshot {
  schemaVersion: "0.1";
  id: string;
  generatedAt: Iso8601;
  network: NetworkFingerprint;
  evidenceCapabilities: EvidenceCapabilitySet;
  executionCapabilities: ExecutionCapabilitySet;
  evidence: EvidenceRef[];
  resolver: ResolverManifestRef;
  /** Logical artifact integrity digest (binds every field except itself). */
  artifactDigest: Digest;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export interface CapabilityRequirement {
  /** CLOSED v0.1 vocabulary (`CapabilityName`); unknown names fail closed. */
  capability: CapabilityName;
  strength: RequirementStrength;
  /**
   * R3: `constraints` is NOT supported in v0.1 and was REMOVED from the
   * contract. NEC has no constraint-matching engine; accepting a field it
   * cannot evaluate would invite unexamined semantics. Unknown fields fail
   * closed through exact-schema validation. A future version may add typed
   * constraints with explicit evaluators.
   */
}

export interface DiscoveryRequirements {
  requirements: CapabilityRequirement[];
  networkAllowlist?: NetworkId[];
  networkDenylist?: NetworkId[];
  metadata?: Record<string, unknown>;
}

export interface RequirementEvaluation {
  requirement: CapabilityRequirement;
  status: "satisfied" | "unsatisfied" | "unknown";
  reason?: string;
  evidence?: EvidenceId[];
}

export interface NetworkDiscoveryMatch {
  network: NetworkFingerprint;
  classification: DiscoveryClassification;
  evaluations: RequirementEvaluation[];
  /** Digest-qualified snapshot reference — never a bare id. */
  capabilitySnapshot: CapabilitySnapshotRef;
  /** Evidence table backing the evaluations; citations resolve here. */
  evidence: EvidenceRef[];
}

export interface DiscoverNetworksResult {
  schemaVersion: "0.1";
  requestId: string;
  generatedAt: Iso8601;
  /** The discovery request this result answers (bound by artifactDigest). */
  request: DiscoveryRequirements;
  matches: NetworkDiscoveryMatch[];
  artifactDigest: Digest;
}

// ---------------------------------------------------------------------------
// Evidence policy
// ---------------------------------------------------------------------------

export interface EvidencePolicy {
  id: string;
  version: string;
  /** CLOSED v0.1 vocabulary (`PolicyDimension`); unknown dimensions fail closed. */
  requiredDimensions: PolicyDimension[];
  desiredDimensions?: PolicyDimension[];
  rules?: Record<string, unknown>;
  digest: Digest;
}

export interface EvidencePolicyRef {
  id: string;
  version: string;
  digest: Digest;
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

export interface ActionDescriptor {
  kind: string;
  target?: NativeId;
  value?: string;
  fields?: Record<string, unknown>;
}

export interface PreflightRequest {
  schemaVersion: "0.1";
  /**
   * THE preflight-request identity (NEC identifier grammar). It is the ONLY
   * request identity: `PreflightResult` embeds the complete request and
   * carries no independent top-level id. Two results for the same request
   * share `requestId` and differ by `artifactDigest` because observation,
   * capability context and time differ.
   */
  requestId: string;
  networkId: NetworkId;
  account?: NativeId;
  action: ActionDescriptor;
  evidencePolicy: EvidencePolicy;
  metadata?: Record<string, unknown>;
}

export interface ReadinessCheck {
  status: "ready" | "blocked" | "unknown" | "not_applicable";
  reason?: string;
  evidence?: EvidenceId[];
  metadata?: Record<string, unknown>;
}

export interface PreflightBlocker {
  code: string;
  reason: string;
}

/**
 * Digest-qualified reference to a PreflightResult artifact. The reference is
 * the preflight REQUEST id (i.e. `result.request.requestId` — there is no
 * independent result identity) plus the artifact digest of the exact result:
 * two preflights for the same request share `requestId` and are
 * unambiguously distinguished by `digest` (= the result's
 * `artifactDigest`). There is deliberately no independent result `id`.
 */
export interface PreflightResultRef {
  requestId: string;
  digest: Digest;
}

export interface PreflightResult {
  schemaVersion: "0.1";
  generatedAt: Iso8601;
  /** Normative composer output — never caller-authored (recomputed). */
  status: PreflightStatus;
  network: NetworkFingerprint;
  /**
   * The COMPLETE original preflight request. Its `requestId` is the
   * preflight identity; `PreflightResultRef = {requestId:
   * request.requestId, digest: artifactDigest}`.
   */
  request: PreflightRequest;

  /**
   * Per-policy-dimension EVIDENCE readiness. Generic preflight means exactly:
   * "Can NEC obtain the evidence REQUIRED by this EvidencePolicy for THIS
   * action on THIS network under the supplied capability/resolver context?"
   * NEC does NOT own wallet/account readiness, funding, gas acquisition,
   * signing, submission or generic execution simulation — those concepts are
   * deliberately absent from v0.1 (R3).
   */
  evidenceReadiness: {
    execution: ReadinessCheck;
    observedEffects: ReadinessCheck;
    dataBinding: ReadinessCheck;
    settlement: ReadinessCheck;
    finality: ReadinessCheck;
  };

  blockers: PreflightBlocker[];

  warnings: Warning[];
  /** Evidence table; every readiness-cited EvidenceId resolves here. */
  evidence: EvidenceRef[];
  evidencePolicy: EvidencePolicyRef;
  resolver: ResolverManifestRef;
  capabilitySnapshot?: CapabilitySnapshotRef;
  artifactDigest: Digest;
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export interface EvidenceAnchor {
  networkId: NetworkId;
  blockNumber?: bigint;
  blockId?: NativeId;
  timestamp?: Iso8601;
  role?: string;
}

export interface EvidenceSnapshotRef {
  id: string;
  digest: Digest;
}

export interface EvidenceSnapshot extends EvidenceSnapshotRef {
  createdAt: Iso8601;
  networkFingerprint: NetworkFingerprint;
  anchors: EvidenceAnchor[];
  evidence: EvidenceRef[];
  resolverManifestDigest: Digest;
  policyDigest: Digest;
}

// ---------------------------------------------------------------------------
// Conflicts / warnings
// ---------------------------------------------------------------------------

export interface Conflict {
  id: string;
  code: string;
  description: string;
  /** Explicit non-empty semantic scope. Never inferred from EvidenceIds. */
  scope: PropositionScope;
  evidence: EvidenceId[];
  material: boolean;
  metadata?: Record<string, unknown>;
}

export interface Warning {
  code: string;
  message: string;
  evidence?: EvidenceId[];
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Network evidence result
// ---------------------------------------------------------------------------

export interface NetworkEvidenceResult {
  schemaVersion: "0.1";
  requestId: string;
  generatedAt: Iso8601;
  /**
   * Digest-qualified binding to the complete EvidenceRequest this result
   * answers (`{requestId, computeEvidenceRequestDigest(request)}`). The
   * embedded `requestId` MUST equal the top-level `requestId`; the digest
   * makes request substitution (action/policy/network swapping after a
   * successful preflight) detectable and rejectable.
   */
  request: EvidenceRequestRef;
  /**
   * The COMPLETE expected ActionDescriptor this result answers (semantic
   * field, R3). It is bound into `semanticDigest`: same subject/policy/
   * evidence but a different expected action => different semanticDigest.
   * Continuity of the expected action is NOT proof that an external
   * execution produced the subject — that causality question belongs to a
   * resolver/protocol adapter comparing observed effects.
   */
  action: ActionDescriptor;
  network: NetworkFingerprint;
  subject: SubjectRef;
  policy: EvidencePolicyRef;
  snapshot: EvidenceSnapshotRef;

  networkEvidence: {
    execution: EvidenceDimension;
    observedEffects: ObservedEffect[];
    dataBinding: EvidenceDimension;
    settlement: EvidenceDimension;
    finality: EvidenceDimension;
  };

  evidence: EvidenceRef[];
  conflicts: Conflict[];
  warnings: Warning[];
  resolver: ResolverManifestRef;
  /**
   * Stable semantic replay identity: excludes requestId, generatedAt and
   * both digests; BINDS the expected `action` (R3). Equal semantics =>
   * equal semanticDigest.
   */
  semanticDigest: Digest;
  /**
   * Logical artifact integrity: binds every logical field except itself
   * (including requestId, generatedAt and semanticDigest).
   */
  artifactDigest: Digest;
}

// ---------------------------------------------------------------------------
// Resolve request
// ---------------------------------------------------------------------------

/**
 * Digest-qualified reference to an EvidenceRequest. `digest` is
 * `computeEvidenceRequestDigest(request)` — it binds the COMPLETE normalized
 * request (network, subject, policy, preflight reference, metadata). The
 * request itself never carries a self-referential digest field.
 */
export interface EvidenceRequestRef {
  requestId: string;
  digest: Digest;
}

export interface EvidenceRequest {
  schemaVersion: "0.1";
  /** Stable caller/resolver-assigned request id (NEC identifier grammar). */
  requestId: string;
  networkId: NetworkId;
  subject: SubjectRef;
  /**
   * The COMPLETE expected ActionDescriptor (R3 action continuity). When a
   * preflight is referenced, this MUST be canonically equal to
   * `preflight.request.action` — the request binds continuity of the
   * EXPECTED ACTION (it does not by itself prove that an external execution
   * produced the subject).
   */
  action: ActionDescriptor;
  evidencePolicy: EvidencePolicy;
  /** Digest-qualified reference to the preflight result, when one exists. */
  preflight?: PreflightResultRef;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Resolver plugin
// ---------------------------------------------------------------------------

/**
 * Context handed to resolver plugin methods. It carries ONLY evaluation
 * inputs: an explicit evaluation time and controlled source configuration.
 * Private keys, signing material, wallets and execution authority are
 * structurally excluded from NEC by contract — they can never enter through
 * `ResolverContext` (or anywhere else in core).
 */
export interface ResolverContext {
  now: Iso8601;
  sourceConfig: Record<string, unknown>;
}

export interface PreflightFragment {
  network: NetworkFingerprint;
  /** Per-policy-dimension evidence readiness (partial table). */
  evidenceReadiness: Partial<PreflightResult["evidenceReadiness"]>;
  evidence: EvidenceRef[];
  blockers: PreflightBlocker[];
  warnings: Warning[];
}

export interface NetworkEvidenceFragment {
  network: NetworkFingerprint;
  subject: SubjectRef;
  networkEvidence: Partial<NetworkEvidenceResult["networkEvidence"]>;
  evidence: EvidenceRef[];
  conflicts: Conflict[];
  warnings: Warning[];
}

export interface NetworkResolver {
  manifest(): ResolverManifest;

  /**
   * Probe the capabilities of ONE explicitly named target network. The
   * target is a first-class argument — never hidden inside
   * `context.sourceConfig`. The returned snapshot MUST satisfy
   * `snapshot.network.networkId === networkId`; builders/verifiers reject
   * any snapshot whose network differs from the requested target.
   */
  probeCapabilities(
    networkId: NetworkId,
    context: ResolverContext,
  ): Promise<CapabilitySnapshot>;

  preflight(request: PreflightRequest, context: ResolverContext): Promise<PreflightFragment>;

  resolve(request: EvidenceRequest, context: ResolverContext): Promise<NetworkEvidenceFragment>;
}
