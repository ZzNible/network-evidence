/**
 * BEFORE-side foundation for the GENERIC EVM resolver (v0.1).
 *
 * Pure derivation from ALREADY-ACQUIRED capability-probe observations into
 * frozen @nec/core artifacts:
 *
 *   EvmCapabilityProbeObservation
 *     -> ResolverManifest (SUPPORT authority)
 *     -> CapabilitySnapshot (per-capability SUPPORT x AVAILABILITY + evidence)
 *     -> discovery-ready candidate data (`DiscoveryCandidate`)
 *     -> preflight EVIDENCE readiness (`PreflightResult`)
 *
 * Semantic split (NEC invariant):
 *   SUPPORT      = the resolver implementation knows how to evaluate the
 *                  capability — static manifest authority, never probe-derived;
 *   AVAILABILITY = the required evidence source is usable for that capability
 *                  NOW — volatile probe outcome; a source outage changes
 *                  availability, NEVER support;
 *   OBSERVED     = concrete provenance: every positive availability claim is
 *   EVIDENCE       backed by complete EvidenceRefs in the probe table.
 *
 * Conservative by design. The v0.1 generic EVM manifest claims exactly:
 *   execution | observedEffects | dataBinding
 * and NEVER settlement, finality, simulation, batching, executionModel,
 * accountModel or gasModel. No execution-family capability slot is ever
 * populated because this implementation does not evaluate or evidence them.
 *
 * CAPABILITY AVAILABILITY RULES (generic EVM v0.1, conservative):
 *   execution       available iff the RPC source answered AND chain identity
 *                   was observed AND receipt AND block acquisition were usable
 *                   (execution evidence is anchored to its block);
 *   observedEffects available iff the RPC source answered AND chain identity
 *                   was observed AND receipt/log acquisition was usable;
 *   dataBinding     available iff the RPC source answered AND chain identity
 *                   was observed AND receipt AND block AND transaction
 *                   coherence acquisition were usable;
 *   settlement/finality unsupported (deterministically negative).
 *
 * An observed-but-unverified chain identity leaves availability UNKNOWN
 * (undetermined), never silently available and never a definite negative.
 *
 * Fail-closed rules:
 *   - positive flags without concrete backing EvidenceRefs are GHOST claims
 *     and rejected outright (positive availability requires provenance);
 *   - an observation whose network differs from the explicitly requested
 *     target is rejected (network mismatch);
 *   - cross-network EvidenceRefs inside a probe table are rejected.
 *
 * This module performs NO I/O of any kind: no network, clock, randomness,
 * wallet, keys, signing, gas acquisition, funding, transaction submission or
 * execution runtime. Time enters only through `observation.observedAt`;
 * all artifacts are therefore deterministic functions of their inputs.
 */

import {
  assertIso8601,
  assertNetworkId,
  buildCapabilitySnapshot,
  buildPreflightResult,
  capabilityIsDeterministicallyUnavailable,
  capabilityIsUsable,
  computeResolverManifestDigest,
  deepFreeze,
  EVIDENCE_READINESS_KEYS,
  validateEvidenceRef,
} from "@nec/core";
import type {
  CapabilitySnapshot,
  CapabilityState,
  DiscoveryCandidate,
  EvidenceCapabilitySet,
  EvidenceRef,
  Iso8601,
  NetworkFingerprint,
  NetworkId,
  PreflightRequest,
  PreflightResult,
  ReadinessCheck,
  ResolverManifest,
  ResolverManifestRef,
} from "@nec/core";

import { NecResolverEvmError } from "./errors.js";

// ---------------------------------------------------------------------------
// Resolver manifest — THE support authority for the generic EVM resolver
// ---------------------------------------------------------------------------

/**
 * Frozen manifest content. `digest` is computed once via the core digest
 * domain (`computeResolverManifestDigest`); there is no second place where
 * these declarations live.
 */
const EVM_BEFORE_MANIFEST_CONTENT: Omit<ResolverManifest, "digest"> = {
  id: "resolver-evm-generic",
  version: "0.1.0",
  networkFamilies: ["eip155"],
  implementation: { package: "@nec/resolver-evm" },
  supportedCapabilities: ["execution", "observedEffects", "dataBinding"],
  sourceRequirements: [{ sourceType: "evm_rpc", required: true }],
};

let manifestCache: ResolverManifest | undefined;

/**
 * THE ResolverManifest of the generic EVM v0.1 resolver (frozen,
 * digest-bound). Its `supportedCapabilities` are exactly the capabilities
 * this implementation knows how to evaluate; membership permits evaluation
 * only and never proves current availability.
 */
export function evmBeforeResolverManifest(): ResolverManifest {
  if (manifestCache === undefined) {
    manifestCache = deepFreeze({
      ...EVM_BEFORE_MANIFEST_CONTENT,
      digest: computeResolverManifestDigest(EVM_BEFORE_MANIFEST_CONTENT),
    });
  }
  return manifestCache;
}

function manifestRef(manifest: ResolverManifest): ResolverManifestRef {
  return { id: manifest.id, version: manifest.version, digest: manifest.digest };
}

// ---------------------------------------------------------------------------
// Pure capability-probe observation model (no I/O — input only)
// ---------------------------------------------------------------------------

/**
 * Probe-path classification of one EvidenceRef. A ref is classified either
 * explicitly via `metadata.probePath` or, failing that, derived from the
 * acquisition-style `metadata.rpcMethod` tag produced by
 * `buildEvidenceRefs`. Refs with neither tag are inert extra provenance:
 * they stay in the table but are never cited.
 */
export const PROBE_PATH_METADATA_KEY = "probePath";

export type EvmProbePath = "chainidentity" | "receipt" | "block" | "transaction";

const PROBE_PATHS: readonly EvmProbePath[] = ["chainidentity", "receipt", "block", "transaction"];

const RPC_METHOD_PROBE_PATHS: ReadonlyMap<string, EvmProbePath> = new Map([
  ["eth_chainId", "chainidentity"],
  ["eth_getTransactionReceipt", "receipt"],
  ["eth_getBlockByHash", "block"],
  ["eth_getTransactionByHash", "transaction"],
]);

/** Provenance of whatever performed the capability probe (never a URL). */
export interface EvmCapabilityProbeSource {
  readonly sourceId: string;
  readonly sourceType: string;
}

/**
 * PURE input model of already-acquired capability-probe observations for ONE
 * network. Every boolean answers "was this path usable at probe time?"; the
 * `evidence` table carries the concrete provenance that must back every
 * positive answer. No reachability is inferred here — nothing is fetched.
 */
export interface EvmCapabilityProbeObservation {
  /** Network the probe ran against (must match the requested target). */
  readonly network: NetworkId;
  readonly source: EvmCapabilityProbeSource;
  /** Probe time (THE only time input; flows into every artifact). */
  readonly observedAt: Iso8601;
  /** Observed EIP-155 chain id, when the probe captured it. */
  readonly chainId?: number;
  readonly rpcReachable: boolean;
  readonly chainIdentityObserved: boolean;
  readonly receiptLookupUsable: boolean;
  readonly blockLookupUsable: boolean;
  readonly transactionLookupUsable: boolean;
  /** Complete validated EvidenceRef table backing the positive flags. */
  readonly evidence: EvidenceRef[];
}

const OBSERVATION_KEYS: readonly string[] = [
  "network",
  "source",
  "observedAt",
  "rpcReachable",
  "chainIdentityObserved",
  "receiptLookupUsable",
  "blockLookupUsable",
  "transactionLookupUsable",
  "evidence",
  "chainId",
];

const REQUIRED_OBSERVATION_KEYS: readonly string[] = OBSERVATION_KEYS.filter(
  (key) => key !== "chainId",
);

const FLAGGED_PROBE_PATHS: ReadonlyArray<readonly [keyof EvmCapabilityProbeObservation, EvmProbePath]> = [
  ["chainIdentityObserved", "chainidentity"],
  ["receiptLookupUsable", "receipt"],
  ["blockLookupUsable", "block"],
  ["transactionLookupUsable", "transaction"],
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function evmFailInvalid(detail: string): never {
  throw new NecResolverEvmError(
    "EVM_FIXTURE_INVALID",
    `capability probe observation rejected: ${detail}`,
  );
}

/** Validate the observation boundary fail-closed before any derivation. */
function validateObservation(value: unknown): EvmCapabilityProbeObservation {
  if (!isPlainObject(value)) evmFailInvalid("must be a plain object");
  const raw = value as Record<string, unknown>;
  for (const key of Reflect.ownKeys(raw)) {
    if (typeof key === "symbol") {
      evmFailInvalid("symbol-keyed properties are not allowed");
    }
    if (!OBSERVATION_KEYS.includes(key as string)) {
      evmFailInvalid(`unknown key ${JSON.stringify(key)}`);
    }
  }
  for (const key of REQUIRED_OBSERVATION_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) {
      evmFailInvalid(`missing required key ${JSON.stringify(key)}`);
    }
  }

  try {
    assertNetworkId(raw.network, "observation.network");
  } catch (error) {
    evmFailInvalid((error as Error).message);
  }
  if (raw.chainId !== undefined && (typeof raw.chainId !== "number" || !Number.isSafeInteger(raw.chainId) || raw.chainId <= 0)) {
    evmFailInvalid("chainId must be a safe positive integer");
  }

  const source = raw.source;
  if (!isPlainObject(source)) evmFailInvalid("source must be a plain object");
  for (const key of Reflect.ownKeys(source)) {
    if (typeof key === "symbol" || !["sourceId", "sourceType"].includes(key as string)) {
      evmFailInvalid(`source has unknown key ${JSON.stringify(String(key))}`);
    }
  }
  for (const key of ["sourceId", "sourceType"] as const) {
    if (typeof source[key] !== "string") evmFailInvalid(`source.${key} must be a string`);
  }

  if (typeof raw.observedAt !== "string") {
    throw new NecResolverEvmError("EVM_TIME_INVALID", "observedAt must be an ISO-8601 UTC timestamp string");
  }
  try {
    assertIso8601(raw.observedAt, "observation.observedAt");
  } catch (error) {
    throw new NecResolverEvmError(
      "EVM_TIME_INVALID",
      `observedAt must be exactly YYYY-MM-DDTHH:mm:ss.sssZ (${(error as Error).message})`,
    );
  }

  for (const key of [
    "rpcReachable",
    "chainIdentityObserved",
    "receiptLookupUsable",
    "blockLookupUsable",
    "transactionLookupUsable",
  ] as const) {
    if (typeof raw[key] !== "boolean") evmFailInvalid(`${key} must be a boolean`);
  }

  const evidence = raw.evidence;
  if (!Array.isArray(evidence)) evmFailInvalid("evidence must be a dense array");
  const seenIds = new Set<string>();
  for (let i = 0; i < evidence.length; i++) {
    const ref = evidence[i] as EvidenceRef;
    try {
      validateEvidenceRef(ref, `evidence[${i}]`);
    } catch (error) {
      evmFailInvalid((error as Error).message);
    }
    if (seenIds.has(ref.id)) {
      evmFailInvalid(`duplicate EvidenceId ${JSON.stringify(ref.id)}; failing closed`);
    }
    seenIds.add(ref.id);
    if (ref.networkId !== undefined && ref.networkId !== (raw.network as NetworkId)) {
      throw new NecResolverEvmError(
        "EVM_NETWORK_MISMATCH",
        `evidence[${i}] (${JSON.stringify(ref.id)}): networkId ${JSON.stringify(
          ref.networkId,
        )} differs from the probed network ${JSON.stringify(raw.network)}; cross-network probe tables fail closed`,
      );
    }
  }
  return raw as unknown as EvmCapabilityProbeObservation;
}

// ---------------------------------------------------------------------------
// Evidence classification + ghost-claim rejection
// ---------------------------------------------------------------------------

interface ProbeEvidenceTable {
  readonly byPath: ReadonlyMap<EvmProbePath, EvidenceRef[]>;
  readonly total: number;
}

function classifyEvidence(observation: EvmCapabilityProbeObservation): ProbeEvidenceTable {
  const byPath = new Map<EvmProbePath, EvidenceRef[]>(PROBE_PATHS.map((path) => [path, []]));
  for (let i = 0; i < observation.evidence.length; i++) {
    const ref = observation.evidence[i] as EvidenceRef;
    const meta = ref.metadata as Record<string, unknown> | undefined;
    let path: EvmProbePath | undefined;
    const explicit = meta === undefined ? undefined : meta[PROBE_PATH_METADATA_KEY];
    if (explicit !== undefined) {
      if (typeof explicit !== "string" || !PROBE_PATHS.includes(explicit as EvmProbePath)) {
        evmFailInvalid(
          `evidence ${JSON.stringify(ref.id)}: unknown ${PROBE_PATH_METADATA_KEY} tag ${JSON.stringify(String(explicit))}`,
        );
      }
      path = explicit as EvmProbePath;
    } else if (meta !== undefined && meta.rpcMethod !== undefined) {
      if (typeof meta.rpcMethod !== "string") {
        evmFailInvalid(`evidence ${JSON.stringify(ref.id)}: metadata.rpcMethod must be a string`);
      }
      path = RPC_METHOD_PROBE_PATHS.get(meta.rpcMethod);
    }
    if (path !== undefined) (byPath.get(path) as EvidenceRef[]).push(ref);
  }
  return { byPath, total: observation.evidence.length };
}

/**
 * GHOST-EVIDENCE RULE: every TRUE flag must cite at least one concrete
 * classified EvidenceRef. A positive usability claim without provenance is
 * an incomplete observation, never a derivable availability.
 */
function assertPositiveFlagsAreEvidenced(
  observation: EvmCapabilityProbeObservation,
  table: ProbeEvidenceTable,
): void {
  if (observation.rpcReachable && table.total === 0) {
    throw new NecResolverEvmError(
      "EVM_OBSERVATION_INCOMPLETE",
      "positive rpcReachable claim cites no EvidenceRef; positive availability requires concrete provenance",
    );
  }
  for (const [flagKey, path] of FLAGGED_PROBE_PATHS) {
    const flag = observation[flagKey] as boolean;
    const refs = table.byPath.get(path) ?? [];
    if (flag === true && refs.length === 0) {
      throw new NecResolverEvmError(
        "EVM_OBSERVATION_INCOMPLETE",
        `positive ${path} claim cites no ${path} EvidenceRef; ghost evidence cannot back availability`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Availability derivation (support NEVER depends on the probe outcome)
// ---------------------------------------------------------------------------

const EXECUTION_REQUIRED_PATHS: readonly EvmProbePath[] = ["receipt", "block"];
const OBSERVED_EFFECTS_REQUIRED_PATHS: readonly EvmProbePath[] = ["receipt"];
const DATA_BINDING_REQUIRED_PATHS: readonly EvmProbePath[] = ["receipt", "block", "transaction"];

const REASON_RPC_UNREACHABLE = "probe source did not answer during the capability probe";
const REASON_CHAIN_IDENTITY_UNOBSERVED =
  "chain identity was not observed during the probe; usability is undetermined";
const REASON_UNSUPPORTED = "not claimed by the generic EVM v0.1 resolver manifest";
const READY_REASON = "evidence acquisition for this dimension is usable and concretely evidenced";
const UNDETERMINED_REASON =
  "capability usability could not be determined from the probe observation";

type DerivedAvailability =
  | { readonly availability: "available"; readonly evidenceIds: readonly string[] }
  | { readonly availability: "unavailable" | "unknown"; readonly reason: string };

function probeFlag(observation: EvmCapabilityProbeObservation, path: EvmProbePath): boolean {
  switch (path) {
    case "chainidentity":
      return observation.chainIdentityObserved;
    case "receipt":
      return observation.receiptLookupUsable;
    case "block":
      return observation.blockLookupUsable;
    case "transaction":
      return observation.transactionLookupUsable;
  }
}

function deriveAvailability(
  observation: EvmCapabilityProbeObservation,
  table: ProbeEvidenceTable,
  requiredPaths: readonly EvmProbePath[],
): DerivedAvailability {
  if (!observation.rpcReachable) {
    return { availability: "unavailable", reason: REASON_RPC_UNREACHABLE };
  }
  if (!observation.chainIdentityObserved) {
    return { availability: "unknown", reason: REASON_CHAIN_IDENTITY_UNOBSERVED };
  }
  for (const path of requiredPaths) {
    if (!probeFlag(observation, path)) {
      return { availability: "unavailable", reason: `${path} acquisition was unusable at probe time` };
    }
  }
  // Positive availability cites its full concrete provenance (non-empty by
  // the ghost-evidence rule enforced above).
  const evidenceIds: string[] = [];
  for (const ref of table.byPath.get("chainidentity") ?? []) evidenceIds.push(ref.id);
  for (const path of requiredPaths) {
    for (const ref of table.byPath.get(path) ?? []) evidenceIds.push(ref.id);
  }
  return { availability: "available", evidenceIds };
}

function capabilityState(outcome: DerivedAvailability): CapabilityState {
  return outcome.availability === "available"
    ? { support: "supported", availability: "available", evidence: [...outcome.evidenceIds] }
    : { support: "supported", availability: outcome.availability, reason: outcome.reason };
}

function deriveEvidenceCapabilities(
  observation: EvmCapabilityProbeObservation,
  table: ProbeEvidenceTable,
): EvidenceCapabilitySet {
  return {
    execution: capabilityState(deriveAvailability(observation, table, EXECUTION_REQUIRED_PATHS)),
    observedEffects: capabilityState(
      deriveAvailability(observation, table, OBSERVED_EFFECTS_REQUIRED_PATHS),
    ),
    dataBinding: capabilityState(deriveAvailability(observation, table, DATA_BINDING_REQUIRED_PATHS)),
    settlement: { support: "unsupported", availability: "unavailable", reason: REASON_UNSUPPORTED },
    finality: { support: "unsupported", availability: "unavailable", reason: REASON_UNSUPPORTED },
  };
}

// ---------------------------------------------------------------------------
// Foundation derivation: manifest + snapshot + discovery candidate data
// ---------------------------------------------------------------------------

export interface EvmBeforeDerivationInput {
  /**
   * The EXPLICITLY requested probe target. An observation claiming another
   * network fails closed here (mirror of the core snapshot-builder check).
   */
  readonly networkId: NetworkId;
  readonly observation: EvmCapabilityProbeObservation;
}

export interface EvmBeforeFoundation {
  /** THE support authority behind the snapshot. */
  readonly manifest: ResolverManifest;
  /** Canonical network context of the probe (as bound into the snapshot). */
  readonly network: NetworkFingerprint;
  /** Frozen, digest-bound CapabilitySnapshot (built via @nec/core). */
  readonly snapshot: CapabilitySnapshot;
  /** Discovery-ready candidate data (THE core `DiscoveryCandidate` shape). */
  readonly candidate: DiscoveryCandidate;
}

/**
 * Derive the BEFORE-side foundation from one pure probe observation. All
 * artifact construction is delegated to the frozen @nec/core builders
 * (`buildCapabilitySnapshot` enforces self-digest binding, probe-target
 * equality and the manifest-authority invariant); this module only projects
 * the observation into builder content.
 */
export function deriveEvmBeforeFoundation(input: EvmBeforeDerivationInput): EvmBeforeFoundation {
  if (!isPlainObject(input)) evmFailInvalid("derivation input must be a plain object");
  const { networkId, observation } = input as {
    networkId?: unknown;
    observation?: unknown;
  };
  try {
    assertNetworkId(networkId, "input.networkId");
  } catch (error) {
    evmFailInvalid((error as Error).message);
  }
  const obs = validateObservation(observation);
  if (obs.network !== networkId) {
    throw new NecResolverEvmError(
      "EVM_NETWORK_MISMATCH",
      `probe observation network ${JSON.stringify(obs.network)} does not match the explicitly requested target ${JSON.stringify(
        networkId,
      )}; failing closed`,
    );
  }
  const table = classifyEvidence(obs);
  assertPositiveFlagsAreEvidenced(obs, table);

  const manifest = evmBeforeResolverManifest();
  const fingerprint: NetworkFingerprint = {
    networkId: obs.network,
    ...(obs.chainId === undefined ? {} : { chainId: obs.chainId }),
    observedAt: { timestamp: obs.observedAt },
    metadata: {
      probeSource: { sourceId: obs.source.sourceId, sourceType: obs.source.sourceType },
    },
  };
  const snapshot = buildCapabilitySnapshot(
    {
      schemaVersion: "0.1",
      id: `evm-capsnap-${obs.network}`,
      generatedAt: obs.observedAt,
      network: fingerprint,
      evidenceCapabilities: deriveEvidenceCapabilities(obs, table),
      // Deliberately EMPTY: this implementation evaluates and evidences no
      // executionModel/accountModel/gasModel/simulation/batching dimension.
      executionCapabilities: {},
      evidence: [...obs.evidence],
      resolver: manifestRef(manifest),
    },
    { resolver: manifest, networkId: obs.network },
  );
  return deepFreeze({
    manifest,
    network: snapshot.network,
    snapshot,
    candidate: { network: snapshot.network, snapshot, resolver: manifest },
  });
}

// ---------------------------------------------------------------------------
// Preflight evidence readiness
// ---------------------------------------------------------------------------

/**
 * Project each policy dimension's snapshot state onto the readiness check
 * vocabulary, using ONLY the core classification helpers:
 *
 *   usable                    -> "ready"          (cites the capability's own
 *                                                   validated evidence set)
 *   unsupported               -> "not_applicable" (definite policy
 *                                                   infeasibility when
 *                                                   required — the normative
 *                                                   composer turns this into
 *                                                   an overall "blocked")
 *   deterministically         -> "blocked"        (definite source outage /
 *   unavailable                                      degraded acquisition)
 *   anything else             -> "unknown"        (undetermined — never
 *                                                   silently ready)
 *
 * The overall `status` is NEVER authored here: `buildPreflightResult`
 * recomputes it with the normative composer and re-derives every positive
 * readiness claim from the supplied snapshot/manifest context.
 */
export function deriveEvmBeforePreflightResult(
  foundation: EvmBeforeFoundation,
  request: PreflightRequest,
): PreflightResult {
  if (!isPlainObject(foundation)) evmFailInvalid("preflight foundation must be a plain object");
  if (!isPlainObject(request)) evmFailInvalid("preflight request must be a plain object");
  const snapshot = foundation.snapshot;
  if (snapshot.network.networkId !== request.networkId) {
    throw new NecResolverEvmError(
      "EVM_NETWORK_MISMATCH",
      `preflight request network ${JSON.stringify(request.networkId)} does not match the probed foundation network ${JSON.stringify(
        snapshot.network.networkId,
      )}; failing closed`,
    );
  }

  const evidenceReadiness: Record<(typeof EVIDENCE_READINESS_KEYS)[number], ReadinessCheck> = {
    execution: { status: "unknown", reason: UNDETERMINED_REASON },
    observedEffects: { status: "unknown", reason: UNDETERMINED_REASON },
    dataBinding: { status: "unknown", reason: UNDETERMINED_REASON },
    settlement: { status: "not_applicable", reason: REASON_UNSUPPORTED },
    finality: { status: "not_applicable", reason: REASON_UNSUPPORTED },
  };
  for (const dimension of EVIDENCE_READINESS_KEYS) {
    const state = snapshot.evidenceCapabilities[dimension];
    if (capabilityIsUsable(state, snapshot.evidence)) {
      evidenceReadiness[dimension] = {
        status: "ready",
        reason: READY_REASON,
        evidence: [...(state.evidence ?? [])],
      };
    } else if (state.support === "unsupported") {
      evidenceReadiness[dimension] = {
        status: "not_applicable",
        reason: state.reason ?? REASON_UNSUPPORTED,
      };
    } else if (capabilityIsDeterministicallyUnavailable(state)) {
      evidenceReadiness[dimension] = {
        status: "blocked",
        reason: state.reason ?? UNDETERMINED_REASON,
      };
    } else {
      evidenceReadiness[dimension] = {
        status: "unknown",
        reason: state.reason ?? UNDETERMINED_REASON,
      };
    }
  }

  return buildPreflightResult(
    {
      schemaVersion: "0.1",
      generatedAt: snapshot.generatedAt,
      network: snapshot.network,
      request,
      evidenceReadiness,
      blockers: [],
      warnings: [],
      evidence: [...snapshot.evidence],
      evidencePolicy: {
        id: request.evidencePolicy.id,
        version: request.evidencePolicy.version,
        digest: request.evidencePolicy.digest,
      },
      resolver: manifestRef(foundation.manifest),
      capabilitySnapshot: { id: snapshot.id, digest: snapshot.artifactDigest },
    },
    { resolver: foundation.manifest, capabilitySnapshot: snapshot },
  );
}
