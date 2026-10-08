/**
 * OP Stack BEFORE overlay (v0.1) over the generic EVM BEFORE foundation.
 *
 *   EvmCapabilityProbeObservation        (generic, @nec/resolver-evm)
 *     -> deriveEvmBeforeFoundation        (execution/observedEffects/dataBinding)
 *   OpStackFinalityProbeObservation      (this module, optional)
 *     -> OP Stack L2 block-finality capability state
 *   explicit OpStackFinalityConfig       (family NEVER inferred from chain id)
 *     -> ResolverManifest + CapabilitySnapshot + DiscoveryCandidate
 *     -> evidence Preflight (delegated to the generic EVM projection)
 *
 * SEMANTIC BOUNDARY (never collapsed):
 *   - `finality` here means OP Stack L2 BLOCK finality as reported by the
 *     configured source's `finalized` head view under the pinned
 *     `opstack.rpc-finalized-head-v1` ruleset. It is NEVER withdrawal or
 *     output-root finalization, dispute-game resolution, settlement or
 *     economic irreversibility.
 *   - `settlement` is never claimed: finality support does not imply it.
 *   - Manifest membership permits evaluation only; availability derives from
 *     the supplied probe observations and their concrete EvidenceRefs.
 *   - `historical_replay` observations (archived fixtures) prove what was
 *     observed at capture time; every supported capability is then projected
 *     to CURRENT availability `unknown`, never to a live claim.
 *   - Preflight is evidence readiness only: no wallet, balance, funding, gas,
 *     signing or submission readiness is represented anywhere.
 *
 * FINALITY AVAILABILITY RULES (`probe` observations):
 *   no finality probe supplied                     -> unknown
 *   finality probe source did not answer           -> unavailable
 *   chain identity not observed by the probe       -> unknown
 *   finalized head lookup unusable                 -> unavailable (safe/latest
 *                                                     are never substituted)
 *   safe or latest head lookup unusable            -> unavailable (the pinned
 *                                                     ruleset requires both)
 *   observed head ordering incoherent              -> degraded
 *   generic execution (receipt+block) path not usable -> mirrors it
 *                                                     (an action's finality is
 *                                                     anchored to its block)
 *   otherwise                                      -> available, citing the
 *                                                     identity/head refs plus
 *                                                     the execution refs
 *
 * Pure: no network, clock, randomness, wallet, keys, signing, funding or
 * submission. Time enters only through observation timestamps. The async
 * `replayOpStackBeforeFoundation` helper performs offline fixture replay only.
 */

import {
  assertIso8601,
  assertNetworkId,
  buildCapabilitySnapshot,
  computeResolverManifestDigest,
  deepFreeze,
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
  ResolverManifest,
  ResolverManifestRef,
} from "@nec/core";
import {
  buildEvidenceRefs,
  deriveEvmBeforeFoundation,
  deriveEvmBeforePreflightResult,
  evmBeforeResolverManifest,
  NecResolverEvmError,
  replayTransactionAcquisition,
  validateEvmAcquisitionFixture,
} from "@nec/resolver-evm";
import type {
  EvmBeforeFoundation,
  EvmCapabilityProbeObservation,
  EvmTransactionAcquisition,
} from "@nec/resolver-evm";

import {
  OPSTACK_FAMILY,
  OPSTACK_FINALITY_RULESET,
  OPSTACK_FINALITY_RULESET_VERSION,
  validateOpStackFinalityConfig,
} from "./config.js";
import type { OpStackFinalityConfig } from "./config.js";
import { NecResolverOpStackError, opstackFail } from "./errors.js";
import type { NecResolverOpStackErrorCode } from "./errors.js";
import type { OpStackFinalityObservation } from "./acquire.js";
import { replayOpStackFinalityObservation } from "./replay.js";

// ---------------------------------------------------------------------------
// Manifest — THE support authority of the OP Stack BEFORE overlay
// ---------------------------------------------------------------------------

export const OPSTACK_BEFORE_PROFILE = "opstack-before-v0.1";

/** What an OP Stack L2 finalized block NEVER establishes here. */
export const OPSTACK_FINALITY_DOES_NOT_ESTABLISH: readonly string[] = Object.freeze([
  "withdrawal_finalization",
  "output_root_finalization",
  "dispute_game_resolution",
  "settlement",
  "economic_irreversibility",
]);

export const OPSTACK_BEFORE_FINALITY_SEMANTICS =
  "OP Stack L2 block finality as reported by the configured source's eth_getBlockByNumber(\"finalized\") view under ruleset opstack.rpc-finalized-head-v1; never withdrawal or output-root finalization";

const REASON_SETTLEMENT_UNSUPPORTED =
  "not claimed by the OP Stack BEFORE v0.1 manifest: L2 block finality is never settlement and withdrawal/output-root finalization is never inferred";

let manifestCache: ResolverManifest | undefined;

/**
 * THE ResolverManifest of the OP Stack BEFORE overlay (frozen,
 * digest-bound): the generic EVM capabilities plus OP Stack L2 block
 * `finality`. Never `settlement`. Membership permits evaluation only.
 */
export function opStackBeforeResolverManifest(): ResolverManifest {
  if (manifestCache === undefined) {
    const evm = evmBeforeResolverManifest();
    const content: Omit<ResolverManifest, "digest"> = {
      id: "resolver-opstack-before",
      version: "0.1.0",
      networkFamilies: ["eip155"],
      implementation: { package: "@nec/resolver-opstack" },
      supportedCapabilities: ["execution", "observedEffects", "dataBinding", "finality"],
      sourceRequirements: [{ sourceType: "evm_rpc", required: true }],
      metadata: {
        profile: OPSTACK_BEFORE_PROFILE,
        chainFamily: OPSTACK_FAMILY,
        chainFamilyConfiguration: "explicit OpStackFinalityConfig; never inferred from a chain id",
        finalityRuleset: OPSTACK_FINALITY_RULESET,
        finalityRulesetVersion: OPSTACK_FINALITY_RULESET_VERSION,
        finalitySemantics: OPSTACK_BEFORE_FINALITY_SEMANTICS,
        finalityDoesNotEstablish: [...OPSTACK_FINALITY_DOES_NOT_ESTABLISH],
        settlement: "never claimed",
        genericEvmFoundation: { id: evm.id, version: evm.version, digest: evm.digest },
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
// Pure finality probe observation model (input only — nothing is fetched)
// ---------------------------------------------------------------------------

/** Explicit `metadata.probePath` tag classifying finality probe EvidenceRefs. */
export const OPSTACK_PROBE_PATH_METADATA_KEY = "probePath";

export type OpStackFinalityProbePath = "chainidentity" | "finalizedhead" | "safehead" | "latesthead";

const FINALITY_PROBE_PATHS: readonly OpStackFinalityProbePath[] = [
  "chainidentity",
  "finalizedhead",
  "safehead",
  "latesthead",
];

/**
 * Already-acquired OP Stack finality-path probe for ONE network from ONE
 * configured source. Every positive flag must be backed by at least one
 * EvidenceRef tagged with the matching `metadata.probePath`; untagged refs
 * are inert extra provenance.
 */
export interface OpStackFinalityProbeObservation {
  readonly network: NetworkId;
  readonly source: { readonly sourceId: string; readonly sourceType: string };
  readonly observedAt: Iso8601;
  /** Observed EIP-155 chain id; required when chainIdentityObserved. */
  readonly chainId?: number;
  readonly rpcReachable: boolean;
  readonly chainIdentityObserved: boolean;
  readonly finalizedHeadLookupUsable: boolean;
  readonly safeHeadLookupUsable: boolean;
  readonly latestHeadLookupUsable: boolean;
  /** finalized <= safe <= latest held, with equal-height heads equal. */
  readonly headOrderingCoherent: boolean;
  readonly evidence: EvidenceRef[];
}

/**
 * `probe`: the caller supplies observations acquired by its own probe; the
 * snapshot states availability AS OF that probe time.
 * `historical_replay`: archived observations; every supported capability is
 * projected to current availability `unknown`.
 */
export type OpStackBeforeObservationKind = "probe" | "historical_replay";

export interface OpStackBeforeDerivationInput {
  /** EXPLICIT family/network configuration (validated, never inferred). */
  readonly config: OpStackFinalityConfig;
  readonly observationKind: OpStackBeforeObservationKind;
  readonly evmObservation: EvmCapabilityProbeObservation;
  /** Absent => finality availability stays `unknown`. */
  readonly finalityObservation?: OpStackFinalityProbeObservation;
}

export interface OpStackBeforeFoundation {
  readonly manifest: ResolverManifest;
  readonly network: NetworkFingerprint;
  readonly snapshot: CapabilitySnapshot;
  readonly candidate: DiscoveryCandidate;
}

const FINALITY_OBSERVATION_KEYS: readonly string[] = [
  "network",
  "source",
  "observedAt",
  "chainId",
  "rpcReachable",
  "chainIdentityObserved",
  "finalizedHeadLookupUsable",
  "safeHeadLookupUsable",
  "latestHeadLookupUsable",
  "headOrderingCoherent",
  "evidence",
];

const FINALITY_FLAG_PATHS: ReadonlyArray<
  readonly [keyof OpStackFinalityProbeObservation, OpStackFinalityProbePath]
> = [
  ["chainIdentityObserved", "chainidentity"],
  ["finalizedHeadLookupUsable", "finalizedhead"],
  ["safeHeadLookupUsable", "safehead"],
  ["latestHeadLookupUsable", "latesthead"],
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function probeInvalid(detail: string): never {
  opstackFail("OPSTACK_PROBE_INVALID", `OP Stack BEFORE input rejected: ${detail}`);
}

function exactKeys(value: unknown, path: string, allowed: readonly string[], required: readonly string[]): Record<string, unknown> {
  if (!isPlainObject(value)) probeInvalid(`${path} must be a plain object`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") probeInvalid(`${path}: symbol-keyed properties are not allowed`);
    if (!allowed.includes(key)) probeInvalid(`${path}: unknown key ${JSON.stringify(key)}`);
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      probeInvalid(`${path}: missing required key ${JSON.stringify(key)}`);
    }
  }
  return value;
}

function assertIsoTime(value: unknown, path: string): Iso8601 {
  if (typeof value !== "string") {
    opstackFail("OPSTACK_TIME_INVALID", `${path} must be an ISO-8601 UTC timestamp string`);
  }
  try {
    assertIso8601(value, path);
  } catch (error) {
    opstackFail("OPSTACK_TIME_INVALID", `${path}: ${(error as Error).message}`);
  }
  return value as Iso8601;
}

/** Explicitly configured chain identity is enforced on every observation. */
function assertChainIdentity(
  config: OpStackFinalityConfig,
  chainId: unknown,
  chainIdentityObserved: boolean,
  path: string,
): void {
  if (chainId !== undefined) {
    if (typeof chainId !== "number" || !Number.isSafeInteger(chainId) || chainId <= 0) {
      probeInvalid(`${path}.chainId must be a safe positive integer`);
    }
    if (chainId !== config.chainId) {
      opstackFail(
        "OPSTACK_NETWORK_MISMATCH",
        `${path}.chainId ${chainId} differs from the explicitly configured chainId ${config.chainId}; failing closed`,
      );
    }
  } else if (chainIdentityObserved) {
    probeInvalid(`${path}: a positive chainIdentityObserved claim must carry the observed chainId`);
  }
}

interface ClassifiedFinalityProbe {
  readonly observation: OpStackFinalityProbeObservation;
  readonly byPath: ReadonlyMap<OpStackFinalityProbePath, readonly string[]>;
}

function validateFinalityObservation(
  value: unknown,
  config: OpStackFinalityConfig,
): ClassifiedFinalityProbe {
  const raw = exactKeys(
    value,
    "finalityObservation",
    FINALITY_OBSERVATION_KEYS,
    FINALITY_OBSERVATION_KEYS.filter((key) => key !== "chainId"),
  );
  try {
    assertNetworkId(raw.network, "finalityObservation.network");
  } catch (error) {
    probeInvalid((error as Error).message);
  }
  if (raw.network !== config.networkId) {
    opstackFail(
      "OPSTACK_NETWORK_MISMATCH",
      `finalityObservation.network ${JSON.stringify(raw.network)} differs from the configured ${JSON.stringify(config.networkId)}`,
    );
  }
  const source = exactKeys(raw.source, "finalityObservation.source", ["sourceId", "sourceType"], ["sourceId", "sourceType"]);
  if (typeof source.sourceId !== "string" || source.sourceId.length === 0) {
    probeInvalid("finalityObservation.source.sourceId must be a non-empty string");
  }
  if (source.sourceType !== "evm_rpc") {
    probeInvalid("finalityObservation.source.sourceType must be exactly \"evm_rpc\"");
  }
  assertIsoTime(raw.observedAt, "finalityObservation.observedAt");
  for (const key of FINALITY_OBSERVATION_KEYS) {
    if (key.endsWith("Usable") || key === "rpcReachable" || key === "chainIdentityObserved" || key === "headOrderingCoherent") {
      if (typeof raw[key] !== "boolean") probeInvalid(`finalityObservation.${key} must be a boolean`);
    }
  }
  const obs = raw as unknown as OpStackFinalityProbeObservation;
  assertChainIdentity(config, raw.chainId, obs.chainIdentityObserved, "finalityObservation");

  if (!Array.isArray(raw.evidence)) probeInvalid("finalityObservation.evidence must be an array");
  const byPath = new Map<OpStackFinalityProbePath, string[]>(FINALITY_PROBE_PATHS.map((path) => [path, []]));
  const seen = new Set<string>();
  const evidence = raw.evidence as unknown[];
  for (let i = 0; i < evidence.length; i++) {
    const ref = evidence[i] as EvidenceRef;
    try {
      validateEvidenceRef(ref, `finalityObservation.evidence[${i}]`);
    } catch (error) {
      probeInvalid((error as Error).message);
    }
    if (seen.has(ref.id)) probeInvalid(`duplicate EvidenceId ${JSON.stringify(ref.id)}`);
    seen.add(ref.id);
    if (ref.networkId !== undefined && ref.networkId !== config.networkId) {
      opstackFail(
        "OPSTACK_NETWORK_MISMATCH",
        `finalityObservation.evidence[${i}] networkId ${JSON.stringify(ref.networkId)} differs from the configured network`,
      );
    }
    if (ref.sourceId !== source.sourceId || ref.sourceType !== source.sourceType) {
      probeInvalid(`finalityObservation.evidence[${i}] must come from the single configured finality probe source`);
    }
    const tag = (ref.metadata as Record<string, unknown> | undefined)?.[OPSTACK_PROBE_PATH_METADATA_KEY];
    if (tag === undefined) continue;
    if (typeof tag !== "string" || !FINALITY_PROBE_PATHS.includes(tag as OpStackFinalityProbePath)) {
      probeInvalid(`evidence ${JSON.stringify(ref.id)}: unknown ${OPSTACK_PROBE_PATH_METADATA_KEY} tag ${JSON.stringify(String(tag))}`);
    }
    (byPath.get(tag as OpStackFinalityProbePath) as string[]).push(ref.id);
  }

  // Ghost-evidence and contradiction rules (positive claims need provenance).
  const anyPositive = FINALITY_FLAG_PATHS.some(([flag]) => obs[flag] === true) || obs.headOrderingCoherent;
  if (!obs.rpcReachable && anyPositive) {
    opstackFail("OPSTACK_OBSERVATION_INCOMPLETE", "positive finality probe flags contradict rpcReachable=false");
  }
  if (obs.rpcReachable && evidence.length === 0) {
    opstackFail("OPSTACK_OBSERVATION_INCOMPLETE", "positive rpcReachable claim cites no EvidenceRef");
  }
  for (const [flag, path] of FINALITY_FLAG_PATHS) {
    if (obs[flag] === true && (byPath.get(path) ?? []).length === 0) {
      opstackFail(
        "OPSTACK_OBSERVATION_INCOMPLETE",
        `positive ${path} claim cites no ${path} EvidenceRef; ghost evidence cannot back availability`,
      );
    }
  }
  if (obs.headOrderingCoherent && !(obs.finalizedHeadLookupUsable && obs.safeHeadLookupUsable && obs.latestHeadLookupUsable)) {
    opstackFail(
      "OPSTACK_OBSERVATION_INCOMPLETE",
      "headOrderingCoherent requires usable finalized, safe and latest head lookups",
    );
  }
  return { observation: obs, byPath };
}

// ---------------------------------------------------------------------------
// Capability derivation
// ---------------------------------------------------------------------------

function finalityMetadata(config: OpStackFinalityConfig, probe: ClassifiedFinalityProbe | undefined): Record<string, unknown> {
  return {
    chainFamily: config.family,
    ruleset: config.ruleset,
    rulesetVersion: config.rulesetVersion,
    semantics: OPSTACK_BEFORE_FINALITY_SEMANTICS,
    doesNotEstablish: [...OPSTACK_FINALITY_DOES_NOT_ESTABLISH],
    availabilityScope:
      "usability of the configured source's finalized/safe/latest head view at probe time; a specific action's finality is decided only post-action, after the source's finalized head reaches its block within the bounded ancestry walk",
    ...(probe === undefined
      ? {}
      : {
          finalityProbeSource: {
            sourceId: probe.observation.source.sourceId,
            sourceType: probe.observation.source.sourceType,
          },
          finalityProbeObservedAt: probe.observation.observedAt,
        }),
  };
}

function deriveFinalityState(
  config: OpStackFinalityConfig,
  execution: CapabilityState,
  probe: ClassifiedFinalityProbe | undefined,
): CapabilityState {
  const metadata = finalityMetadata(config, probe);
  const negative = (availability: "unknown" | "unavailable" | "degraded", reason: string): CapabilityState => ({
    support: "supported",
    availability,
    reason,
    metadata,
  });
  if (probe === undefined) {
    return negative("unknown", "no OP Stack finality probe observation was supplied; finality availability is undetermined");
  }
  const obs = probe.observation;
  if (!obs.rpcReachable) {
    return negative("unavailable", "OP Stack finality probe source did not answer during the capability probe");
  }
  if (!obs.chainIdentityObserved) {
    return negative("unknown", "chain identity was not observed by the finality probe; usability is undetermined");
  }
  if (!obs.finalizedHeadLookupUsable) {
    return negative(
      "unavailable",
      "finalized head acquisition was unusable at probe time; safe/latest heads are never substituted for finalized",
    );
  }
  if (!obs.safeHeadLookupUsable || !obs.latestHeadLookupUsable) {
    return negative("unavailable", "safe/latest head acquisition required by the pinned ruleset was unusable at probe time");
  }
  if (!obs.headOrderingCoherent) {
    return negative("degraded", "the observed finalized/safe/latest head view was incoherent at probe time");
  }
  if (execution.availability !== "available") {
    return negative(
      execution.availability === "unknown" ? "unknown" : "unavailable",
      "the generic receipt/block anchor path that locates an action's containing block is not available",
    );
  }
  const ids: string[] = [];
  for (const path of FINALITY_PROBE_PATHS) {
    for (const id of probe.byPath.get(path) ?? []) if (!ids.includes(id)) ids.push(id);
  }
  for (const id of execution.evidence ?? []) if (!ids.includes(id)) ids.push(id);
  return { support: "supported", availability: "available", evidence: ids, metadata };
}

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

function retype(error: unknown, fallback: NecResolverOpStackErrorCode): never {
  if (error instanceof NecResolverOpStackError) throw error;
  if (error instanceof NecResolverEvmError) {
    const mapped: NecResolverOpStackErrorCode =
      error.code === "EVM_NETWORK_MISMATCH"
        ? "OPSTACK_NETWORK_MISMATCH"
        : error.code === "EVM_OBSERVATION_INCOMPLETE"
          ? "OPSTACK_OBSERVATION_INCOMPLETE"
          : error.code === "EVM_TIME_INVALID"
            ? "OPSTACK_TIME_INVALID"
            : error.code === "EVM_REPLAY_UNMATCHED_REQUEST"
              ? "OPSTACK_REPLAY_UNMATCHED_REQUEST"
              : error.code === "EVM_REPLAY_UNUSED_CAPTURES"
                ? "OPSTACK_REPLAY_UNUSED_CAPTURES"
                : fallback;
    throw new NecResolverOpStackError(mapped, error.message);
  }
  if (error instanceof NecError) throw new NecResolverOpStackError(fallback, error.message);
  throw error;
}

/**
 * Derive the OP Stack BEFORE foundation. The generic EVM foundation is
 * reused verbatim for execution/observedEffects/dataBinding; this overlay
 * only adds the OP Stack L2 block-finality state and its own manifest.
 */
export function deriveOpStackBeforeFoundation(input: OpStackBeforeDerivationInput): OpStackBeforeFoundation {
  try {
    return deriveFoundation(input);
  } catch (error) {
    retype(error, "OPSTACK_PROBE_INVALID");
  }
}

function deriveFoundation(input: OpStackBeforeDerivationInput): OpStackBeforeFoundation {
  const root = exactKeys(
    input,
    "input",
    ["config", "observationKind", "evmObservation", "finalityObservation"],
    ["config", "observationKind", "evmObservation"],
  );
  validateOpStackFinalityConfig(root.config);
  const config = root.config;
  const kind = root.observationKind;
  if (kind !== "probe" && kind !== "historical_replay") {
    probeInvalid("observationKind must be exactly \"probe\" or \"historical_replay\"");
  }
  const networkId = config.networkId as NetworkId;

  const evmRaw = exactKeys(
    root.evmObservation,
    "evmObservation",
    ["network", "source", "observedAt", "chainId", "rpcReachable", "chainIdentityObserved", "receiptLookupUsable", "blockLookupUsable", "transactionLookupUsable", "evidence"],
    [],
  );
  if (typeof evmRaw.chainIdentityObserved !== "boolean") {
    probeInvalid("evmObservation.chainIdentityObserved must be a boolean");
  }
  assertChainIdentity(config, evmRaw.chainId, evmRaw.chainIdentityObserved, "evmObservation");
  // Generic validation, ghost-evidence rule and network binding live here.
  const evm: EvmBeforeFoundation = deriveEvmBeforeFoundation({
    networkId,
    observation: root.evmObservation as EvmCapabilityProbeObservation,
  });

  const hasFinality = Object.prototype.hasOwnProperty.call(root, "finalityObservation");
  const probe = hasFinality ? validateFinalityObservation(root.finalityObservation, config) : undefined;

  const evmTime = evm.snapshot.generatedAt;
  let generatedAt = evmTime;
  if (probe !== undefined) {
    const finalityTime = probe.observation.observedAt;
    if (kind === "probe" && finalityTime !== evmTime) {
      opstackFail(
        "OPSTACK_TIME_INVALID",
        "probe observations must share one probe time (evmObservation.observedAt === finalityObservation.observedAt)",
      );
    }
    if (finalityTime > generatedAt) generatedAt = finalityTime;
  }

  const evmIds = new Set(evm.snapshot.evidence.map((ref) => ref.id));
  const finalityEvidence = probe?.observation.evidence ?? [];
  for (const ref of finalityEvidence) {
    if (evmIds.has(ref.id)) {
      probeInvalid(`EvidenceId ${JSON.stringify(ref.id)} is duplicated across the EVM and finality probe tables`);
    }
  }

  const caps = evm.snapshot.evidenceCapabilities;
  let finality = deriveFinalityState(config, caps.execution, probe);
  let execution = caps.execution;
  let observedEffects = caps.observedEffects;
  let dataBinding = caps.dataBinding;
  if (kind === "historical_replay") {
    execution = historicalState(execution, evmTime);
    observedEffects = historicalState(observedEffects, evmTime);
    dataBinding = historicalState(dataBinding, evmTime);
    finality = historicalState(finality, probe?.observation.observedAt ?? evmTime);
  }

  const evmSource = (root.evmObservation as EvmCapabilityProbeObservation).source;
  const chainId = evm.network.chainId ?? probe?.observation.chainId;
  const network: NetworkFingerprint = {
    networkId,
    ...(chainId === undefined ? {} : { chainId }),
    observedAt: { timestamp: generatedAt },
    metadata: {
      chainFamily: config.family,
      observationKind: kind,
      probeSource: { sourceId: evmSource.sourceId, sourceType: evmSource.sourceType },
      ...(probe === undefined
        ? {}
        : {
            finalityProbeSource: {
              sourceId: probe.observation.source.sourceId,
              sourceType: probe.observation.source.sourceType,
            },
          }),
    },
  };

  const manifest = opStackBeforeResolverManifest();
  const snapshot = buildCapabilitySnapshot(
    {
      schemaVersion: "0.1",
      id: `opstack-capsnap-${networkId}`,
      generatedAt,
      network,
      evidenceCapabilities: {
        execution,
        observedEffects,
        dataBinding,
        settlement: { support: "unsupported", availability: "unavailable", reason: REASON_SETTLEMENT_UNSUPPORTED },
        finality,
      },
      executionCapabilities: {},
      evidence: [...evm.snapshot.evidence, ...finalityEvidence],
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
// Preflight evidence readiness
// ---------------------------------------------------------------------------

/**
 * Evidence-readiness Preflight for an OP Stack BEFORE foundation. The
 * readiness projection is the generic EVM one (core composer recomputes the
 * overall status); this wrapper only binds the foundation to the OP Stack
 * manifest and the request to the snapshot network.
 */
export function deriveOpStackBeforePreflightResult(
  foundation: OpStackBeforeFoundation,
  request: PreflightRequest,
): PreflightResult {
  try {
    if (!isPlainObject(foundation)) probeInvalid("preflight foundation must be a plain object");
    validatePreflightRequest(request);
    validateResolverManifest(foundation.manifest);
    validateCapabilitySnapshot(foundation.snapshot);
    const expected = opStackBeforeResolverManifest();
    const ref = foundation.snapshot.resolver;
    if (
      foundation.manifest.digest !== expected.digest ||
      ref.id !== expected.id ||
      ref.version !== expected.version ||
      ref.digest !== expected.digest
    ) {
      probeInvalid("preflight foundation is not bound to the OP Stack BEFORE v0.1 manifest");
    }
    if (request.networkId !== foundation.snapshot.network.networkId) {
      opstackFail(
        "OPSTACK_NETWORK_MISMATCH",
        `preflight request network ${JSON.stringify(request.networkId)} does not match the foundation network ${JSON.stringify(
          foundation.snapshot.network.networkId,
        )}; failing closed`,
      );
    }
    return deriveEvmBeforePreflightResult(foundation as unknown as EvmBeforeFoundation, request);
  } catch (error) {
    retype(error, "OPSTACK_PROBE_INVALID");
  }
}

// ---------------------------------------------------------------------------
// Offline replay of archived fixtures -> historical_replay foundation
// ---------------------------------------------------------------------------

export interface OpStackBeforeReplayInput {
  readonly config: OpStackFinalityConfig;
  /** Archived `nec-resolver-evm-fixture-v1` acquisition fixture. */
  readonly evmFixture: unknown;
  /** Archived `nec-resolver-opstack-fixture-v1` finality fixture. */
  readonly finalityFixture?: unknown;
}

function evmProbeFromAcquisition(acquisition: EvmTransactionAcquisition): EvmCapabilityProbeObservation {
  if (!acquisition.consistent) {
    opstackFail(
      "OPSTACK_OBSERVATION_INCOMPLETE",
      "archived generic EVM acquisition failed its consistency checks; it cannot back a capability observation",
    );
  }
  const has = (method: string): boolean => acquisition.captures.some((capture) => capture.rpcMethod === method);
  const chainId = Number(acquisition.chain.chainId);
  return {
    network: acquisition.source.networkId,
    ...(Number.isSafeInteger(chainId) && chainId > 0 ? { chainId } : {}),
    source: { sourceId: acquisition.source.sourceId, sourceType: acquisition.source.sourceType },
    observedAt: acquisition.acquiredAt,
    rpcReachable: acquisition.captures.length > 0,
    chainIdentityObserved: has("eth_chainId"),
    receiptLookupUsable: has("eth_getTransactionReceipt") && acquisition.receipt !== null,
    blockLookupUsable: has("eth_getBlockByHash") && acquisition.block !== undefined && acquisition.block !== null,
    transactionLookupUsable:
      has("eth_getTransactionByHash") && acquisition.transaction !== undefined && acquisition.transaction !== null,
    evidence: buildEvidenceRefs(acquisition),
  };
}

// Head-view coherence: ordering plus finalized-head stability within the burst.
// Subject/ancestry checks are action-specific and stay out of BEFORE.
const HEAD_ORDERING_CHECKS = new Set([
  "OP_FINALIZED_NOT_AHEAD_OF_SAFE",
  "OP_SAFE_NOT_AHEAD_OF_LATEST",
  "OP_SAFE_FINALIZED_COHERENT_AT_EQUAL_HEIGHT",
  "OP_FINALIZED_HEAD_STABLE",
]);

function finalityProbeFromReplay(observation: OpStackFinalityObservation): OpStackFinalityProbeObservation {
  for (const check of observation.checks) {
    if (check.code === "OP_CHAIN_ID_MATCHES_SOURCE" && !check.passed) {
      opstackFail("OPSTACK_NETWORK_MISMATCH", "archived finality burst failed its chain identity check");
    }
  }
  const pathOf = (method: string, params: readonly unknown[]): OpStackFinalityProbePath | undefined => {
    if (method === "eth_chainId") return "chainidentity";
    if (method !== "eth_getBlockByNumber") return undefined;
    if (params[0] === "finalized") return "finalizedhead";
    if (params[0] === "safe") return "safehead";
    if (params[0] === "latest") return "latesthead";
    return undefined;
  };
  // Same id scheme as the post-action evaluator's citation table; identical
  // re-read captures collapse to one ref.
  const byId = new Map<string, EvidenceRef>();
  for (const capture of observation.captures) {
    const path = pathOf(capture.rpcMethod, capture.rpcParams);
    if (path === undefined) continue;
    const kind = path === "chainidentity" ? "chainidentity" : `${path.slice(0, -4)}-head`;
    const id = `opstack-${kind}-${capture.contentDigest.slice("sha256:".length, "sha256:".length + 16)}`;
    if (byId.has(id)) continue;
    byId.set(id, {
      id,
      sourceId: capture.sourceId,
      sourceType: capture.sourceType,
      ...(capture.independenceGroup === undefined ? {} : { independenceGroup: capture.independenceGroup }),
      locator: `${capture.rpcMethod}:${JSON.stringify(capture.rpcParams.length === 1 ? capture.rpcParams[0] : capture.rpcParams)}`,
      retrievedAt: capture.acquiredAt,
      contentDigest: capture.contentDigest,
      networkId: capture.networkId,
      metadata: {
        [OPSTACK_PROBE_PATH_METADATA_KEY]: path,
        rpcMethod: capture.rpcMethod,
        httpStatus: capture.httpStatus,
        captureProfile: capture.profile,
        observationProfile: observation.profile,
      },
    });
  }
  const chainId = Number(observation.chain.chainId);
  const finalized = observation.finalizedHead !== null;
  const safe = observation.safeHead !== null;
  const latest = observation.latestHead !== null;
  const ordered = observation.checks
    .filter((check) => HEAD_ORDERING_CHECKS.has(check.code))
    .every((check) => check.passed);
  return {
    network: observation.source.networkId,
    source: { sourceId: observation.source.sourceId, sourceType: observation.source.sourceType },
    observedAt: observation.acquiredAt,
    ...(Number.isSafeInteger(chainId) && chainId > 0 ? { chainId } : {}),
    rpcReachable: observation.captures.length > 0,
    chainIdentityObserved: observation.captures.some((capture) => capture.rpcMethod === "eth_chainId"),
    finalizedHeadLookupUsable: finalized,
    safeHeadLookupUsable: safe,
    latestHeadLookupUsable: latest,
    headOrderingCoherent: finalized && safe && latest && ordered,
    evidence: [...byId.values()],
  };
}

/**
 * Replay archived fixtures OFFLINE (zero network I/O) and derive a
 * `historical_replay` foundation: every supported capability carries the
 * capture-time observation in metadata and CURRENT availability `unknown`.
 */
export async function replayOpStackBeforeFoundation(input: OpStackBeforeReplayInput): Promise<OpStackBeforeFoundation> {
  try {
    const root = exactKeys(input, "input", ["config", "evmFixture", "finalityFixture"], ["config", "evmFixture"]);
    validateOpStackFinalityConfig(root.config);
    const config = root.config;
    const evmFixture = validateEvmAcquisitionFixture(root.evmFixture);
    if (evmFixture.source.networkId !== config.networkId || evmFixture.source.chainId !== config.chainId) {
      opstackFail("OPSTACK_NETWORK_MISMATCH", "evmFixture source does not identify the configured network");
    }
    const includeTransaction = evmFixture.captures.some((capture) => capture.rpcMethod === "eth_getTransactionByHash");
    const acquisition = await replayTransactionAcquisition(root.evmFixture, { includeTransaction });
    const evmObservation = evmProbeFromAcquisition(acquisition);

    let finalityObservation: OpStackFinalityProbeObservation | undefined;
    if (Object.prototype.hasOwnProperty.call(root, "finalityFixture")) {
      const replayed = await replayOpStackFinalityObservation(root.finalityFixture);
      if (replayed.source.networkId !== config.networkId || replayed.source.chainId !== config.chainId) {
        opstackFail("OPSTACK_NETWORK_MISMATCH", "finalityFixture source does not identify the configured network");
      }
      finalityObservation = finalityProbeFromReplay(replayed);
    }
    return deriveOpStackBeforeFoundation({
      config,
      observationKind: "historical_replay",
      evmObservation,
      ...(finalityObservation === undefined ? {} : { finalityObservation }),
    });
  } catch (error) {
    retype(error, "OPSTACK_FIXTURE_INVALID");
  }
}
