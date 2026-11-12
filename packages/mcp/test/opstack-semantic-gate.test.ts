/**
 * Coverage-gate §4 OP Stack semantic gate on the real pinned Base mainnet pair,
 * at the MCP tool surface: createMultichainTool({subject, includeL2Finality:true})
 * (offline replay, no live read).
 *
 * Real captures only, served verbatim (exact resultJson bytes) for the exact
 * recorded method and params; same-key captures are consumed in fixture order
 * (the repeated finalized read). Any other URL, method or params, or an
 * exhausted queue, throws; global fetch throws.
 * - fixtures/base-mainnet-l2-finalized-positive-evm.json (0x71c9e27a…625c)
 * - fixtures/base-mainnet-l2-finalized-positive-opstack.json (block 0x31f5527)
 *
 * The supplement is a one-source OP Stack L2 block view under
 * opstack.rpc-finalized-head-v1: withdrawal finalization is not evaluated and
 * it is never settlement. Every negative is SIMULATED: it changes exactly one
 * value of the real bytes and is used only by a test titled SIMULATED.
 *
 * Date is pinned to the OP Stack capture's recorded acquisition instant; real
 * timers (whole-call deadline, per-read timeout) keep running.
 */
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeNecWireJson, encodeNecWireJson } from "@nec/core";
import { exchangeIdentityKey, replayTransactionAcquisition } from "@nec/resolver-evm";
import {
  BASE_MAINNET_OPSTACK_BEFORE_PROFILE, evaluateOpStackFinality, replayOpStackFinalityObservation,
} from "@nec/resolver-opstack";
import { LIVE_OPSTACK_MAX_ANCESTRY_DEPTH } from "../src/live-evm.js";
import { createMultichainTool } from "../src/live-multichain.js";
import type { MultichainObservation } from "../src/live-multichain.js";

interface Capture { rpcMethod: string; rpcParams: unknown[]; httpStatus: number; resultJson: string }
interface Source { sourceId: string; sourceType: string; networkId: string; chainId: number; independenceGroup: string }
const read = <T>(path: string): T => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as T;
const EVM = read<{ acquiredAt: string; source: Source; subject: { txHash: string }; captures: Capture[] }>(
  "./fixtures/base-mainnet-l2-finalized-positive-evm.json");
const OP = read<{
  acquiredAt: string; source: Source; subjectBlock: { number: string; hash: string };
  maxAncestryDepth: number; captures: Capture[];
}>("./fixtures/base-mainnet-l2-finalized-positive-opstack.json");

const BASE_ID = "eip155:8453" as const;
const BASE_URL = "https://mainnet.base.org/";
const SUBJECT = { type: "transaction", networkId: BASE_ID, txId: EVM.subject.txHash } as const;
const BLOCK_HASH = "0xdafbdc922653e17e327f8649260a75e01000e9fc03cf3df74e539e0f428ba5d2";
const BLOCK_TAG = "0x31f5527";
const RECEIPT = JSON.parse(EVM.captures.find(c => c.rpcMethod === "eth_getTransactionReceipt")!.resultJson) as
  { blockHash: string; blockNumber: string };
const PINNED_AT = OP.acquiredAt;
/** SIMULATED replacement block hash; never a real Base block identifier. */
const SIMULATED_HASH = "0x" + "e".repeat(64);

/**
 * SIMULATED: one change to the real exchange. `result` rewrites the nth
 * served answer for one exact (method, params); `throw` fails every request
 * of one method.
 */
type Simulated =
  | { readonly kind: "result"; readonly method: string; readonly params: readonly unknown[]; readonly nth: number; readonly mutate: (resultJson: string) => string }
  | { readonly kind: "throw"; readonly method: string };

/** Exactly one occurrence of `from` replaced; anything else is a test bug. */
function replaceOnce(text: string, from: string, to: string): string {
  const parts = text.split(from);
  if (parts.length !== 2) throw Error(`expected exactly one occurrence of ${from}`);
  return parts.join(to);
}

/** Offline replay of the two real fixtures for the fixed Base mainnet origin only. */
function provider(simulated?: Simulated) {
  const queues = new Map<string, Capture[]>();
  for (const capture of [...EVM.captures, ...OP.captures]) {
    const key = exchangeIdentityKey(capture.rpcMethod, capture.rpcParams);
    queues.set(key, [...(queues.get(key) ?? []), capture]);
  }
  const served = new Map<string, number>();
  const calls: { method: string; params: unknown[] }[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).href;
    if (url !== BASE_URL || init?.method !== "POST") throw Error("Unapproved fake endpoint");
    const query = JSON.parse(init?.body as string) as { id: number; method: string; params?: unknown[] };
    const params = query.params ?? [];
    calls.push({ method: query.method, params });
    if (simulated?.kind === "throw" && query.method === simulated.method) throw Error("SIMULATED provider failure");
    const key = exchangeIdentityKey(query.method, params);
    const capture = queues.get(key)?.shift();
    if (capture === undefined) throw Error(`Unexpected mock request ${key}`);
    const nth = served.get(key) ?? 0;
    served.set(key, nth + 1);
    let resultText = capture.resultJson;
    if (simulated?.kind === "result" && key === exchangeIdentityKey(simulated.method, simulated.params) && nth === simulated.nth) {
      resultText = simulated.mutate(resultText);
      if (resultText === capture.resultJson) throw Error("SIMULATED change left the real bytes unchanged");
    }
    const response = new Response(`{"jsonrpc":"2.0","id":${JSON.stringify(query.id)},"result":${resultText}}`, {
      status: capture.httpStatus, headers: { "content-type": "application/json" },
    });
    Object.defineProperty(response, "url", { value: url });
    return response;
  };
  const unused = () => [...queues.values()].reduce((n, queue) => n + queue.length, 0);
  return { fetchFn, calls, unused };
}

async function resolve(simulated?: Simulated) {
  const source = provider(simulated);
  const out = await createMultichainTool(source.fetchFn)({ subject: SUBJECT, includeL2Finality: true });
  return { out, calls: source.calls, unused: source.unused };
}

const wire = (fragment: unknown): string =>
  encodeNecWireJson("network-evidence-fragment", decodeNecWireJson("network-evidence-fragment", JSON.stringify(fragment)));

/** The native evaluator over the same pair, replayed from the fixtures with their own recorded instants. */
async function nativeReplay() {
  const evm = await replayTransactionAcquisition(EVM, { includeTransaction: true });
  const finality = await replayOpStackFinalityObservation(OP);
  return { finality, evaluation: evaluateOpStackFinality({ config: BASE_MAINNET_OPSTACK_BEFORE_PROFILE.config, evm, finality }) };
}

let realMain: Promise<string> | undefined;
/** The generic EVM path is untouched by every simulated supplement change. */
async function expectMainAsReal(out: MultichainObservation): Promise<void> {
  const main = out.fragment as any;
  expect(main.networkEvidence).not.toHaveProperty("finality");
  expect(main.networkEvidence.execution.verdict).toBe("supported");
  expect(main.network.observedAt.blockId).toBe(BLOCK_HASH);
  realMain ??= resolve().then(({ out: real }) => wire(real.fragment));
  expect(wire(out.fragment)).toBe(await realMain);
}

const supplementOf = (out: MultichainObservation): any => out.opStackFinality?.fragment;
const codes = (items: readonly { code: string }[]): string[] => items.map(item => item.code);

const realFetch = globalThis.fetch;
let globalFetchAttempts = 0;
beforeAll(() => {
  globalThis.fetch = (async () => {
    globalFetchAttempts += 1;
    throw new Error("network I/O is forbidden in opstack-semantic-gate tests");
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});
// Only Date is faked; setTimeout and AbortSignal.timeout stay real.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse(PINNED_AT));
});
afterEach(() => {
  vi.useRealTimers();
  expect(globalFetchAttempts).toBe(0);
});

describe("OP Stack semantic gate on the real pinned Base 0x71c9 pair at the MCP tool surface", () => {
  it("real pair: the opt-in supplement is a supported one-source L2 block view; withdrawal finalization and settlement are not evaluated", async () => {
    expect(EVM.subject.txHash).toBe("0x71c9e27a7195bdecf1c63e73d5f959c96ddb35a27f6f1308835494c3156d625c");
    expect(OP.source).toEqual(EVM.source);
    expect(OP.source).toMatchObject({ networkId: BASE_ID, chainId: 8453 });
    expect(OP.subjectBlock.hash).toBe(BLOCK_HASH);
    expect(OP.maxAncestryDepth).toBe(LIVE_OPSTACK_MAX_ANCESTRY_DEPTH);

    const { out, calls, unused } = await resolve();
    // Every real capture was served exactly once and nothing else was asked for.
    expect(unused()).toBe(0);
    expect(calls).toHaveLength(EVM.captures.length + OP.captures.length);

    const op = out.opStackFinality!;
    expect(op).toMatchObject({
      toolStatus: "evaluated", ruleset: "opstack.rpc-finalized-head-v1", networkId: BASE_ID,
      withdrawalFinalization: "not_evaluated", ethereumSettlement: "not_evaluated",
      maxAncestryDepth: LIVE_OPSTACK_MAX_ANCESTRY_DEPTH,
    });
    expect(op.observedAt).toBe(PINNED_AT);
    const supplement = supplementOf(out);
    expect(supplement.subject).toEqual(SUBJECT);
    expect(supplement.networkEvidence.finality.verdict).toBe("supported");
    expect(supplement.networkEvidence.finality.basis).toEqual(["source_observation"]);
    expect(codes(supplement.warnings)).toContain("WITHDRAWAL_FINALIZATION_NOT_EVALUATED");
    expect(supplement.networkEvidence).not.toHaveProperty("settlement");
    expect(supplement.networkEvidence).not.toHaveProperty("execution");
    expect(supplement.conflicts).toEqual([]);

    const main = out.fragment as any;
    expect(main.networkEvidence).not.toHaveProperty("finality");
    expect(main.networkEvidence.execution.verdict).toBe("supported");
  });

  it("exact block identity: receipt, main fragment and supplement anchor are block 0xdafb…; ancestry depth 0 is read from the fixture", async () => {
    const { out, calls } = await resolve();
    const op = out.opStackFinality!;
    const supplement = supplementOf(out);
    const main = out.fragment as any;

    expect(RECEIPT).toMatchObject({ blockHash: BLOCK_HASH, blockNumber: BLOCK_TAG });
    expect(main.network.observedAt.blockId).toBe(BLOCK_HASH);
    expect(supplement.network.observedAt.blockId).toBe(RECEIPT.blockHash);
    expect(supplement.network.observedAt.blockId).toBe(main.network.observedAt.blockId);

    expect(op.captures!.filter(c => c.rpcMethod === "eth_getBlockByNumber").map(c => c.rpcParams))
      .toEqual([["finalized", false], ["safe", false], ["latest", false], [BLOCK_TAG, false], ["finalized", false]]);
    // The supplement walked no parent link; the generic EVM path read its block once, by hash.
    expect(op.captures!.filter(c => c.rpcMethod === "eth_getBlockByHash")).toHaveLength(0);
    expect(out.acquisition.captures.filter(c => c.rpcMethod === "eth_getBlockByHash")).toHaveLength(1);
    expect(calls.filter(c => c.method === "eth_getBlockByHash")).toEqual([
      { method: "eth_getBlockByHash", params: [RECEIPT.blockHash, false] },
    ]);
    // Each supplement capture is the fixture's own exchange, in order, with its exact result length.
    expect(op.captures!.map(c => [c.rpcMethod, c.rpcParams, c.httpStatus, c.resultBytes]))
      .toEqual(OP.captures.map(c => [c.rpcMethod, c.rpcParams, c.httpStatus, Buffer.byteLength(c.resultJson)]));

    // Depth from the fixture's own bytes: first finalized head height minus subject height.
    const finalizedHead = JSON.parse(OP.captures.find(c => c.rpcMethod === "eth_getBlockByNumber" && c.rpcParams[0] === "finalized")!.resultJson) as
      { number: string; hash: string };
    const depth = BigInt(finalizedHead.number) - BigInt(OP.subjectBlock.number);
    expect(depth).toBe(0n);
    expect(finalizedHead.hash).toBe(BLOCK_HASH);
    // Depth > 0 is not claimed for the real case: no link was walked.
    expect(supplement.networkEvidence.finality.metadata).toMatchObject({
      ancestryRequiredDepth: depth.toString(), ancestryWalkedLinks: "0",
      subjectBlockNumber: OP.subjectBlock.number, finalizedHeadNumber: OP.subjectBlock.number,
      maxAncestryDepth: LIVE_OPSTACK_MAX_ANCESTRY_DEPTH,
    });
  });

  it("two calls under the same pinned clock give byte-identical supplement wire, equal in verdict and basis to the native evaluateOpStackFinality replay", async () => {
    const first = await resolve();
    const second = await resolve();
    const firstWire = wire(first.out.opStackFinality!.fragment);
    expect(wire(second.out.opStackFinality!.fragment)).toBe(firstWire);

    const native = await nativeReplay();
    const nativeFinality = native.evaluation.fragment.networkEvidence.finality!;
    const finality = supplementOf(first.out).networkEvidence.finality;
    expect(nativeFinality.verdict).toBe("supported");
    expect(finality.verdict).toBe(nativeFinality.verdict);
    expect(finality.basis).toEqual(nativeFinality.basis);
    // Same source, same bytes, same recorded instant: the supplement cites the
    // native replay's own OP Stack capture digests. (The native generic EVM
    // replay keeps its own earlier instant, so whole fragments are not compared.)
    expect(first.out.opStackFinality!.captures!.map(c => c.contentDigest))
      .toEqual(native.finality.captures.map(c => c.contentDigest));
  });

  it("SIMULATED: a different hash at height 0x31f5527 (one value changed) gives contradicted", async () => {
    const { out } = await resolve({
      kind: "result", method: "eth_getBlockByNumber", params: [BLOCK_TAG, false], nth: 0,
      mutate: text => replaceOnce(text, `"hash":"${BLOCK_HASH}"`, `"hash":"${SIMULATED_HASH}"`),
    });
    expect(out.opStackFinality?.toolStatus).toBe("evaluated");
    const supplement = supplementOf(out);
    expect(supplement.networkEvidence.finality.verdict).toBe("contradicted");
    expect(codes(supplement.warnings)).toContain("OP_SUBJECT_NOT_CANONICAL_AT_HEIGHT");
    expect(supplement.networkEvidence).not.toHaveProperty("settlement");
    await expectMainAsReal(out);
  });

  it("SIMULATED: a null finalized head (one value changed) gives insufficient, never contradicted", async () => {
    const { out, unused } = await resolve({
      kind: "result", method: "eth_getBlockByNumber", params: ["finalized", false], nth: 0, mutate: () => "null",
    });
    expect(out.opStackFinality?.toolStatus).toBe("evaluated");
    const supplement = supplementOf(out);
    expect(supplement.networkEvidence.finality.verdict).toBe("insufficient");
    expect(supplement.networkEvidence.finality.verdict).not.toBe("contradicted");
    expect(codes(supplement.warnings)).toContain("OP_FINALIZED_HEAD_UNAVAILABLE");
    // No walk and no stability re-read without a finalized head.
    expect(out.opStackFinality!.captures!.filter(c => c.rpcMethod === "eth_getBlockByNumber").map(c => c.rpcParams))
      .toEqual([["finalized", false], ["safe", false], ["latest", false], [BLOCK_TAG, false]]);
    expect(unused()).toBe(1);
    expect(supplement.networkEvidence).not.toHaveProperty("settlement");
    await expectMainAsReal(out);
  });

  it("SIMULATED: a changed hash on the second finalized read (one value changed) gives ambiguous with conflicts", async () => {
    const { out } = await resolve({
      kind: "result", method: "eth_getBlockByNumber", params: ["finalized", false], nth: 1,
      mutate: text => replaceOnce(text, `"hash":"${BLOCK_HASH}"`, `"hash":"${SIMULATED_HASH}"`),
    });
    expect(out.opStackFinality?.toolStatus).toBe("evaluated");
    const supplement = supplementOf(out);
    expect(supplement.networkEvidence.finality.verdict).toBe("ambiguous");
    expect(supplement.conflicts.length).toBeGreaterThan(0);
    expect(codes(supplement.conflicts)).toContain("OP_FINALIZED_HEAD_STABLE");
    expect(supplement.networkEvidence).not.toHaveProperty("settlement");
    await expectMainAsReal(out);
  });

  it("SIMULATED: a throw on eth_getBlockByNumber gives toolStatus source_unavailable with no fragment", async () => {
    const { out, calls } = await resolve({ kind: "throw", method: "eth_getBlockByNumber" });
    expect(out.opStackFinality).toMatchObject({
      toolStatus: "source_unavailable", reason: "opstack_source_unavailable",
      withdrawalFinalization: "not_evaluated", ethereumSettlement: "not_evaluated",
    });
    expect(out.opStackFinality).not.toHaveProperty("fragment");
    expect(out.opStackFinality).not.toHaveProperty("captures");
    expect(calls.filter(c => c.method === "eth_getBlockByNumber")).toEqual([
      { method: "eth_getBlockByNumber", params: ["finalized", false] },
    ]);
    await expectMainAsReal(out);
  });
});
