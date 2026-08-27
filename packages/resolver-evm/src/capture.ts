/**
 * RAW CAPTURE model.
 *
 * A capture preserves exactly what ONE configured source returned for ONE
 * JSON-RPC request, in a deterministic, secret-free representation:
 *
 *   - `resultText` is the byte-exact raw text of the envelope's `result`
 *     VALUE (provider key order and whitespace preserved) — no intermediate
 *     JS value can lose integer precision or formatting evidence;
 *   - provenance (sourceId/sourceType/independenceGroup/networkId) is
 *     embedded in every capture;
 *   - `acquiredAt` comes from the supplied context, never from a clock;
 *   - `contentDigest` binds the complete capture record under an explicit
 *     resolver-local digest domain.
 */

import { digestCanonicalJson } from "@nec/core";
import type { Digest, Iso8601, NetworkId } from "@nec/core";

import { NecResolverEvmError, evmFail } from "./errors.js";
import { assertInertDataObject, assertInertJsonTree, assertNotProxy } from "./inert.js";
import { scanRpcEnvelope } from "./envelope.js";
import type { RpcEnvelope } from "./envelope.js";
import type { SourceProvenance } from "./source.js";

export const CAPTURE_PROFILE = "nec-resolver-evm-capture-v1";
export const CAPTURE_DIGEST_DOMAIN = "resolver-evm-capture-v1";

/** One successful JSON-RPC exchange with one evidentiary source. */
export interface EvmRpcCapture {
  readonly profile: typeof CAPTURE_PROFILE;
  readonly sourceId: string;
  readonly sourceType: string;
  readonly independenceGroup?: string;
  readonly networkId: NetworkId;
  readonly rpcMethod: string;
  /** JSON-safe request parameters exactly as sent. */
  readonly rpcParams: readonly unknown[];
  readonly httpStatus: number;
  /** Byte-exact raw text of the envelope's `result` value. */
  readonly resultText: string;
  readonly acquiredAt: Iso8601;
  /** Digest binding the complete capture record (provenance + content). */
  readonly contentDigest: Digest;
}

const RPC_METHOD_PATTERN = /^[A-Za-z0-9_]{1,64}$/;
const MAX_CAPTURES = 64;

/**
 * Stable, bounded canonical text for JSON-safe values (sorted object keys).
 * Used for capture identity (request matching in replay) and digests.
 */
export function stableJsonKey(value: unknown, depth = 1): string {
  if (depth > 32) evmFail("EVM_LIMIT_EXCEEDED", "rpc params exceed maximum nesting depth");
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isSafeInteger(value)) {
        evmFail("EVM_MALFORMED_RESPONSE", "rpc params contain a non-safe-integer number");
      }
      return String(value);
    case "object": {
      if (value === null) return "null";
      if (Array.isArray(value)) {
        const proto = Object.getPrototypeOf(value) as object | null;
        if (proto !== Array.prototype) evmFail("EVM_MALFORMED_RESPONSE", "rpc params contain a non-plain array");
        return `[${value.map((item) => stableJsonKey(item, depth + 1)).join(",")}]`;
      }
      const proto = Object.getPrototypeOf(value) as object | null;
      if (proto !== Object.prototype && proto !== null) {
        evmFail("EVM_MALFORMED_RESPONSE", "rpc params contain a non-plain object");
      }
      const keys = Object.keys(value).sort();
      const parts = keys.map((key) => `${JSON.stringify(key)}:${stableJsonKey((value as Record<string, unknown>)[key], depth + 1)}`);
      return `{${parts.join(",")}}`;
    }
    default:
      evmFail("EVM_MALFORMED_RESPONSE", "rpc params contain an unsupported value");
  }
}

/** Identity key of one exchange: method + canonical parameter form. */
export function exchangeIdentityKey(rpcMethod: string, rpcParams: readonly unknown[]): string {
  return `${rpcMethod} ${stableJsonKey(rpcParams)}`;
}

function validateRpcMethod(method: unknown): asserts method is string {
  if (typeof method !== "string" || !RPC_METHOD_PATTERN.test(method)) {
    throw new NecResolverEvmError("EVM_MALFORMED_RESPONSE", "rpcMethod must match ^[A-Za-z0-9_]{1,64}$");
  }
}

/**
 * Validate rpcParams END TO END descriptor-first: the complete tree is
 * proven inert (plain prototypes, enumerable data properties only, no
 * symbol-keyed members, safe integers, bounded size) BEFORE any value is
 * read, canonicalized or iterated — so no caller-owned accessor can ever
 * execute merely because NEC is validating the parameters.
 */
function validateRpcParams(params: unknown): asserts params is readonly unknown[] {
  if (!Array.isArray(params)) {
    throw new NecResolverEvmError("EVM_MALFORMED_RESPONSE", "rpcParams must be an array");
  }
  assertInertJsonTree(params, "rpcParams", { nodes: 0 }, 1, "EVM_MALFORMED_RESPONSE");
}

/**
 * Bind a scanned response envelope to the outbound request id: a response
 * may only be consumed when its `id` is present and EXACTLY equals the id
 * actually sent. Mismatched or missing ids fail closed.
 */
function assertBoundResponseId(
  envelope: RpcEnvelope,
  rpcRequestId: string | number | null,
  rpcMethod: string,
): void {
  if (envelope.id === undefined || envelope.id !== rpcRequestId) {
    throw new NecResolverEvmError(
      "EVM_MALFORMED_RESPONSE",
      `${rpcMethod}: response "id" does not match the outbound request id`,
    );
  }
}

function computeCaptureDigest(capture: Omit<EvmRpcCapture, "contentDigest">): Digest {
  const record = {
    profile: capture.profile,
    sourceId: capture.sourceId,
    sourceType: capture.sourceType,
    ...(capture.independenceGroup === undefined ? {} : { independenceGroup: capture.independenceGroup }),
    networkId: capture.networkId,
    rpcMethod: capture.rpcMethod,
    rpcParams: [...capture.rpcParams],
    httpStatus: capture.httpStatus,
    resultText: capture.resultText,
    acquiredAt: capture.acquiredAt,
  };
  return digestCanonicalJson(CAPTURE_DIGEST_DOMAIN, record);
}

/**
 * Build a validated capture from a recorded HTTP exchange. The response
 * body must be exactly one strict JSON-RPC envelope carrying a `result`
 * (an `error` envelope fails the acquisition upstream; this builder is
 * only called after that classification). The envelope's `id` must bind
 * EXACTLY to the outbound request id recorded for this exchange.
 */
export function buildCapture(input: {
  provenance: SourceProvenance;
  rpcMethod: string;
  rpcRequestId: string | number | null;
  rpcParams: readonly unknown[];
  httpStatus: number;
  responseBody: string;
  acquiredAt: Iso8601;
}): EvmRpcCapture {
  validateRpcMethod(input.rpcMethod);
  validateRpcParams(input.rpcParams);
  if (!Number.isInteger(input.httpStatus) || input.httpStatus < 200 || input.httpStatus > 599) {
    throw new NecResolverEvmError("EVM_MALFORMED_RESPONSE", "httpStatus must be an integer in [200, 599]");
  }
  if (input.httpStatus !== 200) {
    // Classify HTTP-level failures as provider errors, but prefer the
    // structured JSON-RPC error when the body carries one.
    try {
      const scanned = scanRpcEnvelope(input.responseBody);
      assertBoundResponseId(scanned, input.rpcRequestId, input.rpcMethod);
      if (scanned.kind === "error") {
        throw new NecResolverEvmError(
          "EVM_RPC_ERROR_RESPONSE",
          `${input.rpcMethod}: provider returned JSON-RPC error ${scanned.error.code} (HTTP ${input.httpStatus}): ${scanned.error.message}`,
        );
      }
    } catch (error) {
      if (error instanceof NecResolverEvmError && error.code === "EVM_RPC_ERROR_RESPONSE") throw error;
    }
    throw new NecResolverEvmError(
      "EVM_RPC_ERROR_RESPONSE",
      `${input.rpcMethod}: provider responded HTTP ${input.httpStatus}`,
    );
  }
  const envelope = scanRpcEnvelope(input.responseBody);
  assertBoundResponseId(envelope, input.rpcRequestId, input.rpcMethod);
  if (envelope.kind !== "result") {
    throw new NecResolverEvmError(
      "EVM_RPC_ERROR_RESPONSE",
      `${input.rpcMethod}: provider returned JSON-RPC error ${envelope.error.code}: ${envelope.error.message}`,
    );
  }
  const base: Omit<EvmRpcCapture, "contentDigest"> = {
    profile: CAPTURE_PROFILE,
    sourceId: input.provenance.sourceId,
    sourceType: input.provenance.sourceType,
    ...(input.provenance.independenceGroup === undefined
      ? {}
      : { independenceGroup: input.provenance.independenceGroup }),
    networkId: input.provenance.networkId,
    rpcMethod: input.rpcMethod,
    rpcParams: input.rpcParams,
    httpStatus: input.httpStatus,
    resultText: envelope.resultText,
    acquiredAt: input.acquiredAt,
  };
  return { ...base, contentDigest: computeCaptureDigest(base) };
}

/**
 * Validate a capture coming from a FIXTURE (hostile input domain).
 * SELF-GATING: the complete hostile object gate is applied at function
 * entry — non-null object, non-array, NOT a Proxy (`node:util` isProxy,
 * before any trap-dispatching reflective operation), plain allowed
 * prototype, then descriptor-first inertness (exact data descriptors,
 * enumerable only, no accessors, no functions, no Symbols, no hidden
 * props). Only THEN are semantic fields read from proven-data
 * descriptors. Direct calls and fixture-mediated calls are therefore
 * identically safe: no caller-owned accessor executes merely because NEC
 * is validating and rejecting a hostile fixture.
 */
export function validateFixtureCaptureShape(value: unknown): void {
  // Proxy rejection BEFORE Array.isArray: even spec-level IsArray THROWS a
  // raw TypeError on a revoked proxy.
  if (value === null || typeof value !== "object") {
    throw new NecResolverEvmError("EVM_FIXTURE_INVALID", "capture must be a plain object");
  }
  // Complete hostile gate BEFORE reading ANY own value.
  assertNotProxy(value, "capture");
  if (Array.isArray(value)) {
    throw new NecResolverEvmError("EVM_FIXTURE_INVALID", "capture must be a plain object");
  }
  const proto = Object.getPrototypeOf(value) as object | null;
  if (proto !== Object.prototype && proto !== null) {
    throw new NecResolverEvmError("EVM_FIXTURE_INVALID", "capture: exotic prototype rejected");
  }
  assertInertDataObject(value, "capture");
  const capture = value as Record<string, unknown>;
  const allowed = new Set(["rpcMethod", "rpcParams", "httpStatus", "resultJson", "error"]);
  // Reflect.ownKeys (not Object.keys): symbol-keyed hidden properties are
  // rejected outright instead of silently evading exact-key validation.
  for (const key of Reflect.ownKeys(capture)) {
    if (typeof key === "symbol") {
      throw new NecResolverEvmError(
        "EVM_FIXTURE_INVALID",
        `capture.${String(key)}: symbol-keyed property rejected`,
      );
    }
    if (!allowed.has(key as string)) {
      throw new NecResolverEvmError("EVM_FIXTURE_INVALID", `capture: unknown key ${JSON.stringify(key)}`);
    }
  }
  validateRpcMethod(capture.rpcMethod);
  // Descriptor-first hostile validation of the COMPLETE rpcParams tree
  // before any canonicalization, iteration, indexing or value read.
  if (!Array.isArray(capture.rpcParams)) {
    throw new NecResolverEvmError("EVM_FIXTURE_INVALID", "capture.rpcParams must be an array");
  }
  assertInertJsonTree(capture.rpcParams, "capture.rpcParams", { nodes: 0 }, 1, "EVM_FIXTURE_INVALID");
  if (
    typeof capture.httpStatus !== "number" ||
    !Number.isSafeInteger(capture.httpStatus) ||
    capture.httpStatus < 200 ||
    capture.httpStatus > 599
  ) {
    throw new NecResolverEvmError("EVM_FIXTURE_INVALID", "capture.httpStatus must be an integer in [200, 599]");
  }
  const hasResult = Object.prototype.hasOwnProperty.call(capture, "resultJson");
  const hasError = Object.prototype.hasOwnProperty.call(capture, "error");
  if (hasResult === hasError) {
    throw new NecResolverEvmError("EVM_FIXTURE_INVALID", 'capture must carry exactly one of "resultJson" or "error"');
  }
  if (hasResult) {
    if (typeof capture.resultJson !== "string" || capture.resultJson.length === 0) {
      throw new NecResolverEvmError("EVM_FIXTURE_INVALID", "capture.resultJson must be a non-empty string");
    }
    // Fail closed early: the stored text must be a parseable strict
    // envelope result (this also bounds it before anything downstream).
    try {
      scanRpcEnvelope(`{"jsonrpc":"2.0","id":1,"result":${capture.resultJson}}`);
    } catch (error) {
      throw new NecResolverEvmError("EVM_FIXTURE_INVALID", `capture.resultJson: ${(error as Error).message}`);
    }
  } else {
    const error = capture.error;
    if (error === null || typeof error !== "object") {
      throw new NecResolverEvmError("EVM_FIXTURE_INVALID", "capture.error must be a plain object");
    }
    assertNotProxy(error, "capture.error");
    if (Array.isArray(error)) {
      throw new NecResolverEvmError("EVM_FIXTURE_INVALID", "capture.error must be a plain object");
    }
    const errorProto = Object.getPrototypeOf(error) as object | null;
    if (errorProto !== Object.prototype && errorProto !== null) {
      throw new NecResolverEvmError("EVM_FIXTURE_INVALID", "capture.error: exotic prototype rejected");
    }
    assertInertDataObject(error, "capture.error");
    const errRecord = error as Record<string, unknown>;
    const errorKeys = Object.keys(errRecord);
    if (errorKeys.length !== 2 || !errorKeys.includes("code") || !errorKeys.includes("message")) {
      throw new NecResolverEvmError("EVM_FIXTURE_INVALID", 'capture.error must have exactly "code" and "message"');
    }
    if (typeof errRecord.code !== "number" || !Number.isSafeInteger(errRecord.code)) {
      throw new NecResolverEvmError("EVM_FIXTURE_INVALID", "capture.error.code must be an integer");
    }
    if (typeof errRecord.message !== "string" || errRecord.message.length === 0) {
      throw new NecResolverEvmError("EVM_FIXTURE_INVALID", "capture.error.message must be a non-empty string");
    }
  }
}

export function maxCapturesPerAcquisition(): number {
  return MAX_CAPTURES;
}
