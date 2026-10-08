/**
 * Solana BEFORE foundation (v0.1).
 *
 *   SolanaCapabilityProbeObservation    (already acquired; input only)
 *   explicit SolanaBeforeNetworkConfig  (full genesis hash pinned, never inferred)
 *     -> ResolverManifest (SUPPORT authority)
 *     -> CapabilitySnapshot (SUPPORT x AVAILABILITY + evidence)
 *     -> DiscoveryCandidate (THE core shape)
 *     -> evidence Preflight (readiness only)
 *
 * SEMANTIC BOUNDARY (never collapsed):
 *   - SUPPORT is static manifest authority; AVAILABILITY derives only from the
 *     supplied probe observation and its concrete EvidenceRefs.
 *   - Every supported capability requires the SAME evidence path: full
 *     getGenesisHash identity, getTransaction(finalized),
 *     getSignatureStatuses(searchTransactionHistory) and compact
 *     getBlock(finalized). An `unusable` path is `unavailable` for all of them
 *     because the post-action resolver (`nec-resolver-solana-acquisition-v1`)
 *     reads them as one sequential pipeline and any read failure aborts it.
 *     `not_established` paths and incoherent lookups are projected to every
 *     capability conservatively, because the probe characterizes the
 *     configured source's view, not a per-dimension post-action verdict.
 *   - `observationKind: "probe"` is a producer assertion; this pure
 *     derivation cannot verify freshness. Consumers must apply their own
 *     freshness window to `generatedAt`, `network.observedAt` and each
 *     `EvidenceRef.retrievedAt`.
 *   - `finality` additionally requires that the probe OBSERVED the finalized
 *     commitment for its subject. It means only Solana finalized commitment as
 *     reported by the configured source (basis `source_observation`). It
 *     NEVER establishes settlement, economic irreversibility or independent
 *     cryptographic verification.
 *   - `settlement` is never claimed.
 *   - `historical_replay` observations (archived fixtures) prove what was
 *     observed at capture time; every supported capability is then projected
 *     to CURRENT availability `unknown`, never to a live claim.
 *   - Preflight is evidence readiness only: no wallet, balance, fee funding,
 *     signer, transaction construction/submission, sponsor or facilitator
 *     readiness is represented anywhere.
 *
 * AVAILABILITY LADDER (`probe` observations; first match wins):
 *   probe source did not answer                     -> unavailable
 *   genesis identity read failed                    -> unavailable
 *   genesis identity not established                -> unknown
 *   transaction/status/finalized-block read failed  -> unavailable
 *   any of those lookups not established            -> unknown
 *     (not probed, or the probe subject was absent/pruned at the source)
 *   lookups mutually inconsistent                   -> degraded
 *   finality only: finalized commitment unobserved  -> unknown
 *   otherwise                                       -> available, citing the
 *                                                      identity + lookup refs
 *
 * Pure: no network, clock, randomness, wallet, keys, signing, funding or
 * submission. Time enters only through `observation.observedAt`. The async
 * `replaySolanaBeforeFoundation` helper performs offline fixture replay only.
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
  NecError,
  validateCapabilitySnapshot,
  validateEvidenceRef,
  validatePreflightRequest,
  validateResolverManifest,
} from "@nec/core";
import type {
  CapabilitySnapshot,
  CapabilityState,
  DiscoveryCandidate,
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

import { ACQUISITION_PROFILE } from "./acquire.js";
import type { SolanaTransactionAcquisition } from "./acquire.js";
import { parseGenesisHash } from "./base58.js";
import { NecResolverSolanaError, solanaFail } from "./errors.js";
import type { NecResolverSolanaErrorCode } from "./errors.js";
import { EVALUATION_PROFILE, TRANSFER_CHECKED_EFFECT_TYPE, evaluateSolanaTransaction } from "./evaluate.js";
import { validateSolanaAcquisitionFixture } from "./fixture.js";
import { replaySolanaTransaction } from "./replay.js";
import { SOURCE_TYPE } from "./rpc.js";

// ---------------------------------------------------------------------------
// Explicit genesis-bound network configuration
// ---------------------------------------------------------------------------

export const SOLANA_FAMILY = "solana";

/**
 * EXPLICIT network configuration. `genesisHash` is the FULL `getGenesisHash`
 * result; `networkId` must be exactly `solana:` + its first 32 characters.
 */
export interface SolanaBeforeNetworkConfig {
  readonly networkId: string;
  readonly genesisHash: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function probeInvalid(detail: string): never {
  solanaFail("SOLANA_PROBE_INVALID", `Solana BEFORE input rejected: ${detail}`);
}

function exactKeys(value: unknown, path: string, allowed: readonly string[], required: readonly string[]): Record<string, unknown> {
  if (!isPlainObject(value)) probeInvalid(`${path} must be a plain object`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") probeInvalid(`${path}: symbol-keyed properties are not allowed`);
    if (!allowed.includes(key)) probeInvalid(`${path}: unknown key ${JSON.stringify(key)}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) probeInvalid(`${path}.${key}: accessor properties are not allowed`);
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) probeInvalid(`${path}: missing required key ${JSON.stringify(key)}`);
  }
  return value;
}

/** Validate an explicit config: canonical full genesis hash + derived CAIP id. */
export function validateSolanaBeforeNetworkConfig(value: unknown): asserts value is SolanaBeforeNetworkConfig {
  const raw = exactKeys(value, "config", ["networkId", "genesisHash"], ["networkId", "genesisHash"]);
  if (typeof raw.genesisHash !== "string") probeInvalid("config.genesisHash must be a string");
  try {
    parseGenesisHash(raw.genesisHash, "config.genesisHash");
  } catch (error) {
    probeInvalid((error as Error).message);
  }
  if (raw.genesisHash.length <= 32) probeInvalid("config.genesisHash must be the full getGenesisHash result, not the 32-character CAIP reference");
  if (typeof raw.networkId !== "string") probeInvalid("config.networkId must be a string");
  const derived = `solana:${raw.genesisHash.slice(0, 32)}`;
  if (raw.networkId !== derived) {
    solanaFail(
      "SOLANA_NETWORK_MISMATCH",
      `config.networkId ${JSON.stringify(raw.networkId)} is not derived from the configured full genesis hash (expected ${JSON.stringify(derived)})`,
    );
  }
}

// ---------------------------------------------------------------------------
// Manifest — THE support authority of the Solana BEFORE foundation
// ---------------------------------------------------------------------------

export const SOLANA_BEFORE_PROFILE = "solana-before-v0.1";

/** What an observed Solana finalized commitment NEVER establishes here. */
export const SOLANA_FINALITY_DOES_NOT_ESTABLISH: readonly string[] = Object.freeze([
  "settlement",
  "economic_irreversibility",
  "independent_cryptographic_verification",
]);

export const SOLANA_BEFORE_FINALITY_SEMANTICS =
  "Solana finalized commitment as reported by the configured source: getTransaction(commitment=finalized), getSignatureStatuses confirmationStatus=finalized and the finalized containing getBlock, mutually consistent under nec-resolver-solana-evaluation-v1; basis source_observation only";

/**
 * Probe paths, in citation order. Every supported capability requires all of
 * them (pipeline abort for `unusable`; conservative source-view projection for
 * `not_established` and incoherent lookups).
 */
export type SolanaProbePath = "genesisidentity" | "transaction" | "signaturestatus" | "finalizedblock";

const PROBE_PATHS: readonly SolanaProbePath[] = ["genesisidentity", "transaction", "signaturestatus", "finalizedblock"];
const LOOKUP_PATHS: readonly SolanaProbePath[] = ["transaction", "signaturestatus", "finalizedblock"];

const RPC_METHOD_PROBE_PATHS: ReadonlyMap<string, SolanaProbePath> = new Map([
  ["getGenesisHash", "genesisidentity"],
  ["getTransaction", "transaction"],
  ["getSignatureStatuses", "signaturestatus"],
  ["getBlock", "finalizedblock"],
]);

const REASON_SETTLEMENT_UNSUPPORTED =
  "not claimed by the Solana BEFORE v0.1 manifest: an observed finalized commitment is never settlement or economic irreversibility";

let manifestCache: ResolverManifest | undefined;

/**
 * THE ResolverManifest of the Solana BEFORE foundation (frozen,
 * digest-bound): execution, observedEffects, dataBinding and finality —
 * exactly what the post-action Solana resolver evaluates. Never settlement.
 * Membership permits evaluation only; it never proves availability.
 */
export function solanaBeforeResolverManifest(): ResolverManifest {
  if (manifestCache === undefined) {
    const content: Omit<ResolverManifest, "digest"> = {
      id: "resolver-solana-before",
      version: "0.1.0",
      networkFamilies: [SOLANA_FAMILY],
      implementation: { package: "@nec/resolver-solana" },
      supportedCapabilities: ["execution", "observedEffects", "dataBinding", "finality"],
      sourceRequirements: [{ sourceType: SOURCE_TYPE, required: true }],
      metadata: {
        profile: SOLANA_BEFORE_PROFILE,
        chainFamily: SOLANA_FAMILY,
        networkIdentity:
          "networkId = solana:<first 32 characters of the full getGenesisHash result>; the full genesis hash is pinned by an explicit SolanaBeforeNetworkConfig and must equal the observed result exactly",
        postActionAcquisitionProfile: ACQUISITION_PROFILE,
        postActionEvaluationProfile: EVALUATION_PROFILE,
        requiredProbePaths: [...PROBE_PATHS],
        supportedTransactionVersions: ["legacy", "0"],
        observedEffectTypes: [TRANSFER_CHECKED_EFFECT_TYPE],
        finalitySemantics: SOLANA_BEFORE_FINALITY_SEMANTICS,
        finalityDoesNotEstablish: [...SOLANA_FINALITY_DOES_NOT_ESTABLISH],
        settlement: "never claimed",
      },
    };
    const manifest = { ...content, digest: computeResolverManifestDigest(content) };
    validateResolverManifest(manifest);
    manifestCache = deepFreeze(manifest);
  }
  return manifestCache;
}

function manifestRef(manifest: ResolverManifest): ResolverManifestRef {
  return { id: manifest.id, version: manifest.version, digest: manifest.digest };
}

// ---------------------------------------------------------------------------
// Pure probe observation model (input only — nothing is fetched)
// ---------------------------------------------------------------------------

/** Explicit `metadata.probePath` tag; refs may instead carry `metadata.rpcMethod`. */
export const SOLANA_PROBE_PATH_METADATA_KEY = "probePath";

/**
 * Outcome of one probe read:
 *   usable          the read answered with a non-null well-formed result;
 *   not_established not probed, or answered null (subject unknown, pruned or
 *                   not yet visible at this source) — undetermined, never a
 *                   definite negative;
 *   unusable        the read itself failed at probe time (transport, HTTP or
 *                   JSON-RPC error).
 */
export type SolanaProbePathOutcome = "usable" | "not_established" | "unusable";

const OUTCOMES: readonly SolanaProbePathOutcome[] = ["usable", "not_established", "unusable"];

/**
 * Already-acquired Solana capability probe for ONE network from ONE source.
 * Every `usable` path must cite at least one EvidenceRef classified to that
 * path (`metadata.probePath`, else `metadata.rpcMethod`); unclassified refs
 * are inert extra provenance.
 */
export interface SolanaCapabilityProbeObservation {
  readonly network: NetworkId;
  readonly source: { readonly sourceId: string; readonly sourceType: typeof SOURCE_TYPE };
  readonly observedAt: Iso8601;
  /** FULL observed getGenesisHash result; required when the identity path is usable. */
  readonly genesisHash?: string;
  readonly rpcReachable: boolean;
  readonly paths: Readonly<Record<SolanaProbePath, SolanaProbePathOutcome>>;
  /** The probe subject's signature status reported confirmationStatus=finalized. */
  readonly finalizedCommitmentObserved: boolean;
  /** Signature/slot/error/parent-slot cross-checks between the lookups all held. */
  readonly lookupsCoherent: boolean;
  readonly evidence: EvidenceRef[];
}

/**
 * `probe`: the caller's own fresh observation; the snapshot states
 * availability AS OF that probe time. This is a producer assertion the
 * derivation cannot verify; consumers apply their own freshness window.
 * `historical_replay`: archived observations; every supported capability is
 * projected to current availability `unknown`.
 */
export type SolanaBeforeObservationKind = "probe" | "historical_replay";

export interface SolanaBeforeDerivationInput {
  /** EXPLICIT genesis-bound configuration (validated, never inferred). */
  readonly config: SolanaBeforeNetworkConfig;
  readonly observationKind: SolanaBeforeObservationKind;
  readonly observation: SolanaCapabilityProbeObservation;
}

export interface SolanaBeforeFoundation {
  readonly manifest: ResolverManifest;
  readonly network: NetworkFingerprint;
  readonly snapshot: CapabilitySnapshot;
  readonly candidate: DiscoveryCandidate;
}

const OBSERVATION_KEYS: readonly string[] = [
  "network",
  "source",
  "observedAt",
  "genesisHash",
  "rpcReachable",
  "paths",
  "finalizedCommitmentObserved",
  "lookupsCoherent",
  "evidence",
];

interface ClassifiedProbe {
  readonly observation: SolanaCapabilityProbeObservation;
  readonly byPath: ReadonlyMap<SolanaProbePath, readonly string[]>;
}

function validateObservation(value: unknown, config: SolanaBeforeNetworkConfig): ClassifiedProbe {
  const raw = exactKeys(value, "observation", OBSERVATION_KEYS, OBSERVATION_KEYS.filter((key) => key !== "genesisHash"));
  try {
    assertNetworkId(raw.network, "observation.network");
  } catch (error) {
    probeInvalid((error as Error).message);
  }
  if (raw.network !== config.networkId) {
    solanaFail(
      "SOLANA_NETWORK_MISMATCH",
      `observation.network ${JSON.stringify(raw.network)} differs from the configured ${JSON.stringify(config.networkId)}; failing closed`,
    );
  }
  const source = exactKeys(raw.source, "observation.source", ["sourceId", "sourceType"], ["sourceId", "sourceType"]);
  if (typeof source.sourceId !== "string" || source.sourceId.length === 0) probeInvalid("observation.source.sourceId must be a non-empty string");
  if (source.sourceType !== SOURCE_TYPE) probeInvalid(`observation.source.sourceType must be exactly ${JSON.stringify(SOURCE_TYPE)}`);
  if (typeof raw.observedAt !== "string") solanaFail("SOLANA_TIME_INVALID", "observation.observedAt must be an ISO-8601 UTC timestamp string");
  try {
    assertIso8601(raw.observedAt, "observation.observedAt");
  } catch (error) {
    solanaFail("SOLANA_TIME_INVALID", (error as Error).message);
  }
  for (const key of ["rpcReachable", "finalizedCommitmentObserved", "lookupsCoherent"] as const) {
    if (typeof raw[key] !== "boolean") probeInvalid(`observation.${key} must be a boolean`);
  }
  const paths = exactKeys(raw.paths, "observation.paths", PROBE_PATHS, PROBE_PATHS);
  for (const path of PROBE_PATHS) {
    if (!OUTCOMES.includes(paths[path] as SolanaProbePathOutcome)) probeInvalid(`observation.paths.${path} must be one of ${OUTCOMES.join("/")}`);
  }
  const obs = raw as unknown as SolanaCapabilityProbeObservation;

  // Genesis binding: the FULL observed hash must equal the pinned one.
  if (raw.genesisHash !== undefined) {
    if (typeof raw.genesisHash !== "string") probeInvalid("observation.genesisHash must be a string");
    try {
      parseGenesisHash(raw.genesisHash, "observation.genesisHash");
    } catch (error) {
      probeInvalid((error as Error).message);
    }
    if (raw.genesisHash !== config.genesisHash) {
      solanaFail(
        "SOLANA_NETWORK_MISMATCH",
        `observed full genesis hash ${JSON.stringify(raw.genesisHash)} differs from the configured ${JSON.stringify(config.genesisHash)}; failing closed`,
      );
    }
  } else if (obs.paths.genesisidentity === "usable") {
    probeInvalid("a usable genesisidentity path must carry the observed full genesisHash");
  }

  if (!Array.isArray(raw.evidence)) probeInvalid("observation.evidence must be an array");
  const evidence = raw.evidence as unknown[];
  const byPath = new Map<SolanaProbePath, string[]>(PROBE_PATHS.map((path) => [path, []]));
  const seen = new Set<string>();
  for (let i = 0; i < evidence.length; i++) {
    const ref = evidence[i] as EvidenceRef;
    try {
      validateEvidenceRef(ref, `observation.evidence[${i}]`);
    } catch (error) {
      probeInvalid((error as Error).message);
    }
    if (seen.has(ref.id)) probeInvalid(`duplicate EvidenceId ${JSON.stringify(ref.id)}`);
    seen.add(ref.id);
    if (ref.networkId !== undefined && ref.networkId !== config.networkId) {
      solanaFail(
        "SOLANA_NETWORK_MISMATCH",
        `observation.evidence[${i}] networkId ${JSON.stringify(ref.networkId)} differs from the configured network; cross-network probe tables fail closed`,
      );
    }
    if (ref.sourceId !== source.sourceId || ref.sourceType !== source.sourceType) {
      probeInvalid(`observation.evidence[${i}] must come from the single probe source`);
    }
    const meta = ref.metadata as Record<string, unknown> | undefined;
    let path: SolanaProbePath | undefined;
    const tag = meta?.[SOLANA_PROBE_PATH_METADATA_KEY];
    if (tag !== undefined) {
      if (typeof tag !== "string" || !PROBE_PATHS.includes(tag as SolanaProbePath)) {
        probeInvalid(`evidence ${JSON.stringify(ref.id)}: unknown ${SOLANA_PROBE_PATH_METADATA_KEY} tag ${JSON.stringify(String(tag))}`);
      }
      path = tag as SolanaProbePath;
    } else if (meta?.rpcMethod !== undefined) {
      if (typeof meta.rpcMethod !== "string") probeInvalid(`evidence ${JSON.stringify(ref.id)}: metadata.rpcMethod must be a string`);
      path = RPC_METHOD_PROBE_PATHS.get(meta.rpcMethod);
    }
    if (path !== undefined) (byPath.get(path) as string[]).push(ref.id);
  }

  // Ghost-evidence and contradiction rules (positive claims need provenance).
  const anyUsable = PROBE_PATHS.some((path) => obs.paths[path] === "usable");
  if (!obs.rpcReachable && (anyUsable || obs.finalizedCommitmentObserved || obs.lookupsCoherent)) {
    solanaFail("SOLANA_OBSERVATION_INCOMPLETE", "positive probe claims contradict rpcReachable=false");
  }
  if (obs.rpcReachable && evidence.length === 0) {
    solanaFail("SOLANA_OBSERVATION_INCOMPLETE", "positive rpcReachable claim cites no EvidenceRef");
  }
  for (const path of PROBE_PATHS) {
    if (obs.paths[path] === "usable" && (byPath.get(path) ?? []).length === 0) {
      solanaFail(
        "SOLANA_OBSERVATION_INCOMPLETE",
        `usable ${path} claim cites no ${path} EvidenceRef; ghost evidence cannot back availability`,
      );
    }
  }
  if (obs.finalizedCommitmentObserved && obs.paths.signaturestatus !== "usable") {
    solanaFail("SOLANA_OBSERVATION_INCOMPLETE", "finalizedCommitmentObserved requires a usable signaturestatus path");
  }
  if (obs.lookupsCoherent && LOOKUP_PATHS.some((path) => obs.paths[path] !== "usable")) {
    solanaFail("SOLANA_OBSERVATION_INCOMPLETE", "lookupsCoherent requires usable transaction, signaturestatus and finalizedblock paths");
  }
  return { observation: obs, byPath };
}

// ---------------------------------------------------------------------------
// Capability derivation (support NEVER depends on the probe outcome)
// ---------------------------------------------------------------------------

function deriveState(probe: ClassifiedProbe, finality: boolean, metadata: Record<string, unknown>): CapabilityState {
  const obs = probe.observation;
  const meta = Object.keys(metadata).length === 0 ? {} : { metadata };
  const negative = (availability: "unknown" | "unavailable" | "degraded", reason: string): CapabilityState => ({
    support: "supported",
    availability,
    reason,
    ...meta,
  });
  if (!obs.rpcReachable) return negative("unavailable", "probe source did not answer during the capability probe");
  if (obs.paths.genesisidentity === "unusable") {
    return negative("unavailable", "getGenesisHash failed at probe time; network identity cannot be bound, so no acquisition can proceed");
  }
  if (obs.paths.genesisidentity !== "usable") {
    return negative("unknown", "the full getGenesisHash network identity was not observed by the probe; usability is undetermined");
  }
  for (const path of LOOKUP_PATHS) {
    if (obs.paths[path] === "unusable") {
      return negative("unavailable", `${path} read failed at probe time; the single post-action acquisition pipeline cannot complete`);
    }
  }
  for (const path of LOOKUP_PATHS) {
    if (obs.paths[path] !== "usable") {
      return negative(
        "unknown",
        `${path} lookup was not established at probe time (not probed, or the probe subject was absent or pruned at this source); usability is undetermined`,
      );
    }
  }
  if (!obs.lookupsCoherent) {
    return negative("degraded", "the probe's transaction, signature-status and finalized-block observations were mutually inconsistent");
  }
  if (finality && !obs.finalizedCommitmentObserved) {
    return negative("unknown", "finalized commitment was not observed for the probe subject; finality path usability is undetermined");
  }
  const ids: string[] = [];
  for (const path of PROBE_PATHS) {
    for (const id of probe.byPath.get(path) ?? []) if (!ids.includes(id)) ids.push(id);
  }
  return { support: "supported", availability: "available", evidence: ids, ...meta };
}

const FINALITY_METADATA: Record<string, unknown> = {
  semantics: SOLANA_BEFORE_FINALITY_SEMANTICS,
  basis: "source_observation",
  doesNotEstablish: [...SOLANA_FINALITY_DOES_NOT_ESTABLISH],
  availabilityScope:
    "usability of the configured source's finalized transaction/status/block view at probe time; a specific action's finality is decided only post-action",
};

const OBSERVED_EFFECTS_METADATA: Record<string, unknown> = {
  effectTypes: [TRANSFER_CHECKED_EFFECT_TYPE],
  scope: "only SPL Token / Token-2022 TransferChecked instructions of successful legacy/v0 transactions are decoded",
};

/** Archived replay never establishes current availability. */
function historicalState(state: CapabilityState, captureTime: Iso8601): CapabilityState {
  if (state.support !== "supported") return state;
  return {
    support: state.support,
    availability: "unknown",
    reason: "archived historical replay does not establish current availability",
    ...(state.evidence === undefined ? {} : { evidence: [...state.evidence] }),
    metadata: {
      ...(state.metadata ?? {}),
      observationKind: "historical_replay",
      historicalCaptureTime: captureTime,
      historicalAvailabilityAtCapture: state.availability,
      ...(state.reason === undefined ? {} : { historicalReasonAtCapture: state.reason }),
      currentAvailability: "unknown",
      statement: "the cited paths were observed at capture time; this is not a current probe",
    },
  };
}

function retype(error: unknown, fallback: NecResolverSolanaErrorCode): never {
  if (error instanceof NecResolverSolanaError) throw error;
  if (error instanceof NecError) throw new NecResolverSolanaError(fallback, error.message);
  throw error;
}

/**
 * Derive the Solana BEFORE foundation from ONE explicit config and ONE pure
 * probe observation. All artifact construction is delegated to the frozen
 * @nec/core builders (self-digest, probe-target equality, manifest authority).
 */
export function deriveSolanaBeforeFoundation(input: SolanaBeforeDerivationInput): SolanaBeforeFoundation {
  try {
    return deriveFoundation(input);
  } catch (error) {
    retype(error, "SOLANA_PROBE_INVALID");
  }
}

function deriveFoundation(input: SolanaBeforeDerivationInput): SolanaBeforeFoundation {
  const root = exactKeys(input, "input", ["config", "observationKind", "observation"], ["config", "observationKind", "observation"]);
  validateSolanaBeforeNetworkConfig(root.config);
  const config = root.config;
  const kind = root.observationKind;
  if (kind !== "probe" && kind !== "historical_replay") probeInvalid('observationKind must be exactly "probe" or "historical_replay"');
  const probe = validateObservation(root.observation, config);
  const obs = probe.observation;

  let execution = deriveState(probe, false, {});
  let observedEffects = deriveState(probe, false, OBSERVED_EFFECTS_METADATA);
  let dataBinding = deriveState(probe, false, {});
  let finality = deriveState(probe, true, FINALITY_METADATA);
  if (kind === "historical_replay") {
    execution = historicalState(execution, obs.observedAt);
    observedEffects = historicalState(observedEffects, obs.observedAt);
    dataBinding = historicalState(dataBinding, obs.observedAt);
    finality = historicalState(finality, obs.observedAt);
  }

  const networkId = config.networkId as NetworkId;
  // genesisId only when the probe itself established the identity path; a
  // supplied hash is still bound above but never presented as observed.
  const genesisObserved = obs.paths.genesisidentity === "usable" && obs.genesisHash !== undefined;
  const network: NetworkFingerprint = {
    networkId,
    ...(genesisObserved ? { genesisId: obs.genesisHash } : {}),
    observedAt: { timestamp: obs.observedAt },
    metadata: {
      chainFamily: SOLANA_FAMILY,
      observationKind: kind,
      probeSource: { sourceId: obs.source.sourceId, sourceType: obs.source.sourceType },
    },
  };
  const manifest = solanaBeforeResolverManifest();
  const snapshot = buildCapabilitySnapshot(
    {
      schemaVersion: "0.1",
      id: `solana-capsnap-${networkId}`,
      generatedAt: obs.observedAt,
      network,
      evidenceCapabilities: {
        execution,
        observedEffects,
        dataBinding,
        settlement: { support: "unsupported", availability: "unavailable", reason: REASON_SETTLEMENT_UNSUPPORTED },
        finality,
      },
      // Deliberately EMPTY: no executionModel/accountModel/gasModel/
      // simulation/batching dimension is evaluated or evidenced.
      executionCapabilities: {},
      evidence: [...obs.evidence],
      resolver: manifestRef(manifest),
    },
    { resolver: manifest, networkId },
  );
  return deepFreeze({
    manifest,
    network: snapshot.network,
    snapshot,
    candidate: { network: snapshot.network, snapshot, resolver: manifest },
  });
}

// ---------------------------------------------------------------------------
// Acquisition -> probe observation (pure projection)
// ---------------------------------------------------------------------------

// Cross-lookup coherence; presence is expressed by the path outcomes.
const COHERENCE_CHECKS = new Set([
  "TRANSACTION_SIGNATURE_MATCHES_SUBJECT",
  "STATUS_SLOT_MATCHES_TRANSACTION",
  "STATUS_ERROR_MATCHES_TRANSACTION",
  "BLOCK_PARENT_PRECEDES_SLOT",
]);

/**
 * Project ONE completed `nec-resolver-solana-acquisition-v1` acquisition (live
 * with an explicit fetchFn, or offline replay) onto a probe observation. The
 * EvidenceRefs are the post-action evaluator's own citation table (same ids).
 * Null lookups are `not_established`; a completed acquisition never has an
 * `unusable` path (any read failure aborts it). Pure: no I/O.
 */
export function solanaProbeObservationFromAcquisition(acquisition: SolanaTransactionAcquisition): SolanaCapabilityProbeObservation {
  if (!isPlainObject(acquisition) || acquisition.profile !== ACQUISITION_PROFILE) {
    probeInvalid("not a resolver-solana acquisition");
  }
  let evidence: readonly EvidenceRef[];
  try {
    evidence = evaluateSolanaTransaction(acquisition).fragment.evidence;
  } catch (error) {
    retype(error, "SOLANA_PROBE_INVALID");
  }
  const paths: Record<SolanaProbePath, SolanaProbePathOutcome> = {
    genesisidentity: acquisition.captures.some((capture) => capture.rpcMethod === "getGenesisHash") ? "usable" : "not_established",
    transaction: acquisition.transaction !== null ? "usable" : "not_established",
    signaturestatus: acquisition.signatureStatus.value !== null ? "usable" : "not_established",
    finalizedblock: acquisition.block !== null && acquisition.block !== undefined ? "usable" : "not_established",
  };
  const allLookups = LOOKUP_PATHS.every((path) => paths[path] === "usable");
  return {
    network: acquisition.source.networkId,
    source: { sourceId: acquisition.source.sourceId, sourceType: SOURCE_TYPE },
    observedAt: acquisition.acquiredAt,
    genesisHash: acquisition.genesisHash,
    rpcReachable: acquisition.captures.length > 0,
    paths,
    finalizedCommitmentObserved: acquisition.signatureStatus.value?.confirmationStatus === "finalized",
    lookupsCoherent: allLookups && acquisition.checks.filter((check) => COHERENCE_CHECKS.has(check.code)).every((check) => check.passed),
    evidence: [...evidence],
  };
}

// ---------------------------------------------------------------------------
// Preflight evidence readiness
// ---------------------------------------------------------------------------

const READY_REASON = "evidence acquisition for this dimension is usable and concretely evidenced";
const UNDETERMINED_REASON = "capability usability could not be determined from the probe observation";

/**
 * Evidence-readiness Preflight for a Solana BEFORE foundation. Projection
 * (core helpers only): usable -> ready; unsupported -> not_applicable;
 * deterministically unavailable/degraded -> blocked; otherwise unknown. The
 * overall status is recomputed by the core composer, never authored here.
 */
export function deriveSolanaBeforePreflightResult(foundation: SolanaBeforeFoundation, request: PreflightRequest): PreflightResult {
  try {
    if (!isPlainObject(foundation)) probeInvalid("preflight foundation must be a plain object");
    validatePreflightRequest(request);
    validateResolverManifest(foundation.manifest);
    validateCapabilitySnapshot(foundation.snapshot);
    const expected = solanaBeforeResolverManifest();
    const ref = foundation.snapshot.resolver;
    if (
      foundation.manifest.digest !== expected.digest ||
      ref.id !== expected.id ||
      ref.version !== expected.version ||
      ref.digest !== expected.digest
    ) {
      probeInvalid("preflight foundation is not bound to the Solana BEFORE v0.1 manifest");
    }
    const snapshot = foundation.snapshot;
    if (request.networkId !== snapshot.network.networkId) {
      solanaFail(
        "SOLANA_NETWORK_MISMATCH",
        `preflight request network ${JSON.stringify(request.networkId)} does not match the foundation network ${JSON.stringify(
          snapshot.network.networkId,
        )}; failing closed`,
      );
    }
    const evidenceReadiness = {} as Record<(typeof EVIDENCE_READINESS_KEYS)[number], ReadinessCheck>;
    for (const dimension of EVIDENCE_READINESS_KEYS) {
      const state = snapshot.evidenceCapabilities[dimension];
      const metadata = dimension === "finality" ? { metadata: { ...FINALITY_METADATA } } : {};
      if (capabilityIsUsable(state, snapshot.evidence)) {
        evidenceReadiness[dimension] = { status: "ready", reason: READY_REASON, evidence: [...(state.evidence ?? [])], ...metadata };
      } else if (state.support === "unsupported") {
        evidenceReadiness[dimension] = { status: "not_applicable", reason: state.reason ?? REASON_SETTLEMENT_UNSUPPORTED };
      } else if (capabilityIsDeterministicallyUnavailable(state)) {
        evidenceReadiness[dimension] = { status: "blocked", reason: state.reason ?? UNDETERMINED_REASON, ...metadata };
      } else {
        evidenceReadiness[dimension] = { status: "unknown", reason: state.reason ?? UNDETERMINED_REASON, ...metadata };
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
  } catch (error) {
    retype(error, "SOLANA_PROBE_INVALID");
  }
}

// ---------------------------------------------------------------------------
// Offline replay of an archived fixture -> historical_replay foundation
// ---------------------------------------------------------------------------

export interface SolanaBeforeReplayInput {
  readonly config: SolanaBeforeNetworkConfig;
  /** Archived `nec-resolver-solana-fixture-v1` acquisition fixture. */
  readonly fixture: unknown;
}

/**
 * Replay an archived fixture OFFLINE (zero network I/O) through the unchanged
 * post-action acquisition pipeline and derive a `historical_replay`
 * foundation: capture-time availability is kept in metadata only and every
 * supported capability's CURRENT availability is `unknown`.
 */
export async function replaySolanaBeforeFoundation(input: SolanaBeforeReplayInput): Promise<SolanaBeforeFoundation> {
  try {
    const root = exactKeys(input, "input", ["config", "fixture"], ["config", "fixture"]);
    validateSolanaBeforeNetworkConfig(root.config);
    const config = root.config;
    const fixture = validateSolanaAcquisitionFixture(root.fixture);
    if (fixture.networkId !== config.networkId) {
      solanaFail("SOLANA_NETWORK_MISMATCH", "fixture network does not identify the configured network");
    }
    const acquisition = await replaySolanaTransaction(root.fixture);
    return deriveSolanaBeforeFoundation({
      config,
      observationKind: "historical_replay",
      observation: solanaProbeObservationFromAcquisition(acquisition),
    });
  } catch (error) {
    retype(error, "SOLANA_FIXTURE_INVALID");
  }
}
