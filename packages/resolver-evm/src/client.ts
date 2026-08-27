/**
 * SOURCE ADAPTER: one Viem public client per configured evidentiary source.
 *
 * The recording fetch sits between Viem's HTTP transport and the network:
 * it records every exchange (method, params, status, raw response body)
 * while leaving ALL JSON-RPC mechanics (framing, ids, headers, timeouts,
 * error mapping, response parsing) to Viem. `fallback([...])` is never
 * used — a capture can only ever belong to exactly one configured source.
 *
 * Acquisitions are strictly sequential per client; a batched JSON-RPC
 * payload fails closed rather than producing ambiguous captures.
 *
 * Provenance is exact end to end: redirects are never followed and the
 * final response origin must match the configured endpoint, so one
 * configured source can never silently acquire bytes from another origin.
 */

import { createPublicClient, http } from "viem";
import type { PublicClient } from "viem";

import { stableJsonKey } from "./capture.js";
import { NecResolverEvmError, redactUrlOccurrences } from "./errors.js";

/** Raw HTTP exchange recorded by the recording fetch. */
export interface RecordedExchange {
  readonly rpcMethod: string;
  /** The outbound JSON-RPC request id exactly as sent (binding anchor). */
  readonly rpcRequestId: string | number | null;
  readonly rpcParams: readonly unknown[];
  readonly httpStatus: number;
  readonly responseBody: string;
}

export type FetchLike = typeof fetch;

/** Valid JSON-RPC 2.0 request/response id domain: string | integer | null. */
export function isValidRpcId(id: unknown): boolean {
  if (typeof id === "string") return true;
  if (typeof id === "number") return Number.isSafeInteger(id);
  return id === null;
}

export interface RecordingFetchOptions {
  /**
   * Origin of THE configured endpoint. When set, any response whose final
   * URL carries a different origin fails closed BEFORE being recorded or
   * processed — bytes can never silently arrive from another origin.
   */
  readonly expectedOrigin?: string;
}

/**
 * Create a fetch implementation that delegates to `inner` while recording
 * each exchange. Endpoint URLs are recorded NOWHERE.
 *
 * Provenance invariants:
 *   - redirects are never followed (`redirect: "error"`): one configured
 *     source must not acquire bytes through another HTTP origin;
 *   - when `expectedOrigin` is set, the final response origin is verified
 *     as defense in depth before anything is recorded.
 */
export function createRecordingFetch(
  sink: RecordedExchange[],
  inner: FetchLike,
  options: RecordingFetchOptions = {},
): FetchLike {
  return async (input, init) => {
    const bodyText = typeof init?.body === "string" ? init.body : "";
    if (bodyText === "") {
      throw new NecResolverEvmError("EVM_MALFORMED_RESPONSE", "expected a string request body from the transport");
    }
    let request: { method: string; params: unknown[]; requestId: string | number | null };
    try {
      const parsed = JSON.parse(bodyText) as Record<string, unknown>;
      if (Array.isArray(parsed)) {
        throw new Error("batch");
      }
      if (parsed.jsonrpc !== "2.0") {
        throw new Error("version");
      }
      if (typeof parsed.method !== "string") {
        throw new Error("shape");
      }
      if (!isValidRpcId(parsed.id)) {
        throw new Error("id");
      }
      // Some methods (e.g. eth_chainId) are dispatched WITHOUT a params
      // member; normalize to an empty parameter list.
      const params = Array.isArray(parsed.params) ? parsed.params : [];
      request = { method: parsed.method, params, requestId: parsed.id as string | number | null };
    } catch (error) {
      if ((error as Error).message === "batch") {
        throw new NecResolverEvmError(
          "EVM_LIMIT_EXCEEDED",
          "batched JSON-RPC requests are unsupported for evidentiary acquisition",
        );
      }
      throw new NecResolverEvmError(
        "EVM_MALFORMED_RESPONSE",
        'outbound request body is not a single JSON-RPC 2.0 request with an "id"',
      );
    }
    // Fail closed on provenance-changing redirects; bytes must come from
    // THE configured source, never from wherever a redirect points.
    const response = await inner(input, { ...init, redirect: "error" });
    if (options.expectedOrigin !== undefined && response.url !== "") {
      let finalOrigin = "<unparseable>";
      try {
        finalOrigin = new URL(response.url).origin;
      } catch {
        // treated as a mismatch below
      }
      if (finalOrigin !== options.expectedOrigin) {
        throw new NecResolverEvmError(
          "EVM_RPC_REQUEST_FAILED",
          "response did not originate from the configured source origin",
        );
      }
    }
    // Clone BEFORE returning so the raw body stays readable downstream.
    const cloned = response.clone();
    const responseBody = await cloned.text();
    sink.push({
      rpcMethod: request.method,
      rpcRequestId: request.requestId,
      rpcParams: request.params,
      httpStatus: response.status,
      responseBody,
    });
    return response;
  };
}

/**
 * Build THE Viem public client for one endpoint. Deterministic transport
 * settings: no retries (a retry would duplicate evidence), no batching
 * (captures must map 1:1 to logical reads).
 */
export function createSourceClient(
  transportUrl: string,
  fetchFn: FetchLike,
): { client: PublicClient; recordings: RecordedExchange[] } {
  const recordings: RecordedExchange[] = [];
  let expectedOrigin = "";
  try {
    expectedOrigin = new URL(transportUrl).origin;
  } catch {
    expectedOrigin = "";
  }
  const recordingFetch = createRecordingFetch(recordings, fetchFn, {
    ...(expectedOrigin === "" ? {} : { expectedOrigin }),
  });
  const client = createPublicClient({
    transport: http(transportUrl, {
      batch: false,
      retryCount: 0,
      timeout: 10_000,
      fetchFn: recordingFetch,
    }),
  });
  return { client, recordings };
}

/**
 * Invoke one Viem action, wrapping any upstream failure into a controlled
 * resolver error with endpoint material redacted. Only name/shortMessage/
 * details are carried over — never URLs, headers or stack traces.
 */
export async function callViemAction<T>(rpcMethod: string, endpointUrl: string, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    const name = (error as { name?: unknown }).name;
    const details = (error as { details?: unknown }).details;
    const shortMessage = (error as { shortMessage?: unknown }).shortMessage;
    const parts = [typeof name === "string" ? name : "Error"];
    if (typeof shortMessage === "string") parts.push(shortMessage);
    if (typeof details === "string") parts.push(details);
    throw new NecResolverEvmError(
      "EVM_RPC_REQUEST_FAILED",
      `${rpcMethod} failed (${redactUrlOccurrences(parts.join(": "), endpointUrl)})`,
    );
  }
}

/** Identity key of one recorded exchange (used by replay bookkeeping). */
export function recordedIdentityKey(exchange: Pick<RecordedExchange, "rpcMethod" | "rpcParams">): string {
  return `${exchange.rpcMethod} ${stableJsonKey(exchange.rpcParams)}`;
}
