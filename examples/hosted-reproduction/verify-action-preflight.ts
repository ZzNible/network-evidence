/**
 * GT-02 step 3a (examples-only; closes no gate row; GT-02 stays OPEN): an
 * offline, fail-closed check of ONE `preflight` action capture
 * (capture-action.ts, `ne-hosted-action-capture/v0.1`) BEFORE the irreversible
 * human step 5. It binds the capture to the caller's own request file and to
 * the resolver manifest pinned at the reproducing commit
 * (`evmBeforeResolverManifest()` / `solanaBeforeResolverManifest()`).
 *
 *   tsx examples/hosted-reproduction/verify-action-preflight.ts --preflight-capture preflight-capture.json \
 *     --request preflight-arguments.json [--anchor-c-readiness]
 *
 * Frozen check order (first failure wins):
 *   1  capture: inert JSON data, schema ACTION_CAPTURE_SCHEMA_ACCEPTED, mode
 *      `preflight`, tool `preflight_live_network_evidence`, isError false
 *      -> else not_reproducible:capture_invalid
 *   2  preflight_envelope: verifyLivePreflightEnvelope(call.structuredContent,
 *      { expected: <the caller's request file> }), never call.arguments; any
 *      non-verified status/reason is propagated verbatim
 *   3  pinned_manifest: the served resolverManifest must be the pinned family
 *      manifest, digest first, then canonical wire equality
 *      -> else diverged:manifest_not_pinned; then Core verifyCapabilitySnapshot
 *      and verifyPreflightResult against the PINNED manifest
 *      -> else diverged:pinned_context_mismatch
 *   4  anchor_readiness, only when requested: a non-eip155 network
 *      -> not_applicable:non_evm_subject; action.target must be a lowercase
 *      0x+40-hex address -> else insufficient:anchor_target_not_bindable;
 *      request.account, if present, likewise
 *      -> else insufficient:anchor_account_not_bindable
 *
 * verifyLivePreflightEnvelope verifies the served context against the
 * manifest returned by the SAME server; a Core-consistent drifted manifest
 * passes it. Step 3 is what refuses that drift.
 *
 * Pure: no network, clock, filesystem or randomness in the exported function;
 * the only timestamps read are those carried by the inputs (inside the
 * unchanged verifyLivePreflightEnvelope). The report never prints an EIP-3009
 * nonce, an EIP-712 field, a transaction input or any artifact digest of the
 * preflight, and never echoes the requestId, account, action or metadata.
 * `fixedBeforeExecution` is always false. Exit 0 is not authorization to
 * execute.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { types as utilTypes } from "node:util";

import {
  canonicalNecJson,
  decodeNecWireJson,
  encodeNecWireJson,
  verifyCapabilitySnapshot,
  verifyPreflightResult,
} from "@nec/core";
import type { ResolverManifest } from "@nec/core";
import { evmBeforeResolverManifest } from "@nec/resolver-evm";
import { solanaBeforeResolverManifest } from "@nec/resolver-solana";

import { ACTION_CAPTURE_SCHEMA_ACCEPTED } from "./verify-evidence-result.js";
import { verifyLivePreflightEnvelope } from "./verify-live-before.js";
import type { LivePreflightReport, VerificationReason } from "./verify-live-before.js";

export const ACTION_PREFLIGHT_CHECK_SCHEMA = "ne-hosted-action-preflight-check/v0.1";
const PREFLIGHT_TOOL = "preflight_live_network_evidence";
const EVM_ADDRESS = /^0x[0-9a-f]{40}$/;

export type ActionPreflightCheckStage = "capture" | "preflight_envelope" | "pinned_manifest" | "anchor_readiness" | "complete";
export type ActionPreflightCheckStatus =
  | "verified" | "anchor_ready" | "not_reproducible" | "diverged" | "not_applicable" | "insufficient";
export type ActionPreflightCheckReason =
  // exit 0
  | "preflight_capture_pinned" | "anchor_c_bindable"
  // step 1
  | "capture_invalid"
  // step 2, propagated verbatim from verifyLivePreflightEnvelope
  | Exclude<VerificationReason, "envelope_verified">
  // step 3
  | "manifest_not_pinned" | "pinned_context_mismatch"
  // step 4
  | "non_evm_subject" | "anchor_target_not_bindable" | "anchor_account_not_bindable";

export interface ActionPreflightCheckReport {
  readonly schema: typeof ACTION_PREFLIGHT_CHECK_SCHEMA;
  readonly anchorReadinessRequested: boolean;
  readonly status: ActionPreflightCheckStatus;
  readonly reason: ActionPreflightCheckReason;
  readonly stage: ActionPreflightCheckStage;
  /** verifyLivePreflightEnvelope's status, reason and contextualVerification; null when not reached. No pointer or digest is echoed. */
  readonly preflightEnvelope: {
    readonly status: LivePreflightReport["status"];
    readonly reason: VerificationReason;
    readonly contextualVerification: LivePreflightReport["contextualVerification"];
  } | null;
  /** A fixed live profile id, as validated by verifyLivePreflightEnvelope; else null. */
  readonly selectedNetworkId: string | null;
  /** Core evidence readiness, echoed and never gated (never wallet, gas, execution or settlement readiness). */
  readonly preflightStatus: string | null;
  /** Reached only after step 2 verified. */
  readonly manifest: {
    readonly family: "evm" | "solana";
    readonly pinnedDigest: string;
    readonly servedDigest: string | null;
    readonly pinned: boolean;
  } | null;
  readonly fixedBeforeExecution: false;
  readonly exitCode: 0 | 1;
  readonly nonClaims: readonly string[];
}

export interface ActionPreflightCheckInput {
  /** The parsed `preflight` action capture. */
  readonly capture: unknown;
  /** The caller's own request file ({selectedNetworkId, probeSubject, request}) that step 3 sent. */
  readonly requestFile: unknown;
  /** --anchor-c-readiness */
  readonly anchorReadiness?: boolean;
}

export const ACTION_PREFLIGHT_CHECK_NON_CLAIMS: readonly string[] = Object.freeze([
  "Exit 0 is not authorization to execute anything. It is not precedence, not policy satisfaction and not wallet, account, balance, signing or gas readiness.",
  "verified means only: this non-error preflight action capture verifies under verifyLivePreflightEnvelope against the caller's own request file, and the served resolver manifest, capability snapshot and preflight hold under the resolver manifest pinned at this reproducing commit. The served context comes from the same server; this is not independent source verification.",
  "preflightStatus is Core evidence readiness, echoed and never gated; it is not execution, settlement or finality.",
  "fixedBeforeExecution is always false here: nothing in this report shows that an action or policy existed before any execution.",
  "anchor_ready means only that the declared eip155 action.target, and the account if one is declared, are lowercase 0x addresses the anchor (c) matcher could bind. It is not an anchor. Whether anchor (c) counts is an owner decision.",
  "This report carries no EIP-3009 nonce, no EIP-712 field, no transaction input and no preflight artifact digest, and echoes no requestId, account, action or metadata string. The capture and the request file stay private by default.",
  "GT-02 stays OPEN. This check closes no gate row.",
]);

type HaltStatus = Exclude<ActionPreflightCheckStatus, "verified" | "anchor_ready">;

class Halt extends Error {
  constructor(readonly status: HaltStatus, readonly reason: ActionPreflightCheckReason) {
    super(reason);
  }
}

function halt(status: HaltStatus, reason: ActionPreflightCheckReason): never {
  throw new Halt(status, reason);
}

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

/** Inert JSON data only (same rules as the sibling strict parsers). */
function inert(value: unknown, state: { nodes: number }, depth: number): boolean {
  state.nodes += 1;
  if (state.nodes > 250_000 || depth > 64) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || utilTypes.isProxy(value)) return false;
  const array = Array.isArray(value);
  const proto = Object.getPrototypeOf(value) as object | null;
  if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) return false;
  if (array) {
    const length = (value as unknown[]).length;
    for (let i = 0; i < length; i++) if (!Object.hasOwn(value, i)) return false;
  }
  for (const key of Reflect.ownKeys(value)) {
    if (array && key === "length") continue;
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) return false;
    if (!inert(descriptor.value, state, depth + 1)) return false;
  }
  return true;
}

/** A detached copy of inert JSON data, else undefined. */
function detach(value: unknown): unknown {
  if (value === undefined || !inert(value, { nodes: 0 }, 0)) return undefined;
  return JSON.parse(JSON.stringify(value)) as unknown;
}

/** Step 1: the single non-error preflight call of an action capture, else null. */
function preflightCall(capture: unknown): Record<string, unknown> | null {
  if (!isRecord(capture) || capture.schema !== ACTION_CAPTURE_SCHEMA_ACCEPTED || capture.mode !== "preflight") return null;
  const call = capture.call;
  if (!isRecord(call) || call.tool !== PREFLIGHT_TOOL || call.isError !== false) return null;
  return call;
}

export function verifyActionPreflightCapture(input: ActionPreflightCheckInput): ActionPreflightCheckReport {
  const anchorReadinessRequested = ownData(input, "anchorReadiness") === true;
  let stage: ActionPreflightCheckStage = "capture";
  let preflightEnvelope: ActionPreflightCheckReport["preflightEnvelope"] = null;
  let selectedNetworkId: string | null = null;
  let preflightStatus: string | null = null;
  let manifest: ActionPreflightCheckReport["manifest"] = null;
  const report = (status: ActionPreflightCheckStatus, reason: ActionPreflightCheckReason): ActionPreflightCheckReport => {
    const exitCode: 0 | 1 = status === "verified" || status === "anchor_ready" ? 0 : 1;
    return {
      schema: ACTION_PREFLIGHT_CHECK_SCHEMA,
      anchorReadinessRequested,
      status,
      reason,
      stage,
      preflightEnvelope,
      selectedNetworkId,
      preflightStatus,
      manifest,
      fixedBeforeExecution: false,
      exitCode,
      nonClaims: ACTION_PREFLIGHT_CHECK_NON_CLAIMS,
    };
  };
  try {
    // (1) The capture: a detached inert copy is all that is read from here on.
    const call = preflightCall(detach(ownData(input, "capture")));
    if (call === null) halt("not_reproducible", "capture_invalid");

    // (2) The caller's own request file, never call.arguments. An absent or non-inert
    // request file is passed as null, which the unchanged verifier refuses; it never skips the binding.
    stage = "preflight_envelope";
    const requestFile = detach(ownData(input, "requestFile"));
    const live = verifyLivePreflightEnvelope(call.structuredContent, { expected: requestFile === undefined ? null : requestFile });
    preflightEnvelope = { status: live.status, reason: live.reason, contextualVerification: live.contextualVerification };
    selectedNetworkId = live.selectedNetworkId;
    preflightStatus = live.preflightStatus;
    if (live.status !== "verified") halt(live.status, live.reason as Exclude<VerificationReason, "envelope_verified">);
    const networkId = live.selectedNetworkId;
    const envelope = call.structuredContent;
    if (networkId === null || !isRecord(envelope)) halt("not_reproducible", "harness_error");

    // (3) The served manifest must be the pinned family manifest, then the context must hold under it.
    stage = "pinned_manifest";
    const family = networkId.startsWith("eip155:") ? "evm" : "solana";
    const pinned: ResolverManifest = family === "evm" ? evmBeforeResolverManifest() : solanaBeforeResolverManifest();
    const local = JSON.parse(encodeNecWireJson("resolver-manifest", pinned)) as Record<string, unknown>;
    const served = envelope.resolverManifest;
    const servedDigest = isRecord(served) && typeof served.digest === "string" ? served.digest : null;
    manifest = { family, pinnedDigest: pinned.digest, servedDigest, pinned: false };
    if (servedDigest !== local.digest) halt("diverged", "manifest_not_pinned");
    if (!same(served, local)) halt("diverged", "manifest_not_pinned");
    manifest = { ...manifest, pinned: true };
    const snapshot = decodeNecWireJson("capability-snapshot", JSON.stringify(envelope.capabilitySnapshot));
    const preflight = decodeNecWireJson("preflight-result", JSON.stringify(envelope.preflight));
    if (!verifyCapabilitySnapshot(snapshot, { resolver: pinned, networkId })
        || !verifyPreflightResult(preflight, { resolver: pinned, capabilitySnapshot: snapshot })
        || preflight.resolver.digest !== pinned.digest
        || preflight.capabilitySnapshot?.digest !== snapshot.artifactDigest) {
      halt("diverged", "pinned_context_mismatch");
    }
    if (!anchorReadinessRequested) {
      stage = "complete";
      return report("verified", "preflight_capture_pinned");
    }

    // (4) Read from the Core-decoded served request, which step 2 bound canonically to the request file.
    stage = "anchor_readiness";
    if (!networkId.startsWith("eip155:")) halt("not_applicable", "non_evm_subject");
    const target = preflight.request.action.target;
    if (target === undefined || !EVM_ADDRESS.test(target)) halt("insufficient", "anchor_target_not_bindable");
    const account = preflight.request.account;
    if (account !== undefined && !EVM_ADDRESS.test(account)) halt("insufficient", "anchor_account_not_bindable");
    stage = "complete";
    return report("anchor_ready", "anchor_c_bindable");
  } catch (error) {
    if (error instanceof Halt) return report(error.status, error.reason);
    // Never verified on an unexpected failure.
    return report("not_reproducible", "harness_error");
  }
}

// ---------------------------------------------------------------------------
// CLI (reads the two files it is given, prints the report; no network request)
// ---------------------------------------------------------------------------

const CLI_VALUE_FLAGS: readonly string[] = ["--preflight-capture", "--request"];

export function parseActionPreflightArgs(argv: readonly string[]): {
  preflightCapture: string; request: string; anchorReadiness: boolean;
} {
  const values = new Map<string, string>();
  let anchorReadiness = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] as string;
    if (flag === "--anchor-c-readiness") {
      if (anchorReadiness) throw new Error("--anchor-c-readiness given more than once");
      anchorReadiness = true;
      continue;
    }
    if (!CLI_VALUE_FLAGS.includes(flag)) throw new Error(`unknown argument ${JSON.stringify(flag)}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    if (values.has(flag)) throw new Error(`${flag} given more than once`);
    values.set(flag, value);
    i += 1;
  }
  const preflightCapture = values.get("--preflight-capture");
  const request = values.get("--request");
  if (preflightCapture === undefined) throw new Error("--preflight-capture <preflight action capture> is required");
  if (request === undefined) throw new Error("--request <the caller's request file> is required");
  return { preflightCapture, request, anchorReadiness };
}

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

/** Exit 0 only for verified (or anchor_ready with --anchor-c-readiness); every other report exits 1. */
export function main(argv: readonly string[]): number {
  const args = parseActionPreflightArgs(argv);
  const capture = readJsonFile(args.preflightCapture);
  const requestFile = readJsonFile(args.request);
  const report = verifyActionPreflightCapture({ capture, requestFile, anchorReadiness: args.anchorReadiness });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.exitCode;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let code = 1;
  try {
    code = main(process.argv.slice(2));
  } catch (error: unknown) {
    process.stderr.write(`verify-action-preflight: ${error instanceof Error ? error.message : String(error)}\n`);
    code = 1;
  }
  process.exit(code);
}
