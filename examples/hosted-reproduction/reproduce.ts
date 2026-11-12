/**
 * Offline reproduction of ONE hosted `resolve_transaction_evidence`
 * structuredContent envelope (`ne-mcp-observation-envelope/v0.1`).
 *
 * Raw provider bytes come ONLY from the hosted fragment's evidence-ref
 * `nativeSource` payloads, each verified with Core `verifyNativeSourceDigest`.
 * Every envelope capture is bound 1:1 to one ref by contentDigest; request
 * params are re-derived from the ref locator under a per-method allowlist and
 * must re-render to the EXACT hosted locator. The resulting resolver fixture is
 * validated by the resolver's own fixture validator, replayed at the hosted
 * acquiredAt through the existing replay + evaluate functions (EVM:
 * includeTransaction + requireAllCapturesUsed; Solana replay is ordered and
 * always consumes every capture), rebuilt with the resolver's fixture builder
 * and compared: every recomputed capture contentDigest, the acquisition
 * projection and the canonical Core fragment wire bytes. "reproduced" is
 * returned only when ALL of them match; any partial match is not reproduced.
 *
 * Pure: no network, clock, filesystem or randomness in reproduceObservationEnvelope.
 * Reproduction != independent source verification: the same raw bytes are
 * re-evaluated by THIS commit's evaluator; no provider is re-asked, and a
 * source-reported "finalized" is not cryptographic finality. The OP Stack
 * supplement carries no raw bytes (live-evm.ts:310-315) and is ALWAYS reported
 * not_reproducible; only its verdict class, anchor and not_evaluated
 * settlement fields are echoed.
 */
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { types as utilTypes } from "node:util";

import {
  canonicalJson,
  decodeBase64Strict,
  decodeNecWireJson,
  encodeNecWireJson,
  verifyNativeSourceDigest,
} from "@nec/core";
import type { EvidenceRef, NativeSourcePayload, NetworkEvidenceFragment } from "@nec/core";
import {
  buildEvmAcquisitionFixture,
  evaluateTransactionAcquisition,
  FIXTURE_PROFILE as EVM_FIXTURE_PROFILE,
  replayTransactionAcquisition,
  validateEvmAcquisitionFixture,
} from "@nec/resolver-evm";
import {
  buildSolanaAcquisitionFixture,
  evaluateSolanaTransaction,
  FIXTURE_PROFILE as SOLANA_FIXTURE_PROFILE,
  parseSignature,
  replaySolanaTransaction,
  solanaProbeObservationFromAcquisition,
  stableJsonKey,
  validateSolanaAcquisitionFixture,
} from "@nec/resolver-solana";

/** Pinned by test to LIVE_MULTICHAIN_SCHEMA / LIVE_MULTICHAIN_NETWORK_IDS (packages/mcp/src/live-multichain.ts). */
export const LIVE_ENVELOPE_SCHEMA = "ne-mcp-observation-envelope/v0.1";
export const LIVE_ENVELOPE_NETWORK_IDS: readonly string[] = Object.freeze([
  "eip155:8453", "eip155:84532",
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
]);
/** Same bound as MULTICHAIN_RESULT_MAX_BYTES. */
const ENVELOPE_MAX_BYTES = 450_000;

export const EVM_RPC_METHODS: readonly string[] = Object.freeze([
  "eth_chainId", "eth_getTransactionReceipt", "eth_getBlockByHash", "eth_getTransactionByHash",
]);
export const SOLANA_RPC_METHODS: readonly string[] = Object.freeze([
  "getGenesisHash", "getTransaction", "getSignatureStatuses", "getBlock",
]);
const NATIVE_NAMESPACE = { evm: "nec.resolver-evm.rpc-result", solana: "nec.resolver-solana.rpc-result" } as const;
const SOLANA_TX_OPTIONS = { commitment: "finalized", encoding: "json", maxSupportedTransactionVersion: 0 } as const;
const SOLANA_BLOCK_OPTIONS = {
  commitment: "finalized", transactionDetails: "none", rewards: false, maxSupportedTransactionVersion: 0,
} as const;

export type ReproductionStatus = "reproduced" | "diverged" | "not_reproducible";
export type ReproductionReason =
  // reproduced
  | "byte_identical"
  // not_reproducible: the envelope lacks material, or is outside this harness
  | "envelope_invalid" | "unknown_schema" | "unsupported_network" | "claim_assessment_out_of_scope"
  | "hosted_fragment_invalid" | "native_source_absent" | "rpc_method_not_allowlisted"
  | "fixture_rejected" | "harness_error"
  // diverged: material present and in scope, but a binding does not hold
  | "native_source_digest_mismatch" | "subject_binding_mismatch" | "source_binding_mismatch"
  | "capture_ref_count_mismatch" | "capture_ref_binding_mismatch" | "ref_provenance_mismatch"
  | "ref_metadata_mismatch" | "native_source_profile_mismatch" | "native_source_not_utf8"
  | "locator_params_mismatch" | "locator_subject_mismatch" | "replay_rejected"
  | "fixture_roundtrip_mismatch" | "evaluation_rejected" | "capture_content_digest_mismatch"
  | "capture_metadata_mismatch" | "acquisition_projection_mismatch" | "fragment_wire_mismatch";

export interface OpStackSupplementReport {
  readonly status: "not_reproducible";
  readonly reason: "opstack_supplement_without_raw_bytes";
  /** finality verdict of an evaluated supplement, else its toolStatus. */
  readonly verdictClass: string;
  /** The supplement fragment's own Core anchor (network.observedAt.blockId); never re-derived. */
  readonly anchoredBlockHash: string | null;
  readonly withdrawalFinalization: "not_evaluated";
  readonly ethereumSettlement: "not_evaluated";
}

export interface ReproductionReport {
  readonly status: ReproductionStatus;
  readonly reason: ReproductionReason;
  /** RFC 6901 pointer into the envelope (fragment diffs are prefixed "/fragment"). */
  readonly firstDiffPointer?: string;
  /** sha256 of the hosted fragment's canonical nec-wire-json-v1 bytes; null if not Core-decodable. */
  readonly hostedFragmentDigest: string | null;
  /** sha256 of the replayed fragment's canonical wire bytes; null if replay/evaluation did not run. */
  readonly reproducedFragmentDigest: string | null;
  readonly opStackSupplement?: OpStackSupplementReport;
}

type Family = "evm" | "solana";
type HaltStatus = Exclude<ReproductionStatus, "reproduced">;

class Halt extends Error {
  constructor(readonly status: HaltStatus, readonly reason: ReproductionReason, readonly pointer?: string) {
    super(reason);
  }
}

function stop(status: HaltStatus, reason: ReproductionReason, pointer?: string): never {
  throw new Halt(status, reason, pointer);
}

function invalid(pointer: string): never {
  throw new Halt("not_reproducible", "envelope_invalid", pointer);
}

function attempt<T>(fn: () => T, status: HaltStatus, reason: ReproductionReason, pointer?: string): T {
  try { return fn(); } catch (error) {
    if (error instanceof Halt) throw error;
    return stop(status, reason, pointer);
  }
}

async function attemptAsync<T>(fn: () => Promise<T>, status: HaltStatus, reason: ReproductionReason, pointer?: string): Promise<T> {
  try { return await fn(); } catch (error) {
    if (error instanceof Halt) throw error;
    return stop(status, reason, pointer);
  }
}

const escapePointer = (key: string): string => key.replace(/~/g, "~0").replace(/\//g, "~1");
const sha256 = (text: string): string => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const EVM_HASH = /^0x[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// ---------------------------------------------------------------------------
// Strict envelope parse (hostile input: inert JSON data only, exact keys)
// ---------------------------------------------------------------------------

function assertJsonData(value: unknown, pointer: string, state: { nodes: number }, depth: number): void {
  state.nodes += 1;
  if (state.nodes > 100_000 || depth > 64) invalid(pointer);
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid(pointer);
    return;
  }
  if (typeof value !== "object" || utilTypes.isProxy(value)) invalid(pointer);
  const array = Array.isArray(value);
  const proto = Object.getPrototypeOf(value) as object | null;
  if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) invalid(pointer);
  if (array) {
    const length = (value as unknown[]).length;
    for (let i = 0; i < length; i++) if (!Object.hasOwn(value, i)) invalid(`${pointer}/${i}`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (array && key === "length") continue;
    if (typeof key !== "string") invalid(pointer);
    const child = `${pointer}/${escapePointer(key)}`;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) invalid(child);
    assertJsonData(descriptor.value, child, state, depth + 1);
  }
}

function record(value: unknown, pointer: string): Record<string, unknown> {
  if (!isRecord(value)) invalid(pointer);
  return value;
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[], pointer: string): void {
  for (const key of required) if (!Object.hasOwn(value, key)) invalid(`${pointer}/${escapePointer(key)}`);
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) invalid(`${pointer}/${escapePointer(key)}`);
  }
}

function str(value: unknown, pointer: string): string {
  if (typeof value !== "string") invalid(pointer);
  return value;
}

function bool(value: unknown, pointer: string): boolean {
  if (typeof value !== "boolean") invalid(pointer);
  return value;
}

function safeInt(value: unknown, pointer: string, min: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) invalid(pointer);
  return value;
}

function isoMs(value: unknown, pointer: string): string {
  const text = str(value, pointer);
  if (!ISO_MS.test(text) || Number.isNaN(Date.parse(text)) || new Date(text).toISOString() !== text) invalid(pointer);
  return text;
}

function validSignature(value: string): boolean {
  try { return parseSignature(value) === value; } catch { return false; }
}

interface EnvelopeCapture {
  readonly rpcMethod: string;
  readonly acquiredAt: string;
  readonly contentDigest: string;
  readonly httpStatus: number;
  readonly resultBytes: number;
}

interface ParsedEnvelope {
  readonly family: Family;
  readonly networkId: string;
  readonly txId: string;
  readonly acquiredAt: string;
  readonly source: {
    readonly sourceId: string;
    readonly sourceType: string;
    readonly networkId: string;
    readonly chainId?: number;
    readonly independenceGroup?: string;
  };
  /** Envelope acquisition flags (+ Solana probe) the replay must reproduce. */
  readonly projection: Readonly<Record<string, unknown>>;
  readonly captures: readonly EnvelopeCapture[];
  readonly fragment: Record<string, unknown>;
  readonly opStack?: OpStackSupplementReport;
}

const ENVELOPE_KEYS = [
  "schema", "observationKind", "toolStatus", "evidenceBasis", "subject", "acquiredAt",
  "source", "acquisition", "artifactType", "fragment", "nonClaims",
] as const;
const ENVELOPE_LITERALS = [
  ["observationKind", "live_source_observation"], ["toolStatus", "observed"],
  ["evidenceBasis", "source_observation"], ["artifactType", "network-evidence-fragment"],
] as const;

function parseEnvelope(value: unknown): ParsedEnvelope {
  const env = record(value, "");
  if (env.schema !== LIVE_ENVELOPE_SCHEMA) stop("not_reproducible", "unknown_schema", "/schema");
  // A protocol claim assessment is adapter-local; this harness reproduces
  // only the source observation, so it refuses rather than ignores it.
  if (Object.hasOwn(env, "claimAssessment")) stop("not_reproducible", "claim_assessment_out_of_scope", "/claimAssessment");
  exactKeys(env, ENVELOPE_KEYS, ["opStackFinality"], "");
  for (const [key, literal] of ENVELOPE_LITERALS) if (env[key] !== literal) invalid(`/${key}`);

  const subject = record(env.subject, "/subject");
  exactKeys(subject, ["type", "networkId", "txId"], [], "/subject");
  if (subject.type !== "transaction") invalid("/subject/type");
  const networkId = str(subject.networkId, "/subject/networkId");
  if (!LIVE_ENVELOPE_NETWORK_IDS.includes(networkId)) stop("not_reproducible", "unsupported_network", "/subject/networkId");
  const family: Family = networkId.startsWith("eip155:") ? "evm" : "solana";
  const txId = str(subject.txId, "/subject/txId");
  if (family === "evm" ? !EVM_HASH.test(txId) : !validSignature(txId)) invalid("/subject/txId");
  const acquiredAt = isoMs(env.acquiredAt, "/acquiredAt");

  const rawSource = record(env.source, "/source");
  exactKeys(rawSource, family === "evm" ? ["sourceId", "sourceType", "networkId", "chainId"] : ["sourceId", "sourceType", "networkId"],
    ["independenceGroup"], "/source");
  const source = {
    sourceId: str(rawSource.sourceId, "/source/sourceId"),
    sourceType: str(rawSource.sourceType, "/source/sourceType"),
    networkId: str(rawSource.networkId, "/source/networkId"),
    ...(family === "evm" ? { chainId: safeInt(rawSource.chainId, "/source/chainId", 1) } : {}),
    ...(rawSource.independenceGroup === undefined
      ? {} : { independenceGroup: str(rawSource.independenceGroup, "/source/independenceGroup") }),
  };

  const acquisition = record(env.acquisition, "/acquisition");
  const flags = family === "evm"
    ? ["transactionObserved", "transactionLookupUsable", "blockObserved", "consistent"]
    : ["transactionObserved", "blockObserved", "consistent"];
  exactKeys(acquisition, [...flags, "captures", ...(family === "solana" ? ["solanaProbe"] : [])], [], "/acquisition");
  const projection: Record<string, unknown> = {};
  for (const flag of flags) projection[flag] = bool(acquisition[flag], `/acquisition/${flag}`);
  if (family === "solana") projection.solanaProbe = record(acquisition.solanaProbe, "/acquisition/solanaProbe");
  const rawCaptures = acquisition.captures;
  if (!Array.isArray(rawCaptures) || rawCaptures.length === 0 || rawCaptures.length > 64) invalid("/acquisition/captures");
  const captures = rawCaptures.map((raw: unknown, i): EnvelopeCapture => {
    const p = `/acquisition/captures/${i}`;
    const capture = record(raw, p);
    exactKeys(capture, ["rpcMethod", "acquiredAt", "contentDigest", "httpStatus", "resultBytes"], [], p);
    const contentDigest = str(capture.contentDigest, `${p}/contentDigest`);
    if (!DIGEST.test(contentDigest)) invalid(`${p}/contentDigest`);
    return {
      rpcMethod: str(capture.rpcMethod, `${p}/rpcMethod`),
      acquiredAt: str(capture.acquiredAt, `${p}/acquiredAt`),
      contentDigest,
      httpStatus: safeInt(capture.httpStatus, `${p}/httpStatus`, 100),
      resultBytes: safeInt(capture.resultBytes, `${p}/resultBytes`, 0),
    };
  });

  const fragment = record(env.fragment, "/fragment");
  if (!Array.isArray(env.nonClaims) || !env.nonClaims.every((x: unknown) => typeof x === "string")) invalid("/nonClaims");
  let opStack: OpStackSupplementReport | undefined;
  if (env.opStackFinality !== undefined) {
    if (family !== "evm") invalid("/opStackFinality");
    opStack = parseOpStackSupplement(env.opStackFinality, networkId, txId);
  }
  return { family, networkId, txId, acquiredAt, source, projection, captures, fragment, ...(opStack === undefined ? {} : { opStack }) };
}

/**
 * The supplement is checked for shape and Core validity, then echoed. It has
 * no raw bytes, so it is never reproduced, and its observedAt is deliberately
 * NOT required to equal the envelope acquiredAt (it is a later, separate read).
 */
function parseOpStackSupplement(value: unknown, networkId: string, txId: string): OpStackSupplementReport {
  const p = "/opStackFinality";
  const op = record(value, p);
  exactKeys(op, ["ruleset", "networkId", "toolStatus", "withdrawalFinalization", "ethereumSettlement", "maxAncestryDepth", "nonClaims"],
    ["reason", "observedAt", "fragment", "captures"], p);
  if (op.ruleset !== "opstack.rpc-finalized-head-v1") invalid(`${p}/ruleset`);
  if (op.networkId !== networkId) invalid(`${p}/networkId`);
  if (op.withdrawalFinalization !== "not_evaluated") invalid(`${p}/withdrawalFinalization`);
  if (op.ethereumSettlement !== "not_evaluated") invalid(`${p}/ethereumSettlement`);
  safeInt(op.maxAncestryDepth, `${p}/maxAncestryDepth`, 0);
  if (!Array.isArray(op.nonClaims) || !op.nonClaims.every((x: unknown) => typeof x === "string")) invalid(`${p}/nonClaims`);
  if (op.observedAt !== undefined) str(op.observedAt, `${p}/observedAt`);
  if (op.reason !== undefined) str(op.reason, `${p}/reason`);
  let verdictClass: string;
  let anchoredBlockHash: string | null = null;
  if (op.toolStatus === "evaluated") {
    if (!isRecord(op.fragment) || !Array.isArray(op.captures)) invalid(p);
    const fragment = attempt(() => decodeNecWireJson("network-evidence-fragment", JSON.stringify(op.fragment)),
      "not_reproducible", "envelope_invalid", `${p}/fragment`);
    const finality = fragment.networkEvidence.finality;
    if (finality === undefined || fragment.networkEvidence.settlement !== undefined ||
        fragment.networkEvidence.execution !== undefined || fragment.subject.type !== "transaction" ||
        fragment.subject.networkId !== networkId || fragment.subject.txId !== txId) invalid(`${p}/fragment`);
    verdictClass = finality.verdict ?? "no_verdict";
    anchoredBlockHash = fragment.network.observedAt.blockId ?? null;
  } else if (op.toolStatus === "not_evaluated" || op.toolStatus === "source_unavailable") {
    if (op.fragment !== undefined || op.captures !== undefined) invalid(p);
    verdictClass = op.toolStatus as string;
  } else {
    invalid(`${p}/toolStatus`);
  }
  return {
    status: "not_reproducible", reason: "opstack_supplement_without_raw_bytes",
    verdictClass, anchoredBlockHash,
    withdrawalFinalization: "not_evaluated", ethereumSettlement: "not_evaluated",
  };
}

// ---------------------------------------------------------------------------
// Hosted fragment bindings and raw capture reconstruction
// ---------------------------------------------------------------------------

function decodeHosted(fragment: Record<string, unknown>): { hosted: NetworkEvidenceFragment; hostedWire: string } {
  return attempt(() => {
    const hosted = decodeNecWireJson("network-evidence-fragment", JSON.stringify(fragment));
    return { hosted, hostedWire: encodeNecWireJson("network-evidence-fragment", hosted) };
  }, "not_reproducible", "hosted_fragment_invalid", "/fragment");
}

function bindSubject(env: ParsedEnvelope, hosted: NetworkEvidenceFragment): void {
  const subject = hosted.subject;
  if (subject.type !== "transaction") stop("diverged", "subject_binding_mismatch", "/fragment/subject/type");
  if (subject.networkId !== env.networkId) stop("diverged", "subject_binding_mismatch", "/fragment/subject/networkId");
  if (subject.txId !== env.txId) stop("diverged", "subject_binding_mismatch", "/fragment/subject/txId");
  if (hosted.network.networkId !== env.networkId) stop("diverged", "subject_binding_mismatch", "/fragment/network/networkId");
  if (env.source.networkId !== env.networkId) stop("diverged", "source_binding_mismatch", "/source/networkId");
  if (env.family === "evm" && env.source.chainId !== Number(env.networkId.slice("eip155:".length))) {
    stop("diverged", "source_binding_mismatch", "/source/chainId");
  }
}

interface RebuiltCapture {
  readonly rpcMethod: string;
  readonly rpcParams: unknown[];
  readonly httpStatus: number;
  readonly resultText: string;
}

/** Rebuild exact request params from a hosted locator; the result must re-render to that locator byte-for-byte. */
function rebuildRpcParams(family: Family, method: string, locator: string, txId: string, pointer: string): unknown[] {
  if (!(family === "evm" ? EVM_RPC_METHODS : SOLANA_RPC_METHODS).includes(method)) {
    stop("not_reproducible", "rpc_method_not_allowlisted", pointer);
  }
  const prefix = `${method}:`;
  if (!locator.startsWith(prefix)) stop("diverged", "locator_params_mismatch", pointer);
  const raw = attempt(() => JSON.parse(locator.slice(prefix.length)) as unknown, "diverged", "locator_params_mismatch", pointer);
  const list = Array.isArray(raw) ? raw as unknown[] : [];
  function mismatch(): never {
    return stop("diverged", "locator_params_mismatch", pointer);
  }
  let params: unknown[];
  let subjectValue: unknown;
  switch (method) {
    case "eth_chainId":
    case "getGenesisHash":
      params = [];
      break;
    case "eth_getTransactionReceipt":
    case "eth_getTransactionByHash":
      if (typeof raw !== "string" || !EVM_HASH.test(raw)) mismatch();
      subjectValue = raw;
      params = [raw];
      break;
    case "eth_getBlockByHash":
      if (typeof list[0] !== "string" || !EVM_HASH.test(list[0])) mismatch();
      params = [list[0], false];
      break;
    case "getTransaction":
      if (typeof list[0] !== "string") mismatch();
      subjectValue = list[0];
      params = [list[0], { ...SOLANA_TX_OPTIONS }];
      break;
    case "getSignatureStatuses": {
      const signatures = Array.isArray(list[0]) ? list[0] as unknown[] : [];
      if (signatures.length !== 1 || typeof signatures[0] !== "string") mismatch();
      subjectValue = signatures[0];
      params = [[signatures[0]], { searchTransactionHistory: true }];
      break;
    }
    case "getBlock":
      if (typeof list[0] !== "number" || !Number.isSafeInteger(list[0]) || list[0] < 0) mismatch();
      params = [list[0], { ...SOLANA_BLOCK_OPTIONS }];
      break;
    default:
      return stop("not_reproducible", "rpc_method_not_allowlisted", pointer);
  }
  // Same locator renderings as resolver-evm buildEvidenceRefs / resolver-solana evidenceRefs.
  const rendered = family === "evm"
    ? `${method}:${JSON.stringify(params.length === 1 ? params[0] : params)}`
    : `${method}:${stableJsonKey(params)}`;
  if (rendered !== locator) mismatch();
  if (subjectValue !== undefined && subjectValue !== txId) stop("diverged", "locator_subject_mismatch", pointer);
  return params;
}

function decodeUtf8(bytes: Uint8Array, pointer: string): string {
  const text = attempt(() => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    "diverged", "native_source_not_utf8", pointer);
  if (!Buffer.from(text, "utf8").equals(Buffer.from(bytes))) stop("diverged", "native_source_not_utf8", pointer);
  return text;
}

function rebuildCapture(env: ParsedEnvelope, capture: EnvelopeCapture, ref: EvidenceRef, p: string): RebuiltCapture {
  const native = ref.nativeSource;
  // Refs above MAX_NATIVE_SOURCE_PAYLOAD_BYTES legitimately carry no bytes.
  if (native === undefined) stop("not_reproducible", "native_source_absent", `${p}/nativeSource`);
  if (ref.sourceId !== env.source.sourceId) stop("diverged", "ref_provenance_mismatch", `${p}/sourceId`);
  if (ref.sourceType !== env.source.sourceType) stop("diverged", "ref_provenance_mismatch", `${p}/sourceType`);
  if (ref.independenceGroup !== env.source.independenceGroup) stop("diverged", "ref_provenance_mismatch", `${p}/independenceGroup`);
  if (ref.networkId !== env.networkId) stop("diverged", "ref_provenance_mismatch", `${p}/networkId`);
  if (ref.retrievedAt !== env.acquiredAt) stop("diverged", "ref_provenance_mismatch", `${p}/retrievedAt`);
  const metadata = ref.metadata ?? {};
  if (metadata.rpcMethod !== capture.rpcMethod) stop("diverged", "ref_metadata_mismatch", `${p}/metadata/rpcMethod`);
  if (metadata.httpStatus !== capture.httpStatus) stop("diverged", "ref_metadata_mismatch", `${p}/metadata/httpStatus`);
  if (native.namespace !== NATIVE_NAMESPACE[env.family] || native.mediaType !== "application/json" ||
      native.encoding !== "base64" || native.schema !== undefined) {
    stop("diverged", "native_source_profile_mismatch", `${p}/nativeSource`);
  }
  if (ref.locator === undefined) stop("diverged", "locator_params_mismatch", `${p}/locator`);
  const rpcParams = rebuildRpcParams(env.family, capture.rpcMethod, ref.locator, env.txId, `${p}/locator`);
  const bytes = decodeBase64Strict(native.payload, `${p}/nativeSource/payload`);
  return { rpcMethod: capture.rpcMethod, rpcParams, httpStatus: capture.httpStatus, resultText: decodeUtf8(bytes, `${p}/nativeSource/payload`) };
}

function rebuildCaptures(env: ParsedEnvelope, hosted: NetworkEvidenceFragment): RebuiltCapture[] {
  const refs = hosted.evidence;
  if (refs.length !== env.captures.length) stop("diverged", "capture_ref_count_mismatch", "/acquisition/captures");
  const used = new Set<number>();
  return env.captures.map((capture, i) => {
    const matches = refs.flatMap((ref, j) => (ref.contentDigest === capture.contentDigest ? [j] : []));
    const j = matches[0];
    if (matches.length !== 1 || j === undefined || used.has(j)) {
      stop("diverged", "capture_ref_binding_mismatch", `/acquisition/captures/${i}/contentDigest`);
    }
    used.add(j);
    return rebuildCapture(env, capture, refs[j] as EvidenceRef, `/fragment/evidence/${j}`);
  });
}

// ---------------------------------------------------------------------------
// Replay through the existing resolver fixture/replay/evaluate functions
// ---------------------------------------------------------------------------

interface ReplayOutcome {
  readonly captures: readonly {
    readonly rpcMethod: string;
    readonly acquiredAt: string;
    readonly httpStatus: number;
    readonly resultText: string;
    readonly contentDigest: string;
  }[];
  readonly projection: Readonly<Record<string, unknown>>;
  readonly fragment: NetworkEvidenceFragment;
}

const independenceGroupOf = (env: ParsedEnvelope) =>
  env.source.independenceGroup === undefined ? {} : { independenceGroup: env.source.independenceGroup };

async function replayEvm(env: ParsedEnvelope, rebuilt: readonly RebuiltCapture[]): Promise<ReplayOutcome> {
  const fixture = attempt(() => validateEvmAcquisitionFixture({
    schemaVersion: EVM_FIXTURE_PROFILE,
    acquiredAt: env.acquiredAt,
    source: {
      sourceId: env.source.sourceId, sourceType: env.source.sourceType,
      networkId: env.source.networkId, chainId: env.source.chainId, ...independenceGroupOf(env),
    },
    subject: { txHash: env.txId },
    captures: rebuilt.map((c) => ({ rpcMethod: c.rpcMethod, rpcParams: c.rpcParams, httpStatus: c.httpStatus, resultJson: c.resultText })),
  }), "not_reproducible", "fixture_rejected");
  const acquisition = await attemptAsync(
    () => replayTransactionAcquisition(fixture, { includeTransaction: true, requireAllCapturesUsed: true }),
    "diverged", "replay_rejected");
  if (canonicalJson(buildEvmAcquisitionFixture(acquisition)) !== canonicalJson(fixture)) {
    stop("diverged", "fixture_roundtrip_mismatch", "/acquisition/captures");
  }
  const fragment = attempt(() => evaluateTransactionAcquisition(acquisition).fragment, "diverged", "evaluation_rejected");
  const receipt = acquisition.receipt;
  const tx = acquisition.transaction;
  // Same projection as live-evm.ts / live-multichain.ts.
  return {
    captures: acquisition.captures,
    projection: {
      transactionObserved: receipt !== null,
      transactionLookupUsable: acquisition.consistent && tx !== null && tx !== undefined &&
        tx.hash === acquisition.subject.txHash &&
        (receipt === null || (tx.blockHash === receipt.blockHash && tx.blockNumber === receipt.blockNumber)),
      blockObserved: acquisition.block !== null && acquisition.block !== undefined,
      consistent: acquisition.consistent,
    },
    fragment,
  };
}

async function replaySolana(env: ParsedEnvelope, rebuilt: readonly RebuiltCapture[]): Promise<ReplayOutcome> {
  const fixture = attempt(() => validateSolanaAcquisitionFixture({
    schemaVersion: SOLANA_FIXTURE_PROFILE,
    acquiredAt: env.acquiredAt,
    source: {
      sourceId: env.source.sourceId, sourceType: env.source.sourceType,
      networkId: env.source.networkId, ...independenceGroupOf(env),
    },
    networkId: env.source.networkId,
    subject: { signature: env.txId },
    captures: rebuilt.map((c) => ({ rpcMethod: c.rpcMethod, rpcParams: c.rpcParams, httpStatus: c.httpStatus, resultJson: c.resultText })),
  }), "not_reproducible", "fixture_rejected");
  const acquisition = await attemptAsync(() => replaySolanaTransaction(fixture), "diverged", "replay_rejected");
  if (canonicalJson(buildSolanaAcquisitionFixture(acquisition)) !== canonicalJson(fixture)) {
    stop("diverged", "fixture_roundtrip_mismatch", "/acquisition/captures");
  }
  const fragment = attempt(() => evaluateSolanaTransaction(acquisition).fragment, "diverged", "evaluation_rejected");
  const probe = attempt(() => solanaProbeObservationFromAcquisition(acquisition), "diverged", "evaluation_rejected");
  // Same projection as live-solana.ts / live-multichain.ts.
  return {
    captures: acquisition.captures,
    projection: {
      transactionObserved: acquisition.transaction !== null,
      blockObserved: acquisition.block !== null && acquisition.block !== undefined,
      consistent: acquisition.consistent,
      solanaProbe: {
        paths: probe.paths,
        finalizedCommitmentObserved: probe.finalizedCommitmentObserved,
        lookupsCoherent: probe.lookupsCoherent,
      },
    },
    fragment,
  };
}

function compareCaptures(env: ParsedEnvelope, replayed: ReplayOutcome["captures"]): void {
  if (replayed.length !== env.captures.length) stop("diverged", "capture_content_digest_mismatch", "/acquisition/captures");
  for (const [i, hosted] of env.captures.entries()) {
    if (replayed[i]?.contentDigest !== hosted.contentDigest) {
      stop("diverged", "capture_content_digest_mismatch", `/acquisition/captures/${i}/contentDigest`);
    }
  }
  for (const [i, hosted] of env.captures.entries()) {
    const capture = replayed[i];
    const p = `/acquisition/captures/${i}`;
    if (capture === undefined) stop("diverged", "capture_metadata_mismatch", p);
    if (capture.rpcMethod !== hosted.rpcMethod) stop("diverged", "capture_metadata_mismatch", `${p}/rpcMethod`);
    if (capture.acquiredAt !== hosted.acquiredAt) stop("diverged", "capture_metadata_mismatch", `${p}/acquiredAt`);
    if (capture.httpStatus !== hosted.httpStatus) stop("diverged", "capture_metadata_mismatch", `${p}/httpStatus`);
    if (Buffer.byteLength(capture.resultText, "utf8") !== hosted.resultBytes) {
      stop("diverged", "capture_metadata_mismatch", `${p}/resultBytes`);
    }
  }
}

function compareProjection(env: ParsedEnvelope, replayed: ReplayOutcome["projection"]): void {
  for (const key of Object.keys(env.projection).sort()) {
    if (canonicalJson(env.projection[key]) !== canonicalJson(replayed[key])) {
      stop("diverged", "acquisition_projection_mismatch", `/acquisition/${escapePointer(key)}`);
    }
  }
}

function firstDiff(a: unknown, b: unknown, pointer: string): string | undefined {
  if (Object.is(a, b)) return undefined;
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (i >= a.length || i >= b.length) return `${pointer}/${i}`;
      const diff = firstDiff(a[i], b[i], `${pointer}/${i}`);
      if (diff !== undefined) return diff;
    }
    return undefined;
  }
  if (isRecord(a) && isRecord(b)) {
    for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      const child = `${pointer}/${escapePointer(key)}`;
      if (!Object.hasOwn(a, key) || !Object.hasOwn(b, key)) return child;
      const diff = firstDiff(a[key], b[key], child);
      if (diff !== undefined) return diff;
    }
    return undefined;
  }
  return pointer;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function reproduceObservationEnvelope(envelope: unknown): Promise<ReproductionReport> {
  let hostedFragmentDigest: string | null = null;
  let reproducedFragmentDigest: string | null = null;
  let opStackSupplement: OpStackSupplementReport | undefined;
  const report = (status: ReproductionStatus, reason: ReproductionReason, pointer?: string): ReproductionReport => ({
    status,
    reason,
    ...(pointer === undefined ? {} : { firstDiffPointer: pointer }),
    hostedFragmentDigest,
    reproducedFragmentDigest,
    ...(opStackSupplement === undefined ? {} : { opStackSupplement }),
  });
  try {
    assertJsonData(envelope, "", { nodes: 0 }, 0);
    if (Buffer.byteLength(JSON.stringify(envelope), "utf8") > ENVELOPE_MAX_BYTES) invalid("");
    const env = parseEnvelope(JSON.parse(JSON.stringify(envelope)) as unknown);
    opStackSupplement = env.opStack;

    // Raw bytes may come only from nativeSource payloads whose declared digest binds them.
    const rawEvidence = env.fragment.evidence;
    if (Array.isArray(rawEvidence)) {
      for (const [i, ref] of rawEvidence.entries()) {
        if (!isRecord(ref) || ref.nativeSource === undefined) continue;
        attempt(() => verifyNativeSourceDigest(ref.nativeSource as NativeSourcePayload, `fragment.evidence[${i}].nativeSource`),
          "diverged", "native_source_digest_mismatch", `/fragment/evidence/${i}/nativeSource/contentDigest`);
      }
    }

    const { hosted, hostedWire } = decodeHosted(env.fragment);
    hostedFragmentDigest = sha256(hostedWire);
    bindSubject(env, hosted);
    const rebuilt = rebuildCaptures(env, hosted);
    const replayed = env.family === "evm" ? await replayEvm(env, rebuilt) : await replaySolana(env, rebuilt);
    const reproducedWire = attempt(() => encodeNecWireJson("network-evidence-fragment", replayed.fragment),
      "diverged", "evaluation_rejected");
    reproducedFragmentDigest = sha256(reproducedWire);

    compareCaptures(env, replayed.captures);
    compareProjection(env, replayed.projection);
    if (reproducedWire !== hostedWire) {
      const pointer = firstDiff(JSON.parse(hostedWire) as unknown, JSON.parse(reproducedWire) as unknown, "/fragment");
      return report("diverged", "fragment_wire_mismatch", pointer ?? "/fragment");
    }
    return report("reproduced", "byte_identical");
  } catch (error) {
    if (error instanceof Halt) return report(error.status, error.reason, error.pointer);
    // Never reproduced on an unexpected failure.
    return report("not_reproducible", "harness_error");
  }
}

// ---------------------------------------------------------------------------
// Fail-closed decision over a capture-hosted.ts output (no network, clock or randomness)
// ---------------------------------------------------------------------------

export const REPRODUCTION_REPORT_SCHEMA = "ne-hosted-reproduction-report/v0.1";

/**
 * Exit 0 needs a reproduced, subject-bound report for each of these capture
 * call ids: the real multichain AFTER on Base mainnet AND Solana mainnet. An
 * errored call (even an expected source_failure) is no AFTER evidence. The OP
 * Stack supplement call is never required: its supplement has no raw bytes.
 */
export const REQUIRED_REPRODUCED_CALLS: readonly string[] = Object.freeze(["base-mainnet-pinned", "solana-mainnet-pinned"]);

export interface CaptureOutcomeAssessment {
  readonly id: string;
  readonly outcome: { readonly kind: string; readonly code: string | null };
  readonly expected: boolean;
}

export interface CaptureReproductionEntry {
  readonly id: string;
  /** reproduceObservationEnvelope(call.structuredContent), verbatim. */
  readonly report: ReproductionReport;
  /** True only if reproduced AND the envelope /subject equals CAPTURE_CALLS[id].arguments.subject. */
  readonly subjectBound: boolean;
}

export interface CaptureReproductionOutput {
  readonly schema: typeof REPRODUCTION_REPORT_SCHEMA;
  readonly acquiringExecutable: unknown;
  readonly reproducingCommit: string | null;
  readonly outcomes: readonly CaptureOutcomeAssessment[];
  readonly reports: readonly CaptureReproductionEntry[];
  readonly missingReproduced: readonly string[];
}

export interface CaptureReproductionDecision {
  readonly exitCode: 0 | 1;
  readonly output: CaptureReproductionOutput;
}

interface CaptureCallLike {
  readonly id: string;
  readonly tool: string;
  readonly isError: boolean;
  readonly structuredContent: unknown;
  readonly content?: unknown;
}

const isCaptureCall = (value: unknown): value is CaptureCallLike =>
  isRecord(value) && typeof value.id === "string" && typeof value.tool === "string" && typeof value.isError === "boolean";

/**
 * exitCode 0 only if ALL hold: `calls` is a non-empty array of well-formed
 * calls; every call outcome is in EXPECTED_OUTCOMES (assessCaptureOutcomes);
 * every non-error resolve report is "reproduced" with its envelope /subject
 * equal to CAPTURE_CALLS[id].arguments.subject; and every
 * REQUIRED_REPRODUCED_CALLS id has such a report. Otherwise 1.
 * The capture's own recorded arguments are never trusted for the binding.
 */
export async function evaluateReproductionCapture(
  capture: unknown, reproducingCommit: string | null = null,
): Promise<CaptureReproductionDecision> {
  // Dynamic: keeps the static import graph of this module free of the MCP client.
  const { assessCaptureOutcomes, CAPTURE_CALLS } = await import("./capture-hosted.js");
  const raw: Record<string, unknown> = isRecord(capture) ? capture : {};
  const rawCalls: readonly unknown[] = Array.isArray(raw.calls) ? raw.calls : [];
  const calls = rawCalls.filter(isCaptureCall);
  const wellFormed = Array.isArray(raw.calls) && calls.length === rawCalls.length;
  const outcomes: CaptureOutcomeAssessment[] = assessCaptureOutcomes(calls);
  const reports: CaptureReproductionEntry[] = [];
  const reproducedIds = new Set<string>();
  for (const call of calls) {
    if (call.tool !== "resolve_transaction_evidence" || call.isError) continue;
    const report = await reproduceObservationEnvelope(call.structuredContent);
    const expectedSubject = CAPTURE_CALLS.find((c) => c.id === call.id)?.arguments.subject;
    const envelope = call.structuredContent;
    const subjectBound = report.status === "reproduced" && expectedSubject !== undefined && isRecord(envelope) &&
      isRecord(envelope.subject) && canonicalJson(envelope.subject) === canonicalJson(expectedSubject);
    reports.push({ id: call.id, report, subjectBound });
    if (subjectBound) reproducedIds.add(call.id);
  }
  const missingReproduced = REQUIRED_REPRODUCED_CALLS.filter((id) => !reproducedIds.has(id));
  const exitCode = wellFormed && outcomes.length > 0 && outcomes.every((o) => o.expected) &&
    reports.every((r) => r.report.status === "reproduced" && r.subjectBound) && missingReproduced.length === 0 ? 0 : 1;
  return {
    exitCode,
    output: {
      schema: REPRODUCTION_REPORT_SCHEMA,
      acquiringExecutable: raw.acquiringExecutable ?? null,
      reproducingCommit,
      outcomes,
      reports,
      missingReproduced,
    },
  };
}

// ---------------------------------------------------------------------------
// Optional CLI over a capture-hosted.ts output file (the exports above stay pure)
//
//   tsx examples/hosted-reproduction/reproduce.ts --capture capture.json [--reproducing-commit <git sha>]
// ---------------------------------------------------------------------------

export async function main(argv: readonly string[]): Promise<number> {
  const { readFileSync } = await import("node:fs");
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index === -1 ? undefined : argv[index + 1];
  };
  const path = flag("--capture");
  const reproducingCommit = flag("--reproducing-commit") ?? null;
  if (path === undefined) throw new Error("--capture <capture.json> is required");
  if (reproducingCommit !== null && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(reproducingCommit)) {
    throw new Error("--reproducing-commit must be a full lowercase git commit SHA");
  }
  const capture = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const { exitCode, output } = await evaluateReproductionCapture(capture, reproducingCommit);
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  return exitCode;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`reproduce: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(2);
    },
  );
}
