/**
 * BEFORE/Discovery -> explicit caller choice -> preflight separation at the
 * hosted MCP surface (offline replay, no live read).
 *
 * Real captures only, served verbatim (exact resultJson bytes) for the exact
 * recorded params; no identifier is paired with foreign bytes:
 * - Base mainnet: mcp fixtures/base-mainnet-l2-finalized-positive-evm.json
 *   (0x71c9e27a…625c, captured 2026-10-09).
 * - Solana mainnet: resolver-solana solana-mainnet-x402-real.json
 *   (4DYWUMEx…LF71, captured 2026-08-26).
 * The caller's action target is that Base transaction's own `to`. Request and
 * policy ids are caller labels, not network identifiers. The single response
 * mutation is SYNTHETIC and used only by the test titled SYNTHETIC.
 *
 * Date is pinned to the Base capture's recorded acquisition instant so that
 * two independent preflights can be compared byte for byte; real timers
 * (whole-call deadlines, HTTP) keep running.
 */
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  computeEvidencePolicyDigest, decodeNecWireJson,
  verifyCapabilitySnapshot, verifyPreflightResult,
} from "@nec/core";
import type { EvidencePolicy, PolicyDimension, PreflightRequest } from "@nec/core";
import { startNeMcpHttpServer } from "../src/http.js";
import { createMultichainTool, MULTICHAIN_CALLS_PER_MINUTE } from "../src/live-multichain.js";
import { LIVE_BEFORE_TOOL_NAME } from "../src/live-before.js";
import { LIVE_PREFLIGHT_TOOL_NAME } from "../src/live-preflight.js";
import { collectKeys, FORBIDDEN_KEY_WORD, simulatedHostFetch } from "./helpers.js";

interface Capture { rpcMethod: string; rpcParams: unknown[]; resultJson: string }
const read = <T>(path: string): T => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as T;
const EVM = read<{ acquiredAt: string; source: { networkId: string; chainId: number }; subject: { txHash: string }; captures: Capture[] }>(
  "./fixtures/base-mainnet-l2-finalized-positive-evm.json");
const SOL = read<{ networkId: string; subject: { signature: string }; captures: Capture[] }>(
  "../../resolver-solana/test/fixtures/solana-mainnet-x402-real.json");

const ORIGIN = "https://mcp.example.org";
const HOST = "mcp.example.org";
const BASE_ID = "eip155:8453" as const;
const SOL_ID = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" as const;
const BASE_URL = "https://mainnet.base.org/";
const SOL_URL = "https://api.mainnet-beta.solana.com/";
const SOURCE_HOSTS = ["mainnet.base.org", "api.mainnet-beta.solana.com"];
const BASE_METHODS = ["eth_chainId", "eth_getTransactionReceipt", "eth_getBlockByHash", "eth_getTransactionByHash"];
const NULL_BASE_METHODS = ["eth_chainId", "eth_getTransactionReceipt", "eth_getTransactionByHash"];
const SOL_METHODS = ["getGenesisHash", "getTransaction", "getSignatureStatuses", "getBlock"];
const PINNED_AT = EVM.acquiredAt;

const EVM_SUBJECT = { type: "transaction", networkId: BASE_ID, txId: EVM.subject.txHash } as const;
const SOL_SUBJECT = { type: "transaction", networkId: SOL_ID, txId: SOL.subject.signature } as const;
const DISCOVERY_INPUT = {
  requestId: "ne_before_separation_1",
  requirements: { requirements: [
    { capability: "execution", strength: "required" },
    { capability: "finality", strength: "desired" },
  ] },
  subjects: [EVM_SUBJECT, SOL_SUBJECT],
};

/** The real Base transaction's own `to`, used as the caller's action target. */
const ACTION_TARGET = (JSON.parse(EVM.captures.find(c => c.rpcMethod === "eth_getTransactionByHash")!.resultJson) as { to: string }).to;
const POLICY_CONTENT = {
  id: "caller_policy_requires_finality", version: "1",
  requiredDimensions: ["execution", "finality"] as PolicyDimension[],
};
const POLICY: EvidencePolicy = { ...POLICY_CONTENT, digest: computeEvidencePolicyDigest(POLICY_CONTENT) };
/** The caller's explicit choice: a literal fixed before any tool call, never read from Discovery output. */
const CALLER_CHOICE = BASE_ID;
const REQUEST: PreflightRequest = {
  schemaVersion: "0.1", requestId: "ne_caller_preflight_1", networkId: CALLER_CHOICE,
  action: { kind: "evm.contract_call", target: ACTION_TARGET },
  evidencePolicy: POLICY,
};
const PREFLIGHT_INPUT = { selectedNetworkId: CALLER_CHOICE, probeSubject: EVM_SUBJECT, request: REQUEST };
const PREFLIGHT_INPUT_FIXED = JSON.stringify(PREFLIGHT_INPUT);

/**
 * Offline replay of the two real captures for the two fixed mainnet origins
 * only (any other URL, method or params throws). SYNTHETIC option, used only
 * by the test titled SYNTHETIC: the Base receipt and transaction answers set
 * to null.
 */
function provider(synthetic: { nullBaseReceiptAndTransaction?: boolean } = {}) {
  const methods: string[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).href;
    const query = JSON.parse(init?.body as string) as { id: number; method: string; params?: unknown[] };
    methods.push(query.method);
    const fixture = url === BASE_URL ? EVM : url === SOL_URL ? SOL : null;
    if (fixture === null) throw Error("Unapproved fake endpoint");
    const found = fixture.captures.find(c => c.rpcMethod === query.method);
    if (!found) throw Error("Unexpected mock method");
    if (!isDeepStrictEqual(query.params ?? [], found.rpcParams)) throw Error("Unexpected mock params");
    let resultText = found.resultJson;
    if (synthetic.nullBaseReceiptAndTransaction && fixture === EVM
      && (query.method === "eth_getTransactionReceipt" || query.method === "eth_getTransactionByHash")) resultText = "null";
    const response = new Response(`{"jsonrpc":"2.0","id":${JSON.stringify(query.id)},"result":${resultText}}`, {
      status: 200, headers: { "content-type": "application/json" },
    });
    Object.defineProperty(response, "url", { value: url });
    return response;
  };
  return { fetchFn, methods };
}

type Call = (name: string, args: Record<string, unknown>) => Promise<any>;

/** One hosted opt-in server + ONE modern MCP client session; returns every tool response as text. */
async function session(fetchFn: typeof fetch, run: (call: Call) => Promise<void>): Promise<string[]> {
  const seen: string[] = [];
  const server = await startNeMcpHttpServer({
    host: "127.0.0.1", port: 0, hosted: { publicOrigin: ORIGIN }, liveEvidence: createMultichainTool(fetchFn),
  });
  try {
    const client = new Client({ name: "live-before-preflight-separation-test", version: "1" }, { versionNegotiation: { mode: "auto" } });
    await client.connect(new StreamableHTTPClientTransport(new URL(ORIGIN + "/mcp"), { fetch: simulatedHostFetch(server.port, HOST) }));
    try {
      await run(async (name, args) => {
        const result = await client.callTool({ name, arguments: args });
        seen.push(JSON.stringify(result));
        return result;
      });
    } finally { await client.close(); }
  } finally { await server.close(); }
  return seen;
}

/** A failed tool call: bounded safe error only, no structured evidence. */
function errorCode(result: any): string {
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toBeUndefined();
  const parsed = JSON.parse(result.content[0].text as string) as { error: { code: string; cause: unknown } };
  expect(parsed.error.cause).toBeNull();
  return parsed.error.code;
}

function stringsOf(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringsOf(item, out);
  else if (typeof value === "object" && value !== null) for (const item of Object.values(value)) stringsOf(item, out);
  return out;
}

/** Conditional Base under required finality: blocked, never borrowing L2 finality or claiming settlement. */
function expectBlockedWithoutBorrowedFinality(out: any): void {
  expect(out).toMatchObject({
    schema: "ne-mcp-live-preflight/v0.1", choiceSource: "caller", selectedNetworkId: BASE_ID,
    probeSubject: EVM_SUBJECT, probeObservedAt: PINNED_AT, verifiedBy: "@nec/core",
  });
  const result = decodeNecWireJson("preflight-result", JSON.stringify(out.preflight));
  const snapshot = decodeNecWireJson("capability-snapshot", JSON.stringify(out.capabilitySnapshot));
  const manifest = decodeNecWireJson("resolver-manifest", JSON.stringify(out.resolverManifest));
  expect(verifyCapabilitySnapshot(snapshot, { resolver: manifest, networkId: BASE_ID })).toBe(true);
  expect(verifyPreflightResult(result, { resolver: manifest, capabilitySnapshot: snapshot })).toBe(true);
  expect(result.request).toEqual(REQUEST);
  expect(result.status).toBe("blocked");
  expect(result.evidenceReadiness.execution.status).toBe("ready");
  // The generic EVM resolver claims no finality or settlement; the AFTER OP
  // Stack L2 finality probe is never consulted for preflight readiness.
  expect(result.evidenceReadiness.finality.status).toBe("not_applicable");
  expect(result.evidenceReadiness.settlement.status).toBe("not_applicable");
  expect(snapshot.evidenceCapabilities.finality.availability).not.toBe("available");
  expect(snapshot.evidenceCapabilities.settlement.availability).not.toBe("available");
  expect(out.evidenceCaptures.map((c: any) => c.rpcMethod)).toEqual(BASE_METHODS);
  expect(collectKeys(out).has("opStackFinality")).toBe(false);
  const text = JSON.stringify(out);
  expect(text).not.toContain("opstack.rpc-finalized-head-v1");
  expect(text).not.toMatch(/settlement\W+(is\W+|was\W+)?(satisfied|established|ready|achieved|confirmed)/i);
}

const realFetch = globalThis.fetch;
let globalFetchAttempts = 0;
beforeAll(() => {
  globalThis.fetch = (async () => {
    globalFetchAttempts += 1;
    throw new Error("network I/O is forbidden in live-before-preflight-separation tests");
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});
// Only Date is faked; setTimeout, AbortSignal.timeout and HTTP stay real.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse(PINNED_AT));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("BEFORE/Discovery -> explicit caller choice -> separate preflight, on real pinned captures only", () => {
  it("one session: Discovery over real Base and Solana, the caller explicitly chooses conditional Base, and the blocked preflight equals one from a session that never ran Discovery", async () => {
    expect(EVM.subject.txHash).toBe("0x71c9e27a7195bdecf1c63e73d5f959c96ddb35a27f6f1308835494c3156d625c");
    expect(EVM.source).toMatchObject({ networkId: BASE_ID, chainId: 8453 });
    expect(SOL.subject.signature).toBe("4DYWUMExSrMNxYLjUuH9G8feN4fmYXm4ToCx7gGaAEjJRf2QNrE8LsvoFSGhXwQJrchhgrnGpUFwjxrci9PRLF71");
    expect(SOL.networkId).toBe(SOL_ID);
    expect(ACTION_TARGET).toBe("0x4200000000000000000000000000000000000015");
    expect(new Date().toISOString()).toBe(PINNED_AT);

    const p = provider();
    let chosen: any;
    const seen = await session(p.fetchFn, async (call) => {
      // (1) Discovery: exactly 8 provider reads, Core classifications, no choice semantics.
      const discovery = await call(LIVE_BEFORE_TOOL_NAME, DISCOVERY_INPUT);
      expect(discovery.isError).toBeFalsy();
      const d = discovery.structuredContent as any;
      expect(d.candidates.map((c: any) => [c.id, c.classification])).toEqual([
        ["base-mainnet", "conditional"], ["solana-mainnet", "eligible"],
      ]);
      for (const key of collectKeys(d)) expect(key).not.toMatch(FORBIDDEN_KEY_WORD);
      expect(p.methods).toEqual([...BASE_METHODS, ...SOL_METHODS]);

      // (2) The caller's choice and request were fixed before Discovery and
      // carry no Discovery digest, classification, snapshot id or request id.
      expect(JSON.stringify(PREFLIGHT_INPUT)).toBe(PREFLIGHT_INPUT_FIXED);
      expect(Object.keys(PREFLIGHT_INPUT).sort()).toEqual(["probeSubject", "request", "selectedNetworkId"]);
      const digests = stringsOf(d).filter(s => s.startsWith("sha256:"));
      expect(digests.length).toBeGreaterThan(2);
      for (const marker of [...digests, ...d.candidates.map((c: any) => c.snapshotId as string), DISCOVERY_INPUT.requestId]) {
        expect(PREFLIGHT_INPUT_FIXED).not.toContain(marker);
      }
      expect(PREFLIGHT_INPUT_FIXED).not.toMatch(/eligible|conditional/);

      // (3) Preflight on the chosen network: one fresh probe, Core-verified, blocked.
      chosen = await call(LIVE_PREFLIGHT_TOOL_NAME, PREFLIGHT_INPUT);
      expect(chosen.isError).toBeFalsy();
      expect(p.methods.slice(8)).toEqual(BASE_METHODS);
      expectBlockedWithoutBorrowedFinality(chosen.structuredContent);

      // Shared 8/min budget across steps: Discovery took 2 admissions (one
      // per subject), the preflight 1; the rest are spent by repeat preflights.
      for (let n = 3; n < MULTICHAIN_CALLS_PER_MINUTE; n++) {
        const again = await call(LIVE_PREFLIGHT_TOOL_NAME, PREFLIGHT_INPUT);
        expect(again.content[0].text).toBe(chosen.content[0].text);
      }
      const reads = p.methods.length;
      expect(reads).toBe(8 + 4 * (MULTICHAIN_CALLS_PER_MINUTE - 2));
      expect(errorCode(await call(LIVE_PREFLIGHT_TOOL_NAME, PREFLIGHT_INPUT))).toBe("MCP_MULTICHAIN_RATE_LIMIT");
      expect(errorCode(await call(LIVE_BEFORE_TOOL_NAME, DISCOVERY_INPUT))).toBe("MCP_MULTICHAIN_RATE_LIMIT");
      expect(p.methods).toHaveLength(reads); // no provider read after the budget
    });

    // Separation: a fresh server and session that never called Discovery.
    const fresh = provider();
    let alone: any;
    seen.push(...await session(fresh.fetchFn, async (call) => {
      alone = await call(LIVE_PREFLIGHT_TOOL_NAME, PREFLIGHT_INPUT);
    }));
    expect(fresh.methods).toEqual(BASE_METHODS);
    expect(alone.isError).toBeFalsy();
    expect(JSON.stringify(alone.structuredContent)).toBe(JSON.stringify(chosen.structuredContent));
    expect(alone.content[0].text).toBe(chosen.content[0].text);

    for (const text of seen) for (const host of SOURCE_HOSTS) expect(text).not.toContain(host);
    expect(globalFetchAttempts).toBe(0);
  });

  it("SYNTHETIC (real Base capture, receipt+transaction set to null): Discovery says ineligible; a caller who still chooses Base gets MCP_LIVE_PREFLIGHT_UNAVAILABLE, never a blocked or contradicted verdict", async () => {
    const p = provider({ nullBaseReceiptAndTransaction: true });
    const seen = await session(p.fetchFn, async (call) => {
      const discovery = await call(LIVE_BEFORE_TOOL_NAME, DISCOVERY_INPUT);
      expect(discovery.isError).toBeFalsy();
      const d = discovery.structuredContent as any;
      expect(d.candidates.map((c: any) => [c.id, c.classification])).toEqual([
        ["base-mainnet", "ineligible"], ["solana-mainnet", "eligible"],
      ]);
      expect(d.nonClaims.some((x: string) => x.includes("not proof of network unavailability"))).toBe(true);
      for (const key of collectKeys(d)) expect(key).not.toMatch(FORBIDDEN_KEY_WORD);
      expect(p.methods).toEqual([...NULL_BASE_METHODS, ...SOL_METHODS]);

      // The caller still chooses Base with the same fixed input.
      const preflight = await call(LIVE_PREFLIGHT_TOOL_NAME, PREFLIGHT_INPUT);
      expect(errorCode(preflight)).toBe("MCP_LIVE_PREFLIGHT_UNAVAILABLE");
      expect(preflight.content[0].text).not.toMatch(/blocked|contradicted|not_applicable|ineligible/i);
      expect(p.methods.slice(NULL_BASE_METHODS.length + SOL_METHODS.length)).toEqual(NULL_BASE_METHODS);
    });
    for (const text of seen) for (const host of SOURCE_HOSTS) expect(text).not.toContain(host);
    expect(globalFetchAttempts).toBe(0);
  });
});
