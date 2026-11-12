/**
 * NE-L008 follow-up for the live-acquisition surface (offline replay, no live read):
 * - F-03: EVM method/param/block-tag allowlist negatives behind the CANONICAL
 *   slashed URL, so the URL check cannot mask the shape check.
 * - F-14: the 2-in-flight multichain cap, behaviorally.
 * - F-19: EVM non-200 body and throwing-provider redaction.
 * - H-10a, H-11, H-12: reproduced by NE-L012 as `it.fails`, fixed by NE-L014 and
 *   now plain tests of the fixed behavior; the last plain test re-checks what
 *   each one recorded.
 * Provider bytes are the real recorded F1 Base mainnet capture (x402 #1062
 * USDC transfer), the real Solana mainnet x402 capture and the real Base
 * mainnet OP Stack resolver capture; delays, padding, stalls and every other
 * answer are SIMULATED (see `f1Provider` and `opStackStallingProvider`).
 */
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { computeEvidencePolicyDigest } from "@nec/core";
import { startNeMcpHttpServer } from "../src/http.js";
import { toSafeToolError } from "../src/errors.js";
import { LIVE_EVM_MAX_RPC_BYTES, LIVE_EVM_RPC_TIMEOUT_MS, restrictedBaseRpcFetch } from "../src/live-evm.js";
import {
  createMultichainTool, LIVE_MULTICHAIN_TOOL, LIVE_TOOL_DEADLINE_MS, MULTICHAIN_CALLS_PER_MINUTE, MULTICHAIN_MAX_INFLIGHT,
} from "../src/live-multichain.js";
import { SOLANA_NETWORKS } from "../src/live-solana.js";
import { createLiveBeforeTool } from "../src/live-before.js";
import { createLivePreflightTool } from "../src/live-preflight.js";
import { resolveWithOptionalClaim } from "../src/live-claim.js";
import { simulatedHostFetch } from "./helpers.js";

const F1 = JSON.parse(readFileSync(new URL(
  "../../../examples/historical-compat/authority/fixtures/F1-x402-1062-partial/source/network-evidence/fixtures/base-mainnet-x402-1062-usdc-transfer.fixture.json",
  import.meta.url), "utf8")) as {
  subject: { txHash: string };
  captures: { rpcMethod: string; rpcParams: unknown[]; resultJson: string }[];
};
const SOL = JSON.parse(readFileSync(new URL(
  "../../resolver-solana/test/fixtures/solana-mainnet-x402-real.json", import.meta.url), "utf8")) as {
  subject: { signature: string };
  captures: { rpcMethod: string; resultJson: string }[];
};
const OP = JSON.parse(readFileSync(new URL(
  "../../resolver-opstack/test/fixtures/base-mainnet-usdc-transfer.fixture.json", import.meta.url), "utf8")) as {
  captures: { rpcMethod: string; resultJson: string }[];
};
const TX = F1.subject.txHash;
const RECEIPT = JSON.parse(F1.captures.find(c => c.rpcMethod === "eth_getTransactionReceipt")!.resultJson) as {
  blockHash: string; blockNumber: string;
};
const HEIGHT = BigInt(RECEIPT.blockNumber);
const hex = (n: bigint) => "0x" + n.toString(16);
/** The only URL the guard admits for base-mainnet: `new URL(source.url).href`. */
const BASE_URL = "https://mainnet.base.org/";
const SOLANA_URL = new URL(SOLANA_NETWORKS["solana-mainnet"].url).href;
const SUBJECT = { type: "transaction", networkId: "eip155:8453", txId: TX } as const;
const SOL_SUBJECT = { type: "transaction", networkId: SOLANA_NETWORKS["solana-mainnet"].networkId, txId: SOL.subject.signature } as const;
/** The transaction of the OP Stack resolver capture (same as live-opstack.test.ts). */
const OP_SUBJECT = { type: "transaction", networkId: "eip155:8453", txId: "0xcf496bca417f033e3ce5ad167e82a5bf95b2d815e4493de2f4943d3058b85afb" } as const;
const F1_METHODS = ["eth_chainId", "eth_getTransactionReceipt", "eth_getBlockByHash", "eth_getTransactionByHash"];
const SOLANA_METHODS = ["getGenesisHash", "getTransaction", "getSignatureStatuses", "getBlock"];
const REQUIREMENTS = { requirements: [{ capability: "execution", strength: "required" }] };
const SENTINEL = "PROVIDER_SENTINEL_NE_L008";
const ORIGIN = "https://mcp.example.org";
const HOST = "mcp.example.org";

const rpc = (method: string, params: unknown[]) => JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
const urlOf = (input: Parameters<typeof fetch>[0]) =>
  new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).href;

function sourceResponse(body: string, status = 200, contentType = "application/json", url = BASE_URL): Response {
  const response = new Response(body, { status, headers: { "content-type": contentType } });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

interface Simulated {
  /** Every read waits for this gate before answering. */
  gate?: Promise<void>;
  /** Every read answers only after this many milliseconds (ignoring its abort signal). */
  delayMs?: number;
  /** The real receipt answer is padded with JSON whitespace to exactly this many bytes. */
  receiptBytes?: number;
}

/**
 * Replays F1's exact resultJson per method for the exact recorded params on
 * Base mainnet, and the real Solana mainnet capture per method; any other URL throws.
 */
function f1Provider(sim: Simulated = {}) {
  const methods: string[] = [];
  const startedAt: number[] = [];
  const bodyBytes: Record<string, number> = {};
  const fetchFn: typeof fetch = async (input, init) => {
    const url = urlOf(input);
    if (url !== BASE_URL && url !== SOLANA_URL) throw Error("Unapproved fake endpoint");
    const req = JSON.parse(init?.body as string) as { id: number; method: string; params?: unknown[] };
    methods.push(req.method);
    startedAt.push(performance.now());
    let resultJson: string;
    if (url === BASE_URL) {
      const found = F1.captures.find(c => c.rpcMethod === req.method);
      if (!found || JSON.stringify(req.params ?? []) !== JSON.stringify(found.rpcParams)) throw Error("Unexpected mock method or params");
      resultJson = found.resultJson;
    } else {
      const found = SOL.captures.find(c => c.rpcMethod === req.method);
      if (!found) throw Error("Unexpected mock method");
      resultJson = found.resultJson;
    }
    if (sim.gate !== undefined) await sim.gate;
    if (sim.delayMs !== undefined) await delay(sim.delayMs);
    let body = `{"jsonrpc":"2.0","id":${JSON.stringify(req.id)},"result":${resultJson}}`;
    if (sim.receiptBytes !== undefined && req.method === "eth_getTransactionReceipt") {
      body = body.slice(0, -1) + " ".repeat(sim.receiptBytes - Buffer.byteLength(body)) + "}";
    }
    bodyBytes[req.method] = Buffer.byteLength(body);
    return sourceResponse(body, 200, "application/json", url);
  };
  return { methods, startedAt, bodyBytes, fetchFn };
}

/**
 * Answers the four generic Base reads at once with the real OP Stack resolver
 * capture. Every OP Stack eth_getBlockByNumber read never answers; like real
 * fetch, it rejects only when its init.signal aborts.
 */
function opStackStallingProvider() {
  const state = { methods: [] as string[], opReadStartedAt: [] as number[], opReadAborted: false };
  const generic = ["eth_chainId", "eth_getTransactionReceipt", "eth_getBlockByHash", "eth_getTransactionByHash"];
  const fetchFn: typeof fetch = async (input, init) => {
    if (urlOf(input) !== BASE_URL) throw Error("Unapproved fake endpoint");
    const req = JSON.parse(init?.body as string) as { id: number; method: string };
    state.methods.push(req.method);
    if (req.method === "eth_getBlockByNumber") {
      state.opReadStartedAt.push(performance.now());
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          state.opReadAborted = true;
          reject(new Error("aborted"));
        }, { once: true });
      });
    }
    const index = generic.indexOf(req.method);
    if (index < 0) throw Error("Unexpected mock method");
    const result = req.method === "eth_chainId" ? JSON.stringify("0x2105") : OP.captures[index]!.resultJson;
    return sourceResponse(`{"jsonrpc":"2.0","id":${JSON.stringify(req.id)},"result":${result}}`);
  };
  return { state, fetchFn };
}

function preflightRequest() {
  const content = { id: "external_policy_1", version: "1", requiredDimensions: ["execution" as const], desiredDimensions: [] };
  return {
    schemaVersion: "0.1", requestId: "external_preflight_1", networkId: SUBJECT.networkId,
    action: { kind: "erc20.transfer", target: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", fields: { expectedAmount: "1000" } },
    evidencePolicy: { ...content, digest: computeEvidencePolicyDigest(content) },
  };
}

interface DeadlineRecord { code?: unknown; elapsedMs: number; returned: boolean; readStartsMs: number[] }
/** What each fixed case actually observed; re-checked by the last plain test. */
const h10a: { code?: unknown; receiptBodyBytes?: number; returned?: boolean } = {};
const h11: { evm?: DeadlineRecord; solana?: DeadlineRecord; opStack?: DeadlineRecord & { opReadAborted: boolean } } = {};
const h12: {
  providerCalls: number; signalPresent?: boolean; providerReachedBeforeAbort?: boolean;
  clientOutcome?: "resolved" | "rejected"; abortDelayMs?: number;
  admittedAfterAbort?: string[]; laterAdmitted?: number; refusedCode?: unknown;
} = { providerCalls: 0 };

const realFetch = globalThis.fetch;
let globalFetchAttempts = 0;
beforeAll(() => {
  globalThis.fetch = (async () => {
    globalFetchAttempts += 1;
    throw new Error("network I/O is forbidden in live-acquisition-guards tests");
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("live-acquisition guards (NE-L008 coverage gaps)", () => {
  it("F-03: isolates the EVM method, param and block-tag allowlist behind the canonical URL", async () => {
    const calls: string[] = [];
    const recorder: typeof fetch = async (_input, init) => {
      calls.push(String(init?.body));
      return sourceResponse('{"jsonrpc":"2.0","id":1,"result":null}');
    };
    const plain = restrictedBaseRpcFetch(recorder, "base-mainnet");
    const opStack = restrictedBaseRpcFetch(recorder, "base-mainnet", { opStackSubjectBlockNumber: HEIGHT });
    const refused: [typeof fetch, Parameters<typeof fetch>[1]][] = [
      [plain, { method: "GET", body: rpc("eth_chainId", []) }],
      [plain, { method: "POST", body: rpc("eth_sendRawTransaction", ["0x02"]) }],
      [plain, { method: "POST", body: rpc("eth_getTransactionReceipt", []) }],
      [plain, { method: "POST", body: rpc("eth_getBlockByHash", [TX, true]) }],
      // No OP Stack opt-in: eth_getBlockByNumber is not admitted at all.
      [plain, { method: "POST", body: rpc("eth_getBlockByNumber", ["finalized", false]) }],
      // With the opt-in: wrong tag, full transactions, wrong height.
      [opStack, { method: "POST", body: rpc("eth_getBlockByNumber", ["pending", false]) }],
      [opStack, { method: "POST", body: rpc("eth_getBlockByNumber", [hex(HEIGHT), true]) }],
      [opStack, { method: "POST", body: rpc("eth_getBlockByNumber", [hex(HEIGHT + 1n), false]) }],
    ];
    for (const [scoped, init] of refused) {
      await expect(scoped(BASE_URL, init)).rejects.toMatchObject({ code: "MCP_LIVE_EVM_RPC_FAILED" });
    }
    expect(calls).toEqual([]);
    // Same URL and near-miss shapes are admitted, so each refusal above is
    // caused by the one field that differs, not by the URL check.
    const accepted: [typeof fetch, string][] = [
      [plain, rpc("eth_chainId", [])],
      [plain, rpc("eth_getTransactionReceipt", [TX])],
      [plain, rpc("eth_getBlockByHash", [RECEIPT.blockHash, false])],
      [opStack, rpc("eth_getBlockByNumber", ["finalized", false])],
      [opStack, rpc("eth_getBlockByNumber", [hex(HEIGHT), false])],
    ];
    for (const [scoped, body] of accepted) {
      expect((await scoped(BASE_URL, { method: "POST", body })).status).toBe(200);
    }
    expect(calls).toHaveLength(accepted.length);
  });

  it("F-14: holds at most two multichain calls in flight; a third is refused before any provider read", async () => {
    expect(MULTICHAIN_MAX_INFLIGHT).toBe(2);
    let open!: () => void;
    const gate = new Promise<void>(resolve => { open = resolve; });
    const p = f1Provider({ gate });
    const tool = createMultichainTool(p.fetchFn);
    const first = tool({ subject: SUBJECT });
    const second = tool({ subject: SUBJECT });
    await expect.poll(() => p.methods.length).toBe(2);
    expect(p.methods).toEqual(["eth_chainId", "eth_chainId"]);
    await expect(tool({ subject: SUBJECT })).rejects.toMatchObject({ code: "MCP_MULTICHAIN_RATE_LIMIT" });
    await delay(50);
    expect(p.methods).toHaveLength(2);
    open();
    expect((await Promise.all([first, second])).map(x => x.toolStatus)).toEqual(["observed", "observed"]);
    const before = p.methods.length;
    const fourth = await tool({ subject: SUBJECT });
    expect(fourth.toolStatus).toBe("observed");
    expect(p.methods.slice(before)).toEqual(F1_METHODS);
  });

  it("F-19: an EVM HTTP 503 body and a throwing provider both collapse to MCP_LIVE_EVM_RPC_FAILED without the sentinel", async () => {
    let reads = 0;
    const unavailable: typeof fetch = async () => { reads += 1; return sourceResponse(SENTINEL, 503, "text/plain"); };
    const throwing: typeof fetch = async () => { reads += 1; throw new Error(SENTINEL); };
    for (const fetchFn of [unavailable, throwing]) {
      const prior = reads;
      let caught: unknown;
      try { await createMultichainTool(fetchFn)({ subject: SUBJECT }); } catch (error) { caught = error; }
      expect(reads).toBeGreaterThan(prior);
      expect(caught).toMatchObject({ code: "MCP_LIVE_EVM_RPC_FAILED" });
      expect(toSafeToolError(caught).code).toBe("MCP_LIVE_EVM_RPC_FAILED");
      expect(JSON.stringify(toSafeToolError(caught))).not.toContain(SENTINEL);
    }
  });
});

/** One direct resolve under a short test-only deadline; records what happened. */
async function deadlineRun(fetchFn: typeof fetch, startedAt: number[], subject: typeof SUBJECT | typeof SOL_SUBJECT, deadlineMs: number) {
  const tool = createMultichainTool(fetchFn, { deadlineMs });
  const started = performance.now();
  let out: { toolStatus?: string } | undefined;
  let caught: unknown;
  try { out = await tool({ subject }); } catch (error) { caught = error; }
  const elapsedMs = performance.now() - started;
  return { caught, out, record: (): DeadlineRecord => ({
    code: (caught as { code?: unknown } | undefined)?.code, elapsedMs, returned: out !== undefined,
    readStartsMs: startedAt.map(t => t - started),
  }) };
}

describe("NE-L008 hypotheses H-10a, H-11 and H-12, fixed by NE-L014", () => {
  it("H-10a: a 128,001-byte EVM receipt response rejects with MCP_LIVE_EVM_TOO_LARGE and no fragment", async () => {
    expect(LIVE_EVM_MAX_RPC_BYTES).toBe(128_000);
    const p = f1Provider({ receiptBytes: 128_001 });
    let out: unknown;
    let caught: unknown;
    try { out = await createMultichainTool(p.fetchFn)({ subject: SUBJECT }); } catch (error) { caught = error; }
    h10a.code = (caught as { code?: unknown } | undefined)?.code;
    h10a.receiptBodyBytes = p.bodyBytes["eth_getTransactionReceipt"];
    h10a.returned = out !== undefined;
    expect(h10a.receiptBodyBytes).toBe(LIVE_EVM_MAX_RPC_BYTES + 1);
    expect(out).toBeUndefined();
    expect(caught).toMatchObject({ code: "MCP_LIVE_EVM_TOO_LARGE" });
    expect(toSafeToolError(caught)).toEqual({ code: "MCP_LIVE_EVM_TOO_LARGE", message: expect.any(String), cause: null });
    expect(p.methods).toEqual(F1_METHODS.slice(0, 2));
  });

  it("H-11: LIVE_TOOL_DEADLINE_MS is at most 40 s; a test deadline can only be shorter", () => {
    expect(LIVE_TOOL_DEADLINE_MS).toBeLessThanOrEqual(40_000);
    const p = f1Provider();
    expect(() => createMultichainTool(p.fetchFn, { deadlineMs: LIVE_TOOL_DEADLINE_MS + 1 })).toThrow();
    expect(() => createMultichainTool(p.fetchFn, { deadlineMs: 0 })).toThrow();
  });

  for (const chain of ["evm", "solana"] as const) {
    it(`H-11 (${chain}): deadlineMs=3000 with 2,000 ms per read rejects with MCP_LIVE_DEADLINE_EXCEEDED within 4,000 ms; no read starts after it`, { timeout: 20_000 }, async () => {
      const p = f1Provider({ delayMs: 2_000 });
      const run = await deadlineRun(p.fetchFn, p.startedAt, chain === "evm" ? SUBJECT : SOL_SUBJECT, 3_000);
      expect(run.out).toBeUndefined();
      expect(run.caught).toMatchObject({ code: "MCP_LIVE_DEADLINE_EXCEEDED" });
      // Let the interrupted simulated read answer, so a later read would have started by now.
      await delay(2_500);
      const record = run.record();
      h11[chain] = record;
      expect(record.elapsedMs).toBeLessThan(4_000);
      expect(record.readStartsMs.every(t => t < 3_000)).toBe(true);
      expect(p.methods).toEqual((chain === "evm" ? F1_METHODS : SOLANA_METHODS).slice(0, 2));
    });
  }

  it("H-11 (OP Stack): a deadline hit during the OP Stack phase rejects the whole call; no source_unavailable, no finality verdict", { timeout: 20_000 }, async () => {
    const p = opStackStallingProvider();
    const tool = createMultichainTool(p.fetchFn, { deadlineMs: 1_000 });
    const started = performance.now();
    let out: unknown;
    let caught: unknown;
    try { out = await tool({ subject: OP_SUBJECT, includeL2Finality: true }); } catch (error) { caught = error; }
    const elapsedMs = performance.now() - started;
    await delay(200);
    h11.opStack = {
      code: (caught as { code?: unknown } | undefined)?.code, elapsedMs, returned: out !== undefined,
      readStartsMs: p.state.opReadStartedAt.map(t => t - started), opReadAborted: p.state.opReadAborted,
    };
    // The four generic reads completed; the deadline hit inside the OP Stack phase.
    expect(p.state.methods.slice(0, 4)).toEqual(F1_METHODS);
    expect(h11.opStack.readStartsMs.length).toBeGreaterThanOrEqual(1);
    expect(h11.opStack.readStartsMs.every(t => t < 1_000)).toBe(true);
    // Aborted by the 1 s deadline, well before the 6 s per-read budget.
    expect(h11.opStack.opReadAborted).toBe(true);
    expect(elapsedMs).toBeLessThan(2_000);
    expect(out).toBeUndefined();
    expect(caught).toMatchObject({ code: "MCP_LIVE_DEADLINE_EXCEEDED" });
  });

  it("H-11: discover with 2 subjects shares ONE deadline; discover, preflight and claim pass MCP_LIVE_DEADLINE_EXCEEDED through", { timeout: 20_000 }, async () => {
    // Control: each subject alone (4 reads x 400 ms) fits a 2,500 ms deadline.
    const control = createMultichainTool(f1Provider({ delayMs: 400 }).fetchFn, { deadlineMs: 2_500 });
    expect((await control({ subject: SOL_SUBJECT })).toolStatus).toBe("observed");
    expect((await control({ subject: SUBJECT })).toolStatus).toBe("observed");
    // Both subjects in one discover call do not: the deadline is shared, not per subject.
    const p = f1Provider({ delayMs: 400 });
    const discover = createLiveBeforeTool(createMultichainTool(p.fetchFn, { deadlineMs: 2_500 }));
    await expect(discover({ requestId: "ne_l014_shared_deadline_1", requirements: REQUIREMENTS, subjects: [SOL_SUBJECT, SUBJECT] }))
      .rejects.toMatchObject({ code: "MCP_LIVE_DEADLINE_EXCEEDED" });
    expect(p.methods.slice(0, 4)).toEqual(SOLANA_METHODS);
    expect(p.methods.length).toBeGreaterThan(4);
    // Never mapped to *_UNAVAILABLE, a blocked preflight or an ineligible candidate.
    const preflight = createLivePreflightTool(createMultichainTool(f1Provider({ delayMs: 400 }).fetchFn, { deadlineMs: 1_000 }));
    await expect(preflight({ selectedNetworkId: SUBJECT.networkId, probeSubject: SUBJECT, request: preflightRequest() }))
      .rejects.toMatchObject({ code: "MCP_LIVE_DEADLINE_EXCEEDED" });
    const claimed = createMultichainTool(f1Provider({ delayMs: 400 }).fetchFn, { deadlineMs: 1_000 });
    await expect(resolveWithOptionalClaim(claimed, { subject: SUBJECT }))
      .rejects.toMatchObject({ code: "MCP_LIVE_DEADLINE_EXCEEDED" });
  });

  it("H-12: a hosted client abort at 200 ms reaches the provider's init.signal within 1,000 ms; both in-flight slots are freed", { timeout: 20_000 }, async () => {
    let reachedAt: number | undefined;
    let abortedAt: number | undefined;
    let settled!: () => void;
    const providerAborted = new Promise<void>(resolve => { settled = resolve; });
    let stall = true;
    const replay = f1Provider();
    // While `stall` holds, a provider that never answers; like real fetch, it rejects only on abort.
    const provider: typeof fetch = (input, init) => {
      if (!stall) return replay.fetchFn(input, init);
      return new Promise<Response>((_resolve, reject) => {
        h12.providerCalls += 1;
        reachedAt ??= performance.now();
        const signal = init?.signal ?? undefined;
        h12.signalPresent = signal !== undefined;
        signal?.addEventListener("abort", () => {
          abortedAt = performance.now();
          settled();
          reject(new Error("aborted"));
        }, { once: true });
      });
    };
    const tool = createMultichainTool(provider);
    const server = await startNeMcpHttpServer({
      host: "127.0.0.1", port: 0, hosted: { publicOrigin: ORIGIN }, liveEvidence: tool,
    });
    const disconnect = new AbortController();
    const local = simulatedHostFetch(server.port, HOST);
    // Only the tools/call POST is tied to the client-side abort; a retried call after it is refused locally.
    const transportFetch: typeof fetch = (input, init) => {
      if (typeof init?.body !== "string" || !init.body.includes('"tools/call"')) return local(input, init);
      if (disconnect.signal.aborted) return Promise.reject(new Error("client disconnected"));
      const own = init.signal ?? undefined;
      return local(input, { ...init, signal: own === undefined ? disconnect.signal : AbortSignal.any([own, disconnect.signal]) });
    };
    const client = new Client({ name: "live-acquisition-guards-h12", version: "1" }, { versionNegotiation: { mode: "auto" } });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(ORIGIN + "/mcp"), { fetch: transportFetch }));
      void client.callTool({ name: LIVE_MULTICHAIN_TOOL, arguments: { subject: SUBJECT } })
        .then(() => { h12.clientOutcome = "resolved"; }, () => { h12.clientOutcome = "rejected"; });
      await delay(200);
      h12.providerReachedBeforeAbort = reachedAt !== undefined;
      const abortAt = performance.now();
      disconnect.abort();
      await expect.poll(() => abortedAt, { timeout: 1_000, interval: 20 }).toBeDefined();
      h12.abortDelayMs = abortedAt! - abortAt;
      expect(h12.abortDelayMs).toBeLessThanOrEqual(1_000);
      // Both MULTICHAIN_MAX_INFLIGHT slots are free: two immediate calls are admitted.
      stall = false;
      h12.admittedAfterAbort = (await Promise.all([tool({ subject: SUBJECT }), tool({ subject: SUBJECT })])).map(x => x.toolStatus);
      expect(h12.admittedAfterAbort).toEqual(["observed", "observed"]);
      // The per-minute counter is not refunded: the aborted call still counts.
      h12.laterAdmitted = 0;
      for (let n = 3; n < MULTICHAIN_CALLS_PER_MINUTE; n++) {
        expect((await tool({ subject: SUBJECT })).toolStatus).toBe("observed");
        h12.laterAdmitted += 1;
      }
      try { await tool({ subject: SUBJECT }); } catch (error) { h12.refusedCode = (error as { code?: unknown }).code; }
      expect(h12.refusedCode).toBe("MCP_MULTICHAIN_RATE_LIMIT");
    } finally {
      // Never leave an in-process upstream read pending past its own bound.
      await Promise.race([providerAborted, delay(LIVE_EVM_RPC_TIMEOUT_MS + 2_000)]);
      await client.close().catch(() => {});
      await server.close();
    }
  });

  it("stop-and-report guard: each fixed case recorded the fixed behavior; no global fetch was attempted", () => {
    expect(globalFetchAttempts).toBe(0);
    // H-10a: the oversized receipt was served and surfaced under its own code, with no envelope.
    expect(h10a).toEqual({ code: "MCP_LIVE_EVM_TOO_LARGE", receiptBodyBytes: LIVE_EVM_MAX_RPC_BYTES + 1, returned: false });
    // H-11: each call ended at the deadline with its own code, no envelope, no read after it.
    for (const record of [h11.evm, h11.solana]) {
      expect(record).toMatchObject({ code: "MCP_LIVE_DEADLINE_EXCEEDED", returned: false });
      expect(record!.elapsedMs).toBeLessThan(4_000);
      expect(record!.readStartsMs).toHaveLength(2);
      expect(record!.readStartsMs.every(t => t < 3_000)).toBe(true);
    }
    expect(h11.opStack).toMatchObject({ code: "MCP_LIVE_DEADLINE_EXCEEDED", returned: false, opReadAborted: true });
    // H-12: one provider read was pending with a signal at abort time; the
    // client abort reached it within 1 s; slots were free, the count was kept.
    expect(h12.providerCalls).toBe(1);
    expect(h12.signalPresent).toBe(true);
    expect(h12.providerReachedBeforeAbort).toBe(true);
    expect(h12.clientOutcome).toBe("rejected");
    expect(h12.abortDelayMs).toBeLessThanOrEqual(1_000);
    expect(h12.admittedAfterAbort).toEqual(["observed", "observed"]);
    expect(h12.laterAdmitted).toBe(MULTICHAIN_CALLS_PER_MINUTE - 3);
    expect(h12.refusedCode).toBe("MCP_MULTICHAIN_RATE_LIMIT");
  });
});
