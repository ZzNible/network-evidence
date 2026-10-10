/**
 * Streamable HTTP host for the MCP server. Loopback-only by default; an
 * explicit, validated hosted mode exists for a separately approved deployment
 * (see hosted.ts).
 *
 *   GET  /healthz  -> 200 static JSON (local/Render)
 *   GET  /health   -> 200 static JSON (hosted; Cloud Run-safe alias)
 *   POST /mcp      -> MCP (2026-07-28 modern era, and 2025-era
 *                     initialize -> tools/list -> tools/call served statelessly)
 *   *    /mcp      -> delegated to the SDK (GET/DELETE answered 405: stateless)
 *   anything else  -> 404
 *
 * Guards, in order: Host + Origin validation (DNS-rebinding protection;
 * local: loopback names and the exact same-port loopback Origin; hosted: the
 * exact configured hostname/origin only), the global /mcp abuse limiter
 * (rate + concurrency, 429), JSON Content-Type, a byte-bounded body read, then
 * the @nec/core strict wire parser over the RAW body (duplicate keys, depth,
 * node-count and string bounds fail closed) before anything reaches the SDK.
 * Every request gets a fresh McpServer instance (no shared session state).
 *
 * Logging is one line per request: method, path, status, duration. Never
 * headers, bodies, tool arguments, client addresses or identifiers.
 */

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { localhostHostValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { parseNecWireJson } from "@nec/core";

import { loadReviewedCaseStore } from "./cases.js";
import type { ReviewedCaseStore } from "./cases.js";
import { NeMcpConfigError } from "./errors.js";
import { HOSTED_BIND_HOST, hostedAllowlist, hostedGuard, localSamePortOriginGuard } from "./hosted.js";
import type { HostedAllowlist, NeMcpHostedOptions, NeMcpMode, RequestGuard } from "./hosted.js";
import { GlobalAbuseLimiter, HOSTED_DEFAULT_LIMITS, LOCAL_DEFAULT_LIMITS, resolveLimits } from "./limits.js";
import type { NeMcpLimits } from "./limits.js";
import { createNeMcpServer, LIVE_TOOL_NAMES, SERVER_NAME, SERVER_VERSION, TOOL_NAMES } from "./tools.js";
import type { MultichainTool } from "./live-multichain.js";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 4178;
export const DEFAULT_MAX_BODY_BYTES = 1_048_576;
export const MAX_MAX_BODY_BYTES = 4_194_304;
/** v0 has no authentication, so local mode accepts only loopback binds. */
export const LOOPBACK_HOSTS: readonly string[] = Object.freeze(["127.0.0.1", "::1", "localhost"]);

export { NeMcpConfigError };

export interface NeMcpHttpOptions {
  readonly host?: string;
  readonly port?: number;
  readonly maxBodyBytes?: number;
  /** Receives one access line per request (no payloads). Default: no logging. */
  readonly log?: (line: string) => void;
  /** Injected store (tests); default loads the shipped, pinned collection. */
  readonly cases?: ReviewedCaseStore;
  /** Explicitly admitted read-only live RPC tool; forbidden in local mode. */
  readonly liveEvidence?: MultichainTool;
  /**
   * Opt-in hosted mode. Requires a validated exact public origin; binds
   * HOSTED_BIND_HOST by default (a loopback bind is allowed for rehearsal/tests).
   */
  readonly hosted?: NeMcpHostedOptions;
  /** Global /mcp abuse limits; defaults depend on the mode. */
  readonly limits?: { readonly maxConcurrent?: number | undefined; readonly maxRequestsPerMinute?: number | undefined };
}

export interface NeMcpHttpServer {
  readonly url: string;
  readonly mcpUrl: string;
  readonly host: string;
  readonly port: number;
  readonly mode: NeMcpMode;
  close(): Promise<void>;
}

export interface ValidatedHttpOptions {
  readonly mode: NeMcpMode;
  readonly host: string;
  readonly port: number;
  readonly maxBodyBytes: number;
  readonly limits: NeMcpLimits;
  /** Present in hosted mode only. */
  readonly allow?: HostedAllowlist;
}

export function validateHttpOptions(options: NeMcpHttpOptions): ValidatedHttpOptions {
  const mode: NeMcpMode = options.hosted === undefined ? "local" : "hosted";
  const allow = options.hosted === undefined ? undefined : hostedAllowlist(options.hosted);
  const host = options.host ?? (mode === "hosted" ? HOSTED_BIND_HOST : DEFAULT_HOST);
  if (mode === "local" && !LOOPBACK_HOSTS.includes(host)) {
    throw new NeMcpConfigError(
      `host ${JSON.stringify(host)} is not a loopback address; local mode binds loopback only (${LOOPBACK_HOSTS.join(", ")})`,
    );
  }
  if (mode === "hosted" && host !== HOSTED_BIND_HOST && !LOOPBACK_HOSTS.includes(host)) {
    throw new NeMcpConfigError(`hosted mode binds ${HOSTED_BIND_HOST} (or loopback for rehearsal) only`);
  }
  const port = options.port ?? DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new NeMcpConfigError("port must be an integer in 0..65535");
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1024 || maxBodyBytes > MAX_MAX_BODY_BYTES) {
    throw new NeMcpConfigError(`maxBodyBytes must be an integer in 1024..${MAX_MAX_BODY_BYTES}`);
  }
  const limits = resolveLimits(options.limits, mode === "hosted" ? HOSTED_DEFAULT_LIMITS : LOCAL_DEFAULT_LIMITS);
  return { mode, host, port, maxBodyBytes, limits, ...(allow === undefined ? {} : { allow }) };
}

export const HEALTH_SCOPE: Readonly<Record<NeMcpMode, string>> = Object.freeze({
  local: "local v0; not a public endpoint",
  hosted: "hosted preview v0: anonymous, read-only, offline; not a reviewed production service",
});

function healthBody(mode: NeMcpMode, liveEnabled = false): string {
  return JSON.stringify({
    status: "ok",
    server: SERVER_NAME,
    version: SERVER_VERSION,
    transport: "streamable-http",
    endpoint: "/mcp",
    tools: liveEnabled ? LIVE_TOOL_NAMES : TOOL_NAMES,
    readOnly: true,
    liveObservation: liveEnabled,
    networkIo: liveEnabled ? "bounded_evm_solana_rpc" : "none",
    mode,
    scope: liveEnabled ? "pre-release: source observations on Base and Solana; no independent proof of settlement or finality" : HEALTH_SCOPE[mode],
  });
}

function sendJson(res: ServerResponse, status: number, body: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extra,
  });
  res.end(body);
}

function jsonRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  sendJson(res, status, JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

class BodyTooLarge extends Error {}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declared = req.headers["content-length"];
  if (declared !== undefined && Number(declared) > maxBytes) throw new BodyTooLarge();
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > maxBytes) throw new BodyTooLarge();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}

function isJsonContentType(value: string | undefined): boolean {
  if (value === undefined) return false;
  return value.split(";")[0]!.trim().toLowerCase() === "application/json";
}

/** Start the MCP HTTP server (local by default). Fails closed on invalid configuration or unverified case data. */
export async function startNeMcpHttpServer(options: NeMcpHttpOptions = {}): Promise<NeMcpHttpServer> {
  const { mode, host, port, maxBodyBytes, limits, allow } = validateHttpOptions(options);
  if (options.liveEvidence !== undefined && mode !== "hosted") throw new NeMcpConfigError("live multichain RPC requires hosted mode");
  const cases = options.cases ?? loadReviewedCaseStore();
  const log = options.log ?? (() => {});

  const mcp = createMcpHandler(() => createNeMcpServer({ cases, mode, ...(options.liveEvidence === undefined ? {} : { liveEvidence: options.liveEvidence }) }), {
    legacy: "stateless",
    maxRequestBodySize: maxBodyBytes,
    onerror: (error) => log(`mcp handler error: ${error.name}`),
  });
  const mcpNode = toNodeHandler(mcp, {
    maxRequestBodySize: maxBodyBytes,
    onerror: (error) => log(`mcp adapter error: ${error.name}`),
  });
  let boundPort = port;
  const guards: RequestGuard[] =
    allow === undefined ? [localhostHostValidation(), localSamePortOriginGuard(() => boundPort)] : [hostedGuard(allow)];
  const limiter = new GlobalAbuseLimiter(limits);
  const health = healthBody(mode, options.liveEvidence !== undefined);

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    for (const guard of guards) if (!guard(req, res)) return;
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/healthz" || (mode === "hosted" && path === "/health")) {
      if (req.method !== "GET" && req.method !== "HEAD") {
        sendJson(res, 405, JSON.stringify({ error: "method not allowed" }), { allow: "GET, HEAD" });
        return;
      }
      sendJson(res, 200, req.method === "HEAD" ? "" : health);
      return;
    }
    if (path !== "/mcp") {
      sendJson(res, 404, JSON.stringify({ error: "not found" }));
      return;
    }
    const admission = limiter.admit();
    if (!admission.ok) {
      sendJson(
        res,
        429,
        JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Too Many Requests: global server limit reached" }, id: null }),
        { "retry-after": String(admission.retryAfterSeconds) },
      );
      return;
    }
    res.once("close", admission.release);
    if (req.method !== "POST") {
      await mcpNode(req, res);
      return;
    }
    if (!isJsonContentType(req.headers["content-type"])) {
      jsonRpcError(res, 415, -32000, "Unsupported Media Type: Content-Type must be application/json");
      return;
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(await readBody(req, maxBodyBytes));
    } catch (error) {
      if (error instanceof BodyTooLarge) {
        jsonRpcError(res, 413, -32000, `Payload Too Large: request body exceeds ${maxBodyBytes} bytes`);
      } else {
        jsonRpcError(res, 400, -32700, "Parse error: request body is not valid UTF-8");
      }
      return;
    }
    let parsed: unknown;
    try {
      // Core strict parser: duplicate keys, unpaired surrogates and resource
      // bounds fail closed BEFORE the SDK's own JSON.parse could collapse them.
      parsed = parseNecWireJson(text);
    } catch {
      jsonRpcError(res, 400, -32700, "Parse error: body is not strict JSON (duplicate keys, malformed JSON or resource bounds exceeded)");
      return;
    }
    // The hosted limiter accounts ONE HTTP request, while the MCP SDK can
    // execute MANY tools from an array. Refuse *all* JSON-RPC batches,
    // including single-element and notifications-only arrays, BEFORE SDK
    // dispatch so quota cost cannot be multiplied by one HTTP admission.
    if (Array.isArray(parsed)) {
      jsonRpcError(res, 400, -32600, "Bad Request: JSON-RPC batches are not accepted; use one operation per HTTP request");
      return;
    }
    // The read-only stateless server publishes no subscription events. The
    // generic SDK would keep subscriptions/listen open indefinitely, which can
    // monopolize a Cloud Run revision configured for one concurrent request.
    // Answer explicitly before SDK dispatch; still charge the normal ingress
    // admission and preserve the JSON-RPC id for standards-compliant clients.
    const operation = parsed as Record<string, unknown>;
    if (operation !== null && typeof operation === "object" && operation.method === "subscriptions/listen") {
      const id = operation.id;
      if (typeof id !== "string" && !(typeof id === "number" && Number.isSafeInteger(id))) {
        jsonRpcError(res, 400, -32600, "Bad Request: invalid JSON-RPC id");
        return;
      }
      sendJson(res, 200, JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: "subscriptions/listen is unavailable on this stateless server" },
      }));
      return;
    }
    await mcpNode(req, res, parsed);
  }

  const server: Server = createServer((req, res) => {
    const started = process.hrtime.bigint();
    res.on("finish", () => {
      const ms = Number((process.hrtime.bigint() - started) / 1_000_000n);
      const path = (req.url ?? "/").split("?")[0];
      const route = path === "/mcp" || path === "/healthz" || (mode === "hosted" && path === "/health") ? path : "(other)";
      log(`${req.method ?? "?"} ${route} ${res.statusCode} ${ms}ms`);
    });
    handle(req, res).catch(() => {
      if (!res.headersSent) jsonRpcError(res, 500, -32603, "Internal error");
      else res.destroy();
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  boundPort = address.port;
  const urlHost = address.family === "IPv6" ? `[${address.address}]` : address.address;
  const url = `http://${urlHost}:${address.port}`;
  return {
    url,
    mcpUrl: `${url}/mcp`,
    host: address.address,
    port: address.port,
    mode,
    async close() {
      await mcp.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
