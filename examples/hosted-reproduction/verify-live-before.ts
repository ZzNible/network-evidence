/**
 * Offline, fail-closed checks of ONE hosted BEFORE envelope captured by
 * capture-hosted.ts: `discover_live_network_evidence` structuredContent
 * (`ne-mcp-live-discovery/v0.1`) or `preflight_live_network_evidence`
 * structuredContent (`ne-mcp-live-preflight/v0.1`).
 *
 * Pure: no network, clock, filesystem or randomness in the exported functions.
 * Freshness compares the envelope's own generatedAt with each candidate
 * observedAt, never "now". "verified" is returned only when EVERY check holds.
 *
 * Discovery returns snapshot digests, not the complete CapabilitySnapshots and
 * ResolverManifests, so Core contextual verification cannot run here; it is
 * always reported as "context_not_returned", never as verified. The preflight
 * context (snapshot + manifest) is returned by the SAME server: verifying
 * against it shows internal Core consistency, not independent verification.
 */
import { pathToFileURL } from "node:url";
import { types as utilTypes } from "node:util";

import {
  decodeNecWireJson,
  encodeNecWireJson,
  verifyCapabilitySnapshot,
  verifyDiscoverNetworksResultIntegrity,
  verifyPreflightResult,
} from "@nec/core";
import { parseSignature } from "@nec/resolver-solana";

/** Pinned by test to LIVE_BEFORE_SCHEMA / LIVE_PREFLIGHT_SCHEMA / LIVE_BEFORE_MAX_AGE_MS (packages/mcp/src). */
export const LIVE_DISCOVERY_SCHEMA = "ne-mcp-live-discovery/v0.1";
export const LIVE_PREFLIGHT_SCHEMA = "ne-mcp-live-preflight/v0.1";
export const LIVE_BEFORE_MAX_AGE_MS = 180_000;
/** Pinned by test to LIVE_BEFORE_MAX_CANDIDATES (packages/mcp/src/live-before.ts): 1..3 candidates on distinct live networks. */
export const LIVE_BEFORE_MAX_CANDIDATES = 3;
/** Same bound as LIVE_BEFORE_MAX_OUTPUT_BYTES and LIVE_PREFLIGHT_MAX_OUTPUT_BYTES. */
const ENVELOPE_MAX_BYTES = 180_000;
/** The fixed live profiles (packages/mcp/src/live-before.ts NETWORK_PROFILES). */
const PROFILES: Readonly<Record<string, { readonly id: string; readonly environment: "mainnet" | "testnet" }>> = Object.freeze({
  "eip155:8453": { id: "base-mainnet", environment: "mainnet" },
  "eip155:84532": { id: "base-sepolia", environment: "testnet" },
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": { id: "solana-mainnet", environment: "mainnet" },
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1": { id: "solana-devnet", environment: "testnet" },
});
const CLASSIFICATIONS: readonly string[] = ["eligible", "conditional", "ineligible"];

export type VerificationStatus = "verified" | "diverged" | "not_reproducible";
export type VerificationReason =
  // verified
  | "envelope_verified"
  // not_reproducible: material missing, or outside this verifier (never handled by loosening a parser)
  | "envelope_invalid" | "unknown_schema" | "unsupported_network" | "core_artifact_invalid" | "harness_error"
  // diverged: material present but a binding does not hold
  | "integrity_failed" | "generated_at_mismatch" | "candidate_binding_mismatch"
  | "observation_after_generation" | "observation_stale"
  | "choice_source_mismatch" | "probe_network_mismatch" | "capability_snapshot_context_mismatch"
  | "preflight_context_mismatch" | "preflight_binding_mismatch" | "request_binding_mismatch";

export interface LiveDiscoveryReport {
  readonly status: VerificationStatus;
  readonly reason: VerificationReason;
  /** RFC 6901 pointer into the envelope. */
  readonly firstDiffPointer?: string;
  /** The Core result's artifactDigest once it decoded, else null. */
  readonly resultArtifactDigest: string | null;
  /** Complete snapshots + manifests are not in the envelope; never "verified". */
  readonly contextualVerification: "context_not_returned";
  /** Bound candidates, only when status is "verified". */
  readonly candidates: readonly {
    readonly networkId: string;
    readonly classification: string;
    readonly snapshotDigest: string;
    readonly observationAgeMs: number;
  }[];
}

export interface LivePreflightReport {
  readonly status: VerificationStatus;
  readonly reason: VerificationReason;
  readonly firstDiffPointer?: string;
  /** The Core PreflightResult artifactDigest once it decoded, else null. */
  readonly preflightArtifactDigest: string | null;
  readonly selectedNetworkId: string | null;
  /** Core evidence readiness status (never wallet, execution or settlement readiness). */
  readonly preflightStatus: string | null;
  /** Against the snapshot + manifest returned in the SAME envelope, not an independent context. */
  readonly contextualVerification: "returned_context_verified" | "not_verified";
}

/** Optional binding to the capture's own call arguments (capture-hosted.ts `calls[].arguments`). */
export interface VerifyOptions {
  readonly expected?: unknown;
}

class Halt extends Error {
  constructor(readonly status: Exclude<VerificationStatus, "verified">, readonly reason: VerificationReason, readonly pointer?: string) {
    super(reason);
  }
}

function stop(status: Exclude<VerificationStatus, "verified">, reason: VerificationReason, pointer?: string): never {
  throw new Halt(status, reason, pointer);
}

function invalid(pointer: string): never {
  throw new Halt("not_reproducible", "envelope_invalid", pointer);
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const escapePointer = (key: string): string => key.replace(/~/g, "~0").replace(/\//g, "~1");
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const EVM_HASH = /^0x[0-9a-f]{64}$/;
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// ---------------------------------------------------------------------------
// Strict parse (hostile input: inert JSON data only, exact keys)
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

/** Inert, bounded JSON data, returned as a detached copy. */
function inertCopy(value: unknown): unknown {
  assertJsonData(value, "", { nodes: 0 }, 0);
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, "utf8") > ENVELOPE_MAX_BYTES) invalid("");
  return JSON.parse(text) as unknown;
}

function record(value: unknown, pointer: string): Record<string, unknown> {
  if (!isRecord(value)) invalid(pointer);
  return value;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], pointer: string): void {
  for (const key of keys) if (!Object.hasOwn(value, key)) invalid(`${pointer}/${escapePointer(key)}`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) invalid(`${pointer}/${escapePointer(key)}`);
}

function str(value: unknown, pointer: string): string {
  if (typeof value !== "string" || value.length === 0) invalid(pointer);
  return value;
}

function digest(value: unknown, pointer: string): string {
  const text = str(value, pointer);
  if (!DIGEST.test(text)) invalid(pointer);
  return text;
}

function isoMs(value: unknown, pointer: string): string {
  const text = str(value, pointer);
  if (!ISO_MS.test(text) || Number.isNaN(Date.parse(text)) || new Date(text).toISOString() !== text) invalid(pointer);
  return text;
}

function liveNetwork(value: unknown, pointer: string): string {
  const networkId = str(value, pointer);
  if (!Object.hasOwn(PROFILES, networkId)) stop("not_reproducible", "unsupported_network", pointer);
  return networkId;
}

function stringList(value: unknown, pointer: string): void {
  if (!Array.isArray(value) || !value.every((x: unknown) => typeof x === "string")) invalid(pointer);
}

function captureRefs(value: unknown, pointer: string): void {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) invalid(pointer);
  for (const [i, raw] of value.entries()) {
    const p = `${pointer}/${i}`;
    const capture = record(raw, p);
    exactKeys(capture, ["rpcMethod", "contentDigest"], p);
    str(capture.rpcMethod, `${p}/rpcMethod`);
    digest(capture.contentDigest, `${p}/contentDigest`);
  }
}

function decodeCore<T extends Parameters<typeof decodeNecWireJson>[0]>(type: T, value: unknown, pointer: string) {
  try {
    return decodeNecWireJson(type, JSON.stringify(value));
  } catch {
    return stop("not_reproducible", "core_artifact_invalid", pointer);
  }
}

function argumentsOf(options: VerifyOptions | undefined): Record<string, unknown> | undefined {
  const expected = options?.expected;
  if (expected === undefined) return undefined;
  if (!isRecord(expected)) stop("diverged", "request_binding_mismatch", "");
  return expected;
}

// ---------------------------------------------------------------------------
// discover_live_network_evidence
// ---------------------------------------------------------------------------

const DISCOVERY_KEYS = ["schema", "observationKind", "builtAndVerifiedBy", "generatedAt", "result", "candidates", "nonClaims"] as const;
const CANDIDATE_KEYS = [
  "id", "environment", "networkId", "classification", "observedAt", "sourceId", "sourceType",
  "snapshotId", "snapshotDigest", "resolver", "evidenceCaptures", "capabilities",
] as const;

interface DiscoveryCandidate {
  readonly networkId: string;
  readonly classification: string;
  readonly observedAt: string;
  readonly snapshotId: string;
  readonly snapshotDigest: string;
}

function parseDiscovery(value: unknown): { generatedAt: string; result: Record<string, unknown>; candidates: DiscoveryCandidate[] } {
  const env = record(value, "");
  if (env.schema !== LIVE_DISCOVERY_SCHEMA) stop("not_reproducible", "unknown_schema", "/schema");
  exactKeys(env, DISCOVERY_KEYS, "");
  if (env.observationKind !== "live_source_observation") invalid("/observationKind");
  if (env.builtAndVerifiedBy !== "@nec/discovery + @nec/core") invalid("/builtAndVerifiedBy");
  const generatedAt = isoMs(env.generatedAt, "/generatedAt");
  const result = record(env.result, "/result");
  stringList(env.nonClaims, "/nonClaims");
  const rawCandidates = env.candidates;
  if (!Array.isArray(rawCandidates) || rawCandidates.length < 1 || rawCandidates.length > LIVE_BEFORE_MAX_CANDIDATES) {
    invalid("/candidates");
  }
  const seen = new Set<string>();
  const candidates = rawCandidates.map((raw: unknown, i): DiscoveryCandidate => {
    const p = `/candidates/${i}`;
    const c = record(raw, p);
    exactKeys(c, CANDIDATE_KEYS, p);
    const networkId = liveNetwork(c.networkId, `${p}/networkId`);
    if (seen.has(networkId)) invalid(`${p}/networkId`);
    seen.add(networkId);
    const profile = PROFILES[networkId]!;
    if (c.id !== profile.id) invalid(`${p}/id`);
    if (c.environment !== profile.environment) invalid(`${p}/environment`);
    const classification = str(c.classification, `${p}/classification`);
    if (!CLASSIFICATIONS.includes(classification)) invalid(`${p}/classification`);
    str(c.sourceId, `${p}/sourceId`);
    str(c.sourceType, `${p}/sourceType`);
    const resolver = record(c.resolver, `${p}/resolver`);
    exactKeys(resolver, ["id", "version", "digest"], `${p}/resolver`);
    str(resolver.id, `${p}/resolver/id`);
    str(resolver.version, `${p}/resolver/version`);
    digest(resolver.digest, `${p}/resolver/digest`);
    captureRefs(c.evidenceCaptures, `${p}/evidenceCaptures`);
    record(c.capabilities, `${p}/capabilities`);
    return {
      networkId,
      classification,
      observedAt: isoMs(c.observedAt, `${p}/observedAt`),
      snapshotId: str(c.snapshotId, `${p}/snapshotId`),
      snapshotDigest: digest(c.snapshotDigest, `${p}/snapshotDigest`),
    };
  });
  return { generatedAt, result, candidates };
}

export function verifyLiveDiscoveryEnvelope(envelope: unknown, options?: VerifyOptions): LiveDiscoveryReport {
  let resultArtifactDigest: string | null = null;
  const report = (status: VerificationStatus, reason: VerificationReason, pointer?: string,
    candidates: LiveDiscoveryReport["candidates"] = []): LiveDiscoveryReport => ({
    status, reason, ...(pointer === undefined ? {} : { firstDiffPointer: pointer }),
    resultArtifactDigest, contextualVerification: "context_not_returned", candidates,
  });
  try {
    const env = parseDiscovery(inertCopy(envelope));
    const core = decodeCore("discovery-result", env.result, "/result");
    resultArtifactDigest = core.artifactDigest;
    if (!verifyDiscoverNetworksResultIntegrity(core)) stop("diverged", "integrity_failed", "/result");
    if (core.generatedAt !== env.generatedAt) stop("diverged", "generated_at_mismatch", "/generatedAt");
    if (core.matches.length !== env.candidates.length) stop("diverged", "candidate_binding_mismatch", "/candidates");

    const bound = env.candidates.map((c, i) => {
      const p = `/candidates/${i}`;
      const matches = core.matches.filter((m) => m.network.networkId === c.networkId);
      const match = matches[0];
      if (matches.length !== 1 || match === undefined) stop("diverged", "candidate_binding_mismatch", `${p}/networkId`);
      if (match.classification !== c.classification) stop("diverged", "candidate_binding_mismatch", `${p}/classification`);
      if (match.capabilitySnapshot.digest !== c.snapshotDigest) stop("diverged", "candidate_binding_mismatch", `${p}/snapshotDigest`);
      if (match.capabilitySnapshot.id !== c.snapshotId) stop("diverged", "candidate_binding_mismatch", `${p}/snapshotId`);
      const observationAgeMs = Date.parse(env.generatedAt) - Date.parse(c.observedAt);
      if (observationAgeMs < 0) stop("diverged", "observation_after_generation", `${p}/observedAt`);
      if (observationAgeMs > LIVE_BEFORE_MAX_AGE_MS) stop("diverged", "observation_stale", `${p}/observedAt`);
      return { networkId: c.networkId, classification: c.classification, snapshotDigest: c.snapshotDigest, observationAgeMs };
    });

    const args = argumentsOf(options);
    if (args !== undefined) {
      if (args.requestId !== core.requestId) stop("diverged", "request_binding_mismatch", "/result/requestId");
      const subjects = Array.isArray(args.subjects) ? args.subjects as unknown[] : [];
      const asked = subjects.map((s) => (isRecord(s) ? s.networkId : undefined)).sort();
      const answered = env.candidates.map((c) => c.networkId).sort();
      if (JSON.stringify(asked) !== JSON.stringify(answered)) stop("diverged", "request_binding_mismatch", "/candidates");
    }
    return report("verified", "envelope_verified", undefined, bound);
  } catch (error) {
    if (error instanceof Halt) return report(error.status, error.reason, error.pointer);
    return report("not_reproducible", "harness_error");
  }
}

// ---------------------------------------------------------------------------
// preflight_live_network_evidence
// ---------------------------------------------------------------------------

const PREFLIGHT_KEYS = [
  "schema", "observationKind", "choiceSource", "selectedNetworkId", "probeSubject", "probeObservedAt",
  "source", "evidenceCaptures", "verifiedBy", "preflight", "capabilitySnapshot", "resolverManifest", "nonClaims",
] as const;

function parsePreflight(value: unknown) {
  const env = record(value, "");
  if (env.schema !== LIVE_PREFLIGHT_SCHEMA) stop("not_reproducible", "unknown_schema", "/schema");
  exactKeys(env, PREFLIGHT_KEYS, "");
  if (env.observationKind !== "live_source_observation") invalid("/observationKind");
  if (env.verifiedBy !== "@nec/core") invalid("/verifiedBy");
  const choiceSource = str(env.choiceSource, "/choiceSource");
  const selectedNetworkId = liveNetwork(env.selectedNetworkId, "/selectedNetworkId");
  const probe = record(env.probeSubject, "/probeSubject");
  exactKeys(probe, ["type", "networkId", "txId"], "/probeSubject");
  if (probe.type !== "transaction") invalid("/probeSubject/type");
  const probeNetworkId = liveNetwork(probe.networkId, "/probeSubject/networkId");
  const txId = str(probe.txId, "/probeSubject/txId");
  if (probeNetworkId.startsWith("eip155:") ? !EVM_HASH.test(txId) : !validSignature(txId)) invalid("/probeSubject/txId");
  isoMs(env.probeObservedAt, "/probeObservedAt");
  const source = record(env.source, "/source");
  exactKeys(source, ["sourceId", "sourceType"], "/source");
  str(source.sourceId, "/source/sourceId");
  str(source.sourceType, "/source/sourceType");
  captureRefs(env.evidenceCaptures, "/evidenceCaptures");
  stringList(env.nonClaims, "/nonClaims");
  return {
    choiceSource, selectedNetworkId, probe: { type: "transaction", networkId: probeNetworkId, txId },
    preflight: record(env.preflight, "/preflight"),
    capabilitySnapshot: record(env.capabilitySnapshot, "/capabilitySnapshot"),
    resolverManifest: record(env.resolverManifest, "/resolverManifest"),
  };
}

function validSignature(value: string): boolean {
  try { return parseSignature(value) === value; } catch { return false; }
}

export function verifyLivePreflightEnvelope(envelope: unknown, options?: VerifyOptions): LivePreflightReport {
  let preflightArtifactDigest: string | null = null;
  let selectedNetworkId: string | null = null;
  let preflightStatus: string | null = null;
  const report = (status: VerificationStatus, reason: VerificationReason, pointer?: string): LivePreflightReport => ({
    status, reason, ...(pointer === undefined ? {} : { firstDiffPointer: pointer }),
    preflightArtifactDigest, selectedNetworkId, preflightStatus,
    contextualVerification: status === "verified" ? "returned_context_verified" : "not_verified",
  });
  try {
    const env = parsePreflight(inertCopy(envelope));
    selectedNetworkId = env.selectedNetworkId;
    if (env.choiceSource !== "caller") stop("diverged", "choice_source_mismatch", "/choiceSource");
    if (env.probe.networkId !== env.selectedNetworkId) stop("diverged", "probe_network_mismatch", "/probeSubject/networkId");

    const preflight = decodeCore("preflight-result", env.preflight, "/preflight");
    preflightArtifactDigest = preflight.artifactDigest;
    preflightStatus = preflight.status;
    const snapshot = decodeCore("capability-snapshot", env.capabilitySnapshot, "/capabilitySnapshot");
    const manifest = decodeCore("resolver-manifest", env.resolverManifest, "/resolverManifest");
    if (!verifyCapabilitySnapshot(snapshot, { resolver: manifest, networkId: env.selectedNetworkId })) {
      stop("diverged", "capability_snapshot_context_mismatch", "/capabilitySnapshot");
    }
    if (!verifyPreflightResult(preflight, { resolver: manifest, capabilitySnapshot: snapshot })) {
      stop("diverged", "preflight_context_mismatch", "/preflight");
    }
    if (preflight.request.networkId !== env.selectedNetworkId) stop("diverged", "preflight_binding_mismatch", "/preflight/request/networkId");
    if (preflight.network.networkId !== env.selectedNetworkId) stop("diverged", "preflight_binding_mismatch", "/preflight/network/networkId");
    if (preflight.capabilitySnapshot?.digest !== snapshot.artifactDigest) {
      stop("diverged", "preflight_binding_mismatch", "/preflight/capabilitySnapshot");
    }
    if (preflight.resolver.digest !== manifest.digest) stop("diverged", "preflight_binding_mismatch", "/preflight/resolver/digest");

    const args = argumentsOf(options);
    if (args !== undefined) {
      if (args.selectedNetworkId !== env.selectedNetworkId) stop("diverged", "request_binding_mismatch", "/selectedNetworkId");
      const probe = args.probeSubject;
      if (!isRecord(probe) || Object.keys(probe).length !== 3 || probe.type !== env.probe.type ||
          probe.networkId !== env.probe.networkId || probe.txId !== env.probe.txId) {
        stop("diverged", "request_binding_mismatch", "/probeSubject");
      }
      let sent: string;
      try {
        sent = encodeNecWireJson("preflight-request", decodeNecWireJson("preflight-request", JSON.stringify(args.request)));
      } catch {
        return stop("diverged", "request_binding_mismatch", "/preflight/request");
      }
      if (sent !== encodeNecWireJson("preflight-request", preflight.request)) {
        stop("diverged", "request_binding_mismatch", "/preflight/request");
      }
    }
    return report("verified", "envelope_verified");
  } catch (error) {
    if (error instanceof Halt) return report(error.status, error.reason, error.pointer);
    return report("not_reproducible", "harness_error");
  }
}

// ---------------------------------------------------------------------------
// Optional CLI over a capture-hosted.ts output file (the exports above stay pure)
//
//   tsx examples/hosted-reproduction/verify-live-before.ts --capture capture.json
// ---------------------------------------------------------------------------

/**
 * Exit 0 needs a verified report for each of these capture call ids, from its
 * own tool. An errored call (even an expected source_failure) is no BEFORE evidence.
 * Reports bind to CAPTURE_CALLS' fixed arguments for the id, never the capture's own.
 */
const REQUIRED_VERIFIED_CALLS: Readonly<Record<string, string>> = Object.freeze({
  "discover-mainnet": "discover_live_network_evidence",
  "discover-three-candidates": "discover_live_network_evidence",
  "preflight-base-mainnet-probe": "preflight_live_network_evidence",
});

/**
 * A separate exit condition: the verified Discovery report(s) of this call id must
 * bind exactly one candidate per Core class. It never changes a report's status.
 */
const CLASS_COVERAGE_CALL = "discover-three-candidates";
const CLASS_COVERAGE_REQUIRED: readonly string[] = Object.freeze(["conditional", "eligible", "ineligible"]);

export async function main(argv: readonly string[]): Promise<number> {
  const { readFileSync } = await import("node:fs");
  const { assessCaptureOutcomes, CAPTURE_CALLS } = await import("./capture-hosted.js");
  const index = argv.indexOf("--capture");
  const path = index === -1 ? undefined : argv[index + 1];
  if (path === undefined) throw new Error("--capture <capture.json> is required");
  const capture = JSON.parse(readFileSync(path, "utf8")) as {
    acquiringExecutable?: unknown;
    calls?: { id: string; tool: string; arguments: unknown; isError: boolean; structuredContent: unknown; content?: unknown }[];
  };
  const calls = capture.calls ?? [];
  const outcomes = assessCaptureOutcomes(calls);
  const reports: { id: string; report: LiveDiscoveryReport | LivePreflightReport }[] = [];
  const verifiedCalls = new Set<string>();
  const observedClasses: { networkId: string; classification: string }[] = [];
  for (const call of calls) {
    if (call.isError) continue;
    // An unknown id is already an unexpected outcome; it keeps its own arguments.
    const expected = CAPTURE_CALLS.find((c) => c.id === call.id)?.arguments ?? call.arguments;
    let report: LiveDiscoveryReport | LivePreflightReport;
    if (call.tool === "discover_live_network_evidence") {
      const discovery = verifyLiveDiscoveryEnvelope(call.structuredContent, { expected });
      // Bound candidates exist only in a verified report.
      if (call.id === CLASS_COVERAGE_CALL) {
        for (const c of discovery.candidates) observedClasses.push({ networkId: c.networkId, classification: c.classification });
      }
      report = discovery;
    } else if (call.tool === "preflight_live_network_evidence") {
      report = verifyLivePreflightEnvelope(call.structuredContent, { expected });
    } else {
      continue;
    }
    reports.push({ id: call.id, report });
    if (report.status === "verified") verifiedCalls.add(`${call.id} ${call.tool}`);
  }
  const missingVerified = Object.entries(REQUIRED_VERIFIED_CALLS)
    .filter(([id, tool]) => !verifiedCalls.has(`${id} ${tool}`)).map(([id]) => id);
  const classCoverage = {
    callId: CLASS_COVERAGE_CALL,
    required: [...CLASS_COVERAGE_REQUIRED],
    observed: observedClasses,
    met: JSON.stringify(observedClasses.map((c) => c.classification).sort()) === JSON.stringify(CLASS_COVERAGE_REQUIRED),
  };
  process.stdout.write(`${JSON.stringify({
    schema: "ne-hosted-before-verification-report/v0.1",
    acquiringExecutable: capture.acquiringExecutable ?? null,
    outcomes,
    reports,
    missingVerified,
    classCoverage,
  }, null, 2)}\n`);
  return outcomes.length > 0 && outcomes.every((o) => o.expected) && reports.every((r) => r.report.status === "verified") &&
    missingVerified.length === 0 && classCoverage.met ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`verify-live-before: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(2);
    },
  );
}
