/**
 * Strict, opt-in Solana RPC read adapter. No direct global fetch, no
 * caller-provided URL/method/headers, no signing or submitted transactions.
 * The existing resolver owns capture normalization and Core evaluation.
 */
import { encodeNecWireJson } from "@nec/core";
import { acquireSolanaTransaction, evaluateSolanaTransaction, parseSignature, solanaProbeObservationFromAcquisition } from "@nec/resolver-solana";
import type { SolanaCapabilityProbeObservation } from "@nec/resolver-solana";
import type { SolanaRpcSourceDescriptor } from "@nec/resolver-solana";
import { NeMcpError } from "./errors.js";

export const SOLANA_READ_TIMEOUT_MS = 8_000;
export const SOLANA_RESPONSE_MAX_BYTES = 800_000;
export const SOLANA_NETWORKS = {
  "solana-mainnet": { networkId: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", url: "https://api.mainnet-beta.solana.com" },
  "solana-devnet": { networkId: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", url: "https://api.devnet.solana.com" },
} as const;

export type SolanaNetwork = keyof typeof SOLANA_NETWORKS;
export interface SolanaLiveEvidence {
  readonly source: { readonly sourceId: string; readonly sourceType: string; readonly networkId: string; readonly independenceGroup?: string };
  readonly signature: string;
  readonly acquiredAt: string;
  readonly transactionObserved: boolean;
  readonly blockObserved: boolean;
  readonly consistent: boolean;
  /** Derived by the resolver's own exact acquisition-to-probe projection. */
  readonly beforeProbe: Pick<SolanaCapabilityProbeObservation, "paths" | "finalizedCommitmentObserved" | "lookupsCoherent">;
  readonly captures: readonly { readonly rpcMethod: string; readonly contentDigest: string; readonly acquiredAt: string; readonly httpStatus: number; readonly resultBytes: number }[];
  readonly fragment: Record<string, unknown>;
}

function fail(code: "MCP_MULTICHAIN_INPUT" | "MCP_MULTICHAIN_SOURCE_FAILED" | "MCP_MULTICHAIN_TOO_LARGE"): never {
  const message = {
    MCP_MULTICHAIN_INPUT: "invalid configured Solana network or transaction signature",
    MCP_MULTICHAIN_SOURCE_FAILED: "configured Solana RPC observation failed or could not be validated",
    MCP_MULTICHAIN_TOO_LARGE: "bounded Solana RPC response or evidence exceeded limits",
  }[code];
  throw new NeMcpError(code, message);
}

function properParams(method: string, params: unknown): boolean {
  if (!Array.isArray(params)) return false;
  const o = (v: unknown) => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
  const exact = (v: unknown, keys: readonly string[], expect: Record<string, unknown>) => {
    const r = o(v);
    return r !== null && Object.keys(r).length === keys.length && keys.every(k => Object.hasOwn(r, k) && r[k] === expect[k]);
  };
  if (method === "getGenesisHash") return params.length === 0;
  if (method === "getTransaction") return params.length === 2
    && typeof params[0] === "string" && validSignature(params[0])
    && exact(params[1], ["commitment", "encoding", "maxSupportedTransactionVersion"], {
      commitment: "finalized", encoding: "json", maxSupportedTransactionVersion: 0,
    });
  if (method === "getSignatureStatuses") return params.length === 2
    && Array.isArray(params[0]) && params[0].length === 1
    && typeof params[0][0] === "string" && validSignature(params[0][0])
    && exact(params[1], ["searchTransactionHistory"], { searchTransactionHistory: true });
  if (method === "getBlock") return params.length === 2
    && typeof params[0] === "number" && Number.isSafeInteger(params[0]) && params[0] >= 0
    && exact(params[1], ["commitment", "transactionDetails", "rewards", "maxSupportedTransactionVersion"], {
      commitment: "finalized", transactionDetails: "none", rewards: false, maxSupportedTransactionVersion: 0,
    });
  return false;
}

function validSignature(value: string): boolean {
  try { parseSignature(value); return true; } catch { return false; }
}

/** Restrict the exact JSON-RPC methods/arguments emitted by our Solana resolver. */
export function restrictedSolanaRpcFetch(inner: typeof fetch, network: SolanaNetwork): typeof fetch {
  const source = SOLANA_NETWORKS[network];
  if (!source) fail("MCP_MULTICHAIN_INPUT");
  const exactUrl = new URL(source.url).href;
  return async (input, init) => {
    let url: string;
    try { url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url; }
    catch { return fail("MCP_MULTICHAIN_SOURCE_FAILED"); }
    if (url !== source.url && url !== exactUrl) fail("MCP_MULTICHAIN_SOURCE_FAILED");
    if (init?.method !== "POST" || typeof init.body !== "string" || Buffer.byteLength(init.body) > 4_096)
      fail("MCP_MULTICHAIN_SOURCE_FAILED");
    let parsed: { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
    try { parsed = JSON.parse(init.body) as typeof parsed; }
    catch { return fail("MCP_MULTICHAIN_SOURCE_FAILED"); }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)
      || parsed.jsonrpc !== "2.0" || !Number.isSafeInteger(parsed.id) || (parsed.id as number) < 1
      || typeof parsed.method !== "string" || !properParams(parsed.method, parsed.params)) fail("MCP_MULTICHAIN_SOURCE_FAILED");

    const deadline = AbortSignal.timeout(SOLANA_READ_TIMEOUT_MS);
    const stop = new AbortController();
    const signal = init.signal
      ? AbortSignal.any([deadline, stop.signal, init.signal])
      : AbortSignal.any([deadline, stop.signal]);
    let completed = false;
    try {
      const res = await inner(url, { method: "POST", body: init.body, headers: { "content-type": "application/json" },
        redirect: "error", credentials: "omit", signal });
      if (res.redirected || res.url !== exactUrl || res.status !== 200) {
        // Even a rejected/redirected public response might still have a
        // streaming body. Cancel it without buffering any untrusted bytes.
        void res.body?.cancel().catch(() => {});
        fail("MCP_MULTICHAIN_SOURCE_FAILED");
      }
      const len = res.headers.get("content-length");
      if (len !== null && (!/^\d+$/.test(len) || Number(len) > SOLANA_RESPONSE_MAX_BYTES)) {
        // Do not leave a rejected oversized provider body draining.
        void res.body?.cancel().catch(() => {});
        fail("MCP_MULTICHAIN_TOO_LARGE");
      }
      // Never tee a source stream with Response.clone(): the unread second
      // branch may buffer without our byte bound. Consume ONLY the original
      // stream, cancel it on failure, and give the native RPC parser a fresh
      // in-memory Response containing at most SOLANA_RESPONSE_MAX_BYTES.
      const reader = res.body?.getReader();
      if (!reader) fail("MCP_MULTICHAIN_SOURCE_FAILED");
      // Some mocked or nonstandard fetch implementations do not propagate
      // AbortSignal cancellation to the returned body. Explicitly cancel
      // this reader on the caller's abort OR the existing 8-second deadline.
      const onAbort = () => { void reader.cancel().catch(() => {}); };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      let finished = false;
      try {
        while (true) {
          if (signal.aborted) fail("MCP_MULTICHAIN_SOURCE_FAILED");
          const next = await reader.read();
          if (signal.aborted) fail("MCP_MULTICHAIN_SOURCE_FAILED");
          if (next.done) { finished = true; break; }
          bytes += next.value.byteLength;
          if (bytes > SOLANA_RESPONSE_MAX_BYTES) fail("MCP_MULTICHAIN_TOO_LARGE");
          chunks.push(next.value);
        }
      } finally {
        signal.removeEventListener("abort", onAbort);
        // Cancellation itself may be asynchronous; never hold the MCP
        // worker waiting for a non-cooperative source to acknowledge it.
        if (!finished) void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      completed = true;
      // Keep provider headers, redirects and error text away from downstream
      // clients. The trusted reader needs only exact bounded JSON bytes.
      return new Response(new Uint8Array(Buffer.concat(chunks, bytes)), {
        status: 200, headers: { "content-type": "application/json" },
      });
    } catch (error) {
      // Keep our own bounded-size error for direct fetch-guard tests; never
      // forward untrusted provider error strings, headers or URL.
      if (error instanceof NeMcpError) throw error;
      return fail("MCP_MULTICHAIN_SOURCE_FAILED");
    } finally {
      if (!completed) stop.abort();
    }
  };
}

export async function acquireLiveSolana(nativeFetch: typeof fetch, network: SolanaNetwork, signature: string): Promise<SolanaLiveEvidence> {
  const spec = SOLANA_NETWORKS[network];
  if (spec === undefined || !validSignature(signature)) fail("MCP_MULTICHAIN_INPUT");
  const source: SolanaRpcSourceDescriptor = {
    sourceId: "solana-public-rpc-" + network,
    sourceType: "svm_rpc",
    independenceGroup: "solana-public-rpc",
    networkId: spec.networkId,
    transport: { url: spec.url },
  };
  try {
    const acquired = await acquireSolanaTransaction({
      source, signature, now: new Date().toISOString(), fetchFn: restrictedSolanaRpcFetch(nativeFetch, network),
    });
    const evaluated = evaluateSolanaTransaction(acquired);
    const beforeProbe = solanaProbeObservationFromAcquisition(acquired);
    const fragment = JSON.parse(encodeNecWireJson("network-evidence-fragment", evaluated.fragment)) as Record<string, unknown>;
    return {
      source: {
        sourceId: acquired.source.sourceId,
        sourceType: acquired.source.sourceType,
        networkId: acquired.source.networkId,
        ...(acquired.source.independenceGroup === undefined ? {} : { independenceGroup: acquired.source.independenceGroup }),
      },
      signature: acquired.subject.signature,
      acquiredAt: acquired.acquiredAt,
      transactionObserved: acquired.transaction !== null,
      blockObserved: acquired.block !== null && acquired.block !== undefined,
      consistent: acquired.consistent,
      beforeProbe: {
        paths: beforeProbe.paths,
        finalizedCommitmentObserved: beforeProbe.finalizedCommitmentObserved,
        lookupsCoherent: beforeProbe.lookupsCoherent,
      },
      captures: acquired.captures.map(x => ({
        rpcMethod: x.rpcMethod, contentDigest: x.contentDigest, acquiredAt: x.acquiredAt,
        httpStatus: x.httpStatus, resultBytes: Buffer.byteLength(x.resultText),
      })),
      fragment,
    };
  } catch (error) {
    if (error instanceof NeMcpError) throw error;
    return fail("MCP_MULTICHAIN_SOURCE_FAILED");
  }
}
