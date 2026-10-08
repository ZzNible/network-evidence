/**
 * THE public Discovery orchestrator (v0.1): a thin, pure, deterministic layer
 * ABOVE @nec/core. It owns only input shape, presentation scope and output
 * ordering; every classification, evaluation and binding decision is
 * delegated to Core:
 *
 *   - `validateDiscoveryRequirements` validates the request;
 *   - `composeDiscoveryMatch` is the coherence gate for EVERY supplied
 *     candidate (network/snapshot/manifest binding, manifest authority) and
 *     the sole classification truth table for every scoped candidate;
 *   - `buildDiscoverNetworksResult` builds the digest-bound result and
 *     `verifyDiscoverNetworksResult` re-verifies it against the complete
 *     context before it is returned.
 *
 * ENVIRONMENT is presentation/scope metadata owned by this wrapper. It is
 * never inferred (not from network ids, source ids, labels, fixture names or
 * evidence metadata), never passed to Core and never read back from
 * evidence. It can only remove candidates from scope; it cannot change any
 * classification, evaluation or reason.
 *
 * The orchestrator does NOT choose a network: there is no score, rank,
 * recommendation or "best" field. The caller chooses externally and then
 * invokes the resolver-specific evidence preflight for its chosen network.
 * No network I/O, clock, wallet, signing, funding or submission.
 */

import {
  assertIso8601,
  buildDiscoverNetworksResult,
  composeDiscoveryMatch,
  deepFreeze,
  isNecIdentifier,
  validateDiscoveryRequirements,
  verifyDiscoverNetworksResult,
} from "@nec/core";
import type {
  CapabilitySnapshot,
  DiscoverNetworksResult,
  DiscoverNetworksVerificationContext,
  DiscoveryRequirements,
  Iso8601,
  NetworkDiscoveryMatch,
  NetworkFingerprint,
  NetworkId,
  ResolverManifest,
  ResolverManifestRef,
} from "@nec/core";

import { discoveryFail } from "./errors.js";
import type { NecDiscoveryErrorCode } from "./errors.js";

/** CLOSED presentation-only environment vocabulary. Never evidence. */
export const DISCOVERY_ENVIRONMENTS: readonly ["mainnet", "testnet"] = Object.freeze(["mainnet", "testnet"] as const);

export type DiscoveryEnvironment = (typeof DISCOVERY_ENVIRONMENTS)[number];

/**
 * ONE explicit caller-supplied candidate. `id` and `environment` are the
 * caller's presentation record; `network`, `manifest` and `snapshot` are the
 * complete, already-derived Core context (e.g. a resolver BEFORE foundation's
 * `network` / `manifest` / `snapshot`). Unknown fields fail closed.
 */
export interface DiscoveryCandidateContext {
  /** Presentation id (NEC identifier grammar), unique within the request. */
  readonly id: string;
  /** Presentation-only environment label; explicit, never inferred. */
  readonly environment: DiscoveryEnvironment;
  /** The candidate network fingerprint Core composes against. */
  readonly network: NetworkFingerprint;
  /** The COMPLETE ResolverManifest behind `snapshot.resolver`. */
  readonly manifest: ResolverManifest;
  /** The COMPLETE CapabilitySnapshot probed for exactly `network`. */
  readonly snapshot: CapabilitySnapshot;
}

/**
 * Optional explicit scope. Both filters are exact; when both are present a
 * candidate is in scope iff it passes both. Omitted filter = no restriction.
 */
export interface DiscoveryScope {
  /** Exact presentation ids; non-empty, unique, each must name a supplied candidate. */
  readonly candidateIds?: readonly string[];
  /** Presentation environments; non-empty, unique, from DISCOVERY_ENVIRONMENTS. */
  readonly environments?: readonly DiscoveryEnvironment[];
}

export interface DiscoverNetworksInput {
  /** Becomes `DiscoverNetworksResult.requestId` (NEC identifier grammar). */
  readonly requestId: string;
  /** Explicit result time (no clock is read); becomes `generatedAt`. */
  readonly generatedAt: Iso8601;
  readonly requirements: DiscoveryRequirements;
  readonly candidates: readonly DiscoveryCandidateContext[];
  readonly scope?: DiscoveryScope;
}

/** Per-candidate typed view over the verified Core result (no rewriting). */
export interface DiscoveryCandidateOutcome {
  readonly id: string;
  /** Echo of the caller's presentation label; never evidence. */
  readonly environment: DiscoveryEnvironment;
  readonly networkId: NetworkId;
  readonly resolver: ResolverManifestRef;
  /** THE Core match object, identical to `result.matches[i]`. */
  readonly match: NetworkDiscoveryMatch;
}

export interface AppliedDiscoveryScope {
  /** Normalized (sorted) candidate-id filter, or null when not supplied. */
  readonly candidateIds: readonly string[] | null;
  /** Normalized (sorted) environment filter, or null when not supplied. */
  readonly environments: readonly DiscoveryEnvironment[] | null;
  /** Supplied candidates evaluated into the result, sorted by id. */
  readonly inScopeCandidateIds: readonly string[];
  /** Supplied (and validated) candidates excluded by scope, sorted by id. */
  readonly outOfScopeCandidateIds: readonly string[];
}

export interface DiscoverNetworksOutcome {
  /** Core-built, Core-verified result; matches sorted by candidate id. */
  readonly result: DiscoverNetworksResult;
  /** One entry per in-scope candidate, in the same order as `result.matches`. */
  readonly candidates: readonly DiscoveryCandidateOutcome[];
  readonly scope: AppliedDiscoveryScope;
  /** Complete context to re-verify `result` with Core `verifyDiscoverNetworksResult`. */
  readonly verificationContext: DiscoverNetworksVerificationContext;
}

const INPUT_KEYS = ["requestId", "generatedAt", "requirements", "candidates", "scope"] as const;
const CANDIDATE_KEYS = ["id", "environment", "network", "manifest", "snapshot"] as const;
const SCOPE_KEYS = ["candidateIds", "environments"] as const;

/** UTF-16 code-unit order: THE one deterministic output order. */
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function plainRecord(
  value: unknown,
  path: string,
  allowed: readonly string[],
  required: readonly string[],
  code: NecDiscoveryErrorCode = "DISCOVERY_INPUT_INVALID",
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    discoveryFail(code, `${path} must be a plain object`);
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) discoveryFail(code, `${path} must be a plain object`);
  const out: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.includes(key)) {
      discoveryFail(code, `${path} has unknown field ${JSON.stringify(String(key))}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      discoveryFail(code, `${path}.${key} must be a data property`);
    }
    out[key] = descriptor.value;
  }
  for (const key of required) {
    if (!Object.hasOwn(out, key)) discoveryFail(code, `${path}.${key} is required`);
  }
  return out;
}

function plainList(value: unknown, path: string, code: NecDiscoveryErrorCode): unknown[] {
  if (!Array.isArray(value)) discoveryFail(code, `${path} must be an array`);
  const out: unknown[] = [];
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, i);
    if (descriptor === undefined || !("value" in descriptor)) {
      discoveryFail(code, `${path}[${i}] must be a present data element`);
    }
    out.push(descriptor.value);
  }
  return out;
}

function isEnvironment(value: unknown): value is DiscoveryEnvironment {
  return typeof value === "string" && (DISCOVERY_ENVIRONMENTS as readonly string[]).includes(value);
}

/** Core-detached, frozen copy of Core-validated plain data. */
function detach<T>(value: T): T {
  return deepFreeze(structuredClone(value)) as T;
}

interface ParsedScope {
  readonly candidateIds: readonly string[] | null;
  readonly environments: readonly DiscoveryEnvironment[] | null;
}

function parseScope(value: unknown, knownIds: ReadonlySet<string>): ParsedScope {
  if (value === undefined) return { candidateIds: null, environments: null };
  const scope = plainRecord(value, "scope", SCOPE_KEYS, [], "DISCOVERY_SCOPE_INVALID");
  let candidateIds: string[] | null = null;
  if (scope.candidateIds !== undefined) {
    const ids = plainList(scope.candidateIds, "scope.candidateIds", "DISCOVERY_SCOPE_INVALID");
    if (ids.length === 0) discoveryFail("DISCOVERY_SCOPE_INVALID", "scope.candidateIds must be non-empty when supplied");
    const seen = new Set<string>();
    for (const [i, id] of ids.entries()) {
      if (typeof id !== "string") discoveryFail("DISCOVERY_SCOPE_INVALID", `scope.candidateIds[${i}] must be a string`);
      if (seen.has(id)) discoveryFail("DISCOVERY_SCOPE_INVALID", `scope.candidateIds[${i}] duplicates ${JSON.stringify(id)}`);
      seen.add(id);
      if (!knownIds.has(id)) {
        discoveryFail(
          "DISCOVERY_SCOPE_UNKNOWN_CANDIDATE",
          `scope.candidateIds[${i}] ${JSON.stringify(id)} names no supplied candidate (exact match required)`,
        );
      }
    }
    candidateIds = [...seen].sort(compareIds);
  }
  let environments: DiscoveryEnvironment[] | null = null;
  if (scope.environments !== undefined) {
    const envs = plainList(scope.environments, "scope.environments", "DISCOVERY_SCOPE_INVALID");
    if (envs.length === 0) discoveryFail("DISCOVERY_SCOPE_INVALID", "scope.environments must be non-empty when supplied");
    const seen = new Set<DiscoveryEnvironment>();
    for (const [i, env] of envs.entries()) {
      if (!isEnvironment(env)) {
        discoveryFail(
          "DISCOVERY_ENVIRONMENT_INVALID",
          `scope.environments[${i}] must be one of ${JSON.stringify(DISCOVERY_ENVIRONMENTS)}`,
        );
      }
      if (seen.has(env)) discoveryFail("DISCOVERY_SCOPE_INVALID", `scope.environments[${i}] duplicates ${JSON.stringify(env)}`);
      seen.add(env);
    }
    environments = [...seen].sort(compareIds);
  }
  return { candidateIds, environments };
}

/**
 * Discover over an EXPLICIT candidate set. Pure and deterministic: the output
 * depends only on the input values, never on candidate input order. Fails
 * closed with `NecDiscoveryError` on any invalid, ambiguous or incoherent
 * input; Core errors are preserved as `cause`.
 *
 * Every supplied candidate is validated through Core (in or out of scope).
 * An empty scoped set yields a valid, Core-verified result with no matches.
 */
export function discoverNetworks(input: DiscoverNetworksInput): DiscoverNetworksOutcome {
  const root = plainRecord(input, "input", INPUT_KEYS, ["requestId", "generatedAt", "requirements", "candidates"]);
  if (!isNecIdentifier(root.requestId)) {
    discoveryFail("DISCOVERY_INPUT_INVALID", "input.requestId must match the NEC identifier grammar");
  }
  const requestId = root.requestId;
  try {
    assertIso8601(root.generatedAt, "input.generatedAt");
  } catch (error) {
    discoveryFail("DISCOVERY_INPUT_INVALID", "input.generatedAt must be an ISO-8601 timestamp", error);
  }
  const generatedAt = root.generatedAt as Iso8601;
  try {
    validateDiscoveryRequirements(root.requirements, "input.requirements");
  } catch (error) {
    discoveryFail("DISCOVERY_REQUIREMENTS_INVALID", "Core rejected input.requirements", error);
  }
  const requirements = detach(root.requirements as DiscoveryRequirements);

  // 1. Presentation records: exact shape, unique ids, explicit environment.
  const contexts: DiscoveryCandidateContext[] = [];
  const ids = new Set<string>();
  for (const [i, raw] of plainList(root.candidates, "input.candidates", "DISCOVERY_INPUT_INVALID").entries()) {
    const c = plainRecord(raw, `input.candidates[${i}]`, CANDIDATE_KEYS, CANDIDATE_KEYS);
    if (!isNecIdentifier(c.id)) {
      discoveryFail("DISCOVERY_CANDIDATE_ID_INVALID", `input.candidates[${i}].id must match the NEC identifier grammar`);
    }
    if (ids.has(c.id)) discoveryFail("DISCOVERY_CANDIDATE_ID_DUPLICATE", `duplicate candidate id ${JSON.stringify(c.id)}`);
    ids.add(c.id);
    if (!isEnvironment(c.environment)) {
      discoveryFail(
        "DISCOVERY_ENVIRONMENT_INVALID",
        `candidate ${JSON.stringify(c.id)}: environment must be one of ${JSON.stringify(DISCOVERY_ENVIRONMENTS)} (explicit; never inferred)`,
      );
    }
    contexts.push(c as unknown as DiscoveryCandidateContext);
  }
  // Deterministic processing order (independent of input order).
  contexts.sort((a, b) => compareIds(a.id, b.id));

  // 2. Core binding gate for EVERY supplied candidate, then detach.
  const bound = contexts.map((context) => {
    try {
      composeDiscoveryMatch(requirements, {
        network: context.network,
        snapshot: context.snapshot,
        resolver: context.manifest,
      });
    } catch (error) {
      discoveryFail(
        "DISCOVERY_CANDIDATE_BINDING_INVALID",
        `candidate ${JSON.stringify(context.id)}: Core rejected the network/snapshot/manifest binding`,
        error,
      );
    }
    return {
      id: context.id,
      environment: context.environment,
      network: detach(context.network),
      manifest: detach(context.manifest),
      snapshot: detach(context.snapshot),
    };
  });

  // 3. Cross-candidate coherence the Core result/verification context needs.
  const networks = new Map<string, string>();
  const snapshotIds = new Map<string, string>();
  const manifests = new Map<string, ResolverManifest>();
  for (const candidate of bound) {
    const networkId = candidate.network.networkId;
    const priorNetwork = networks.get(networkId);
    if (priorNetwork !== undefined) {
      discoveryFail(
        "DISCOVERY_NETWORK_DUPLICATE",
        `candidates ${JSON.stringify(priorNetwork)} and ${JSON.stringify(candidate.id)} both target network ${JSON.stringify(networkId)}`,
      );
    }
    networks.set(networkId, candidate.id);
    const priorSnapshot = snapshotIds.get(candidate.snapshot.id);
    if (priorSnapshot !== undefined) {
      discoveryFail(
        "DISCOVERY_CONTEXT_CONFLICT",
        `candidates ${JSON.stringify(priorSnapshot)} and ${JSON.stringify(candidate.id)} share CapabilitySnapshot id ${JSON.stringify(candidate.snapshot.id)}`,
      );
    }
    snapshotIds.set(candidate.snapshot.id, candidate.id);
    const priorManifest = manifests.get(candidate.manifest.id);
    if (priorManifest === undefined) {
      manifests.set(candidate.manifest.id, candidate.manifest);
    } else if (
      priorManifest.version !== candidate.manifest.version ||
      priorManifest.digest !== candidate.manifest.digest
    ) {
      discoveryFail(
        "DISCOVERY_CONTEXT_CONFLICT",
        `candidate ${JSON.stringify(candidate.id)}: ResolverManifest id ${JSON.stringify(candidate.manifest.id)} is supplied with differing version/digest (Core verification context resolves manifests by id)`,
      );
    }
  }

  // 4. Presentation scope — selects candidates only; never touches evidence.
  const scope = parseScope(root.scope, ids);
  if (scope.candidateIds !== null && scope.environments !== null) {
    for (const id of scope.candidateIds) {
      const candidate = bound.find((entry) => entry.id === id)!;
      if (!scope.environments.includes(candidate.environment)) {
        discoveryFail(
          "DISCOVERY_SCOPE_CONFLICT",
          `scope.candidateIds names ${JSON.stringify(id)} but its environment ${JSON.stringify(candidate.environment)} is excluded by scope.environments`,
        );
      }
    }
  }
  const inScope = bound.filter(
    (candidate) =>
      (scope.candidateIds === null || scope.candidateIds.includes(candidate.id)) &&
      (scope.environments === null || scope.environments.includes(candidate.environment)),
  );
  const outOfScope = bound.filter((candidate) => !inScope.includes(candidate));

  // 5. Core classification + Core build + Core verification.
  const matches: NetworkDiscoveryMatch[] = inScope.map((candidate) => {
    const composed = composeDiscoveryMatch(requirements, {
      network: candidate.network,
      snapshot: candidate.snapshot,
      resolver: candidate.manifest,
    });
    return {
      network: candidate.network,
      classification: composed.classification,
      evaluations: composed.evaluations,
      capabilitySnapshot: { id: candidate.snapshot.id, digest: candidate.snapshot.artifactDigest },
      evidence: [...candidate.snapshot.evidence],
    };
  });
  const usedManifestIds = new Set(inScope.map((candidate) => candidate.manifest.id));
  const verificationContext: DiscoverNetworksVerificationContext = {
    capabilitySnapshots: inScope.map((candidate) => candidate.snapshot),
    resolverManifests: [...manifests.values()]
      .filter((manifest) => usedManifestIds.has(manifest.id))
      .sort((a, b) => compareIds(a.id, b.id)),
  };
  let result: DiscoverNetworksResult;
  try {
    result = buildDiscoverNetworksResult(
      { schemaVersion: "0.1", requestId, generatedAt, request: requirements, matches },
      verificationContext,
    );
  } catch (error) {
    discoveryFail("DISCOVERY_RESULT_INVALID", "Core rejected the DiscoverNetworksResult build", error);
  }
  if (!verifyDiscoverNetworksResult(result, verificationContext)) {
    discoveryFail("DISCOVERY_RESULT_INVALID", "Core did not verify the built DiscoverNetworksResult");
  }

  const candidates: DiscoveryCandidateOutcome[] = inScope.map((candidate, i) => {
    const match = result.matches[i];
    if (match === undefined || match.network.networkId !== candidate.network.networkId) {
      discoveryFail("DISCOVERY_RESULT_INVALID", "Core result match order diverged from the deterministic candidate order");
    }
    const { id: resolverId, version, digest } = candidate.manifest;
    return {
      id: candidate.id,
      environment: candidate.environment,
      networkId: candidate.network.networkId,
      resolver: { id: resolverId, version, digest },
      match,
    };
  });

  return deepFreeze({
    result,
    candidates,
    scope: {
      candidateIds: scope.candidateIds,
      environments: scope.environments,
      inScopeCandidateIds: inScope.map((candidate) => candidate.id),
      outOfScopeCandidateIds: outOfScope.map((candidate) => candidate.id),
    },
    verificationContext,
  }) as DiscoverNetworksOutcome;
}
