/**
 * NE-L024 confirmation tests for the abort/deadline seams named by the NE-L022
 * review (offline replay over loopback, no live read):
 * - M-3: a caller abort that precedes the deadline is MCP_LIVE_CALL_CANCELLED,
 *   never a source failure, *_UNAVAILABLE, ineligible or blocked outcome.
 * - notifications/cancelled sent as a separate POST to the stateless hosted
 *   server: its effect is recorded and pinned.
 * - H-3 (legacy-era client abort), H-4 (HTTP slot after a tool-phase client
 *   abort), H-1 (EVM body stall with a signal-ignoring fetch) and H-6 (a 31 s
 *   live call against the server's 30 s requestTimeout, http.ts:319).
 * Provider bytes are the real recorded F1 Base mainnet capture (x402 #1062
 * USDC transfer); every hold, stall, delay and abort is SIMULATED.
 */
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { ClientRequest } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { computeEvidencePolicyDigest } from "@nec/core";
import { assessCaptureOutcomes, classifyCallOutcome } from "../../../examples/hosted-reproduction/capture-hosted.js";
import { startNeMcpHttpServer } from "../src/http.js";
import { NeMcpError, toSafeToolError } from "../src/errors.js";
import { HOSTED_DEFAULT_LIMITS } from "../src/limits.js";
import { createLiveEvmTool, LIVE_EVM_MAX_CONCURRENT, LIVE_EVM_RPC_TIMEOUT_MS } from "../src/live-evm.js";
import {
  createMultichainTool, LIVE_MULTICHAIN_TOOL, LIVE_TOOL_DEADLINE_MS, MULTICHAIN_CALLS_PER_MINUTE, startLiveCall,
} from "../src/live-multichain.js";
import type { LiveCall, MultichainTool } from "../src/live-multichain.js";
import { createLiveBeforeTool, LIVE_BEFORE_TOOL_NAME } from "../src/live-before.js";
import { createLivePreflightTool, LIVE_PREFLIGHT_TOOL_NAME } from "../src/live-preflight.js";
import { simulatedHostFetch } from "./helpers.js";

const F1 = JSON.parse(readFileSync(new URL(
  "../../../examples/historical-compat/authority/fixtures/F1-x402-1062-partial/source/network-evidence/fixtures/base-mainnet-x402-1062-usdc-transfer.fixture.json",
  import.meta.url), "utf8")) as {
  subject: { txHash: string };
  captures: { rpcMethod: string; rpcParams: unknown[]; resultJson: string }[];
};
const TX = F1.subject.txHash;
/** The only URL the guard admits for base-mainnet: `new URL(source.url).href`. */
const BASE_URL = "https://mainnet.base.org/";
const SUBJECT = { type: "transaction", networkId: "eip155:8453", txId: TX } as const;
const REQUIREMENTS = { requirements: [{ capability: "execution", strength: "required" }] };
const ORIGIN = "https://mcp.example.org";
const HOST = "mcp.example.org";
/** 2025-era stateless headers, as in hosted-ingress-budget.test.ts. */
const LEGACY_HEADERS = {
  host: HOST, "content-type": "application/json",
  "mcp-protocol-version": "2025-11-25", accept: "application/json, text/event-stream",
};
const LIST = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
const CANCELLED_MESSAGE =
  "the live tool call was cancelled by the caller before its deadline; no observation or availability claim was produced";
/** Longer than the server's 30 s requestTimeout, shorter than the 35 s whole-call deadline. */
const SIMULATED_CALL_MS = 31_000;

const urlOf = (input: Parameters<typeof fetch>[0]) =>
  new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).href;
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function sourceResponse(body: string | ReadableStream<Uint8Array>): Response {
  const response = new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  Object.defineProperty(response, "url", { value: BASE_URL });
  return response;
}

/** The exact recorded F1 answer for an exact recorded Base mainnet read; anything else throws. */
function f1Read(input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]): string {
  if (urlOf(input) !== BASE_URL) throw Error("Unapproved fake endpoint");
  const req = JSON.parse(init?.body as string) as { id: number; method: string; params?: unknown[] };
  const found = F1.captures.find(c => c.rpcMethod === req.method);
  if (!found || JSON.stringify(req.params ?? []) !== JSON.stringify(found.rpcParams)) throw Error("Unexpected mock method or params");
  return `{"jsonrpc":"2.0","id":${JSON.stringify(req.id)},"result":${found.resultJson}}`;
}

const f1Answer: typeof fetch = async (input, init) => sourceResponse(f1Read(input, init));

/**
 * F1 replay. Until release(), every read is held and, like real fetch, rejects
 * only when its init.signal aborts. release() answers held and later reads.
 */
function heldProvider() {
  const state = { held: 0, aborted: 0, abortedAt: undefined as number | undefined };
  let holding = true;
  const waiting: (() => void)[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const body = f1Read(input, init);
    if (holding) {
      state.held += 1;
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        waiting.push(() => { if (!settled) { settled = true; resolve(); } });
        const onAbort = () => {
          if (settled) return;
          settled = true;
          state.aborted += 1;
          state.abortedAt ??= performance.now();
          reject(new Error("aborted"));
        };
        init?.signal?.addEventListener("abort", onAbort, { once: true });
        if (init?.signal?.aborted) onAbort();
      });
    }
    return sourceResponse(body);
  };
  return { state, fetchFn, release: () => { holding = false; for (const answer of waiting.splice(0)) answer(); } };
}

function preflightRequest() {
  const content = { id: "external_policy_1", version: "1", requiredDimensions: ["execution" as const], desiredDimensions: [] };
  return {
    schemaVersion: "0.1", requestId: "external_preflight_1", networkId: SUBJECT.networkId,
    action: { kind: "erc20.transfer", target: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", fields: { expectedAmount: "1000" } },
    evidencePolicy: { ...content, digest: computeEvidencePolicyDigest(content) },
  };
}

const toolsCall = (id: number) => JSON.stringify({
  jsonrpc: "2.0", id, method: "tools/call", params: { name: LIVE_MULTICHAIN_TOOL, arguments: { subject: SUBJECT } },
});

interface RawReply { readonly status: number; readonly body: string }

/** One raw loopback POST /mcp with the simulated public Host; `req` can be destroyed to abort it. */
function rawPost(port: number, body: string): { readonly req: ClientRequest; readonly reply: Promise<RawReply> } {
  const req = httpRequest({ host: "127.0.0.1", port, path: "/mcp", method: "POST", agent: false,
    headers: { ...LEGACY_HEADERS, connection: "close", "content-length": String(Buffer.byteLength(body)) } });
  const reply = new Promise<RawReply>((resolve, reject) => {
    req.on("response", (res) => {
      const parts: Buffer[] = [];
      res.on("data", (chunk: Buffer) => parts.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("error", reject);
  });
  req.end(body);
  return { req, reply };
}

/** The JSON-RPC message of a plain JSON or text/event-stream reply body. */
function jsonRpcOf(text: string): Record<string, unknown> | undefined {
  const candidates = [text, ...text.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trim())];
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isRecord(parsed) && parsed.jsonrpc === "2.0") return parsed;
    } catch { /* not this candidate */ }
  }
  return undefined;
}

/** What the client of request `id` received: a complete observation, a tool error code, or nothing usable. */
function outcomeOf(message: Record<string, unknown> | undefined, id: number): string {
  if (message === undefined || message.id !== id) return "none";
  if (isRecord(message.error)) return "jsonrpc_error";
  const result = message.result;
  if (!isRecord(result)) return "none";
  if (result.isError === true) {
    const first: unknown = Array.isArray(result.content) ? result.content[0] : undefined;
    const text = isRecord(first) && typeof first.text === "string" ? first.text : "";
    let code: unknown;
    try { code = (JSON.parse(text) as { error?: { code?: unknown } }).error?.code; } catch { code = undefined; }
    return `tool_error:${String(code)}`;
  }
  const env = result.structuredContent;
  return isRecord(env) && env.toolStatus === "observed" && isRecord(env.subject) && env.subject.txId === TX ? "observed" : "other";
}

/** What each confirmation observed; re-checked by the last plain test. */
const notification: { cancelStatus?: number; providerAborted?: boolean; firstStatus?: number; firstClient?: string } = {};
const h1: { settled?: string[]; stalledReads?: number; bodyCancelled?: number; following?: unknown } = {};

const realFetch = globalThis.fetch;
let globalFetchAttempts = 0;
beforeAll(() => {
  globalThis.fetch = (async () => {
    globalFetchAttempts += 1;
    throw new Error("network I/O is forbidden in live-abort-confirmation tests");
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("M-3: a caller abort before the deadline has its own code", () => {
  it("caller_abort_before_deadline_is_not_classified_as_source_failure", { timeout: 20_000 }, async () => {
    const p = heldProvider();
    const tool = createMultichainTool(p.fetchFn);
    const discover = createLiveBeforeTool(tool);
    const preflight = createLivePreflightTool(tool);
    const directCalls: LiveCall[] = [];
    const runs: readonly { readonly captureId: string; readonly tool: string; readonly run: (signal: AbortSignal) => Promise<unknown> }[] = [
      { captureId: "base-mainnet-pinned", tool: LIVE_MULTICHAIN_TOOL, run: (signal) => {
        const call = startLiveCall(tool, signal);
        directCalls.push(call);
        return tool({ subject: SUBJECT, call });
      } },
      { captureId: "discover-mainnet", tool: LIVE_BEFORE_TOOL_NAME, run: (signal) =>
        discover({ requestId: "ne_l024_cancel_discover_1", requirements: REQUIREMENTS, subjects: [SUBJECT] }, signal) },
      { captureId: "preflight-base-mainnet-probe", tool: LIVE_PREFLIGHT_TOOL_NAME, run: (signal) =>
        preflight({ selectedNetworkId: SUBJECT.networkId, probeSubject: SUBJECT, request: preflightRequest() }, signal) },
    ];
    for (const [index, entry] of runs.entries()) {
      const caller = new AbortController();
      let caught: unknown;
      const pending = entry.run(caller.signal).then(() => { caught = "resolved"; }, (error: unknown) => { caught = error; });
      // Abort only once the provider read is in flight, i.e. after admission.
      await expect.poll(() => p.state.held, { timeout: 2_000, interval: 10 }).toBe(index + 1);
      caller.abort();
      await pending;
      await expect.poll(() => p.state.aborted, { timeout: 1_000, interval: 10 }).toBe(index + 1);
      expect(caught).toBeInstanceOf(NeMcpError);
      expect((caught as NeMcpError).code).toBe("MCP_LIVE_CALL_CANCELLED");
      const safe = toSafeToolError(caught);
      expect(safe).toEqual({ code: "MCP_LIVE_CALL_CANCELLED", message: CANCELLED_MESSAGE, cause: null });
      // The capture client has no class for it: unclassified, never an expected outcome.
      const captured = {
        id: entry.captureId, tool: entry.tool, isError: true, structuredContent: null,
        content: [{ type: "text", text: JSON.stringify({ error: safe }) }],
      };
      expect(classifyCallOutcome(captured)).toEqual({ kind: "unclassified", code: "MCP_LIVE_CALL_CANCELLED" });
      expect(assessCaptureOutcomes([captured])[0]?.expected).toBe(false);
    }
    // The cancel preceded the 35 s deadline.
    expect(directCalls).toHaveLength(1);
    expect(directCalls[0]!.signal.aborted).toBe(true);
    expect(directCalls[0]!.deadline.aborted).toBe(false);
    // Both in-flight slots are free again: two immediate calls are admitted
    // once the aborted inner reads have unwound (one macrotask).
    p.release();
    await delay(50);
    expect((await Promise.all([tool({ subject: SUBJECT }), tool({ subject: SUBJECT })])).map(x => x.toolStatus))
      .toEqual(["observed", "observed"]);
    // The per-minute count kept all three cancelled calls; a refund would let a
    // ninth call reach the inner EVM budget and fail with MCP_LIVE_EVM_RATE_LIMIT.
    for (let n = runs.length + 2; n < MULTICHAIN_CALLS_PER_MINUTE; n++) {
      expect((await tool({ subject: SUBJECT })).toolStatus).toBe("observed");
    }
    await expect(tool({ subject: SUBJECT })).rejects.toMatchObject({ code: "MCP_MULTICHAIN_RATE_LIMIT" });
  });
});

describe("abort and deadline seams over loopback HTTP", () => {
  it("stateless_notifications_cancelled_effect", { timeout: 20_000 }, async () => {
    const p = heldProvider();
    const server = await startNeMcpHttpServer({
      host: "127.0.0.1", port: 0, hosted: { publicOrigin: ORIGIN }, liveEvidence: createMultichainTool(p.fetchFn),
    });
    try {
      const first = rawPost(server.port, toolsCall(41));
      await expect.poll(() => p.state.held, { timeout: 2_000, interval: 10 }).toBe(1);
      const cancel = await rawPost(server.port, JSON.stringify({
        jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 41, reason: "ne-l024 confirmation" },
      })).reply;
      await delay(1_000);
      notification.cancelStatus = cancel.status;
      notification.providerAborted = p.state.aborted > 0;
      // Let the held read answer, well inside its 6 s per-read budget.
      p.release();
      const reply = await first.reply;
      notification.firstStatus = reply.status;
      notification.firstClient = outcomeOf(jsonRpcOf(reply.body), 41);
      // Pinned observation: the notification is accepted, but it reaches a fresh
      // per-request server (http.ts:200), so the original call is not cancelled
      // and its client receives the complete observation.
      expect([200, 202]).toContain(notification.cancelStatus);
      expect(notification).toEqual({
        cancelStatus: notification.cancelStatus, providerAborted: false, firstStatus: 200, firstClient: "observed",
      });
    } finally {
      p.release();
      await server.close();
    }
  });

  it("h12_legacy_era_client_abort_reaches_provider_signal", { timeout: 20_000 }, async () => {
    const p = heldProvider();
    const server = await startNeMcpHttpServer({
      host: "127.0.0.1", port: 0, hosted: { publicOrigin: ORIGIN }, liveEvidence: createMultichainTool(p.fetchFn),
    });
    const disconnect = new AbortController();
    const local = simulatedHostFetch(server.port, HOST);
    // Only the tools/call POST is tied to the client-side abort; a retried call after it is refused locally.
    const transportFetch: typeof fetch = (input, init) => {
      if (typeof init?.body !== "string" || !init.body.includes('"tools/call"')) return local(input, init);
      if (disconnect.signal.aborted) return Promise.reject(new Error("client disconnected"));
      const own = init.signal ?? undefined;
      return local(input, { ...init, signal: own === undefined ? disconnect.signal : AbortSignal.any([own, disconnect.signal]) });
    };
    const client = new Client({ name: "live-abort-confirmation-h3", version: "1" }, { versionNegotiation: { mode: "legacy" } });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(ORIGIN + "/mcp"), { fetch: transportFetch }));
      expect(client.getProtocolEra()).toBe("legacy");
      void client.callTool({ name: LIVE_MULTICHAIN_TOOL, arguments: { subject: SUBJECT } }).catch(() => {});
      await expect.poll(() => p.state.held, { timeout: 2_000, interval: 10 }).toBe(1);
      expect(p.state.aborted).toBe(0);
      const abortAt = performance.now();
      disconnect.abort();
      await expect.poll(() => p.state.abortedAt, { timeout: 1_000, interval: 20 }).toBeDefined();
      expect(p.state.abortedAt! - abortAt).toBeLessThanOrEqual(1_000);
    } finally {
      p.release();
      await client.close().catch(() => {});
      await server.close();
    }
  });

  it("http_slot_released_after_tool_phase_client_abort", { timeout: 20_000 }, async () => {
    const p = heldProvider();
    const server = await startNeMcpHttpServer({
      host: "127.0.0.1", port: 0, hosted: { publicOrigin: ORIGIN },
      limits: { ...HOSTED_DEFAULT_LIMITS, maxConcurrent: 1 }, liveEvidence: createMultichainTool(p.fetchFn),
    });
    try {
      const call = rawPost(server.port, toolsCall(51));
      call.reply.catch(() => {});
      // The body was read and dispatched: the live tool phase holds the sole /mcp slot.
      await expect.poll(() => p.state.held, { timeout: 2_000, interval: 10 }).toBe(1);
      expect((await rawPost(server.port, LIST).reply).status).toBe(429);
      const abortAt = performance.now();
      call.req.destroy();
      await expect.poll(async () => (await rawPost(server.port, LIST).reply).status, { timeout: 1_000, interval: 20 }).toBe(200);
      expect(performance.now() - abortAt).toBeLessThan(1_500);
    } finally {
      p.release();
      await server.close();
    }
  });

  // H-1 REPRODUCED (see the last test): the guard's bounded clone read
  // (live-evm.ts:170-186) does not observe its per-read budget signal, so a
  // body that stalls after headers under a signal-ignoring fetch is never cut
  // and both inner EVM slots stay held. Real fetch errors the body on abort;
  // this is a fetch-implementation-dependent gap. Not fixed here (NE-L024).
  it.fails("evm_body_stall_with_signal_ignoring_fetch_is_cut_by_per_read_budget", { timeout: 20_000 }, async () => {
    let stall = true;
    let stalledReads = 0;
    let bodyCancelled = 0;
    const provider: typeof fetch = async (input, init) => {
      const body = f1Read(input, init);
      if (!stall) return sourceResponse(body);
      stalledReads += 1;
      // Headers arrive at once; body bytes never do, and this fetch ignores init.signal.
      return sourceResponse(new ReadableStream<Uint8Array>({ cancel() { bodyCancelled += 1; } }));
    };
    const evm = createLiveEvmTool(provider, { includeTransaction: true });
    const settled = Array.from({ length: LIVE_EVM_MAX_CONCURRENT }, () => "pending");
    for (let i = 0; i < LIVE_EVM_MAX_CONCURRENT; i++) {
      void evm({ network: "base-mainnet", txHash: TX }).then(() => { settled[i] = "resolved"; }, () => { settled[i] = "rejected"; });
    }
    await delay(LIVE_EVM_RPC_TIMEOUT_MS + 1_000);
    stall = false;
    let following: unknown = "admitted";
    try { await evm({ network: "base-mainnet", txHash: TX }); } catch (error) { following = (error as { code?: unknown }).code; }
    Object.assign(h1, { settled: [...settled], stalledReads, bodyCancelled, following });
    expect(stalledReads).toBe(LIVE_EVM_MAX_CONCURRENT);
    expect(h1.settled).toEqual(Array.from({ length: LIVE_EVM_MAX_CONCURRENT }, () => "rejected"));
    expect(h1.following).toBe("admitted");
  });

  it("live_call_of_31s_is_not_cut_by_server_requestTimeout", { timeout: 60_000 }, async () => {
    expect(SIMULATED_CALL_MS).toBeLessThan(LIVE_TOOL_DEADLINE_MS);
    const real = createMultichainTool(f1Answer);
    // SIMULATED slow live call: waits under the call's own signal, then resolves the real F1 replay.
    const slow: MultichainTool = Object.assign(async (input: Parameters<MultichainTool>[0]) => {
      await delay(SIMULATED_CALL_MS, undefined, input.call === undefined ? {} : { signal: input.call.signal });
      return real(input);
    }, { startCall: real.startCall });
    const server = await startNeMcpHttpServer({ host: "127.0.0.1", port: 0, hosted: { publicOrigin: ORIGIN }, liveEvidence: slow });
    try {
      const started = performance.now();
      const reply = await rawPost(server.port, toolsCall(61)).reply;
      const elapsedMs = performance.now() - started;
      expect(elapsedMs).toBeGreaterThan(30_000);
      expect(reply.status).toBe(200);
      expect(outcomeOf(jsonRpcOf(reply.body), 61)).toBe("observed");
    } finally {
      await server.close();
    }
  });
});

describe("stop-and-report", () => {
  it("each confirmation recorded what it observed; no global fetch was attempted", () => {
    expect(globalFetchAttempts).toBe(0);
    expect(notification).toMatchObject({ providerAborted: false, firstStatus: 200, firstClient: "observed" });
    // H-1: after budget + 1 s neither stalled read had settled, nothing cancelled
    // the stalled body, and a third read was refused by the leaked inner slots.
    expect(h1).toEqual({
      settled: Array.from({ length: LIVE_EVM_MAX_CONCURRENT }, () => "pending"),
      stalledReads: LIVE_EVM_MAX_CONCURRENT, bodyCancelled: 0, following: "MCP_LIVE_EVM_RATE_LIMIT",
    });
  });
});
