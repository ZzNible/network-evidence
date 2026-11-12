/**
 * NE-L049, G2-A conformance check. Test only; no MCP src, Core, fixture or
 * other test change.
 *
 * OFFLINE REPLAY ONLY. No live network, deployment, hosted capture, transaction
 * or signing. This file CLOSES NO GATE ROW: GT-08 stays as recorded and GT-09
 * stays OPEN. It does not claim that a G2-A owner record exists.
 *
 * Per SDK era ("legacy", then "modern"; asserted with client.getProtocolEra()),
 * a FRESH hosted loopback server and one client session make:
 *   1. discover_live_network_evidence {execution required, finality desired}
 *      over the Base mainnet and Solana mainnet probes;
 *   2. a SEPARATE discover_live_network_evidence call with a distinct requestId
 *      and distinct requirements {execution required, finality required};
 *   3. a SEPARATE preflight_live_network_evidence call whose input is a literal
 *      fixed at module load, before any tool call.
 * Each Discovery result is checked on its own by the client with Core
 * (decodeNecWireJson("discovery-result") + verifyDiscoverNetworksResultIntegrity).
 *
 * What the client can and cannot check: the served Discovery envelope does NOT
 * carry the complete CapabilitySnapshots and ResolverManifests the result
 * references, so a client can check only INTEGRITY (structure + self-digest).
 * Contextual verification (snapshot/manifest closure and agreement with the
 * normative composer) runs server-side in live-before.ts:182-183
 * (discoverNetworks + verifyDiscoverNetworksResult). An integrity pass is not a
 * contextual pass: a forger who recomputes the self-digest is caught only by
 * the contextual verifier. The preflight output, by contrast, serves its
 * complete snapshot and manifest, so verifyPreflightResult runs client-side.
 *
 * Provider bytes are REAL pinned captures only, served verbatim (exact
 * resultJson) for the exact recorded method and params:
 * - Base mainnet: packages/mcp/test/fixtures/base-mainnet-l2-finalized-positive-evm.json
 *   (0x71c9e27a…625c, acquired 2026-10-09T15:42:11.665Z).
 * - Solana mainnet: packages/resolver-solana/test/fixtures/solana-mainnet-x402-real.json
 *   (4DYWUMEx…LF71, acquired 2026-08-26T20:01:41.884Z).
 * Any other URL, method or params throws. Global fetch throws and its counter
 * must stay 0. Only Date is faked, pinned to the Base capture's acquiredAt;
 * real timers (whole-call deadlines, HTTP) keep running.
 *
 * Classifications are Core's native outputs over source-reported probe
 * observations. They are not a recommendation, ranking, network choice,
 * settlement or finality claim.
 */
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  computeEvidencePolicyDigest, decodeNecWireJson,
  verifyCapabilitySnapshot, verifyDiscoverNetworksResult, verifyDiscoverNetworksResultIntegrity, verifyPreflightResult,
} from "@nec/core";
import type { DiscoverNetworksResult, EvidencePolicy, PolicyDimension, PreflightRequest } from "@nec/core";
import { startNeMcpHttpServer } from "../src/http.js";
import { createMultichainTool, MULTICHAIN_CALLS_PER_MINUTE } from "../src/live-multichain.js";
import { LIVE_BEFORE_SCHEMA, LIVE_BEFORE_TOOL_NAME } from "../src/live-before.js";
import { LIVE_PREFLIGHT_TOOL_NAME } from "../src/live-preflight.js";
import { simulatedHostFetch } from "./helpers.js";

interface Capture { rpcMethod: string; rpcParams: unknown[]; resultJson: string }
const read = <T>(path: string): T => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as T;
const EVM = read<{ acquiredAt: string; source: { networkId: string; chainId: number }; subject: { txHash: string }; captures: Capture[] }>(
  "./fixtures/base-mainnet-l2-finalized-positive-evm.json");
const SOL = read<{ acquiredAt: string; networkId: string; subject: { signature: string }; captures: Capture[] }>(
  "../../resolver-solana/test/fixtures/solana-mainnet-x402-real.json");

const ORIGIN = "https://mcp.example.org";
const HOST = "mcp.example.org";
const BASE_ID = "eip155:8453" as const;
const SOL_ID = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" as const;
const BASE_URL = "https://mainnet.base.org/";
const SOL_URL = "https://api.mainnet-beta.solana.com/";
const APPROVED_URLS = [BASE_URL, SOL_URL];
/** Every RPC hostname the source code knows; none may appear in served text. */
const RPC_HOSTS = ["mainnet.base.org", "sepolia.base.org", "api.mainnet-beta.solana.com", "api.devnet.solana.com"];
const BASE_METHODS = ["eth_chainId", "eth_getTransactionReceipt", "eth_getBlockByHash", "eth_getTransactionByHash"];
const SOL_METHODS = ["getGenesisHash", "getTransaction", "getSignatureStatuses", "getBlock"];
const tagged = (endpoint: "base" | "solana", methods: readonly string[]) => methods.map(m => `${endpoint}:${m}`);
/** One admission = one probe; each probe's first read is the chain identity read. */
const ADMISSION_MARKERS = ["base:eth_chainId", "solana:getGenesisHash"];
const PINNED_AT = EVM.acquiredAt;

const BASE_SUBJECT = { type: "transaction", networkId: BASE_ID, txId: EVM.subject.txHash } as const;
const SOL_SUBJECT = { type: "transaction", networkId: SOL_ID, txId: SOL.subject.signature } as const;

/** Call 1: distinct requestId; execution required, finality desired. */
const DISCOVERY_1 = {
  requestId: "ne_l049_discovery_call_1",
  requirements: { requirements: [
    { capability: "execution", strength: "required" },
    { capability: "finality", strength: "desired" },
  ] },
  subjects: [BASE_SUBJECT, SOL_SUBJECT],
};
/** Call 2: distinct requestId; execution required, finality REQUIRED. */
const DISCOVERY_2 = {
  requestId: "ne_l049_discovery_call_2",
  requirements: { requirements: [
    { capability: "execution", strength: "required" },
    { capability: "finality", strength: "required" },
  ] },
  subjects: [BASE_SUBJECT, SOL_SUBJECT],
};
const EXPECTED_1 = { [BASE_ID]: "conditional", [SOL_ID]: "eligible" };
const EXPECTED_2 = { [BASE_ID]: "ineligible", [SOL_ID]: "eligible" };

/**
 * The caller's preflight: a LITERAL fixed here, before any tool call. The
 * action target is the real Base transaction's own `to` (asserted below).
 * Request and policy ids are caller labels.
 */
const POLICY_CONTENT = {
  id: "caller_policy_l049_execution_finality", version: "1",
  requiredDimensions: ["execution", "finality"] as PolicyDimension[],
};
const POLICY: EvidencePolicy = { ...POLICY_CONTENT, digest: computeEvidencePolicyDigest(POLICY_CONTENT) };
const REQUEST: PreflightRequest = {
  schemaVersion: "0.1", requestId: "ne_l049_caller_preflight_1", networkId: BASE_ID,
  action: { kind: "evm.contract_call", target: "0x4200000000000000000000000000000000000015" },
  evidencePolicy: POLICY,
};
const PREFLIGHT_INPUT = { selectedNetworkId: BASE_ID, probeSubject: BASE_SUBJECT, request: REQUEST };
const PREFLIGHT_INPUT_FIXED = JSON.stringify(PREFLIGHT_INPUT);

const ERAS = [
  { era: "legacy", mode: "legacy" },
  { era: "modern", mode: "auto" },
] as const;
type Era = (typeof ERAS)[number];

/**
 * Strict offline provider for the two fixed mainnet origins. Unknown URL,
 * unrecorded method, or params not exactly equal to the recorded ones: throw
 * (before any read is recorded). Otherwise the recorded resultJson, verbatim.
 */
function provider() {
  const reads: string[] = [];
  const urls = new Set<string>();
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).href;
    const endpoint = url === BASE_URL ? "base" : url === SOL_URL ? "solana" : null;
    if (endpoint === null) throw Error("Unapproved fake endpoint");
    const query = JSON.parse(init?.body as string) as { id: number; method: string; params?: unknown[] };
    const found = (endpoint === "base" ? EVM : SOL).captures.find(c => c.rpcMethod === query.method);
    if (!found) throw Error("Unexpected mock method");
    if (!isDeepStrictEqual(query.params ?? [], found.rpcParams)) throw Error("Unexpected mock params");
    urls.add(url);
    reads.push(`${endpoint}:${query.method}`);
    const response = new Response(`{"jsonrpc":"2.0","id":${JSON.stringify(query.id)},"result":${found.resultJson}}`, {
      status: 200, headers: { "content-type": "application/json" },
    });
    Object.defineProperty(response, "url", { value: url });
    return response;
  };
  return { fetchFn, reads, urls };
}

type Call = (name: string, args: Record<string, unknown>) => Promise<any>;

/** A FRESH hosted loopback server plus ONE client session in an asserted SDK era. Returns every served text. */
async function hostedSession(era: Era, fetchFn: typeof fetch, run: (call: Call, client: Client) => Promise<void>): Promise<string[]> {
  const served: string[] = [];
  const server = await startNeMcpHttpServer({
    host: "127.0.0.1", port: 0, hosted: { publicOrigin: ORIGIN }, liveEvidence: createMultichainTool(fetchFn),
  });
  try {
    const client = new Client({ name: `live-discovery-g2a-eras-${era.era}`, version: "1" }, { versionNegotiation: { mode: era.mode } });
    await client.connect(new StreamableHTTPClientTransport(new URL(ORIGIN + "/mcp"), { fetch: simulatedHostFetch(server.port, HOST) }));
    try {
      expect(client.getProtocolEra(), era.mode).toBe(era.era);
      served.push(JSON.stringify(await client.listTools()));
      await run(async (name, args) => {
        const result = await client.callTool({ name, arguments: args });
        served.push(JSON.stringify(result));
        return result;
      }, client);
    } finally { await client.close(); }
  } finally { await server.close(); }
  return served;
}

function stringsOf(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringsOf(item, out);
  else if (typeof value === "object" && value !== null) for (const item of Object.values(value)) stringsOf(item, out);
  return out;
}

/** Client-side Core check of a served Discovery result in wire form: decode (validates) AND integrity. */
function coreAcceptsWire(wire: unknown): boolean {
  try {
    return verifyDiscoverNetworksResultIntegrity(decodeNecWireJson("discovery-result", JSON.stringify(wire)));
  } catch {
    return false;
  }
}

/** Decode and integrity-check ONE Discovery result on its own; return the Core artifact. */
function checkDiscovery(
  sc: any, input: typeof DISCOVERY_1, expected: Record<string, string>,
): DiscoverNetworksResult {
  expect(sc).toMatchObject({
    schema: LIVE_BEFORE_SCHEMA, observationKind: "live_source_observation",
    builtAndVerifiedBy: "@nec/discovery + @nec/core", generatedAt: PINNED_AT,
  });
  const core = decodeNecWireJson("discovery-result", JSON.stringify(sc.result));
  expect(verifyDiscoverNetworksResultIntegrity(core)).toBe(true);
  expect(coreAcceptsWire(sc.result)).toBe(true);
  expect(core.artifactDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(core.requestId).toBe(input.requestId);
  expect(core.generatedAt).toBe(PINNED_AT);
  expect(core.request.requirements).toEqual(input.requirements.requirements);
  expect(Object.fromEntries(core.matches.map(m => [m.network.networkId, m.classification]))).toEqual(expected);
  expect(Object.fromEntries(sc.candidates.map((c: any) => [c.networkId, c.classification]))).toEqual(expected);
  for (const match of core.matches) {
    const candidate = sc.candidates.find((c: any) => c.networkId === match.network.networkId);
    expect(candidate.snapshotDigest).toBe(match.capabilitySnapshot.digest);
    expect(candidate.observedAt).toBe(PINNED_AT);
  }
  // Base (generic EVM resolver): execution satisfied, finality unsatisfied under either strength.
  const base = core.matches.find(m => m.network.networkId === BASE_ID)!;
  expect(base.evaluations.map(e => [e.requirement.capability, e.status])).toEqual([["execution", "satisfied"], ["finality", "unsatisfied"]]);
  // The served envelope lacks the complete snapshots/manifests: the client cannot run the contextual verifier.
  expect(verifyDiscoverNetworksResult(core, { capabilitySnapshots: [], resolverManifests: [] })).toBe(false);
  return core;
}

const realFetch = globalThis.fetch;
let globalFetchAttempts = 0;
beforeAll(() => {
  globalThis.fetch = (async () => {
    globalFetchAttempts += 1;
    throw new Error("network I/O is forbidden in live-discovery-g2a-eras tests");
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

describe("NE-L049 G2-A conformance (offline replay; closes no gate row)", () => {
  it("pins the real captures, the pinned clock, the strict provider, the fixed preflight literal and the budget arithmetic", async () => {
    expect(EVM.subject.txHash).toBe("0x71c9e27a7195bdecf1c63e73d5f959c96ddb35a27f6f1308835494c3156d625c");
    expect(EVM.source).toMatchObject({ networkId: BASE_ID, chainId: 8453 });
    expect(SOL.subject.signature).toBe("4DYWUMExSrMNxYLjUuH9G8feN4fmYXm4ToCx7gGaAEjJRf2QNrE8LsvoFSGhXwQJrchhgrnGpUFwjxrci9PRLF71");
    expect(SOL.networkId).toBe(SOL_ID);
    expect(PINNED_AT).toBe("2026-10-09T15:42:11.665Z");
    expect(new Date().toISOString()).toBe(PINNED_AT);
    expect(EVM.captures.map(c => c.rpcMethod).sort()).toEqual([...BASE_METHODS].sort());
    expect(SOL.captures.map(c => c.rpcMethod).sort()).toEqual([...SOL_METHODS].sort());

    // The preflight literal: the action target is the real Base transaction's own `to`.
    const to = (JSON.parse(EVM.captures.find(c => c.rpcMethod === "eth_getTransactionByHash")!.resultJson) as { to: string }).to;
    expect(REQUEST.action.target).toBe(to);
    expect(Object.keys(PREFLIGHT_INPUT).sort()).toEqual(["probeSubject", "request", "selectedNetworkId"]);
    expect(PREFLIGHT_INPUT_FIXED).not.toMatch(/eligible|conditional|ne_l049_discovery/);
    // Its only digest is the caller's own EvidencePolicy digest.
    expect(PREFLIGHT_INPUT_FIXED.match(/sha256:[0-9a-f]{64}/g)).toEqual([POLICY.digest]);

    // Distinct calls by construction.
    expect(DISCOVERY_1.requestId).not.toBe(DISCOVERY_2.requestId);
    expect(DISCOVERY_1.requirements).not.toEqual(DISCOVERY_2.requirements);

    // Strict provider: other URL, method or params throw, and nothing is recorded.
    const p = provider();
    const body = (method: string, params: unknown[]) => ({ method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    await expect(p.fetchFn("https://rpc.attacker.example/", body("eth_chainId", []))).rejects.toThrow("Unapproved fake endpoint");
    await expect(p.fetchFn("https://mainnet.base.org/other", body("eth_chainId", []))).rejects.toThrow("Unapproved fake endpoint");
    await expect(p.fetchFn(BASE_URL, body("eth_blockNumber", []))).rejects.toThrow("Unexpected mock method");
    await expect(p.fetchFn(SOL_URL, body("eth_chainId", []))).rejects.toThrow("Unexpected mock method");
    await expect(p.fetchFn(BASE_URL, body("eth_getTransactionReceipt", ["0x" + "0".repeat(64)]))).rejects.toThrow("Unexpected mock params");
    await expect(p.fetchFn(SOL_URL, body("getTransaction", [SOL.subject.signature]))).rejects.toThrow("Unexpected mock params");
    expect(p.reads).toHaveLength(0);
    expect(p.urls.size).toBe(0);

    // Budget: 2 + 2 + 1 admissions per era, below the shared per-minute budget.
    expect(2 + 2 + 1).toBeLessThan(MULTICHAIN_CALLS_PER_MINUTE);
    expect(globalFetchAttempts).toBe(0);
  });

  it("legacy then modern era: two separate Discovery calls, each Core-checked on its own, then a separate fixed-input preflight equal to one from a session that never ran Discovery", async () => {
    for (const era of ERAS) {
      const p = provider();
      let core1!: DiscoverNetworksResult;
      let core2!: DiscoverNetworksResult;
      let chosen: any;
      const served = await hostedSession(era, p.fetchFn, async (call) => {
        // The preflight literal is unchanged before any tool call.
        expect(JSON.stringify(PREFLIGHT_INPUT)).toBe(PREFLIGHT_INPUT_FIXED);
        expect(p.reads).toHaveLength(0);

        // (1) First Discovery call.
        const first = await call(LIVE_BEFORE_TOOL_NAME, DISCOVERY_1);
        expect(first.isError).toBeFalsy();
        expect(p.reads).toEqual([...tagged("base", BASE_METHODS), ...tagged("solana", SOL_METHODS)]);
        // (2) Second, separate Discovery call.
        const second = await call(LIVE_BEFORE_TOOL_NAME, DISCOVERY_2);
        expect(second.isError).toBeFalsy();
        expect(p.reads.slice(8)).toEqual([...tagged("base", BASE_METHODS), ...tagged("solana", SOL_METHODS)]);

        // Each result decoded and integrity-checked by Core independently.
        core1 = checkDiscovery(first.structuredContent, DISCOVERY_1, EXPECTED_1);
        core2 = checkDiscovery(second.structuredContent, DISCOVERY_2, EXPECTED_2);
        expect(core1.artifactDigest).not.toBe(core2.artifactDigest);
        expect(core1.requestId).not.toBe(core2.requestId);
        // Neither result (nor its envelope) references the other. Both probe the
        // same subjects at the same pinned instant, so equal SNAPSHOT digests are
        // expected and are not a cross-reference.
        const text1 = JSON.stringify(first.structuredContent);
        const text2 = JSON.stringify(second.structuredContent);
        expect(text1).not.toContain(core2.artifactDigest);
        expect(text1).not.toContain(core2.requestId);
        expect(text2).not.toContain(core1.artifactDigest);
        expect(text2).not.toContain(core1.requestId);

        // Mutation sensitivity (integrity-level). (a) A flipped classification.
        const flipped = structuredClone(first.structuredContent.result);
        const flippedMatch = flipped.matches.find((m: any) => m.network.networkId === BASE_ID);
        expect(flippedMatch.classification).toBe("conditional");
        flippedMatch.classification = "eligible";
        expect(coreAcceptsWire(flipped)).toBe(false);
        expect(() => decodeNecWireJson("discovery-result", JSON.stringify(flipped))).toThrow();
        expect(verifyDiscoverNetworksResultIntegrity({
          ...core1,
          matches: core1.matches.map(m => m.network.networkId === BASE_ID ? { ...m, classification: "eligible" as const } : m),
        })).toBe(false);
        // (b) Call 1's result relabelled with call 2's requestId.
        const relabelled = { ...structuredClone(first.structuredContent.result), requestId: DISCOVERY_2.requestId };
        expect(coreAcceptsWire(relabelled)).toBe(false);
        expect(() => decodeNecWireJson("discovery-result", JSON.stringify(relabelled))).toThrow();
        expect(verifyDiscoverNetworksResultIntegrity({ ...core1, requestId: core2.requestId })).toBe(false);
        // The unmutated served results still pass.
        expect(coreAcceptsWire(first.structuredContent.result)).toBe(true);
        expect(coreAcceptsWire(second.structuredContent.result)).toBe(true);

        // (3) The preflight literal carries no Discovery digest, snapshot id, request id or class word.
        expect(JSON.stringify(PREFLIGHT_INPUT)).toBe(PREFLIGHT_INPUT_FIXED);
        const markers = [
          ...stringsOf(first.structuredContent), ...stringsOf(second.structuredContent),
        ].filter(s => s.startsWith("sha256:"));
        expect(markers.length).toBeGreaterThan(4);
        for (const sc of [first.structuredContent, second.structuredContent]) {
          for (const c of sc.candidates) markers.push(c.snapshotId as string);
        }
        markers.push(core1.requestId, core2.requestId);
        for (const marker of markers) expect(PREFLIGHT_INPUT_FIXED).not.toContain(marker);
        expect(PREFLIGHT_INPUT_FIXED).not.toMatch(/eligible|conditional/);

        // (4) Separate preflight with the literal.
        chosen = await call(LIVE_PREFLIGHT_TOOL_NAME, JSON.parse(PREFLIGHT_INPUT_FIXED) as Record<string, unknown>);
        expect(chosen.isError).toBeFalsy();
        expect(p.reads.slice(16)).toEqual(tagged("base", BASE_METHODS));
        const out = chosen.structuredContent as any;
        expect(out).toMatchObject({
          schema: "ne-mcp-live-preflight/v0.1", observationKind: "live_source_observation", choiceSource: "caller",
          selectedNetworkId: BASE_ID, probeSubject: BASE_SUBJECT, probeObservedAt: PINNED_AT, verifiedBy: "@nec/core",
        });
        const result = decodeNecWireJson("preflight-result", JSON.stringify(out.preflight));
        const snapshot = decodeNecWireJson("capability-snapshot", JSON.stringify(out.capabilitySnapshot));
        const manifest = decodeNecWireJson("resolver-manifest", JSON.stringify(out.resolverManifest));
        expect(verifyCapabilitySnapshot(snapshot, { resolver: manifest, networkId: BASE_ID })).toBe(true);
        expect(verifyPreflightResult(result, { resolver: manifest, capabilitySnapshot: snapshot })).toBe(true);
        expect(result.request).toEqual(REQUEST);
        expect(result.request.evidencePolicy.digest).toBe(computeEvidencePolicyDigest(POLICY_CONTENT));
        // Native Core status; the generic EVM resolver claims no finality or settlement.
        expect(result.status).toBe("blocked");
        expect(result.evidenceReadiness.finality.status).toBe("not_applicable");
        expect(result.evidenceReadiness.settlement.status).toBe("not_applicable");
        const preText = JSON.stringify(out);
        for (const marker of [core1.artifactDigest, core2.artifactDigest, core1.requestId, core2.requestId]) {
          expect(preText).not.toContain(marker);
        }
      });

      // Budget: exactly 2 + 2 + 1 shared admissions, below the per-minute budget.
      expect(p.reads).toEqual([
        ...tagged("base", BASE_METHODS), ...tagged("solana", SOL_METHODS),
        ...tagged("base", BASE_METHODS), ...tagged("solana", SOL_METHODS),
        ...tagged("base", BASE_METHODS),
      ]);
      const admissions = p.reads.filter(r => ADMISSION_MARKERS.includes(r)).length;
      expect(admissions).toBe(5);
      expect(admissions).toBeLessThan(MULTICHAIN_CALLS_PER_MINUTE);
      for (const url of p.urls) expect(APPROVED_URLS).toContain(url);

      // Separation: a FRESH server and session in the same era that never ran Discovery.
      const fresh = provider();
      let alone: any;
      served.push(...await hostedSession(era, fresh.fetchFn, async (call) => {
        alone = await call(LIVE_PREFLIGHT_TOOL_NAME, JSON.parse(PREFLIGHT_INPUT_FIXED) as Record<string, unknown>);
      }));
      expect(fresh.reads).toEqual(tagged("base", BASE_METHODS));
      expect(alone.isError).toBeFalsy();
      expect(JSON.stringify(alone.structuredContent)).toBe(JSON.stringify(chosen.structuredContent));
      expect(alone.content[0].text).toBe(chosen.content[0].text);
      for (const url of fresh.urls) expect(APPROVED_URLS).toContain(url);

      // No RPC hostname in any served text (tools/list and every tool response, both sessions).
      expect(served.length).toBeGreaterThanOrEqual(6);
      for (const text of served) for (const host of RPC_HOSTS) expect(text).not.toContain(host);
      expect(globalFetchAttempts).toBe(0);
    }
    expect(globalFetchAttempts).toBe(0);
  }, 60_000);
});
