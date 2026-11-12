/**
 * verify-evidence-result.ts (examples-only; closes no gate row; GT-02 stays OPEN).
 *
 * Envelopes come from a LOOPBACK hosted-mode server (startNeMcpHttpServer,
 * SIMULATED public Host header, test-only helper) whose live tools read a fake
 * provider serving checked-in real capture bytes for the fixed origins only;
 * anything else throws. Only Date is faked. Fixtures and instants are those of
 * packages/mcp/test/live-result-tool.test.ts.
 *
 * Every BEFORE in this file is SIMULATED_REPLAY_CLOCK, fixedBeforeExecution:false:
 *  - EVM: the hosted preflight probes the EARLIER completed F1 x402 #1062 Base
 *    transaction at a pinned 2026-10-09T15:00:00.000Z, before the subject block
 *    (2026-10-09T15:24:33.000Z); the AFTER is read at 2026-10-09T15:42:11.665Z.
 *  - Solana: a SIMULATED null pre-execution probe at 2026-05-10T20:00:00.000Z.
 * None of them is a genuine caller action fixed before execution. The
 * efda0ca-shaped AFTER-only context is never verified and never a BEFORE.
 *
 * Negatives labelled SIMULATED edit ONE value of a copy of a real envelope or
 * context, or rebuild ONE result/snapshot field with consistent Core digests.
 * The transaction_not_observed case serves a SIMULATED null receipt (as in
 * reproduce.test.ts). Global fetch throws and is counted; no live network call is made.
 */
import { readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  buildEvidenceSnapshot, buildNetworkEvidenceResult, computeEvidencePolicyDigest, decodeNecWireJson, encodeNecWireJson,
  verifyNetworkEvidenceResult,
} from "@nec/core";
import type {
  EvidencePolicy, EvidenceRequest, EvidenceSnapshot, NecWireType, NetworkEvidenceBuildContext, NetworkEvidenceResultContent,
  PolicyDimension, PreflightRequest, PreflightResult, ResolverManifest,
} from "@nec/core";
import { createMultichainTool, LIVE_MULTICHAIN_TOOL, LIVE_PREFLIGHT_TOOL_NAME, startNeMcpHttpServer } from "@nec/mcp";
import { evmBeforeResolverManifest, exchangeIdentityKey } from "@nec/resolver-evm";
import { deriveSolanaBeforePreflightResult, solanaBeforeResolverManifest } from "@nec/resolver-solana";

// Test-only imports of server source: the Solana SIMULATED BEFORE derivation (as in
// live-result-tool.test.ts) and the composer for the differential check. The verifier never imports them.
import { foundationFromObservation } from "../../../packages/mcp/src/live-before.js";
import type { TransactionSubject } from "../../../packages/mcp/src/live-multichain.js";
import { composeNetworkEvidenceResult, LIVE_RESULT_NON_CLAIMS, prepareEvidenceContext } from "../../../packages/mcp/src/live-result.js";
import { simulatedHostFetch } from "../../../packages/mcp/test/helpers.js";
import { reproduceObservationEnvelope } from "../reproduce.js";
import { EVIDENCE_RESULT_NON_CLAIMS, verifyEvidenceResultEnvelope } from "../verify-evidence-result.js";
import type { EvidenceResultVerificationReport } from "../verify-evidence-result.js";
import { matchPreflightAnchor } from "../verify-preflight-anchor.js";

interface Capture { rpcMethod: string; rpcParams: unknown[]; resultJson: string }
const load = (path: string): any => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const subjectRaw = load("../../../packages/mcp/test/fixtures/base-mainnet-l2-finalized-positive-evm.json");
const opStackRaw = load("../../../packages/mcp/test/fixtures/base-mainnet-l2-finalized-positive-opstack.json");
const probeRaw = load(
  "../../historical-compat/authority/fixtures/F1-x402-1062-partial/source/network-evidence/fixtures/base-mainnet-x402-1062-usdc-transfer.fixture.json");
const solRaw = load("../../../packages/resolver-solana/test/fixtures/solana-mainnet-x402-real.json");

const ORIGIN = "https://mcp.example.org";
const HOST = "mcp.example.org";
const BASE = "eip155:8453" as const;
const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" as const;
const EVM_SUBJECT: TransactionSubject = { type: "transaction", networkId: BASE, txId: subjectRaw.subject.txHash };
const EVM_PROBE: TransactionSubject = { type: "transaction", networkId: BASE, txId: probeRaw.subject.txHash };
const SOL_SUBJECT: TransactionSubject = { type: "transaction", networkId: SOL, txId: solRaw.subject.signature };

const EVM_PREFLIGHT_AT = "2026-10-09T15:00:00.000Z";
const EVM_LATE_PREFLIGHT_AT = "2026-10-09T15:30:00.000Z";
const EVM_OTHER_PREFLIGHT_AT = "2026-10-09T14:00:00.000Z";
const EVM_BLOCK_AT = "2026-10-09T15:24:33.000Z"; // block timestamp 0x6ac90731
const EVM_AFTER_AT = "2026-10-09T15:42:11.665Z"; // recorded acquisition time of the subject fixture
const OP_AT = "2026-10-09T15:42:12.116Z"; // recorded acquisition time of the OP Stack fixture
const SOL_PREFLIGHT_AT = "2026-05-10T20:00:00.000Z";
const SOL_BLOCK_AT = "2026-05-10T20:29:19.000Z"; // blockTime 1778444959
const SOL_AFTER_AT = "2026-08-26T20:01:41.884Z"; // recorded acquisition time of the Solana fixture
/** Same bound as the server's MULTICHAIN_RESULT_MAX_BYTES. */
const ENVELOPE_MAX_BYTES = 450_000;

/** The label every BEFORE of this file carries; none is a genuine pre-execution fix. */
const SIMULATED_BEFORE = Object.freeze({ clock: "SIMULATED_REPLAY_CLOCK", fixedBeforeExecution: false } as const);

/**
 * Offline replay of the recorded captures (same as live-result-tool.test.ts). Base: exact
 * method+params of the subject, OP Stack and earlier probe fixtures, refilled before every
 * call. Solana: the recorded answer per method; `solanaBeforeExecution` is the SIMULATED null answer.
 * `evmNullReceipt` is the SIMULATED null receipt/transaction answer of reproduce.test.ts.
 */
function provider(options: { solanaBeforeExecution?: boolean; evmNullReceipt?: boolean } = {}) {
  const reads: string[] = [];
  let queues = new Map<string, Capture[]>();
  const refill = () => {
    queues = new Map();
    for (const capture of [...subjectRaw.captures, ...opStackRaw.captures, ...probeRaw.captures] as Capture[]) {
      const key = exchangeIdentityKey(capture.rpcMethod, capture.rpcParams);
      queues.set(key, [...(queues.get(key) ?? []), capture]);
    }
  };
  refill();
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).href;
    const query = JSON.parse(init?.body as string) as { id: number; method: string; params?: unknown[] };
    reads.push(query.method);
    let resultText: string;
    if (url === "https://mainnet.base.org/") {
      const capture = queues.get(exchangeIdentityKey(query.method, query.params ?? []))?.shift();
      if (capture === undefined) throw new Error("undeclared Base read");
      resultText = options.evmNullReceipt
          && (query.method === "eth_getTransactionReceipt" || query.method === "eth_getTransactionByHash")
        ? "null" : capture.resultJson;
    } else if (url === "https://api.mainnet-beta.solana.com/") {
      const found = (solRaw.captures as Capture[]).find((c) => c.rpcMethod === query.method);
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
    Object.defineProperty(response, "url", { value: url });
    return response;
  };
  return { fetchFn, reads, refill };
}
type Provider = ReturnType<typeof provider>;
type Call = (name: string, args: Record<string, unknown>) => Promise<any>;

/** One hosted live-mode server and one modern-era client; every call starts from full queues and an empty read log. */
async function hosted(p: Provider, run: (call: Call) => Promise<void>): Promise<void> {
  const server = await startNeMcpHttpServer({
    host: "127.0.0.1", port: 0, hosted: { publicOrigin: ORIGIN }, liveEvidence: createMultichainTool(p.fetchFn),
  });
  try {
    const client = new Client({ name: "verify-evidence-result-test", version: "1" }, { versionNegotiation: { mode: "auto" } });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), { fetch: simulatedHostFetch(server.port, HOST) }));
    try {
      await run(async (name, args) => {
        p.refill();
        p.reads.length = 0;
        return await client.callTool({ name, arguments: args });
      });
    } finally {
      await client.close();
    }
  } finally {
    await server.close();
  }
}

const at = (iso: string): void => { vi.setSystemTime(new Date(iso)); };
const json = (value: unknown): any => JSON.parse(JSON.stringify(value));
const wire = (type: NecWireType, value: unknown): Record<string, unknown> => JSON.parse(encodeNecWireJson(type, value)) as Record<string, unknown>;
const mutate = (value: unknown, change: (copy: any) => void): any => {
  const copy = json(value);
  change(copy);
  return copy;
};
const flip = (digest: string) => `${digest.slice(0, -1)}${digest.endsWith("0") ? "1" : "0"}`;
const strip = (envelope: any): any => {
  const { evidenceResult: _evidenceResult, ...rest } = envelope;
  return rest;
};
function policyOf(content: Omit<EvidencePolicy, "digest">): EvidencePolicy {
  return { ...content, digest: computeEvidencePolicyDigest(content) };
}
function served(out: any): any {
  expect([out.isError ?? false, out.isError ? JSON.stringify(out.content) : null]).toEqual([false, null]);
  return json(out.structuredContent);
}

const EVM_ACTION = { kind: "evm.transaction", target: "0x4200000000000000000000000000000000000015", fields: { expectedStatus: "success" } };
const SOL_ACTION = { kind: "spl_token.transfer_checked", target: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", fields: { expectedAmount: "5000" } };

/** Test-authored caller request (NOT an original caller's action or policy). */
function preflightRequest(networkId: string, required: PolicyDimension[], desired: PolicyDimension[] = []): PreflightRequest {
  return {
    schemaVersion: "0.1", requestId: "ne-l039-preflight", networkId,
    action: networkId === BASE ? EVM_ACTION : SOL_ACTION,
    evidencePolicy: policyOf({ id: "ne-l039-policy", version: "1", requiredDimensions: required, desiredDimensions: desired }),
  };
}
function callerContext(subject: TransactionSubject, preflight: Record<string, unknown>, capabilitySnapshot: Record<string, unknown>) {
  const decoded = decodeNecWireJson("preflight-result", JSON.stringify(preflight));
  const request: EvidenceRequest = {
    schemaVersion: "0.1", requestId: "ne-l039-result", networkId: subject.networkId,
    subject: { type: "transaction", networkId: subject.networkId, txId: subject.txId },
    action: decoded.request.action,
    evidencePolicy: decoded.request.evidencePolicy,
    preflight: { requestId: decoded.request.requestId, digest: decoded.artifactDigest },
  };
  return { request: wire("evidence-request", request), preflight, capabilitySnapshot };
}

/** SIMULATED_REPLAY_CLOCK hosted preflight on Base: probes the EARLIER completed F1 transaction. */
async function hostedEvmContext(call: Call, preflightAt: string): Promise<any> {
  at(preflightAt);
  const out = served(await call(LIVE_PREFLIGHT_TOOL_NAME, {
    selectedNetworkId: BASE, probeSubject: EVM_PROBE, request: preflightRequest(BASE, ["execution", "dataBinding"], ["observedEffects", "finality"]),
  }));
  return callerContext(EVM_SUBJECT, out.preflight, out.capabilitySnapshot);
}

/** SIMULATED_REPLAY_CLOCK pre-execution Solana probe: the source does not know the signature yet. */
async function solanaContext(): Promise<any> {
  at(SOL_PREFLIGHT_AT);
  const probe = await createMultichainTool(provider({ solanaBeforeExecution: true }).fetchFn)({ subject: SOL_SUBJECT });
  expect(probe.acquisition).toMatchObject({ transactionObserved: false, blockObserved: false });
  const source = foundationFromObservation(probe);
  if (source.family !== "solana") throw new Error("expected the Solana BEFORE foundation");
  const preflight = deriveSolanaBeforePreflightResult(source.foundation, preflightRequest(SOL, ["execution", "finality"]));
  return callerContext(SOL_SUBJECT, wire("preflight-result", preflight), wire("capability-snapshot", source.foundation.snapshot));
}

/** efda0ca-shaped: AFTER-only, no preflight, policy authored after the block. */
function efdaContext(): Record<string, unknown> {
  const request: EvidenceRequest = {
    schemaVersion: "0.1", requestId: "efda0ca-shaped", networkId: BASE,
    subject: { type: "transaction", networkId: BASE, txId: EVM_SUBJECT.txId },
    action: EVM_ACTION,
    evidencePolicy: policyOf({
      id: "efda0ca-shaped-policy", version: "2026-10-26", requiredDimensions: ["execution", "observedEffects"],
      rules: { authoredAt: "2026-10-26T00:00:00.000Z" },
    }),
  };
  return { request: wire("evidence-request", request) };
}

const verify = (envelope: unknown, evidenceContext: unknown): Promise<EvidenceResultVerificationReport> =>
  verifyEvidenceResultEnvelope({ envelope, evidenceContext });
const decodePreflight = (context: any): PreflightResult => decodeNecWireJson("preflight-result", JSON.stringify(context.preflight));
const decodeFragment = (envelope: any) => decodeNecWireJson("network-evidence-fragment", JSON.stringify(envelope.fragment));

/** The report fields fixed by the reproduction and the separate anchor matcher. */
async function boundFields(envelope: any, context: any) {
  const reproduction = await reproduceObservationEnvelope(strip(envelope));
  expect(reproduction).toMatchObject({ status: "reproduced", reason: "byte_identical" });
  return {
    hostedFragmentDigest: reproduction.hostedFragmentDigest,
    reproducedFragmentDigest: reproduction.reproducedFragmentDigest,
    anchor: matchPreflightAnchor(decodePreflight(context), decodeFragment(envelope)),
    fixedBeforeExecution: false,
    nonClaims: EVIDENCE_RESULT_NON_CLAIMS,
  };
}

type SnapshotContent = Omit<EvidenceSnapshot, "digest">;

/**
 * SIMULATED: the served result rebuilt by Core with ONE dimension replaced, or with ONE snapshot
 * field replaced (the snapshot is then rebuilt by Core too); every digest is consistent.
 */
function rebuild(
  envelope: any, rawContext: any, manifest: ResolverManifest, patch: Record<string, unknown>,
  snapshotEdit?: (content: SnapshotContent) => SnapshotContent,
) {
  const result = decodeNecWireJson("network-evidence-result", JSON.stringify(envelope.evidenceResult.result));
  const servedSnapshot = decodeNecWireJson("evidence-snapshot", JSON.stringify(envelope.evidenceResult.evidenceSnapshot));
  const request = decodeNecWireJson("evidence-request", JSON.stringify(rawContext.request));
  const preflight = decodePreflight(rawContext);
  const capabilitySnapshot = decodeNecWireJson("capability-snapshot", JSON.stringify(rawContext.capabilitySnapshot));
  const servedContext: NetworkEvidenceBuildContext = {
    policy: request.evidencePolicy, snapshot: servedSnapshot, resolver: manifest, request, preflight,
    preflightContext: { resolver: manifest, capabilitySnapshot },
  };
  expect(verifyNetworkEvidenceResult(result, servedContext)).toBe(true);
  let snapshot: EvidenceSnapshot = servedSnapshot;
  if (snapshotEdit !== undefined) {
    const { digest: _digest, ...snapshotContent } = servedSnapshot;
    snapshot = buildEvidenceSnapshot(snapshotEdit(snapshotContent), { policy: request.evidencePolicy, resolver: manifest });
  }
  const context: NetworkEvidenceBuildContext = { ...servedContext, snapshot };
  const { request: _request, semanticDigest: _semantic, artifactDigest: _artifact, ...content } = result;
  const built = buildNetworkEvidenceResult({
    ...content,
    snapshot: { id: snapshot.id, digest: snapshot.digest },
    networkEvidence: { ...content.networkEvidence, ...patch },
  } as unknown as NetworkEvidenceResultContent, context);
  return {
    artifactDigest: built.artifactDigest,
    coreAccepts: verifyNetworkEvidenceResult(built, context),
    envelope: mutate(envelope, (e) => {
      e.evidenceResult.result = wire("network-evidence-result", built);
      e.evidenceResult.evidenceSnapshot = wire("evidence-snapshot", snapshot);
    }),
  };
}

const realFetch = globalThis.fetch;
let globalFetchCalls = 0;
const fx: Record<string, any> = {};
beforeAll(async () => {
  globalThis.fetch = (async () => {
    globalFetchCalls += 1;
    throw new Error("global fetch is denied in verify-evidence-result tests");
  }) as typeof fetch;
  // Only Date is faked; setTimeout, AbortSignal.timeout and HTTP stay real.
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const pEvm = provider();
    await hosted(pEvm, async (call) => {
      fx.evmContext = await hostedEvmContext(call, EVM_PREFLIGHT_AT);
      at(EVM_AFTER_AT);
      fx.evmPlain = served(await call(LIVE_MULTICHAIN_TOOL, { subject: EVM_SUBJECT }));
      fx.evmComposed = served(await call(LIVE_MULTICHAIN_TOOL, { subject: EVM_SUBJECT, evidenceContext: fx.evmContext }));
      fx.efdaRefusal = await call(LIVE_MULTICHAIN_TOOL, { subject: EVM_SUBJECT, evidenceContext: efdaContext() });
      fx.efdaReads = [...pEvm.reads];
    });
    // A second valid preflight for the same preflight request, probed earlier (for the substitution negative).
    await hosted(provider(), async (call) => { fx.otherContext = await hostedEvmContext(call, EVM_OTHER_PREFLIGHT_AT); });
    await hosted(provider(), async (call) => {
      at(OP_AT);
      fx.evmL2Composed = served(await call(LIVE_MULTICHAIN_TOOL, {
        subject: EVM_SUBJECT, includeL2Finality: true, evidenceContext: fx.evmContext,
      }));
    });
    fx.solContext = await solanaContext();
    at(SOL_AFTER_AT);
    await hosted(provider(), async (call) => {
      fx.solComposed = served(await call(LIVE_MULTICHAIN_TOOL, { subject: SOL_SUBJECT, evidenceContext: fx.solContext }));
    });
    await hosted(provider(), async (call) => {
      fx.lateContext = await hostedEvmContext(call, EVM_LATE_PREFLIGHT_AT);
      at(EVM_AFTER_AT);
      fx.lateNotComposed = served(await call(LIVE_MULTICHAIN_TOOL, { subject: EVM_SUBJECT, evidenceContext: fx.lateContext }));
    });
  } finally {
    vi.useRealTimers();
  }
}, 120_000);
afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("verify-evidence-result (offline, fail closed, examples-only)", () => {
  it("imports only node built-ins, @nec/core, the two resolvers, adapter-x402 and the two sibling verifiers", () => {
    const source = readFileSync(new URL("../verify-evidence-result.ts", import.meta.url), "utf8");
    expect(source).not.toContain("@nec/mcp");
    expect(source).not.toContain("packages/mcp");
    const specifiers = [...source.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)"/g)].map((m) => m[1]!);
    expect(specifiers.length).toBeGreaterThan(5);
    const allowed = new Set([
      "@nec/core", "@nec/resolver-evm", "@nec/resolver-solana", "@nec/adapter-x402", "./reproduce.js", "./verify-preflight-anchor.js",
    ]);
    expect(specifiers.filter((s) => !s.startsWith("node:") && !allowed.has(s))).toEqual([]);
    expect(source).not.toMatch(/\bimport\s*\(/);
    expect(source).not.toMatch(/\brequire\s*\(/);
    expect(globalFetchCalls).toBe(0);
  });

  it("the loopback material is what the SIMULATED_REPLAY_CLOCK fixtures say", () => {
    expect(SIMULATED_BEFORE).toEqual({ clock: "SIMULATED_REPLAY_CLOCK", fixedBeforeExecution: false });
    expect(subjectRaw.acquiredAt).toBe(EVM_AFTER_AT);
    expect(solRaw.acquiredAt).toBe(SOL_AFTER_AT);
    for (const [context, pinnedAt, blockAt] of [
      [fx.evmContext, EVM_PREFLIGHT_AT, EVM_BLOCK_AT], [fx.solContext, SOL_PREFLIGHT_AT, SOL_BLOCK_AT],
    ] as const) {
      const preflight = decodePreflight(context);
      expect(preflight.generatedAt).toBe(pinnedAt);
      expect(Date.parse(preflight.generatedAt)).toBeLessThan(Date.parse(blockAt));
    }
    expect(decodePreflight(fx.lateContext).generatedAt).toBe(EVM_LATE_PREFLIGHT_AT);
    expect(Date.parse(EVM_LATE_PREFLIGHT_AT)).toBeGreaterThan(Date.parse(EVM_BLOCK_AT));
    expect(decodeFragment(fx.evmComposed).network.observedAt.timestamp).toBe(EVM_BLOCK_AT);
    expect(decodeFragment(fx.solComposed).network.observedAt.timestamp).toBe(SOL_BLOCK_AT);
    // Everything but evidenceResult is the no-context envelope.
    expect(strip(fx.evmComposed)).toEqual(fx.evmPlain);
    expect(fx.evmComposed.evidenceResult.status).toBe("composed");
    expect(fx.evmL2Composed.evidenceResult.status).toBe("composed");
    expect(fx.solComposed.evidenceResult.status).toBe("composed");
    expect(fx.lateNotComposed.evidenceResult).toEqual({ status: "not_composed", reason: "preflight_not_before_block" });
    expect(JSON.stringify([fx.evmComposed, fx.evmL2Composed, fx.solComposed])).not.toMatch(/fixedBeforeExecution"\s*:\s*true/);
    expect(globalFetchCalls).toBe(0);
  });

  it("EVM 0x71c9 (SIMULATED_REPLAY_CLOCK preflight 15:00, AFTER 15:42:11.665Z) is verified; anchor not_anchored", async () => {
    const report = await verify(fx.evmComposed, fx.evmContext);
    expect(report).toEqual({
      status: "verified", reason: "composed_result_verified", stage: "composition",
      servedStatus: "composed", expectedOutcome: "composable",
      resultArtifactDigest: fx.evmComposed.evidenceResult.result.artifactDigest,
      ...(await boundFields(fx.evmComposed, fx.evmContext)),
    });
    expect(report.anchor).toMatchObject({
      status: "not_anchored", reason: "no_authorization_used_log", stage: "anchor", fixedBeforeExecution: false,
    });
    expect(report.fixedBeforeExecution).toBe(false);
    const result = decodeNecWireJson("network-evidence-result", JSON.stringify(fx.evmComposed.evidenceResult.result));
    expect(result.generatedAt).toBe(EVM_AFTER_AT);
    for (const name of ["settlement", "finality"] as const) {
      expect(result.networkEvidence[name]).not.toHaveProperty("verdict");
      expect(result.networkEvidence[name].reason).toMatch(/^EVM_DIMENSIONS_NOT_EVALUATED: /);
    }
    expect(globalFetchCalls).toBe(0);
  });

  it("EVM + includeL2Finality is verified; the OP Stack supplement is never merged", async () => {
    const envelope = fx.evmL2Composed;
    // Positive control: the served supplement really asserts OP Stack L2 block finality.
    expect(envelope.opStackFinality).toMatchObject({ toolStatus: "evaluated", withdrawalFinalization: "not_evaluated" });
    const op = decodeNecWireJson("network-evidence-fragment", JSON.stringify(envelope.opStackFinality.fragment));
    expect(op.networkEvidence.finality?.verdict).toBe("supported");
    expect(envelope.acquiredAt).toBe(OP_AT);

    const report = await verify(envelope, fx.evmContext);
    expect(report).toEqual({
      status: "verified", reason: "composed_result_verified", stage: "composition",
      servedStatus: "composed", expectedOutcome: "composable",
      resultArtifactDigest: envelope.evidenceResult.result.artifactDigest,
      ...(await boundFields(envelope, fx.evmContext)),
    });
    const result = decodeNecWireJson("network-evidence-result", JSON.stringify(envelope.evidenceResult.result));
    expect(result.networkEvidence.finality).toMatchObject({ applicability: "unknown", basis: [], evidence: [] });
    expect(result.networkEvidence.finality).not.toHaveProperty("verdict");
    const mainIds = new Set(decodeFragment(envelope).evidence.map((ref) => ref.id));
    const foreign = op.evidence.filter((ref) => !mainIds.has(ref.id));
    expect(foreign.length).toBeGreaterThan(0);
    const resultIds = new Set(result.evidence.map((ref) => ref.id));
    for (const ref of foreign) expect(resultIds.has(ref.id)).toBe(false);
    // Nor into the served snapshot: its evidence table is exactly the reproduced fragment's.
    const snapshot = decodeNecWireJson("evidence-snapshot", JSON.stringify(envelope.evidenceResult.evidenceSnapshot));
    const snapshotIds = new Set(snapshot.evidence.map((ref) => ref.id));
    for (const ref of foreign) expect(snapshotIds.has(ref.id)).toBe(false);
    expect(snapshot.evidence.map((ref) => ref.id)).toEqual([...mainIds]);
    expect(result.resolver.digest).toBe(evmBeforeResolverManifest().digest);
    expect(globalFetchCalls).toBe(0);
  });

  it("Solana 4DYWUMEx…LF71 (SIMULATED null probe preflight) is verified; anchor not_applicable", async () => {
    expect(SOL_SUBJECT.txId.startsWith("4DYWUMEx")).toBe(true);
    expect(SOL_SUBJECT.txId.endsWith("LF71")).toBe(true);
    const report = await verify(fx.solComposed, fx.solContext);
    expect(report).toEqual({
      status: "verified", reason: "composed_result_verified", stage: "composition",
      servedStatus: "composed", expectedOutcome: "composable",
      resultArtifactDigest: fx.solComposed.evidenceResult.result.artifactDigest,
      ...(await boundFields(fx.solComposed, fx.solContext)),
    });
    expect(report.anchor).toMatchObject({ status: "not_applicable", reason: "non_evm_subject", fixedBeforeExecution: false });
    const result = decodeNecWireJson("network-evidence-result", JSON.stringify(fx.solComposed.evidenceResult.result));
    expect(result.networkEvidence.finality).toEqual(decodeFragment(fx.solComposed).networkEvidence.finality);
    expect(result.networkEvidence.settlement.reason).toMatch(/^SOLANA_SETTLEMENT_NOT_EVALUATED: /);
    expect(globalFetchCalls).toBe(0);
  });

  it("a preflight at 15:30 (after the block) is not_composed_reproduced(preflight_not_before_block)", async () => {
    const report = await verify(fx.lateNotComposed, fx.lateContext);
    expect(report).toEqual({
      status: "not_composed_reproduced", reason: "preflight_not_before_block", stage: "composition",
      servedStatus: "not_composed", expectedOutcome: "preflight_not_before_block", resultArtifactDigest: null,
      ...(await boundFields(fx.lateNotComposed, fx.lateContext)),
    });
    expect(report.fixedBeforeExecution).toBe(false);
    expect(globalFetchCalls).toBe(0);
  });

  it("efda0ca-shaped AFTER-only context: the server refuses it (NO_PREFLIGHT); the verifier says context_invalid; never verified, never a BEFORE", async () => {
    expect(fx.efdaRefusal.isError).toBe(true);
    expect(fx.efdaRefusal.structuredContent).toBeUndefined();
    expect(JSON.parse(fx.efdaRefusal.content[0].text).error.code).toBe("MCP_EVIDENCE_CONTEXT_NO_PREFLIGHT");
    expect(fx.efdaReads).toEqual([]);
    const efda = efdaContext();
    for (const context of [
      efda,
      { ...efda, capabilitySnapshot: fx.evmContext.capabilitySnapshot },
      { ...efda, preflight: fx.evmContext.preflight, capabilitySnapshot: fx.evmContext.capabilitySnapshot },
    ]) {
      const report = await verify(fx.evmComposed, context);
      expect(report).toMatchObject({
        status: "not_reproducible", reason: "context_invalid", stage: "context",
        firstDiffPointer: "/evidenceContext/request/preflight", anchor: null, fixedBeforeExecution: false,
      });
    }
    // No served envelope carries an evidenceResult for it.
    expect(await verify(fx.evmPlain, efda)).toMatchObject({
      status: "not_applicable", reason: "evidence_result_absent", anchor: null, fixedBeforeExecution: false,
    });
    expect(globalFetchCalls).toBe(0);
  });

  it("SIMULATED single-mutation negatives: each is non-verified with a distinct reason and pointer", async () => {
    const env = fx.evmComposed;
    const ctx = fx.evmContext;
    const k = (env.fragment.evidence as { nativeSource?: unknown }[]).findIndex((ref) => ref.nativeSource !== undefined);
    expect(k).toBeGreaterThanOrEqual(0);
    const other = decodePreflight(fx.otherContext);
    expect(other.request.requestId).toBe(decodePreflight(ctx).request.requestId);
    expect(other.artifactDigest).not.toBe(decodePreflight(ctx).artifactDigest);
    const nextPolicy = (policy: Omit<EvidencePolicy, "digest"> & { digest?: string }) => {
      const { digest: _digest, ...content } = policy;
      return policyOf({ ...content, version: "2" });
    };
    const cases: { label: "SIMULATED"; name: string; envelope: any; context: any; expected: [string, string, string, string] }[] = [
      { label: "SIMULATED", name: "one nativeSource byte", context: ctx,
        envelope: mutate(env, (e) => {
          const native = e.fragment.evidence[k].nativeSource;
          const bytes = Buffer.from(native.payload, "base64");
          bytes[0] = bytes[0]! ^ 1;
          native.payload = bytes.toString("base64");
        }),
        expected: ["diverged", "native_source_digest_mismatch", "after_envelope", `/fragment/evidence/${k}/nativeSource/contentDigest`] },
      { label: "SIMULATED", name: "manifest swapped to the other family", context: ctx,
        envelope: mutate(env, (e) => { e.evidenceResult.resolverManifest = wire("resolver-manifest", solanaBeforeResolverManifest()); }),
        expected: ["diverged", "manifest_not_pinned", "composition", "/evidenceResult/resolverManifest/digest"] },
      { label: "SIMULATED", name: "manifest field edited", context: ctx,
        envelope: mutate(env, (e) => { e.evidenceResult.resolverManifest.version = "0.1.1"; }),
        expected: ["diverged", "manifest_not_pinned", "composition", "/evidenceResult/resolverManifest/version"] },
      { label: "SIMULATED", name: "request.evidencePolicy changed, digest recomputed", envelope: env,
        context: mutate(ctx, (c) => { c.request.evidencePolicy = nextPolicy(c.request.evidencePolicy); }),
        expected: ["diverged", "context_mismatch", "context", "/evidenceContext/request/evidencePolicy"] },
      { label: "SIMULATED", name: "preflight replaced by another valid preflight", envelope: env,
        context: mutate(ctx, (c) => { c.preflight = fx.otherContext.preflight; }),
        expected: ["diverged", "context_mismatch", "context", "/evidenceContext/preflight/artifactDigest"] },
      { label: "SIMULATED", name: "one evidenceSnapshot ref removed", context: ctx,
        envelope: mutate(env, (e) => { e.evidenceResult.evidenceSnapshot.evidence.pop(); }),
        expected: ["diverged", "result_verification_failed", "composition", "/evidenceResult/evidenceSnapshot"] },
      { label: "SIMULATED", name: "result artifactDigest flipped", context: ctx,
        envelope: mutate(env, (e) => { e.evidenceResult.result.artifactDigest = flip(e.evidenceResult.result.artifactDigest); }),
        expected: ["diverged", "result_verification_failed", "composition", "/evidenceResult/result"] },
      { label: "SIMULATED", name: "extra key in evidenceResult", context: ctx,
        envelope: mutate(env, (e) => { e.evidenceResult.note = "SIMULATED"; }),
        expected: ["not_reproducible", "evidence_result_invalid", "evidence_result", "/evidenceResult/note"] },
      { label: "SIMULATED", name: "unknown not_composed reason", context: ctx,
        envelope: mutate(env, (e) => { e.evidenceResult = { status: "not_composed", reason: "policy_not_satisfied" }; }),
        expected: ["not_reproducible", "evidence_result_invalid", "evidence_result", "/evidenceResult/reason"] },
      { label: "SIMULATED", name: "served not_composed although the evidence says composable", context: ctx,
        envelope: mutate(env, (e) => { e.evidenceResult = { status: "not_composed", reason: "preflight_not_before_block" }; }),
        expected: ["diverged", "not_composed_unjustified", "composition", "/evidenceResult/reason"] },
    ];
    expect(new Set(cases.map((c) => `${c.expected[1]} ${c.expected[3]}`)).size).toBe(cases.length);
    for (const c of cases) {
      const report = await verify(c.envelope, c.context);
      expect([c.label, c.name, report.status, report.reason, report.stage, report.firstDiffPointer])
        .toEqual(["SIMULATED", c.name, ...c.expected]);
      expect(report.status).not.toBe("verified");
      expect(report.fixedBeforeExecution).toBe(false);
    }
    // The nativeSource case is the reproduction's own report, passed on unchanged.
    const direct = await reproduceObservationEnvelope(strip(cases[0]!.envelope));
    expect([direct.status, direct.reason, direct.firstDiffPointer]).toEqual(cases[0]!.expected.filter((_, i) => i !== 2));
    expect(globalFetchCalls).toBe(0);
  });

  it("SIMULATED pairing: a composed envelope with a self-consistent context whose preflight is after the block -> composed_unjustified", async () => {
    const report = await verify(fx.evmComposed, fx.lateContext);
    expect(report).toMatchObject({
      status: "diverged", reason: "composed_unjustified", stage: "composition", firstDiffPointer: "/evidenceResult/status",
      expectedOutcome: "preflight_not_before_block", fixedBeforeExecution: false,
    });
    expect(globalFetchCalls).toBe(0);
  });

  it("AT7 (SIMULATED): Core's exact refusal of a pasted settlement verdict, then digest-consistent rebuilds that Core accepts and the verifier refuses", async () => {
    const env = fx.evmComposed;
    const ctx = fx.evmContext;
    const evm = evmBeforeResolverManifest();
    expect(evm.supportedCapabilities).not.toContain("settlement");
    const refId = env.evidenceResult.result.evidence[0].id as string;
    const verdict = { applicability: "applicable", verdict: "supported", basis: ["source_observation"], evidence: [refId] };

    // (a) Pasted into the served result: Core refuses it, by self-digest only.
    const pasted = mutate(env, (e) => { e.evidenceResult.result.networkEvidence.settlement = verdict; });
    expect(() => decodeNecWireJson("network-evidence-result", JSON.stringify(pasted.evidenceResult.result)))
      .toThrow("semanticDigest: self-digest mismatch: recomputed semantic digest differs");
    expect(await verify(pasted, ctx)).toMatchObject({
      status: "diverged", reason: "result_verification_failed", firstDiffPointer: "/evidenceResult/result", resultArtifactDigest: null,
    });

    // (b) Rebuilt by Core with consistent digests: Core does not consult supportedCapabilities for a result.
    const strengthened = rebuild(env, ctx, evm, { settlement: verdict });
    expect(strengthened.coreAccepts).toBe(true);
    expect(await verify(strengthened.envelope, ctx)).toMatchObject({
      status: "diverged", reason: "dimension_not_supported_by_fragment",
      firstDiffPointer: "/evidenceResult/result/networkEvidence/settlement", resultArtifactDigest: strengthened.artifactDigest,
    });

    // (c) Rebuilt: the unevaluated dimension cites a warning the EVM fragment does not carry.
    const fragmentCodes = decodeFragment(env).warnings.map((w) => w.code);
    expect(fragmentCodes).toContain("EVM_DIMENSIONS_NOT_EVALUATED");
    expect(fragmentCodes).not.toContain("SOLANA_SETTLEMENT_NOT_EVALUATED");
    const wrongWarning = rebuild(env, ctx, evm, {
      settlement: {
        applicability: "unknown", basis: [], evidence: [],
        reason: "SOLANA_SETTLEMENT_NOT_EVALUATED: Generic Solana acquisition does not evaluate protocol settlement.",
      },
    });
    expect(wrongWarning.coreAccepts).toBe(true);
    expect(await verify(wrongWarning.envelope, ctx)).toMatchObject({
      status: "diverged", reason: "dimension_not_supported_by_fragment",
      firstDiffPointer: "/evidenceResult/result/networkEvidence/settlement/reason",
    });

    // (d) Solana, rebuilt: settlement cites a warning the fragment carries but which does not declare settlement.
    const limit = decodeFragment(fx.solComposed).warnings.find((w) => w.code === "SOLANA_SOURCE_OBSERVATION_LIMIT");
    expect(limit).toBeDefined();
    const undeclared = rebuild(fx.solComposed, fx.solContext, solanaBeforeResolverManifest(), {
      settlement: { applicability: "unknown", basis: [], evidence: [], reason: `${limit!.code}: ${limit!.message}` },
    });
    expect(undeclared.coreAccepts).toBe(true);
    expect(await verify(undeclared.envelope, fx.solContext)).toMatchObject({
      status: "diverged", reason: "dimension_not_supported_by_fragment",
      firstDiffPointer: "/evidenceResult/result/networkEvidence/settlement/reason",
    });

    // (e) Rebuilt: the right declaring code, but free text after it instead of the fragment's own message.
    const declaring = decodeFragment(env).warnings.find((w) => w.code === "EVM_DIMENSIONS_NOT_EVALUATED");
    expect(env.evidenceResult.result.networkEvidence.settlement.reason).toBe(`${declaring!.code}: ${declaring!.message}`);
    const freeText = rebuild(env, ctx, evm, {
      settlement: { applicability: "unknown", basis: [], evidence: [], reason: "EVM_DIMENSIONS_NOT_EVALUATED: settlement supported" },
    });
    expect(freeText.coreAccepts).toBe(true);
    expect(await verify(freeText.envelope, ctx)).toMatchObject({
      status: "diverged", reason: "dimension_not_supported_by_fragment",
      firstDiffPointer: "/evidenceResult/result/networkEvidence/settlement/reason",
    });
    expect(globalFetchCalls).toBe(0);
  });

  it("SIMULATED snapshot binding: digest-consistent snapshots that Core accepts but that carry unreproduced material diverge", async () => {
    const evm = evmBeforeResolverManifest();
    // Control: rebuilding with an identity edit keeps the served bytes and stays verified.
    const identity = rebuild(fx.evmL2Composed, fx.evmContext, evm, {}, (content) => content);
    expect(identity.artifactDigest).toBe(fx.evmL2Composed.evidenceResult.result.artifactDigest);
    expect(identity.envelope).toEqual(fx.evmL2Composed);
    expect((await verify(identity.envelope, fx.evmContext)).status).toBe("verified");

    // (a) The OP Stack supplement's foreign refs appended to the snapshot evidence table (Core: a superset is allowed).
    const op = decodeNecWireJson("network-evidence-fragment", JSON.stringify(fx.evmL2Composed.opStackFinality.fragment));
    const mainIds = new Set(decodeFragment(fx.evmL2Composed).evidence.map((ref) => ref.id));
    const foreign = op.evidence.filter((ref) => !mainIds.has(ref.id));
    expect(foreign.length).toBeGreaterThan(0);
    const merged = rebuild(fx.evmL2Composed, fx.evmContext, evm, {}, (content) => ({
      ...content, evidence: [...content.evidence, ...foreign],
    }));
    expect(merged.coreAccepts).toBe(true);
    expect(await verify(merged.envelope, fx.evmContext)).toMatchObject({
      status: "diverged", reason: "context_mismatch", stage: "composition",
      firstDiffPointer: "/evidenceResult/evidenceSnapshot/evidence", resultArtifactDigest: merged.artifactDigest,
      fixedBeforeExecution: false,
    });

    // (b) The subject-block anchor moved one second later (Core: anchors are only validated, not bound to the network).
    const moved = rebuild(fx.evmComposed, fx.evmContext, evm, {}, (content) => ({
      ...content, anchors: content.anchors.map((anchor) => ({ ...anchor, timestamp: "2026-10-09T15:24:34.000Z" })),
    }));
    expect(moved.coreAccepts).toBe(true);
    expect(await verify(moved.envelope, fx.evmContext)).toMatchObject({
      status: "diverged", reason: "context_mismatch", stage: "composition",
      firstDiffPointer: "/evidenceResult/evidenceSnapshot/anchors", resultArtifactDigest: moved.artifactDigest,
      fixedBeforeExecution: false,
    });

    // (c) A second, foreign-network anchor added next to the subject block.
    const extra = rebuild(fx.evmComposed, fx.evmContext, evm, {}, (content) => ({
      ...content, anchors: [...content.anchors, { networkId: "eip155:1", blockNumber: 1n }],
    }));
    expect(extra.coreAccepts).toBe(true);
    expect(await verify(extra.envelope, fx.evmContext)).toMatchObject({
      status: "diverged", reason: "context_mismatch", firstDiffPointer: "/evidenceResult/evidenceSnapshot/anchors",
    });
    expect(globalFetchCalls).toBe(0);
  });

  it("transaction_not_observed (SIMULATED null receipt, loopback) is recomputed; a different served reason or a composed claim diverges", async () => {
    let envelope: any = undefined;
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await hosted(provider({ evmNullReceipt: true }), async (call) => {
        at(EVM_AFTER_AT);
        envelope = served(await call(LIVE_MULTICHAIN_TOOL, { subject: EVM_SUBJECT, evidenceContext: fx.evmContext }));
      });
    } finally {
      vi.useRealTimers();
    }
    expect(envelope.acquisition.transactionObserved).toBe(false);
    expect(envelope.evidenceResult).toEqual({ status: "not_composed", reason: "transaction_not_observed" });
    // Differential: the composer gives the same refusal for the same observation and context.
    const observation = strip(envelope);
    expect(json(composeNetworkEvidenceResult(observation, prepareEvidenceContext(EVM_SUBJECT, fx.evmContext))))
      .toEqual(envelope.evidenceResult);

    expect(await verify(envelope, fx.evmContext)).toEqual({
      status: "not_composed_reproduced", reason: "transaction_not_observed", stage: "composition",
      servedStatus: "not_composed", expectedOutcome: "transaction_not_observed", resultArtifactDigest: null,
      ...(await boundFields(envelope, fx.evmContext)),
    });
    // SIMULATED: a different, valid refusal reason for the same evidence.
    expect(await verify({ ...observation, evidenceResult: { status: "not_composed", reason: "block_not_observed" } }, fx.evmContext))
      .toMatchObject({
        status: "diverged", reason: "not_composed_unjustified", firstDiffPointer: "/evidenceResult/reason",
        expectedOutcome: "transaction_not_observed", fixedBeforeExecution: false,
      });
    // SIMULATED: a real composed evidenceResult pasted onto the unobserved transaction.
    expect(await verify({ ...observation, evidenceResult: fx.evmComposed.evidenceResult }, fx.evmContext)).toMatchObject({
      status: "diverged", reason: "composed_unjustified", firstDiffPointer: "/evidenceResult/status",
      expectedOutcome: "transaction_not_observed", fixedBeforeExecution: false,
    });
    expect(globalFetchCalls).toBe(0);
  });

  it("differential: every composeNetworkEvidenceResult output on the positive fixtures is accepted; served nonClaims equal LIVE_RESULT_NON_CLAIMS", async () => {
    const cases: [any, any, EvidenceResultVerificationReport["status"]][] = [
      [fx.evmComposed, fx.evmContext, "verified"],
      [fx.evmL2Composed, fx.evmContext, "verified"],
      [fx.solComposed, fx.solContext, "verified"],
      [fx.lateNotComposed, fx.lateContext, "not_composed_reproduced"],
    ];
    for (const [envelope, context, status] of cases) {
      const observation = strip(envelope);
      const outcome = json(composeNetworkEvidenceResult(observation, prepareEvidenceContext(observation.subject, context)));
      expect(outcome).toEqual(envelope.evidenceResult);
      const report = await verify({ ...observation, evidenceResult: outcome }, context);
      expect([observation.subject.txId, report.status]).toEqual([observation.subject.txId, status]);
      if (outcome.status === "composed") expect(outcome.nonClaims).toEqual([...LIVE_RESULT_NON_CLAIMS]);
    }

    // output_budget: a composed result that cannot fit; the envelope with the marker fits exactly.
    const observation = strip(fx.evmComposed);
    const marker = { status: "not_composed", reason: "output_budget" };
    const unpadded = { ...observation, nonClaims: [...observation.nonClaims, ""] };
    const room = ENVELOPE_MAX_BYTES - Buffer.byteLength(JSON.stringify({ ...unpadded, evidenceResult: marker }));
    expect(room).toBeGreaterThan(0);
    const padded = { ...observation, nonClaims: [...observation.nonClaims, "x".repeat(room)] };
    const outcome = json(composeNetworkEvidenceResult(padded, prepareEvidenceContext(EVM_SUBJECT, fx.evmContext)));
    expect(outcome).toEqual(marker);
    const envelope = { ...padded, evidenceResult: outcome };
    expect(Buffer.byteLength(JSON.stringify(envelope))).toBe(ENVELOPE_MAX_BYTES);
    expect(await verify(envelope, fx.evmContext)).toMatchObject({
      status: "not_composed_unchecked", reason: "output_budget", servedStatus: "not_composed", expectedOutcome: "composable",
      fixedBeforeExecution: false,
    });
    expect(globalFetchCalls).toBe(0);
  });

  it("regression: reproduceObservationEnvelope still refuses an unstripped evidenceResult envelope at /evidenceResult", async () => {
    for (const envelope of [fx.evmComposed, fx.evmL2Composed, fx.solComposed, fx.lateNotComposed]) {
      expect(await reproduceObservationEnvelope(envelope)).toEqual({
        status: "not_reproducible", reason: "envelope_invalid", firstDiffPointer: "/evidenceResult",
        hostedFragmentDigest: null, reproducedFragmentDigest: null,
      });
    }
    expect(globalFetchCalls).toBe(0);
  });

  it("determinism: two runs give byte-identical reports, global fetch is never called and no clock is read", async () => {
    const efda = efdaContext();
    const flipped = mutate(fx.evmComposed, (e) => { e.evidenceResult.result.artifactDigest = flip(e.evidenceResult.result.artifactDigest); });
    const inputs: [unknown, unknown][] = [
      [fx.evmComposed, fx.evmContext], [fx.evmL2Composed, fx.evmContext], [fx.solComposed, fx.solContext],
      [fx.lateNotComposed, fx.lateContext], [fx.evmComposed, efda], [fx.evmPlain, fx.evmContext], [flipped, fx.evmContext],
    ];
    const RealDate = globalThis.Date;
    let clockReads = 0;
    const runs: string[] = [];
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
      for (let i = 0; i < 2; i++) {
        const reports: EvidenceResultVerificationReport[] = [];
        for (const [envelope, context] of inputs) reports.push(await verify(envelope, context));
        runs.push(JSON.stringify(reports));
      }
    } finally {
      globalThis.Date = RealDate;
    }
    expect(runs[1]).toBe(runs[0]);
    expect(clockReads).toBe(0);
    expect(runs[0]).not.toMatch(/"fixedBeforeExecution":true/);
    expect(globalFetchCalls).toBe(0);
  });

  it("README states what verified means, the GT-02 operator sequence with its human gates, and GT-02 stays OPEN", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const start = readme.indexOf("## Served evidenceResult verification");
    expect(start).toBeGreaterThan(0);
    const end = readme.indexOf("## Capture client", start);
    expect(end).toBeGreaterThan(start);
    const section = readme.slice(start, end).replace(/\s+/g, " ");
    for (const status of [
      "verified", "not_composed_reproduced", "not_composed_unchecked", "diverged", "not_reproducible", "not_applicable:evidence_result_absent",
    ]) expect(section).toContain(status);
    expect(section).toContain(
      "It is **not** precedence, policy satisfaction, independent source verification, settlement or finality.");
    expect(section).toContain("No real composed or anchored case exists.");
    expect(section).toContain("GT-02 stays OPEN.");
    expect(section).toContain("nothing here was executed");
    expect(section.match(/HUMAN GATE/g)?.length ?? 0).toBeGreaterThanOrEqual(6);
    const draft = readFileSync(new URL("../../../docs/distribution/MCP_PUBLIC_CONTRACT.md", import.meta.url), "utf8");
    expect(draft).toContain("The offline demo does not establish an authenticated or cryptographically anchored BEFORE.");
  });
});
