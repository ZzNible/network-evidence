/**
 * Test-only helpers. Candidate contexts come from the public, offline,
 * deterministic Discovery demo inputs (SYNTHETIC demo probes + one ARCHIVED
 * replay); they are encoded to nec-wire-json-v1 exactly as an external caller
 * would send them. Nothing here is live data.
 */

import { request as httpRequest } from "node:http";
import { Readable } from "node:stream";

import { encodeNecWireJson } from "@nec/core";
import type { DiscoverNetworksInput } from "@nec/discovery";

import { loadDemoInputs } from "../../../examples/discovery/inputs.js";
import { buildDiscoveryInput } from "../../../examples/discovery/run.js";
import type { DiscoverToolInput } from "../src/discover.js";

export interface WireDemo {
  /** The runtime @nec/discovery input the demo itself uses. */
  readonly input: DiscoverNetworksInput;
  /** The same request as an MCP caller sends it (JSON, nec-wire-json-v1). */
  readonly wire: DiscoverToolInput;
}

export function wireJson(type: Parameters<typeof encodeNecWireJson>[0], value: unknown): Record<string, unknown> {
  return JSON.parse(encodeNecWireJson(type, value)) as Record<string, unknown>;
}

export async function loadWireDemo(): Promise<WireDemo> {
  const input = buildDiscoveryInput(await loadDemoInputs());
  const wire: DiscoverToolInput = {
    requestId: input.requestId,
    generatedAt: input.generatedAt,
    requirements: wireJson("discovery-requirements", input.requirements),
    candidates: input.candidates.map((candidate) => {
      const snapshot = wireJson("capability-snapshot", candidate.snapshot);
      return {
        id: candidate.id,
        environment: candidate.environment,
        network: structuredClone(snapshot.network) as Record<string, unknown>,
        manifest: wireJson("resolver-manifest", candidate.manifest),
        snapshot,
      };
    }),
    ...(input.scope === undefined ? {} : { scope: structuredClone(input.scope) as DiscoverToolInput["scope"] }),
  };
  return { input, wire };
}

/** Deep JSON clone for mutation in negative tests. */
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Keys that would carry choice semantics; must never appear in MCP output. */
export const FORBIDDEN_KEY_WORD = /^(rank\w*|scor\w*|best|recommend\w*|weight\w*|priorit\w*|prefer\w*|top|better|confidence|trustScore)$/i;

export function collectKeys(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, out);
  } else if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      out.add(key);
      collectKeys(item, out);
    }
  }
  return out;
}

/**
 * A `fetch` for the SDK client transport that connects to a local socket but
 * sends a SIMULATED public `Host` (and optional `Origin`) header, as an HTTPS
 * terminating platform would forward it. Node's global fetch cannot override
 * `Host`, so this goes through node:http. Test-only; loopback only.
 */
export function simulatedHostFetch(port: number, host: string, extraHeaders: Record<string, string> = {}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).forEach((value, key) => {
      headers[key] = value;
    });
    Object.assign(headers, extraHeaders, { host });
    const body = typeof init?.body === "string" ? init.body : undefined;
    if (body !== undefined) headers["content-length"] = String(Buffer.byteLength(body));
    return await new Promise<Response>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, path: `${url.pathname}${url.search}`, method: init?.method ?? "GET", headers }, (res) => {
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(", ") : value);
        }
        const status = res.statusCode ?? 500;
        const nullBody = status === 204 || status === 205 || status === 304;
        if (nullBody) res.resume();
        resolve(new Response(nullBody ? null : (Readable.toWeb(res) as ReadableStream), { status, headers: responseHeaders }));
      });
      init?.signal?.addEventListener("abort", () => req.destroy(new Error("aborted")), { once: true });
      req.on("error", reject);
      req.end(body);
    });
  }) as typeof fetch;
}
