import { DIGEST_DOMAINS, digestCanonicalJson } from "./digest.js";
import { sortedByCanonical, sortedById, sortedByKey, sortedStrings } from "./ordering.js";
import type {
  CapabilitySnapshot,
  Conflict,
  DiscoverNetworksResult,
  EvidenceDimension,
  EvidencePolicy,
  EvidenceRef,
  EvidenceRequest,
  EvidenceSnapshot,
  NetworkEvidenceResult,
  ObservedEffect,
  PreflightResult,
  ResolverManifest,
  Warning,
} from "./types.js";

/**
 * Digest computation for every self-digesting NEC artifact
 * (`nec-digest-v1`, domain-separated).
 *
 * All computations run over a CANONICAL PROJECTION of the artifact:
 * set-like collections are placed in their declared canonical order first,
 * so arbitrary caller ordering never changes a digest. Validation rejects
 * duplicates; nothing is silently discarded here.
 *
 * NORMALIZATION ORDER (normative): for every set-like nested collection the
 * CHILDREN are normalized first (their own citation arrays sorted), THEN
 * the outer collection derives its deterministic identity/order and is
 * sorted, then the digest is taken. Sorting raw forms first would let an
 * inner permutation flip the outer comparison order.
 *
 * Self-digest fields are excluded from their own preimage by construction.
 * For `NetworkEvidenceResult` the two digests are:
 *
 *   - semanticDigest: stable semantic replay identity. Binds schemaVersion,
 *     network, subject, the COMPLETE expected `action`, policy ref,
 *     snapshot ref, dimensions, observed effects, evidence, conflicts,
 *     warnings and resolver ref. EXCLUDES requestId, the bound request
 *     reference, generatedAt and both digests.
 *   - artifactDigest: logical artifact integrity. Binds EVERY logical field
 *     except itself — including requestId, the bound request reference
 *     (EvidenceRequestRef), generatedAt and semanticDigest.
 *
 * Builder-input types (`*Content`) are CALLER/BUILD inputs: they exclude
 * every builder-DERIVED field. `PreflightResultContent` therefore excludes
 * BOTH `status` (recomputed by the normative composer) and `artifactDigest`
 * — the built `PreflightResult` artifact carries the derived values.
 */

export type NetworkEvidenceResultContent = Omit<
  NetworkEvidenceResult,
  "semanticDigest" | "artifactDigest" | "request"
>;

type AnyRecord = Record<string, unknown>;

function strip<T>(value: T, ...keys: readonly string[]): AnyRecord {
  const copy: AnyRecord = {};
  for (const [key, val] of Object.entries(value as AnyRecord)) {
    if (!keys.includes(key)) copy[key] = val;
  }
  return copy;
}

function normalizeDimension(dim: EvidenceDimension): AnyRecord {
  return { ...dim, basis: sortedStrings(dim.basis), evidence: sortedStrings(dim.evidence) };
}

function normalizeEffect(effect: ObservedEffect): AnyRecord {
  return { ...effect, basis: sortedStrings(effect.basis), evidence: sortedStrings(effect.evidence) };
}

function normalizeConflict(conflict: Conflict): AnyRecord {
  return { ...conflict, evidence: sortedStrings(conflict.evidence) };
}

function normalizeWarning(warning: Warning): AnyRecord {
  return warning.evidence === undefined
    ? { ...warning }
    : { ...warning, evidence: sortedStrings(warning.evidence) };
}

/** Normalized requirement evaluation (citation citations sorted) for ordering/identity. */
function normalizeEvaluation(evaluation: {
  requirement: unknown;
  status: string;
  reason?: string;
  evidence?: string[];
}): AnyRecord {
  return evaluation.evidence === undefined
    ? { ...evaluation }
    : { ...evaluation, evidence: sortedStrings(evaluation.evidence) };
}

/**
 * Identity projection of a RequirementEvaluation (evidence citations
 * sorted); used for duplicate detection over set-like evaluations.
 */
export function normalizedEvaluationIdentity(evaluation: unknown): AnyRecord {
  return normalizeEvaluation(evaluation as Parameters<typeof normalizeEvaluation>[0]);
}

// ---------------------------------------------------------------------------
// EvidenceRequest (bound-request identity; no self-referential digest field)
// ---------------------------------------------------------------------------

/**
 * Digest of the COMPLETE normalized EvidenceRequest under the dedicated
 * `evidence-request` domain. This is the `digest` half of every
 * `EvidenceRequestRef`. Set-like policy dimension lists are normalized
 * (sorted) first, so a dimension permutation of the same policy cannot
 * change the request identity; everything else binds exactly (network,
 * subject, embedded policy content incl. its own digest, preflight
 * reference, metadata).
 */
export function computeEvidenceRequestDigest(request: EvidenceRequest): string {
  const content: AnyRecord = { ...request } as AnyRecord;
  const requestPolicy = request.evidencePolicy;
  content.evidencePolicy = {
    ...requestPolicy,
    requiredDimensions: sortedStrings(requestPolicy.requiredDimensions),
    ...(requestPolicy.desiredDimensions === undefined
      ? {}
      : { desiredDimensions: sortedStrings(requestPolicy.desiredDimensions) }),
  };
  return digestCanonicalJson(DIGEST_DOMAINS.evidenceRequest, content);
}

/** Digest-qualified reference of an EvidenceRequest (computed, never stored). */
export function evidenceRequestRef(request: EvidenceRequest): {
  requestId: string;
  digest: string;
} {
  return { requestId: request.requestId, digest: computeEvidenceRequestDigest(request) };
}

// ---------------------------------------------------------------------------
// EvidencePolicy / ResolverManifest (self-referential digest field excluded)
// ---------------------------------------------------------------------------

export function computeEvidencePolicyDigest(
  policy: EvidencePolicy | Omit<EvidencePolicy, "digest">,
): string {
  const content = strip(policy, "digest");
  if (Array.isArray(content.requiredDimensions)) {
    content.requiredDimensions = sortedStrings(content.requiredDimensions as string[]);
  }
  if (Array.isArray(content.desiredDimensions)) {
    content.desiredDimensions = sortedStrings(content.desiredDimensions as string[]);
  }
  return digestCanonicalJson(DIGEST_DOMAINS.evidencePolicy, content);
}

export function computeResolverManifestDigest(
  manifest: ResolverManifest | Omit<ResolverManifest, "digest">,
): string {
  const content = strip(manifest, "digest");
  if (Array.isArray(content.networkFamilies)) {
    content.networkFamilies = sortedStrings(content.networkFamilies as string[]);
  }
  if (Array.isArray(content.supportedCapabilities)) {
    content.supportedCapabilities = sortedStrings(content.supportedCapabilities as string[]);
  }
  if (Array.isArray(content.sourceRequirements)) {
    content.sourceRequirements = sortedByCanonical(
      content.sourceRequirements as Array<{ sourceType: string; required: boolean }>,
    );
  }
  return digestCanonicalJson(DIGEST_DOMAINS.resolverManifest, content);
}

// ---------------------------------------------------------------------------
// EvidenceSnapshot (createdAt participates; time-anchored artifact)
// ---------------------------------------------------------------------------

export function computeEvidenceSnapshotDigest(snapshot: EvidenceSnapshot): string {
  const content = strip(snapshot, "digest");
  content.anchors = sortedByCanonical(snapshot.anchors);
  content.evidence = sortedById(snapshot.evidence);
  return digestCanonicalJson(DIGEST_DOMAINS.evidenceSnapshot, content);
}

// ---------------------------------------------------------------------------
// NetworkEvidenceResult — two explicit digest domains
// ---------------------------------------------------------------------------

function normalizedResultCollections(result: NetworkEvidenceResult | NetworkEvidenceResultContent): AnyRecord {
  const ne = result.networkEvidence;
  return {
    networkEvidence: {
      execution: normalizeDimension(ne.execution),
      observedEffects: sortedById(ne.observedEffects).map(normalizeEffect),
      dataBinding: normalizeDimension(ne.dataBinding),
      settlement: normalizeDimension(ne.settlement),
      finality: normalizeDimension(ne.finality),
    },
    evidence: sortedById(result.evidence),
    conflicts: sortedById(result.conflicts).map(normalizeConflict),
    warnings: sortedByCanonical(result.warnings.map(normalizeWarning)),
  };
}

/** Semantic replay identity of a result (excludes requestId/generatedAt/digests). */
export function computeNetworkEvidenceResultSemanticDigest(
  result: NetworkEvidenceResult | NetworkEvidenceResultContent,
): string {
  const payload: AnyRecord = {
    schemaVersion: result.schemaVersion,
    network: result.network,
    subject: result.subject,
    // R3: the COMPLETE expected ActionDescriptor is part of the semantic
    // replay identity — same subject/policy/evidence but a different
    // expected action yields a DIFFERENT semanticDigest.
    action: result.action,
    policy: result.policy,
    snapshot: result.snapshot,
    resolver: result.resolver,
    ...normalizedResultCollections(result),
  };
  return digestCanonicalJson(DIGEST_DOMAINS.networkEvidenceResultSemantic, payload);
}

/** Logical artifact integrity (binds everything except artifactDigest itself). */
export function computeNetworkEvidenceResultArtifactDigest(
  result: Omit<NetworkEvidenceResult, "artifactDigest">,
): string {
  const payload: AnyRecord = {
    ...strip(result, "artifactDigest"),
    ...normalizedResultCollections(result),
  };
  return digestCanonicalJson(DIGEST_DOMAINS.networkEvidenceResultArtifact, payload);
}

// ---------------------------------------------------------------------------
// CapabilitySnapshot / DiscoverNetworksResult / PreflightResult
// ---------------------------------------------------------------------------

function normalizeCapabilityState(state: { evidence?: string[] }): AnyRecord {
  return state.evidence === undefined ? { ...state } : { ...state, evidence: sortedStrings(state.evidence) };
}

export type CapabilitySnapshotContent = Omit<CapabilitySnapshot, "artifactDigest">;

export function computeCapabilitySnapshotDigest(
  snapshot: CapabilitySnapshot | CapabilitySnapshotContent,
): string {
  const content = strip(snapshot, "artifactDigest");
  const evidenceCaps = snapshot.evidenceCapabilities;
  content.evidenceCapabilities = {
    execution: normalizeCapabilityState(evidenceCaps.execution),
    observedEffects: normalizeCapabilityState(evidenceCaps.observedEffects),
    dataBinding: normalizeCapabilityState(evidenceCaps.dataBinding),
    settlement: normalizeCapabilityState(evidenceCaps.settlement),
    finality: normalizeCapabilityState(evidenceCaps.finality),
  };
  const execCaps: AnyRecord = {};
  for (const key of [
    "executionModel",
    "accountModel",
    "gasModel",
    "simulation",
    "batching",
  ] as const) {
    const state = snapshot.executionCapabilities[key];
    if (state !== undefined) {
      execCaps[key] = normalizeCapabilityState(state);
    }
  }
  content.executionCapabilities = execCaps;
  content.evidence = sortedById(snapshot.evidence);
  return digestCanonicalJson(DIGEST_DOMAINS.capabilitySnapshot, content);
}

export type DiscoverNetworksResultContent = Omit<DiscoverNetworksResult, "artifactDigest">;

export function computeDiscoverNetworksResultDigest(
  result: DiscoverNetworksResult | DiscoverNetworksResultContent,
): string {
  const content = strip(result, "artifactDigest");
  const requirements = sortedByCanonical(result.request.requirements);
  content.request = {
    ...result.request,
    requirements,
    ...(result.request.networkAllowlist === undefined
      ? {}
      : { networkAllowlist: sortedStrings(result.request.networkAllowlist) }),
    ...(result.request.networkDenylist === undefined
      ? {}
      : { networkDenylist: sortedStrings(result.request.networkDenylist) }),
  };
  content.matches = sortedByKey(result.matches, (match) => match.network.networkId).map((match) => ({
    ...match,
    // Normalize CHILD citation arrays FIRST, then derive the outer order
    // from the normalized forms — never the reverse.
    evaluations: sortedByCanonical(match.evaluations.map(normalizeEvaluation)),
    evidence: sortedById(match.evidence),
  }));
  return digestCanonicalJson(DIGEST_DOMAINS.discoveryResult, content);
}

/**
 * CALLER/BUILD input of the preflight builder: excludes every DERIVED
 * field — `status` (recomputed by the normative composer, never
 * caller-authored) and `artifactDigest` (computed by the builder). The
 * built `PreflightResult` artifact carries both derived values; digest
 * projections that need the full artifact shape accept
 * `PreflightResult | PreflightResultContent` internally.
 */
export type PreflightResultContent = Omit<PreflightResult, "artifactDigest" | "status">;

export function computePreflightResultDigest(
  result: PreflightResult | PreflightResultContent,
): string {
  const content = strip(result, "artifactDigest");
  const normalizeChecks = (checks: Record<string, { evidence?: string[] }>): AnyRecord => {
    const out: AnyRecord = {};
    for (const [key, check] of Object.entries(checks)) {
      out[key] =
        check.evidence === undefined ? { ...check } : { ...check, evidence: sortedStrings(check.evidence) };
    }
    return out;
  };
  // R3: evidence readiness only — generic execution readiness is not part
  // of the v0.1 preflight contract.
  content.evidenceReadiness = normalizeChecks(result.evidenceReadiness);
  content.blockers = sortedByCanonical(result.blockers);
  content.warnings = sortedByCanonical(result.warnings.map(normalizeWarning));
  content.evidence = sortedById(result.evidence);
  // The EMBEDDED policy inside the bound request is part of the artifact;
  // its set-like dimension lists are normalized recursively so a dimension
  // permutation of the same policy cannot change the preflight digest. The
  // embedded request's requestId participates directly (it IS the identity).
  const requestPolicy = result.request.evidencePolicy as EvidencePolicy | undefined;
  if (requestPolicy !== undefined && Array.isArray(requestPolicy.requiredDimensions)) {
    content.request = {
      ...result.request,
      evidencePolicy: {
        ...requestPolicy,
        requiredDimensions: sortedStrings(requestPolicy.requiredDimensions),
        ...(requestPolicy.desiredDimensions === undefined
          ? {}
          : { desiredDimensions: sortedStrings(requestPolicy.desiredDimensions) }),
      },
    };
  }
  return digestCanonicalJson(DIGEST_DOMAINS.preflightResult, content);
}
