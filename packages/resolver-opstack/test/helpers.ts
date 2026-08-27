import { acquireTransactionObservation } from "@nec/resolver-evm";
import type {
  EvmRpcSourceDescriptor,
  EvmTransactionAcquisition,
  FetchLike,
} from "@nec/resolver-evm";
import { isValidRpcId } from "@nec/resolver-evm";

import type { OpStackFinalityConfig } from "../src/index.js";
import { OPSTACK_MAX_ANCESTRY_DEPTH } from "../src/index.js";

// ---------------------------------------------------------------------------
// Canonical sample world (Base-shaped, fully deterministic, offline)
// ---------------------------------------------------------------------------

export const NOW = "2026-08-24T12:00:00.000Z";

export const NETWORK_ID = "eip155:8453";
export const CHAIN_ID_DEC = 8453;
export const CHAIN_ID_HEX = "0x2105";

/** Subject transaction + containing L2 block anchor (synthetic, stable). */
export const TX = "0xcf496bca417f033e3ce5ad167e82a5bf95b2d815e4493de2f4943d3058b85afb";
export const SUBJECT_NUMBER = 100000n;
export const SUBJECT_NUMBER_HEX = "0x" + SUBJECT_NUMBER.toString(16);
export const SUBJECT_HASH = `0x${"ab".repeat(32)}`;
export const OTHER_HASH = `0x${"cd".repeat(32)}`;

/** Deterministic synthetic hash for chain-building (64 hex chars). */
export function chainHash(height: bigint): string {
  return "0x" + height.toString(16).padStart(8, "0").repeat(8);
}

export function blockResultText(
  numberValue: bigint,
  hash: string,
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    hash,
    parentHash: `0x${"ee".repeat(32)}`,
    number: "0x" + numberValue.toString(16),
    timestamp: "0x68ab1234",
    stateRoot: `0x${"01".repeat(32)}`,
    transactionsRoot: `0x${"02".repeat(32)}`,
    receiptsRoot: `0x${"03".repeat(32)}`,
    miner: "0x4200000000000000000000000000000000000011",
    difficulty: "0x0",
    gasUsed: "0x13108",
    gasLimit: "0x17d78400",
    baseFeePerGas: "0x4c4b40",
    logsBloom: `0x${"0".repeat(512)}`,
    extraData: "0x01000000640000000500000000004c4b40",
    sha3Uncles: "0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347",
    size: "0x205",
    mixHash: `0x${"00".repeat(32)}`,
    nonce: `0x${"00".repeat(8)}`,
    transactions: [TX],
    withdrawals: [],
    withdrawalsRoot: `0x${"04".repeat(32)}`,
    ...overrides,
  });
}

export function receiptResultText(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    transactionHash: TX,
    transactionIndex: "0x51",
    blockHash: SUBJECT_HASH,
    blockNumber: SUBJECT_NUMBER_HEX,
    from: `0x${"aa".repeat(20)}`,
    to: `0x${"bb".repeat(20)}`,
    contractAddress: null,
    cumulativeGasUsed: "0xb7c115",
    effectiveGasPrice: "0x4c5c25",
    gasUsed: "0x150e2",
    logs: [],
    logsBloom: `0x${"0".repeat(512)}`,
    status: "0x1",
    type: "0x2",
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Generic EVM acquisition (frozen @nec/resolver-evm pipeline, scripted)
// ---------------------------------------------------------------------------

interface ScriptedResponse {
  readonly expectMethod: string;
  /** When set, the FIRST rpc param must equal this value (block lookups). */
  readonly expectParam?: string;
  readonly resultJson?: string;
  readonly status?: number;
}

function bindEnvelopeId(bodyText: string, outboundId: unknown): string {
  if (!isValidRpcId(outboundId)) return bodyText;
  return bodyText.replace(/^(\{"jsonrpc":"2\.0","id":)[^,]*/, `$1${JSON.stringify(outboundId)}`);
}

function envelope(resultJson: string): string {
  return `{"jsonrpc":"2.0","id":1,"result":${resultJson}}`;
}

/**
 * Strict sequential scripted fetch: every dispatched read must match the
 * next script entry's method AND (when set) its first parameter.
 */
export function scriptedOpstackFetch(
  responses: readonly ScriptedResponse[],
): { fetchFn: FetchLike; seen: { calls: string[] } } {
  const queue = [...responses];
  const seen: { calls: string[] } = { calls: [] };
  const fetchFn: FetchLike = async (_input, init) => {
    const bodyText = typeof init?.body === "string" ? init.body : "";
    let method = "";
    let params: unknown[] = [];
    let outboundId: string | number | null = null;
    try {
      const parsed = JSON.parse(bodyText) as Record<string, unknown>;
      method = typeof parsed.method === "string" ? parsed.method : "";
      if (Array.isArray(parsed.params)) params = parsed.params;
      if (isValidRpcId(parsed.id)) outboundId = parsed.id as string | number | null;
    } catch {
      method = "<unparseable>";
    }
    const firstParam = params.length > 0 ? String(params[0]) : undefined;
    seen.calls.push(firstParam === undefined ? method : `${method}:${firstParam}`);
    const next = queue.shift();
    if (next === undefined) throw new Error("scripted fetch exhausted");
    if (next.expectMethod !== method) {
      throw new Error(`scripted fetch expected ${next.expectMethod}, got ${method}`);
    }
    if (next.expectParam !== undefined && next.expectParam !== firstParam) {
      throw new Error(`scripted fetch expected param ${next.expectParam}, got ${String(firstParam)}`);
    }
    let body: string;
    if (next.status !== undefined && next.status !== 200) {
      body = `{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"boom"}}`;
    } else {
      body = envelope(next.resultJson ?? "null");
    }
    return new Response(bindEnvelopeId(body, outboundId), {
      status: next.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetchFn, seen };
}

// ---------------------------------------------------------------------------
// OP Stack finality scripted burst (mirrors THE acquisition read order)
// ---------------------------------------------------------------------------

export type AncestryBreakMode =
  | "none"
  | "parent-hash"
  | "parent-number"
  | "null-parent"
  | "terminal-hash";

export interface OpstackResponsesOptions {
  chainIdHex?: string;
  finalized?: bigint | null;
  finalizedHash?: string;
  safe?: bigint | null;
  safeHash?: string;
  latest?: bigint | null;
  latestHash?: string;
  canonical?: { number: bigint; hash: string } | null;
  /** Second finalized read (burst-stability re-read); default mirrors the first. */
  finalizedReRead?: { number?: bigint; hash?: string } | null;
  /** Must mirror the acquisition input when a custom bound is used. */
  maxAncestryDepth?: number;
  /** Deterministic corruption injected into the walked ancestry chain. */
  ancestryBreak?: AncestryBreakMode;
}

/**
 * Build the full happy-path-shaped scripted response sequence in THE
 * pipeline's exact order:
 *
 *   eth_chainId
 *   eth_getBlockByNumber("finalized", false)
 *   eth_getBlockByNumber("safe", false)
 *   eth_getBlockByNumber("latest", false)
 *   [eth_getBlockByHash(<parentHash>, false) x requiredDepth]  (bounded)
 *   eth_getBlockByNumber(<S hex>, false)
 *   [eth_getBlockByNumber("finalized", false)]                 (after walk)
 *
 * When the observed finalized head lies at/above the subject height and the
 * required depth fits the bound, this helper synthesizes a fully LINKED
 * parentHash chain down to (and including) the subject block, mirroring the
 * real pipeline decision-for-decision.
 */
export function opstackResponses(opts: OpstackResponsesOptions = {}): ScriptedResponse[] {
  const responses: ScriptedResponse[] = [
    { expectMethod: "eth_chainId", resultJson: JSON.stringify(opts.chainIdHex ?? CHAIN_ID_HEX) },
  ];

  const finalized =
    opts.finalized === undefined ? SUBJECT_NUMBER + 3n : opts.finalized;
  const safe = opts.safe === undefined ? SUBJECT_NUMBER + 4n : opts.safe;
  const latest = opts.latest === undefined ? SUBJECT_NUMBER + 5n : opts.latest;
  const maxDepth = opts.maxAncestryDepth ?? OPSTACK_MAX_ANCESTRY_DEPTH;
  const breakMode: AncestryBreakMode = opts.ancestryBreak ?? "none";

  // Hash of the chain block at height h (the subject block anchors the chain).
  const subjectChainHash = breakMode === "terminal-hash" ? OTHER_HASH : SUBJECT_HASH;
  const chainBlockHash = (h: bigint): string =>
    h === SUBJECT_NUMBER ? subjectChainHash : chainHash(h);

  const finalizedNumber = finalized;
  const finalizedBlockHash = opts.finalizedHash ?? (finalized === null ? "" : chainBlockHash(finalized));

  if (finalized === null) {
    responses.push({ expectMethod: "eth_getBlockByNumber", expectParam: "finalized", resultJson: "null" });
  } else {
    const parentOfFinalized = finalized - 1n >= SUBJECT_NUMBER ? chainBlockHash(finalized - 1n) : `0x${"ee".repeat(32)}`;
    responses.push({
      expectMethod: "eth_getBlockByNumber",
      expectParam: "finalized",
      resultJson: blockResultText(finalized, finalizedBlockHash, {
        parentHash: finalized > SUBJECT_NUMBER ? parentOfFinalized : `0x${"11".repeat(32)}`,
      }),
    });
  }

  if (safe === null) {
    responses.push({ expectMethod: "eth_getBlockByNumber", expectParam: "safe", resultJson: "null" });
  } else {
    responses.push({
      expectMethod: "eth_getBlockByNumber",
      expectParam: "safe",
      resultJson: blockResultText(safe, opts.safeHash ?? chainBlockHash(safe)),
    });
  }

  if (latest === null) {
    responses.push({ expectMethod: "eth_getBlockByNumber", expectParam: "latest", resultJson: "null" });
  } else {
    responses.push({
      expectMethod: "eth_getBlockByNumber",
      expectParam: "latest",
      resultJson: blockResultText(latest, opts.latestHash ?? chainBlockHash(latest)),
    });
  }

  // Required bounded ancestry walk (mirrors the pipeline gate exactly).
  const walkRequired = finalized !== null && finalized >= SUBJECT_NUMBER;
  const requiredDepth = walkRequired ? finalized - SUBJECT_NUMBER : 0n;
  const walkPerformed = walkRequired && requiredDepth <= BigInt(maxDepth);
  if (walkPerformed) {
    for (let i = 0n; i < requiredDepth; i++) {
      const childHeight = finalized - i;
      const requestedParentHash = chainBlockHash(childHeight - 1n);
      if (breakMode === "parent-hash" && i === 0n) {
        // Correct height, wrong identity: breaks ONLY the hash-chain invariant.
        responses.push({
          expectMethod: "eth_getBlockByHash",
          expectParam: requestedParentHash,
          resultJson: blockResultText(childHeight - 1n, OTHER_HASH, { parentHash: requestedParentHash }),
        });
        break;
      }
      if (breakMode === "parent-number" && i === 0n) {
        // Requested identity, wrong height: breaks ONLY the height-sequence invariant.
        responses.push({
          expectMethod: "eth_getBlockByHash",
          expectParam: requestedParentHash,
          resultJson: blockResultText(childHeight - 3n, requestedParentHash),
        });
        break;
      }
      if (breakMode === "null-parent" && i === 0n) {
        responses.push({
          expectMethod: "eth_getBlockByHash",
          expectParam: requestedParentHash,
          resultJson: "null",
        });
        break;
      }
      responses.push({
        expectMethod: "eth_getBlockByHash",
        expectParam: requestedParentHash,
        resultJson: blockResultText(childHeight - 1n, requestedParentHash, {
          parentHash: childHeight - 1n > SUBJECT_NUMBER ? chainBlockHash(childHeight - 2n) : `0x${"22".repeat(32)}`,
        }),
      });
    }
  }

  if (opts.canonical === null) {
    responses.push({
      expectMethod: "eth_getBlockByNumber",
      expectParam: SUBJECT_NUMBER_HEX,
      resultJson: "null",
    });
  } else {
    // Happy-path default: the canonical block at S still equals the subject
    // containing-block anchor.
    responses.push({
      expectMethod: "eth_getBlockByNumber",
      expectParam: SUBJECT_NUMBER_HEX,
      resultJson: blockResultText(
        opts.canonical?.number ?? SUBJECT_NUMBER,
        opts.canonical?.hash ?? SUBJECT_HASH,
      ),
    });
  }

  if (walkPerformed) {
    const reRead = opts.finalizedReRead;
    if (reRead === null) {
      responses.push({ expectMethod: "eth_getBlockByNumber", expectParam: "finalized", resultJson: "null" });
    } else {
      responses.push({
        expectMethod: "eth_getBlockByNumber",
        expectParam: "finalized",
        resultJson: blockResultText(reRead?.number ?? finalized, reRead?.hash ?? finalizedBlockHash, {
          parentHash:
            finalized > SUBJECT_NUMBER ? chainBlockHash(finalized - 1n) : `0x${"11".repeat(32)}`,
        }),
      });
    }
  }

  return responses;
}

export function opstackSource(
  overrides: Partial<EvmRpcSourceDescriptor> = {},
): EvmRpcSourceDescriptor {
  return {
    sourceId: "src.base.primary",
    sourceType: "evm_rpc",
    networkId: NETWORK_ID,
    chainId: CHAIN_ID_DEC,
    transport: { kind: "http", url: "https://base.example/rpc/SECRET-KEY" },
    independenceGroup: "base-public-rpc",
    ...overrides,
  };
}

export function config(overrides: Partial<OpStackFinalityConfig> = {}): OpStackFinalityConfig {
  return {
    networkId: NETWORK_ID,
    chainId: CHAIN_ID_DEC,
    family: "opstack",
    ruleset: "opstack.rpc-finalized-head-v1",
    rulesetVersion: "1",
    ...overrides,
  };
}

/**
 * Acquire ONE generic EVM transaction observation whose receipt binds TX to
 * the containing block (SUBJECT_NUMBER, SUBJECT_HASH) — the frozen upstream
 * flow this package consumes.
 */
export async function genericAcquisition(
  overrides: { receipt?: Record<string, unknown>; blockHash?: string; blockNumber?: bigint } = {},
): Promise<EvmTransactionAcquisition> {
  const receiptOverrides = overrides.receipt ?? {};
  const blockHash = overrides.blockHash ?? SUBJECT_HASH;
  const blockNumber = overrides.blockNumber ?? SUBJECT_NUMBER;
  const responses: ScriptedResponse[] = [
    { expectMethod: "eth_chainId", resultJson: JSON.stringify(CHAIN_ID_HEX) },
    {
      expectMethod: "eth_getTransactionReceipt",
      resultJson: receiptResultText({ blockHash, blockNumber: "0x" + blockNumber.toString(16), ...receiptOverrides }),
    },
    {
      expectMethod: "eth_getBlockByHash",
      resultJson: blockResultText(blockNumber, blockHash),
    },
  ];
  // Sequential single-source scripting: same helper, generic read order.
  const { fetchFn } = scriptedOpstackFetch(responses);
  return acquireTransactionObservation({
    source: opstackSource(),
    txHash: TX,
    now: NOW,
    fetchFn,
  });
}
