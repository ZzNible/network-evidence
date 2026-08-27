import { capabilityIsDeterministicallyUnavailable, capabilityIsUsable } from "./capabilities.js";
import { canonicalJson } from "./canonical-json.js";
import { NecValidationError } from "./errors.js";
import { validateCapabilitySnapshot, validateDiscoveryRequirements, validateNetworkFingerprint, validateResolverManifest } from "./validate.js";
import type {
  CapabilitySnapshot,
  CapabilityState,
  DiscoveryClassification,
  DiscoveryRequirements,
  NetworkFingerprint,
  RequirementEvaluation,
  ResolverManifest,
} from "./types.js";

/**
 * THE one normative DISCOVERY evaluation/classification composer (v0.1
 * freeze, R3 revision). Builders and validators share this function so
 * discovery classification is never caller-authored arbitrary truth: given a
 * request, a candidate network and the COMPLETE CapabilitySnapshot (+
 * resolver manifest) behind it, the classification is a pure, deterministic
 * function. No probabilistic scoring, no weighted majority, no "probably
 * eligible".
 *
 * COHERENCE GATE (fail closed before any evaluation):
 *   - the snapshot's network fingerprint must be CANONICALLY EQUAL to the
 *     candidate network (R3: same networkId alone is insufficient — the
 *     complete fingerprint is the context);
 *   - the snapshot's resolver reference must exactly match the provided
 *     manifest (id, version AND computed digest);
 *   - every capability claimed supported/conditional must be listed under
 *     manifest.supportedCapabilities — manifest membership permits
 *     EVALUATION only; it never proves support or availability.
 *
 * REQUIREMENT EVALUATION truth table (per requirement, against the
 * candidate's snapshot state for that capability; an absent optional slot
 * evaluates as unknown). Usability is CONTEXTUAL: citations must resolve
 * against the snapshot's validated evidence table:
 *
 *   satisfied   <=> capabilityIsUsable(state, snapshot.evidence)
 *                  (support=supported AND availability=available AND
 *                   non-empty evidence citations resolvable in the
 *                   snapshot evidence table)
 *   unsatisfied <=> NOT usable AND deterministically negative
 *                  (support=unsupported OR availability=unavailable/degraded)
 *   unknown     <=> everything else (unknown support/availability,
 *                  conditional support, positive claim without resolvable
 *                  cited evidence) — never silently promoted
 *
 * Evaluation `reason` fields are DETERMINISTIC composer output; contextual
 * verification requires stored evaluations to reproduce them exactly.
 *
 * CLASSIFICATION truth table (evaluated in order, first match wins):
 *
 *   1. network on the denylist                        -> "ineligible"
 *      (denylist wins over EVERYTHING, incl. the allowlist)
 *   2. allowlist non-empty and network not listed     -> "ineligible"
 *   3. any REQUIRED evaluation "unsatisfied"          -> "ineligible"
 *   4. any REQUIRED evaluation "unknown"              -> "ineligible"
 *      (REQUIRED + unknown is never silently eligible)
 *   5. all REQUIRED satisfied AND every DESIRED
 *      satisfied (vacuously true without desired)     -> "eligible"
 *   6. otherwise (all REQUIRED satisfied, some DESIRED
 *      unsatisfied or unknown)                        -> "conditional"
 *
 * Preferred/optional requirements affect only ranking/classification
 * between eligible and conditional — they can never rescue a failed or
 * unknown required capability.
 */

export interface DiscoveryCandidate {
  /** The candidate network's fingerprint (its `networkId` is the key). */
  readonly network: NetworkFingerprint;
  /** The COMPLETE CapabilitySnapshot probed for exactly this network. */
  readonly snapshot: CapabilitySnapshot;
  /** The COMPLETE ResolverManifest that produced/verified the snapshot. */
  readonly resolver: ResolverManifest;
}

export interface DiscoveryComposition {
  readonly classification: DiscoveryClassification;
  /** Exactly one evaluation per request requirement, in request order. */
  readonly evaluations: RequirementEvaluation[];
}

function fail(reason: string): never {
  throw new NecValidationError("NEC_VALIDATION_FAILED", reason);
}

/**
 * Compose the deterministic discovery outcome for ONE candidate network.
 * Fails closed unless the complete inputs are valid and mutually coherent:
 * the snapshot's network must equal the candidate network, and the
 * snapshot's resolver reference must exactly match the provided manifest
 * (id, version AND computed digest). A capability claimed
 * supported/conditional but missing from the manifest's
 * `supportedCapabilities` is incoherent and rejected.
 */
export function composeDiscoveryMatch(
  requirements: DiscoveryRequirements,
  candidate: DiscoveryCandidate,
): DiscoveryComposition {
  validateDiscoveryRequirements(requirements, "discovery.request");
  validateNetworkFingerprint(candidate.network, "discovery.candidate.network");
  validateCapabilitySnapshot(candidate.snapshot, "discovery.candidate.snapshot");
  validateResolverManifest(candidate.resolver, "discovery.candidate.resolver");

  if (canonicalJson(candidate.snapshot.network) !== canonicalJson(candidate.network)) {
    fail(
      `candidate snapshot network fingerprint ${JSON.stringify(
        canonicalJson(candidate.snapshot.network),
      )} is not canonically equal to the candidate network context ${JSON.stringify(
        canonicalJson(candidate.network),
      )} (full fingerprint equality required; same networkId alone is insufficient)`,
    );
  }
  const ref = candidate.snapshot.resolver;
  if (
    ref.id !== candidate.resolver.id ||
    ref.version !== candidate.resolver.version ||
    ref.digest !== candidate.resolver.digest
  ) {
    fail(
      "candidate snapshot resolver reference does not exactly match the provided resolver manifest (id/version/digest)",
    );
  }
  assertSnapshotAgreesWithManifest(candidate.snapshot, candidate.resolver);
  const supported = new Set<string>(candidate.resolver.supportedCapabilities);
  for (const [name, state] of Object.entries(candidate.snapshot.evidenceCapabilities)) {
    if ((state.support === "supported" || state.support === "conditional") && !supported.has(name)) {
      fail(
        `snapshot claims ${state.support} "${name}" but the resolver manifest does not list it under supportedCapabilities`,
      );
    }
  }
  for (const [name, state] of Object.entries(candidate.snapshot.executionCapabilities)) {
    if (
      state !== undefined &&
      (state.support === "supported" || state.support === "conditional") &&
      !supported.has(name)
    ) {
      fail(
        `snapshot claims ${state.support} "${name}" but the resolver manifest does not list it under supportedCapabilities`,
      );
    }
  }

  // Denylist wins over everything; a non-empty allowlist excludes unlisted networks.
  const networkId = candidate.network.networkId;
  if (requirements.networkDenylist?.includes(networkId)) {
    return { classification: "ineligible", evaluations: evaluateAll(requirements, candidate.snapshot) };
  }
  if (
    requirements.networkAllowlist !== undefined &&
    requirements.networkAllowlist.length > 0 &&
    !requirements.networkAllowlist.includes(networkId)
  ) {
    return { classification: "ineligible", evaluations: evaluateAll(requirements, candidate.snapshot) };
  }

  const evaluations = evaluateAll(requirements, candidate.snapshot);
  let requiredFailed = false;
  let requiredUnknown = false;
  let desiredUnsatisfiedOrUnknown = false;
  for (let i = 0; i < requirements.requirements.length; i++) {
    const status = evaluations[i]!.status;
    if (requirements.requirements[i]!.strength === "required") {
      if (status === "unsatisfied") requiredFailed = true;
      else if (status === "unknown") requiredUnknown = true;
    } else if (status !== "satisfied") {
      desiredUnsatisfiedOrUnknown = true;
    }
  }

  let classification: DiscoveryClassification;
  if (requiredFailed || requiredUnknown) {
    classification = "ineligible";
  } else if (!desiredUnsatisfiedOrUnknown) {
    classification = "eligible";
  } else {
    classification = "conditional";
  }
  return { classification, evaluations };
}

function stateFor(snapshot: CapabilitySnapshot, name: string): CapabilityState | undefined {
  const evidenceCaps = snapshot.evidenceCapabilities as unknown as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(evidenceCaps, name)) {
    return evidenceCaps[name] as CapabilityState | undefined;
  }
  const execCaps = snapshot.executionCapabilities as unknown as Record<string, unknown>;
  return execCaps[name] as CapabilityState | undefined;
}

/** Deterministic composer `reason` for each evaluation status (normative). */
const EVALUATION_REASONS = {
  satisfied: "capability is usable",
  unsatisfied: "capability is deterministically unavailable",
  unknownAbsent: "capability absent from the capability snapshot",
  unknownUnproven:
    "capability claim is not provably usable (unsupported-by-evidence or undetermined)",
} as const;

/**
 * R3 manifest-authority invariant, shared by the composer and the
 * capability snapshot builder/verifier: the COMPLETE ResolverManifest is
 * authoritative about what the resolver implementation knows how to
 * evaluate. A snapshot MUST NOT claim support == supported/conditional for
 * a capability absent from manifest.supportedCapabilities. Membership does
 * NOT prove support/availability — positive current claims still require
 * live provenance.
 */
export function assertSnapshotAgreesWithManifest(
  snapshot: CapabilitySnapshot,
  resolver: ResolverManifest,
): void {
  const supported = new Set<string>(resolver.supportedCapabilities);
  for (const [name, state] of Object.entries(snapshot.evidenceCapabilities)) {
    if ((state.support === "supported" || state.support === "conditional") && !supported.has(name)) {
      fail(
        `snapshot claims ${state.support} "${name}" but the resolver manifest does not list it under supportedCapabilities`,
      );
    }
  }
  for (const [name, state] of Object.entries(snapshot.executionCapabilities)) {
    if (
      state !== undefined &&
      (state.support === "supported" || state.support === "conditional") &&
      !supported.has(name)
    ) {
      fail(
        `snapshot claims ${state.support} "${name}" but the resolver manifest does not list it under supportedCapabilities`,
      );
    }
  }
}

function evaluateAll(
  requirements: DiscoveryRequirements,
  snapshot: CapabilitySnapshot,
): RequirementEvaluation[] {
  return requirements.requirements.map((requirement) => {
    const state = stateFor(snapshot, requirement.capability);
    if (state === undefined) {
      return {
        requirement,
        status: "unknown",
        reason: EVALUATION_REASONS.unknownAbsent,
      };
    }
    // Contextual usability: every citation must resolve in the snapshot's
    // validated evidence table.
    if (capabilityIsUsable(state, snapshot.evidence)) {
      return {
        requirement,
        status: "satisfied",
        reason: EVALUATION_REASONS.satisfied,
        ...(state.evidence !== undefined && state.evidence.length > 0
          ? { evidence: [...state.evidence] }
          : {}),
      };
    }
    if (capabilityIsDeterministicallyUnavailable(state)) {
      return {
        requirement,
        status: "unsatisfied",
        reason: EVALUATION_REASONS.unsatisfied,
        ...(state.evidence !== undefined && state.evidence.length > 0
          ? { evidence: [...state.evidence] }
          : {}),
      };
    }
    return {
      requirement,
      status: "unknown",
      reason: EVALUATION_REASONS.unknownUnproven,
      ...(state.evidence !== undefined && state.evidence.length > 0
        ? { evidence: [...state.evidence] }
        : {}),
    };
  });
}

export { EVALUATION_REASONS };
