import type {
  PolicyDimension,
  PreflightBlocker,
  PreflightResult,
  PreflightResultRef,
  PreflightStatus,
  ReadinessCheck,
} from "./types.js";

/**
 * Deterministic PREFLIGHT STATUS composition (v0.1 freeze, R3).
 *
 * The overall status of a `PreflightResult` is a pure function of its
 * evidence readiness checks, its blockers, and the REQUIRED dimensions of
 * the bound evidence policy. Callers NEVER author the overall status: the
 * builder recomputes it and validators reject any artifact whose stored
 * status differs.
 *
 * Generic preflight means exactly one question: "Can NEC obtain the
 * evidence REQUIRED by this EvidencePolicy for THIS action on THIS network
 * under the supplied capability/resolver context?" NEC does NOT own
 * wallet/account readiness, funding, gas acquisition, signing, transaction
 * submission or generic execution simulation — those concepts were REMOVED
 * from the v0.1 contract (R3). Only per-policy-dimension evidence readiness
 * remains, and DESIRED dimensions never prevent `ready`; their individual
 * readiness stays visible in `evidenceReadiness`.
 *
 * NORMATIVE TRUTH TABLE (evaluated in order, first match wins):
 *
 *   1. any blocker                                        -> "blocked"
 *   2. any REQUIRED dimension check "blocked"             -> "blocked"
 *   3. any REQUIRED dimension check "not_applicable"
 *      (definite policy infeasibility: required by the
 *      caller, denied by the resolver)                    -> "blocked"
 *   4. otherwise, any REQUIRED dimension "unknown"        -> "unknown"
 *      (if generic core cannot derive readiness, it is
 *      unknown — never silently ready)
 *   5. otherwise every REQUIRED dimension is "ready"
 *      (vacuously true when nothing is required)          -> "ready"
 *
 * Consequences:
 *   - required + blocked / not_applicable  -> blocked
 *   - required + unknown                   -> unknown (never ready)
 *   - desired dimensions NEVER affect the overall status
 *   - blockers can never coexist with an overall "ready" status
 */

export const EVIDENCE_READINESS_KEYS = [
  "execution",
  "observedEffects",
  "dataBinding",
  "settlement",
  "finality",
] as const;

/**
 * Compose the deterministic overall preflight status from evidence
 * readiness, blockers and the bound policy's REQUIRED dimensions. The
 * REQUIRED dimensions are a REQUIRED argument: there is no structural-only
 * composition of full artifacts (callers without a policy have no question
 * to answer). Validation rejects any stored status that differs.
 */
export function composePreflightStatus(input: {
  evidenceReadiness: PreflightResult["evidenceReadiness"];
  blockers: readonly PreflightBlocker[];
  /** REQUIRED dimensions of the bound evidence policy (policy-aware gate). */
  requiredDimensions: readonly PolicyDimension[];
}): PreflightStatus {
  if (input.blockers.length > 0) return "blocked";
  const requiredChecks = input.requiredDimensions.map(
    (dimension) => input.evidenceReadiness[dimension],
  );
  if (requiredChecks.some((check) => check.status === "blocked")) return "blocked";
  if (requiredChecks.some((check) => check.status === "not_applicable")) return "blocked";
  if (requiredChecks.some((check) => check.status === "unknown")) return "unknown";
  // Every REQUIRED dimension check is "ready" here; with no required
  // dimensions this vacuously yields ready (desired states never gate).
  return "ready";
}

/**
 * THE one way to reference a built preflight result:
 * `{ requestId: result.request.requestId, digest: artifactDigest }`. The
 * preflight REQUEST id is the only preflight-request identity; two
 * preflights for the same request share it and are distinguished by digest.
 */
export function toPreflightResultRef(result: PreflightResult): PreflightResultRef {
  return { requestId: result.request.requestId, digest: result.artifactDigest };
}
