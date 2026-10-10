/**
 * Opt-in hosted mode (for a separately approved deployment behind an HTTPS
 * terminating platform such as Render) and the request guards of both modes.
 *
 * Local mode (default) is unchanged: loopback bind, loopback Host names, no
 * authentication. Its Origin check is tightened to the exact same-port
 * loopback origin (a browser page on another local port is refused).
 *
 * Hosted mode is entered ONLY with `NE_MCP_MODE=hosted` AND a validated exact
 * `NE_MCP_PUBLIC_ORIGIN` (https, canonical, public DNS name). It binds
 * 0.0.0.0:$PORT. Host must equal a configured hostname exactly; a supplied
 * Origin must equal a configured origin exactly; no Origin (server-to-server
 * MCP) is accepted. X-Forwarded-* headers are never read. Hosted mode is an
 * anonymous, read-only PREVIEW, not a reviewed production service.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { NeMcpConfigError } from "./errors.js";

/** The only non-loopback bind, used exclusively by hosted mode. */
export const HOSTED_BIND_HOST = "0.0.0.0";

export type NeMcpMode = "local" | "hosted";

export interface NeMcpHostedOptions {
  /** Exact public origin, e.g. `https://<service>.onrender.com` (no path, port or trailing slash). */
  readonly publicOrigin: string;
  /** Optional second exact origin for an explicitly configured custom domain. */
  readonly customOrigin?: string;
}

/** Special-use / non-public suffixes refused as a hosted origin. */
const NON_PUBLIC_SUFFIXES = ["localhost", "local", "internal", "lan", "home.arpa", "localdomain", "test", "invalid", "example", "onion"];
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Validate one hosted origin and return its hostname. Throws NeMcpConfigError; never widens. */
export function validateHostedOrigin(raw: unknown, name: string): string {
  if (typeof raw !== "string" || raw.length === 0) throw new NeMcpConfigError(`${name} is required in hosted mode (exact https origin)`);
  if (raw.length > 300) throw new NeMcpConfigError(`${name} is too long`);
  if (raw.includes("*")) throw new NeMcpConfigError(`${name} must not contain a wildcard`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new NeMcpConfigError(`${name} is not a valid URL`);
  }
  if (url.protocol !== "https:") throw new NeMcpConfigError(`${name} must use https://`);
  if (url.username !== "" || url.password !== "") throw new NeMcpConfigError(`${name} must not carry credentials`);
  if (url.port !== "") throw new NeMcpConfigError(`${name} must not carry a port`);
  if (url.origin !== raw) {
    throw new NeMcpConfigError(`${name} must be an exact canonical origin (lowercase https://host, no path, query, fragment or trailing slash)`);
  }
  const host = url.hostname;
  if (host.startsWith("[") || /^[\d.]+$/.test(host)) throw new NeMcpConfigError(`${name} must be a DNS hostname, not an IP address`);
  if (NON_PUBLIC_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) {
    throw new NeMcpConfigError(`${name} must not be a localhost-class or special-use hostname`);
  }
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((label) => DNS_LABEL.test(label)) || /^\d+$/.test(labels.at(-1)!)) {
    throw new NeMcpConfigError(`${name} must be a fully qualified public DNS hostname`);
  }
  return host;
}

export interface HostedAllowlist {
  readonly hostnames: readonly string[];
  readonly origins: readonly string[];
}

export function hostedAllowlist(options: NeMcpHostedOptions): HostedAllowlist {
  const hostnames = [validateHostedOrigin(options.publicOrigin, "NE_MCP_PUBLIC_ORIGIN")];
  const origins = [options.publicOrigin];
  if (options.customOrigin !== undefined) {
    const custom = validateHostedOrigin(options.customOrigin, "NE_MCP_CUSTOM_ORIGIN");
    if (hostnames.includes(custom)) throw new NeMcpConfigError("NE_MCP_CUSTOM_ORIGIN must differ from NE_MCP_PUBLIC_ORIGIN");
    hostnames.push(custom);
    origins.push(options.customOrigin);
  }
  return Object.freeze({ hostnames: Object.freeze(hostnames), origins: Object.freeze(origins) });
}

// ---------------------------------------------------------------------------
// Request guards. A guard returns false after answering 403 itself. Rejection
// messages are static: caller-supplied header values are never echoed.
// ---------------------------------------------------------------------------

export type RequestGuard = (req: IncomingMessage, res: ServerResponse) => boolean;

function forbid(res: ServerResponse, message: string): false {
  res.writeHead(403, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
  return false;
}

/**
 * Hosted: Host must be exactly one configured hostname (no port, no other
 * name); Origin, when present, must be exactly one configured https origin.
 */
export function hostedGuard(allow: HostedAllowlist): RequestGuard {
  return (req, res) => {
    const host = req.headers.host;
    if (typeof host !== "string" || !allow.hostnames.includes(host.toLowerCase())) return forbid(res, "Forbidden: Host not allowed");
    const origin = req.headers.origin;
    if (origin !== undefined && !allow.origins.includes(origin)) return forbid(res, "Forbidden: Origin not allowed");
    return true;
  };
}

/**
 * Local: a supplied Origin must be the exact same-port loopback origin
 * (`http://127.0.0.1:<port>`, `http://localhost:<port>`, `http://[::1]:<port>`).
 * Absent Origin (SDK / server-to-server clients) passes.
 */
export function localSamePortOriginGuard(port: () => number): RequestGuard {
  return (req, res) => {
    const origin = req.headers.origin;
    if (origin === undefined) return true;
    const p = port();
    const suffix = p === 80 ? [":80", ""] : [`:${p}`];
    const allowed = ["127.0.0.1", "localhost", "[::1]"].flatMap((name) => suffix.map((s) => `http://${name}${s}`));
    return allowed.includes(origin) ? true : forbid(res, "Forbidden: Origin not allowed");
  };
}

// ---------------------------------------------------------------------------
// CLI / environment resolution
// ---------------------------------------------------------------------------

export type ServeEnv = Readonly<Record<string, string | undefined>>;

export interface ResolvedServeConfig {
  readonly mode: NeMcpMode;
  readonly host: string;
  readonly port: number;
  readonly hosted?: NeMcpHostedOptions;
  readonly limits?: { readonly maxConcurrent?: number; readonly maxRequestsPerMinute?: number };
}

function argValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

function decimal(raw: string, name: string): number {
  if (!/^\d{1,5}$/.test(raw)) throw new NeMcpConfigError(`${name} must be a decimal integer`);
  return Number(raw);
}

function optionalDecimal(env: ServeEnv, name: string): number | undefined {
  const raw = env[name];
  return raw === undefined ? undefined : decimal(raw, name);
}

/**
 * Resolve CLI arguments and environment into server options. Refuses
 * ambiguous or unsafe combinations instead of guessing.
 */
export function resolveServeConfig(argv: readonly string[], env: ServeEnv, defaults: { host: string; port: number }): ResolvedServeConfig {
  const rawMode = env.NE_MCP_MODE;
  if (rawMode !== undefined && rawMode !== "local" && rawMode !== "hosted") {
    throw new NeMcpConfigError('NE_MCP_MODE must be "local" (default) or "hosted"');
  }
  const limits = {
    maxConcurrent: optionalDecimal(env, "NE_MCP_MAX_CONCURRENT"),
    maxRequestsPerMinute: optionalDecimal(env, "NE_MCP_RATE_LIMIT_PER_MINUTE"),
  };
  if (rawMode !== "hosted") {
    if (env.NE_MCP_PUBLIC_ORIGIN !== undefined || env.NE_MCP_CUSTOM_ORIGIN !== undefined) {
      throw new NeMcpConfigError("NE_MCP_PUBLIC_ORIGIN / NE_MCP_CUSTOM_ORIGIN are set but NE_MCP_MODE is not \"hosted\"; refusing to guess the mode");
    }
    const port = argValue(argv, "--port") ?? env.NE_MCP_PORT;
    return {
      mode: "local",
      host: argValue(argv, "--host") ?? env.NE_MCP_HOST ?? defaults.host,
      port: port === undefined ? defaults.port : decimal(port, "port"),
      limits,
    };
  }
  if (argv.includes("--host") || argv.includes("--port") || env.NE_MCP_HOST !== undefined || env.NE_MCP_PORT !== undefined) {
    throw new NeMcpConfigError("hosted mode binds 0.0.0.0:$PORT only; --host/--port/NE_MCP_HOST/NE_MCP_PORT are refused");
  }
  if (env.PORT === undefined) throw new NeMcpConfigError("hosted mode requires PORT (set by the hosting platform)");
  const port = decimal(env.PORT, "PORT");
  if (port < 1 || port > 65535) throw new NeMcpConfigError("PORT must be in 1..65535");
  const hosted: NeMcpHostedOptions = {
    publicOrigin: env.NE_MCP_PUBLIC_ORIGIN as string,
    ...(env.NE_MCP_CUSTOM_ORIGIN === undefined ? {} : { customOrigin: env.NE_MCP_CUSTOM_ORIGIN }),
  };
  hostedAllowlist(hosted); // validate now: fail before binding anything
  return { mode: "hosted", host: HOSTED_BIND_HOST, port, hosted, limits };
}
