/**
 * Loopback-only Streamable HTTP host for the MCP server.
 *
 *   GET  /healthz  -> 200 static JSON (no evidence, no clock-derived claims)
 *   POST /mcp      -> MCP (2026-07-28 modern era, and 2025-era
 *                     initialize -> tools/list -> tools/call served statelessly)
 *   *    /mcp      -> delegated to the SDK (GET/DELETE answered 405: stateless)
 *   anything else  -> 404
 *
 * Guards, in order: Host + Origin validation (DNS-rebinding protection,
 * loopback names only), JSON Content-Type, a byte-bounded body read, then the
 * @nec/core strict wire parser over the RAW body (duplicate keys, depth,
 * node-count and string bounds fail closed) before anything reaches the SDK.
 * Every request gets a fresh McpServer instance (no shared session state).
 *
 * Logging is one line per request: method, path, status, duration. Never
 * headers, bodies, tool arguments, client addresses or identifiers.
 */

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { parseNecWireJson } from "@nec/core";

import { loadReviewedCaseStore } from "./cases.js";
import type { ReviewedCaseStore } from "./cases.js";
import { createNeMcpServer, SERVER_NAME, SERVER_VERSION, TOOL_NAMES } from "./tools.js";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 4178;
export const DEFAULT_MAX_BODY_BYTES = 1_048_576;
export const MAX_MAX_BODY_BYTES = 4_194_304;
/** v0 has no authentication, so only loopback binds are accepted. */
export const LOOPBACK_HOSTS: readonly string[] = Object.freeze(["127.0.0.1", "::1", "localhost"]);

export interface NeMcpHttpOptions {
  readonly host?: string;
  readonly port?: number;
  readonly maxBodyBytes?: number;
  /** Receives one access line per request (no payloads). Default: no logging. */
  readonly log?: (line: string) => void;
  /** Injected store (tests); default loads the shipped, pinned collection. */
  readonly cases?: ReviewedCaseStore;
}

export interface NeMcpHttpServer {
  readonly url: string;
  readonly mcpUrl: string;
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
}

export class NeMcpConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NeMcpConfigError";
  }
}

export function validateHttpOptions(options: NeMcpHttpOptions): { host: string; port: number; maxBodyBytes: number } {
  const host = options.host ?? DEFAULT_HOST;
  if (!LOOPBACK_HOSTS.includes(host)) {
    throw new NeMcpConfigError(
      `host ${JSON.stringify(host)} is not a loopback address; v0 binds loopback only (${LOOPBACK_HOSTS.join(", ")})`,
    );
  }
  const port = options.port ?? DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new NeMcpConfigError("port must be an integer in 0..65535");
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1024 || maxBodyBytes > MAX_MAX_BODY_BYTES) {
    throw new NeMcpConfigError(`maxBodyBytes must be an integer in 1024..${MAX_MAX_BODY_BYTES}`);
  }
  return { host, port, maxBodyBytes };
}

const HEALTH_BODY = JSON.stringify({
  status: "ok",
  server: SERVER_NAME,
  version: SERVER_VERSION,
  transport: "streamable-http",
  endpoint: "/mcp",
  tools: TOOL_NAMES,
  readOnly: true,
  liveObservation: false,
  networkIo: "none",
  scope: "local v0; not a public endpoint",
});

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

/** Start the loopback-only MCP HTTP server. Fails closed on invalid configuration or unverified case data. */
export async function startNeMcpHttpServer(options: NeMcpHttpOptions = {}): Promise<NeMcpHttpServer> {
  const { host, port, maxBodyBytes } = validateHttpOptions(options);
  const cases = options.cases ?? loadReviewedCaseStore();
  const log = options.log ?? (() => {});

  const mcp = createMcpHandler(() => createNeMcpServer({ cases }), {
    legacy: "stateless",
    maxRequestBodySize: maxBodyBytes,
    onerror: (error) => log(`mcp handler error: ${error.name}`),
  });
  const mcpNode = toNodeHandler(mcp, {
    maxRequestBodySize: maxBodyBytes,
    onerror: (error) => log(`mcp adapter error: ${error.name}`),
  });
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!validateHost(req, res) || !validateOrigin(req, res)) return;
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/healthz") {
      if (req.method !== "GET" && req.method !== "HEAD") {
        sendJson(res, 405, JSON.stringify({ error: "method not allowed" }), { allow: "GET, HEAD" });
        return;
      }
      sendJson(res, 200, req.method === "HEAD" ? "" : HEALTH_BODY);
      return;
    }
    if (path !== "/mcp") {
      sendJson(res, 404, JSON.stringify({ error: "not found" }));
      return;
    }
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
    try {
      // Core strict parser: duplicate keys, unpaired surrogates and resource
      // bounds fail closed BEFORE the SDK's own JSON.parse could collapse them.
      parseNecWireJson(text);
    } catch {
      jsonRpcError(res, 400, -32700, "Parse error: body is not strict JSON (duplicate keys, malformed JSON or resource bounds exceeded)");
      return;
    }
    await mcpNode(req, res, JSON.parse(text) as unknown);
  }

  const server: Server = createServer((req, res) => {
    const started = process.hrtime.bigint();
    res.on("finish", () => {
      const ms = Number((process.hrtime.bigint() - started) / 1_000_000n);
      const path = (req.url ?? "/").split("?")[0];
      const route = path === "/mcp" || path === "/healthz" ? path : "(other)";
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
  const urlHost = address.family === "IPv6" ? `[${address.address}]` : address.address;
  const url = `http://${urlHost}:${address.port}`;
  return {
    url,
    mcpUrl: `${url}/mcp`,
    host: address.address,
    port: address.port,
    async close() {
      await mcp.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
