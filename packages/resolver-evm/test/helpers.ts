import type { FetchLike } from "../src/index.js";
import { isValidRpcId } from "../src/index.js";
import type { EvmRpcSourceDescriptor } from "../src/index.js";

// ---------------------------------------------------------------------------
// Canonical sample world (Sepolia-shaped, deterministic)
// ---------------------------------------------------------------------------

export const NOW = "2026-03-14T09:26:53.589Z";

export const NETWORK_ID = "eip155:11155111";
export const CHAIN_ID_DEC = 11155111;
export const CHAIN_ID_HEX = "0xaa36a7";

export const TX = "0x1111111111111111111111111111111111111111111111111111111111111111";
export const OTHER_TX = "0x2222222222222222222222222222222222222222222222222222222222222222";
export const BLOCK_HASH = `0x${"ab".repeat(32)}`;
export const PARENT_HASH = `0x${"cd".repeat(32)}`;
export const STATE_ROOT = `0x${"01".repeat(32)}`;
export const TX_ROOT = `0x${"02".repeat(32)}`;
export const RECEIPTS_ROOT = `0x${"03".repeat(32)}`;
export const EMPTY_UNCLES = "0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347";
export const MINER = `0x${"99".repeat(20)}`;
export const FROM = `0x${"aa".repeat(20)}`;
export const TO = `0x${"bb".repeat(20)}`;
export const TOKEN = `0x${"cc".repeat(20)}`;
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const AMOUNT_WORD = `0x${"00".repeat(31)}64`;
export const BLOOM = `0x${"0".repeat(512)}`;
export const MIX_HASH = `0x${"00".repeat(32)}`;

export const BLOCK_NUMBER_HEX = "0x186a0"; // 100000

export function transferLog(logIndexHex: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    address: TOKEN,
    topics: [TRANSFER_TOPIC, `0x${"00".repeat(12)}${"aa".repeat(20)}`, `0x${"00".repeat(12)}${"bb".repeat(20)}`],
    data: AMOUNT_WORD,
    blockNumber: BLOCK_NUMBER_HEX,
    blockHash: BLOCK_HASH,
    transactionHash: TX,
    transactionIndex: "0x0",
    logIndex: logIndexHex,
    removed: false,
    ...overrides,
  });
}

export function successReceiptResultText(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    transactionHash: TX,
    transactionIndex: "0x0",
    blockHash: BLOCK_HASH,
    blockNumber: BLOCK_NUMBER_HEX,
    from: FROM,
    to: TO,
    contractAddress: null,
    cumulativeGasUsed: "0x13108",
    effectiveGasPrice: "0x3b9aca00",
    gasUsed: "0x5208",
    logs: [],
    logsBloom: BLOOM,
    status: "0x1",
    type: "0x2",
    ...overrides,
  });
}

export function successBlockResultText(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hash: BLOCK_HASH,
    parentHash: PARENT_HASH,
    number: BLOCK_NUMBER_HEX,
    timestamp: "0x66a1f3a0",
    stateRoot: STATE_ROOT,
    transactionsRoot: TX_ROOT,
    receiptsRoot: RECEIPTS_ROOT,
    miner: MINER,
    difficulty: "0x0",
    totalDifficulty: "0xc70d8159c67",
    gasUsed: "0x13108",
    gasLimit: "0x1c9c380",
    baseFeePerGas: "0x7",
    logsBloom: BLOOM,
    extraData: "0x",
    sha3Uncles: EMPTY_UNCLES,
    size: "0x205",
    mixHash: MIX_HASH,
    nonce: `0x${"00".repeat(8)}`,
    transactions: [TX],
    uncles: [],
    ...overrides,
  });
}

export function successTransactionResultText(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hash: TX,
    nonce: "0x2a",
    blockHash: BLOCK_HASH,
    blockNumber: BLOCK_NUMBER_HEX,
    transactionIndex: "0x0",
    from: FROM,
    to: TO,
    value: "0x2386f26fc10000",
    gas: "0x5208",
    gasPrice: "0x4a817c800",
    maxFeePerGas: "0x77359400",
    maxPriorityFeePerGas: "0x3b9aca00",
    input: "0x",
    chainId: CHAIN_ID_HEX,
    type: "0x2",
    accessList: [],
    v: "0x1",
    yParity: "0x1",
    r: `0x${"11".repeat(32)}`,
    s: `0x${"22".repeat(32)}`,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Scripted offline fetch (drives the ordinary Viem path with zero network)
// ---------------------------------------------------------------------------

export interface ScriptedResponse {
  readonly expectMethod: string;
  /** Complete HTTP response body text. */
  readonly bodyText: string;
  readonly status?: number;
  /**
   * Optional mutation applied to the response body AFTER the outbound
   * JSON-RPC request id has been bound into it. Used to force id-binding
   * violations in tests; the default echoes the actual outbound id.
   */
  readonly mutate?: (bodyText: string, outboundId: string | number | null) => string;
}

export function rpcResult(resultValueText: string, id = 7): string {
  return `{"jsonrpc":"2.0","id":${id},"result":${resultValueText}}`;
}

export function rpcError(code: number, message: string, id = 7): string {
  return `{"jsonrpc":"2.0","id":${id},"error":{"code":${code},"message":"${message}"}}`;
}

// ---------------------------------------------------------------------------
// Shared source descriptor + happy-path response script (non-test helpers)
// ---------------------------------------------------------------------------

export function source(overrides: Partial<EvmRpcSourceDescriptor> = {}): EvmRpcSourceDescriptor {
  return {
    sourceId: "src.sepolia.primary",
    sourceType: "evm_rpc",
    networkId: NETWORK_ID,
    chainId: CHAIN_ID_DEC,
    transport: { kind: "http", url: "https://sepolia.example/rpc/v3/SECRET-TOKEN" },
    independenceGroup: "sepolia-rpc-a",
    ...overrides,
  };
}

export function happyPathResponses(
  opts: { receipt?: string; block?: string; transaction?: string; chainId?: string } = {},
) {
  const responses: Array<{ expectMethod: string; bodyText: string }> = [
    {
      expectMethod: "eth_chainId",
      bodyText: rpcResult(JSON.stringify(opts.chainId ?? CHAIN_ID_HEX)),
    },
  ];
  if (opts.receipt !== "absent") {
    responses.push({
      expectMethod: "eth_getTransactionReceipt",
      bodyText: rpcResult(opts.receipt ?? successReceiptResultText()),
    });
  }
  if (opts.block !== undefined) {
    responses.push({ expectMethod: "eth_getBlockByHash", bodyText: rpcResult(opts.block) });
  }
  if (opts.transaction !== undefined) {
    responses.push({ expectMethod: "eth_getTransactionByHash", bodyText: rpcResult(opts.transaction) });
  }
  return responses;
}

/**
 * Rewrite the top-level envelope id so the response carries EXACTLY the
 * id of the actually-dispatched outbound request (request/response
 * binding), preserving every other byte of the scripted body.
 */
function bindEnvelopeId(bodyText: string, outboundId: unknown): string {
  if (!isValidRpcId(outboundId)) return bodyText;
  return bodyText.replace(/^(\{"jsonrpc":"2\.0","id":)[^,]*/, `$1${JSON.stringify(outboundId)}`);
}

export function scriptedFetch(responses: readonly ScriptedResponse[]): {
  fetchFn: FetchLike;
  seen: { methods: string[] };
} {
  const queue = [...responses];
  const seen: { methods: string[] } = { methods: [] };
  const fetchFn: FetchLike = async (_input, init) => {
    const bodyText = typeof init?.body === "string" ? init.body : "";
    const next = queue.shift();
    if (next === undefined) {
      throw new Error("scripted fetch exhausted");
    }
    let method = "";
    let outboundId: string | number | null = null;
    try {
      const parsed = JSON.parse(bodyText) as { method?: unknown; id?: unknown };
      method = typeof parsed.method === "string" ? parsed.method : "";
      if (isValidRpcId(parsed.id)) outboundId = parsed.id as string | number | null;
    } catch {
      method = "<unparseable>";
    }
    seen.methods.push(method);
    if (next.expectMethod !== method) {
      throw new Error(`scripted fetch expected ${next.expectMethod}, got ${method}`);
    }
    let responseBody = bindEnvelopeId(next.bodyText, outboundId);
    if (next.mutate !== undefined) responseBody = next.mutate(responseBody, outboundId);
    return new Response(responseBody, {
      status: next.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetchFn, seen };
}
