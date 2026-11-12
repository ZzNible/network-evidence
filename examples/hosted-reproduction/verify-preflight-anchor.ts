/**
 * Offline, fail-closed PRE-EXECUTION ANCHOR check (anchor (c)): is the
 * artifactDigest of an integrity-valid Core PreflightResult committed as the
 * EIP-3009 nonce of exactly one `AuthorizationUsed(address,bytes32)` log
 * emitted by the caller's declared `action.target` in a reproduced AFTER
 * fragment?
 *
 * Pure: no network, clock, filesystem or randomness in the exported
 * functions. The preflight digest is never reimplemented: Core
 * `verifyPreflightResultIntegrity` recomputes it, and the nonce is compared
 * with that Core-validated `artifactDigest` only. The AuthorizationUsed topic0
 * is computed from the event signature at module load, never pasted.
 *
 * `verifyPreflightAnchor` first requires `verifyLivePreflightEnvelope` ->
 * verified and `reproduceObservationEnvelope` -> reproduced; any other report
 * is propagated with its status and reason unchanged. Neither strict parser
 * is loosened: both run on a detached copy of the caller's input, or on the
 * original input when it is not inert JSON data (they then refuse it).
 *
 * "anchored" is the ONLY status with fixedBeforeExecution:true. This verifier
 * performs, signs, simulates or presupposes no transaction, and it never
 * turns an existing AFTER (efda0ca included) into a BEFORE.
 */
import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";

import { decodeNecWireJson, deepFreeze, encodeNecWireJson, verifyPreflightResultIntegrity } from "@nec/core";
import type { NetworkEvidenceFragment, ObservedEffect, PreflightResult } from "@nec/core";
import { keccak256Hex, utf8Bytes } from "@nec/adapter-x402";

import { reproduceObservationEnvelope } from "./reproduce.js";
import type { ReproductionReason } from "./reproduce.js";
import { verifyLivePreflightEnvelope } from "./verify-live-before.js";
import type { VerificationReason } from "./verify-live-before.js";

export const AUTHORIZATION_USED_SIGNATURE = "AuthorizationUsed(address,bytes32)";
/** keccak256 of the event signature, computed at runtime. */
export const AUTHORIZATION_USED_TOPIC = `0x${keccak256Hex(utf8Bytes(AUTHORIZATION_USED_SIGNATURE))}`;

export type AnchorStatus =
  | "anchored" | "not_anchored" | "ambiguous" | "insufficient" | "not_applicable" | "diverged" | "not_reproducible";
export type AnchorReason =
  | "preflight_digest_committed_as_nonce"
  | "preflight_integrity_failed" | "after_fragment_invalid" | "network_mismatch" | "non_evm_subject"
  | "no_authorization_used_log" | "emitter_unbound" | "nonce_digest_mismatch" | "nonce_digest_multiple_matches"
  | "authorizer_mismatch" | "anchor_block_time_unavailable" | "clock_inconsistent" | "harness_error";
/** Which gate produced the report: a propagated envelope report, or the anchor check itself. */
export type AnchorStage = "preflight_envelope" | "after_envelope" | "anchor";

/**
 * The FROZEN check order (first failure wins), mirrored in the README:
 *   1  Core verifyPreflightResultIntegrity                  else diverged:preflight_integrity_failed
 *   1b the fragment is a valid Core NetworkEvidenceFragment else not_reproducible:after_fragment_invalid
 *   2  preflight.request.networkId == fragment.subject.networkId else diverged:network_mismatch
 *   3  EVM (eip155) transaction subject                    else not_applicable:non_evm_subject
 *   4  AuthorizationUsed candidates (evm.log of the subject tx, not removed, exactly 3 topics,
 *      topics[0] == AUTHORIZATION_USED_TOPIC)               none -> not_anchored:no_authorization_used_log
 *   5  action.target is a lowercase EVM address equal to a candidate's emitter
 *      (a convention this verifier imposes, not a Core or token-contract fact)
 *                                                          else insufficient:emitter_unbound
 *   6  bound candidates with topics[2] == "0x" + hex(artifactDigest):
 *      one -> continue, zero -> not_anchored:nonce_digest_mismatch, more -> ambiguous:nonce_digest_multiple_matches
 *   7  request.account present: topics[1] == that address left-padded to 32 bytes
 *                                                          else diverged:authorizer_mismatch
 *   8  consistency only: the anchored log's block is the fragment anchor and carries a timestamp
 *      (else insufficient:anchor_block_time_unavailable), and preflight.generatedAt <= that block time
 *                                                          else diverged:clock_inconsistent
 *   -> anchored:preflight_digest_committed_as_nonce
 */
export const ANCHOR_CHECK_ORDER: readonly (readonly [AnchorStatus, AnchorReason])[] = deepFreeze([
  ["diverged", "preflight_integrity_failed"],
  ["not_reproducible", "after_fragment_invalid"],
  ["diverged", "network_mismatch"],
  ["not_applicable", "non_evm_subject"],
  ["not_anchored", "no_authorization_used_log"],
  ["insufficient", "emitter_unbound"],
  ["not_anchored", "nonce_digest_mismatch"],
  ["ambiguous", "nonce_digest_multiple_matches"],
  ["diverged", "authorizer_mismatch"],
  ["insufficient", "anchor_block_time_unavailable"],
  ["diverged", "clock_inconsistent"],
  ["anchored", "preflight_digest_committed_as_nonce"],
] as const);

export const ANCHOR_NON_CLAIMS: readonly string[] = deepFreeze([
  "anchored means only that the Core-validated artifactDigest of this PreflightResult equals topics[2] (the EIP-3009 nonce) of exactly one AuthorizationUsed log emitted by the declared action.target in this AFTER fragment. It does not prove that the observed effects match the action, nor settlement, finality or any economic consequence.",
  "The emitter binding (action.target == log emitter) is a convention imposed by this verifier, not a Core or token-contract fact.",
  "This verifier never makes efda0ca or any existing AFTER fixedBeforeExecution; fixedBeforeExecution is true only in an anchored report.",
  "A 32-byte nonce that fits the sha256 digest width is not a preimage match; only exact equality with the Core-recomputed artifactDigest counts.",
  "preflight.generatedAt <= block time is a consistency check on reported timestamps, not a proof of ordering.",
  "Reproduction is not independent source verification; no provider, network or clock is consulted.",
  "Whether anchor (c) is accepted as pre-execution proof is an owner decision; this report closes no gate row.",
]);

export interface PreflightAnchorReport {
  readonly status: AnchorStatus;
  readonly reason: AnchorReason | VerificationReason | ReproductionReason;
  readonly stage: AnchorStage;
  /** The Core-validated artifactDigest, or the claimed one when integrity failed; null if none was readable. */
  readonly preflightArtifactDigest: string | null;
  /** topics[2] of the single identified AuthorizationUsed log, else null. */
  readonly observedNonce: string | null;
  /** sha256 of the AFTER fragment's canonical nec-wire-json-v1 bytes; null if not Core-encodable or not reached. */
  readonly afterFragmentDigest: string | null;
  readonly fixedBeforeExecution: boolean;
  readonly nonClaims: readonly string[];
}

export interface PreflightAnchorInput {
  /** `preflight_live_network_evidence` structuredContent. */
  readonly preflightEnvelope: unknown;
  /** `resolve_transaction_evidence` structuredContent. */
  readonly afterEnvelope: unknown;
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const EVM_ADDRESS = /^0x[0-9a-f]{40}$/;
const sha256 = (text: string): string => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;

function anchorReport(
  status: AnchorStatus, reason: PreflightAnchorReport["reason"], stage: AnchorStage,
  preflightArtifactDigest: string | null, observedNonce: string | null, afterFragmentDigest: string | null,
): PreflightAnchorReport {
  return {
    status, reason, stage, preflightArtifactDigest, observedNonce, afterFragmentDigest,
    fixedBeforeExecution: status === "anchored",
    nonClaims: ANCHOR_NON_CLAIMS,
  };
}

/** The claimed artifactDigest of a rejected preflight, read without invoking any accessor. */
function claimedDigest(value: unknown): string | null {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value)) return null;
  const descriptor = Object.getOwnPropertyDescriptor(value, "artifactDigest");
  return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string" && DIGEST.test(descriptor.value)
    ? descriptor.value : null;
}

/** (1) Core integrity, then a detached copy that Core decodes (and so re-validates) again. */
function integrityChecked(preflight: PreflightResult): PreflightResult | null {
  try {
    if (!verifyPreflightResultIntegrity(preflight)) return null;
    const copy = decodeNecWireJson("preflight-result", encodeNecWireJson("preflight-result", preflight));
    return verifyPreflightResultIntegrity(copy) ? copy : null;
  } catch {
    return null;
  }
}

function detachedFragment(fragment: NetworkEvidenceFragment): { fragment: NetworkEvidenceFragment; digest: string } | null {
  try {
    const wire = encodeNecWireJson("network-evidence-fragment", fragment);
    return { fragment: decodeNecWireJson("network-evidence-fragment", wire), digest: sha256(wire) };
  } catch {
    return null;
  }
}

const topicsOf = (effect: ObservedEffect): readonly string[] => effect.fields.topics as string[];

function isAuthorizationUsed(effect: ObservedEffect, txId: string): boolean {
  const topics = effect.fields.topics;
  // "evm.log" is resolver-evm's generic log effect type (EVM_LOG_EFFECT_TYPE).
  return effect.type === "evm.log" && effect.fields.transactionHash === txId && effect.fields.removed === false &&
    Array.isArray(topics) && topics.length === 3 && topics.every((t: unknown) => typeof t === "string") &&
    topics[0] === AUTHORIZATION_USED_TOPIC;
}

/**
 * Pure anchor check over an already-decoded preflight and AFTER fragment, in
 * the frozen order of ANCHOR_CHECK_ORDER. Nothing is fetched or read from a clock.
 */
export function matchPreflightAnchor(preflight: PreflightResult, fragment: NetworkEvidenceFragment): PreflightAnchorReport {
  let preflightArtifactDigest: string | null = null;
  let observedNonce: string | null = null;
  let afterFragmentDigest: string | null = null;
  const report = (status: AnchorStatus, reason: AnchorReason): PreflightAnchorReport =>
    anchorReport(status, reason, "anchor", preflightArtifactDigest, observedNonce, afterFragmentDigest);
  try {
    const after = detachedFragment(fragment);
    afterFragmentDigest = after?.digest ?? null;

    // (1) Core integrity (self-digest recomputed by Core).
    const pf = integrityChecked(preflight);
    if (pf === null) {
      preflightArtifactDigest = claimedDigest(preflight);
      return report("diverged", "preflight_integrity_failed");
    }
    preflightArtifactDigest = pf.artifactDigest;
    // (1b) Only a Core-valid fragment is examined.
    if (after === null) return report("not_reproducible", "after_fragment_invalid");
    const f = after.fragment;
    const subject = f.subject;

    // (2) Same network.
    if (pf.request.networkId !== subject.networkId) return report("diverged", "network_mismatch");
    // (3) EVM transaction subject.
    if (subject.type !== "transaction" || !subject.networkId.startsWith("eip155:")) {
      return report("not_applicable", "non_evm_subject");
    }
    const txId = subject.txId;

    // (4) AuthorizationUsed candidates by the runtime-computed topic0.
    const candidates = (f.networkEvidence.observedEffects ?? []).filter((e) => isAuthorizationUsed(e, txId));
    if (candidates.length === 0) return report("not_anchored", "no_authorization_used_log");

    // (5) Emitter binding: a convention of this verifier, not a Core or code fact.
    const target = pf.request.action.target;
    if (target === undefined || !EVM_ADDRESS.test(target)) return report("insufficient", "emitter_unbound");
    const bound = candidates.filter((e) => e.fields.address === target);
    if (bound.length === 0) return report("insufficient", "emitter_unbound");

    // (6) Exactly one nonce equal to the Core artifactDigest.
    const expectedNonce = `0x${pf.artifactDigest.slice("sha256:".length)}`;
    const matches = bound.filter((e) => topicsOf(e)[2] === expectedNonce);
    if (matches.length === 0) {
      if (bound.length === 1) observedNonce = topicsOf(bound[0] as ObservedEffect)[2] ?? null;
      return report("not_anchored", "nonce_digest_mismatch");
    }
    if (matches.length > 1) return report("ambiguous", "nonce_digest_multiple_matches");
    const log = matches[0] as ObservedEffect;
    observedNonce = expectedNonce;

    // (7) Authorizer, only when the caller declared an account.
    const account = pf.request.account;
    if (account !== undefined && (!EVM_ADDRESS.test(account) || topicsOf(log)[1] !== `0x${"0".repeat(24)}${account.slice(2)}`)) {
      return report("diverged", "authorizer_mismatch");
    }

    // (8) Consistency only; a missing block time is never treated as consistent.
    const anchor = f.network.observedAt;
    if (anchor.timestamp === undefined || anchor.blockId === undefined || log.fields.blockHash !== anchor.blockId) {
      return report("insufficient", "anchor_block_time_unavailable");
    }
    if (Date.parse(pf.generatedAt) > Date.parse(anchor.timestamp)) return report("diverged", "clock_inconsistent");

    return report("anchored", "preflight_digest_committed_as_nonce");
  } catch {
    return report("not_reproducible", "harness_error");
  }
}

/**
 * Detached copy of inert, bounded JSON data (same rules as the strict
 * parsers' own check), else undefined.
 */
function detachedJson(value: unknown): unknown {
  const state = { nodes: 0 };
  const inert = (v: unknown, depth: number): boolean => {
    state.nodes += 1;
    if (state.nodes > 100_000 || depth > 64) return false;
    if (v === null || typeof v === "string" || typeof v === "boolean") return true;
    if (typeof v === "number") return Number.isFinite(v);
    if (typeof v !== "object" || utilTypes.isProxy(v)) return false;
    const array = Array.isArray(v);
    const proto = Object.getPrototypeOf(v) as object | null;
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) return false;
    if (array) {
      const length = (v as unknown[]).length;
      for (let i = 0; i < length; i++) if (!Object.hasOwn(v, i)) return false;
    }
    for (const key of Reflect.ownKeys(v)) {
      if (array && key === "length") continue;
      if (typeof key !== "string") return false;
      const descriptor = Object.getOwnPropertyDescriptor(v, key);
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable || !inert(descriptor.value, depth + 1)) return false;
    }
    return true;
  };
  return inert(value, 0) ? JSON.parse(JSON.stringify(value)) as unknown : undefined;
}

/**
 * Envelope wrapper: verified preflight envelope + reproduced AFTER envelope,
 * then matchPreflightAnchor over the Core artifacts they carry. The verifiers
 * and the anchor check all read the same detached copies.
 */
export async function verifyPreflightAnchor(input: PreflightAnchorInput): Promise<PreflightAnchorReport> {
  let stage: AnchorStage = "preflight_envelope";
  let preflightArtifactDigest: string | null = null;
  try {
    const preflightCopy = detachedJson(input?.preflightEnvelope);
    const preflightReport = verifyLivePreflightEnvelope(preflightCopy ?? input?.preflightEnvelope);
    preflightArtifactDigest = preflightReport.preflightArtifactDigest;
    if (preflightReport.status !== "verified") {
      return anchorReport(preflightReport.status, preflightReport.reason, stage, preflightArtifactDigest, null, null);
    }
    if (preflightCopy === undefined) return anchorReport("not_reproducible", "harness_error", stage, preflightArtifactDigest, null, null);

    stage = "after_envelope";
    const afterCopy = detachedJson(input.afterEnvelope);
    const afterReport = await reproduceObservationEnvelope(afterCopy ?? input.afterEnvelope);
    if (afterReport.status !== "reproduced") {
      return anchorReport(afterReport.status, afterReport.reason, stage, preflightArtifactDigest, null, null);
    }
    if (afterCopy === undefined) return anchorReport("not_reproducible", "harness_error", stage, preflightArtifactDigest, null, null);

    stage = "anchor";
    const preflight = decodeNecWireJson("preflight-result", JSON.stringify((preflightCopy as Record<string, unknown>).preflight));
    const fragment = decodeNecWireJson("network-evidence-fragment", JSON.stringify((afterCopy as Record<string, unknown>).fragment));
    const anchored = matchPreflightAnchor(preflight, fragment);
    // The anchor check must have examined exactly the canonical bytes the reproduction compared.
    if (anchored.afterFragmentDigest !== afterReport.reproducedFragmentDigest) {
      return anchorReport("not_reproducible", "harness_error", stage, preflightArtifactDigest, null, null);
    }
    return anchored;
  } catch {
    return anchorReport("not_reproducible", "harness_error", stage, preflightArtifactDigest, null, null);
  }
}
