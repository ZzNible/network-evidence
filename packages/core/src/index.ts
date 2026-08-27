/**
 * NEC v0.1 core — public API.
 *
 * Pure, deterministic semantics shared by all future NEC resolvers:
 * contracts, verdict/applicability/conflict/capability composition,
 * canonicalization (`nec-canonical-json-v1`), domain-separated digests
 * (`nec-digest-v1`), the wire profile (`nec-wire-json-v1`), complete
 * fail-closed validation for every public data contract, and immutable
 * contextual artifact builders.
 *
 * This package owns no I/O of any kind: no network, filesystem, clock,
 * randomness, wallet, database, or payment-protocol code.
 */

// Contracts
export * from "./types.js";

// Errors
export {
  NecError,
  NecValidationError,
  NecCanonicalizationError,
  NecDigestError,
  NecWireError,
} from "./errors.js";

// Resource bounds (`nec-resource-limits-v0.1`)
export { RESOURCE_LIMITS_PROFILE, RESOURCE_LIMITS, MAX_DECIMAL_INTEGER_DIGITS } from "./limits.js";

// Canonicalization + digests
export {
  CANONICAL_JSON_PROFILE,
  canonicalJson,
  canonicalJsonBytes,
  assertCanonicalizable,
} from "./canonical-json.js";
export {
  DIGEST_PROFILE,
  DIGEST_DOMAINS,
  digestBytes,
  digestCanonicalJson,
  isDigest,
} from "./digest.js";
export type { DigestDomain } from "./digest.js";

// Applicability + enum guards
export {
  APPLICABILITIES,
  CAPABILITY_NAMES,
  EVIDENCE_DIMENSION_NAMES,
  EVIDENCE_VERDICTS,
  EVIDENCE_BASES,
  POLICY_DIMENSIONS,
  CAPABILITY_SUPPORTS,
  CAPABILITY_AVAILABILITIES,
  isApplicability,
  isCapabilityName,
  isPolicyDimension,
  isEvidenceDimensionName,
  isEvidenceVerdict,
  isEvidenceBasis,
  isCapabilitySupport,
  isCapabilityAvailability,
  combineApplicability,
} from "./applicability.js";

// Verdict composition (THE normative applicability/verdict state machine)
export {
  COMPOSITION_WARNING_CODES,
  composeVerdict,
  composeProposition,
  assertNormativePropositionState,
} from "./verdict.js";
export type { VerdictInput, ComposeOptions, ComposedProposition } from "./verdict.js";

// Conflicts + warnings + proposition scope semantics
export {
  isMaterialConflict,
  blockingConflicts,
  hasBlockingMaterialConflict,
  isPropositionScope,
  samePropositionScope,
  conflictAffectsProposition,
  mergeConflicts,
  mergeWarnings,
} from "./conflict.js";

// Capability + preflight status semantics
export {
  capabilityIsUsable,
  capabilityIsDeterministicallyUnavailable,
} from "./capabilities.js";
export type { EvidenceIndexInput } from "./capabilities.js";
export {
  EVIDENCE_READINESS_KEYS,
  composePreflightStatus,
  toPreflightResultRef,
} from "./preflight.js";

// Discovery: THE one normative evaluation/classification composer
export { composeDiscoveryMatch } from "./discovery.js";
export type { DiscoveryCandidate, DiscoveryComposition } from "./discovery.js";

// Validation (every public data contract; accepts unknown; fails closed)
export {
  RESERVED_METADATA_KEYS,
  deepFreeze,
  assertNonEmptyString,
  assertBoundedIdentifier,
  assertNecIdentifier,
  isNecIdentifier,
  assertNetworkId,
  assertNativeId,
  assertHex,
  assertIso8601,
  assertDigestShape,
  assertSchemaVersion,
  assertSafePositiveInteger,
  assertPlainRecord,
  validateNetworkAnchor,
  validateNetworkFingerprint,
  validateEvidenceRef,
  validateNativeSourcePayload,
  validateEvidenceDimension,
  validateObservedEffect,
  validatePropositionScope,
  validateConflict,
  validateWarning,
  validateSubjectRef,
  validateResolverManifestRef,
  validateResolverManifest,
  validateCapabilityState,
  validateEvidenceCapabilitySet,
  validateExecutionCapabilitySet,
  validateCapabilitySnapshotRef,
  validateCapabilitySnapshot,
  validateCapabilityRequirement,
  validateDiscoveryRequirements,
  validateRequirementEvaluation,
  validateNetworkDiscoveryMatch,
  validateDiscoverNetworksResult,
  validateEvidencePolicy,
  validateEvidencePolicyRef,
  validateEvidenceSnapshotRef,
  validateActionDescriptor,
  validatePreflightRequest,
  validateReadinessCheck,
  validatePreflightResult,
  validateEvidenceAnchor,
  validateEvidenceSnapshot,
  validateNetworkEvidenceResult,
  validateEvidenceRequest,
  validateResolverContext,
  validatePreflightFragment,
  validateNetworkEvidenceFragment,
} from "./validate.js";

// Digest computation over canonically-ordered projections
export {
  computeEvidencePolicyDigest,
  computeEvidenceRequestDigest,
  computeResolverManifestDigest,
  computeEvidenceSnapshotDigest,
  computeNetworkEvidenceResultSemanticDigest,
  computeNetworkEvidenceResultArtifactDigest,
  computeCapabilitySnapshotDigest,
  computeDiscoverNetworksResultDigest,
  computePreflightResultDigest,
} from "./digests.js";
export type {
  NetworkEvidenceResultContent,
  CapabilitySnapshotContent,
  DiscoverNetworksResultContent,
  PreflightResultContent,
} from "./digests.js";

// Contextual artifact construction + integrity/claim verification
export {
  buildNetworkEvidenceResult,
  verifyNetworkEvidenceContext,
  verifyNetworkEvidenceResult,
  verifyNetworkEvidenceResultIntegrity,
  verifyNetworkEvidenceResultSemantics,
  buildEvidenceSnapshot,
  verifyEvidenceSnapshotIntegrity,
  buildCapabilitySnapshot,
  verifyCapabilitySnapshot,
  verifyCapabilitySnapshotIntegrity,
  buildDiscoverNetworksResult,
  verifyDiscoverNetworksResult,
  verifyDiscoverNetworksResultIntegrity,
  buildPreflightResult,
  verifyPreflightResult,
  verifyPreflightResultIntegrity,
  canonicalNecJson,
} from "./result.js";
export type {
  NetworkEvidenceBuildContext,
  EvidenceSnapshotBuildContext,
  CapabilitySnapshotBuildContext,
  DiscoverNetworksBuildContext,
  DiscoverNetworksVerificationContext,
  PreflightBuildContext,
  PreflightVerificationContext,
} from "./result.js";

// Native source payload boundary
export { decodeBase64Strict, nativeSourceContentDigest, verifyNativeSourceDigest } from "./native.js";

// Wire profile (`nec-wire-json-v1`)
export {
  WIRE_PROFILE,
  MAX_WIRE_DECIMAL_DIGITS,
  parseNecWireJson,
  encodeNecWireJson,
  decodeNecWireJson,
} from "./wire.js";
export type { NecWireType, NecWireDecoded } from "./wire.js";
