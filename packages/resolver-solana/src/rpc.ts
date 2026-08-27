import { digestCanonicalJson } from "@nec/core";
import type { Digest, Iso8601 } from "@nec/core";

import { NecResolverSolanaError, solanaFail } from "./errors.js";

export const CAPTURE_PROFILE = "nec-resolver-solana-capture-v1";
export const CAPTURE_DIGEST_DOMAIN = "resolver-solana-capture-v1";
export const SOURCE_TYPE = "svm_rpc";
const MAX_RESPONSE_BYTES = 2_000_000;

export interface SolanaSourceProvenance {
  readonly sourceId: string;
  readonly sourceType: typeof SOURCE_TYPE;
  readonly networkId: string;
  readonly independenceGroup?: string;
}

export interface SolanaRpcSourceDescriptor extends SolanaSourceProvenance {
  readonly transport: { readonly url: string };
}

export interface SolanaRpcCapture {
  readonly profile: typeof CAPTURE_PROFILE;
  readonly sourceId: string;
  readonly sourceType: typeof SOURCE_TYPE;
  readonly networkId: string;
  readonly independenceGroup?: string;
  readonly rpcMethod: string;
  readonly rpcParams: readonly unknown[];
  readonly httpStatus: number;
  readonly resultText: string;
  readonly acquiredAt: Iso8601;
  readonly contentDigest: Digest;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function stableJsonKey(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) solanaFail("SOLANA_MALFORMED_RESPONSE", "RPC params contain an unsafe number");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJsonKey).join(",")}]`;
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) solanaFail("SOLANA_MALFORMED_RESPONSE", "RPC params must be plain JSON");
    return `{${Object.keys(value as object).sort().map((k) => `${JSON.stringify(k)}:${stableJsonKey((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  solanaFail("SOLANA_MALFORMED_RESPONSE", "RPC params contain a non-JSON value");
}

export function exchangeIdentityKey(method: string, params: readonly unknown[]): string {
  return `${method} ${stableJsonKey(params)}`;
}

function skipString(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length) {
    const c = text[i] as string;
    if (c === '"') return i + 1;
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c.charCodeAt(0) < 0x20) solanaFail("SOLANA_MALFORMED_RESPONSE", "raw control character in JSON string");
    i += 1;
  }
  solanaFail("SOLANA_MALFORMED_RESPONSE", "unterminated JSON string");
}

function skipWhitespace(text: string, start: number): number {
  let i = start;
  while (i < text.length && /[\x20\t\r\n]/.test(text[i] as string)) i += 1;
  return i;
}

function skipValue(text: string, start: number, depth = 0): number {
  if (depth > 64) solanaFail("SOLANA_MALFORMED_RESPONSE", "JSON nesting exceeds 64");
  let i = skipWhitespace(text, start);
  const c = text[i];
  if (c === '"') return skipString(text, i);
  if (c === "{" || c === "[") {
    const close = c === "{" ? "}" : "]";
    i += 1;
    while (true) {
      i = skipWhitespace(text, i);
      if (text[i] === close) return i + 1;
      if (c === "{") {
        if (text[i] !== '"') solanaFail("SOLANA_MALFORMED_RESPONSE", "JSON object key must be a string");
        i = skipString(text, i);
        i = skipWhitespace(text, i);
        if (text[i] !== ":") solanaFail("SOLANA_MALFORMED_RESPONSE", "JSON object member missing colon");
        i = skipValue(text, i + 1, depth + 1);
      } else {
        i = skipValue(text, i, depth + 1);
      }
      i = skipWhitespace(text, i);
      if (text[i] === close) return i + 1;
      if (text[i] !== ",") solanaFail("SOLANA_MALFORMED_RESPONSE", "JSON aggregate missing comma");
      i += 1;
    }
  }
  while (i < text.length && !/[\x20\t\r\n,}\]]/.test(text[i] as string)) i += 1;
  if (i === start) solanaFail("SOLANA_MALFORMED_RESPONSE", "missing JSON value");
  return i;
}

function resultSlice(body: string): { resultText: string; envelope: Record<string, unknown> } {
  if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) solanaFail("SOLANA_MALFORMED_RESPONSE", "RPC response exceeds size limit");
  let envelope: unknown;
  try { envelope = JSON.parse(body); } catch { solanaFail("SOLANA_MALFORMED_RESPONSE", "RPC response is not valid JSON"); }
  if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) solanaFail("SOLANA_MALFORMED_RESPONSE", "RPC envelope must be an object");
  const record = envelope as Record<string, unknown>;
  if (record.jsonrpc !== "2.0" || !("id" in record)) solanaFail("SOLANA_MALFORMED_RESPONSE", "RPC envelope must carry jsonrpc=2.0 and id");
  if (("result" in record) === ("error" in record)) solanaFail("SOLANA_MALFORMED_RESPONSE", "RPC envelope must carry exactly one of result or error");
  if ("error" in record) {
    const error = record.error;
    if (error === null || typeof error !== "object" || Array.isArray(error)) solanaFail("SOLANA_RPC_ERROR_RESPONSE", "provider returned malformed JSON-RPC error");
    const e = error as Record<string, unknown>;
    throw new NecResolverSolanaError("SOLANA_RPC_ERROR_RESPONSE", `provider returned JSON-RPC error ${String(e.code)}: ${String(e.message)}`);
  }
  let i = skipWhitespace(body, 0);
  if (body[i] !== "{") solanaFail("SOLANA_MALFORMED_RESPONSE", "RPC envelope must start with an object");
  i += 1;
  let found: string | undefined;
  const seen = new Set<string>();
  while (true) {
    i = skipWhitespace(body, i);
    if (body[i] === "}") break;
    if (body[i] !== '"') solanaFail("SOLANA_MALFORMED_RESPONSE", "RPC envelope key must be a string");
    const keyEnd = skipString(body, i);
    let key: string;
    try { key = JSON.parse(body.slice(i, keyEnd)) as string; } catch { solanaFail("SOLANA_MALFORMED_RESPONSE", "invalid RPC envelope key"); }
    if (seen.has(key)) solanaFail("SOLANA_MALFORMED_RESPONSE", `duplicate RPC envelope member ${key}`);
    seen.add(key);
    i = skipWhitespace(body, keyEnd);
    if (body[i] !== ":") solanaFail("SOLANA_MALFORMED_RESPONSE", "RPC envelope member missing colon");
    const valueStart = skipWhitespace(body, i + 1);
    const valueEnd = skipValue(body, valueStart);
    if (key === "result") found = body.slice(valueStart, valueEnd);
    i = skipWhitespace(body, valueEnd);
    if (body[i] === "}") { i += 1; break; }
    if (body[i] !== ",") solanaFail("SOLANA_MALFORMED_RESPONSE", "RPC envelope missing comma");
    i += 1;
  }
  if (skipWhitespace(body, i) !== body.length || found === undefined) solanaFail("SOLANA_MALFORMED_RESPONSE", "malformed or trailing RPC envelope content");
  return { resultText: found, envelope: record };
}

function buildCapture(args: {
  provenance: SolanaSourceProvenance; method: string; params: readonly unknown[];
  status: number; body: string; requestId: number; acquiredAt: Iso8601;
}): SolanaRpcCapture {
  if (args.status !== 200) solanaFail("SOLANA_RPC_ERROR_RESPONSE", `${args.method}: provider responded HTTP ${args.status}`);
  const scanned = resultSlice(args.body);
  if (scanned.envelope.id !== args.requestId) solanaFail("SOLANA_MALFORMED_RESPONSE", `${args.method}: response id mismatch`);
  const base = {
    profile: CAPTURE_PROFILE,
    ...args.provenance,
    rpcMethod: args.method,
    rpcParams: [...args.params],
    httpStatus: args.status,
    resultText: scanned.resultText,
    acquiredAt: args.acquiredAt,
  } as const;
  return { ...base, contentDigest: digestCanonicalJson(CAPTURE_DIGEST_DOMAIN, base) };
}

export function validateSource(source: SolanaRpcSourceDescriptor): void {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(source.sourceId) || source.sourceType !== SOURCE_TYPE) solanaFail("SOLANA_INPUT_INVALID", "invalid Solana source identity");
  if (!/^solana:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(source.networkId)) solanaFail("SOLANA_INPUT_INVALID", "networkId must be solana:<genesisHash>");
  let url: URL;
  try { url = new URL(source.transport.url); } catch { solanaFail("SOLANA_INPUT_INVALID", "RPC transport URL is invalid"); }
  if (!/^https?:$/.test(url.protocol) || url.username !== "" || url.password !== "") solanaFail("SOLANA_INPUT_INVALID", "RPC URL must be HTTP(S) without userinfo");
}

export function createRpcReader(args: { provenance: SolanaSourceProvenance; endpoint: string; now: Iso8601; fetchFn: FetchLike }) {
  let requestId = 0;
  const captures: SolanaRpcCapture[] = [];
  const read = async (method: string, params: readonly unknown[]): Promise<{ value: unknown; capture: SolanaRpcCapture }> => {
    requestId += 1;
    let response: Response;
    try {
      response = await args.fetchFn(args.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }),
      });
    } catch (error) {
      if (error instanceof NecResolverSolanaError) throw error;
      throw new NecResolverSolanaError("SOLANA_RPC_REQUEST_FAILED", `${method}: RPC request failed (${error instanceof Error ? error.name : "unknown error"})`);
    }
    const body = await response.text();
    const capture = buildCapture({ provenance: args.provenance, method, params, status: response.status, body, requestId, acquiredAt: args.now });
    let value: unknown;
    try { value = JSON.parse(capture.resultText); } catch { solanaFail("SOLANA_MALFORMED_RESPONSE", `${method}: result is malformed JSON`); }
    captures.push(capture);
    return { value, capture };
  };
  return { read, captures };
}
