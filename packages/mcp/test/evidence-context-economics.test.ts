/**
 * NE-L040 (P1 of NE-L038): test-only measurement of the evidenceContext
 * economics of the EXISTING resolve_transaction_evidence tool. Nothing in src
 * changes and no limit is raised; this file only measures and pins.
 *
 *  - H-A  pre-budget CPU of prepareEvidenceContext (largest valid context,
 *         same-size context failing only at the last check, context just
 *         under the 1 MiB HTTP body cap).
 *  - H-B  served bytes with and without evidenceResult at the hosted
 *         tools/call surface, the tripled nativeSource payloads, and the
 *         padding room at which composed flips to not_composed/output_budget.
 *  - F2   claim + context: the composer's own pre-check passes but the final
 *         envelope exceeds MULTICHAIN_RESULT_MAX_BYTES, so the whole call is
 *         refused (the exception to packages/mcp/README.md:560-561).
 *  - H-D  wall time of prepare and compose on the recorded observations.
 *  - H-E  every provider request (URL + full body) with and without context.
 *
 * Measured numbers are printed as `NE-L040-MEASURE <label> <json>` lines, and
 * the H-A and H-D timings are repeated as a short `NE-L040-SUMMARY` block after
 * the last test of this file so they survive a truncated log tail; the
 * assertions only pin generous ceilings and exact byte relations.
 *
 * Truth labels:
 *  - Recorded inputs: the Base 0x71c9…625c subject fixture, the F1 x402 #1062
 *    Base probe fixture, the Solana 4DYWUMEx…LF71 fixture and the
 *    adapter-erc4337 Base mainnet redeem-bundle fixture (RPC result bytes).
 *  - SIMULATED: every BEFORE (SIMULATED_REPLAY_CLOCK, fixedBeforeExecution:
 *    false; the Solana pre-execution probe is a SIMULATED null answer), the
 *    test-authored action and policy, the request.metadata padding, the
 *    nonClaims padding of the observation (the live-result-tool.test.ts:508-514
 *    approach) and the erc4337 claim terms. None of them is an original
 *    caller's action, policy or protocol terms; continuity is not precedence.
 *
 * Offline only: providers serve recorded bytes for the fixed origins and refuse
 * anything else; global fetch throws and is counted (must stay 0). Only Date is
 * faked; wall time is read from performance.now(), which is not faked.
 */
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { computeEvidencePolicyDigest, decodeNecWireJson, encodeNecWireJson } from "@nec/core";
import type {
  EvidencePolicy, EvidenceRequest, NecWireType, PolicyDimension, PreflightRequest, PreflightResult,
} from "@nec/core";
import { ENTRY_POINT_V0_7_OBSERVED_ON_BASE } from "@nec/adapter-erc4337";
import { deriveSolanaBeforePreflightResult } from "@nec/resolver-solana";
import { DEFAULT_MAX_BODY_BYTES, startNeMcpHttpServer } from "../src/http.js";
import { HOSTED_DEFAULT_LIMITS } from "../src/limits.js";
import { foundationFromObservation } from "../src/live-before.js";
import { resolveWithOptionalClaim } from "../src/live-claim.js";
import type { ClaimBoundObservation, OptionalClaim } from "../src/live-claim.js";
import {
  createMultichainTool, LIVE_MULTICHAIN_TOOL, LIVE_TOOL_DEADLINE_MS, MULTICHAIN_CALLS_PER_MINUTE,
  MULTICHAIN_RESULT_MAX_BYTES,
} from "../src/live-multichain.js";
import type { MultichainTool, TransactionSubject } from "../src/live-multichain.js";
import { createLivePreflightTool } from "../src/live-preflight.js";
import {
  composeNetworkEvidenceResult, EVIDENCE_CONTEXT_MAX_BYTES, EvidenceContextError, prepareEvidenceContext,
} from "../src/live-result.js";
import { simulatedHostFetch } from "./helpers.js";

interface Capture { rpcMethod: string; resultJson: string }
interface BaseFixture { acquiredAt: string; subject: { txHash: string }; captures: Capture[] }
const json = (path: string): any => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const subjectRaw: BaseFixture = json("./fixtures/base-mainnet-l2-finalized-positive-evm.json");
const probeRaw: BaseFixture = json(
  "../../../examples/historical-compat/authority/fixtures/F1-x402-1062-partial/source/network-evidence/fixtures/base-mainnet-x402-1062-usdc-transfer.fixture.json");
const ercRaw: BaseFixture = json("../../adapter-erc4337/test/fixtures/base-mainnet-redeem-bundle.json");
const solRaw = json("../../resolver-solana/test/fixtures/solana-mainnet-x402-real.json");

const ORIGIN = "https://mcp.example.org";
const HOST = "mcp.example.org";
const BASE_URL = "https://mainnet.base.org/";
const SOL_URL = "https://api.mainnet-beta.solana.com/";
const BASE = "eip155:8453" as const;
const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" as const;
const EVM_SUBJECT: TransactionSubject = { type: "transaction", networkId: BASE, txId: subjectRaw.subject.txHash };
const EVM_PROBE: TransactionSubject = { type: "transaction", networkId: BASE, txId: probeRaw.subject.txHash };
const SOL_SUBJECT: TransactionSubject = { type: "transaction", networkId: SOL, txId: solRaw.subject.signature };
const ERC_SUBJECT: TransactionSubject = { type: "transaction", networkId: BASE, txId: ercRaw.subject.txHash };

/** SIMULATED_REPLAY_CLOCK instants (identical to live-result-tool.test.ts for the two pinned subjects). */
const EVM_PREFLIGHT_AT = "2026-10-09T15:00:00.000Z";
const EVM_AFTER_AT = "2026-10-09T15:42:11.665Z"; // recorded acquisition time of the subject fixture
const SOL_PREFLIGHT_AT = "2026-05-10T20:00:00.000Z";
const SOL_AFTER_AT = "2026-08-26T20:01:41.884Z"; // recorded acquisition time of the Solana fixture
/**
 * SIMULATED_REPLAY_CLOCK for the erc4337 bundle: after the F1 probe block
 * (0x697e667d, 2026-01-31) and before the bundle block (0x69f1190b,
 * 2026-04-28). The AFTER is read at the fixture's recorded acquisition time.
 */
const ERC_PREFLIGHT_AT = "2026-04-01T00:00:00.000Z";
const ERC_AFTER_AT = ercRaw.acquiredAt;

const BASE_READS = ["eth_chainId", "eth_getTransactionReceipt", "eth_getBlockByHash", "eth_getTransactionByHash"];
const SOL_READS = ["getGenesisHash", "getTransaction", "getSignatureStatuses", "getBlock"];
const MAX = MULTICHAIN_RESULT_MAX_BYTES;
const TOO_LARGE = "MCP_EVIDENCE_CONTEXT_TOO_LARGE";
const INVALID = "MCP_EVIDENCE_CONTEXT_INVALID";
const POLICY_MISMATCH = "evidenceContext rejected before any RPC read: the preflighted evidence policy differs from the request evidence policy";
const CEILING_MS = 1_000;
const ITERATIONS = 25;
/** NE-L038: hosted default HTTP /mcp admissions per minute, and the recorded beta rate. */
const HOSTED_RATE_PER_MINUTE = HOSTED_DEFAULT_LIMITS.maxRequestsPerMinute;
const RECORDED_BETA_RATE_PER_MINUTE = 24;
const MARKER = "NE_L040_CALLER_CONTEXT_MARKER_NEVER_SENT";
const OUTPUT_BUDGET = { status: "not_composed", reason: "output_budget" };
const TIMEOUT = 120_000;

/** The label every BEFORE of this file carries; none is a genuine pre-execution fix. */
const SIMULATED_BEFORE = Object.freeze({ clock: "SIMULATED_REPLAY_CLOCK", fixedBeforeExecution: false } as const);

/**
 * SIMULATED erc4337 claim terms (adapter-erc4337 base-mainnet-redeem-bundle.json):
 * userOpHash and sender copied from the pinned on-chain UserOperationEvent, as in
 * live-claim-verdicts.test.ts. Not an original caller's protocol terms.
 */
const ERC_CLAIM: OptionalClaim = {
  protocol: "erc4337",
  claim: {
    network: BASE, bundleTransactionHash: ERC_SUBJECT.txId,
    entryPoint: ENTRY_POINT_V0_7_OBSERVED_ON_BASE,
    entryPointProfile: "v0.7",
    userOperation: {
      userOpHash: "0x94e3b302718e1f594c903cdb8237741c02edf12495cc78b34e30b9cfcfe5ae31",
      sender: "0xf64dd2892370f6d75aa1bd0f10da312235a06a1e",
    },
  },
};

// ---------------------------------------------------------------------------
// Offline provider: recorded bytes only; every request (URL + full body) logged
// ---------------------------------------------------------------------------

interface ProviderRequest { readonly url: string; readonly body: string }

/**
 * `base`: the ONE recorded Base fixture served (by method; each fixture holds
 * exactly one capture per method). Solana: the recorded answer per method;
 * `solanaBeforeExecution` is the SIMULATED null pre-execution answer.
 */
function provider(base: BaseFixture | null, options: { solanaBeforeExecution?: boolean } = {}) {
  const requests: ProviderRequest[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw).href;
    const body = init?.body;
    if (typeof body !== "string") throw new Error("provider request without a string body");
    requests.push({ url: raw, body });
    const query = JSON.parse(body) as { id: unknown; method: string };
    let resultText: string;
    if (url === BASE_URL && base !== null) {
      const found = base.captures.find(c => c.rpcMethod === query.method);
      if (found === undefined) throw new Error("undeclared Base read");
      resultText = found.resultJson;
    } else if (url === SOL_URL) {
      const found = (solRaw.captures as Capture[]).find(c => c.rpcMethod === query.method);
      if (found === undefined) throw new Error("undeclared Solana read");
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
  return { fetchFn, requests };
}

type Call = (name: string, args: Record<string, unknown>) => Promise<any>;

/** One hosted live-mode server (SDK client, loopback, SIMULATED public Host). */
async function hosted(tool: MultichainTool, run: (call: Call) => Promise<void>): Promise<void> {
  const server = await startNeMcpHttpServer({
    host: "127.0.0.1", port: 0, hosted: { publicOrigin: ORIGIN }, liveEvidence: tool,
  });
  try {
    const client = new Client({ name: "evidence-context-economics-test", version: "1" }, { versionNegotiation: { mode: "auto" } });
    await client.connect(new StreamableHTTPClientTransport(new URL(ORIGIN + "/mcp"), { fetch: simulatedHostFetch(server.port, HOST) }));
    try {
      await run(async (name, args) => await client.callTool({ name, arguments: args }));
    } finally { await client.close(); }
  } finally { await server.close(); }
}

/** SIMULATED: the real observation with one padding non-claim appended (pad ASCII bytes). */
function padTool(inner: MultichainTool, pad: number): MultichainTool {
  return async (input) => {
    const observation = await inner(input);
    return { ...observation, nonClaims: [...observation.nonClaims, "x".repeat(pad)] };
  };
}

const realFetch = globalThis.fetch;
let globalFetchCalls = 0;
beforeAll(() => {
  globalThis.fetch = (async () => {
    globalFetchCalls += 1;
    throw new Error("network I/O is forbidden in evidence-context-economics tests");
  }) as typeof fetch;
});
afterAll(() => { globalThis.fetch = realFetch; });
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); });
afterEach(() => {
  vi.useRealTimers();
  expect(globalFetchCalls).toBe(0);
});

// ---------------------------------------------------------------------------
// Context construction (test-authored action and policy; SIMULATED BEFOREs)
// ---------------------------------------------------------------------------

function at(iso: string): void {
  vi.setSystemTime(new Date(iso));
}
function wire(type: NecWireType, value: unknown): Record<string, unknown> {
  return JSON.parse(encodeNecWireJson(type, value)) as Record<string, unknown>;
}
function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}
function policyOf(content: Omit<EvidencePolicy, "digest">): EvidencePolicy {
  return { ...content, digest: computeEvidencePolicyDigest(content) };
}
const EVM_ACTION = { kind: "evm.transaction", target: "0x4200000000000000000000000000000000000015", fields: { expectedStatus: "success" } };
const SOL_ACTION = { kind: "spl_token.transfer_checked", target: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", fields: { expectedAmount: "5000" } };

function preflightRequest(networkId: string, required: PolicyDimension[]): PreflightRequest {
  return {
    schemaVersion: "0.1", requestId: "ne-l040-preflight", networkId,
    action: networkId === BASE ? EVM_ACTION : SOL_ACTION,
    evidencePolicy: policyOf({ id: "ne-l040-policy", version: "1", requiredDimensions: required }),
  };
}

interface Parts {
  readonly subject: TransactionSubject;
  readonly preflight: Record<string, unknown>;
  readonly capabilitySnapshot: Record<string, unknown>;
  /** The later EvidenceRequest (runtime form): action and policy come from the preflighted request. */
  readonly request: EvidenceRequest;
}

function partsOf(subject: TransactionSubject, preflight: Record<string, unknown>, capabilitySnapshot: Record<string, unknown>): Parts {
  const decoded: PreflightResult = decodeNecWireJson("preflight-result", JSON.stringify(preflight));
  const request: EvidenceRequest = {
    schemaVersion: "0.1", requestId: "ne-l040-result", networkId: subject.networkId,
    subject: { type: "transaction", networkId: subject.networkId, txId: subject.txId },
    action: decoded.request.action,
    evidencePolicy: decoded.request.evidencePolicy,
    preflight: { requestId: decoded.request.requestId, digest: decoded.artifactDigest },
  };
  return { subject, preflight, capabilitySnapshot, request };
}

/** The caller's evidenceContext in wire form; `change` replaces request fields (Core-encoded, so always valid wire). */
function contextOf(parts: Parts, change: Partial<Pick<EvidenceRequest, "metadata" | "evidencePolicy">> = {}): Record<string, unknown> {
  const request: EvidenceRequest = { ...parts.request, ...change };
  return { request: wire("evidence-request", request), preflight: parts.preflight, capabilitySnapshot: parts.capabilitySnapshot };
}

/** SIMULATED request.metadata padding so that JSON.stringify(context) is exactly `target` bytes. */
function contextOfSize(parts: Parts, target: number, change: Partial<Pick<EvidenceRequest, "evidencePolicy">> = {}): Record<string, unknown> {
  const base = bytes(contextOf(parts, { ...change, metadata: { padding: "" } }));
  const pad = target - base;
  expect(pad).toBeGreaterThan(0);
  const context = contextOf(parts, { ...change, metadata: { padding: "x".repeat(pad) } });
  expect(bytes(context)).toBe(target);
  return context;
}

/** SIMULATED_REPLAY_CLOCK hosted-equivalent Base preflight: probes the EARLIER completed F1 x402 #1062 transaction. */
async function evmParts(subject: TransactionSubject, preflightAt: string): Promise<Parts> {
  at(preflightAt);
  const out = await createLivePreflightTool(createMultichainTool(provider(probeRaw).fetchFn))({
    selectedNetworkId: BASE, probeSubject: EVM_PROBE, request: preflightRequest(BASE, ["execution", "dataBinding"]),
  });
  expect(out.preflight.generatedAt).toBe(preflightAt);
  return partsOf(subject, out.preflight, out.capabilitySnapshot);
}

/** SIMULATED_REPLAY_CLOCK pre-execution Solana probe: a SIMULATED null answer for the not-yet-existing signature. */
async function solanaParts(): Promise<Parts> {
  at(SOL_PREFLIGHT_AT);
  const probe = await createMultichainTool(provider(null, { solanaBeforeExecution: true }).fetchFn)({ subject: SOL_SUBJECT });
  expect(probe.acquisition).toMatchObject({ transactionObserved: false, blockObserved: false });
  const source = foundationFromObservation(probe);
  if (source.family !== "solana") throw new Error("expected the Solana BEFORE foundation");
  const preflight = deriveSolanaBeforePreflightResult(source.foundation, preflightRequest(SOL, ["execution", "finality"]));
  expect(preflight.generatedAt).toBe(SOL_PREFLIGHT_AT);
  return partsOf(SOL_SUBJECT, wire("preflight-result", preflight), wire("capability-snapshot", source.foundation.snapshot));
}

interface Family {
  readonly name: "base" | "solana";
  readonly subject: TransactionSubject;
  readonly afterAt: string;
  readonly fixture: BaseFixture | null;
  readonly reads: readonly string[];
  readonly parts: Parts;
}

async function families(): Promise<Family[]> {
  expect(EVM_SUBJECT.txId.startsWith("0x71c9")).toBe(true);
  expect(SOL_SUBJECT.txId.startsWith("4DYWUMEx")).toBe(true);
  expect(SOL_SUBJECT.txId.endsWith("LF71")).toBe(true);
  expect(SIMULATED_BEFORE).toEqual({ clock: "SIMULATED_REPLAY_CLOCK", fixedBeforeExecution: false });
  const base = await evmParts(EVM_SUBJECT, EVM_PREFLIGHT_AT);
  const solana = await solanaParts();
  return [
    { name: "base", subject: EVM_SUBJECT, afterAt: EVM_AFTER_AT, fixture: subjectRaw, reads: BASE_READS, parts: base },
    { name: "solana", subject: SOL_SUBJECT, afterAt: SOL_AFTER_AT, fixture: null, reads: SOL_READS, parts: solana },
  ];
}

// ---------------------------------------------------------------------------
// Measurement helpers
// ---------------------------------------------------------------------------

interface Timing { readonly iterations: number; readonly medianMs: number; readonly maxMs: number }

const round = (ms: number): number => Math.round(ms * 1000) / 1000;

/** Wall time of a synchronous, I/O-free call: the CPU cost of the call on one core. */
function measure(iterations: number, fn: () => void): Timing {
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return { iterations, medianMs: round(median), maxMs: round(sorted[sorted.length - 1]!) };
}

/** CPU-seconds per minute if every admitted HTTP /mcp request carried this context. */
function cpuSecondsPerMinute(timing: Timing): Record<string, number> {
  return {
    [`median_at_${HOSTED_RATE_PER_MINUTE}_per_min`]: round((HOSTED_RATE_PER_MINUTE * timing.medianMs) / 1000),
    [`max_at_${HOSTED_RATE_PER_MINUTE}_per_min`]: round((HOSTED_RATE_PER_MINUTE * timing.maxMs) / 1000),
    [`median_at_${RECORDED_BETA_RATE_PER_MINUTE}_per_min`]: round((RECORDED_BETA_RATE_PER_MINUTE * timing.medianMs) / 1000),
    [`max_at_${RECORDED_BETA_RATE_PER_MINUTE}_per_min`]: round((RECORDED_BETA_RATE_PER_MINUTE * timing.maxMs) / 1000),
  };
}

function report(label: string, data: unknown): void {
  console.log(`NE-L040-MEASURE ${label} ${JSON.stringify(data)}`);
}

/** Short H-A / H-D timing lines, printed once after the last test of this file. */
const summary: string[] = [];
afterAll(() => {
  if (summary.length > 0) console.log(["NE-L040-SUMMARY (median/max ms; CPU-s/min = rate * ms / 1000)", ...summary].join("\n"));
});
function fmt(timing: Timing): string {
  return `${timing.medianMs}/${timing.maxMs} ms (n=${timing.iterations})`;
}
function summarizeHA(label: string, timing: Timing): void {
  const cpu = cpuSecondsPerMinute(timing);
  const at240 = `${cpu[`median_at_${HOSTED_RATE_PER_MINUTE}_per_min`]}/${cpu[`max_at_${HOSTED_RATE_PER_MINUTE}_per_min`]}`;
  const at24 = `${cpu[`median_at_${RECORDED_BETA_RATE_PER_MINUTE}_per_min`]}/${cpu[`max_at_${RECORDED_BETA_RATE_PER_MINUTE}_per_min`]}`;
  summary.push(`H-A ${label}: ${fmt(timing)}; CPU-s/min @${HOSTED_RATE_PER_MINUTE} ${at240}, @${RECORDED_BETA_RATE_PER_MINUTE} ${at24}`);
}

/** Run fn and return what it threw; fails if it returned normally. */
function thrown(fn: () => unknown): unknown {
  try { fn(); } catch (error) { return error; }
  throw new Error("expected a refusal");
}

function expectRefusal(error: unknown, code: string, message?: string): void {
  expect(error).toBeInstanceOf(EvidenceContextError);
  expect((error as EvidenceContextError).code).toBe(code);
  if (message !== undefined) expect((error as EvidenceContextError).message).toBe(message);
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}
/** Number of JSON string values strictly equal to `needle` anywhere in `value`. */
function countValue(value: unknown, needle: string): number {
  if (value === needle) return 1;
  if (Array.isArray(value)) return value.reduce((n: number, item) => n + countValue(item, needle), 0);
  if (typeof value === "object" && value !== null) {
    return Object.values(value).reduce((n: number, item) => n + countValue(item, needle), 0);
  }
  return 0;
}
/** Every nativeSource payload string of the served fragment's evidence references. */
function nativePayloads(fragment: any): string[] {
  return (fragment.evidence as any[])
    .map(ref => ref?.nativeSource?.payload)
    .filter((payload): payload is string => typeof payload === "string");
}

// ---------------------------------------------------------------------------
// H-A
// ---------------------------------------------------------------------------

describe("H-A: CPU of prepareEvidenceContext before the live budget", () => {
  it("largest valid 65,536-byte context, same-size last-check failure, and a context just under the 1 MiB body cap", async () => {
    const parts = await evmParts(EVM_SUBJECT, EVM_PREFLIGHT_AT);
    at(EVM_AFTER_AT);

    // (a) the largest valid context: exactly EVIDENCE_CONTEXT_MAX_BYTES; one byte more is TOO_LARGE.
    expect(EVIDENCE_CONTEXT_MAX_BYTES).toBe(65_536);
    const largest = contextOfSize(parts, EVIDENCE_CONTEXT_MAX_BYTES);
    expect(prepareEvidenceContext(EVM_SUBJECT, largest).family).toBe("evm");
    expectRefusal(thrown(() => prepareEvidenceContext(EVM_SUBJECT, contextOfSize(parts, EVIDENCE_CONTEXT_MAX_BYTES + 1))), TOO_LARGE);
    const valid = measure(ITERATIONS, () => { prepareEvidenceContext(EVM_SUBJECT, largest); });

    // (b) same size, fails only at the last check (policy mismatch, live-result.ts:242): every
    // earlier check (decodes, Core verifications, digest/request binding, network, action) passes.
    const otherPolicy = policyOf({ id: "ne-l040-policy", version: "2", requiredDimensions: ["execution", "dataBinding"] });
    expect(otherPolicy.digest).not.toBe(parts.request.evidencePolicy.digest);
    const lastCheck = contextOfSize(parts, EVIDENCE_CONTEXT_MAX_BYTES, { evidencePolicy: otherPolicy });
    const lastCheckErrors: unknown[] = [];
    const policyMismatch = measure(ITERATIONS, () => {
      lastCheckErrors.push(thrown(() => prepareEvidenceContext(EVM_SUBJECT, lastCheck)));
    });
    expect(lastCheckErrors).toHaveLength(ITERATIONS);
    for (const error of lastCheckErrors) expectRefusal(error, INVALID, POLICY_MISMATCH);

    // (c) just under the 1 MiB HTTP body cap: the whole tools/call body still fits, the context is refused TOO_LARGE.
    const huge = contextOfSize(parts, DEFAULT_MAX_BODY_BYTES - 2_048);
    const rpcBody = {
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: LIVE_MULTICHAIN_TOOL, arguments: { subject: EVM_SUBJECT, evidenceContext: huge } },
    };
    expect(bytes(rpcBody)).toBeLessThan(DEFAULT_MAX_BODY_BYTES);
    expect(bytes(rpcBody)).toBeGreaterThan(DEFAULT_MAX_BODY_BYTES - 4_096);
    const hugeErrors: unknown[] = [];
    const tooLarge = measure(ITERATIONS, () => {
      hugeErrors.push(thrown(() => prepareEvidenceContext(EVM_SUBJECT, huge)));
    });
    expect(hugeErrors).toHaveLength(ITERATIONS);
    for (const error of hugeErrors) expectRefusal(error, TOO_LARGE, `evidenceContext exceeds ${EVIDENCE_CONTEXT_MAX_BYTES} bytes`);

    // The same near-cap context is admitted by the HTTP layer and refused by the tool with zero provider reads.
    const p = provider(subjectRaw);
    await hosted(createMultichainTool(p.fetchFn), async (call) => {
      const out = await call(LIVE_MULTICHAIN_TOOL, { subject: EVM_SUBJECT, evidenceContext: huge });
      expect(out.isError).toBe(true);
      expect(JSON.parse(out.content[0].text).error.code).toBe(TOO_LARGE);
      expect(p.requests).toEqual([]);
    });

    for (const timing of [valid, policyMismatch, tooLarge]) {
      expect(timing.iterations).toBeGreaterThanOrEqual(20);
      expect(timing.maxMs).toBeLessThan(CEILING_MS);
    }
    report("H-A", {
      clock: "performance.now (wall time of a synchronous, I/O-free call)",
      a_largest_valid_context: { contextBytes: EVIDENCE_CONTEXT_MAX_BYTES, ...valid, cpuSecondsPerMinute: cpuSecondsPerMinute(valid) },
      b_same_size_policy_mismatch: { contextBytes: EVIDENCE_CONTEXT_MAX_BYTES, ...policyMismatch, cpuSecondsPerMinute: cpuSecondsPerMinute(policyMismatch) },
      c_near_body_cap_too_large: { contextBytes: bytes(huge), toolsCallBodyBytes: bytes(rpcBody), ...tooLarge, cpuSecondsPerMinute: cpuSecondsPerMinute(tooLarge) },
    });
    summarizeHA(`(a) valid ${EVIDENCE_CONTEXT_MAX_BYTES} B`, valid);
    summarizeHA(`(b) policy mismatch ${EVIDENCE_CONTEXT_MAX_BYTES} B`, policyMismatch);
    summarizeHA(`(c) TOO_LARGE ${bytes(huge)} B`, tooLarge);
  }, TIMEOUT);
});

// ---------------------------------------------------------------------------
// H-B
// ---------------------------------------------------------------------------

describe("H-B: served bytes, tripled nativeSource and the output_budget flip", () => {
  it("hosted tools/call bytes with and without evidenceResult for Base 0x71c9 and Solana 4DYWUMEx…LF71", async () => {
    for (const family of await families()) {
      const context = contextOf(family.parts);
      at(family.afterAt);
      const p = provider(family.fixture);
      await hosted(createMultichainTool(p.fetchFn), async (call) => {
        const plain = await call(LIVE_MULTICHAIN_TOOL, { subject: family.subject });
        const composed = await call(LIVE_MULTICHAIN_TOOL, { subject: family.subject, evidenceContext: context });
        expect(plain.isError).toBeFalsy();
        expect(composed.isError).toBeFalsy();
        const plainText = plain.content[0].text as string;
        const text = composed.content[0].text as string;
        const envelope = JSON.parse(text);
        expect(composed.structuredContent).toEqual(envelope);
        expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX);
        const { evidenceResult, ...rest } = envelope;
        expect(evidenceResult.status).toBe("composed");
        expect(JSON.stringify(rest)).toBe(plainText);
        expect(Buffer.byteLength(text) - Buffer.byteLength(plainText))
          .toBe(Buffer.byteLength(`,"evidenceResult":${JSON.stringify(evidenceResult)}`));

        // Every nativeSource payload: once in the fragment, once in result.evidence, once in evidenceSnapshot.evidence.
        const payloads = nativePayloads(envelope.fragment);
        expect(payloads.length).toBeGreaterThan(0);
        // Fail closed: every evidence reference of the fragment carries a string nativeSource payload.
        expect(payloads).toHaveLength(envelope.fragment.evidence.length);
        for (const payload of payloads) {
          expect(payloads.filter(x => x === payload)).toHaveLength(1);
          expect(occurrences(plainText, payload)).toBe(1);
          expect(occurrences(text, payload)).toBe(3);
          expect(countValue(envelope.fragment, payload)).toBe(1);
          expect(countValue(evidenceResult.result.evidence, payload)).toBe(1);
          expect(countValue(evidenceResult.evidenceSnapshot.evidence, payload)).toBe(1);
          expect(countValue(envelope, payload)).toBe(3);
          // ok() serves the envelope as text AND as structuredContent: twice on the wire.
          expect(occurrences(JSON.stringify(plain), payload)).toBe(2);
          expect(occurrences(JSON.stringify(composed), payload)).toBe(6);
        }
        const payloadBytes = payloads.reduce((n, payload) => n + Buffer.byteLength(payload), 0);
        report(`H-B served ${family.name}`, {
          subject: family.subject.txId,
          withoutEvidenceResult: { contentTextBytes: Buffer.byteLength(plainText), callToolResultBytes: bytes(plain) },
          withEvidenceResult: { contentTextBytes: Buffer.byteLength(text), callToolResultBytes: bytes(composed) },
          evidenceResultBytes: bytes(evidenceResult),
          nativeSourcePayloads: payloads.length,
          nativeSourcePayloadBytesOnce: payloadBytes,
          nativeSourcePayloadBytesInComposedText: 3 * payloadBytes,
          nativeSourcePayloadBytesInComposedCallToolResult: 6 * payloadBytes,
          maxResultBytes: MAX,
        });
      });
    }
  }, TIMEOUT);

  it("padding room at which composed flips to not_composed/output_budget; the live admission is already taken", async () => {
    for (const family of await families()) {
      const context = contextOf(family.parts);
      at(family.afterAt);
      const fresh = () => createMultichainTool(provider(family.fixture).fetchFn);
      const input = { subject: family.subject, evidenceContext: context };

      const unpadded = await resolveWithOptionalClaim(padTool(fresh(), 0), input);
      expect(unpadded.evidenceResult?.status).toBe("composed");
      const composedRoom = MAX - bytes(unpadded);
      expect(composedRoom).toBeGreaterThan(0);

      // Largest padding that still composes: the envelope is exactly MULTICHAIN_RESULT_MAX_BYTES.
      const edge = await resolveWithOptionalClaim(padTool(fresh(), composedRoom), input);
      expect(edge.evidenceResult?.status).toBe("composed");
      expect(bytes(edge)).toBe(MAX);

      // One byte more: not_composed/output_budget, on a tool whose live admission this call already took.
      const p = provider(family.fixture);
      const inner = createMultichainTool(p.fetchFn);
      const flipped = await resolveWithOptionalClaim(padTool(inner, composedRoom + 1), input);
      expect(flipped.evidenceResult).toEqual(OUTPUT_BUDGET);
      expect(bytes(flipped)).toBeLessThanOrEqual(MAX);
      expect(p.requests.map(r => (JSON.parse(r.body) as { method: string }).method)).toEqual(family.reads);
      // The window holds MULTICHAIN_CALLS_PER_MINUTE admissions; only that many minus one remain.
      for (let n = 0; n < MULTICHAIN_CALLS_PER_MINUTE - 1; n++) {
        expect((await inner({ subject: family.subject })).toolStatus).toBe("observed");
      }
      await expect(inner({ subject: family.subject })).rejects.toMatchObject({ code: "MCP_MULTICHAIN_RATE_LIMIT" });

      const markerRoom = MAX - bytes({ ...(await padTool(fresh(), 0)({ subject: family.subject })), evidenceResult: OUTPUT_BUDGET });
      report(`H-B room ${family.name}`, {
        subject: family.subject.txId,
        composedEnvelopeBytesAtPad0: bytes(unpadded),
        composedRoomBytes: composedRoom,
        flipsAtPadBytes: composedRoom + 1,
        outputBudgetMarkerRoomBytes: markerRoom,
        liveAdmissionTakenByOutputBudgetCall: true,
      });
    }
  }, TIMEOUT);
});

// ---------------------------------------------------------------------------
// F2
// ---------------------------------------------------------------------------

describe("F2: claim + evidenceContext over the output cap (the packages/mcp/README.md:560-561 exception)", () => {
  it("the composer's pre-check passes, the final envelope exceeds MULTICHAIN_RESULT_MAX_BYTES, and the whole call is refused MCP_MULTICHAIN_TOO_LARGE", async () => {
    const parts = await evmParts(ERC_SUBJECT, ERC_PREFLIGHT_AT);
    at(ERC_AFTER_AT);
    const context = contextOf(parts);
    const fresh = () => createMultichainTool(provider(ercRaw).fetchFn);

    // Unpadded references (each on its own tool instance and budget).
    const plain0 = await padTool(fresh(), 0)({ subject: ERC_SUBJECT });
    const claimOnly0 = await resolveWithOptionalClaim(padTool(fresh(), 0), { subject: ERC_SUBJECT, claim: ERC_CLAIM });
    expect(claimOnly0.claimAssessment?.evaluation).toMatchObject({
      subjectMatchesClaim: true, outcome: { applicability: "applicable", verdict: "supported" },
    });
    const contextOnly0 = await resolveWithOptionalClaim(padTool(fresh(), 0), { subject: ERC_SUBJECT, evidenceContext: context });
    expect(contextOnly0.evidenceResult?.status).toBe("composed");
    const fragment = decodeNecWireJson("network-evidence-fragment", JSON.stringify(contextOnly0.fragment));
    expect(Date.parse(ERC_PREFLIGHT_AT)).toBeLessThan(Date.parse(fragment.network.observedAt.timestamp!));
    const assessmentBytes = bytes(claimOnly0) - bytes(plain0);
    expect(assessmentBytes).toBe(Buffer.byteLength(`,"claimAssessment":${JSON.stringify(claimOnly0.claimAssessment)}`));
    expect(assessmentBytes).toBeGreaterThan(0);

    // pad: the composer's own pre-check (live-result.ts:399, without claimAssessment) sits exactly at the cap.
    const pad = MAX - bytes(contextOnly0);
    expect(pad - assessmentBytes).toBeGreaterThanOrEqual(0);
    const observation = await padTool(fresh(), pad)({ subject: ERC_SUBJECT });
    const outcome = composeNetworkEvidenceResult(observation, prepareEvidenceContext(ERC_SUBJECT, context));
    expect(outcome.status).toBe("composed");
    expect(bytes({ ...observation, evidenceResult: outcome })).toBe(MAX);
    // Without a claim this padding still composes (and one byte more is the documented output_budget).
    const contextOnly = await resolveWithOptionalClaim(padTool(fresh(), pad), { subject: ERC_SUBJECT, evidenceContext: context });
    expect(contextOnly.evidenceResult?.status).toBe("composed");
    expect(bytes(contextOnly)).toBe(MAX);
    const contextOnlyOver = await resolveWithOptionalClaim(padTool(fresh(), pad + 1), { subject: ERC_SUBJECT, evidenceContext: context });
    expect(contextOnlyOver.evidenceResult).toEqual(OUTPUT_BUDGET);

    // With the claim: largest padding that still fits is pad - assessmentBytes (composed, exactly at the cap) ...
    const fits: ClaimBoundObservation = await resolveWithOptionalClaim(padTool(fresh(), pad - assessmentBytes),
      { subject: ERC_SUBJECT, claim: ERC_CLAIM, evidenceContext: context });
    expect(fits.evidenceResult?.status).toBe("composed");
    expect(fits.claimAssessment?.protocol).toBe("erc4337");
    expect(bytes(fits)).toBe(MAX);
    // ... one byte more, up to the pre-check edge, the whole call is refused: no not_composed fallback.
    const refusal = {
      code: "MCP_MULTICHAIN_TOO_LARGE",
      message: "bounded source evidence plus the optional assessment and evidence result exceeds MCP tool output budget; nothing is truncated",
    };
    for (const over of [pad - assessmentBytes + 1, pad]) {
      await expect(resolveWithOptionalClaim(padTool(fresh(), over), { subject: ERC_SUBJECT, claim: ERC_CLAIM, evidenceContext: context }))
        .rejects.toMatchObject(refusal);
    }

    // At the hosted tools/call surface nothing but the error is returned.
    await hosted(padTool(fresh(), pad), async (call) => {
      const out = await call(LIVE_MULTICHAIN_TOOL, { subject: ERC_SUBJECT, claim: ERC_CLAIM, evidenceContext: context });
      expect(out.isError).toBe(true);
      expect(out.structuredContent).toBeUndefined();
      expect(out.content).toHaveLength(1);
      const parsed = JSON.parse(out.content[0].text);
      expect(Object.keys(parsed)).toEqual(["error"]);
      expect(parsed.error).toMatchObject({ ...refusal, cause: null });
    });

    report("F2", {
      subject: ERC_SUBJECT.txId,
      claimTerms: "SIMULATED (adapter-erc4337 base-mainnet-redeem-bundle.json UserOperationEvent)",
      claimAssessmentBytes: assessmentBytes,
      composerPreCheckPadBytes: pad,
      claimAndContextLargestFittingPadBytes: pad - assessmentBytes,
      refusedWholePadRangeBytes: [pad - assessmentBytes + 1, pad],
      behaviour: "MCP_MULTICHAIN_TOO_LARGE, nothing returned (packages/mcp/README.md:560-561 exception)",
    });
  }, TIMEOUT);
});

// ---------------------------------------------------------------------------
// H-D
// ---------------------------------------------------------------------------

describe("H-D: prepare and compose wall time on the recorded observations", () => {
  it("prepareEvidenceContext and composeNetworkEvidenceResult stay far below LIVE_TOOL_DEADLINE_MS for Base and Solana", async () => {
    expect(CEILING_MS).toBeLessThan(LIVE_TOOL_DEADLINE_MS);
    for (const family of await families()) {
      const context = contextOf(family.parts);
      at(family.afterAt);
      const observation = await createMultichainTool(provider(family.fixture).fetchFn)({ subject: family.subject });
      expect(observation.acquiredAt).toBe(family.afterAt);
      const prepare = measure(ITERATIONS, () => { prepareEvidenceContext(family.subject, context); });
      const prepared = prepareEvidenceContext(family.subject, context);
      const statuses: string[] = [];
      const compose = measure(ITERATIONS, () => { statuses.push(composeNetworkEvidenceResult(observation, prepared).status); });
      expect(statuses).toEqual(Array(ITERATIONS).fill("composed"));
      for (const timing of [prepare, compose]) {
        expect(timing.iterations).toBeGreaterThanOrEqual(20);
        expect(timing.maxMs).toBeLessThan(CEILING_MS);
      }
      report(`H-D ${family.name}`, {
        subject: family.subject.txId,
        prepareEvidenceContext: prepare,
        composeNetworkEvidenceResult: compose,
        liveToolDeadlineMs: LIVE_TOOL_DEADLINE_MS,
      });
      summary.push(`H-D ${family.name}: prepare ${fmt(prepare)}; compose ${fmt(compose)}; deadline ${LIVE_TOOL_DEADLINE_MS} ms`);
    }
  }, TIMEOUT);
});

// ---------------------------------------------------------------------------
// H-E
// ---------------------------------------------------------------------------

/**
 * EVM normalisation: viem's HTTP transport takes JSON-RPC ids from a
 * process-wide counter, so a later call carries later ids whatever its input.
 * Only that id token is replaced (it must occur exactly once); every other
 * byte of the body must be identical. Solana ids restart at 1 per acquisition
 * (resolver-solana rpc.ts createRpcReader), so Solana bodies are compared raw.
 */
function withoutRpcId(body: string): string {
  const id = (JSON.parse(body) as { id?: unknown }).id;
  expect(typeof id === "number" || typeof id === "string").toBe(true);
  const token = `"id":${JSON.stringify(id)}`;
  expect(occurrences(body, token)).toBe(1);
  return body.replace(token, `"id":"<rpc-id>"`);
}

describe("H-E: provider requests are identical with and without evidenceContext", () => {
  it("every provider request (URL + full body) for Base and Solana; nothing of the context reaches a provider", async () => {
    for (const family of await families()) {
      const clean = contextOf(family.parts);
      const marked = contextOf(family.parts, { metadata: { note: MARKER } });
      at(family.afterAt);
      const p = provider(family.fixture);
      const runs: Record<string, ProviderRequest[]> = {};
      await hosted(createMultichainTool(p.fetchFn), async (call) => {
        for (const [label, evidenceContext] of [["without", undefined], ["with", clean], ["withMarker", marked]] as const) {
          p.requests.length = 0;
          const out = await call(LIVE_MULTICHAIN_TOOL, {
            subject: family.subject, ...(evidenceContext === undefined ? {} : { evidenceContext }),
          });
          expect(out.isError).toBeFalsy();
          if (evidenceContext !== undefined) expect(out.structuredContent.evidenceResult.status).toBe("composed");
          runs[label] = p.requests.map(r => ({ ...r }));
        }
      });
      const without = runs.without!;
      expect(without.map(r => (JSON.parse(r.body) as { method: string }).method)).toEqual(family.reads);
      for (const label of ["with", "withMarker"]) {
        const other = runs[label]!;
        expect(other.map(r => r.url)).toEqual(without.map(r => r.url));
        if (family.name === "solana") {
          expect(other).toEqual(without);
        } else {
          expect(other.map(r => withoutRpcId(r.body))).toEqual(without.map(r => withoutRpcId(r.body)));
        }
        for (const request of other) {
          for (const secret of [MARKER, "ne-l040-", family.parts.request.evidencePolicy.digest]) {
            expect(request.url).not.toContain(secret);
            expect(request.body).not.toContain(secret);
          }
        }
      }
      report(`H-E ${family.name}`, {
        subject: family.subject.txId,
        providerRequests: without.length,
        comparison: family.name === "solana" ? "byte-identical" : "byte-identical after normalising only the JSON-RPC id",
        rawBodiesIdenticalWithContext: runs.with!.every((r, i) => r.body === without[i]?.body),
        requests: without.map(r => ({ url: r.url, bodyBytes: Buffer.byteLength(r.body) })),
      });
    }
  }, TIMEOUT);
});
