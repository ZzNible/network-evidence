/**
 * Strict, canonical EVM hex parsing.
 *
 * The normalized observation layer NEVER trusts Viem's decoded values for
 * evidence: every typed value is re-derived here from the captured raw
 * JSON-RPC result text. Rules:
 *
 *   - quantities: `0x` + lowercase hex digits, parsed with BigInt (arbitrary
 *     magnitude; never `Number(...)`, so a hostile 40-digit block number
 *     cannot lose precision);
 *   - hashes/addresses/blooms/byte strings: exact length, lowercase only —
 *     providers emit canonical lowercase hex; anything else fails closed;
 *   - no silent coercion, no repair.
 */

import { MAX_DECIMAL_INTEGER_DIGITS } from "@nec/core";

import { NecResolverEvmError } from "./errors.js";

const QUANTITY_PATTERN = /^0x[0-9a-f]+$/;
const HASH_PATTERN = /^0x[0-9a-f]{64}$/;
const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
const BLOOM_PATTERN = /^0x[0-9a-f]{512}$/;
const BYTES_PATTERN = /^0x(?:[0-9a-f]{2})*$/;

export type EvmHash = string;
export type EvmAddress = string;
export type EvmHexBytes = string;

export function parseHexQuantity(value: unknown, path: string): bigint {
  if (typeof value !== "string" || !QUANTITY_PATTERN.test(value)) {
    throw new NecResolverEvmError(
      "EVM_MALFORMED_RESPONSE",
      `${path}: must be a canonical 0x-prefixed lowercase hex quantity`,
    );
  }
  // Same decimal-digit bound the core wire profile applies to schema-typed
  // integers; a quantity that large is not a plausible EVM value and would
  // otherwise be an unbounded DoS input.
  if (value.length - 2 > MAX_DECIMAL_INTEGER_DIGITS) {
    throw new NecResolverEvmError(
      "EVM_LIMIT_EXCEEDED",
      `${path}: hex quantity exceeds ${MAX_DECIMAL_INTEGER_DIGITS} digits`,
    );
  }
  return BigInt(value);
}

export function parseHexHash(value: unknown, path: string): EvmHash {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw new NecResolverEvmError(
      "EVM_MALFORMED_RESPONSE",
      `${path}: must be a lowercase 0x-prefixed 32-byte hash`,
    );
  }
  return value;
}

export function parseHexAddress(value: unknown, path: string): EvmAddress {
  if (typeof value !== "string" || !ADDRESS_PATTERN.test(value)) {
    throw new NecResolverEvmError(
      "EVM_MALFORMED_RESPONSE",
      `${path}: must be a lowercase 0x-prefixed 20-byte address`,
    );
  }
  return value;
}

export function parseHexBloom(value: unknown, path: string): EvmHexBytes {
  if (typeof value !== "string" || !BLOOM_PATTERN.test(value)) {
    throw new NecResolverEvmError(
      "EVM_MALFORMED_RESPONSE",
      `${path}: must be a lowercase 0x-prefixed 2048-bit logs bloom`,
    );
  }
  return value;
}

export function parseHexBytes(value: unknown, path: string): EvmHexBytes {
  if (typeof value !== "string" || !BYTES_PATTERN.test(value)) {
    throw new NecResolverEvmError(
      "EVM_MALFORMED_RESPONSE",
      `${path}: must be a lowercase 0x-prefixed byte string with even digit count`,
    );
  }
  return value;
}

/** A transaction hash as supplied by NEC callers (canonical form required). */
export function parseTransactionHashInput(value: unknown): EvmHash {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw new NecResolverEvmError(
      "EVM_TX_HASH_INVALID",
      "txHash must be a lowercase 0x-prefixed 32-byte transaction hash",
    );
  }
  return value;
}
