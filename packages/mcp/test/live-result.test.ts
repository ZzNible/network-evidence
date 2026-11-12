/**
 * NE-L003: pure server-pinned full-action composer (G1 option A, owner-ratified).
 *
 * Offline replay only. Recorded Base mainnet and Solana mainnet RPC bytes are
 * served by a fake provider that refuses undeclared destinations; global
 * fetch throws and is counted. Date is frozen at explicit instants, so every
 * artifact and digest is reproducible under replay.
 *
 * The pre-execution ordering is never invented from an AFTER:
 *  - EVM: the hosted preflight probes an EARLIER completed Base transaction
 *    (F1 x402 #1062, block 2026-01-31) at 2026-10-09T15:00:00.000Z, before the
 *    subject block (2026-10-09T15:24:33.000Z); AFTER is read at the subject
 *    fixture's recorded acquisition time.
 *  - Solana: only one mainnet transaction is recorded, so the pre-execution
 *    probe is SIMULATED as the source answering null for the not-yet-existing
 *    signature (getTransaction null, signature status [null]) at
 *    2026-05-10T20:00:00.000Z, before its block (2026-05-10T20:29:19.000Z). The
 *    recorded transaction bytes are never served before their block time.
 * Server-clock ordering is a rejection check only; nothing here proves
 * precedence, policy satisfaction, settlement or finality.
 */
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeEvidencePolicyDigest, computeEvidenceRequestDigest, decodeNecWireJson, encodeNecWireJson,
  verifyNetworkEvidenceResult,
} from "@nec/core";
import type {
  CapabilitySnapshot, EvidencePolicy, EvidenceRequest, NecWireType, PolicyDimension, PreflightRequest,
  PreflightResult,
} from "@nec/core";
import { evmBeforeResolverManifest, replayTransactionAcquisition } from "@nec/resolver-evm";
import {
  BASE_MAINNET_OPSTACK_BEFORE_PROFILE, evaluateOpStackFinality, replayOpStackFinalityObservation,
} from "@nec/resolver-opstack";
import { deriveSolanaBeforePreflightResult, solanaBeforeResolverManifest } from "@nec/resolver-solana";
import { foundationFromObservation } from "../src/live-before.js";
import { createMultichainTool } from "../src/live-multichain.js";
import type { MultichainObservation, MultichainTool, TransactionSubject } from "../src/live-multichain.js";
import { createLivePreflightTool } from "../src/live-preflight.js";
import type { LivePreflightOutput } from "../src/live-preflight.js";
import {
  composeNetworkEvidenceResult, EVIDENCE_CONTEXT_MAX_BYTES, prepareEvidenceContext,
} from "../src/live-result.js";
import type { ComposedEvidenceResult, EvidenceResultOutcome, PreparedEvidenceContext } from "../src/live-result.js";

interface Capture { rpcMethod: string; rpcParams: unknown[]; resultJson: string }
const json = (path: string): any => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const subjectRaw = json("./fixtures/base-mainnet-l2-finalized-positive-evm.json");
const opStackRaw = json("./fixtures/base-mainnet-l2-finalized-positive-opstack.json");
const probeRaw = json(
  "../../../examples/historical-compat/authority/fixtures/F1-x402-1062-partial/source/network-evidence/fixtures/base-mainnet-x402-1062-usdc-transfer.fixture.json");
const solRaw = json("../../resolver-solana/test/fixtures/solana-mainnet-x402-real.json");

const BASE = "eip155:8453" as const;
const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" as const;
const EVM_SUBJECT: TransactionSubject = { type: "transaction", networkId: BASE, txId: subjectRaw.subject.txHash };
const EVM_PROBE: TransactionSubject = { type: "transaction", networkId: BASE, txId: probeRaw.subject.txHash };
const SOL_SUBJECT: TransactionSubject = { type: "transaction", networkId: SOL, txId: solRaw.subject.signature };

const EVM_PREFLIGHT_AT = "2026-10-09T15:00:00.000Z";
const EVM_BLOCK_AT = "2026-10-09T15:24:33.000Z"; // block timestamp 0x6ac90731
const EVM_AFTER_AT = "2026-10-09T15:42:11.665Z"; // recorded acquisition time of the subject fixture
const SOL_PREFLIGHT_AT = "2026-05-10T20:00:00.000Z";
const SOL_BLOCK_AT = "2026-05-10T20:29:19.000Z"; // blockTime 1778444959
const SOL_AFTER_AT = "2026-08-26T20:01:41.884Z"; // recorded acquisition time of the Solana fixture

const NO_PREFLIGHT = "MCP_EVIDENCE_CONTEXT_NO_PREFLIGHT";
const INVALID = "MCP_EVIDENCE_CONTEXT_INVALID";
const CALLER_MANIFEST = "MCP_EVIDENCE_CONTEXT_CALLER_MANIFEST";

/**
 * Offline replay. Base: exact recorded resultJson per method+params of the
 * subject and the earlier probe fixtures. Options are SIMULATED negatives:
 * - nullSubjectReceipt: receipt and transaction answers for the SUBJECT are null.
 * - solanaBeforeExecution: the source does not know the signature yet
 *   (getTransaction/getBlock null, getSignatureStatuses value [null]).
 */
function fakeProvider(options: { nullSubjectReceipt?: boolean; solanaBeforeExecution?: boolean } = {}) {
  const methods: string[] = [];
  const baseCaptures = [...(subjectRaw.captures as Capture[]), ...(probeRaw.captures as Capture[])];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const query = JSON.parse(init?.body as string) as { id: number; method: string; params?: unknown[] };
    methods.push(query.method);
    let resultText: string;
    if (url.includes("mainnet.base.org")) {
      const params = JSON.stringify(query.params ?? []);
      const found = baseCaptures.find(c => c.rpcMethod === query.method && JSON.stringify(c.rpcParams) === params);
      if (!found) throw new Error("undeclared Base read");
      resultText = found.resultJson;
      if (options.nullSubjectReceipt && params.includes(EVM_SUBJECT.txId) &&
          (query.method === "eth_getTransactionReceipt" || query.method === "eth_getTransactionByHash")) resultText = "null";
    } else if (url.includes("api.mainnet-beta.solana.com")) {
      const found = (solRaw.captures as Capture[]).find(c => c.rpcMethod === query.method);
      if (!found) throw new Error("undeclared Solana read");
      let result: unknown = JSON.parse(found.resultJson);
      if (options.solanaBeforeExecution) {
        if (query.method === "getTransaction" || query.method === "getBlock") result = null;
        if (query.method === "getSignatureStatuses") (result as { value: unknown[] }).value = [null];
      }
      resultText = JSON.stringify(result);
    } else throw new Error("undeclared destination");
    const response = new Response(`{"jsonrpc":"2.0","id":${JSON.stringify(query.id)},"result":${resultText}}`,
      { status: 200, headers: { "content-type": "application/json" } });
    Object.defineProperty(response, "url", { value: new URL(url).href });
    return response;
  };
  return { fetchFn, methods };
}

const realFetch = globalThis.fetch;
let globalFetchCalls = 0;
beforeAll(() => {
  globalThis.fetch = (async () => {
    globalFetchCalls += 1;
    throw new Error("network I/O is forbidden in live-result tests");
  }) as typeof fetch;
});
afterAll(() => { globalThis.fetch = realFetch; });
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); });
afterEach(() => { vi.useRealTimers(); });

function at(iso: string): void {
  vi.setSystemTime(new Date(iso));
}
function wire(type: NecWireType, value: unknown): Record<string, unknown> {
  return JSON.parse(encodeNecWireJson(type, value)) as Record<string, unknown>;
}
function policyOf(content: Omit<EvidencePolicy, "digest">): EvidencePolicy {
  return { ...content, digest: computeEvidencePolicyDigest(content) };
}
/** Another valid, correctly digested policy: same content, version "2". */
function nextVersion(policy: EvidencePolicy): EvidencePolicy {
  const { digest: _digest, ...content } = policy;
  return policyOf({ ...content, version: "2" });
}
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}
const EVM_ACTION = { kind: "evm.transaction", target: "0x4200000000000000000000000000000000000015", fields: { expectedStatus: "success" } };
const SOL_ACTION = { kind: "spl_token.transfer_checked", target: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", fields: { expectedAmount: "5000" } };

function preflightRequest(networkId: string, required: PolicyDimension[], desired: PolicyDimension[] = []): PreflightRequest {
  return {
    schemaVersion: "0.1", requestId: "ne-l003-preflight", networkId,
    action: networkId === BASE ? EVM_ACTION : SOL_ACTION,
    evidencePolicy: policyOf({ id: "ne-l003-policy", version: "1", requiredDimensions: required, desiredDimensions: desired }),
  };
}
/** The later EvidenceRequest: subject now exists; action/policy come from the preflighted request. */
function evidenceRequestFor(subject: TransactionSubject, preflight: PreflightResult): EvidenceRequest {
  return {
    schemaVersion: "0.1", requestId: "ne-l003-result", networkId: subject.networkId,
    subject: { type: "transaction", networkId: subject.networkId, txId: subject.txId },
    action: preflight.request.action,
    evidencePolicy: preflight.request.evidencePolicy,
    preflight: { requestId: preflight.request.requestId, digest: preflight.artifactDigest },
  };
}
function callerContext(subject: TransactionSubject, preflight: Record<string, unknown>, capabilitySnapshot: Record<string, unknown>) {
  const decoded = decodeNecWireJson("preflight-result", JSON.stringify(preflight));
  return { request: wire("evidence-request", evidenceRequestFor(subject, decoded)), preflight, capabilitySnapshot };
}

/** Hosted preflight on Base: probes the EARLIER completed F1 transaction. */
async function hostedEvmPreflight(
  preflightAt: string, required: PolicyDimension[], desired: PolicyDimension[],
): Promise<LivePreflightOutput> {
  at(preflightAt);
  const provider = fakeProvider();
  return createLivePreflightTool(createMultichainTool(provider.fetchFn))({
    selectedNetworkId: BASE, probeSubject: EVM_PROBE, request: preflightRequest(BASE, required, desired),
  });
}

/** SIMULATED pre-execution Solana probe: the source does not know the signature yet. */
async function solanaPreflight(preflightAt: string): Promise<{ preflight: PreflightResult; capabilitySnapshot: CapabilitySnapshot }> {
  at(preflightAt);
  const provider = fakeProvider({ solanaBeforeExecution: true });
  const probe = await createMultichainTool(provider.fetchFn)({ subject: SOL_SUBJECT });
  expect(probe.acquisition).toMatchObject({ transactionObserved: false, blockObserved: false });
  const source = foundationFromObservation(probe);
  if (source.family !== "solana") throw new Error("expected the Solana BEFORE foundation");
  return {
    preflight: deriveSolanaBeforePreflightResult(source.foundation, preflightRequest(SOL, ["execution", "finality"])),
    capabilitySnapshot: source.foundation.snapshot,
  };
}

/** P3 ordering: the context is prepared BEFORE the first RPC read, composed after. */
async function hostedAfter(resolve: MultichainTool, subject: TransactionSubject, raw: unknown):
  Promise<{ observation: MultichainObservation; outcome: EvidenceResultOutcome }> {
  const ctx = prepareEvidenceContext(subject, raw);
  const observation = await resolve({ subject });
  return { observation, outcome: composeNetworkEvidenceResult(observation, ctx) };
}

async function evmFlow(
  preflightAt = EVM_PREFLIGHT_AT,
  required: PolicyDimension[] = ["execution", "dataBinding"],
  desired: PolicyDimension[] = ["observedEffects", "finality"],
) {
  const out = await hostedEvmPreflight(preflightAt, required, desired);
  const raw = callerContext(EVM_SUBJECT, out.preflight, out.capabilitySnapshot);
  at(EVM_AFTER_AT);
  const provider = fakeProvider();
  const flow = await hostedAfter(createMultichainTool(provider.fetchFn), EVM_SUBJECT, raw);
  return { out, raw, ...flow, methods: provider.methods };
}

async function solanaFlow() {
  const { preflight, capabilitySnapshot } = await solanaPreflight(SOL_PREFLIGHT_AT);
  const raw = callerContext(SOL_SUBJECT, wire("preflight-result", preflight), wire("capability-snapshot", capabilitySnapshot));
  at(SOL_AFTER_AT);
  const provider = fakeProvider();
  const flow = await hostedAfter(createMultichainTool(provider.fetchFn), SOL_SUBJECT, raw);
  return { preflight, capabilitySnapshot, raw, ...flow, methods: provider.methods };
}

function composed(outcome: EvidenceResultOutcome): ComposedEvidenceResult {
  if (outcome.status !== "composed") throw new Error(`expected a composed result, got not_composed: ${outcome.reason}`);
  return outcome;
}
function decodeComposed(out: ComposedEvidenceResult) {
  return {
    result: decodeNecWireJson("network-evidence-result", JSON.stringify(out.result)),
    snapshot: decodeNecWireJson("evidence-snapshot", JSON.stringify(out.evidenceSnapshot)),
    manifest: decodeNecWireJson("resolver-manifest", JSON.stringify(out.resolverManifest)),
  };
}
function fragmentOf(observation: MultichainObservation) {
  return decodeNecWireJson("network-evidence-fragment", JSON.stringify(observation.fragment));
}

describe("server-pinned full-action composer: positives under replay", () => {
  it("EVM: hosted preflight before the block + hosted AFTER compose a Core-verified result, byte-identical on replay", async () => {
    expect(subjectRaw.acquiredAt).toBe(EVM_AFTER_AT);
    const first = await evmFlow();
    const second = await evmFlow();
    const outcome = composed(first.outcome);
    // Pinned under replay: two independent tool instances at the same instants.
    expect(JSON.stringify(second.outcome)).toBe(JSON.stringify(first.outcome));
    expect(first.methods).toEqual(["eth_chainId", "eth_getTransactionReceipt", "eth_getBlockByHash", "eth_getTransactionByHash"]);
    expect(outcome).toMatchObject({
      status: "composed", artifactType: "network-evidence-result", preExecutionBinding: "core_preflight_continuity",
    });

    const preflight = decodeNecWireJson("preflight-result", JSON.stringify(first.out.preflight));
    const capabilitySnapshot = decodeNecWireJson("capability-snapshot", JSON.stringify(first.out.capabilitySnapshot));
    const request = decodeNecWireJson("evidence-request", JSON.stringify(first.raw.request));
    const fragment = fragmentOf(first.observation);
    expect(preflight.status).toBe("ready");
    expect(preflight.generatedAt).toBe(EVM_PREFLIGHT_AT);
    expect(fragment.network.observedAt.timestamp).toBe(EVM_BLOCK_AT);
    expect(Date.parse(preflight.generatedAt)).toBeLessThan(Date.parse(EVM_BLOCK_AT));

    const { result, snapshot, manifest } = decodeComposed(outcome);
    const pinned = evmBeforeResolverManifest();
    expect(manifest).toEqual(pinned);
    expect(result.resolver).toEqual({ id: "resolver-evm-generic", version: "0.1.0", digest: pinned.digest });
    expect(result.request).toEqual({ requestId: "ne-l003-result", digest: computeEvidenceRequestDigest(request) });
    expect(request.preflight).toEqual({ requestId: "ne-l003-preflight", digest: preflight.artifactDigest });
    expect(result.policy).toEqual({ id: "ne-l003-policy", version: "1", digest: request.evidencePolicy.digest });
    expect(result.action).toEqual(EVM_ACTION);
    expect(result.generatedAt).toBe(EVM_AFTER_AT);
    expect(result.snapshot).toEqual({ id: snapshot.id, digest: snapshot.digest });
    expect(snapshot.createdAt).toBe(EVM_AFTER_AT);
    expect(snapshot.resolverManifestDigest).toBe(pinned.digest);
    expect(snapshot.policyDigest).toBe(request.evidencePolicy.digest);
    expect(snapshot.networkFingerprint).toEqual(fragment.network);
    expect(snapshot.evidence).toEqual(fragment.evidence);
    expect(snapshot.anchors).toEqual([{
      networkId: BASE, blockNumber: fragment.network.observedAt.blockNumber,
      blockId: fragment.network.observedAt.blockId, timestamp: EVM_BLOCK_AT, role: "subject_block",
    }]);

    // Verbatim from the fragment.
    expect(result.network).toEqual(fragment.network);
    expect(result.subject).toEqual(fragment.subject);
    expect(result.networkEvidence.execution).toEqual(fragment.networkEvidence.execution);
    expect(result.networkEvidence.execution.verdict).toBe("supported");
    expect(result.networkEvidence.dataBinding).toEqual(fragment.networkEvidence.dataBinding);
    expect(result.networkEvidence.observedEffects).toEqual(fragment.networkEvidence.observedEffects);
    expect(result.evidence).toEqual(fragment.evidence);
    expect(result.conflicts).toEqual(fragment.conflicts);
    expect(result.warnings).toEqual(fragment.warnings);

    // G1 option A: the omitted dimensions cite the fragment's own warning.
    const notEvaluated = fragment.warnings.find(w => w.code === "EVM_DIMENSIONS_NOT_EVALUATED");
    expect(notEvaluated).toBeDefined();
    for (const name of ["settlement", "finality"] as const) {
      expect(fragment.networkEvidence).not.toHaveProperty(name);
      expect(result.networkEvidence[name]).toEqual({
        applicability: "unknown", basis: [], evidence: [], reason: `EVM_DIMENSIONS_NOT_EVALUATED: ${notEvaluated!.message}`,
      });
    }

    // Independent Core verification with the complete context, and a swapped one.
    const context = {
      policy: request.evidencePolicy, snapshot, resolver: pinned, request, preflight,
      preflightContext: { resolver: pinned, capabilitySnapshot },
    };
    expect(verifyNetworkEvidenceResult(result, context)).toBe(true);
    expect(verifyNetworkEvidenceResult(result, { ...context, request: { ...request, action: { ...request.action, fields: { expectedStatus: "reverted" } } } })).toBe(false);
    expect(verifyNetworkEvidenceResult(result, { ...context, policy: nextVersion(request.evidencePolicy) })).toBe(false);

    expect(outcome.nonClaims.join(" ")).toMatch(/Continuity is not precedence/);
    expect(outcome.nonClaims.join(" ")).toMatch(/not policy satisfaction/);
    expect(JSON.stringify(outcome)).not.toContain("mainnet.base.org");
    expect(globalFetchCalls).toBe(0);
  });

  it("Solana: SIMULATED pre-execution probe + recorded AFTER compose a Core-verified result, byte-identical on replay", async () => {
    expect(solRaw.acquiredAt).toBe(SOL_AFTER_AT);
    const first = await solanaFlow();
    const second = await solanaFlow();
    const outcome = composed(first.outcome);
    expect(JSON.stringify(second.outcome)).toBe(JSON.stringify(first.outcome));
    expect(first.methods).toEqual(["getGenesisHash", "getTransaction", "getSignatureStatuses", "getBlock"]);

    // An undetermined readiness still fixes the expected action and policy before execution.
    expect(first.preflight.status).toBe("unknown");
    expect(first.preflight.generatedAt).toBe(SOL_PREFLIGHT_AT);
    const fragment = fragmentOf(first.observation);
    expect(fragment.network.observedAt.timestamp).toBe(SOL_BLOCK_AT);

    const { result, snapshot, manifest } = decodeComposed(outcome);
    const pinned = solanaBeforeResolverManifest();
    const request = decodeNecWireJson("evidence-request", JSON.stringify(first.raw.request));
    expect(manifest).toEqual(pinned);
    expect(result.resolver).toEqual({ id: "resolver-solana-before", version: "0.1.0", digest: pinned.digest });
    expect(result.request).toEqual({ requestId: "ne-l003-result", digest: computeEvidenceRequestDigest(request) });
    expect(result.action).toEqual(SOL_ACTION);
    expect(result.generatedAt).toBe(SOL_AFTER_AT);
    expect(snapshot.createdAt).toBe(SOL_AFTER_AT);
    expect(snapshot.resolverManifestDigest).toBe(pinned.digest);
    expect(snapshot.policyDigest).toBe(request.evidencePolicy.digest);
    expect(snapshot.anchors).toEqual([{
      networkId: SOL, blockNumber: fragment.network.observedAt.blockNumber,
      blockId: fragment.network.observedAt.blockId, timestamp: SOL_BLOCK_AT, role: "subject_block",
    }]);

    expect(result.networkEvidence.execution).toEqual(fragment.networkEvidence.execution);
    expect(result.networkEvidence.dataBinding).toEqual(fragment.networkEvidence.dataBinding);
    expect(result.networkEvidence.finality).toEqual(fragment.networkEvidence.finality);
    expect(result.networkEvidence.finality.verdict).toBe("supported");
    expect(result.networkEvidence.observedEffects).toEqual(fragment.networkEvidence.observedEffects);
    expect(result.networkEvidence.observedEffects.length).toBeGreaterThan(0);
    expect(result.evidence).toEqual(fragment.evidence);
    expect(result.conflicts).toEqual(fragment.conflicts);
    expect(result.warnings).toEqual(fragment.warnings);

    const notEvaluated = fragment.warnings.find(w => w.code === "SOLANA_SETTLEMENT_NOT_EVALUATED");
    expect(notEvaluated).toBeDefined();
    expect(fragment.networkEvidence).not.toHaveProperty("settlement");
    expect(result.networkEvidence.settlement).toEqual({
      applicability: "unknown", basis: [], evidence: [], reason: `SOLANA_SETTLEMENT_NOT_EVALUATED: ${notEvaluated!.message}`,
    });

    const context = {
      policy: request.evidencePolicy, snapshot, resolver: pinned, request, preflight: first.preflight,
      preflightContext: { resolver: pinned, capabilitySnapshot: first.capabilitySnapshot },
    };
    expect(verifyNetworkEvidenceResult(result, context)).toBe(true);
    expect(verifyNetworkEvidenceResult(result, { ...context, resolver: evmBeforeResolverManifest() })).toBe(false);
    expect(globalFetchCalls).toBe(0);
  });

  it("G1 option A: a policy-REQUIRED unevaluated dimension is composed as unknown, never refused and never satisfied", async () => {
    const flow = await evmFlow(EVM_PREFLIGHT_AT, ["execution", "settlement", "finality"], []);
    const preflight = decodeNecWireJson("preflight-result", JSON.stringify(flow.out.preflight));
    expect(preflight.status).toBe("blocked");
    expect(preflight.evidenceReadiness.settlement.status).toBe("not_applicable");
    const { result } = decodeComposed(composed(flow.outcome));
    expect(result.policy.digest).toBe(preflight.request.evidencePolicy.digest);
    for (const name of ["settlement", "finality"] as const) {
      expect(result.networkEvidence[name]).toMatchObject({ applicability: "unknown", basis: [], evidence: [] });
      expect(result.networkEvidence[name]).not.toHaveProperty("verdict");
      expect(result.networkEvidence[name].reason).toMatch(/^EVM_DIMENSIONS_NOT_EVALUATED: /);
    }
    expect(composed(flow.outcome).nonClaims.join(" ")).toMatch(/not policy satisfaction/);
  });
});

describe("server-pinned full-action composer: not_composed and never-merged", () => {
  it("null receipt (SIMULATED) -> not_composed transaction_not_observed", async () => {
    const out = await hostedEvmPreflight(EVM_PREFLIGHT_AT, ["execution"], []);
    const raw = callerContext(EVM_SUBJECT, out.preflight, out.capabilitySnapshot);
    at(EVM_AFTER_AT);
    const provider = fakeProvider({ nullSubjectReceipt: true });
    const { outcome } = await hostedAfter(createMultichainTool(provider.fetchFn), EVM_SUBJECT, raw);
    expect(outcome).toEqual({ status: "not_composed", reason: "transaction_not_observed" });
    expect(provider.methods).toEqual(["eth_chainId", "eth_getTransactionReceipt", "eth_getTransactionByHash"]);
  });

  it("preflight dated at or after the block -> not_composed preflight_not_before_block", async () => {
    for (const preflightAt of [EVM_AFTER_AT, EVM_BLOCK_AT]) {
      const flow = await evmFlow(preflightAt);
      const preflight = decodeNecWireJson("preflight-result", JSON.stringify(flow.out.preflight));
      expect(preflight.generatedAt).toBe(preflightAt);
      expect(flow.outcome).toEqual({ status: "not_composed", reason: "preflight_not_before_block" });
    }
  });

  it("SIMULATED envelope mutations: block not observed, inconsistent, no timestamp, output budget", async () => {
    const out = await hostedEvmPreflight(EVM_PREFLIGHT_AT, ["execution"], []);
    const ctx = prepareEvidenceContext(EVM_SUBJECT, callerContext(EVM_SUBJECT, out.preflight, out.capabilitySnapshot));
    at(EVM_AFTER_AT);
    const good = await createMultichainTool(fakeProvider().fetchFn)({ subject: EVM_SUBJECT });
    expect(composeNetworkEvidenceResult(good, ctx).status).toBe("composed");
    const noTimestamp = JSON.parse(JSON.stringify(good.fragment));
    delete noTimestamp.network.observedAt.timestamp;
    const cases: Array<[MultichainObservation, string]> = [
      [{ ...good, acquisition: { ...good.acquisition, blockObserved: false } }, "block_not_observed"],
      [{ ...good, acquisition: { ...good.acquisition, consistent: false } }, "acquisition_inconsistent"],
      [{ ...good, fragment: noTimestamp }, "block_timestamp_absent"],
      [{ ...good, nonClaims: [...good.nonClaims, "x".repeat(450_000)] }, "output_budget"],
    ];
    for (const [observation, reason] of cases) {
      expect(composeNetworkEvidenceResult(observation, ctx)).toEqual({ status: "not_composed", reason });
    }
  });

  it("an injected OP Stack finality fragment is never used: same digests, finality stays unknown", async () => {
    const out = await hostedEvmPreflight(EVM_PREFLIGHT_AT, ["execution"], ["finality"]);
    const ctx = prepareEvidenceContext(EVM_SUBJECT, callerContext(EVM_SUBJECT, out.preflight, out.capabilitySnapshot));
    at(EVM_AFTER_AT);
    const observation = await createMultichainTool(fakeProvider().fetchFn)({ subject: EVM_SUBJECT });
    const opFragment = evaluateOpStackFinality({
      config: BASE_MAINNET_OPSTACK_BEFORE_PROFILE.config,
      evm: await replayTransactionAcquisition(subjectRaw, { includeTransaction: true }),
      finality: await replayOpStackFinalityObservation(opStackRaw),
    }).fragment;
    // Positive control: the injected fragment really asserts L2 finality for this subject.
    expect(opFragment.networkEvidence.finality?.verdict).toBe("supported");
    expect(opFragment.subject).toEqual(EVM_SUBJECT);
    const injected: MultichainObservation = {
      ...observation,
      opStackFinality: {
        ruleset: "opstack.rpc-finalized-head-v1", networkId: BASE, toolStatus: "evaluated",
        withdrawalFinalization: "not_evaluated", ethereumSettlement: "not_evaluated", maxAncestryDepth: 8,
        observedAt: EVM_AFTER_AT, fragment: wire("network-evidence-fragment", opFragment), captures: [], nonClaims: [],
      },
    };
    const plain = composed(composeNetworkEvidenceResult(observation, ctx));
    const withOp = composed(composeNetworkEvidenceResult(injected, ctx));
    expect(withOp.result).toEqual(plain.result);
    expect(withOp.evidenceSnapshot).toEqual(plain.evidenceSnapshot);
    const { result } = decodeComposed(withOp);
    expect(result.networkEvidence.finality).toMatchObject({ applicability: "unknown", basis: [], evidence: [] });
    expect(result.networkEvidence.finality).not.toHaveProperty("verdict");
    const fragmentIds = new Set(fragmentOf(observation).evidence.map(ref => ref.id));
    const foreign = opFragment.evidence.filter(ref => !fragmentIds.has(ref.id));
    expect(foreign.length).toBeGreaterThan(0);
    const resultIds = new Set(result.evidence.map(ref => ref.id));
    for (const ref of foreign) expect(resultIds.has(ref.id)).toBe(false);
  });

  it("composes only contexts returned by prepareEvidenceContext, and only for the prepared subject", async () => {
    const out = await hostedEvmPreflight(EVM_PREFLIGHT_AT, ["execution"], []);
    const ctx = prepareEvidenceContext(EVM_SUBJECT, callerContext(EVM_SUBJECT, out.preflight, out.capabilitySnapshot));
    at(EVM_AFTER_AT);
    const resolve = createMultichainTool(fakeProvider().fetchFn);
    const observation = await resolve({ subject: EVM_SUBJECT });
    expect(composeNetworkEvidenceResult(observation, ctx).status).toBe("composed");
    const copy: PreparedEvidenceContext = { ...ctx };
    expect(thrownBy(() => composeNetworkEvidenceResult(observation, copy))).toMatchObject({ code: "MCP_RESULT_UNVERIFIED" });
    const other = await resolve({ subject: EVM_PROBE });
    expect(thrownBy(() => composeNetworkEvidenceResult(other, ctx))).toMatchObject({ code: "MCP_RESULT_UNVERIFIED" });
  });
});

describe("evidenceContext is rejected before any RPC read", () => {
  it("missing preflight, efda0ca-shaped, swapped, substituted, caller manifest: zero fetches", async () => {
    const outA = await hostedEvmPreflight(EVM_PREFLIGHT_AT, ["execution", "dataBinding"], []);
    // A second GENUINE preflight for the same preflight request, probed earlier.
    const outB = await hostedEvmPreflight("2026-10-09T14:00:00.000Z", ["execution", "dataBinding"], []);
    const good = callerContext(EVM_SUBJECT, outA.preflight, outA.capabilitySnapshot);
    const goodRequest = good.request as Record<string, any>;
    const { preflight: _ref, ...requestWithoutPreflight } = goodRequest;
    const solana = await solanaPreflight(SOL_PREFLIGHT_AT);

    // efda0ca-shaped: an AFTER-only request with no preflight whose policy is dated after the block.
    const efdaPolicy = policyOf({
      id: "efda0ca-shaped-policy", version: "2026-10-26", requiredDimensions: ["execution", "observedEffects"],
      rules: { authoredAt: "2026-10-26T00:00:00.000Z" },
    });
    expect(Date.parse("2026-10-26T00:00:00.000Z")).toBeGreaterThan(Date.parse(EVM_BLOCK_AT));
    const efdaRequest: EvidenceRequest = {
      schemaVersion: "0.1", requestId: "efda0ca-shaped", networkId: BASE,
      subject: { type: "transaction", networkId: BASE, txId: EVM_SUBJECT.txId },
      action: EVM_ACTION, evidencePolicy: efdaPolicy,
    };
    const efda = { request: wire("evidence-request", efdaRequest) };
    const preflightA = decodeNecWireJson("preflight-result", JSON.stringify(outA.preflight));
    const v2 = nextVersion(preflightA.request.evidencePolicy);
    const otherSubjectRequest = wire("evidence-request", evidenceRequestFor(EVM_PROBE, preflightA));

    at(EVM_AFTER_AT);
    const provider = fakeProvider();
    const resolve = createMultichainTool(provider.fetchFn);
    const cases: Array<[string, TransactionSubject, unknown, string]> = [
      ["request.preflight absent", EVM_SUBJECT, { ...good, request: requestWithoutPreflight }, NO_PREFLIGHT],
      ["preflight artifact absent", EVM_SUBJECT, { request: good.request, capabilitySnapshot: good.capabilitySnapshot }, NO_PREFLIGHT],
      ["efda0ca-shaped context", EVM_SUBJECT, efda, NO_PREFLIGHT],
      ["efda0ca-shaped context with a snapshot", EVM_SUBJECT, { ...efda, capabilitySnapshot: good.capabilitySnapshot }, NO_PREFLIGHT],
      ["swapped action", EVM_SUBJECT, { ...good, request: { ...goodRequest, action: { ...EVM_ACTION, fields: { expectedStatus: "reverted" } } } }, INVALID],
      ["zeroed policy digest", EVM_SUBJECT, { ...good, request: { ...goodRequest, evidencePolicy: { ...goodRequest.evidencePolicy, digest: `sha256:${"0".repeat(64)}` } } }, INVALID],
      ["swapped policy (re-digested v2)", EVM_SUBJECT, { ...good, request: { ...goodRequest, evidencePolicy: v2 } }, INVALID],
      ["substituted preflight", EVM_SUBJECT, { ...good, preflight: outB.preflight, capabilitySnapshot: outB.capabilitySnapshot }, INVALID],
      ["snapshot of another probe", EVM_SUBJECT, { ...good, capabilitySnapshot: outB.capabilitySnapshot }, INVALID],
      ["forged preflight artifactDigest", EVM_SUBJECT, { ...good, preflight: { ...outA.preflight, artifactDigest: `sha256:${"0".repeat(64)}` } }, INVALID],
      ["caller resolverManifest key", EVM_SUBJECT, { ...good, resolverManifest: outA.resolverManifest }, CALLER_MANIFEST],
      ["caller manifest key", EVM_SUBJECT, { ...good, manifest: outA.resolverManifest }, CALLER_MANIFEST],
      ["unknown key", EVM_SUBJECT, { ...good, note: "x" }, INVALID],
      ["request subject differs", EVM_SUBJECT, { ...good, request: otherSubjectRequest }, INVALID],
      ["other-family subject", SOL_SUBJECT, good, INVALID],
      ["EVM preflight under the pinned Solana manifest", SOL_SUBJECT, {
        request: wire("evidence-request", evidenceRequestFor(SOL_SUBJECT, preflightA)),
        preflight: outA.preflight, capabilitySnapshot: outA.capabilitySnapshot,
      }, INVALID],
      ["Solana preflight for an EVM subject", EVM_SUBJECT, {
        request: good.request,
        preflight: wire("preflight-result", solana.preflight), capabilitySnapshot: wire("capability-snapshot", solana.capabilitySnapshot),
      }, INVALID],
      ["oversized context", EVM_SUBJECT, { ...good, request: { ...goodRequest, metadata: { padding: "x".repeat(EVIDENCE_CONTEXT_MAX_BYTES) } } }, "MCP_EVIDENCE_CONTEXT_TOO_LARGE"],
      ["not an object", EVM_SUBJECT, "context", INVALID],
    ];
    for (const [label, subject, raw, code] of cases) {
      await expect(hostedAfter(resolve, subject, raw), label).rejects.toMatchObject({ code });
    }
    expect(provider.methods).toEqual([]);
    expect(globalFetchCalls).toBe(0);

    // Positive control: the untouched context composes through the same flow.
    const { outcome } = await hostedAfter(resolve, EVM_SUBJECT, good);
    expect(outcome.status).toBe("composed");
  });
});
