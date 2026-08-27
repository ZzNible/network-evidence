import type {
  Applicability,
  CapabilityAvailability,
  CapabilityName,
  CapabilitySupport,
  EvidenceBasis,
  EvidenceDimensionName,
  EvidenceVerdict,
  PolicyDimension,
} from "./types.js";

/**
 * Enum value guards and applicability composition.
 *
 * All guards are total and fail closed: any string outside the frozen
 * NEC_CONTRACTS_v0.1 vocabulary returns false / throws at call sites that
 * require a valid value. Never extend these arrays without changing the
 * contracts document first.
 */

export const APPLICABILITIES: readonly Applicability[] = [
  "applicable",
  "not_applicable",
  "unknown",
] as const;

export const EVIDENCE_DIMENSION_NAMES: readonly EvidenceDimensionName[] = [
  "execution",
  "dataBinding",
  "settlement",
  "finality",
] as const;

export const EVIDENCE_VERDICTS: readonly EvidenceVerdict[] = [
  "supported",
  "contradicted",
  "insufficient",
  "ambiguous",
] as const;

export const EVIDENCE_BASES: readonly EvidenceBasis[] = [
  "source_observation",
  "deterministic_derivation",
  "local_content_verification",
  "local_consensus_engine",
  "cryptographic_verification",
] as const;

export const CAPABILITY_SUPPORTS: readonly CapabilitySupport[] = [
  "supported",
  "conditional",
  "unsupported",
  "unknown",
] as const;

export const CAPABILITY_AVAILABILITIES: readonly CapabilityAvailability[] = [
  "available",
  "degraded",
  "unavailable",
  "unknown",
] as const;

/**
 * CLOSED v0.1 capability vocabulary (evidence family + execution family).
 * It is the exact set of capability slots represented by
 * `CapabilitySnapshot`. Unknown capability strings fail closed everywhere.
 */
export const CAPABILITY_NAMES: readonly CapabilityName[] = [
  "execution",
  "observedEffects",
  "dataBinding",
  "settlement",
  "finality",
  "executionModel",
  "accountModel",
  "gasModel",
  "simulation",
  "batching",
] as const;

/** CLOSED v0.1 evidence-policy dimension vocabulary. */
export const POLICY_DIMENSIONS: readonly PolicyDimension[] = [
  "execution",
  "observedEffects",
  "dataBinding",
  "settlement",
  "finality",
] as const;

export function isApplicability(value: unknown): value is Applicability {
  return APPLICABILITIES.includes(value as Applicability);
}

export function isEvidenceDimensionName(value: unknown): value is EvidenceDimensionName {
  return EVIDENCE_DIMENSION_NAMES.includes(value as EvidenceDimensionName);
}

export function isEvidenceVerdict(value: unknown): value is EvidenceVerdict {
  return EVIDENCE_VERDICTS.includes(value as EvidenceVerdict);
}

export function isEvidenceBasis(value: unknown): value is EvidenceBasis {
  return EVIDENCE_BASES.includes(value as EvidenceBasis);
}

export function isCapabilitySupport(value: unknown): value is CapabilitySupport {
  return CAPABILITY_SUPPORTS.includes(value as CapabilitySupport);
}

export function isCapabilityAvailability(value: unknown): value is CapabilityAvailability {
  return CAPABILITY_AVAILABILITIES.includes(value as CapabilityAvailability);
}

export function isCapabilityName(value: unknown): value is CapabilityName {
  return (CAPABILITY_NAMES as readonly string[]).includes(value as string);
}

export function isPolicyDimension(value: unknown): value is PolicyDimension {
  return (POLICY_DIMENSIONS as readonly string[]).includes(value as string);
}

/**
 * Combine applicability of parts into the applicability of a whole:
 *   - any part `unknown`            -> `unknown`
 *   - all parts `not_applicable`    -> `not_applicable`
 *   - otherwise (some applicable)   -> `applicable`
 *
 * This keeps `not_applicable` strictly distinct from `insufficient`:
 * inapplicable parts never degrade an applicable proposition, and an
 * undecidable part forces `unknown`, not a verdict.
 */
export function combineApplicability(a: Applicability, b: Applicability): Applicability {
  if (a === "not_applicable" && b === "not_applicable") return "not_applicable";
  if (a === "unknown" || b === "unknown") return "unknown";
  return "applicable";
}
