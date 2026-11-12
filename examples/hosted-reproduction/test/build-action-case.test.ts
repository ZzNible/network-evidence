/**
 * build-action-case.ts: GT-02 step-9 tooling (examples-only; closes no gate
 * row; GT-02 stays OPEN).
 *
 * Every capture here is produced by captureAction against a LOOPBACK
 * hosted-mode server (startNeMcpHttpServer, SIMULATED public Host header,
 * test-only helper) whose live tools read a fake provider serving checked-in
 * real Base mainnet capture bytes (the subject 0x71c9…625c and the earlier
 * F1 x402 #1062 probe) and nothing else. Global fetch throws and is counted.
 *
 * Clock: SIMULATED_REPLAY_CLOCK, same pinned times as capture-action.test.ts.
 * Only Date is faked, and only while the captures are produced: the preflight
 * runs at 2026-10-09T15:00:00.000Z (before the subject block, 15:24:33Z), the
 * resolve at 2026-10-09T15:42:11.665Z. The preflight request is TEST-AUTHORED,
 * not an original caller's action; nothing here is a genuine pre-execution fix
 * (fixedBeforeExecution "false" everywhere).
 *
 * Cases labelled SIMULATED edit a copy of a loopback capture (a rebuilt
 * settlement verdict with consistent Core digests; a relabelled target to
 * exercise the non-loopback label). No request is made for them, and a
 * relabelled capture is not a hosted capture.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  buildNetworkEvidenceResult, computeEvidencePolicyDigest, decodeNecWireJson, encodeNecWireJson, verifyNetworkEvidenceResult,
} from "@nec/core";
import type {
  EvidencePolicy, EvidenceRequest, NetworkEvidenceBuildContext, NetworkEvidenceResultContent, PolicyDimension,
} from "@nec/core";
import { normalizeNetworkEvidenceV01 } from "@nec/hub";
import {
  buildLensCaseFromHubV01, projectLensBrowserSafeV01, serializeLensBrowserSafeV01, serializeLensCaseV01, validateLensBrowserSafeCaseV01,
} from "@nec/lens";
import { createMultichainTool, startNeMcpHttpServer } from "@nec/mcp";
import { evmBeforeResolverManifest, exchangeIdentityKey } from "@nec/resolver-evm";

import { simulatedHostFetch } from "../../../packages/mcp/test/helpers.js";
import { validateNeMapsCollectionV01 } from "../../ne-maps/collection.js";
import {
  ACTION_CASE_BUILD_SCHEMA, ANCHOR_ACCEPTANCE, COMPOSITION_RULE, CONTINUITY_LIMITATION, GATE_ROW, HOSTED_LABEL, LOOPBACK_LABEL,
  main as buildMain, parseActionCaseArgs,
} from "../build-action-case.js";
import { captureAction, writeActionCapture } from "../capture-action.js";
import type { ActionCapture } from "../capture-action.js";
import { EVIDENCE_RESULT_NON_CLAIMS, evaluateEvidenceResultCapture, main as verifyMain } from "../verify-evidence-result.js";

/** Counts Hub admissions made through the public @nec/hub entry point (the builder's and this file's). */
const hubCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock("@nec/hub", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@nec/hub")>();
  return {
    ...actual,
    normalizeNetworkEvidenceV01: (input: Parameters<typeof actual.normalizeNetworkEvidenceV01>[0]) => {
      hubCalls.count += 1;
      return actual.normalizeNetworkEvidenceV01(input);
    },
  };
});

interface Capture { rpcMethod: string; rpcParams: unknown[]; resultJson: string }
const load = (path: string): any => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const subjectRaw = load("../../../packages/mcp/test/fixtures/base-mainnet-l2-finalized-positive-evm.json");
const opStackRaw = load("../../../packages/mcp/test/fixtures/base-mainnet-l2-finalized-positive-opstack.json");
const probeRaw = load(
  "../../historical-compat/authority/fixtures/F1-x402-1062-partial/source/network-evidence/fixtures/base-mainnet-x402-1062-usdc-transfer.fixture.json");

const ORIGIN = "https://mcp.example.org";
const HOST = "mcp.example.org";
const BASE = "eip155:8453";
const EVM_SUBJECT = { type: "transaction", networkId: BASE, txId: subjectRaw.subject.txHash as string };
const EVM_PROBE = { type: "transaction", networkId: BASE, txId: probeRaw.subject.txHash as string };

const PREFLIGHT_AT = "2026-10-09T15:00:00.000Z";
const LATE_PREFLIGHT_AT = "2026-10-09T15:30:00.000Z";
const BLOCK_AT = "2026-10-09T15:24:33.000Z";
const AFTER_AT = "2026-10-09T15:42:11.665Z";
/** The label of every BEFORE in this file; none is a genuine pre-execution fix. */
const SIMULATED_REPLAY_CLOCK = Object.freeze({
  clock: "SIMULATED_REPLAY_CLOCK", preflightAt: PREFLIGHT_AT, resolveAt: AFTER_AT, fixedBeforeExecution: false,
} as const);

/** Lens construction time, given on the command line; never a clock read. */
const CREATED_AT = "2026-11-02T00:00:00.000Z";
const CASE_ID = "ne-l043-loopback-action-case";

/** Test-authored private strings that must never reach the built collection. */
const ACCOUNT = `0x${"acc0de57".repeat(5)}`;
const PREFLIGHT_NOTE = "ne-l043-private-preflight-note-3b7e";
const RESULT_NOTE = "ne-l043-private-result-note-c25a";
const PREFLIGHT_REQUEST_ID = "ne-l043-caller-preflight";
const RESULT_REQUEST_ID = "ne-l043-caller-result";
const ACQUIRING_SHA = "a".repeat(40);

const EVM_ACTION = { kind: "evm.transaction", target: "0x4200000000000000000000000000000000000015", fields: { expectedStatus: "success" } };
function policyOf(content: Omit<EvidencePolicy, "digest">): EvidencePolicy {
  return { ...content, digest: computeEvidencePolicyDigest(content) };
}
const POLICY = policyOf({
  id: "ne-l043-policy", version: "1",
  requiredDimensions: ["execution", "dataBinding"] as PolicyDimension[], desiredDimensions: ["observedEffects", "finality"] as PolicyDimension[],
});

/** TEST-AUTHORED caller request file: {selectedNetworkId, probeSubject, request}. */
function preflightArguments(): Record<string, unknown> {
  return {
    selectedNetworkId: BASE, probeSubject: { ...EVM_PROBE },
    request: {
      schemaVersion: "0.1", requestId: PREFLIGHT_REQUEST_ID, networkId: BASE, account: ACCOUNT,
      action: EVM_ACTION, evidencePolicy: POLICY, metadata: { callerNote: PREFLIGHT_NOTE },
    },
  };
}

/** GT-02 step 6 shape (TEST-AUTHORED): the EvidenceRequest over the captured preflight and snapshot. */
function contextFrom(capture: ActionCapture): Record<string, any> {
  const env = capture.call.structuredContent as { preflight: Record<string, unknown>; capabilitySnapshot: Record<string, unknown> };
  const decoded = decodeNecWireJson("preflight-result", JSON.stringify(env.preflight));
  const request: EvidenceRequest = {
    schemaVersion: "0.1", requestId: RESULT_REQUEST_ID, networkId: BASE,
    subject: { type: "transaction", networkId: BASE, txId: EVM_SUBJECT.txId },
    action: decoded.request.action, evidencePolicy: decoded.request.evidencePolicy,
    preflight: { requestId: decoded.request.requestId, digest: decoded.artifactDigest },
    metadata: { callerNote: RESULT_NOTE },
  };
  return {
    request: JSON.parse(encodeNecWireJson("evidence-request", request)) as unknown,
    preflight: env.preflight,
    capabilitySnapshot: env.capabilitySnapshot,
  };
}

/** Exact-lookup fake provider over the checked-in Base captures; anything else throws. */
function provider(): typeof fetch {
  const queues = new Map<string, Capture[]>();
  for (const capture of [...subjectRaw.captures, ...opStackRaw.captures, ...probeRaw.captures] as Capture[]) {
    const key = exchangeIdentityKey(capture.rpcMethod, capture.rpcParams);
    queues.set(key, [...(queues.get(key) ?? []), capture]);
  }
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).href;
    if (url !== "https://mainnet.base.org/") throw new Error("undeclared destination");
    const query = JSON.parse(init?.body as string) as { id: number; method: string; params?: unknown[] };
    const capture = queues.get(exchangeIdentityKey(query.method, query.params ?? []))?.shift();
    if (capture === undefined) throw new Error("undeclared Base read");
    const response = new Response(`{"jsonrpc":"2.0","id":${JSON.stringify(query.id)},"result":${capture.resultJson}}`,
      { status: 200, headers: { "content-type": "application/json" } });
    Object.defineProperty(response, "url", { value: url });
    return response;
  };
}

/** One fresh hosted-mode loopback server per capture. */
async function withServer<T>(fn: (url: string, fetchFn: typeof fetch) => Promise<T>): Promise<T> {
  const server = await startNeMcpHttpServer({
    host: "127.0.0.1", port: 0, hosted: { publicOrigin: ORIGIN }, liveEvidence: createMultichainTool(provider()),
  });
  try {
    return await fn(`http://127.0.0.1:${server.port}/mcp`, simulatedHostFetch(server.port, HOST));
  } finally {
    await server.close();
  }
}

/**
 * SIMULATED: the served result rebuilt by Core with a settlement verdict and consistent
 * digests (as AT7 in verify-evidence-result.test.ts); Core accepts it, the gate must not.
 */
function rebuiltSettlementEnvelope(envelope: any, rawContext: any): { envelope: any; coreAccepts: boolean } {
  const manifest = evmBeforeResolverManifest();
  const result = decodeNecWireJson("network-evidence-result", JSON.stringify(envelope.evidenceResult.result));
  const snapshot = decodeNecWireJson("evidence-snapshot", JSON.stringify(envelope.evidenceResult.evidenceSnapshot));
  const request = decodeNecWireJson("evidence-request", JSON.stringify(rawContext.request));
  const preflight = decodeNecWireJson("preflight-result", JSON.stringify(rawContext.preflight));
  const capabilitySnapshot = decodeNecWireJson("capability-snapshot", JSON.stringify(rawContext.capabilitySnapshot));
  const context: NetworkEvidenceBuildContext = {
    policy: request.evidencePolicy, snapshot, resolver: manifest, request, preflight,
    preflightContext: { resolver: manifest, capabilitySnapshot },
  };
  const { request: _request, semanticDigest: _semantic, artifactDigest: _artifact, ...content } = result;
  const verdict = { applicability: "applicable", verdict: "supported", basis: ["source_observation"], evidence: [result.evidence[0]!.id] };
  const built = buildNetworkEvidenceResult({
    ...content,
    snapshot: { id: snapshot.id, digest: snapshot.digest },
    networkEvidence: { ...content.networkEvidence, settlement: verdict },
  } as unknown as NetworkEvidenceResultContent, context);
  const copy = JSON.parse(JSON.stringify(envelope));
  copy.evidenceResult.result = JSON.parse(encodeNecWireJson("network-evidence-result", built));
  return { envelope: copy, coreAccepts: verifyNetworkEvidenceResult(built, context) };
}

/** Core's exact resolver-evm-generic v0.1.0 data-binding proposition; the only source text Lens may display. */
const DATA_BINDING_PROPOSITION = "The acquired receipt binds to the requested subject transaction id.";
const ADMITTED_BINDING_CAVEAT =
  "Lens display caveat: this verdict covers only the exact proposition evaluated by resolver-evm-generic v0.1.0 for the requested subject transaction id; it is not the full requested action and does not establish transfer amount, accounts, calldata, authorization, policy satisfaction, settlement or finality.";
const ONE_SOURCE_CAVEAT =
  "Lens display caveat: every cited evidence reference is an evm_rpc observation from one source in one declared independence group; this is a single-source observation, not independent corroboration or consensus.";
const NO_CORROBORATION_CAVEAT =
  "Lens display caveat: independent corroboration across sources is not established for this assessment.";
const SUPPORTED_GENERIC_CAVEAT =
  "Lens display caveat: this data-binding verdict covers only the source resolver's specific evaluated proposition, not the full requested action, its terms or authorization.";
const WITHHELD_CAVEAT =
  "Lens display caveat: source resolver proposition metadata is not admitted for browser display and is withheld; this generic statement does not restate the evaluated proposition.";
const SUPPORTED_GENERIC_STATEMENT = "Network Evidence data-binding assessment of the source resolver's specific evaluated proposition.";
const EXACT_ACTION_GENERIC_STATEMENT = "Network Evidence data-binding assessment for the exact action.";
/** Test-authored private strings placed in Core-valid dimension metadata; must never reach a Lens output. */
const HOSTILE_SECRET = "ne-gt02-hostile-metadata-secret-9d41";
const HOSTILE_URL = "https://rpc.example/?key=NE-GT02-HOSTILE-KEY";

/**
 * SIMULATED: the loopback result rebuilt by Core with a replaced dataBinding dimension
 * (and optional extra conflicts), against the complete unchanged caller context.
 */
function coreRebuiltDataBinding(envelope: any, rawContext: any, dataBinding: Record<string, unknown>, extraConflicts: unknown[] = []) {
  const manifest = evmBeforeResolverManifest();
  const result = decodeNecWireJson("network-evidence-result", JSON.stringify(envelope.evidenceResult.result));
  const snapshot = decodeNecWireJson("evidence-snapshot", JSON.stringify(envelope.evidenceResult.evidenceSnapshot));
  const request = decodeNecWireJson("evidence-request", JSON.stringify(rawContext.request));
  const preflight = decodeNecWireJson("preflight-result", JSON.stringify(rawContext.preflight));
  const capabilitySnapshot = decodeNecWireJson("capability-snapshot", JSON.stringify(rawContext.capabilitySnapshot));
  const context: NetworkEvidenceBuildContext = {
    policy: request.evidencePolicy, snapshot, resolver: manifest, request, preflight,
    preflightContext: { resolver: manifest, capabilitySnapshot },
  };
  const { request: _request, semanticDigest: _semantic, artifactDigest: _artifact, ...content } = result;
  const build = () => buildNetworkEvidenceResult({
    ...content,
    snapshot: { id: snapshot.id, digest: snapshot.digest },
    networkEvidence: { ...content.networkEvidence, dataBinding },
    conflicts: [...content.conflicts, ...extraConflicts],
  } as unknown as NetworkEvidenceResultContent, context);
  return { original: result, context, build };
}

/** Generic public path for one Core result: Hub -> Lens case -> lens-browser/v0.1. */
function lensPathOf(result: any) {
  const hubRecord = normalizeNetworkEvidenceV01({ kind: "network_evidence_result", result });
  const lensCase = buildLensCaseFromHubV01({ hubRecord, caseId: CASE_ID, namespace: "nec.gt02.lens-scope", createdAt: CREATED_AT });
  const browser = projectLensBrowserSafeV01(lensCase);
  expect(() => validateLensBrowserSafeCaseV01(browser)).not.toThrow();
  const binding: any = browser.propositions.find((p) => p.propositionId === "network.dataBinding");
  expect(binding).toBeDefined();
  return {
    lensCase, browser, binding,
    caseText: serializeLensCaseV01(lensCase),
    browserText: serializeLensBrowserSafeV01(browser),
  };
}

async function stdoutOf<T>(fn: () => Promise<T>): Promise<{ value: T; text: string }> {
  const printed: string[] = [];
  const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    printed.push(String(chunk));
    return true;
  });
  try {
    const value = await fn();
    return { value, text: printed.join("") };
  } finally {
    write.mockRestore();
  }
}

async function verifyCli(argv: string[]): Promise<{ code: number; text: string; out: any }> {
  const { value, text } = await stdoutOf(() => verifyMain(argv));
  return { code: value, text, out: JSON.parse(text) };
}
async function buildCli(argv: string[]): Promise<{ code: number; text: string; out: any }> {
  const { value, text } = await stdoutOf(() => buildMain(argv));
  return { code: value, text, out: JSON.parse(text) };
}

const at = (iso: string): void => { vi.setSystemTime(new Date(iso)); };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const validateLens = (lens: unknown) => validateLensBrowserSafeCaseV01(lens);

const MAPS_COLLECTION = new URL("../../ne-maps/data/collection.json", import.meta.url);
const MAPS_COLLECTION_SHA = new URL("../../ne-maps/data/COLLECTION.sha256", import.meta.url);

const realFetch = globalThis.fetch;
let globalFetchCalls = 0;
let dir = "";
let outCount = 0;
const file = (name: string) => join(dir, name);
const freshOut = () => file(`case-${++outCount}.json`);
const caseArgs = (out: string) => ["--case-id", CASE_ID, "--created-at", CREATED_AT, "--out", out];
const fx: Record<string, any> = {};

beforeAll(async () => {
  fx.mapsCollectionBytes = readFileSync(MAPS_COLLECTION);
  fx.mapsCollectionShaBytes = readFileSync(MAPS_COLLECTION_SHA);
  dir = mkdtempSync(join(tmpdir(), "ne-action-case-"));
  globalThis.fetch = (async () => {
    globalFetchCalls += 1;
    throw new Error("global fetch is denied in build-action-case tests");
  }) as typeof fetch;
  // Only Date is faked, only while capturing; setTimeout, AbortSignal.timeout and HTTP stay real.
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    at(PREFLIGHT_AT);
    const preflight = await withServer((url, fetchFn) => captureAction({ mode: "preflight", url, request: preflightArguments(), fetch: fetchFn }));
    writeActionCapture(file("preflight-capture.json"), preflight);
    fx.preflightCapture = preflight;
    fx.context = contextFrom(preflight);
    fx.contextText = `${JSON.stringify(fx.context, null, 2)}\n`;
    writeFileSync(file("evidence-context.json"), fx.contextText);
    at(AFTER_AT);
    const resolve = await withServer((url, fetchFn) => captureAction({
      mode: "resolve", url, subject: { networkId: BASE, txId: EVM_SUBJECT.txId }, evidenceContext: fx.context, fetch: fetchFn,
    }));
    writeActionCapture(file("resolve-capture.json"), resolve);
    fx.resolveCapture = clone(resolve);

    // Negative: a preflight AFTER the block time, then the resolve.
    at(LATE_PREFLIGHT_AT);
    const late = await withServer((url, fetchFn) => captureAction({ mode: "preflight", url, request: preflightArguments(), fetch: fetchFn }));
    writeActionCapture(file("late-preflight-capture.json"), late);
    fx.lateContext = contextFrom(late);
    writeFileSync(file("late-context.json"), JSON.stringify(fx.lateContext));
    at(AFTER_AT);
    const lateResolve = await withServer((url, fetchFn) => captureAction({
      mode: "resolve", url, subject: { networkId: BASE, txId: EVM_SUBJECT.txId }, evidenceContext: fx.lateContext, fetch: fetchFn,
    }));
    writeActionCapture(file("late-resolve-capture.json"), lateResolve);
  } finally {
    vi.useRealTimers();
  }
  // One changed context value (same capture): context_digest_mismatch.
  const changed = clone(fx.context);
  changed.request.metadata.callerNote = `${RESULT_NOTE}x`;
  writeFileSync(file("context-changed.json"), JSON.stringify(changed, null, 2));
  // SIMULATED rebuilt-settlement result in a copy of the loopback resolve capture (context unchanged).
  const rebuilt = rebuiltSettlementEnvelope(fx.resolveCapture.call.structuredContent, fx.context);
  fx.rebuiltCoreAccepts = rebuilt.coreAccepts;
  const rebuiltCapture = clone(fx.resolveCapture);
  rebuiltCapture.call.structuredContent = rebuilt.envelope;
  writeFileSync(file("rebuilt-settlement-capture.json"), JSON.stringify(rebuiltCapture, null, 2));
  // SIMULATED relabels of the loopback capture (no request is made for them).
  const hosted = clone(fx.resolveCapture);
  hosted.target = "https://mcp.example.org/mcp";
  hosted.loopback = false;
  hosted.acquiringExecutable = { sha: ACQUIRING_SHA, declaredBy: "operator", verifiedByThisClient: false };
  fx.hostedRelabel = hosted;
  writeFileSync(file("relabelled-hosted-capture.json"), JSON.stringify(hosted, null, 2));
  const loopbackDeclaredFalse = clone(fx.resolveCapture);
  loopbackDeclaredFalse.loopback = false;
  writeFileSync(file("mismatch-loopback-false.json"), JSON.stringify(loopbackDeclaredFalse));
  const hostedDeclaredTrue = clone(hosted);
  hostedDeclaredTrue.loopback = true;
  writeFileSync(file("mismatch-hosted-true.json"), JSON.stringify(hostedDeclaredTrue));
}, 120_000);

afterAll(() => {
  globalThis.fetch = realFetch;
  if (dir !== "") rmSync(dir, { recursive: true, force: true });
});

describe("build-action-case (verified resolve action capture -> one generic NE Maps case; loopback only)", () => {
  const base = () => ["--capture", file("resolve-capture.json"), "--context", file("evidence-context.json")];

  it("fixtures: SIMULATED_REPLAY_CLOCK loopback captures; the verify CLI exits 0 on the positive inputs", async () => {
    expect(SIMULATED_REPLAY_CLOCK.fixedBeforeExecution).toBe(false);
    expect(Date.parse(PREFLIGHT_AT)).toBeLessThan(Date.parse(BLOCK_AT));
    expect(Date.parse(AFTER_AT)).toBeGreaterThan(Date.parse(BLOCK_AT));
    expect(fx.resolveCapture).toMatchObject({ mode: "resolve", loopback: true, acquiringExecutable: null });
    expect(new URL(fx.resolveCapture.target).hostname).toBe("127.0.0.1");
    expect(fx.resolveCapture.call.structuredContent.evidenceResult.status).toBe("composed");
    const run = await verifyCli([...base(), "--preflight-capture", file("preflight-capture.json")]);
    expect([run.code, run.out.exitReason]).toEqual([0, "composed_result_verified"]);
    expect(globalFetchCalls).toBe(0);
  });

  it("positive: exit 0; the output passes both validators; Core digests and dimensions are preserved, nothing is strengthened", async () => {
    const out = freshOut();
    const argv = [...base(), "--preflight-capture", file("preflight-capture.json")];
    hubCalls.count = 0;
    const run = await buildCli([...argv, ...caseArgs(out)]);
    expect(run.code).toBe(0);
    expect(run.out).toMatchObject({
      schema: ACTION_CASE_BUILD_SCHEMA, hosted: "loopback", exitCode: 0, exitReason: "composed_result_verified", written: true,
    });
    // The gate is the verify CLI's decision, verbatim.
    expect(run.out.verification).toEqual((await verifyCli(argv)).out);
    expect(hubCalls.count).toBe(1); // positive control for the no-Hub-call negatives

    const text = readFileSync(out, "utf8");
    const collection = JSON.parse(text);
    expect(validateNeMapsCollectionV01(collection, { validateLens: (lens) => validateLens(lens) })).toEqual(collection);
    expect(collection.cases).toHaveLength(1);
    const item = collection.cases[0];
    expect(() => validateLens(item.lens)).not.toThrow();
    expect(item.id).toBe(CASE_ID);
    expect([item.lens.caseId, item.lens.createdAt]).toEqual([CASE_ID, CREATED_AT]);

    const served = fx.resolveCapture.call.structuredContent.evidenceResult;
    const result = decodeNecWireJson("network-evidence-result", JSON.stringify(served.result));
    expect(item.lens.coreResultPreservation.sourceArtifactDigest).toBe(result.artifactDigest);
    expect(item.lens.coreResultPreservation.sourceSemanticDigest).toBe(result.semanticDigest);
    expect(item.lens.coreResultPreservation.subject).toEqual(EVM_SUBJECT);
    expect(item.exactAction).toMatchObject({ kind: "transaction", networkId: BASE, id: EVM_SUBJECT.txId, realityClass: LOOPBACK_LABEL });

    const byId = new Map<string, any>(item.lens.propositions.map((p: any) => [p.propositionId, p]));
    expect(result.networkEvidence.execution.verdict).toBeDefined();
    expect(byId.get("network.execution").assessments.map((a: any) => a.value)).toEqual([result.networkEvidence.execution.verdict]);
    // GT-02: Core evaluated exactly one narrow proposition for this resolver; Lens shows that
    // exact text (compared to a Lens constant, never copied from metadata) and nothing broader.
    // A supported data-binding verdict does not establish the whole requested action or authorization.
    expect(result.resolver).toMatchObject({ id: "resolver-evm-generic", version: "0.1.0" });
    const coreBinding = result.networkEvidence.dataBinding;
    expect(coreBinding.verdict).toBe("supported");
    expect(coreBinding.metadata).toEqual({ proposition: DATA_BINDING_PROPOSITION });
    const binding = byId.get("network.dataBinding");
    expect(binding.statement).toBe(DATA_BINDING_PROPOSITION);
    expect(binding.availability).toBe("available");
    expect(binding.assessments).toHaveLength(1);
    expect(binding.assessments[0]).toMatchObject({
      value: "supported", basis: [...coreBinding.basis], evidenceRefs: coreBinding.evidence.map((id) => `core-evidence:${id}`),
    });
    expect(binding).not.toHaveProperty("metadata");
    expect(binding.assessments[0]).not.toHaveProperty("metadata");
    // One-source caveat only because every cited ref is evm_rpc with one sourceId and one explicit group.
    const cited = coreBinding.evidence.map((id) => result.evidence.find((ref) => ref.id === id)!);
    expect(cited.length).toBeGreaterThan(0);
    for (const ref of cited) {
      expect(ref).toMatchObject({ sourceType: "evm_rpc", sourceId: cited[0]!.sourceId, independenceGroup: "base-public-rpc" });
    }
    expect(binding.limitations).toEqual([ADMITTED_BINDING_CAVEAT, ONE_SOURCE_CAVEAT]);
    expect(binding.limitations.join(" ")).toMatch(/not the full requested action.*authorization/i);
    expect(binding.assessments[0].limitations).toEqual(binding.limitations);
    // The source/group labels themselves are not exported by the caveat.
    expect(JSON.stringify(binding)).not.toContain(cited[0]!.sourceId);
    expect(JSON.stringify(binding)).not.toContain("base-public-rpc");
    for (const name of ["settlement", "finality"] as const) {
      const proposition = byId.get(`network.${name}`);
      expect(proposition.availability).toBe("unknown");
      expect(proposition.assessments).toEqual([]);
      expect(proposition.limitations).toHaveLength(1);
      expect(proposition.limitations[0]).toMatch(/^EVM_DIMENSIONS_NOT_EVALUATED: /);
      expect(proposition.limitations[0]).toBe(result.networkEvidence[name].reason);
    }
    // No edge, no reordering: relations stay empty, the trail is Lens's own order.
    expect(item.lens.relations).toEqual([]);
    expect(item.trailPropositionOrder).toEqual(item.lens.propositions.map((p: any) => p.propositionId));

    // Labels, provenance and non-claims.
    expect(item.lens.limitations).toContain(CONTINUITY_LIMITATION);
    expect(item.lens.limitations).toContain(LOOPBACK_LABEL);
    expect(item.lens.limitations).toContain(GATE_ROW);
    expect(text).not.toContain(HOSTED_LABEL);
    const provenance = item.extensions.provenance;
    expect(provenance).toMatchObject({
      hosted: LOOPBACK_LABEL,
      acquiringExecutable: "null",
      contextSha256: fx.resolveCapture.call.contextSha256,
      resultArtifactDigest: result.artifactDigest,
      fixedBeforeExecution: "false",
      anchorAcceptance: ANCHOR_ACCEPTANCE,
      compositionRule: COMPOSITION_RULE,
      gateRow: GATE_ROW,
    });
    expect(JSON.parse(provenance.anchor)).toEqual({ status: "not_anchored", reason: "no_authorization_used_log" });
    expect(provenance.fixedBeforeExecution).toBe(String(run.out.verification.report.fixedBeforeExecution));
    expect(collection.nonClaims.slice(-EVIDENCE_RESULT_NON_CLAIMS.length)).toEqual([...EVIDENCE_RESULT_NON_CLAIMS]);
    expect(collection.TARGET_CORE_MUTATIONS).toBe(0);

    // No strengthening.
    expect(text).not.toMatch(/fixedBeforeExecution"\s*:\s*(true|"true")/);
    for (const key of ["caseVerdict", "confidence", "trustScore", "score", "policyDecision", "rank", "ranking"]) {
      expect([key, text.includes(key)]).toEqual([key, false]);
    }
    expect(globalFetchCalls).toBe(0);
  });

  it("privacy: the output carries none of the context's account, request/preflight metadata or requestId strings", async () => {
    const outs = [freshOut(), freshOut()];
    expect((await buildCli([...base(), ...caseArgs(outs[0]!)])).code).toBe(0);
    expect((await buildCli(["--capture", file("relabelled-hosted-capture.json"), "--context", file("evidence-context.json"),
      ...caseArgs(outs[1]!)])).code).toBe(0);
    const preflight = decodeNecWireJson("preflight-result", JSON.stringify(fx.context.preflight));
    const privateStrings = [ACCOUNT, PREFLIGHT_NOTE, RESULT_NOTE, PREFLIGHT_REQUEST_ID, RESULT_REQUEST_ID, preflight.artifactDigest];
    for (const out of outs) {
      const text = readFileSync(out, "utf8");
      for (const secret of privateStrings) {
        expect([secret, fx.contextText.includes(secret)]).toEqual([secret, true]); // positive control
        expect([secret, text.includes(secret)]).toEqual([secret, false]);
      }
      // The capture target (a URL path could carry a secret) is never copied.
      expect(text).not.toContain("/mcp");
    }
    expect(globalFetchCalls).toBe(0);
  });

  it("gate parity: every non-zero verify exitReason exits 1 with the identical exitReason and writes no --out", async () => {
    const cases: [string, string[]][] = [
      ["capture_invalid", ["--capture", file("preflight-capture.json"), "--context", file("evidence-context.json")]],
      ["context_digest_mismatch", ["--capture", file("resolve-capture.json"), "--context", file("context-changed.json")]],
      ["not_verified", ["--capture", file("late-resolve-capture.json"), "--context", file("late-context.json")]],
      ["preflight_capture_invalid", [...base(), "--preflight-capture", file("resolve-capture.json")]],
      ["preflight_capture_unbound", [...base(), "--preflight-capture", file("late-preflight-capture.json")]],
      ["not_anchored", [...base(), "--require-anchored"]],
    ];
    for (const [reason, argv] of cases) {
      const verify = await verifyCli(argv);
      expect([reason, verify.code, verify.out.exitReason]).toEqual([reason, 1, reason]);
      const out = freshOut();
      hubCalls.count = 0;
      const build = await buildCli([...argv, ...caseArgs(out)]);
      expect([reason, build.code, build.out.exitReason, build.out.written, build.out.hosted]).toEqual([reason, 1, reason, false, null]);
      expect(build.out.verification).toEqual(verify.out);
      expect([reason, existsSync(out), hubCalls.count]).toEqual([reason, false, 0]);
    }
    expect(globalFetchCalls).toBe(0);
  });

  it("SIMULATED rebuilt-settlement result: Core accepts it, the gate refuses it (dimension_not_supported_by_fragment), no Hub call", async () => {
    expect(fx.rebuiltCoreAccepts).toBe(true);
    const argv = ["--capture", file("rebuilt-settlement-capture.json"), "--context", file("evidence-context.json")];
    const verify = await verifyCli(argv);
    const out = freshOut();
    hubCalls.count = 0;
    const build = await buildCli([...argv, ...caseArgs(out)]);
    expect([build.code, build.out.exitReason, build.out.written]).toEqual([1, "not_verified", false]);
    expect(build.out.verification).toEqual(verify.out);
    expect(build.out.verification.report).toMatchObject({
      status: "diverged", reason: "dimension_not_supported_by_fragment",
      firstDiffPointer: "/evidenceResult/result/networkEvidence/settlement", fixedBeforeExecution: false,
    });
    expect([existsSync(out), hubCalls.count]).toEqual([false, 0]);
    expect(globalFetchCalls).toBe(0);
  });

  it("Lens dataBinding scope (SIMULATED Core-valid rebuilds): verdicts copied unchanged; hostile metadata never exported; Core's ambiguous-conflict guard holds", () => {
    const envelope = fx.resolveCapture.call.structuredContent;
    const original = decodeNecWireJson("network-evidence-result", JSON.stringify(envelope.evidenceResult.result));
    const coreBinding = original.networkEvidence.dataBinding;
    expect(coreBinding.metadata).toEqual({ proposition: DATA_BINDING_PROPOSITION });
    const verified = (dataBinding: Record<string, unknown>, conflicts: unknown[] = []) => {
      const variant = coreRebuiltDataBinding(envelope, fx.context, dataBinding, conflicts);
      const built = variant.build();
      expect(verifyNetworkEvidenceResult(built, variant.context)).toBe(true);
      return built;
    };
    const expectPreserved = (built: any, path: ReturnType<typeof lensPathOf>) => {
      expect(path.browser.coreResultPreservation?.sourceArtifactDigest).toBe(built.artifactDigest);
      expect(path.browser.coreResultPreservation?.sourceSemanticDigest).toBe(built.semanticDigest);
      const dim = built.networkEvidence.dataBinding;
      expect(path.binding.assessments).toHaveLength(1);
      expect(path.binding.assessments[0]).toMatchObject({
        value: dim.verdict, basis: [...dim.basis], evidenceRefs: dim.evidence.map((id: string) => `core-evidence:${id}`),
      });
      expect(path.binding.assessments[0].limitations).toEqual(path.binding.limitations);
      // Execution is untouched by every dataBinding variant.
      const execution: any = path.browser.propositions.find((p) => p.propositionId === "network.execution");
      expect(execution.assessments.map((a: any) => a.value)).toEqual([built.networkEvidence.execution.verdict]);
    };

    // Positive control: an identical rebuild reproduces the served Core digests and the admitted row.
    const same = verified({ ...coreBinding });
    expect([same.artifactDigest, same.semanticDigest]).toEqual([original.artifactDigest, original.semanticDigest]);
    const samePath = lensPathOf(same);
    expect(samePath.binding.statement).toBe(DATA_BINDING_PROPOSITION);
    expect(samePath.binding.limitations).toEqual([ADMITTED_BINDING_CAVEAT, ONE_SOURCE_CAVEAT]);
    expectPreserved(same, samePath);

    // Other admitted verdicts keep Core's value. Same single cited source -> one-source caveat;
    // no cited EvidenceRef at all -> independent corroboration explicitly not established.
    const contradicted = verified({ ...coreBinding, verdict: "contradicted" });
    const contradictedPath = lensPathOf(contradicted);
    expect(contradictedPath.binding.statement).toBe(DATA_BINDING_PROPOSITION);
    expect(contradictedPath.binding.assessments[0].value).toBe("contradicted");
    expect(contradictedPath.binding.limitations).toEqual([ADMITTED_BINDING_CAVEAT, ONE_SOURCE_CAVEAT]);
    expectPreserved(contradicted, contradictedPath);
    const reason = "Subject binding is not established for this acquisition; nothing can be bound to the requested subject.";
    const insufficient = verified({
      applicability: "applicable", verdict: "insufficient", basis: [], evidence: [], reason, metadata: { proposition: DATA_BINDING_PROPOSITION },
    });
    const insufficientPath = lensPathOf(insufficient);
    expect(insufficientPath.binding.statement).toBe(DATA_BINDING_PROPOSITION);
    expect(insufficientPath.binding.assessments[0].value).toBe("insufficient");
    expect(insufficientPath.binding.limitations).toEqual([reason, ADMITTED_BINDING_CAVEAT, NO_CORROBORATION_CAVEAT]);
    expectPreserved(insufficient, insufficientPath);

    // Hostile metadata: Core accepts and carries it; Lens keeps the prior generic statement,
    // adds the withheld-source caveat, and no metadata value reaches the Lens case or browser bytes.
    for (const metadata of [
      { proposition: DATA_BINDING_PROPOSITION, callerNote: HOSTILE_SECRET, endpoint: HOSTILE_URL },
      { proposition: `${DATA_BINDING_PROPOSITION} ${HOSTILE_SECRET}` },
      { proposition: `${DATA_BINDING_PROPOSITION} ` },
      { proposition: HOSTILE_URL },
      { note: HOSTILE_SECRET },
    ]) {
      const hostile = verified({ ...coreBinding, metadata });
      expect(hostile.networkEvidence.dataBinding.metadata).toEqual(metadata); // positive control: Core carried it
      const path = lensPathOf(hostile);
      expect([JSON.stringify(metadata), path.binding.statement]).toEqual([JSON.stringify(metadata), SUPPORTED_GENERIC_STATEMENT]);
      expect(path.binding.limitations).toEqual([SUPPORTED_GENERIC_CAVEAT, WITHHELD_CAVEAT]);
      expectPreserved(hostile, path);
      for (const text of [path.caseText, path.browserText]) {
        for (const secret of [HOSTILE_SECRET, HOSTILE_URL, "NE-GT02-HOSTILE-KEY", DATA_BINDING_PROPOSITION]) {
          expect([secret, text.includes(secret)]).toEqual([secret, false]);
        }
      }
    }

    // Core's ambiguous-conflict guard: a material dataBinding conflict refuses "supported"
    // and requires "ambiguous"; Lens admits no source text for an ambiguous row.
    const conflict = {
      id: "lens-gt02-test-conflict:data-binding", code: "LENS_GT02_TEST_CONFLICT",
      description: "SIMULATED test-authored material data-binding conflict.",
      scope: { kind: "dimension", dimension: "dataBinding" }, evidence: [coreBinding.evidence[0]], material: true,
    };
    expect(() => coreRebuiltDataBinding(envelope, fx.context, { ...coreBinding }, [conflict]).build()).toThrow();
    const ambiguous = verified({ ...coreBinding, verdict: "ambiguous" }, [conflict]);
    const ambiguousPath = lensPathOf(ambiguous);
    expect(ambiguousPath.binding.statement).toBe(EXACT_ACTION_GENERIC_STATEMENT);
    expect(ambiguousPath.binding.assessments[0].value).toBe("ambiguous");
    expect(ambiguousPath.binding.limitations).toEqual([WITHHELD_CAVEAT]);
    expect(ambiguousPath.browser.coreResultPreservation?.conflictIds).toContain(conflict.id);
    expect(ambiguousPath.browserText).not.toContain(DATA_BINDING_PROPOSITION);
    expectPreserved(ambiguous, ambiguousPath);
    expect(globalFetchCalls).toBe(0);
  });

  it("labels: loopback is re-derived from capture.target; a mismatch is refused; a non-loopback target gets the operator-declared label", async () => {
    for (const name of ["mismatch-loopback-false.json", "mismatch-hosted-true.json"]) {
      const out = freshOut();
      hubCalls.count = 0;
      const run = await buildCli(["--capture", file(name), "--context", file("evidence-context.json"), ...caseArgs(out)]);
      expect([name, run.code, run.out.exitReason, run.out.verification.exitReason]).toEqual([name, 1, "loopback_label_mismatch", "composed_result_verified"]);
      expect([name, existsSync(out), hubCalls.count]).toEqual([name, false, 0]);
    }
    // SIMULATED relabel: not a hosted capture; only the label path is exercised.
    const out = freshOut();
    const run = await buildCli(["--capture", file("relabelled-hosted-capture.json"), "--context", file("evidence-context.json"), ...caseArgs(out)]);
    expect([run.code, run.out.hosted]).toEqual([0, "operator_declared_hosted"]);
    const text = readFileSync(out, "utf8");
    const item = JSON.parse(text).cases[0];
    expect(item.lens.limitations).toContain(HOSTED_LABEL);
    expect(item.lens.limitations).toContain(CONTINUITY_LIMITATION);
    expect(text).not.toContain(LOOPBACK_LABEL);
    expect(item.extensions.provenance.hosted).toBe(HOSTED_LABEL);
    expect(item.extensions.provenance.acquiringExecutable).toBe(JSON.stringify(fx.hostedRelabel.acquiringExecutable));
    expect(item.extensions.provenance.fixedBeforeExecution).toBe("false");
    expect(HOSTED_LABEL).toBe(
      "operator-declared hosted capture; acquiringExecutable declaredBy operator, verifiedByThisClient false; a non-loopback URL is not evidence of an authentic hosted server");
    expect(LOOPBACK_LABEL).toBe("loopback replay (SIMULATED host), not a hosted observation");
    expect(globalFetchCalls).toBe(0);
  });

  it("determinism: two runs give byte-identical output; global fetch is never called; the Date spy is not hit", async () => {
    const outs = [freshOut(), freshOut()];
    const texts: string[] = [];
    const RealDate = globalThis.Date;
    let clockReads = 0;
    globalThis.Date = new Proxy(RealDate, {
      construct(target, args, newTarget) {
        if (args.length === 0) clockReads += 1;
        return Reflect.construct(target, args, newTarget) as object;
      },
      apply(target, thisArg, args) {
        clockReads += 1;
        return Reflect.apply(target, thisArg, args) as unknown;
      },
      get(target, key, receiver) {
        if (key === "now") return () => { clockReads += 1; return target.now(); };
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    try {
      for (const out of outs) {
        const run = await buildCli([...base(), "--preflight-capture", file("preflight-capture.json"), ...caseArgs(out)]);
        expect(run.code).toBe(0);
        texts.push(run.text);
      }
    } finally {
      globalThis.Date = RealDate;
    }
    expect(clockReads).toBe(0);
    expect(texts[1]).toBe(texts[0]);
    expect(readFileSync(outs[1]!, "utf8")).toBe(readFileSync(outs[0]!, "utf8"));
    expect(globalFetchCalls).toBe(0);
  });

  it("arguments: --case-id and --created-at are required; an existing --out is refused before any read or verification", async () => {
    const files = ["--capture", "c.json", "--context", "x.json"];
    expect(() => parseActionCaseArgs([...files, "--created-at", CREATED_AT, "--out", "o.json"])).toThrow("--case-id");
    expect(() => parseActionCaseArgs([...files, "--case-id", CASE_ID, "--out", "o.json"])).toThrow("--created-at");
    expect(() => parseActionCaseArgs([...files, "--case-id", CASE_ID, "--created-at", CREATED_AT])).toThrow("--out");
    expect(() => parseActionCaseArgs([...files, ...caseArgs("o.json").map((v) => (v === CASE_ID ? "Bad_Id" : v))])).toThrow("--case-id");
    expect(() => parseActionCaseArgs([...files, ...caseArgs("o.json").map((v) => (v === CREATED_AT ? "2026-11-02" : v))])).toThrow("--created-at");
    expect(() => parseActionCaseArgs([...files, ...caseArgs("o.json"), "--url", "https://mcp.example.org/mcp"])).toThrow("unknown argument");
    expect(parseActionCaseArgs([...files, ...caseArgs("o.json")])).toEqual({
      capture: "c.json", context: "x.json", preflightCapture: undefined, requireAnchored: false,
      caseId: CASE_ID, createdAt: CREATED_AT, out: "o.json",
    });
    // Existing --out: refused even though the capture path does not exist (nothing was read).
    writeFileSync(file("existing.json"), "SENTINEL\n");
    hubCalls.count = 0;
    await expect(buildMain(["--capture", file("missing-capture.json"), "--context", file("missing-context.json"),
      ...caseArgs(file("existing.json"))])).rejects.toThrow("already exists");
    expect(readFileSync(file("existing.json"), "utf8")).toBe("SENTINEL\n");
    expect(hubCalls.count).toBe(0);
    expect(globalFetchCalls).toBe(0);
  });

  it("evaluateEvidenceResultCapture loads the preflight capture lazily, only after the capture and contextSha256 checks", async () => {
    let loads = 0;
    const loadPreflightCapture = () => { loads += 1; return clone(fx.preflightCapture); };
    const changed = JSON.parse(readFileSync(file("context-changed.json"), "utf8"));
    const invalid = await evaluateEvidenceResultCapture({
      capture: clone(fx.preflightCapture), context: clone(fx.context), loadPreflightCapture, requireAnchored: false,
    });
    const mismatch = await evaluateEvidenceResultCapture({
      capture: clone(fx.resolveCapture), context: changed, loadPreflightCapture, requireAnchored: false,
    });
    expect([invalid.exitReason, mismatch.exitReason, loads]).toEqual(["capture_invalid", "context_digest_mismatch", 0]);
    const verified = await evaluateEvidenceResultCapture({
      capture: clone(fx.resolveCapture), context: clone(fx.context), loadPreflightCapture, requireAnchored: false,
    });
    expect([verified.exitReason, loads]).toEqual(["composed_result_verified", 1]);
    // Same decision as the CLI on the same files.
    expect(JSON.parse(JSON.stringify(verified))).toEqual(
      (await verifyCli([...base(), "--preflight-capture", file("preflight-capture.json")])).out);
    expect(globalFetchCalls).toBe(0);
  });

  it("Hub still refuses the AFTER fragment alone", () => {
    expect(() => normalizeNetworkEvidenceV01({
      kind: "nec_wire_json_v1", wireType: "network-evidence-result", wire: JSON.stringify(fx.resolveCapture.call.structuredContent.fragment),
    })).toThrow();
  });

  it("static: imports only node built-ins, @nec/core, @nec/hub, @nec/lens and the two allowed siblings; family-agnostic", () => {
    const source = readFileSync(new URL("../build-action-case.ts", import.meta.url), "utf8");
    const specifiers = [...source.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)"/g)].map((m) => m[1]!);
    expect(specifiers.length).toBeGreaterThan(4);
    const allowed = new Set(["@nec/core", "@nec/hub", "@nec/lens", "./verify-evidence-result.js", "../ne-maps/collection.js"]);
    for (const specifier of specifiers) {
      expect([specifier, specifier.startsWith("node:") || allowed.has(specifier)]).toEqual([specifier, true]);
    }
    expect(source).not.toMatch(/\bimport\s*\(/);
    expect(source).not.toMatch(/\brequire\s*\(/);
    for (const banned of ["packages/mcp", "@nec/mcp", "@modelcontextprotocol", "capture-hosted", "capture-action"]) {
      expect([banned, source.includes(banned)]).toEqual([banned, false]);
    }
    expect(source).not.toMatch(/capture-[a-z-]*\.js/);
    expect(source).not.toMatch(/eip155/i);
    expect(source).not.toMatch(/solana/i);
  });

  it("README: the Action case builder section and GT-02 step 9; no gate row closed; GT-02 stays OPEN", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const sequenceStart = readme.indexOf("### GT-02 operator sequence");
    const sequenceEnd = readme.indexOf("## Capture client", sequenceStart);
    expect(sequenceStart).toBeGreaterThan(0);
    const sequence = readme.slice(sequenceStart, sequenceEnd).replace(/\s+/g, " ");
    const step9 = sequence.slice(sequence.indexOf("9. "), sequence.indexOf("10. "));
    expect(step9).toContain("tsx examples/hosted-reproduction/build-action-case.ts --capture");
    expect(step9).toContain("HUMAN GATE");
    const start = readme.indexOf("## Action case builder");
    expect(start).toBeGreaterThan(sequenceEnd);
    const section = readme.slice(start).replace(/\s+/g, " ");
    for (const phrase of [
      "tsx examples/hosted-reproduction/build-action-case.ts --capture",
      "closes no gate row", "GT-02 stays OPEN.", "Q2/Q3", "private by default", "HUMAN GATE",
      CONTINUITY_LIMITATION, LOOPBACK_LABEL,
    ]) expect([phrase, section.includes(phrase)]).toEqual([phrase, true]);
  });

  it("isolation: the shipped NE Maps collection.json and COLLECTION.sha256 bytes are unchanged", () => {
    expect(readFileSync(MAPS_COLLECTION).equals(fx.mapsCollectionBytes)).toBe(true);
    expect(readFileSync(MAPS_COLLECTION_SHA).equals(fx.mapsCollectionShaBytes)).toBe(true);
  });
});
