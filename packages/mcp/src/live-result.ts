/**
 * Pure, I/O-free full-action composer for ONE hosted AFTER observation.
 *
 * Binds a caller-returned Core PreflightResult + CapabilitySnapshot (expected
 * action and evidence policy fixed before execution) and a later
 * EvidenceRequest to the hosted AFTER fragment. The NetworkEvidenceResult is
 * produced and re-verified ONLY by Core (buildNetworkEvidenceResult /
 * verifyNetworkEvidenceResult); Core's own continuity chain does the linking.
 *
 * - The resolver manifest is pinned by the server per network family: a
 *   fragment carries no resolver identity, so no caller manifest is accepted.
 * - Continuity is not precedence. preflight.generatedAt earlier than the block
 *   timestamp is a necessary rejection check on server-clock time, never proof.
 * - Owner-ratified G1 (option A): a dimension the pinned family resolver did
 *   not evaluate is {applicability:"unknown", basis:[], evidence:[], reason:
 *   the fragment's own not-evaluated warning}; a policy that requires it stays
 *   unsatisfied. Never a verdict, never not_applicable.
 * - The optional OP Stack finality fragment is never decoded or merged: it
 *   belongs to another resolver and would credit foreign evidence to the
 *   generic family manifest.
 */
import {
  buildEvidenceSnapshot, buildNetworkEvidenceResult, canonicalNecJson, computeEvidenceRequestDigest,
  decodeNecWireJson, deepFreeze, digestCanonicalJson, encodeNecWireJson, verifyCapabilitySnapshot,
  verifyNetworkEvidenceResult, verifyPreflightResult,
} from "@nec/core";
import type {
  CapabilitySnapshot, EvidenceAnchor, EvidenceDimension, EvidenceDimensionName, EvidenceRequest,
  NecWireDecoded, NecWireType, NetworkEvidenceBuildContext, NetworkEvidenceFragment, NetworkEvidenceResult,
  PreflightResult, ResolverManifest, SubjectRef, Warning,
} from "@nec/core";
import { evmBeforeResolverManifest, parseTransactionHashInput } from "@nec/resolver-evm";
import { parseSignature, solanaBeforeResolverManifest } from "@nec/resolver-solana";
import { NeMcpError } from "./errors.js";
import { LIVE_MULTICHAIN_NETWORK_IDS, MULTICHAIN_RESULT_MAX_BYTES } from "./live-multichain.js";
import type { MultichainObservation, TransactionSubject } from "./live-multichain.js";

export const EVIDENCE_CONTEXT_MAX_BYTES = 64 * 1024;
export const EVIDENCE_CONTEXT_KEYS = ["request", "preflight", "capabilitySnapshot"] as const;

export type EvidenceContextErrorCode =
  | "MCP_EVIDENCE_CONTEXT_INVALID"
  | "MCP_EVIDENCE_CONTEXT_NO_PREFLIGHT"
  | "MCP_EVIDENCE_CONTEXT_CALLER_MANIFEST"
  | "MCP_EVIDENCE_CONTEXT_TOO_LARGE";

/**
 * Context rejection raised before any RPC read. A real NeMcpError: its four
 * codes are members of the closed NeMcpErrorCode union (errors.ts), so both
 * `instanceof NeMcpError` and toSafeToolError keep its code and bounded,
 * server-authored message (no cause, no caller payload). The tool surface
 * exposes it through live-claim.ts resolveWithOptionalClaim. Its `code` is
 * always an EvidenceContextErrorCode, a subset of NeMcpErrorCode.
 */
export class EvidenceContextError extends NeMcpError {
  constructor(code: EvidenceContextErrorCode, message: string) {
    super(code, message);
  }
}

export type NetworkFamily = "evm" | "solana";

export interface PreparedEvidenceContext {
  readonly family: NetworkFamily;
  readonly subject: TransactionSubject;
  readonly request: EvidenceRequest;
  readonly preflight: PreflightResult;
  readonly capabilitySnapshot: CapabilitySnapshot;
  /** Server-pinned family manifest; never caller-supplied. */
  readonly manifest: ResolverManifest;
}

export type EvidenceResultNotComposedReason =
  | "transaction_not_observed"
  | "block_not_observed"
  | "acquisition_inconsistent"
  | "block_timestamp_absent"
  | "preflight_not_before_block"
  | "output_budget";

export interface EvidenceResultNotComposed {
  readonly status: "not_composed";
  readonly reason: EvidenceResultNotComposedReason;
}

export interface ComposedEvidenceResult {
  readonly status: "composed";
  readonly artifactType: "network-evidence-result";
  readonly preExecutionBinding: "core_preflight_continuity";
  /** Core wire JSON (nec-wire-json-v1) of the verified artifacts. */
  readonly result: Record<string, unknown>;
  readonly evidenceSnapshot: Record<string, unknown>;
  readonly resolverManifest: Record<string, unknown>;
  readonly nonClaims: readonly string[];
}

export type EvidenceResultOutcome = ComposedEvidenceResult | EvidenceResultNotComposed;

export const LIVE_RESULT_NON_CLAIMS: readonly string[] = Object.freeze([
  "Continuity is not precedence: the caller-returned PreflightResult is re-verified against the server-pinned resolver manifest, but its provenance and time are not established; a preflight generatedAt earlier than the block timestamp is a necessary rejection check, not proof that the action or policy existed before execution.",
  "This result is not policy satisfaction: Core does not compare the policy's required dimensions with the evaluated dimensions.",
  "Dimensions the pinned family resolver did not evaluate remain applicability unknown with no verdict, basis or evidence; missing is never zero.",
  "Expected-action continuity does not establish that an external execution produced the subject.",
  "The optional OP Stack L2 finality fragment is never merged into this result; no settlement, withdrawal finalization or economic finality is established.",
  "No signing, transaction submission, network choice or trust score is provided.",
]);

const PINNED_MANIFESTS: Readonly<Record<NetworkFamily, () => ResolverManifest>> = {
  evm: evmBeforeResolverManifest,
  solana: solanaBeforeResolverManifest,
};

/**
 * G1 option A source: the fragment's OWN not-evaluated warning per family.
 * resolver-evm evaluator.ts DIMENSIONS_NOT_EVALUATED_WARNING;
 * resolver-solana evaluate.ts SOLANA_SETTLEMENT_NOT_EVALUATED.
 */
const NOT_EVALUATED_WARNING_CODES: Readonly<Record<NetworkFamily, Partial<Record<EvidenceDimensionName, string>>>> = {
  evm: { settlement: "EVM_DIMENSIONS_NOT_EVALUATED", finality: "EVM_DIMENSIONS_NOT_EVALUATED" },
  solana: { settlement: "SOLANA_SETTLEMENT_NOT_EVALUATED" },
};

const DIMENSIONS: readonly EvidenceDimensionName[] = ["execution", "dataBinding", "settlement", "finality"];

/** Only contexts returned by prepareEvidenceContext can be composed. */
const PREPARED = new WeakSet<object>();

function reject(code: EvidenceContextErrorCode, message: string): never {
  throw new EvidenceContextError(code, message);
}
function invalid(detail: string): never {
  reject("MCP_EVIDENCE_CONTEXT_INVALID", `evidenceContext rejected before any RPC read: ${detail}`);
}
function noPreflight(): never {
  reject("MCP_EVIDENCE_CONTEXT_NO_PREFLIGHT",
    "evidenceContext requires request.preflight and the complete referenced PreflightResult; without a pre-execution preflight no full result is composed");
}
function unverified(): never {
  throw new NeMcpError("MCP_RESULT_UNVERIFIED",
    "the hosted AFTER fragment could not be composed into a Core-verified NetworkEvidenceResult under the server-pinned context");
}
function notComposed(reason: EvidenceResultNotComposedReason): EvidenceResultNotComposed {
  const outcome: EvidenceResultNotComposed = { status: "not_composed", reason };
  return Object.freeze(outcome);
}
function plain(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}
function same(a: unknown, b: unknown): boolean {
  return canonicalNecJson(a) === canonicalNecJson(b);
}
function familyOf(networkId: string): NetworkFamily {
  return networkId.startsWith("eip155:") ? "evm" : "solana";
}
function subjectRef(subject: TransactionSubject): SubjectRef {
  return { type: "transaction", networkId: subject.networkId, txId: subject.txId };
}
function wireJson(type: NecWireType, value: unknown): Record<string, unknown> {
  return JSON.parse(encodeNecWireJson(type, value)) as Record<string, unknown>;
}

function exactSubject(subject: unknown): TransactionSubject {
  if (!plain(subject)) invalid("subject is not an exact supported transaction SubjectRef");
  const { type, networkId, txId } = subject;
  if (Object.keys(subject).length !== 3
      || !Object.keys(subject).every(k => k === "type" || k === "networkId" || k === "txId")
      || type !== "transaction" || typeof networkId !== "string" || typeof txId !== "string"
      || !(LIVE_MULTICHAIN_NETWORK_IDS as readonly string[]).includes(networkId)) {
    invalid("subject is not an exact supported transaction SubjectRef");
  }
  const exact = { type: "transaction", networkId, txId } as TransactionSubject;
  try {
    if (familyOf(exact.networkId) === "evm") {
      if (!/^0x[0-9a-f]{64}$/.test(exact.txId)) throw new Error("not canonical");
      parseTransactionHashInput(exact.txId);
    } else parseSignature(exact.txId);
  } catch { invalid("subject transaction id is not canonical for its network family"); }
  return exact;
}

function decodeArtifact<T extends NecWireType>(type: T, value: unknown, field: string): NecWireDecoded[T] {
  try {
    return decodeNecWireJson(type, JSON.stringify(value));
  } catch { return invalid(`${field} is not a valid Core ${type}`); }
}

/**
 * Validate the complete caller context. This function must run before the
 * first RPC read; it performs no I/O and reads no clock.
 */
export function prepareEvidenceContext(subject: TransactionSubject, raw: unknown): PreparedEvidenceContext {
  const exact = exactSubject(subject);
  const family = familyOf(exact.networkId);
  if (!plain(raw)) invalid("evidenceContext must be a plain JSON object");
  let text: string | undefined;
  try { text = JSON.stringify(raw); } catch { invalid("evidenceContext is not JSON data"); }
  if (typeof text !== "string") invalid("evidenceContext is not JSON data");
  if (Buffer.byteLength(text) > EVIDENCE_CONTEXT_MAX_BYTES) {
    reject("MCP_EVIDENCE_CONTEXT_TOO_LARGE", `evidenceContext exceeds ${EVIDENCE_CONTEXT_MAX_BYTES} bytes`);
  }
  const keys = Object.keys(raw);
  if (keys.some(k => /manifest/i.test(k))) {
    reject("MCP_EVIDENCE_CONTEXT_CALLER_MANIFEST",
      "the resolver manifest is pinned by the server per network family; a caller-supplied manifest is never accepted");
  }
  if (keys.some(k => !(EVIDENCE_CONTEXT_KEYS as readonly string[]).includes(k))) {
    invalid("only request, preflight and capabilitySnapshot are accepted");
  }
  if (raw.request === undefined) invalid("request is required");
  const request = decodeArtifact("evidence-request", raw.request, "request");
  const preflightRef = request.preflight;
  if (preflightRef === undefined || raw.preflight === undefined) noPreflight();
  if (raw.capabilitySnapshot === undefined) invalid("capabilitySnapshot is required");
  const preflight = decodeArtifact("preflight-result", raw.preflight, "preflight");
  const snapshot = decodeArtifact("capability-snapshot", raw.capabilitySnapshot, "capabilitySnapshot");

  if (request.networkId !== exact.networkId || !same(request.subject, subjectRef(exact))) {
    invalid("request.subject must canonically equal the requested subject");
  }
  const manifest = PINNED_MANIFESTS[family]();
  if (!verifyCapabilitySnapshot(snapshot, { resolver: manifest, networkId: exact.networkId })) {
    invalid("capabilitySnapshot does not verify against the server-pinned resolver manifest");
  }
  if (!verifyPreflightResult(preflight, { resolver: manifest, capabilitySnapshot: snapshot })
      || preflight.resolver.digest !== manifest.digest
      || preflight.capabilitySnapshot?.digest !== snapshot.artifactDigest) {
    invalid("preflight does not verify against the server-pinned resolver manifest and the supplied capabilitySnapshot");
  }
  if (preflightRef.digest !== preflight.artifactDigest || preflightRef.requestId !== preflight.request.requestId) {
    invalid("request.preflight does not reference the supplied PreflightResult (stale or substituted preflight)");
  }
  if (preflight.request.networkId !== request.networkId || preflight.network.networkId !== request.networkId
      || !same(preflight.network, snapshot.network)) {
    invalid("preflight network continuity with the request and capabilitySnapshot is broken");
  }
  if (!same(preflight.request.action, request.action)) {
    invalid("the preflighted action differs from the request expected action");
  }
  const policy = request.evidencePolicy;
  if (!same(preflight.request.evidencePolicy, policy) || preflight.evidencePolicy.id !== policy.id
      || preflight.evidencePolicy.version !== policy.version || preflight.evidencePolicy.digest !== policy.digest) {
    invalid("the preflighted evidence policy differs from the request evidence policy");
  }

  const prepared: PreparedEvidenceContext = {
    family,
    subject: Object.freeze(exact),
    request: deepFreeze(request),
    preflight: deepFreeze(preflight),
    capabilitySnapshot: deepFreeze(snapshot),
    manifest,
  };
  PREPARED.add(Object.freeze(prepared));
  return prepared;
}

function declaresDimension(warning: Warning, name: EvidenceDimensionName): boolean {
  const listed = warning.metadata?.dimensions;
  return !Array.isArray(listed) || listed.includes(name);
}

/** Evaluated dimensions verbatim; omitted ones strictly per G1 option A. */
function composeNetworkEvidence(
  fragment: NetworkEvidenceFragment,
  ctx: PreparedEvidenceContext,
): NetworkEvidenceResult["networkEvidence"] {
  const supported = new Set<string>(ctx.manifest.supportedCapabilities);
  const out = {} as Record<EvidenceDimensionName, EvidenceDimension>;
  for (const name of DIMENSIONS) {
    const present = fragment.networkEvidence[name];
    if (present !== undefined) {
      // A dimension outside the pinned manifest would credit a foreign resolver.
      if (!supported.has(name)) unverified();
      out[name] = present;
      continue;
    }
    const code = NOT_EVALUATED_WARNING_CODES[ctx.family][name];
    const warning = code === undefined ? undefined
      : fragment.warnings.find(w => w.code === code && declaresDimension(w, name));
    if (supported.has(name) || warning === undefined) unverified();
    out[name] = { applicability: "unknown", basis: [], evidence: [], reason: `${warning.code}: ${warning.message}` };
  }
  const observedEffects = fragment.networkEvidence.observedEffects;
  if (observedEffects === undefined) unverified();
  return {
    execution: out.execution,
    observedEffects,
    dataBinding: out.dataBinding,
    settlement: out.settlement,
    finality: out.finality,
  };
}

/**
 * Compose the hosted AFTER observation with a prepared context. Pure: the
 * observation is already acquired; nothing is fetched and no clock is read.
 */
export function composeNetworkEvidenceResult(
  observation: MultichainObservation,
  ctx: PreparedEvidenceContext,
): EvidenceResultOutcome {
  if (!PREPARED.has(ctx)) unverified();
  const subject = ctx.subject;
  if (!plain(observation) || observation.observationKind !== "live_source_observation"
      || observation.artifactType !== "network-evidence-fragment"
      || !same(observation.subject, subject) || observation.source.networkId !== subject.networkId) unverified();
  let fragment: NetworkEvidenceFragment;
  try {
    fragment = decodeNecWireJson("network-evidence-fragment", JSON.stringify(observation.fragment));
  } catch { return unverified(); }
  const acquisition = observation.acquisition;
  if (!same(fragment.subject, subjectRef(subject)) || fragment.network.networkId !== subject.networkId
      || !acquisition.captures.every(cap => fragment.evidence.some(ref =>
        ref.sourceId === observation.source.sourceId && ref.contentDigest === cap.contentDigest))) unverified();

  if (acquisition.transactionObserved !== true) return notComposed("transaction_not_observed");
  if (acquisition.blockObserved !== true) return notComposed("block_not_observed");
  if (acquisition.consistent !== true) return notComposed("acquisition_inconsistent");
  const at = fragment.network.observedAt;
  const timestamp = at.timestamp;
  if (timestamp === undefined || !Number.isFinite(Date.parse(timestamp))) return notComposed("block_timestamp_absent");
  const blockTime = Date.parse(timestamp);
  // Necessary rejection check only (server clock); never a precedence proof.
  if (!(Date.parse(ctx.preflight.generatedAt) < blockTime)) return notComposed("preflight_not_before_block");

  const networkEvidence = composeNetworkEvidence(fragment, ctx);
  const policy = ctx.request.evidencePolicy;
  const manifest = ctx.manifest;
  let composed: ComposedEvidenceResult;
  try {
    const anchor: EvidenceAnchor = {
      networkId: fragment.network.networkId,
      ...(at.blockNumber === undefined ? {} : { blockNumber: at.blockNumber }),
      ...(at.blockId === undefined ? {} : { blockId: at.blockId }),
      timestamp,
      role: "subject_block",
    };
    const snapshotKey = digestCanonicalJson("ne-mcp-evidence-snapshot-id-v1", {
      request: computeEvidenceRequestDigest(ctx.request),
      acquiredAt: observation.acquiredAt,
      evidence: fragment.evidence.map(ref => ref.id),
    });
    const snapshot = buildEvidenceSnapshot({
      id: `ne-mcp-snapshot-${snapshotKey.slice("sha256:".length, "sha256:".length + 32)}`,
      createdAt: observation.acquiredAt,
      networkFingerprint: fragment.network,
      anchors: [anchor],
      evidence: fragment.evidence,
      resolverManifestDigest: manifest.digest,
      policyDigest: policy.digest,
    }, { policy, resolver: manifest });
    const context: NetworkEvidenceBuildContext = {
      policy, snapshot, resolver: manifest, request: ctx.request, preflight: ctx.preflight,
      preflightContext: { resolver: manifest, capabilitySnapshot: ctx.capabilitySnapshot },
    };
    const result = buildNetworkEvidenceResult({
      schemaVersion: "0.1",
      requestId: ctx.request.requestId,
      generatedAt: observation.acquiredAt,
      action: ctx.request.action,
      network: fragment.network,
      subject: fragment.subject,
      policy: { id: policy.id, version: policy.version, digest: policy.digest },
      snapshot: { id: snapshot.id, digest: snapshot.digest },
      networkEvidence,
      evidence: fragment.evidence,
      conflicts: fragment.conflicts,
      warnings: fragment.warnings,
      resolver: { id: manifest.id, version: manifest.version, digest: manifest.digest },
    }, context);

    // Re-verify what a caller will actually receive: the wire round-trip.
    const savedResult = decodeNecWireJson("network-evidence-result", encodeNecWireJson("network-evidence-result", result));
    const savedSnapshot = decodeNecWireJson("evidence-snapshot", encodeNecWireJson("evidence-snapshot", snapshot));
    if (savedResult.artifactDigest !== result.artifactDigest || savedResult.semanticDigest !== result.semanticDigest
        || savedSnapshot.digest !== snapshot.digest
        || !verifyNetworkEvidenceResult(savedResult, { ...context, snapshot: savedSnapshot })) unverified();
    const kept = savedResult.networkEvidence;
    if (!same(kept, networkEvidence) || !same(savedResult.evidence, fragment.evidence)
        || !same(savedResult.conflicts, fragment.conflicts) || !same(savedResult.warnings, fragment.warnings)
        || !same(savedResult.network, fragment.network) || !same(savedResult.subject, fragment.subject)) unverified();

    composed = {
      status: "composed",
      artifactType: "network-evidence-result",
      preExecutionBinding: "core_preflight_continuity",
      result: wireJson("network-evidence-result", savedResult),
      evidenceSnapshot: wireJson("evidence-snapshot", savedSnapshot),
      resolverManifest: wireJson("resolver-manifest", manifest),
      nonClaims: LIVE_RESULT_NON_CLAIMS,
    };
  } catch (error) {
    if (error instanceof NeMcpError) throw error;
    return unverified();
  }
  // Same shared tool-output cap as the AFTER envelope; never raised here.
  if (Buffer.byteLength(JSON.stringify({ ...observation, evidenceResult: composed })) > MULTICHAIN_RESULT_MAX_BYTES) {
    return notComposed("output_budget");
  }
  return composed;
}
