/**
 * Offline, fail-closed verifier for ONE evidenceResult-bearing hosted
 * `resolve_transaction_evidence` structuredContent envelope
 * (`ne-mcp-observation-envelope/v0.1` + `evidenceResult`), independent of the
 * server's composer: nothing here imports the MCP server package or its source.
 *
 * Check order (first failure wins):
 *   1  envelope: inert JSON data, <= 450 000 bytes; no `evidenceResult`
 *      -> not_applicable:evidence_result_absent
 *   2  after_envelope: a detached copy WITHOUT `evidenceResult` must give
 *      `reproduceObservationEnvelope` -> reproduced; any other report is passed
 *      on unchanged (claimAssessment stays claim_assessment_out_of_scope)
 *   3  evidence_result: exact composed / not_composed shape
 *      -> else not_reproducible:evidence_result_invalid
 *   4  context: the caller's {request, preflight, capabilitySnapshot} is decoded
 *      by Core (decode/integrity -> not_reproducible:context_invalid), then
 *      bound to the subject, to each other and to the LOCALLY pinned family
 *      manifest (-> diverged:context_mismatch)
 *   5  composition: not_composed reasons are recomputed from the reproduced
 *      envelope and the caller preflight; a composed result must be justified,
 *      carry exactly the locally pinned manifest, Core-decode, match the caller
 *      request, hold under Core verifyNetworkEvidenceResult with the complete
 *      context, copy the reproduced fragment, carry a snapshot whose evidence
 *      table is exactly the fragment's and whose only anchor is the fragment's
 *      subject block, and never strengthen a dimension (an unevaluated one cites
 *      exactly "<code>: <message>" of a declaring fragment warning).
 *
 * Pure: no network, clock, filesystem or randomness. Date.parse is used only on
 * timestamps carried by the inputs. "verified" = reproduction at the
 * reproducing commit + Core contextual verification; it is not precedence,
 * policy satisfaction, independent source verification, settlement or
 * finality. `fixedBeforeExecution` is copied from the separate preflight-anchor
 * report only; the verification status never depends on it.
 *
 * The optional CLI `main` (bottom of this file) only reads the files it is
 * given and calls the unchanged pure verifiers; it makes no network request.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { types as utilTypes } from "node:util";

import {
  canonicalJsonBytes,
  canonicalNecJson,
  computeEvidenceRequestDigest,
  decodeNecWireJson,
  encodeNecWireJson,
  verifyCapabilitySnapshot,
  verifyCapabilitySnapshotIntegrity,
  verifyNetworkEvidenceResult,
  verifyPreflightResult,
  verifyPreflightResultIntegrity,
} from "@nec/core";
import type {
  CapabilitySnapshot, EvidenceAnchor, EvidenceDimension, EvidenceDimensionName, EvidenceRequest, NecWireDecoded, NecWireType,
  NetworkEvidenceBuildContext, NetworkEvidenceFragment, PreflightResult, ResolverManifest, SubjectRef, Warning,
} from "@nec/core";
import { evmBeforeResolverManifest } from "@nec/resolver-evm";
import { solanaBeforeResolverManifest } from "@nec/resolver-solana";

import { reproduceObservationEnvelope } from "./reproduce.js";
import type { ReproductionReason } from "./reproduce.js";
import { matchPreflightAnchor, verifyPreflightAnchor } from "./verify-preflight-anchor.js";
import type { PreflightAnchorReport } from "./verify-preflight-anchor.js";

/** Same bound as the server's shared tool-output cap (the whole envelope, evidenceResult included). */
const ENVELOPE_MAX_BYTES = 450_000;
/** Same bound as the server's evidenceContext cap. */
const EVIDENCE_CONTEXT_MAX_BYTES = 64 * 1024;

export type EvidenceResultNotComposedReason =
  | "transaction_not_observed" | "block_not_observed" | "acquisition_inconsistent"
  | "block_timestamp_absent" | "preflight_not_before_block" | "output_budget";
export const EVIDENCE_RESULT_NOT_COMPOSED_REASONS: readonly EvidenceResultNotComposedReason[] = Object.freeze([
  "transaction_not_observed", "block_not_observed", "acquisition_inconsistent",
  "block_timestamp_absent", "preflight_not_before_block", "output_budget",
]);
/** What the reproduced envelope + caller preflight say the composer had to do. */
export type RecomputedOutcome = "composable" | Exclude<EvidenceResultNotComposedReason, "output_budget">;

export type EvidenceResultVerificationStatus =
  | "verified" | "not_composed_reproduced" | "not_composed_unchecked" | "diverged" | "not_reproducible" | "not_applicable";
export type EvidenceResultVerificationReason =
  // verified
  | "composed_result_verified"
  // not_applicable / not_reproducible
  | "evidence_result_absent" | "evidence_result_invalid" | "context_invalid" | "envelope_invalid" | "harness_error"
  // diverged
  | "context_mismatch" | "manifest_not_pinned" | "result_verification_failed" | "dimension_not_supported_by_fragment"
  | "not_composed_unjustified" | "composed_unjustified"
  // not_composed_reproduced / not_composed_unchecked
  | EvidenceResultNotComposedReason
  // propagated from reproduceObservationEnvelope (stage after_envelope)
  | ReproductionReason;
/** Which gate produced the report. */
export type EvidenceResultStage = "envelope" | "after_envelope" | "evidence_result" | "context" | "composition";

export interface EvidenceResultVerificationReport {
  readonly status: EvidenceResultVerificationStatus;
  readonly reason: EvidenceResultVerificationReason;
  readonly stage: EvidenceResultStage;
  /** RFC 6901 pointer into {envelope..., evidenceContext} (envelope paths at the root, context under /evidenceContext). */
  readonly firstDiffPointer?: string;
  readonly servedStatus: "composed" | "not_composed" | null;
  readonly expectedOutcome: RecomputedOutcome | null;
  readonly hostedFragmentDigest: string | null;
  readonly reproducedFragmentDigest: string | null;
  /** artifactDigest of the Core-decoded served result; null if not decoded. */
  readonly resultArtifactDigest: string | null;
  /** The existing preflight-anchor matcher's report, verbatim; null when not reached. */
  readonly anchor: PreflightAnchorReport | null;
  /** anchor.fixedBeforeExecution, else false. Never derived here. */
  readonly fixedBeforeExecution: boolean;
  readonly nonClaims: readonly string[];
}

export interface EvidenceResultVerificationInput {
  /** `resolve_transaction_evidence` structuredContent carrying `evidenceResult`. */
  readonly envelope: unknown;
  /** The caller's own `evidenceContext` ({request, preflight, capabilitySnapshot}) sent with that call. */
  readonly evidenceContext: unknown;
}

export const EVIDENCE_RESULT_NON_CLAIMS: readonly string[] = Object.freeze([
  "verified means only: the AFTER envelope reproduced byte-identically under the reproducing commit's evaluator, and Core verifyNetworkEvidenceResult holds for the served result under the caller's context and the locally pinned family manifest. It is not precedence, not policy satisfaction, not independent source verification, not settlement and not finality.",
  "Core preflight continuity is not precedence: preflight.generatedAt earlier than the block timestamp is a recomputed rejection check on reported times, not proof that the action or policy existed before execution.",
  "A dimension the reproduced fragment does not carry must stay applicability unknown with no verdict, basis or evidence; missing is never zero.",
  "not_composed_reproduced means only that the served refusal reason follows from the reproduced envelope and the caller preflight; output_budget is never checked.",
  "fixedBeforeExecution is copied from the separate preflight-anchor report and is true only when that report is anchored; the verification status never depends on it. No real composed and anchored case exists, and GT-02 stays OPEN.",
  "The OP Stack supplement carries no raw bytes, is never reproduced and must never be merged into the result.",
  "Reproduction is not independent source verification; no provider, network or clock is consulted.",
]);

type Family = "evm" | "solana";
type HaltStatus = "diverged" | "not_reproducible" | "not_applicable";

class Halt extends Error {
  constructor(readonly status: HaltStatus, readonly reason: EvidenceResultVerificationReason, readonly pointer: string) {
    super(reason);
  }
}

function halt(status: HaltStatus, reason: EvidenceResultVerificationReason, pointer: string): never {
  throw new Halt(status, reason, pointer);
}
function resultInvalid(pointer: string): never {
  return halt("not_reproducible", "evidence_result_invalid", pointer);
}
function contextInvalid(pointer: string): never {
  return halt("not_reproducible", "context_invalid", pointer);
}
function contextMismatch(pointer: string): never {
  return halt("diverged", "context_mismatch", pointer);
}

const escapePointer = (key: string): string => key.replace(/~/g, "~0").replace(/\//g, "~1");
const sha256 = (text: string): string => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function same(a: unknown, b: unknown): boolean {
  try { return canonicalNecJson(a) === canonicalNecJson(b); } catch { return false; }
}

/** An own data property, read without invoking any accessor or proxy trap. */
function ownData(holder: unknown, key: string): unknown {
  if (holder === null || typeof holder !== "object" || utilTypes.isProxy(holder)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(holder, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

/** Pointer of the first non-inert node (same rules as the strict parsers), else null. */
function inertFailure(value: unknown, pointer: string, state: { nodes: number }, depth: number): string | null {
  state.nodes += 1;
  if (state.nodes > 100_000 || depth > 64) return pointer;
  if (value === null || typeof value === "string" || typeof value === "boolean") return null;
  if (typeof value === "number") return Number.isFinite(value) ? null : pointer;
  if (typeof value !== "object" || utilTypes.isProxy(value)) return pointer;
  const array = Array.isArray(value);
  const proto = Object.getPrototypeOf(value) as object | null;
  if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) return pointer;
  if (array) {
    const length = (value as unknown[]).length;
    for (let i = 0; i < length; i++) if (!Object.hasOwn(value, i)) return `${pointer}/${i}`;
  }
  for (const key of Reflect.ownKeys(value)) {
    if (array && key === "length") continue;
    if (typeof key !== "string") return pointer;
    const child = `${pointer}/${escapePointer(key)}`;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) return child;
    const nested = inertFailure(descriptor.value, child, state, depth + 1);
    if (nested !== null) return nested;
  }
  return null;
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
// Strict evidenceResult shape
// ---------------------------------------------------------------------------

type ServedEvidenceResult =
  | {
    readonly status: "composed";
    readonly result: Record<string, unknown>;
    readonly evidenceSnapshot: Record<string, unknown>;
    readonly resolverManifest: Record<string, unknown>;
  }
  | { readonly status: "not_composed"; readonly reason: EvidenceResultNotComposedReason };

const COMPOSED_KEYS = [
  "status", "artifactType", "preExecutionBinding", "result", "evidenceSnapshot", "resolverManifest", "nonClaims",
] as const;
const NOT_COMPOSED_KEYS = ["status", "reason"] as const;

function exactKeys(value: Record<string, unknown>, required: readonly string[], pointer: string): void {
  for (const key of required) if (!Object.hasOwn(value, key)) resultInvalid(`${pointer}/${escapePointer(key)}`);
  for (const key of Object.keys(value)) if (!required.includes(key)) resultInvalid(`${pointer}/${escapePointer(key)}`);
}

function parseEvidenceResult(value: unknown): ServedEvidenceResult {
  const p = "/evidenceResult";
  if (!isRecord(value)) resultInvalid(p);
  if (value.status === "not_composed") {
    exactKeys(value, NOT_COMPOSED_KEYS, p);
    const reason = value.reason;
    if (typeof reason !== "string" || !(EVIDENCE_RESULT_NOT_COMPOSED_REASONS as readonly string[]).includes(reason)) {
      resultInvalid(`${p}/reason`);
    }
    return { status: "not_composed", reason: reason as EvidenceResultNotComposedReason };
  }
  if (value.status !== "composed") resultInvalid(`${p}/status`);
  exactKeys(value, COMPOSED_KEYS, p);
  if (value.artifactType !== "network-evidence-result") resultInvalid(`${p}/artifactType`);
  if (value.preExecutionBinding !== "core_preflight_continuity") resultInvalid(`${p}/preExecutionBinding`);
  const result = value.result;
  const evidenceSnapshot = value.evidenceSnapshot;
  const resolverManifest = value.resolverManifest;
  if (!isRecord(result)) resultInvalid(`${p}/result`);
  if (!isRecord(evidenceSnapshot)) resultInvalid(`${p}/evidenceSnapshot`);
  if (!isRecord(resolverManifest)) resultInvalid(`${p}/resolverManifest`);
  const nonClaims = value.nonClaims;
  if (!Array.isArray(nonClaims) || nonClaims.length === 0) resultInvalid(`${p}/nonClaims`);
  for (const [i, claim] of (nonClaims as unknown[]).entries()) {
    if (typeof claim !== "string") resultInvalid(`${p}/nonClaims/${i}`);
  }
  return { status: "composed", result, evidenceSnapshot, resolverManifest };
}

// ---------------------------------------------------------------------------
// Caller context: Core decode, then bindings
// ---------------------------------------------------------------------------

interface CallerContext {
  readonly request: EvidenceRequest;
  readonly preflightRef: NonNullable<EvidenceRequest["preflight"]>;
  readonly preflight: PreflightResult;
  readonly capabilitySnapshot: CapabilitySnapshot;
}

const CONTEXT_KEYS: readonly string[] = ["request", "preflight", "capabilitySnapshot"];

function decodeContextArtifact<T extends NecWireType>(type: T, value: unknown, pointer: string): NecWireDecoded[T] {
  if (value === undefined) contextInvalid(pointer);
  try {
    return decodeNecWireJson(type, JSON.stringify(value));
  } catch {
    return contextInvalid(pointer);
  }
}

function decodeContext(raw: unknown): CallerContext {
  const p = "/evidenceContext";
  const failure = inertFailure(raw, p, { nodes: 0 }, 0);
  if (failure !== null) contextInvalid(failure);
  const ctx = JSON.parse(JSON.stringify(raw)) as unknown;
  if (!isRecord(ctx) || Buffer.byteLength(JSON.stringify(ctx), "utf8") > EVIDENCE_CONTEXT_MAX_BYTES) contextInvalid(p);
  for (const key of Object.keys(ctx)) if (!CONTEXT_KEYS.includes(key)) contextInvalid(`${p}/${escapePointer(key)}`);
  const request = decodeContextArtifact("evidence-request", ctx.request, `${p}/request`);
  // An AFTER-only request (efda0ca-shaped) has no preflight: it can never be composed or verified.
  const preflightRef = request.preflight;
  if (preflightRef === undefined) contextInvalid(`${p}/request/preflight`);
  const preflight = decodeContextArtifact("preflight-result", ctx.preflight, `${p}/preflight`);
  if (!verifyPreflightResultIntegrity(preflight)) contextInvalid(`${p}/preflight`);
  const capabilitySnapshot = decodeContextArtifact("capability-snapshot", ctx.capabilitySnapshot, `${p}/capabilitySnapshot`);
  if (!verifyCapabilitySnapshotIntegrity(capabilitySnapshot)) contextInvalid(`${p}/capabilitySnapshot`);
  return { request, preflightRef, preflight, capabilitySnapshot };
}

/** Subject, request -> preflight -> snapshot continuity, all under the locally pinned manifest. */
function bindContext(ctx: CallerContext, subject: SubjectRef, pinned: ResolverManifest): void {
  const p = "/evidenceContext";
  const { request, preflightRef, preflight, capabilitySnapshot } = ctx;
  if (request.networkId !== subject.networkId || !same(request.subject, subject)) contextMismatch(`${p}/request/subject`);
  if (preflightRef.requestId !== preflight.request.requestId) contextMismatch(`${p}/request/preflight/requestId`);
  if (preflightRef.digest !== preflight.artifactDigest) contextMismatch(`${p}/preflight/artifactDigest`);
  if (!verifyCapabilitySnapshot(capabilitySnapshot, { resolver: pinned, networkId: subject.networkId })) {
    contextMismatch(`${p}/capabilitySnapshot`);
  }
  if (!verifyPreflightResult(preflight, { resolver: pinned, capabilitySnapshot })
      || preflight.resolver.digest !== pinned.digest
      || preflight.capabilitySnapshot?.digest !== capabilitySnapshot.artifactDigest) {
    contextMismatch(`${p}/preflight`);
  }
  if (preflight.request.networkId !== request.networkId || preflight.network.networkId !== request.networkId
      || !same(preflight.network, capabilitySnapshot.network)) {
    contextMismatch(`${p}/preflight/network`);
  }
  if (!same(preflight.request.action, request.action)) contextMismatch(`${p}/request/action`);
  const policy = request.evidencePolicy;
  if (!same(preflight.request.evidencePolicy, policy) || preflight.evidencePolicy.id !== policy.id
      || preflight.evidencePolicy.version !== policy.version || preflight.evidencePolicy.digest !== policy.digest) {
    contextMismatch(`${p}/request/evidencePolicy`);
  }
}

// ---------------------------------------------------------------------------
// Recomputation and composed-result checks
// ---------------------------------------------------------------------------

/** Recomputed from the reproduced acquisition flags, the reproduced fragment anchor and the caller preflight. */
function recomputeOutcome(
  acquisition: Record<string, unknown>, fragment: NetworkEvidenceFragment, preflight: PreflightResult,
): RecomputedOutcome {
  if (acquisition.transactionObserved !== true) return "transaction_not_observed";
  if (acquisition.blockObserved !== true) return "block_not_observed";
  if (acquisition.consistent !== true) return "acquisition_inconsistent";
  const timestamp = fragment.network.observedAt.timestamp;
  const blockTime = timestamp === undefined ? Number.NaN : Date.parse(timestamp);
  if (!Number.isFinite(blockTime)) return "block_timestamp_absent";
  // A rejection check on reported times only; never a precedence proof.
  if (!(Date.parse(preflight.generatedAt) < blockTime)) return "preflight_not_before_block";
  return "composable";
}

/** The served manifest must be exactly the local pinned family manifest (wire form). */
function checkPinnedManifest(served: Record<string, unknown>, pinned: ResolverManifest): void {
  const p = "/evidenceResult/resolverManifest";
  const local = JSON.parse(encodeNecWireJson("resolver-manifest", pinned)) as Record<string, unknown>;
  if (served.digest !== local.digest) halt("diverged", "manifest_not_pinned", `${p}/digest`);
  if (!same(served, local)) halt("diverged", "manifest_not_pinned", firstDiff(served, local, p) ?? p);
}

/** The one anchor a snapshot of the reproduced fragment may carry: its own subject block, nothing else. */
function subjectBlockAnchor(fragment: NetworkEvidenceFragment): EvidenceAnchor {
  const at = fragment.network.observedAt;
  return {
    networkId: fragment.network.networkId,
    ...(at.blockNumber === undefined ? {} : { blockNumber: at.blockNumber }),
    ...(at.blockId === undefined ? {} : { blockId: at.blockId }),
    ...(at.timestamp === undefined ? {} : { timestamp: at.timestamp }),
    role: "subject_block",
  };
}

function decodeServed<T extends NecWireType>(type: T, value: unknown, pointer: string): NecWireDecoded[T] {
  try {
    return decodeNecWireJson(type, JSON.stringify(value));
  } catch {
    return halt("diverged", "result_verification_failed", pointer);
  }
}

/**
 * The not-evaluated warnings each family's evaluator emits, by the dimensions
 * they cover (resolver-evm EVM_DIMENSIONS_NOT_EVALUATED; resolver-solana
 * SOLANA_SETTLEMENT_NOT_EVALUATED). A convention of this verifier, mirrored
 * from the resolver sources, not a Core fact.
 */
const NOT_EVALUATED_DECLARATIONS: Readonly<Record<Family, Readonly<Record<string, readonly EvidenceDimensionName[]>>>> = {
  evm: { EVM_DIMENSIONS_NOT_EVALUATED: ["settlement", "finality"] },
  solana: { SOLANA_SETTLEMENT_NOT_EVALUATED: ["settlement"] },
};

function declaresDimension(family: Family, warning: Warning, name: EvidenceDimensionName): boolean {
  const table = NOT_EVALUATED_DECLARATIONS[family];
  const covered = Object.hasOwn(table, warning.code) ? table[warning.code] : undefined;
  if (covered === undefined || !covered.includes(name)) return false;
  const listed = warning.metadata?.dimensions;
  return listed === undefined || (Array.isArray(listed) && listed.includes(name));
}

const DIMENSIONS: readonly EvidenceDimensionName[] = ["execution", "dataBinding", "settlement", "finality"];
const UNKNOWN_DIMENSION_KEYS = "applicability,basis,evidence,reason";

/** No strengthening: the result says nothing about a dimension that the reproduced fragment does not say. */
function checkDimensions(
  family: Family, fragment: NetworkEvidenceFragment, networkEvidence: Record<EvidenceDimensionName, EvidenceDimension>,
): void {
  for (const name of DIMENSIONS) {
    const p = `/evidenceResult/result/networkEvidence/${name}`;
    const own = fragment.networkEvidence[name];
    const served = networkEvidence[name];
    if (own !== undefined) {
      if (!same(own, served)) halt("diverged", "dimension_not_supported_by_fragment", p);
      continue;
    }
    if (Object.keys(served).sort().join(",") !== UNKNOWN_DIMENSION_KEYS || served.applicability !== "unknown"
        || served.basis.length !== 0 || served.evidence.length !== 0 || typeof served.reason !== "string") {
      halt("diverged", "dimension_not_supported_by_fragment", p);
    }
    // Exactly one of the fragment's own declaring warnings, rendered "<code>: <message>"; no free text after the code.
    const reason = served.reason;
    if (!fragment.warnings.some((w) => declaresDimension(family, w, name) && reason === `${w.code}: ${w.message}`)) {
      halt("diverged", "dimension_not_supported_by_fragment", `${p}/reason`);
    }
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function verifyEvidenceResultEnvelope(input: EvidenceResultVerificationInput): Promise<EvidenceResultVerificationReport> {
  let stage: EvidenceResultStage = "envelope";
  let servedStatus: EvidenceResultVerificationReport["servedStatus"] = null;
  let expectedOutcome: RecomputedOutcome | null = null;
  let hostedFragmentDigest: string | null = null;
  let reproducedFragmentDigest: string | null = null;
  let resultArtifactDigest: string | null = null;
  let anchor: PreflightAnchorReport | null = null;
  const report = (
    status: EvidenceResultVerificationStatus, reason: EvidenceResultVerificationReason, pointer?: string,
  ): EvidenceResultVerificationReport => ({
    status,
    reason,
    stage,
    ...(pointer === undefined ? {} : { firstDiffPointer: pointer }),
    servedStatus,
    expectedOutcome,
    hostedFragmentDigest,
    reproducedFragmentDigest,
    resultArtifactDigest,
    anchor,
    // Copied from the separate anchor report only.
    fixedBeforeExecution: anchor !== null && anchor.fixedBeforeExecution === true,
    nonClaims: EVIDENCE_RESULT_NON_CLAIMS,
  });
  try {
    // (1) Inert, bounded envelope; a detached copy is all that is read from here on.
    const rawEnvelope = ownData(input, "envelope");
    const failure = inertFailure(rawEnvelope, "", { nodes: 0 }, 0);
    if (failure !== null) halt("not_reproducible", "envelope_invalid", failure);
    const envelope = JSON.parse(JSON.stringify(rawEnvelope)) as unknown;
    if (!isRecord(envelope) || Buffer.byteLength(JSON.stringify(envelope), "utf8") > ENVELOPE_MAX_BYTES) {
      halt("not_reproducible", "envelope_invalid", "");
    }
    if (!Object.hasOwn(envelope, "evidenceResult")) return report("not_applicable", "evidence_result_absent", "/evidenceResult");

    // (2) The AFTER envelope itself, unchanged rules, on a copy without evidenceResult.
    stage = "after_envelope";
    const { evidenceResult: rawResult, ...stripped } = envelope;
    const reproduction = await reproduceObservationEnvelope(stripped);
    hostedFragmentDigest = reproduction.hostedFragmentDigest;
    reproducedFragmentDigest = reproduction.reproducedFragmentDigest;
    if (reproduction.status !== "reproduced") {
      return report(reproduction.status, reproduction.reason, reproduction.firstDiffPointer);
    }
    // Exactly the canonical fragment bytes the reproduction compared.
    const fragment = decodeNecWireJson("network-evidence-fragment", JSON.stringify(stripped.fragment));
    if (sha256(encodeNecWireJson("network-evidence-fragment", fragment)) !== reproducedFragmentDigest) {
      halt("not_reproducible", "harness_error", "/fragment");
    }
    const subjectRaw = stripped.subject as { networkId: string; txId: string };
    const subject: SubjectRef = { type: "transaction", networkId: subjectRaw.networkId, txId: subjectRaw.txId };
    const family: Family = subject.networkId.startsWith("eip155:") ? "evm" : "solana";
    const acquiredAt = stripped.acquiredAt as string;
    const acquisition = stripped.acquisition as Record<string, unknown>;

    // (3) Strict served shape.
    stage = "evidence_result";
    const served = parseEvidenceResult(rawResult);
    servedStatus = served.status;

    // (4) Caller context under the locally pinned family manifest.
    stage = "context";
    const pinned = family === "evm" ? evmBeforeResolverManifest() : solanaBeforeResolverManifest();
    const context = decodeContext(ownData(input, "evidenceContext"));
    bindContext(context, subject, pinned);
    anchor = matchPreflightAnchor(context.preflight, fragment);
    expectedOutcome = recomputeOutcome(acquisition, fragment, context.preflight);

    // (5) Composition.
    stage = "composition";
    if (served.status === "not_composed") {
      if (served.reason === "output_budget") return report("not_composed_unchecked", "output_budget");
      if (served.reason === expectedOutcome) return report("not_composed_reproduced", served.reason);
      return halt("diverged", "not_composed_unjustified", "/evidenceResult/reason");
    }
    if (expectedOutcome !== "composable") halt("diverged", "composed_unjustified", "/evidenceResult/status");
    checkPinnedManifest(served.resolverManifest, pinned);
    const result = decodeServed("network-evidence-result", served.result, "/evidenceResult/result");
    resultArtifactDigest = result.artifactDigest;
    const snapshot = decodeServed("evidence-snapshot", served.evidenceSnapshot, "/evidenceResult/evidenceSnapshot");

    const { request, preflight, capabilitySnapshot } = context;
    const policy = request.evidencePolicy;
    if (result.requestId !== request.requestId) contextMismatch("/evidenceResult/result/requestId");
    if (!same(result.action, request.action)) contextMismatch("/evidenceResult/result/action");
    if (result.policy.id !== policy.id || result.policy.version !== policy.version || result.policy.digest !== policy.digest) {
      contextMismatch("/evidenceResult/result/policy");
    }
    if (result.request.requestId !== request.requestId || result.request.digest !== computeEvidenceRequestDigest(request)) {
      contextMismatch("/evidenceResult/result/request");
    }

    const coreContext: NetworkEvidenceBuildContext = {
      policy, snapshot, resolver: pinned, request, preflight,
      preflightContext: { resolver: pinned, capabilitySnapshot },
    };
    if (!verifyNetworkEvidenceResult(result, coreContext)) halt("diverged", "result_verification_failed", "/evidenceResult");

    for (const key of ["subject", "network", "evidence", "conflicts", "warnings"] as const) {
      if (!same(result[key], fragment[key])) contextMismatch(`/evidenceResult/result/${key}`);
    }
    if (result.generatedAt !== acquiredAt) contextMismatch("/evidenceResult/result/generatedAt");
    if (snapshot.createdAt !== acquiredAt) contextMismatch("/evidenceResult/evidenceSnapshot/createdAt");
    // Core lets a snapshot evidence table be a superset of the result's and checks anchors only for
    // validity; the served snapshot must carry exactly the reproduced material and nothing more.
    if (!same(snapshot.evidence, fragment.evidence)) contextMismatch("/evidenceResult/evidenceSnapshot/evidence");
    if (!same(snapshot.anchors, [subjectBlockAnchor(fragment)])) contextMismatch("/evidenceResult/evidenceSnapshot/anchors");

    checkDimensions(family, fragment, result.networkEvidence);
    if (fragment.networkEvidence.observedEffects === undefined
        || !same(fragment.networkEvidence.observedEffects, result.networkEvidence.observedEffects)) {
      halt("diverged", "dimension_not_supported_by_fragment", "/evidenceResult/result/networkEvidence/observedEffects");
    }
    return report("verified", "composed_result_verified");
  } catch (error) {
    if (error instanceof Halt) return report(error.status, error.reason, error.pointer);
    // Never verified on an unexpected failure.
    return report("not_reproducible", "harness_error");
  }
}

// ---------------------------------------------------------------------------
// Optional CLI over capture-action.ts output files (the exports above stay pure)
//
//   tsx examples/hosted-reproduction/verify-evidence-result.ts --capture resolve-capture.json \
//     --context evidence-context.json [--preflight-capture preflight-capture.json] [--require-anchored]
//
// Order: the canonical contextSha256 is recomputed first; a mismatch exits 1
// (context_digest_mismatch) before any verification. Exit 0 only for
// verified:composed_result_verified (plus a bound preflight capture when one is
// given, plus anchored when --require-anchored is given). Everything else exits 1.
// ---------------------------------------------------------------------------

/** Pinned by test to capture-action.ts ACTION_CAPTURE_SCHEMA. */
export const ACTION_CAPTURE_SCHEMA_ACCEPTED = "ne-hosted-action-capture/v0.1";
export const EVIDENCE_RESULT_CLI_SCHEMA = "ne-hosted-evidence-result-cli-report/v0.1";

export type EvidenceResultCliExitReason =
  | "composed_result_verified" | "capture_invalid" | "context_digest_mismatch" | "not_verified"
  | "preflight_capture_invalid" | "preflight_capture_unbound" | "not_anchored";

export interface EvidenceResultCliReport {
  readonly schema: typeof EVIDENCE_RESULT_CLI_SCHEMA;
  /** Echoed from the capture: operator-declared, never verified. */
  readonly acquiringExecutable: unknown;
  readonly requireAnchored: boolean;
  /** Canonical-bytes digests (@nec/core canonicalJsonBytes), never wire bytes. */
  readonly contextSha256: { readonly recorded: string | null; readonly recomputed: string | null; readonly match: boolean };
  /** verifyEvidenceResultEnvelope, verbatim; null when not reached. */
  readonly report: EvidenceResultVerificationReport | null;
  /** verifyPreflightAnchor over the preflight capture and the AFTER envelope without evidenceResult; null when not given. */
  readonly preflightAnchor: PreflightAnchorReport | null;
  readonly exitCode: 0 | 1;
  readonly exitReason: EvidenceResultCliExitReason;
}

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
const CLI_VALUE_FLAGS: readonly string[] = ["--capture", "--context", "--preflight-capture"];

function parseCliArgs(argv: readonly string[]): {
  capture: string; context: string; preflightCapture: string | undefined; requireAnchored: boolean;
} {
  const values = new Map<string, string>();
  let requireAnchored = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] as string;
    if (flag === "--require-anchored") {
      if (requireAnchored) throw new Error("--require-anchored given more than once");
      requireAnchored = true;
      continue;
    }
    if (!CLI_VALUE_FLAGS.includes(flag)) throw new Error(`unknown argument ${JSON.stringify(flag)}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    if (values.has(flag)) throw new Error(`${flag} given more than once`);
    values.set(flag, value);
    i += 1;
  }
  const capture = values.get("--capture");
  const context = values.get("--context");
  if (capture === undefined) throw new Error("--capture <resolve action capture> is required");
  if (context === undefined) throw new Error("--context <evidenceContext file> is required");
  return { capture, context, preflightCapture: values.get("--preflight-capture"), requireAnchored };
}

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

/** sha256 over @nec/core canonicalJsonBytes; null outside nec-canonical-json-v1. */
function canonicalContextSha256(context: unknown): string | null {
  try {
    return `sha256:${createHash("sha256").update(canonicalJsonBytes(context)).digest("hex")}`;
  } catch {
    return null;
  }
}

/** The single call of an action capture of the given mode, else null. */
function actionCall(capture: unknown, mode: "preflight" | "resolve"): Record<string, unknown> | null {
  if (!isRecord(capture) || capture.schema !== ACTION_CAPTURE_SCHEMA_ACCEPTED || capture.mode !== mode) return null;
  const call = capture.call;
  const tool = mode === "resolve" ? "resolve_transaction_evidence" : "preflight_live_network_evidence";
  return isRecord(call) && call.tool === tool ? call : null;
}

export interface EvidenceResultCaptureInput {
  /** The parsed resolve action capture. */
  readonly capture: unknown;
  /** The parsed caller evidenceContext. */
  readonly context: unknown;
  /** Called lazily, only after the capture and contextSha256 checks passed; absent = no preflight capture given. */
  readonly loadPreflightCapture?: () => unknown;
  readonly requireAnchored: boolean;
}

/**
 * The CLI decision over already-parsed inputs (the body of `main` without
 * argument parsing, file reads or stdout). No network, clock or randomness;
 * the only side effect is whatever `loadPreflightCapture` does.
 */
export async function evaluateEvidenceResultCapture(input: EvidenceResultCaptureInput): Promise<EvidenceResultCliReport> {
  const { capture, context, loadPreflightCapture, requireAnchored } = input;
  const call = actionCall(capture, "resolve");
  const recordedRaw = call?.contextSha256;
  const recorded = typeof recordedRaw === "string" && SHA256_DIGEST.test(recordedRaw) ? recordedRaw : null;
  const recomputed = canonicalContextSha256(context);
  const contextSha256 = { recorded, recomputed, match: recorded !== null && recorded === recomputed };

  let report: EvidenceResultVerificationReport | null = null;
  let preflightAnchor: PreflightAnchorReport | null = null;
  let exitReason: EvidenceResultCliExitReason;
  if (call === null || recorded === null) {
    exitReason = "capture_invalid";
  } else if (!contextSha256.match) {
    // Before any verification.
    exitReason = "context_digest_mismatch";
  } else {
    const envelope = call.structuredContent;
    report = await verifyEvidenceResultEnvelope({ envelope, evidenceContext: context });
    let preflightInvalid = false;
    let preflightBound = true;
    if (loadPreflightCapture !== undefined) {
      const preflightCall = actionCall(loadPreflightCapture(), "preflight");
      if (preflightCall === null) {
        preflightInvalid = true;
      } else {
        // reproduceObservationEnvelope refuses an envelope that carries evidenceResult.
        let afterEnvelope: unknown = envelope;
        if (isRecord(envelope)) {
          const { evidenceResult: _evidenceResult, ...rest } = envelope;
          afterEnvelope = rest;
        }
        preflightAnchor = await verifyPreflightAnchor({ preflightEnvelope: preflightCall.structuredContent, afterEnvelope });
        // The served preflight must be the very preflight of the verified context, on the same reproduced fragment.
        preflightBound = preflightAnchor.stage === "anchor" && report.anchor !== null
          && preflightAnchor.preflightArtifactDigest !== null
          && preflightAnchor.preflightArtifactDigest === report.anchor.preflightArtifactDigest
          && preflightAnchor.afterFragmentDigest === report.anchor.afterFragmentDigest;
      }
    }
    const anchored = report.anchor !== null && report.anchor.status === "anchored"
      && (preflightAnchor === null || preflightAnchor.status === "anchored");
    if (report.status !== "verified" || report.reason !== "composed_result_verified") exitReason = "not_verified";
    else if (preflightInvalid) exitReason = "preflight_capture_invalid";
    else if (!preflightBound) exitReason = "preflight_capture_unbound";
    else if (requireAnchored && !anchored) exitReason = "not_anchored";
    else exitReason = "composed_result_verified";
  }
  const exitCode: 0 | 1 = exitReason === "composed_result_verified" ? 0 : 1;
  return {
    schema: EVIDENCE_RESULT_CLI_SCHEMA,
    acquiringExecutable: isRecord(capture) && capture.acquiringExecutable !== undefined ? capture.acquiringExecutable : null,
    requireAnchored,
    contextSha256,
    report,
    preflightAnchor,
    exitCode,
    exitReason,
  };
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseCliArgs(argv);
  const capture = readJsonFile(args.capture);
  const context = readJsonFile(args.context);
  const preflightPath = args.preflightCapture;
  const output = await evaluateEvidenceResultCapture({
    capture,
    context,
    ...(preflightPath === undefined ? {} : { loadPreflightCapture: () => readJsonFile(preflightPath) }),
    requireAnchored: args.requireAnchored,
  });
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  return output.exitCode;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`verify-evidence-result: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}
