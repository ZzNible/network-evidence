/**
 * NE-L032 confirmation tests (NE-L030 gap D-3 and the adversarial Solana-orphan
 * HYPOTHESIS). Offline replay: an in-process fake provider; global fetch throws.
 *
 * - Case A: the caller cancels the pinned three-subject Discovery call while
 *   subject 1's first Base mainnet read is held.
 * - Case B: the caller cancels between subject 1 and subject 2.
 * - In both, the per-minute shared budget was charged exactly one admission and
 *   both in-flight slots are free again.
 * - Case C SIMULATED, HYPOTHESIS-bound: a Solana fetch that ignores its signal
 *   and never settles. It measures the orphaned reads this leaves behind. It is
 *   not a claim about real fetch/undici abort behaviour.
 *
 * Provider bytes:
 * - Base mainnet: the REAL historical-compat "F1" authority capture (x402 #1062
 *   USDC transfer 0x8e01…e696), every answer verbatim for the exact recorded params.
 * - Solana mainnet: the REAL "F3" source capture (resolver-solana
 *   solana-mainnet-x402-real.json, 4DYWUMEx…LF71), verbatim for the exact recorded params.
 * - Base Sepolia: the TEST-ONLY ABSENT probe of live-before-three-candidates.test.ts.
 *   ABSENT_TX is synthetic and NOT a transaction observed anywhere. Only the
 *   eth_chainId answer is real (adapter-erc4337 base-sepolia-external-v06-userop.json);
 *   the receipt and transaction lookups answer JSON null.
 * Every hold, abort and never-settling read is SIMULATED.
 */
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NeMcpError, toSafeToolError } from "../src/errors.js";
import { LIVE_EVM_MAX_CALLS_PER_MINUTE, LIVE_EVM_MAX_CONCURRENT } from "../src/live-evm.js";
import { createMultichainTool, MULTICHAIN_CALLS_PER_MINUTE, MULTICHAIN_MAX_INFLIGHT } from "../src/live-multichain.js";
import type { LiveCall, MultichainObservation, MultichainTool, TransactionSubject } from "../src/live-multichain.js";
import { createLiveBeforeTool, LIVE_BEFORE_MAX_CANDIDATES } from "../src/live-before.js";

interface Capture { rpcMethod: string; rpcParams: unknown[]; resultJson: string }
interface Fixture { captures: Capture[] }
const read = <T>(path: string): T => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as T;
const F1 = read<Fixture & { subject: { txHash: string } }>(
  "../../../examples/historical-compat/authority/fixtures/F1-x402-1062-partial/source/network-evidence/fixtures/base-mainnet-x402-1062-usdc-transfer.fixture.json");
const F3 = read<Fixture & { subject: { signature: string } }>("../../resolver-solana/test/fixtures/solana-mainnet-x402-real.json");
const SEPOLIA_IDENTITY = read<Fixture>("../../adapter-erc4337/test/fixtures/base-sepolia-external-v06-userop.json");

const BASE_ID = "eip155:8453";
const SEPOLIA_ID = "eip155:84532";
const SOLANA_ID = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
/** TEST-ONLY synthetic hash; never a real observed action. */
const ABSENT_TX = "0x" + "e".repeat(64);
const BASE_SUBJECT = { type: "transaction", networkId: BASE_ID, txId: F1.subject.txHash } as const;
const SOL_SUBJECT = { type: "transaction", networkId: SOLANA_ID, txId: F3.subject.signature } as const;
const ABSENT_SEPOLIA_SUBJECT = { type: "transaction", networkId: SEPOLIA_ID, txId: ABSENT_TX } as const;
/** Explicit caller DiscoveryRequirements; nothing is inferred. */
const REQUIREMENTS = { requirements: [
  { capability: "execution", strength: "required" },
  { capability: "finality", strength: "desired" },
] };
/** The pinned three-subject call of NE-L028: Base mainnet, then Solana mainnet, then the absent Base Sepolia probe. */
const INPUT = {
  requestId: "ne_l032_cancel_three_subjects", requirements: REQUIREMENTS,
  subjects: [BASE_SUBJECT, SOL_SUBJECT, ABSENT_SEPOLIA_SUBJECT],
};
const BASE_READS = ["eth_chainId", "eth_getTransactionReceipt", "eth_getBlockByHash", "eth_getTransactionByHash"];
const SOL_READS = ["getGenesisHash", "getTransaction", "getSignatureStatuses", "getBlock"];
const tagged = (endpoint: string, methods: readonly string[]) => methods.map(m => `${endpoint}:${m}`);
const ENDPOINTS: Readonly<Record<string, "base-mainnet" | "base-sepolia" | "solana-mainnet">> = {
  "https://mainnet.base.org/": "base-mainnet",
  "https://sepolia.base.org/": "base-sepolia",
  "https://api.mainnet-beta.solana.com/": "solana-mainnet",
};
const CANCELLED_MESSAGE =
  "the live tool call was cancelled by the caller before its deadline; no observation or availability claim was produced";

const captureOf = (fixture: Fixture, method: string): Capture => {
  const found = fixture.captures.find(c => c.rpcMethod === method);
  if (!found) throw Error(`missing pinned capture ${method}`);
  return found;
};

interface Simulated {
  /** SIMULATED: every read is held until release(); like real fetch, a held read rejects only when its init.signal aborts. */
  hold?: boolean;
  /** SIMULATED, HYPOTHESIS-bound: every Solana read ignores its init.signal and never settles. */
  solanaNeverSettles?: boolean;
}

/** Serves only the three fixed origins with the pinned bytes; any unrecorded method or params throws. */
function provider(sim: Simulated = {}) {
  const reads: string[] = [];
  const state = { held: 0, aborted: 0, solanaPending: 0 };
  let holding = sim.hold === true;
  const waiting: (() => void)[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).href;
    const endpoint = ENDPOINTS[url];
    if (endpoint === undefined) throw Error("Unapproved fake endpoint");
    const req = JSON.parse(init?.body as string) as { id: number; method: string; params?: unknown[] };
    reads.push(`${endpoint}:${req.method}`);
    const params = JSON.stringify(req.params ?? []);
    let resultText: string;
    if (endpoint === "base-sepolia") {
      if (req.method === "eth_chainId" && params === "[]") resultText = captureOf(SEPOLIA_IDENTITY, "eth_chainId").resultJson;
      else if ((req.method === "eth_getTransactionReceipt" || req.method === "eth_getTransactionByHash")
          && params === JSON.stringify([ABSENT_TX])) resultText = "null";
      else throw Error("Unexpected Base Sepolia read");
    } else {
      const found = captureOf(endpoint === "base-mainnet" ? F1 : F3, req.method);
      if (params !== JSON.stringify(found.rpcParams)) throw Error("Unexpected mock params");
      resultText = found.resultJson;
    }
    if (endpoint === "solana-mainnet" && sim.solanaNeverSettles === true) {
      // Never resolves or rejects, whatever init.signal does.
      state.solanaPending += 1;
      return new Promise<Response>(() => {});
    }
    if (holding) {
      state.held += 1;
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        waiting.push(() => { if (!settled) { settled = true; resolve(); } });
        const onAbort = () => {
          if (settled) return;
          settled = true;
          state.aborted += 1;
          reject(new Error("aborted"));
        };
        init?.signal?.addEventListener("abort", onAbort, { once: true });
        if (init?.signal?.aborted) onAbort();
      });
    }
    const response = new Response(`{"jsonrpc":"2.0","id":${JSON.stringify(req.id)},"result":${resultText}}`,
      { status: 200, headers: { "content-type": "application/json" } });
    Object.defineProperty(response, "url", { value: url });
    return response;
  };
  return { fetchFn, reads, state, release: () => { holding = false; for (const answer of waiting.splice(0)) answer(); } };
}

/** Records every resolve of the shared resolver: its LiveCall, subject and outcome. */
function counted(resolve: MultichainTool, afterObservation?: (n: number) => void) {
  const calls: (LiveCall | undefined)[] = [];
  const subjects: string[] = [];
  const outcomes: string[] = [];
  const tool = Object.assign(async (input: Parameters<MultichainTool>[0]) => {
    calls.push(input.call);
    subjects.push(input.subject.networkId);
    let observation: MultichainObservation;
    try {
      observation = await resolve(input);
    } catch (error) {
      outcomes.push(`rejected:${String((error as { code?: unknown }).code)}`);
      throw error;
    }
    outcomes.push("observed");
    afterObservation?.(outcomes.length);
    return observation;
  }, { startCall: resolve.startCall! });
  return { tool: tool as MultichainTool, calls, subjects, outcomes };
}

/** Starts one tool call under its own caller signal; records when it settled relative to abort(). */
function cancellable(run: (signal: AbortSignal) => Promise<unknown>) {
  const caller = new AbortController();
  let abortAt = Number.NaN;
  const outcome = run(caller.signal).then(
    (): { error: unknown; settledMs: number } => ({ error: "resolved", settledMs: performance.now() - abortAt }),
    (error: unknown) => ({ error, settledMs: performance.now() - abortAt }));
  return { abort: () => { abortAt = performance.now(); caller.abort(); }, outcome };
}

type Discover = ReturnType<typeof createLiveBeforeTool>;
const single = (requestId: string, subject: TransactionSubject) => ({ requestId, requirements: REQUIREMENTS, subjects: [subject] });

/**
 * After ONE cancelled call: two immediate concurrent calls are admitted (both
 * shared and both inner EVM in-flight slots are free), 7 further single-subject
 * calls are observed in total, and the next is refused before any read. With a
 * refund the refused call would be observed; with a second charge the 7th would
 * already be refused.
 */
async function exactlyOneAdmissionWasCharged(p: ReturnType<typeof provider>, discover: Discover, tag: string) {
  const start = p.reads.length;
  const pair = await Promise.all([
    discover(single(`${tag}_follow_1`, BASE_SUBJECT)), discover(single(`${tag}_follow_2`, BASE_SUBJECT)),
  ]);
  expect(pair.map(out => out.candidates.map(x => x.networkId))).toEqual([[BASE_ID], [BASE_ID]]);
  let observed = pair.length;
  for (let n = 3; n < MULTICHAIN_CALLS_PER_MINUTE; n++) {
    const out = await discover(single(`${tag}_follow_${n}`, SOL_SUBJECT));
    expect(out.candidates.map(x => x.networkId)).toEqual([SOLANA_ID]);
    observed += 1;
  }
  expect(observed).toBe(7);
  expect([...p.reads.slice(start)].sort()).toEqual([
    ...tagged("base-mainnet", BASE_READS), ...tagged("base-mainnet", BASE_READS),
    ...Array.from({ length: 5 }, () => tagged("solana-mainnet", SOL_READS)).flat(),
  ].sort());
  const before = p.reads.length;
  await expect(discover(single(`${tag}_refused`, SOL_SUBJECT))).rejects.toMatchObject({ code: "MCP_MULTICHAIN_RATE_LIMIT" });
  expect(p.reads.length).toBe(before);
}

/** What Case C observed; re-checked by the last plain test. */
const orphan: { perCancelledCall: number[]; settledMs: number[]; window?: number; afterRefusal?: number } = {
  perCancelledCall: [], settledMs: [],
};

const realFetch = globalThis.fetch;
let globalFetchAttempts = 0;
beforeAll(() => {
  globalThis.fetch = (async () => {
    globalFetchAttempts += 1;
    throw new Error("network I/O is forbidden in live-before-cancel-budget tests");
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("NE-L032: a caller cancel during a three-subject Discovery charges only what was admitted", () => {
  it("pins the subject cap and the shared and inner budgets these confirmations rely on", () => {
    expect({
      LIVE_BEFORE_MAX_CANDIDATES, MULTICHAIN_CALLS_PER_MINUTE, MULTICHAIN_MAX_INFLIGHT,
      LIVE_EVM_MAX_CALLS_PER_MINUTE, LIVE_EVM_MAX_CONCURRENT,
    }).toEqual({
      LIVE_BEFORE_MAX_CANDIDATES: 3, MULTICHAIN_CALLS_PER_MINUTE: 8, MULTICHAIN_MAX_INFLIGHT: 2,
      LIVE_EVM_MAX_CALLS_PER_MINUTE: 8, LIVE_EVM_MAX_CONCURRENT: 2,
    });
    expect(INPUT.subjects.map(s => s.networkId)).toEqual([BASE_ID, SOLANA_ID, SEPOLIA_ID]);
  });

  it("Case A: cancel during subject 1 (first Base mainnet read held) -> MCP_LIVE_CALL_CANCELLED, 1 admission, 1 read, no Solana or Base Sepolia read", { timeout: 20_000 }, async () => {
    const p = provider({ hold: true });
    const c = counted(createMultichainTool(p.fetchFn));
    const discover = createLiveBeforeTool(c.tool);
    const run = cancellable(signal => discover(INPUT, signal));
    await expect.poll(() => p.state.held, { timeout: 2_000, interval: 10 }).toBe(1);
    run.abort();
    const { error } = await run.outcome;
    await expect.poll(() => p.state.aborted, { timeout: 1_000, interval: 10 }).toBe(1);

    expect(error).toBeInstanceOf(NeMcpError);
    expect((error as NeMcpError).code).toBe("MCP_LIVE_CALL_CANCELLED");
    expect(toSafeToolError(error)).toEqual({ code: "MCP_LIVE_CALL_CANCELLED", message: CANCELLED_MESSAGE, cause: null });
    // Exactly one resolve was admitted; it was cancelled before its deadline.
    expect(c.subjects).toEqual([BASE_ID]);
    expect(c.outcomes).toEqual(["rejected:MCP_LIVE_CALL_CANCELLED"]);
    expect(c.calls[0]!.signal.aborted).toBe(true);
    expect(c.calls[0]!.deadline.aborted).toBe(false);
    expect(p.reads).toEqual(["base-mainnet:eth_chainId"]);
    // Releasing the hold starts nothing new: no later subject or read of the cancelled call.
    p.release();
    await delay(100);
    expect(p.reads).toEqual(["base-mainnet:eth_chainId"]);
    expect(p.reads.some(r => r.startsWith("solana-mainnet:") || r.startsWith("base-sepolia:"))).toBe(false);
    expect(c.subjects).toEqual([BASE_ID]);

    await exactlyOneAdmissionWasCharged(p, discover, "ne_l032_case_a");
  });

  it("Case B: cancel right after subject 1's observation -> MCP_LIVE_CALL_CANCELLED, exactly the 4 Base mainnet reads, subject 2 refused before admission", { timeout: 20_000 }, async () => {
    const p = provider();
    const caller = new AbortController();
    const c = counted(createMultichainTool(p.fetchFn), n => { if (n === 1) caller.abort(); });
    const discover = createLiveBeforeTool(c.tool);
    let caught: unknown;
    await discover(INPUT, caller.signal).then(() => { caught = "resolved"; }, (error: unknown) => { caught = error; });

    expect(caught).toBeInstanceOf(NeMcpError);
    expect((caught as NeMcpError).code).toBe("MCP_LIVE_CALL_CANCELLED");
    expect(toSafeToolError(caught)).toEqual({ code: "MCP_LIVE_CALL_CANCELLED", message: CANCELLED_MESSAGE, cause: null });
    // Subject 1 was observed; subject 2 (Solana) reached the resolver on the same
    // LiveCall and was refused by the pre-admission guard (live-multichain.ts:169).
    expect(c.subjects).toEqual([BASE_ID, SOLANA_ID]);
    expect(c.outcomes).toEqual(["observed", "rejected:MCP_LIVE_CALL_CANCELLED"]);
    expect(new Set(c.calls).size).toBe(1);
    expect(c.calls[0]!.signal.aborted).toBe(true);
    expect(c.calls[0]!.deadline.aborted).toBe(false);
    expect(p.reads).toEqual(tagged("base-mainnet", BASE_READS));
    await delay(100);
    expect(p.reads).toEqual(tagged("base-mainnet", BASE_READS));

    // The refused subject 2 was not counted: only subject 1's admission was charged.
    await exactlyOneAdmissionWasCharged(p, discover, "ne_l032_case_b");
  });
});

describe("NE-L032 Case C, SIMULATED and HYPOTHESIS-bound: a Solana fetch that ignores its signal and never settles", () => {
  // This measures only what the MCP code does when an injected fetch never
  // settles. It makes no claim about real fetch/undici abort behaviour.
  it("SIMULATED: each cancelled call settles MCP_LIVE_CALL_CANCELLED within 1 s, frees its shared slot, is never refunded, and leaves <=1 orphaned read (<=8 per 8/min window)", { timeout: 20_000 }, async () => {
    const p = provider({ solanaNeverSettles: true });
    const discover = createLiveBeforeTool(createMultichainTool(p.fetchFn));
    let admitted = 0;
    const expectCancelled = async (run: ReturnType<typeof cancellable>) => {
      const { error, settledMs } = await run.outcome;
      expect(error).toBeInstanceOf(NeMcpError);
      expect(toSafeToolError(error)).toEqual({ code: "MCP_LIVE_CALL_CANCELLED", message: CANCELLED_MESSAGE, cause: null });
      expect(settledMs).toBeLessThan(1_000);
      orphan.settledMs.push(settledMs);
    };
    const cancelOne = async (n: number) => {
      const before = p.state.solanaPending;
      const run = cancellable(signal => discover(single(`ne_l032_case_c_${n}`, SOL_SUBJECT), signal));
      // Cancel only once the Solana read is in flight, i.e. after admission.
      await expect.poll(() => p.state.solanaPending, { timeout: 2_000, interval: 10 }).toBe(before + 1);
      admitted += 1;
      run.abort();
      await expectCancelled(run);
      orphan.perCancelledCall.push(p.state.solanaPending - before);
    };

    await cancelOne(1);
    // The orphaned read holds no shared slot: two immediate concurrent calls are admitted.
    const pairBefore = p.state.solanaPending;
    const pair = [2, 3].map(n => cancellable(signal => discover(single(`ne_l032_case_c_${n}`, SOL_SUBJECT), signal)));
    await expect.poll(() => p.state.solanaPending, { timeout: 2_000, interval: 10 }).toBe(pairBefore + MULTICHAIN_MAX_INFLIGHT);
    admitted += MULTICHAIN_MAX_INFLIGHT;
    for (const run of pair) run.abort();
    for (const run of pair) await expectCancelled(run);
    orphan.perCancelledCall.push((p.state.solanaPending - pairBefore) / pair.length);
    for (let n = admitted + 1; n <= MULTICHAIN_CALLS_PER_MINUTE; n++) await cancelOne(n);
    expect(admitted).toBe(MULTICHAIN_CALLS_PER_MINUTE);
    orphan.window = p.state.solanaPending;

    // The count is not refunded: the next call is refused before any read.
    const reads = p.reads.length;
    await expect(discover(single("ne_l032_case_c_refused", SOL_SUBJECT))).rejects.toMatchObject({ code: "MCP_MULTICHAIN_RATE_LIMIT" });
    expect(p.reads.length).toBe(reads);
    await delay(100);
    orphan.afterRefusal = p.state.solanaPending;

    // Every orphan is the first read of an admitted call; none started a second read.
    expect(p.reads).toEqual(Array.from({ length: MULTICHAIN_CALLS_PER_MINUTE }, () => "solana-mainnet:getGenesisHash"));
    for (const perCall of orphan.perCancelledCall) expect(perCall).toBeLessThanOrEqual(1);
    expect(orphan.window).toBeLessThanOrEqual(MULTICHAIN_CALLS_PER_MINUTE);
    expect(orphan.afterRefusal).toBe(orphan.window);
  });
});

describe("stop-and-report", () => {
  it("each confirmation recorded what it observed; no global fetch was attempted", () => {
    expect(globalFetchAttempts).toBe(0);
    // SIMULATED orphan bound: 1 still-pending read per cancelled call, 8 over the full 8/min window.
    expect(orphan.perCancelledCall).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(orphan).toMatchObject({ window: 8, afterRefusal: 8 });
    expect(orphan.settledMs).toHaveLength(MULTICHAIN_CALLS_PER_MINUTE);
  });
});
