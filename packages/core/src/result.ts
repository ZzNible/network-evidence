import { canonicalJson } from "./canonical-json.js";
import { isDigest } from "./digest.js";
import { assertSnapshotAgreesWithManifest, composeDiscoveryMatch } from "./discovery.js";
import { capabilityIsUsable } from "./capabilities.js";
import { composePreflightStatus } from "./preflight.js";
import {
  computeCapabilitySnapshotDigest,
  computeDiscoverNetworksResultDigest,
  computeEvidenceRequestDigest,
  computeEvidenceSnapshotDigest,
  computeNetworkEvidenceResultArtifactDigest,
  computeNetworkEvidenceResultSemanticDigest,
  computePreflightResultDigest,
  computeResolverManifestDigest,
  normalizedEvaluationIdentity,
  type CapabilitySnapshotContent,
  type DiscoverNetworksResultContent,
  type NetworkEvidenceResultContent,
  type PreflightResultContent,
} from "./digests.js";
import { NecValidationError } from "./errors.js";
import { assertPlainDataContractObject } from "./validate.js";
import { assertInertArray, compareUtf16, firstArrayDeviation } from "./internal.js";
import { RESOURCE_LIMITS } from "./limits.js";
import {
  deepFreeze,
  validateCapabilitySnapshot,
  validateDiscoverNetworksResult,
  validateEvidencePolicy,
  validateEvidenceRequest,
  validateEvidenceSnapshot,
  validateNetworkEvidenceResult,
  validateNetworkEvidenceResultStructureInternal,
  validatePreflightResult,
  validateResolverManifest,
} from "./validate.js";
import { toPreflightResultRef } from "./preflight.js";
import type {
  CapabilitySnapshot,
  Digest,
  DiscoverNetworksResult,
  EvidencePolicy,
  EvidenceRef,
  EvidenceRequest,
  EvidenceSnapshot,
  NetworkEvidenceResult,
  PolicyDimension,
  PreflightResult,
  ResolverManifest,
} from "./types.js";

/**
 * Deterministic artifact construction and digest binding.
 *
 * BUILDERS ARE CONTEXTUAL and VERIFIERS REQUIRE COMPLETE CONTEXT (R3):
 * structural validation and self-digest checks may operate on one artifact
 * (`verify*Integrity`), but anything that verifies an NEC claim/context
 * requires the complete context needed to recompute EVERY relevant
 * reference — there are NO optional context parameters on claim
 * verification:
 *
 *   - CapabilitySnapshot claim verification requires the requested networkId
 *     AND the complete ResolverManifest;
 *   - Discovery claim verification requires the complete referenced
 *     CapabilitySnapshots AND the complete corresponding ResolverManifests;
 *   - Preflight claim verification requires the complete PreflightRequest
 *     (embedded), the relevant CapabilitySnapshot whenever positive
 *     readiness is claimed or referenced, and the complete ResolverManifest;
 *   - NetworkEvidenceResult claim verification requires the complete
 *     EvidenceRequest, EvidencePolicy, ResolverManifest, EvidenceSnapshot
 *     and — when a preflight is referenced — the complete PreflightResult
 *     plus ITS own complete verification context.
 *
 * Builders reject caller-supplied SELF-DIGEST fields outright (never
 * silently overwritten) and the preflight builder recomputes `status` (the
 * caller never authors overall readiness). Results are defensively deep-
 * copied with cycle detection and resource bounds, validated (re-verifying
 * every self-digest), contextually verified, and frozen.
 */

// ---------------------------------------------------------------------------
// Self-digest smuggling rejection
// ---------------------------------------------------------------------------

function rejectSelfDigestFields(content: object, fields: readonly string[], label: string): void {
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(content, field)) {
      throw new NecValidationError(
        "NEC_VALIDATION_FAILED",
        `${label}: caller-supplied self-digest field "${field}" is not allowed; builders compute digests`,
      );
    }
  }
}

const DIGEST_PLACEHOLDER = `sha256:${"0".repeat(64)}`;

function assertComputedDigest(digest: string, field: string): void {
  if (!isDigest(digest)) {
    throw new NecValidationError("NEC_VALIDATION_FAILED", `${field}: computed digest malformed`);
  }
}

// ---------------------------------------------------------------------------
// Cross-artifact coherence (Decision: no shape-only ref checking)
// ---------------------------------------------------------------------------

export interface NetworkEvidenceBuildContext {
  readonly policy: EvidencePolicy;
  readonly snapshot: EvidenceSnapshot;
  readonly resolver: ResolverManifest;
  /**
   * The COMPLETE EvidenceRequest this result answers (surface context
   * requirement for resolveEvidence). The builder computes and binds its
   * `{requestId, digest}` reference; verifiers recompute and compare it.
   */
  readonly request: EvidenceRequest;
  /**
   * The COMPLETE PreflightResult — REQUIRED when `request.preflight`
   * exists, forbidden to be silently absent. Verified end-to-end WITH its
   * own complete verification context (resolver manifest; capability
   * snapshot when one is referenced or needed for readiness derivation)
   * before continuity is accepted.
   */
  readonly preflight?: PreflightResult;
  /** Complete verification context of the referenced preflight (R3). */
  readonly preflightContext?: PreflightVerificationContext;
}

function refEquals(ref: Record<string, unknown>, expected: Record<string, unknown>, keys: readonly string[], path: string): void {
  for (const key of keys) {
    if (ref[key] !== expected[key]) {
      throw new NecValidationError(
        "NEC_VALIDATION_FAILED",
        `${path}.${key}: reference does not exactly match the provided artifact`,
      );
    }
  }
}

/**
 * Verify that a result's digest-qualified references identify the provided
 * artifacts, that those artifacts are themselves valid, and that the FULL
 * EvidenceRequest -> Preflight -> Result continuity chain holds. Throws on
 * any violation.
 *
 * The provided context artifacts are fully validated first (including a
 * complete contextual recomputation of the referenced PreflightResult when
 * one is bound). Every caller-supplied `content` sub-object is descriptor-
 * guarded BEFORE any of its fields are read, so a hostile object cannot
 * execute getters while being rejected.
 *
 * R3 ACTION CONTINUITY: the request binds the EXPECTED ActionDescriptor.
 * `request.action`, `preflight.request.action` (when referenced) and
 * `result.action` must be canonically equal. This proves continuity of the
 * expected action ONLY — it does NOT prove that an external execution
 * produced the subject; that causality question belongs to a resolver /
 * protocol adapter comparing observed effects for the subject against the
 * expected action.
 */
export function verifyNetworkEvidenceContext(
  content: Pick<
    NetworkEvidenceResult,
    | "requestId"
    | "request"
    | "action"
    | "network"
    | "subject"
    | "policy"
    | "snapshot"
    | "resolver"
    | "evidence"
  >,
  context: NetworkEvidenceBuildContext,
): void {
  // Descriptor-safety guards on caller-supplied content BEFORE field reads:
  // accessors/symbols/exotic prototypes fail closed without executing code.
  assertPlainDataContractObject(content as unknown, "result");
  for (const key of ["request", "action", "network", "subject", "policy", "snapshot", "resolver"] as const) {
    assertPlainDataContractObject(
      (content as Record<string, unknown>)[key],
      `result.${key}`,
    );
  }
  assertInertArray((content as Record<string, unknown>).evidence, "result.evidence");

  // The complete artifacts must themselves be valid (this also re-verifies
  // their self-digests).
  validateEvidencePolicy(context.policy);
  validateResolverManifest(context.resolver);
  validateEvidenceSnapshot(context.snapshot);

  refEquals(
    content.policy as unknown as Record<string, unknown>,
    { id: context.policy.id, version: context.policy.version, digest: context.policy.digest },
    ["id", "version", "digest"],
    "policy",
  );
  refEquals(
    content.snapshot as unknown as Record<string, unknown>,
    { id: context.snapshot.id, digest: context.snapshot.digest },
    ["id", "digest"],
    "snapshot",
  );
  refEquals(
    content.resolver as unknown as Record<string, unknown>,
    {
      id: context.resolver.id,
      version: context.resolver.version,
      digest: context.resolver.digest,
    },
    ["id", "version", "digest"],
    "resolver",
  );

  // -----------------------------------------------------------------------
  // EvidenceRequest -> Preflight -> Result CONTINUITY CHAIN.
  // A caller must not be able to preflight action A, substitute request B,
  // attach the old successful preflight and obtain a coherent-looking
  // result. Every link below is digest-bound or canonically compared —
  // equality is NEVER inferred from ids alone.
  // -----------------------------------------------------------------------
  const request = context.request;
  validateEvidenceRequest(request);
  const computedRef = { requestId: request.requestId, digest: computeEvidenceRequestDigest(request) };
  if (
    content.request.requestId !== computedRef.requestId ||
    content.request.digest !== computedRef.digest
  ) {
    throw new NecValidationError(
      "NEC_VALIDATION_FAILED",
      "result.request does not match the provided EvidenceRequest (requestId/digest continuity broken)",
    );
  }
  if (content.requestId !== request.requestId) {
    throw new NecValidationError(
      "NEC_VALIDATION_FAILED",
      "result requestId must equal the bound EvidenceRequest requestId",
    );
  }
  if (content.network.networkId !== request.networkId) {
    throw new NecValidationError(
      "NEC_VALIDATION_FAILED",
      "result network.networkId must equal the EvidenceRequest networkId",
    );
  }
  if (canonicalJson(content.subject) !== canonicalJson(request.subject)) {
    throw new NecValidationError(
      "NEC_VALIDATION_FAILED",
      "result subject must equal the EvidenceRequest subject (canonical equality)",
    );
  }
  if (canonicalJson(content.action) !== canonicalJson(request.action)) {
    throw new NecValidationError(
      "NEC_VALIDATION_FAILED",
      "result action must equal the EvidenceRequest expected action (canonical equality)",
    );
  }
  const requestPolicyRef = {
    id: request.evidencePolicy.id,
    version: request.evidencePolicy.version,
    digest: request.evidencePolicy.digest,
  };
  if (
    content.policy.id !== requestPolicyRef.id ||
    content.policy.version !== requestPolicyRef.version ||
    content.policy.digest !== requestPolicyRef.digest
  ) {
    throw new NecValidationError(
      "NEC_VALIDATION_FAILED",
      "result policy reference must equal the EvidenceRequest evidencePolicy",
    );
  }

  if (request.preflight !== undefined) {
    const preflight = context.preflight;
    if (preflight === undefined) {
      throw new NecValidationError(
        "NEC_VALIDATION_FAILED",
        "the EvidenceRequest references a preflight result; the complete PreflightResult artifact is required in the context",
      );
    }
    // Contextual preflight verification FIRST (complete context required:
    // manifest, capability snapshot when referenced/needed).
    verifyPreflightResultOrThrow(preflight, {
      ...(context.preflightContext ?? {}),
      // The resolve surface already supplies the full manifest; default the
      // preflight's resolver context to it unless explicitly overridden.
      resolver: context.preflightContext?.resolver ?? context.resolver,
    });
    if (request.preflight.requestId !== preflight.request.requestId) {
      throw new NecValidationError(
        "NEC_VALIDATION_FAILED",
        "request.preflight.requestId does not match the provided PreflightResult's embedded request identity",
      );
    }
    if (request.preflight.digest !== preflight.artifactDigest) {
      throw new NecValidationError(
        "NEC_VALIDATION_FAILED",
        "request.preflight.digest does not match the provided PreflightResult artifactDigest (stale or substituted preflight)",
      );
    }
    if (preflight.request.networkId !== request.networkId) {
      throw new NecValidationError(
        "NEC_VALIDATION_FAILED",
        "the preflighted request network differs from the EvidenceRequest network",
      );
    }
    if (canonicalJson(preflight.request.action) !== canonicalJson(request.action)) {
      throw new NecValidationError(
        "NEC_VALIDATION_FAILED",
        "the preflighted action differs from the EvidenceRequest expected action (action continuity broken)",
      );
    }
    const pfPolicy = {
      id: preflight.evidencePolicy.id,
      version: preflight.evidencePolicy.version,
      digest: preflight.evidencePolicy.digest,
    };
    if (
      pfPolicy.id !== requestPolicyRef.id ||
      pfPolicy.version !== requestPolicyRef.version ||
      pfPolicy.digest !== requestPolicyRef.digest
    ) {
      throw new NecValidationError(
        "NEC_VALIDATION_FAILED",
        "the preflighted evidence policy differs from the EvidenceRequest evidencePolicy",
      );
    }
  }

  const primaryNetwork = content.network.networkId;
  if (content.subject.networkId !== primaryNetwork) {
    throw new NecValidationError(
      "NEC_VALIDATION_FAILED",
      "subject.networkId must equal the result primary network",
    );
  }
  if (canonicalJson(context.snapshot.networkFingerprint) !== canonicalJson(content.network)) {
    throw new NecValidationError(
      "NEC_VALIDATION_FAILED",
      "snapshot.networkFingerprint must equal the result primary network context",
    );
  }
  if (context.snapshot.resolverManifestDigest !== context.resolver.digest) {
    throw new NecValidationError(
      "NEC_VALIDATION_FAILED",
      "snapshot.resolverManifestDigest does not match the provided resolver manifest digest",
    );
  }
  if (context.snapshot.policyDigest !== context.policy.digest) {
    throw new NecValidationError(
      "NEC_VALIDATION_FAILED",
      "snapshot.policyDigest does not match the provided evidence policy digest",
    );
  }

  // SNAPSHOT/RESULT EVIDENCE CLOSURE: every EvidenceRef used by the result
  // must correspond to an EvidenceRef in the referenced snapshot — matched
  // by id AND by canonical equality of the COMPLETE EvidenceRef. A result
  // can never replace locator, retrievedAt, contentDigest, networkId, block
  // position, metadata or nativeSource under an existing EvidenceId. The
  // snapshot evidence table MAY be a superset of the result evidence.
  const snapshotRefById = new Map<string, string>();
  for (const snapshotRef of context.snapshot.evidence) {
    snapshotRefById.set(snapshotRef.id, canonicalJson(snapshotRef));
  }
  const evidenceRefs = content.evidence as EvidenceRef[];
  for (let i = 0; i < evidenceRefs.length; i++) {
    const ref = evidenceRefs[i]!;
    const expected = snapshotRefById.get(ref.id);
    if (expected === undefined) {
      throw new NecValidationError(
        "NEC_VALIDATION_FAILED",
        `evidence[${i}] (${JSON.stringify(ref.id)}): no EvidenceRef with this id exists in the referenced EvidenceSnapshot`,
      );
    }
    if (canonicalJson(ref) !== expected) {
      throw new NecValidationError(
        "NEC_VALIDATION_FAILED",
        `evidence[${i}] (${JSON.stringify(ref.id)}): differs from the snapshot's EvidenceRef under the same id; provenance fields cannot be replaced`,
      );
    }
  }

  // Cross-network evidence is ALLOWED but must be anchored explicitly in
  // the snapshot; never implied. Anchors never imply atomic cross-domain state.
  const anchorNetworks = new Set(context.snapshot.anchors.map((anchor) => anchor.networkId));
  for (const [i, ref] of evidenceRefs.entries()) {
    if (ref.networkId === undefined || ref.networkId === primaryNetwork) continue;
    if (!anchorNetworks.has(ref.networkId)) {
      throw new NecValidationError(
        "NEC_VALIDATION_FAILED",
        `evidence[${i}] (${JSON.stringify(ref.id)}): networkId ${JSON.stringify(
          ref.networkId,
        )} differs from the primary network and has no explicit EvidenceAnchor in the snapshot`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// NetworkEvidenceResult builder / verifiers
// ---------------------------------------------------------------------------

/**
 * Build a frozen, validated `NetworkEvidenceResult` with BOTH digests bound
 * and the full EvidenceRequest -> Preflight -> Result continuity chain
 * verified. `context` must contain the complete artifacts behind the
 * policy/snapshot/resolver references, plus the complete EvidenceRequest
 * (and the referenced PreflightResult — with its own verification context —
 * when one exists). The request reference is COMPUTED from the provided
 * request — caller-supplied `request` fields in the content are rejected
 * outright. Throws on any invariant violation.
 */
export function buildNetworkEvidenceResult(
  content: NetworkEvidenceResultContent,
  context: NetworkEvidenceBuildContext,
): NetworkEvidenceResult {
  rejectSelfDigestFields(
    content as object,
    ["semanticDigest", "artifactDigest", "request"],
    "result content",
  );
  // The bound request must be valid BEFORE its reference is computed.
  validateEvidenceRequest(context.request);

  // Assemble the full artifact first so that STRUCTURAL validation runs with
  // precise paths before any cross-artifact comparison reads sub-fields.
  let full: NetworkEvidenceResult;
  const draft = {
    ...(defensiveClone(content) as NetworkEvidenceResultContent),
    // The bound-request reference is recomputed from the COMPLETE request.
    request: defensiveClone({
      requestId: context.request.requestId,
      digest: computeEvidenceRequestDigest(context.request),
    }),
    semanticDigest: DIGEST_PLACEHOLDER,
    artifactDigest: DIGEST_PLACEHOLDER,
  } as Omit<NetworkEvidenceResult, "semanticDigest">;
  // Structural pass first (digests are placeholders here).
  validateNetworkEvidenceResultStructureInternal(draft);

  try {
    const semantic = computeNetworkEvidenceResultSemanticDigest(draft as never);
    assertComputedDigest(semantic, "semanticDigest");
    const withSemantic = { ...draft, semanticDigest: semantic };
    const artifact = computeNetworkEvidenceResultArtifactDigest(withSemantic);
    assertComputedDigest(artifact, "artifactDigest");
    full = { ...withSemantic, artifactDigest: artifact };
  } catch (error) {
    if (error instanceof NecValidationError) throw error;
    throw new NecValidationError(
      "NEC_VALIDATION_FAILED",
      `result content is not a valid NetworkEvidenceResultContent (${(error as Error).message})`,
    );
  }

  validateNetworkEvidenceResult(full);
  // Full coherence against the real artifacts (refs, networks, anchors).
  verifyNetworkEvidenceContext(full, context);
  return deepFreeze(full);
}

/**
 * Recompute and compare both stored digests of a previously built result.
 * SELF-DIGEST / STRUCTURAL integrity only: passing says nothing about
 * cross-artifact truth. Contextual claim verification REQUIRES the complete
 * context (`verifyNetworkEvidenceResult`).
 */
export function verifyNetworkEvidenceResultIntegrity(result: NetworkEvidenceResult): boolean {
  try {
    validateNetworkEvidenceResult(result);
    return true;
  } catch {
    return false;
  }
}

/**
 * Verify ONLY the semantic replay identity (`semanticDigest`) of a result.
 *
 * The artifact is STRUCTURALLY VALIDATED FIRST (exact field sets, plain
 * inert data, referential integrity, normative verdict state machine); only
 * then is the semantic digest recomputed and compared. A digest projection
 * match alone can never verify malformed data. This is NOT contextual claim
 * verification.
 */
export function verifyNetworkEvidenceResultSemantics(result: NetworkEvidenceResult): boolean {
  try {
    validateNetworkEvidenceResultStructureInternal(result);
    return (
      computeNetworkEvidenceResultSemanticDigest(result) === result.semanticDigest &&
      isDigest(result.semanticDigest)
    );
  } catch {
    return false;
  }
}

/**
 * THE contextual claim verifier for resolve-evidence results (R3):
 * structural validation + self-digests + FULL coherence against the
 * complete supplied context (request/policy/snapshot/resolver/preflight).
 * The context parameter is REQUIRED — NEC never claims verification of an
 * artifact it was not actually given.
 */
export function verifyNetworkEvidenceResult(
  result: NetworkEvidenceResult,
  context: NetworkEvidenceBuildContext,
): boolean {
  try {
    validateNetworkEvidenceResult(result);
    verifyNetworkEvidenceContext(result, context);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// EvidenceSnapshot builder / verifier
// ---------------------------------------------------------------------------

export interface EvidenceSnapshotBuildContext {
  readonly policy?: EvidencePolicy;
  readonly resolver?: ResolverManifest;
}

export function buildEvidenceSnapshot(
  content: Omit<EvidenceSnapshot, "digest">,
  context?: EvidenceSnapshotBuildContext,
): EvidenceSnapshot {
  // DEFENSIVE CLONE FIRST (freeze-final): the descriptor-first cloner
  // rejects accessors/symbols/exotic prototypes WITHOUT ever invoking a
  // getter, and every later field read (self-digest rejection, context
  // digest comparison, digest projection) sees only the fresh NEC-owned
  // copy. The caller-owned graph is never frozen.
  const cloned = defensiveClone(content) as Omit<EvidenceSnapshot, "digest">;
  rejectSelfDigestFields(cloned as object, ["digest"], "snapshot content");
  if (context?.policy !== undefined) {
    validateEvidencePolicy(context.policy);
    if (cloned.policyDigest !== context.policy.digest) {
      throw new NecValidationError(
        "NEC_VALIDATION_FAILED",
        "snapshot policyDigest does not match the provided evidence policy digest",
      );
    }
  }
  if (context?.resolver !== undefined) {
    validateResolverManifest(context.resolver);
    if (cloned.resolverManifestDigest !== context.resolver.digest) {
      throw new NecValidationError(
        "NEC_VALIDATION_FAILED",
        "snapshot resolverManifestDigest does not match the provided resolver manifest digest",
      );
    }
  }

  const draft = {
    ...cloned,
    digest: DIGEST_PLACEHOLDER,
  } as EvidenceSnapshot;

  const digest = computeEvidenceSnapshotDigest(draft);
  assertComputedDigest(digest, "snapshot.digest");
  const full = { ...draft, digest };
  validateEvidenceSnapshot(full);
  return deepFreeze(full);
}

export function verifyEvidenceSnapshotIntegrity(snapshot: EvidenceSnapshot): boolean {
  try {
    validateEvidenceSnapshot(snapshot);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// CapabilitySnapshot builder / verifiers
// ---------------------------------------------------------------------------

/**
 * R3: capability-snapshot construction/claim verification REQUIRES the
 * complete context: the explicitly requested probe target networkId AND the
 * complete ResolverManifest. The manifest is authoritative about what the
 * resolver implementation knows how to evaluate: a snapshot MUST NOT claim
 * support == supported/conditional for a capability absent from
 * manifest.supportedCapabilities (membership permits evaluation only; it
 * never proves support or availability — positive current capability claims
 * still require live provenance).
 */
export interface CapabilitySnapshotBuildContext {
  /** The COMPLETE resolver manifest behind `snapshot.resolver`. */
  readonly resolver: ResolverManifest;
  /** The explicitly requested probe target. */
  readonly networkId: string;
}

function verifyCapabilitySnapshotClaims(
  snapshot: CapabilitySnapshot,
  context: CapabilitySnapshotBuildContext,
): void {
  validateCapabilitySnapshot(snapshot);
  validateResolverManifest(context.resolver);
  const ref = snapshot.resolver;
  if (
    ref.id !== context.resolver.id ||
    ref.version !== context.resolver.version ||
    ref.digest !== context.resolver.digest
  ) {
    throw new NecValidationError(
      "NEC_VALIDATION_FAILED",
      "snapshot resolver reference does not exactly match the provided resolver manifest (id/version/digest)",
    );
  }
  if (snapshot.network.networkId !== context.networkId) {
    throw new NecValidationError(
      "NEC_VALIDATION_FAILED",
      `snapshot network ${JSON.stringify(snapshot.network.networkId)} does not match the explicitly requested target ${JSON.stringify(context.networkId)}`,
    );
  }
  // Manifest authority: the manifest is authoritative about evaluability.
  assertSnapshotAgreesWithManifest(snapshot, context.resolver);
}

export function buildCapabilitySnapshot(
  content: CapabilitySnapshotContent,
  context: CapabilitySnapshotBuildContext,
): CapabilitySnapshot {
  rejectSelfDigestFields(content as object, ["artifactDigest"], "capability snapshot content");
  validateResolverManifest(context.resolver);
  const draft = {
    ...defensiveClone(content),
    artifactDigest: DIGEST_PLACEHOLDER,
  } as CapabilitySnapshot;
  const artifact = computeCapabilitySnapshotDigest(draft);
  assertComputedDigest(artifact, "artifactDigest");
  const full = { ...draft, artifactDigest: artifact };
  // Full contextual coherence (manifest authority + probe target).
  verifyCapabilitySnapshotClaims(full, context);
  return deepFreeze(full);
}

/**
 * Contextual CapabilitySnapshot claim verification (R3). REQUIRES the
 * requested networkId and the COMPLETE ResolverManifest; verifies the
 * self-digest, the resolver reference (id/version/digest), the probe target
 * network and the manifest-authority invariant.
 */
export function verifyCapabilitySnapshot(
  snapshot: CapabilitySnapshot,
  context: CapabilitySnapshotBuildContext,
): boolean {
  try {
    verifyCapabilitySnapshotClaims(snapshot, context);
    return true;
  } catch {
    return false;
  }
}

/**
 * SELF-DIGEST / structural integrity only. Passing proves the artifact is
 * internally consistent — NOT that its capability claims are true. Claim
 * verification requires complete context (`verifyCapabilitySnapshot`).
 */
export function verifyCapabilitySnapshotIntegrity(snapshot: CapabilitySnapshot): boolean {
  try {
    validateCapabilitySnapshot(snapshot);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Discovery builder / verifiers
// ---------------------------------------------------------------------------

/**
 * Builder context for discovery results. CLAIM-PRODUCING BUILDERS REQUIRE
 * COMPLETE CONTEXT (freeze-final): the complete CapabilitySnapshots
 * referenced by the matches AND the complete corresponding
 * ResolverManifests are REQUIRED arguments — every match's digest-qualified
 * snapshot reference must resolve against them (matched by id AND recomputed
 * artifact digest), carry the canonically-equal network fingerprint and
 * reference an exactly matching manifest. There is no optional-context
 * build path and no compatibility shim; a caller wanting only structural /
 * self-digest validation uses the validators or `verify*Integrity`.
 */
export interface DiscoverNetworksBuildContext {
  /** The COMPLETE CapabilitySnapshots referenced by the matches. */
  readonly capabilitySnapshots: readonly CapabilitySnapshot[];
  /** The COMPLETE ResolverManifests behind the snapshots' resolver refs. */
  readonly resolverManifests: readonly ResolverManifest[];
}

/**
 * R3 claim-verification context for discovery results. REQUIRED for
 * `verifyDiscoverNetworksResult`: the complete referenced
 * CapabilitySnapshots AND the complete corresponding ResolverManifests.
 */
export interface DiscoverNetworksVerificationContext {
  readonly capabilitySnapshots: readonly CapabilitySnapshot[];
  readonly resolverManifests: readonly ResolverManifest[];
}

/**
 * Contextual discovery verification against COMPLETE context. Every match's
 * digest-qualified capability snapshot reference must resolve to the actual
 * snapshot (recomputed digest), carry the SAME full network fingerprint
 * (canonical equality — networkId alone is insufficient), reference an
 * exactly matching manifest, keep EVIDENCE CLOSURE against the snapshot's
 * evidence table (matched by id AND canonical equality of the COMPLETE
 * EvidenceRef; the snapshot may be a superset), and agree with THE normative
 * discovery composer — including the composer's deterministic evaluation
 * `reason` fields, compared over NORMALIZED projections (citation
 * permutations never fail comparison; genuine disagreement does).
 */
function verifyDiscoverNetworksContext(
  result: DiscoverNetworksResult,
  context: DiscoverNetworksVerificationContext,
): void {
  const snapshots = context.capabilitySnapshots;
  const manifests = context.resolverManifests;
  for (const [i, match] of result.matches.entries()) {
    const ref = match.capabilitySnapshot;
    const snapshot = snapshots.find((candidate) => candidate.id === ref.id);
    if (snapshot === undefined) {
      throw new NecValidationError(
        "NEC_VALIDATION_FAILED",
        `matches[${i}]: no CapabilitySnapshot with id ${JSON.stringify(ref.id)} was supplied; complete context required`,
      );
    }
    validateCapabilitySnapshot(snapshot);
    if (snapshot.artifactDigest !== ref.digest) {
      throw new NecValidationError(
        "NEC_VALIDATION_FAILED",
        `matches[${i}].capabilitySnapshot.digest does not match the supplied CapabilitySnapshot artifactDigest`,
      );
    }
    if (canonicalJson(snapshot.network) !== canonicalJson(match.network)) {
      throw new NecValidationError(
        "NEC_VALIDATION_FAILED",
        `matches[${i}]: capability snapshot network fingerprint is not canonically equal to the match network context (full fingerprint equality required)`,
      );
    }
    const manifest = manifests.find((m) => m.id === snapshot.resolver.id);
    if (manifest === undefined) {
      throw new NecValidationError(
        "NEC_VALIDATION_FAILED",
        `matches[${i}]: no ResolverManifest with id ${JSON.stringify(snapshot.resolver.id)} was supplied; complete context required`,
      );
    }
    validateResolverManifest(manifest);
    const r = snapshot.resolver;
    if (r.id !== manifest.id || r.version !== manifest.version || r.digest !== manifest.digest) {
      throw new NecValidationError(
        "NEC_VALIDATION_FAILED",
        `matches[${i}]: capability snapshot resolver reference does not exactly match the supplied resolver manifest (id/version/digest)`,
      );
    }
    assertSnapshotAgreesWithManifest(snapshot, manifest);

    // EVIDENCE CLOSURE: every EvidenceRef used by this match must exist in
    // the referenced CapabilitySnapshot evidence table — matched by id AND
    // canonical equality of the COMPLETE ref. The snapshot MAY be a
    // superset. A caller cannot keep an EvidenceId while replacing sourceId,
    // locator, contentDigest, retrievedAt, networkId, block position,
    // metadata, nativeSource or independenceGroup.
    const snapshotRefById = new Map<string, string>();
    for (const snapshotRef of snapshot.evidence) {
      snapshotRefById.set(snapshotRef.id, canonicalJson(snapshotRef));
    }
    for (const [j, matchRef] of match.evidence.entries()) {
      const expected = snapshotRefById.get(matchRef.id);
      if (expected === undefined) {
        throw new NecValidationError(
          "NEC_VALIDATION_FAILED",
          `matches[${i}].evidence[${j}] (${JSON.stringify(matchRef.id)}): no EvidenceRef with this id exists in the referenced CapabilitySnapshot`,
        );
      }
      if (canonicalJson(matchRef) !== expected) {
        throw new NecValidationError(
          "NEC_VALIDATION_FAILED",
          `matches[${i}].evidence[${j}] (${JSON.stringify(matchRef.id)}): differs from the snapshot's EvidenceRef under the same id; provenance fields cannot be replaced`,
        );
      }
    }

    // Normative composer agreement: classification + per-requirement
    // statuses, reasons and citations are recomputed, never trusted.
    const composed = composeDiscoveryMatch(result.request, {
      network: match.network,
      snapshot,
      resolver: manifest,
    });
    if (composed.classification !== match.classification) {
      throw new NecValidationError(
        "NEC_VALIDATION_FAILED",
        `matches[${i}].classification ${JSON.stringify(match.classification)} disagrees with the normative composer outcome ${JSON.stringify(composed.classification)}`,
      );
    }
    if (composed.evaluations.length !== match.evaluations.length) {
      throw new NecValidationError(
        "NEC_VALIDATION_FAILED",
        `matches[${i}].evaluations do not correspond 1:1 to the request requirements`,
      );
    }
    // ONE NORMALIZED SEMANTIC PROJECTION (freeze-final): evaluations are
    // SET-LIKE, so comparison happens over the SAME normalized projection
    // the digest uses — each evaluation's citations are sorted first, then
    // both multisets of complete identities (including the deterministic
    // composer `reason` and the requirement + status) are sorted and
    // compared. A permutation of stored evaluations therefore verifies
    // exactly when the digest semantics agree; any genuine disagreement
    // (forged reason, altered status, changed citations) fails.
    const composedForms = composed.evaluations
      .map((evaluation) => canonicalJson(normalizedEvaluationIdentity(evaluation)))
      .sort(compareUtf16);
    const storedForms = match.evaluations
      .map((evaluation) => canonicalJson(normalizedEvaluationIdentity(evaluation)))
      .sort(compareUtf16);
    for (let j = 0; j < composedForms.length; j++) {
      if (composedForms[j] !== storedForms[j]) {
        throw new NecValidationError(
          "NEC_VALIDATION_FAILED",
          `matches[${i}].evaluations disagree with the normative composer evaluation (normalized comparison incl. reason)`,
        );
      }
    }
  }
}

export function buildDiscoverNetworksResult(
  content: DiscoverNetworksResultContent,
  context: DiscoverNetworksBuildContext,
): DiscoverNetworksResult {
  // CLAIM BUILDERS REQUIRE COMPLETE CONTEXT (freeze-final): no optional
  // overload, no compatibility shim. Runtime fail-closed for JS callers
  // that omit the context entirely.
  if (context === undefined || context === null) {
    throw new NecValidationError(
      "NEC_VALIDATION_FAILED",
      "discovery result builder requires the COMPLETE verification context (referenced CapabilitySnapshots + ResolverManifests); structural validation alone is available through validateDiscoverNetworksResult / verifyDiscoverNetworksResultIntegrity",
    );
  }
  rejectSelfDigestFields(content as object, ["artifactDigest"], "discovery result content");
  const draft = {
    ...defensiveClone(content),
    artifactDigest: DIGEST_PLACEHOLDER,
  } as DiscoverNetworksResult;
  const artifact = computeDiscoverNetworksResultDigest(draft);
  assertComputedDigest(artifact, "artifactDigest");
  const full = { ...draft, artifactDigest: artifact };
  validateDiscoverNetworksResult(full);
  verifyDiscoverNetworksContext(full, context);
  return deepFreeze(full);
}

export function verifyDiscoverNetworksResultIntegrity(result: DiscoverNetworksResult): boolean {
  try {
    validateDiscoverNetworksResult(result);
    return true;
  } catch {
    return false;
  }
}

/**
 * THE contextual claim verifier for discovery results (R3): structural
 * validation + self-digest + FULL verification against the complete
 * referenced snapshots and manifests. The context parameter is REQUIRED.
 */
export function verifyDiscoverNetworksResult(
  result: DiscoverNetworksResult,
  context: DiscoverNetworksVerificationContext,
): boolean {
  try {
    validateDiscoverNetworksResult(result);
    verifyDiscoverNetworksContext(result, context);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Preflight builder / verifiers
// ---------------------------------------------------------------------------

/**
 * Builder context for preflight results. CLAIM-PRODUCING BUILDERS REQUIRE
 * COMPLETE CONTEXT (freeze-final): the COMPLETE ResolverManifest is ALWAYS
 * required; the COMPLETE CapabilitySnapshot is additionally required at
 * runtime whenever the result references one OR claims any positive
 * readiness (`ready` must be DERIVABLE from the supplied capability
 * context). No optional-context build path, no compatibility shim.
 */
export interface PreflightBuildContext {
  /** The COMPLETE resolver manifest behind `result.resolver`. */
  readonly resolver: ResolverManifest;
  /**
   * The COMPLETE CapabilitySnapshot behind `result.capabilitySnapshot`
   * and/or used to derive positive readiness claims.
   */
  readonly capabilitySnapshot?: CapabilitySnapshot;
}

/**
 * R3 claim-verification context for preflight results. REQUIRED for
 * `verifyPreflightResult`. The capability snapshot is required at runtime
 * whenever the result references one OR claims any positive readiness
 * (`ready` must be DERIVABLE from the supplied capability context).
 */
export interface PreflightVerificationContext {
  readonly resolver: ResolverManifest;
  readonly capabilitySnapshot?: CapabilitySnapshot;
}

const EVIDENCE_READINESS_DIMENSIONS: readonly PolicyDimension[] = [
  "execution",
  "observedEffects",
  "dataBinding",
  "settlement",
  "finality",
];

function anyReadyClaim(result: PreflightResult): boolean {
  return EVIDENCE_READINESS_DIMENSIONS.some(
    (dimension) => result.evidenceReadiness[dimension].status === "ready",
  );
}

/**
 * Positive-readiness derivation (R3 + freeze-final provenance binding): a
 * `ready` dimension check must be DERIVABLE from the supplied
 * CapabilitySnapshot / ResolverManifest context and its cited provenance.
 * Derivable means ALL of:
 *
 *   1. the snapshot's capability state for that dimension is USABLE
 *      (supported + available + non-empty citations resolving against the
 *      snapshot's validated evidence table),
 *   2. the capability is listed in manifest.supportedCapabilities,
 *   3. the readiness check's own citations are a NON-EMPTY SUBSET of that
 *      validated CapabilityState evidence set — a ready conclusion may cite
 *      only the relevant subset of a larger capability observation, but it
 *      may never cite an unrelated EvidenceRef, an empty set, or evidence
 *      outside the provenance that justifies the usable capability.
 *
 * If generic core cannot derive the claim, the check must not say "ready".
 */
function assertReadinessDerivable(
  result: PreflightResult,
  snapshot: CapabilitySnapshot,
  resolver: ResolverManifest,
): void {
  const manifestCapabilities = new Set<string>(resolver.supportedCapabilities);
  for (const dimension of EVIDENCE_READINESS_DIMENSIONS) {
    const check = result.evidenceReadiness[dimension];
    if (check.status !== "ready") continue;
    const state = (snapshot.evidenceCapabilities as unknown as Record<string, unknown>)[
      dimension as string
    ] as import("./types.js").CapabilityState | undefined;
    const derivable =
      state !== undefined &&
      capabilityIsUsable(state, snapshot.evidence) &&
      manifestCapabilities.has(dimension as string);
    if (!derivable) {
      throw new NecValidationError(
        "NEC_VALIDATION_FAILED",
        `evidenceReadiness.${dimension}: "ready" cannot be derived from the supplied capability context (unsupported-by-manifest, unproven, or absent capability state); unknown, not ready`,
      );
    }
    // PROVENANCE BINDING (freeze-final): the readiness conclusion must cite
    // the provenance that justifies the usable capability.
    const capabilityEvidence = state.evidence ?? [];
    const cited = check.evidence ?? [];
    if (
      cited.length === 0 ||
      !cited.every((id) => capabilityEvidence.includes(id))
    ) {
      throw new NecValidationError(
        "NEC_VALIDATION_FAILED",
        `evidenceReadiness.${dimension}: "ready" citations must be a NON-EMPTY SUBSET of the capability state's validated evidence ${JSON.stringify(capabilityEvidence)} used to derive readiness; got ${JSON.stringify(cited)}`,
      );
    }
  }
}

function verifyPreflightContext(
  result: PreflightResult,
  context: PreflightVerificationContext,
): void {
  validateResolverManifest(context.resolver);
  refEquals(
    result.resolver as unknown as Record<string, unknown>,
    {
      id: context.resolver.id,
      version: context.resolver.version,
      digest: context.resolver.digest,
    },
    ["id", "version", "digest"],
    "resolver",
  );

  const needsSnapshot = result.capabilitySnapshot !== undefined || anyReadyClaim(result);
  if (needsSnapshot && context.capabilitySnapshot === undefined) {
    throw new NecValidationError(
      "NEC_VALIDATION_FAILED",
      "the preflight result references a capability snapshot or claims positive readiness; the COMPLETE CapabilitySnapshot is required in the context",
    );
  }
  if (context.capabilitySnapshot === undefined) return;

  const snapshot = context.capabilitySnapshot;
  validateCapabilitySnapshot(snapshot);
  if (result.capabilitySnapshot === undefined) {
    throw new NecValidationError(
      "NEC_VALIDATION_FAILED",
      "a capability snapshot was supplied but the preflight result does not reference any",
    );
  }
  const ref = result.capabilitySnapshot;
  if (ref.id !== snapshot.id || ref.digest !== snapshot.artifactDigest) {
    throw new NecValidationError(
      "NEC_VALIDATION_FAILED",
      "preflight capabilitySnapshot reference does not match the supplied CapabilitySnapshot (id/artifactDigest)",
    );
  }
  // R3: FULL fingerprint equality — the snapshot IS the context.
  if (canonicalJson(snapshot.network) !== canonicalJson(result.network)) {
    throw new NecValidationError(
      "NEC_VALIDATION_FAILED",
      "capability snapshot network fingerprint is not canonically equal to the preflight result network context (full fingerprint equality required)",
    );
  }
  const r = snapshot.resolver;
  if (r.id !== context.resolver.id || r.version !== context.resolver.version || r.digest !== context.resolver.digest) {
    throw new NecValidationError(
      "NEC_VALIDATION_FAILED",
      "capability snapshot resolver does not match the provided resolver manifest",
    );
  }
  assertSnapshotAgreesWithManifest(snapshot, context.resolver);
  assertReadinessDerivable(result, snapshot, context.resolver);
}

function verifyPreflightResultOrThrow(
  result: PreflightResult,
  context: PreflightVerificationContext,
): void {
  validatePreflightResult(result);
  verifyPreflightContext(result, context);
}

/**
 * THE contextual claim verifier for preflight results (R3): structural
 * validation + self-digest + complete contextual verification. The context
 * parameter is REQUIRED (complete ResolverManifest; complete
 * CapabilitySnapshot whenever the result references one or claims any
 * positive readiness).
 */
export function verifyPreflightResult(
  result: PreflightResult,
  context: PreflightVerificationContext,
): boolean {
  try {
    verifyPreflightResultOrThrow(result, context);
    return true;
  } catch {
    return false;
  }
}

export function verifyPreflightResultIntegrity(result: PreflightResult): boolean {
  try {
    validatePreflightResult(result);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build a frozen, validated PreflightResult. R3 + freeze-final:
 *   - the COMPLETE verification context is a REQUIRED argument (no optional
 *     overload, no compatibility shim): the complete ResolverManifest
 *     always, plus the complete CapabilitySnapshot whenever the result
 *     references one or claims any positive readiness;
 *   - the caller NEVER authors the overall `status`: the builder recomputes
 *     it with the normative composer (a caller-supplied `status` field is
 *     rejected like a self-digest — `PreflightResultContent`, the builder-
 *     input type, does not even carry `status`/`artifactDigest`);
 *   - the caller's content is DEFENSIVELY CLONED (descriptor-first, before
 *     any field read) so no getter can execute and no caller-owned object
 *     is ever frozen;
 *   - positive readiness must be DERIVABLE from the capability context and
 *     its citations must be a non-empty subset of the justifying
 *     capability-state evidence.
 */
export function buildPreflightResult(
  content: PreflightResultContent,
  context: PreflightBuildContext,
): PreflightResult {
  if (context === undefined || context === null) {
    throw new NecValidationError(
      "NEC_VALIDATION_FAILED",
      "preflight result builder requires the COMPLETE verification context (ResolverManifest; CapabilitySnapshot whenever one is referenced or any readiness is claimed); structural validation alone is available through validatePreflightResult / verifyPreflightResultIntegrity",
    );
  }
  // DEFENSIVE CLONE FIRST (freeze-final): the descriptor-first cloner
  // rejects accessors/symbols/exotic prototypes WITHOUT ever invoking a
  // getter, and every later field read (status composition, self-digest
  // rejection, digest projection) sees only the fresh NEC-owned copy.
  const cloned = defensiveClone(content) as PreflightResultContent;
  rejectSelfDigestFields(
    cloned as object,
    ["artifactDigest", "status"],
    "preflight result content",
  );

  // Recompute the overall status from checks + blockers + the bound
  // policy's REQUIRED dimensions. The caller does not author it.
  const composedStatus = composePreflightStatus({
    evidenceReadiness: cloned.evidenceReadiness,
    blockers: cloned.blockers,
    requiredDimensions: cloned.request.evidencePolicy.requiredDimensions,
  });

  const draft = {
    ...cloned,
    status: composedStatus,
    artifactDigest: DIGEST_PLACEHOLDER,
  } as PreflightResult;
  const artifact = computePreflightResultDigest(draft);
  assertComputedDigest(artifact, "artifactDigest");
  const full = { ...draft, artifactDigest: artifact };
  validatePreflightResult(full);

  // Positive readiness requires complete capability context to derive.
  const needsSnapshot = anyReadyClaim(full);
  if (needsSnapshot && context.capabilitySnapshot === undefined) {
    throw new NecValidationError(
      "NEC_VALIDATION_FAILED",
      'a readiness check claims "ready" but no complete CapabilitySnapshot context was supplied; readiness must be derivable from the supplied capability/resolver context',
    );
  }
  if (context.capabilitySnapshot !== undefined && context.resolver === undefined) {
    throw new NecValidationError(
      "NEC_VALIDATION_FAILED",
      "preflight context: a capability snapshot was supplied without the COMPLETE ResolverManifest it must be verified against",
    );
  }
  // Full contextual verification ALWAYS runs: the resolver is required, the
  // snapshot whenever referenced/needed (checked above).
  verifyPreflightContext(full, {
    resolver: context.resolver,
    capabilitySnapshot: context.capabilitySnapshot,
  });
  return deepFreeze(full);
}

// ---------------------------------------------------------------------------
// Defensive cloning (descriptor-first, bounded, prototype-safe)
// ---------------------------------------------------------------------------

interface CloneState {
  readonly ancestors: Set<object>;
  nodes: number;
  depth: number;
}

function cloneFail(reason: string): never {
  throw new NecValidationError("NEC_VALIDATION_FAILED", reason);
}

/**
 * Cycle-detecting, resource-bounded deep copy of plain data.
 *
 * THE ROOT AND EVERY NESTED CONTAINER must be a fresh-owned-constructible
 * plain object (prototype `Object.prototype` or null) or an INERT array —
 * exotic / custom-prototype objects are REJECTED here, BEFORE any spread,
 * property read or getter could run. Nothing caller-owned ever enters the
 * cloned graph by reference, so `deepFreeze` afterwards can only freeze
 * fresh containers built by this function.
 *
 * Plain objects are recreated with NULL prototypes and arrays element by
 * element, so an ordinary own key "__proto__" stays ordinary DATA (never
 * prototype mutation); primitives and bigints are copied by value.
 *
 * Property DESCRIPTORS are inspected before any value is read, so an
 * accessor is rejected WITHOUT ever being invoked; symbol-keyed (including
 * own Symbol.iterator overrides) and non-enumerable properties are
 * rejected, not dropped; sparse/holey arrays, array extra properties and
 * array subclasses fail closed; cycles and limit violations throw before
 * any freezing happens. Depth and node budgets (`nec-resource-limits-v0.1`)
 * guarantee a controlled NEC error long before any RangeError is possible.
 */
function defensiveClone<T>(value: T, state?: CloneState): T {
  if (state === undefined) {
    if (value === null || typeof value !== "object") {
      return value;
    }
    const rootProto: unknown = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && rootProto !== Object.prototype && rootProto !== null) {
      cloneFail(
        "root object must be a plain object (custom-prototype roots are rejected before any spread or read); " +
          "hostile transport boundaries hand over parsed inert data, never live Proxy/exotic objects",
      );
    }
    return defensiveCloneInner(value, { ancestors: new Set(), nodes: 0, depth: 1 });
  }
  return defensiveCloneInner(value, state);
}

function defensiveCloneInner<T>(value: T, state: CloneState): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (state.ancestors.has(value)) {
    cloneFail("input contains a circular reference");
  }
  state.nodes += 1;
  if (state.nodes > RESOURCE_LIMITS.MAX_TOTAL_NODES) {
    cloneFail(`input exceeds MAX_TOTAL_NODES (${RESOURCE_LIMITS.MAX_TOTAL_NODES})`);
  }
  if (state.depth > RESOURCE_LIMITS.MAX_DEPTH) {
    cloneFail(
      `input exceeds MAX_DEPTH (${RESOURCE_LIMITS.MAX_DEPTH}); refusing to recurse toward a RangeError`,
    );
  }
  const deviation = firstArrayDeviation(value);
  if (deviation === null) {
    // Inert array: element-wise copy via descriptor/index access only.
    const source = value as unknown[];
    state.ancestors.add(value);
    try {
      const copy: unknown[] = [];
      for (let i = 0; i < source.length; i++) {
        const d = Object.getOwnPropertyDescriptor(source, i);
        if (d === undefined) cloneFail("sparse/holey arrays cannot be cloned");
        state.depth += 1;
        try {
          copy.push(defensiveCloneInner(d.value as T, state));
        } finally {
          state.depth -= 1;
        }
      }
      return copy as unknown as T;
    } finally {
      state.ancestors.delete(value);
    }
  }
  if (Array.isArray(value)) {
    cloneFail(`only ordinary inert dense arrays can be cloned: ${deviation}`);
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    cloneFail(
      "nested object with custom prototype must be a plain object; " +
        "exotic instances cannot enter a builder graph",
    );
  }
  state.ancestors.add(value);
  try {
    const source = value as Record<string, unknown>;
    const descriptors = Object.getOwnPropertyDescriptors(source) as Record<string, PropertyDescriptor>;
    // Null-prototype record: assigning "__proto__" creates ordinary data.
    const copy: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key === "symbol") {
        cloneFail(`symbol-keyed properties (${String(key)}); failing closed`);
      }
      const d = descriptors[key]!;
      if (d.get !== undefined || d.set !== undefined) {
        cloneFail(`property "${key}" is an accessor; refusing to invoke it — plain data required`);
      }
      if (!d.enumerable) {
        cloneFail(`property "${key}" is non-enumerable; plain enumerable data required`);
      }
      state.depth += 1;
      try {
        copy[key] = defensiveCloneInner(d.value as T, state);
      } finally {
        state.depth -= 1;
      }
    }
    return copy as T;
  } finally {
    state.ancestors.delete(value);
  }
}

/** Canonical form of any NEC value under nec-canonical-json-v1 (re-exported convenience). */
export function canonicalNecJson(value: unknown): string {
  return canonicalJson(value);
}
