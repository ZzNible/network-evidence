/**
 * NORMALIZATION: raw captured result text -> deterministic resolver-local
 * EVM observations.
 *
 * Every typed value below is derived EXCLUSIVELY from the byte-exact raw
 * capture text via strict parsing — Viem's decoded objects drive request
 * flow only and are never trusted as evidence. Unknown members of provider
 * objects are preserved as bounded JSON-safe `extras` (validated with the
 * core plain-record walker) instead of being silently dropped.
 */

import { assertPlainRecord, RESOURCE_LIMITS } from "@nec/core";

import { evmFail } from "./errors.js";
import { NecResolverEvmError } from "./errors.js";
import { parseResultJsonStrict } from "./json.js";
import type { EvmAddress, EvmHash, EvmHexBytes } from "./hex.js";
import {
  parseHexAddress,
  parseHexBloom,
  parseHexBytes,
  parseHexHash,
  parseHexQuantity,
} from "./hex.js";

// ---------------------------------------------------------------------------
// Normalized observation contracts
// ---------------------------------------------------------------------------

export interface EvmLogObservation {
  readonly address: EvmAddress;
  readonly topics: readonly EvmHash[];
  readonly data: EvmHexBytes;
  readonly blockNumber: bigint;
  readonly blockHash: EvmHash;
  readonly transactionHash: EvmHash;
  readonly transactionIndex: bigint;
  /** Position of the log within the block. */
  readonly logIndex: bigint;
  readonly removed: boolean;
  /** Bounded JSON-safe preservation of unconsumed provider fields. */
  readonly extras: Readonly<Record<string, unknown>>;
}

export interface EvmReceiptObservation {
  readonly transactionHash: EvmHash;
  readonly transactionIndex: bigint;
  readonly blockHash: EvmHash;
  readonly blockNumber: bigint;
  readonly from: EvmAddress;
  readonly to: EvmAddress | null;
  readonly contractAddress: EvmAddress | null;
  readonly status: "success" | "reverted";
  readonly gasUsed: bigint;
  readonly cumulativeGasUsed: bigint;
  readonly effectiveGasPrice?: bigint;
  readonly type?: bigint;
  readonly logsBloom: EvmHexBytes;
  readonly logs: readonly EvmLogObservation[];
  /** Bounded JSON-safe preservation of unconsumed provider fields. */
  readonly extras: Readonly<Record<string, unknown>>;
}

export interface EvmBlockObservation {
  readonly hash: EvmHash;
  readonly parentHash: EvmHash;
  readonly number: bigint;
  readonly timestamp: bigint;
  readonly stateRoot: EvmHash;
  readonly transactionsRoot: EvmHash;
  readonly receiptsRoot: EvmHash;
  readonly miner: EvmAddress;
  readonly gasUsed: bigint;
  readonly gasLimit: bigint;
  readonly baseFeePerGas?: bigint;
  readonly logsBloom: EvmHexBytes;
  readonly extraData: EvmHexBytes;
  /** Transaction hashes (eth_getBlockByHash is always queried with full=false). */
  readonly transactions: readonly EvmHash[];
  readonly extras: Readonly<Record<string, unknown>>;
}

export interface EvmTransactionObservation {
  readonly hash: EvmHash;
  readonly nonce: bigint;
  readonly blockHash: EvmHash | null;
  readonly blockNumber: bigint | null;
  readonly transactionIndex: bigint | null;
  readonly from: EvmAddress;
  readonly to: EvmAddress | null;
  readonly value: bigint;
  readonly gas: bigint;
  readonly input: EvmHexBytes;
  readonly type?: bigint;
  readonly gasPrice?: bigint;
  readonly maxFeePerGas?: bigint;
  readonly maxPriorityFeePerGas?: bigint;
  readonly chainId?: bigint;
  readonly extras: Readonly<Record<string, unknown>>;
}

export interface EvmChainIdentityObservation {
  readonly chainId: bigint;
}

// ---------------------------------------------------------------------------
// Strict object-field readers (input is JSON.parse output only)
// ---------------------------------------------------------------------------

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new NecResolverEvmError("EVM_MALFORMED_RESPONSE", `${path}: must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function required<T>(record: Record<string, unknown>, key: string, path: string, parse: (raw: unknown, p: string) => T): T {
  if (!Object.prototype.hasOwnProperty.call(record, key)) {
    throw new NecResolverEvmError("EVM_MALFORMED_RESPONSE", `${path}.${key}: missing required field`);
  }
  try {
    return parse(record[key], `${path}.${key}`);
  } catch (error) {
    if (error instanceof NecResolverEvmError) throw error;
    throw new NecResolverEvmError("EVM_MALFORMED_RESPONSE", `${path}.${key}: ${(error as Error).message}`);
  }
}

function nullableRequired<T>(
  record: Record<string, unknown>,
  key: string,
  path: string,
  parse: (raw: unknown, p: string) => T,
): T | null {
  if (!Object.prototype.hasOwnProperty.call(record, key)) {
    throw new NecResolverEvmError("EVM_MALFORMED_RESPONSE", `${path}.${key}: missing required field`);
  }
  if (record[key] === null) return null;
  try {
    return parse(record[key], `${path}.${key}`);
  } catch (error) {
    if (error instanceof NecResolverEvmError) throw error;
    throw new NecResolverEvmError("EVM_MALFORMED_RESPONSE", `${path}.${key}: ${(error as Error).message}`);
  }
}

function optionalQuantity(record: Record<string, unknown>, key: string, path: string): bigint | undefined {
  const raw = record[key];
  if (raw === undefined) return undefined;
  return parseHexQuantity(raw, `${path}.${key}`);
}

/**
 * Collect every field NOT consumed by the explicit schema into a bounded
 * JSON-safe record. Uses the core plain-record walker so accessors, exotic
 * prototypes, unsafe numbers, oversized strings and reserved score keys all
 * fail closed.
 */
function collectExtras(
  record: Record<string, unknown>,
  consumedKeys: readonly string[],
  path: string,
): Record<string, unknown> {
  const consumed = new Set(consumedKeys);
  // Null-prototype record + explicit property definition so an own
  // "__proto__" DATA field from the provider is preserved inertly (never
  // routed through the Object.prototype setter, never silently dropped).
  const extras: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!consumed.has(key)) {
      Object.defineProperty(extras, key, {
        value: record[key],
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  if (Object.keys(extras).length === 0) return extras;
  try {
    assertPlainRecord(extras, `${path}.extras`);
  } catch (error) {
    throw new NecResolverEvmError(
      "EVM_MALFORMED_RESPONSE",
      `${path}: unhandled provider fields are not bounded JSON-safe data (${(error as Error).message})`,
    );
  }
  return extras;
}

function parseStatus(raw: unknown, path: string): "success" | "reverted" {
  const status = parseHexQuantity(raw, path);
  if (status === 1n) return "success";
  if (status === 0n) return "reverted";
  throw new NecResolverEvmError("EVM_MALFORMED_RESPONSE", `${path}: receipt status must be 0x0 or 0x1`);
}

function parseRemovedFlag(raw: unknown, path: string): boolean {
  if (typeof raw !== "boolean") {
    throw new NecResolverEvmError("EVM_MALFORMED_RESPONSE", `${path}: removed must be a boolean`);
  }
  return raw;
}

function parseTopicsArray(raw: unknown, path: string): EvmHash[] {
  if (!Array.isArray(raw)) {
    throw new NecResolverEvmError("EVM_MALFORMED_RESPONSE", `${path}.topics: must be an array`);
  }
  if (raw.length > 5) {
    // Deterministic bound; real logs have <= 4 topics.
    throw new NecResolverEvmError("EVM_LIMIT_EXCEEDED", `${path}.topics: more than 5 topics`);
  }
  return raw.map((topic, index) => parseHexHash(topic, `${path}.topics[${index}]`));
}

function parseTransactionHashArray(raw: unknown, path: string): EvmHash[] {
  if (!Array.isArray(raw)) {
    throw new NecResolverEvmError("EVM_MALFORMED_RESPONSE", `${path}: transactions must be an array`);
  }
  if (raw.length > RESOURCE_LIMITS.MAX_CONTAINER_ENTRIES) {
    throw new NecResolverEvmError(
      "EVM_LIMIT_EXCEEDED",
      `${path}: more than ${RESOURCE_LIMITS.MAX_CONTAINER_ENTRIES} entries`,
    );
  }
  return raw.map((hash, index) => parseHexHash(hash, `${path}[${index}]`));
}

// ---------------------------------------------------------------------------
// Result-text -> observation builders
// ---------------------------------------------------------------------------

/** Parses the raw `result` text of eth_chainId ("\"0x2105\""). */
export function parseChainIdResult(resultText: string): EvmChainIdentityObservation {
  const parsed = jsonParseStrict(resultText, "eth_chainId result");
  return { chainId: parseHexQuantity(parsed, "eth_chainId") };
}

export function parseReceiptResult(resultText: string): EvmReceiptObservation | null {
  const parsed = jsonParseStrict(resultText, "eth_getTransactionReceipt result");
  if (parsed === null) return null;
  const r = requireObject(parsed, "receipt");
  const consumedKeys = [
    "transactionHash",
    "transactionIndex",
    "blockHash",
    "blockNumber",
    "from",
    "to",
    "contractAddress",
    "status",
    "gasUsed",
    "cumulativeGasUsed",
    "effectiveGasPrice",
    "type",
    "logsBloom",
    "logs",
  ];
  const logsRaw = required(r, "logs", "receipt", (raw, path) => {
    if (!Array.isArray(raw)) {
      throw new NecResolverEvmError("EVM_MALFORMED_RESPONSE", `${path}: must be an array`);
    }
    if (raw.length > RESOURCE_LIMITS.MAX_CONTAINER_ENTRIES) {
      throw new NecResolverEvmError(
        "EVM_LIMIT_EXCEEDED",
        `${path}: more than ${RESOURCE_LIMITS.MAX_CONTAINER_ENTRIES} entries`,
      );
    }
    return raw;
  });
  const logs = logsRaw.map((entry, index) => parseLog(entry, `receipt.logs[${index}]`));
  const status = required(r, "status", "receipt", parseStatus);
  const extras = collectExtras(r, consumedKeys, "receipt");
  const effectiveGasPrice = optionalQuantity(r, "effectiveGasPrice", "receipt");
  const type = optionalQuantity(r, "type", "receipt");
  return {
    transactionHash: required(r, "transactionHash", "receipt", parseHexHash),
    transactionIndex: required(r, "transactionIndex", "receipt", parseHexQuantity),
    blockHash: required(r, "blockHash", "receipt", parseHexHash),
    blockNumber: required(r, "blockNumber", "receipt", parseHexQuantity),
    from: required(r, "from", "receipt", parseHexAddress),
    to: nullableRequired(r, "to", "receipt", parseHexAddress),
    contractAddress: nullableRequired(r, "contractAddress", "receipt", parseHexAddress),
    status,
    gasUsed: required(r, "gasUsed", "receipt", parseHexQuantity),
    cumulativeGasUsed: required(r, "cumulativeGasUsed", "receipt", parseHexQuantity),
    ...(effectiveGasPrice === undefined ? {} : { effectiveGasPrice }),
    ...(type === undefined ? {} : { type }),
    logsBloom: required(r, "logsBloom", "receipt", parseHexBloom),
    logs,
    extras,
  };
}

export function parseLog(raw: unknown, path: string): EvmLogObservation {
  const l = requireObject(raw, path);
  const consumedKeys = [
    "address",
    "topics",
    "data",
    "blockNumber",
    "blockHash",
    "transactionHash",
    "transactionIndex",
    "logIndex",
    "removed",
  ];
  const extras = collectExtras(l, consumedKeys, path);
  return {
    address: required(l, "address", path, parseHexAddress),
    topics: required(l, "topics", path, parseTopicsArray),
    data: required(l, "data", path, parseHexBytes),
    blockNumber: required(l, "blockNumber", path, parseHexQuantity),
    blockHash: required(l, "blockHash", path, parseHexHash),
    transactionHash: required(l, "transactionHash", path, parseHexHash),
    transactionIndex: required(l, "transactionIndex", path, parseHexQuantity),
    logIndex: required(l, "logIndex", path, parseHexQuantity),
    removed: required(l, "removed", path, parseRemovedFlag),
    extras,
  };
}

export function parseBlockResult(resultText: string): EvmBlockObservation | null {
  const parsed = jsonParseStrict(resultText, "eth_getBlockByHash result");
  if (parsed === null) {
    // The receipt references this block; a null block is a SEMANTIC
    // inconsistency surfaced through consistency checks by the caller.
    return null;
  }
  const b = requireObject(parsed, "block");
  const consumedKeys = [
    "hash",
    "parentHash",
    "number",
    "timestamp",
    "stateRoot",
    "transactionsRoot",
    "receiptsRoot",
    "miner",
    "gasUsed",
    "gasLimit",
    "baseFeePerGas",
    "logsBloom",
    "extraData",
    "transactions",
  ];
  const extras = collectExtras(b, consumedKeys, "block");
  const baseFeePerGas = optionalQuantity(b, "baseFeePerGas", "block");
  return {
    hash: required(b, "hash", "block", parseHexHash),
    parentHash: required(b, "parentHash", "block", parseHexHash),
    number: required(b, "number", "block", parseHexQuantity),
    timestamp: required(b, "timestamp", "block", parseHexQuantity),
    stateRoot: required(b, "stateRoot", "block", parseHexHash),
    transactionsRoot: required(b, "transactionsRoot", "block", parseHexHash),
    receiptsRoot: required(b, "receiptsRoot", "block", parseHexHash),
    miner: required(b, "miner", "block", parseHexAddress),
    gasUsed: required(b, "gasUsed", "block", parseHexQuantity),
    gasLimit: required(b, "gasLimit", "block", parseHexQuantity),
    ...(baseFeePerGas === undefined ? {} : { baseFeePerGas }),
    logsBloom: required(b, "logsBloom", "block", parseHexBloom),
    extraData: required(b, "extraData", "block", parseHexBytes),
    transactions: required(b, "transactions", "block", parseTransactionHashArray),
    extras,
  };
}

export function parseTransactionResult(resultText: string): EvmTransactionObservation | null {
  const parsed = jsonParseStrict(resultText, "eth_getTransactionByHash result");
  if (parsed === null) return null;
  const t = requireObject(parsed, "transaction");
  // Exactly the fields mapped below; signature fields (v/r/s/yParity),
  // accessList and blob parameters flow into `extras` instead of being
  // dropped — they may matter as evidence later.
  const consumedKeys = [
    "hash",
    "nonce",
    "blockHash",
    "blockNumber",
    "transactionIndex",
    "from",
    "to",
    "value",
    "gas",
    "input",
    "type",
    "gasPrice",
    "maxFeePerGas",
    "maxPriorityFeePerGas",
    "chainId",
  ];
  const extras = collectExtras(t, consumedKeys, "transaction");
  const type = optionalQuantity(t, "type", "transaction");
  const gasPrice = optionalQuantity(t, "gasPrice", "transaction");
  const maxFeePerGas = optionalQuantity(t, "maxFeePerGas", "transaction");
  const maxPriorityFeePerGas = optionalQuantity(t, "maxPriorityFeePerGas", "transaction");
  const chainId = optionalQuantity(t, "chainId", "transaction");
  return {
    hash: required(t, "hash", "transaction", parseHexHash),
    nonce: required(t, "nonce", "transaction", parseHexQuantity),
    blockHash: nullableRequired(t, "blockHash", "transaction", parseHexHash),
    blockNumber: nullableRequired(t, "blockNumber", "transaction", parseHexQuantity),
    transactionIndex: nullableRequired(t, "transactionIndex", "transaction", parseHexQuantity),
    from: required(t, "from", "transaction", parseHexAddress),
    to: nullableRequired(t, "to", "transaction", parseHexAddress),
    value: required(t, "value", "transaction", parseHexQuantity),
    gas: required(t, "gas", "transaction", parseHexQuantity),
    input: required(t, "input", "transaction", parseHexBytes),
    ...(type === undefined ? {} : { type }),
    ...(gasPrice === undefined ? {} : { gasPrice }),
    ...(maxFeePerGas === undefined ? {} : { maxFeePerGas }),
    ...(maxPriorityFeePerGas === undefined ? {} : { maxPriorityFeePerGas }),
    ...(chainId === undefined ? {} : { chainId }),
    extras,
  };
}

function jsonParseStrict(text: string, what: string): unknown {
  // Duplicate-key-rejecting, resource-bounded parser: a hostile provider
  // cannot rely on last-write-wins ambiguity inside captured evidence.
  try {
    return parseResultJsonStrict(text);
  } catch (error) {
    if (error instanceof NecResolverEvmError) {
      throw new NecResolverEvmError(error.code, `${what}: ${error.message}`);
    }
    throw new NecResolverEvmError("EVM_MALFORMED_RESPONSE", `${what}: invalid JSON`);
  }
}
