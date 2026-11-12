/**
 * NE-P3: the optional `evidenceContext` of the EXISTING resolve_transaction_evidence
 * tool, at the hosted tools/call surface (SDK client, loopback, SIMULATED public
 * Host). No new tool. Offline replay only: a fake provider serves recorded RPC
 * bytes for the fixed origins and refuses anything else; global fetch throws and
 * is counted. Only Date is faked.
 *
 * Every BEFORE in this file is SIMULATED_REPLAY_CLOCK, fixedBeforeExecution:false:
 *  - EVM: the hosted preflight probes the EARLIER completed F1 x402 #1062 Base
 *    transaction at a pinned 2026-10-09T15:00:00.000Z, before the subject block
 *    (2026-10-09T15:24:33.000Z); the AFTER is read at the subject fixture's
 *    recorded acquisition instant.
 *  - Solana: the pre-execution probe is a SIMULATED null answer for the
 *    not-yet-existing signature at a pinned 2026-05-10T20:00:00.000Z.
 * None of them is a genuine caller action fixed before execution. Core
 * preflight continuity is not precedence and not policy satisfaction. The
 * efda0ca-shaped AFTER-only request can never become a BEFORE.
 */
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  computeEvidencePolicyDigest, computeEvidenceRequestDigest, decodeNecWireJson, encodeNecWireJson,
  verifyNetworkEvidenceResult,
} from "@nec/core";
import type {
  CapabilitySnapshot, EvidencePolicy, EvidenceRequest, NecWireType, PolicyDimension, PreflightRequest, PreflightResult,
} from "@nec/core";
import { evmBeforeResolverManifest, exchangeIdentityKey } from "@nec/resolver-evm";
import { deriveSolanaBeforePreflightResult, solanaBeforeResolverManifest } from "@nec/resolver-solana";
import { startNeMcpHttpServer } from "../src/http.js";
import { foundationFromObservation } from "../src/live-before.js";
import { resolveWithOptionalClaim } from "../src/live-claim.js";
import {
  createMultichainTool, LIVE_MULTICHAIN_TOOL, MULTICHAIN_CALLS_PER_MINUTE, MULTICHAIN_RESULT_MAX_BYTES,
} from "../src/live-multichain.js";
import type { MultichainTool, TransactionSubject } from "../src/live-multichain.js";
import { createLivePreflightTool, LIVE_PREFLIGHT_TOOL_NAME } from "../src/live-preflight.js";
import { EVIDENCE_CONTEXT_MAX_BYTES, LIVE_RESULT_NON_CLAIMS } from "../src/live-result.js";
import { LIVE_TOOL_NAMES } from "../src/tools.js";
import { simulatedHostFetch } from "./helpers.js";

interface Capture { rpcMethod: string; rpcParams: unknown[]; resultJson: string }
const json = (path: string): any => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const subjectRaw = json("./fixtures/base-mainnet-l2-finalized-positive-evm.json");
const opStackRaw = json("./fixtures/base-mainnet-l2-finalized-positive-opstack.json");
const probeRaw = json(
  "../../../examples/historical-compat/authority/fixtures/F1-x402-1062-partial/source/network-evidence/fixtures/base-mainnet-x402-1062-usdc-transfer.fixture.json");
const solRaw = json("../../resolver-solana/test/fixtures/solana-mainnet-x402-real.json");

const ORIGIN = "https://mcp.example.org";
const HOST = "mcp.example.org";
const BASE = "eip155:8453" as const;
const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" as const;
const EVM_SUBJECT: TransactionSubject = { type: "transaction", networkId: BASE, txId: subjectRaw.subject.txHash };
const EVM_PROBE: TransactionSubject = { type: "transaction", networkId: BASE, txId: probeRaw.subject.txHash };
const SOL_SUBJECT: TransactionSubject = { type: "transaction", networkId: SOL, txId: solRaw.subject.signature };

const EVM_PREFLIGHT_AT = "2026-10-09T15:00:00.000Z";
const EVM_BLOCK_AT = "2026-10-09T15:24:33.000Z"; // block timestamp 0x6ac90731
const EVM_AFTER_AT = "2026-10-09T15:42:11.665Z"; // recorded acquisition time of the subject fixture
const OP_AT = "2026-10-09T15:42:12.116Z"; // recorded acquisition time of the OP Stack fixture
const SOL_PREFLIGHT_AT = "2026-05-10T20:00:00.000Z";
const SOL_BLOCK_AT = "2026-05-10T20:29:19.000Z"; // blockTime 1778444959
const SOL_AFTER_AT = "2026-08-26T20:01:41.884Z"; // recorded acquisition time of the Solana fixture

const BASE_READS = ["eth_chainId", "eth_getTransactionReceipt", "eth_getBlockByHash", "eth_getTransactionByHash"];
const SOL_READS = ["getGenesisHash", "getTransaction", "getSignatureStatuses", "getBlock"];
const NO_PREFLIGHT = "MCP_EVIDENCE_CONTEXT_NO_PREFLIGHT";
const INVALID = "MCP_EVIDENCE_CONTEXT_INVALID";
const CALLER_MANIFEST = "MCP_EVIDENCE_CONTEXT_CALLER_MANIFEST";
const TOO_LARGE = "MCP_EVIDENCE_CONTEXT_TOO_LARGE";
/** The exact server-authored messages; INVALID carries a fixed prefix plus a fixed detail. */
const MESSAGES: Readonly<Record<string, string>> = {
  [NO_PREFLIGHT]: "evidenceContext requires request.preflight and the complete referenced PreflightResult; without a pre-execution preflight no full result is composed",
  [CALLER_MANIFEST]: "the resolver manifest is pinned by the server per network family; a caller-supplied manifest is never accepted",
  [TOO_LARGE]: `evidenceContext exceeds ${EVIDENCE_CONTEXT_MAX_BYTES} bytes`,
};
const CALLER_TEXT = "CALLER_TEXT_NE_P3_NEVER_ECHOED";

/** The label every BEFORE of this file carries; none is a genuine pre-execution fix. */
const SIMULATED_BEFORE = Object.freeze({ clock: "SIMULATED_REPLAY_CLOCK", fixedBeforeExecution: false } as const);

/**
 * Offline replay of the recorded captures. Base: exact method+params of the
 * subject, OP Stack and earlier probe fixtures (same-key captures in fixture
 * order, refilled before every call). Solana: the recorded answer per method;
 * `solanaBeforeExecution` is the SIMULATED null pre-execution answer.
 */
function provider(options: { solanaBeforeExecution?: boolean } = {}) {
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
      resultText = capture.resultJson;
    } else if (url === "https://api.mainnet-beta.solana.com/") {
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
    Object.defineProperty(response, "url", { value: url });
    return response;
  };
  return { fetchFn, reads, refill };
}
type Provider = ReturnType<typeof provider>;
type Call = (name: string, args: Record<string, unknown>) => Promise<any>;

/** One hosted live-mode server; every call starts from full queues and an empty read log. */
async function hosted(p: Provider, run: (call: Call, client: Client) => Promise<void>, mode: "legacy" | "auto" = "auto") {
  const server = await startNeMcpHttpServer({
    host: "127.0.0.1", port: 0, hosted: { publicOrigin: ORIGIN }, liveEvidence: createMultichainTool(p.fetchFn),
  });
  try {
    const client = new Client({ name: "live-result-tool-test", version: "1" }, { versionNegotiation: { mode } });
    await client.connect(new StreamableHTTPClientTransport(new URL(ORIGIN + "/mcp"), { fetch: simulatedHostFetch(server.port, HOST) }));
    try {
      await run(async (name, args) => {
        p.refill();
        p.reads.length = 0;
        return await client.callTool({ name, arguments: args });
      }, client);
    } finally { await client.close(); }
  } finally { await server.close(); }
}

const realFetch = globalThis.fetch;
let globalFetchCalls = 0;
beforeAll(() => {
  globalThis.fetch = (async () => {
    globalFetchCalls += 1;
    throw new Error("network I/O is forbidden in live-result-tool tests");
  }) as typeof fetch;
});
afterAll(() => { globalThis.fetch = realFetch; });
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); });
afterEach(() => {
  vi.useRealTimers();
  expect(globalFetchCalls).toBe(0);
});

function at(iso: string): void {
  vi.setSystemTime(new Date(iso));
}
function wire(type: NecWireType, value: unknown): Record<string, unknown> {
  return JSON.parse(encodeNecWireJson(type, value)) as Record<string, unknown>;
}
function policyOf(content: Omit<EvidencePolicy, "digest">): EvidencePolicy {
  return { ...content, digest: computeEvidencePolicyDigest(content) };
}
const EVM_ACTION = { kind: "evm.transaction", target: "0x4200000000000000000000000000000000000015", fields: { expectedStatus: "success" } };
const SOL_ACTION = { kind: "spl_token.transfer_checked", target: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", fields: { expectedAmount: "5000" } };

/** Test-authored caller request (NOT an original caller's action or policy). */
function preflightRequest(networkId: string, required: PolicyDimension[], desired: PolicyDimension[] = []): PreflightRequest {
  return {
    schemaVersion: "0.1", requestId: "ne-p3-preflight", networkId,
    action: networkId === BASE ? EVM_ACTION : SOL_ACTION,
    evidencePolicy: policyOf({ id: "ne-p3-policy", version: "1", requiredDimensions: required, desiredDimensions: desired }),
  };
}
/** The later EvidenceRequest: the subject now exists; action and policy come from the preflighted request. */
function evidenceRequestFor(subject: TransactionSubject, preflight: PreflightResult): EvidenceRequest {
  return {
    schemaVersion: "0.1", requestId: "ne-p3-result", networkId: subject.networkId,
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
type Context = ReturnType<typeof callerContext>;

/** SIMULATED_REPLAY_CLOCK hosted preflight on Base: probes the EARLIER completed F1 transaction. */
async function hostedEvmContext(call: Call, preflightAt: string, required: PolicyDimension[], desired: PolicyDimension[] = []):
  Promise<Context> {
  at(preflightAt);
  const out = await call(LIVE_PREFLIGHT_TOOL_NAME, {
    selectedNetworkId: BASE, probeSubject: EVM_PROBE, request: preflightRequest(BASE, required, desired),
  });
  expect(out.isError).toBeFalsy();
  return callerContext(EVM_SUBJECT, out.structuredContent.preflight, out.structuredContent.capabilitySnapshot);
}

/** The same SIMULATED_REPLAY_CLOCK Base preflight in-process, on its own tool instance and budget. */
async function inProcessEvmContext(preflightAt: string, required: PolicyDimension[], desired: PolicyDimension[] = []):
  Promise<Context> {
  at(preflightAt);
  const out = await createLivePreflightTool(createMultichainTool(provider().fetchFn))({
    selectedNetworkId: BASE, probeSubject: EVM_PROBE, request: preflightRequest(BASE, required, desired),
  });
  return callerContext(EVM_SUBJECT, out.preflight, out.capabilitySnapshot);
}

/** SIMULATED_REPLAY_CLOCK pre-execution Solana probe: the source does not know the signature yet. */
async function solanaContext(): Promise<{ raw: Context; preflight: PreflightResult; capabilitySnapshot: CapabilitySnapshot }> {
  at(SOL_PREFLIGHT_AT);
  const probe = await createMultichainTool(provider({ solanaBeforeExecution: true }).fetchFn)({ subject: SOL_SUBJECT });
  expect(probe.acquisition).toMatchObject({ transactionObserved: false, blockObserved: false });
  const source = foundationFromObservation(probe);
  if (source.family !== "solana") throw new Error("expected the Solana BEFORE foundation");
  const preflight = deriveSolanaBeforePreflightResult(source.foundation, preflightRequest(SOL, ["execution", "finality"]));
  const capabilitySnapshot = source.foundation.snapshot;
  return {
    raw: callerContext(SOL_SUBJECT, wire("preflight-result", preflight), wire("capability-snapshot", capabilitySnapshot)),
    preflight, capabilitySnapshot,
  };
}

/** Split a served envelope: everything but evidenceResult must be the no-context envelope, byte for byte. */
function splitEnvelope(out: any): { text: string; envelope: any; rest: string; evidenceResult: any } {
  expect(out.isError).toBeFalsy();
  const text = out.content[0].text as string;
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MULTICHAIN_RESULT_MAX_BYTES);
  const envelope = JSON.parse(text);
  expect(out.structuredContent).toEqual(envelope);
  const { evidenceResult, ...rest } = envelope;
  return { text, envelope, rest: JSON.stringify(rest), evidenceResult };
}

/** Core re-verifies the served result with the COMPLETE caller context and the pinned manifest. */
function verifyServed(evidenceResult: any, raw: Context) {
  expect(evidenceResult).toMatchObject({
    status: "composed", artifactType: "network-evidence-result", preExecutionBinding: "core_preflight_continuity",
  });
  expect(evidenceResult.nonClaims).toEqual([...LIVE_RESULT_NON_CLAIMS]);
  const result = decodeNecWireJson("network-evidence-result", JSON.stringify(evidenceResult.result));
  const snapshot = decodeNecWireJson("evidence-snapshot", JSON.stringify(evidenceResult.evidenceSnapshot));
  const manifest = decodeNecWireJson("resolver-manifest", JSON.stringify(evidenceResult.resolverManifest));
  const request = decodeNecWireJson("evidence-request", JSON.stringify(raw.request));
  const preflight = decodeNecWireJson("preflight-result", JSON.stringify(raw.preflight));
  const capabilitySnapshot = decodeNecWireJson("capability-snapshot", JSON.stringify(raw.capabilitySnapshot));
  const context = {
    policy: request.evidencePolicy, snapshot, resolver: manifest, request, preflight,
    preflightContext: { resolver: manifest, capabilitySnapshot },
  };
  expect(verifyNetworkEvidenceResult(result, context)).toBe(true);
  expect(result.request).toEqual({ requestId: "ne-p3-result", digest: computeEvidenceRequestDigest(request) });
  expect(request.preflight).toEqual({ requestId: "ne-p3-preflight", digest: preflight.artifactDigest });
  return { result, snapshot, manifest, request, preflight };
}

/** The SIMULATED_REPLAY_CLOCK label holds and nothing served claims precedence or policy satisfaction. */
function expectSimulatedBefore(evidenceResult: any, preflight: PreflightResult, pinnedAt: string, blockAt: string): void {
  expect(SIMULATED_BEFORE).toEqual({ clock: "SIMULATED_REPLAY_CLOCK", fixedBeforeExecution: false });
  expect(preflight.generatedAt).toBe(pinnedAt);
  expect(Date.parse(preflight.generatedAt)).toBeLessThan(Date.parse(blockAt));
  const nonClaims = (evidenceResult.nonClaims as string[]).join(" ");
  expect(nonClaims).toMatch(/Continuity is not precedence/);
  expect(nonClaims).toMatch(/not policy satisfaction/);
  expect(JSON.stringify(evidenceResult)).not.toMatch(/fixedBeforeExecution"\s*:\s*true/);
}

describe("resolve_transaction_evidence without evidenceContext is unchanged", () => {
  it("pinned Base and Solana envelopes are byte-identical to the unchanged observation, same reads, same six-tool surface", async () => {
    for (const [subject, afterAt, reads] of [[EVM_SUBJECT, EVM_AFTER_AT, BASE_READS], [SOL_SUBJECT, SOL_AFTER_AT, SOL_READS]] as const) {
      at(afterAt);
      const direct = provider();
      const observation = await createMultichainTool(direct.fetchFn)({ subject });
      expect(direct.reads).toEqual(reads);
      const p = provider();
      await hosted(p, async (call, client) => {
        const { tools } = await client.listTools();
        expect(tools.map(t => t.name).sort()).toEqual([...LIVE_TOOL_NAMES].sort());
        const tool = tools.find(t => t.name === LIVE_MULTICHAIN_TOOL)!;
        expect(tool.annotations).toEqual({
          title: tool.title, readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true,
        });
        const input = tool.inputSchema as any;
        expect(Object.keys(input.properties).sort()).toEqual(["claim", "evidenceContext", "includeL2Finality", "subject"]);
        expect(input.required).toEqual(["subject"]);
        expect(Object.keys((tool.outputSchema as any).properties)).toContain("evidenceResult");

        const out = await call(LIVE_MULTICHAIN_TOOL, { subject });
        expect(out.isError).toBeFalsy();
        expect(out.content[0].text).toBe(JSON.stringify(observation));
        expect(out.structuredContent).not.toHaveProperty("evidenceResult");
        expect(p.reads).toEqual(reads);
      });
    }
  });
});

describe("resolve_transaction_evidence with evidenceContext (SIMULATED_REPLAY_CLOCK BEFOREs)", () => {
  it("EVM: hosted preflight + evidenceContext composes a Core-verified result in both SDK eras; envelope byte-identical around it, same reads", async () => {
    const served: string[] = [];
    for (const mode of ["legacy", "auto"] as const) {
      const p = provider();
      await hosted(p, async (call) => {
        const raw = await hostedEvmContext(call, EVM_PREFLIGHT_AT, ["execution", "dataBinding"], ["observedEffects", "finality"]);
        at(EVM_AFTER_AT);
        const plain = await call(LIVE_MULTICHAIN_TOOL, { subject: EVM_SUBJECT });
        expect(p.reads).toEqual(BASE_READS);
        const out = await call(LIVE_MULTICHAIN_TOOL, { subject: EVM_SUBJECT, evidenceContext: raw });
        // No extra RPC: the context adds no read.
        expect(p.reads).toEqual(BASE_READS);
        const { text, envelope, rest, evidenceResult } = splitEnvelope(out);
        expect(rest).toBe(plain.content[0].text);
        expect(Object.keys(envelope).at(-1)).toBe("evidenceResult");
        served.push(text);

        const { result, snapshot, manifest, preflight } = verifyServed(evidenceResult, raw);
        expectSimulatedBefore(evidenceResult, preflight, EVM_PREFLIGHT_AT, EVM_BLOCK_AT);
        expect(manifest).toEqual(evmBeforeResolverManifest());
        expect(result.resolver).toEqual({ id: "resolver-evm-generic", version: "0.1.0", digest: manifest.digest });
        expect(result.action).toEqual(EVM_ACTION);
        expect(result.generatedAt).toBe(EVM_AFTER_AT);
        expect(result.network.observedAt.timestamp).toBe(EVM_BLOCK_AT);
        expect(snapshot.createdAt).toBe(EVM_AFTER_AT);

        const fragment = decodeNecWireJson("network-evidence-fragment", JSON.stringify(envelope.fragment));
        expect(result.networkEvidence.execution).toEqual(fragment.networkEvidence.execution);
        expect(result.networkEvidence.execution.verdict).toBe("supported");
        expect(result.networkEvidence.dataBinding).toEqual(fragment.networkEvidence.dataBinding);
        expect(result.networkEvidence.observedEffects).toEqual(fragment.networkEvidence.observedEffects);
        expect(result.evidence).toEqual(fragment.evidence);
        expect(result.warnings).toEqual(fragment.warnings);
        // Unavailable settlement and finality stay unknown, citing the fragment's own warning.
        for (const name of ["settlement", "finality"] as const) {
          expect(fragment.networkEvidence).not.toHaveProperty(name);
          expect(result.networkEvidence[name]).toMatchObject({ applicability: "unknown", basis: [], evidence: [] });
          expect(result.networkEvidence[name]).not.toHaveProperty("verdict");
          expect(result.networkEvidence[name].reason).toMatch(/^EVM_DIMENSIONS_NOT_EVALUATED: /);
        }
        expect(text).not.toContain("mainnet.base.org");
      }, mode);
    }
    // Pinned under replay: two eras, two servers, same instants, same bytes.
    expect(served).toHaveLength(2);
    expect(served[1]).toBe(served[0]);
  });

  it("EVM with includeL2Finality: the served OP Stack fragment is never merged; finality stays unknown with no foreign evidence", async () => {
    const p = provider();
    await hosted(p, async (call) => {
      const raw = await hostedEvmContext(call, EVM_PREFLIGHT_AT, ["execution"], ["finality"]);
      at(OP_AT);
      const plain = await call(LIVE_MULTICHAIN_TOOL, { subject: EVM_SUBJECT, includeL2Finality: true });
      const plainReads = [...p.reads];
      // Every recorded capture of the pair is read exactly once (opstack-semantic-gate.test.ts).
      expect(plainReads).toHaveLength(subjectRaw.captures.length + opStackRaw.captures.length);
      const out = await call(LIVE_MULTICHAIN_TOOL, { subject: EVM_SUBJECT, includeL2Finality: true, evidenceContext: raw });
      expect(p.reads).toEqual(plainReads);
      const { envelope, rest, evidenceResult } = splitEnvelope(out);
      expect(rest).toBe(plain.content[0].text);

      // Positive control: the served supplement really asserts OP Stack L2 block finality for this subject.
      expect(envelope.opStackFinality).toMatchObject({
        toolStatus: "evaluated", withdrawalFinalization: "not_evaluated", ethereumSettlement: "not_evaluated",
      });
      const op = decodeNecWireJson("network-evidence-fragment", JSON.stringify(envelope.opStackFinality.fragment));
      expect(op.networkEvidence.finality?.verdict).toBe("supported");

      const { result, preflight } = verifyServed(evidenceResult, raw);
      expectSimulatedBefore(evidenceResult, preflight, EVM_PREFLIGHT_AT, EVM_BLOCK_AT);
      expect(result.networkEvidence.finality).toMatchObject({ applicability: "unknown", basis: [], evidence: [] });
      expect(result.networkEvidence.finality).not.toHaveProperty("verdict");
      expect(result.networkEvidence.finality.reason).toMatch(/^EVM_DIMENSIONS_NOT_EVALUATED: /);
      const fragment = decodeNecWireJson("network-evidence-fragment", JSON.stringify(envelope.fragment));
      expect(result.evidence).toEqual(fragment.evidence);
      expect(result.warnings).toEqual(fragment.warnings);
      const mainIds = new Set(fragment.evidence.map(ref => ref.id));
      const foreign = op.evidence.filter(ref => !mainIds.has(ref.id));
      expect(foreign.length).toBeGreaterThan(0);
      const resultIds = new Set(result.evidence.map(ref => ref.id));
      for (const ref of foreign) expect(resultIds.has(ref.id)).toBe(false);
      expect(result.resolver.digest).toBe(evmBeforeResolverManifest().digest);
    });
  });

  it("Solana: SIMULATED null pre-execution probe + evidenceContext composes; settlement unknown, source-reported finality verbatim", async () => {
    const { raw, preflight: native } = await solanaContext();
    expect(native.status).toBe("unknown");
    at(SOL_AFTER_AT);
    const p = provider();
    await hosted(p, async (call) => {
      const plain = await call(LIVE_MULTICHAIN_TOOL, { subject: SOL_SUBJECT });
      expect(p.reads).toEqual(SOL_READS);
      const out = await call(LIVE_MULTICHAIN_TOOL, { subject: SOL_SUBJECT, evidenceContext: raw });
      expect(p.reads).toEqual(SOL_READS);
      const { envelope, rest, evidenceResult } = splitEnvelope(out);
      expect(rest).toBe(plain.content[0].text);

      const { result, manifest, preflight } = verifyServed(evidenceResult, raw);
      expectSimulatedBefore(evidenceResult, preflight, SOL_PREFLIGHT_AT, SOL_BLOCK_AT);
      expect(manifest).toEqual(solanaBeforeResolverManifest());
      expect(result.resolver).toEqual({ id: "resolver-solana-before", version: "0.1.0", digest: manifest.digest });
      expect(result.action).toEqual(SOL_ACTION);
      expect(result.network.observedAt.timestamp).toBe(SOL_BLOCK_AT);
      const fragment = decodeNecWireJson("network-evidence-fragment", JSON.stringify(envelope.fragment));
      expect(result.networkEvidence.execution).toEqual(fragment.networkEvidence.execution);
      expect(result.networkEvidence.finality).toEqual(fragment.networkEvidence.finality);
      expect(result.networkEvidence.observedEffects).toEqual(fragment.networkEvidence.observedEffects);
      expect(fragment.networkEvidence).not.toHaveProperty("settlement");
      expect(result.networkEvidence.settlement).toMatchObject({ applicability: "unknown", basis: [], evidence: [] });
      expect(result.networkEvidence.settlement).not.toHaveProperty("verdict");
      expect(result.networkEvidence.settlement.reason).toMatch(/^SOLANA_SETTLEMENT_NOT_EVALUATED: /);
      expect(envelope.nonClaims.join(" ")).toMatch(/source-reported/);
    });
  });

  it("a preflight at the block instant is not_composed preflight_not_before_block; the observation is returned unchanged", async () => {
    const p = provider();
    await hosted(p, async (call) => {
      const raw = await hostedEvmContext(call, EVM_BLOCK_AT, ["execution"]);
      at(EVM_AFTER_AT);
      const plain = await call(LIVE_MULTICHAIN_TOOL, { subject: EVM_SUBJECT });
      const out = await call(LIVE_MULTICHAIN_TOOL, { subject: EVM_SUBJECT, evidenceContext: raw });
      expect(p.reads).toEqual(BASE_READS);
      const { rest, evidenceResult } = splitEnvelope(out);
      expect(rest).toBe(plain.content[0].text);
      expect(evidenceResult).toEqual({ status: "not_composed", reason: "preflight_not_before_block" });
    });
  });
});

describe("refused evidenceContext and the final envelope budget", () => {
  it("exact safe MCP_EVIDENCE_CONTEXT_* errors, zero provider reads and no budget charge; efda0ca-shaped is never a BEFORE", async () => {
    const good = await inProcessEvmContext(EVM_PREFLIGHT_AT, ["execution", "dataBinding"]);
    // The hosted server (and its fixed budget window) starts at the frozen AFTER instant: one window for every call below.
    at(EVM_AFTER_AT);
    const p = provider();
    await hosted(p, async (call) => {
      const goodRequest = good.request as Record<string, any>;
      const { preflight: _ref, ...requestWithoutPreflight } = goodRequest;
      // efda0ca-shaped: AFTER-only, no preflight, policy authored after the block.
      const efdaRequest: EvidenceRequest = {
        schemaVersion: "0.1", requestId: "efda0ca-shaped", networkId: BASE,
        subject: { type: "transaction", networkId: BASE, txId: EVM_SUBJECT.txId },
        action: EVM_ACTION,
        evidencePolicy: policyOf({
          id: "efda0ca-shaped-policy", version: "2026-10-26", requiredDimensions: ["execution", "observedEffects"],
          rules: { authoredAt: "2026-10-26T00:00:00.000Z" },
        }),
      };
      expect(Date.parse("2026-10-26T00:00:00.000Z")).toBeGreaterThan(Date.parse(EVM_BLOCK_AT));
      const cases: Array<[string, unknown, string]> = [
        ["efda0ca-shaped AFTER-only request", { request: wire("evidence-request", efdaRequest) }, NO_PREFLIGHT],
        ["efda0ca-shaped request with a snapshot", { request: wire("evidence-request", efdaRequest), capabilitySnapshot: good.capabilitySnapshot }, NO_PREFLIGHT],
        ["request.preflight absent", { ...good, request: requestWithoutPreflight }, NO_PREFLIGHT],
        ["preflight artifact absent", { request: good.request, capabilitySnapshot: good.capabilitySnapshot }, NO_PREFLIGHT],
        ["caller resolverManifest key", { ...good, resolverManifest: { id: CALLER_TEXT } }, CALLER_MANIFEST],
        ["caller manifest key", { ...good, manifest: CALLER_TEXT }, CALLER_MANIFEST],
        ["swapped action", { ...good, request: { ...goodRequest, action: { ...EVM_ACTION, fields: { expectedStatus: "reverted" } } } }, INVALID],
        ["forged preflight artifactDigest", { ...good, preflight: { ...good.preflight, artifactDigest: `sha256:${"0".repeat(64)}` } }, INVALID],
        ["unknown key", { ...good, note: CALLER_TEXT }, INVALID],
        ["request is not a Core EvidenceRequest", { request: { note: CALLER_TEXT } }, INVALID],
        ["oversized context", { ...good, request: { ...goodRequest, metadata: { note: CALLER_TEXT, padding: "x".repeat(EVIDENCE_CONTEXT_MAX_BYTES) } } }, TOO_LARGE],
      ];
      for (const [label, evidenceContext, code] of cases) {
        const out = await call(LIVE_MULTICHAIN_TOOL, { subject: EVM_SUBJECT, evidenceContext });
        expect(out.isError, label).toBe(true);
        expect(out.structuredContent, label).toBeUndefined();
        const text = out.content[0].text as string;
        const parsed = JSON.parse(text);
        expect(Object.keys(parsed), label).toEqual(["error"]);
        expect(parsed.error.code, label).toBe(code);
        expect(parsed.error.cause, label).toBeNull();
        if (code === INVALID) expect(parsed.error.message, label).toMatch(/^evidenceContext rejected before any RPC read: /);
        else expect(parsed.error.message, label).toBe(MESSAGES[code]);
        expect(text, label).not.toContain(CALLER_TEXT);
        expect(text, label).not.toContain("x".repeat(64));
        expect(p.reads, label).toEqual([]);
      }

      // No budget was taken: all eight admissions of the window are still free (seven plain calls, then one with context).
      for (let n = 0; n < MULTICHAIN_CALLS_PER_MINUTE - 1; n++) {
        expect((await call(LIVE_MULTICHAIN_TOOL, { subject: EVM_SUBJECT })).isError).toBeFalsy();
        expect(p.reads).toEqual(BASE_READS);
      }
      const last = await call(LIVE_MULTICHAIN_TOOL, { subject: EVM_SUBJECT, evidenceContext: good });
      expect(splitEnvelope(last).evidenceResult.status).toBe("composed");
      const over = await call(LIVE_MULTICHAIN_TOOL, { subject: EVM_SUBJECT, evidenceContext: good });
      expect(JSON.parse(over.content[0].text).error.code).toBe("MCP_MULTICHAIN_RATE_LIMIT");
      expect(p.reads).toEqual([]);
    });
  });

  it("the final assembled envelope is measured once against MULTICHAIN_RESULT_MAX_BYTES and refused whole, never truncated", async () => {
    const raw = await inProcessEvmContext(EVM_PREFLIGHT_AT, ["execution"]);
    at(EVM_AFTER_AT);
    /** SIMULATED: the real observation with one padding non-claim appended (pad bytes, ASCII). */
    const padded = (pad: number): MultichainTool => {
      const inner = createMultichainTool(provider().fetchFn);
      return async (input) => {
        const observation = await inner(input);
        return { ...observation, nonClaims: [...observation.nonClaims, "x".repeat(pad)] };
      };
    };
    const marker = { status: "not_composed", reason: "output_budget" };
    const unpadded = await padded(0)({ subject: EVM_SUBJECT });
    const base = Buffer.byteLength(JSON.stringify({ ...unpadded, evidenceResult: marker }));
    const room = MULTICHAIN_RESULT_MAX_BYTES - base;
    expect(room).toBeGreaterThan(0);

    // A composed result that cannot fit is an explicit not_composed outcome; the envelope fits exactly.
    const fits = await resolveWithOptionalClaim(padded(room), { subject: EVM_SUBJECT, evidenceContext: raw });
    expect(fits.evidenceResult).toEqual(marker);
    expect(Buffer.byteLength(JSON.stringify(fits))).toBe(MULTICHAIN_RESULT_MAX_BYTES);
    expect(fits.nonClaims.at(-1)).toHaveLength(room);

    // One byte more: the whole envelope is refused, nothing is returned partially.
    await expect(resolveWithOptionalClaim(padded(room + 1), { subject: EVM_SUBJECT, evidenceContext: raw }))
      .rejects.toMatchObject({ code: "MCP_MULTICHAIN_TOO_LARGE", message: expect.stringMatching(/nothing is truncated/) });

    // Without padding the same context composes in-process, under the same cap.
    const composed = await resolveWithOptionalClaim(padded(0), { subject: EVM_SUBJECT, evidenceContext: raw });
    expect(composed.evidenceResult?.status).toBe("composed");
    expect(Buffer.byteLength(JSON.stringify(composed))).toBeLessThanOrEqual(MULTICHAIN_RESULT_MAX_BYTES);
  });
});
