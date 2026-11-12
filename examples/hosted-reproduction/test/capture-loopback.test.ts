/**
 * The capture client against a LOOPBACK hosted-mode server (simulated public
 * Host header, test-only helper). The server's live tools run over a fake
 * provider fetchFn serving checked-in real capture fixtures: Base mainnet and
 * Solana mainnet as before, Base Sepolia and Solana devnet loaded as in
 * packages/mcp/test/live-testnet-parity.test.ts. The ONLY other answers are
 * the SIMULATED nulls for the two made-up SYNTHETIC-SUBJECT hashes (Base
 * mainnet, and the Base Sepolia probe of discover-three-candidates). Global fetch
 * throws. No live network call happens anywhere in this file; the redirect
 * test hands the original fetch to the client against two loopback servers only.
 *
 * Only Date is faked. Each paced sleep advances it by the pacing interval, so
 * every call lands in a fresh shared live budget window, as in a paced live
 * run. The sleep count also attributes each provider read to its call.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMultichainTool, LIVE_MULTICHAIN_NETWORK_IDS, LIVE_MULTICHAIN_TOOL, LIVE_TOOL_NAMES, startNeMcpHttpServer, TOOL_NAMES,
} from "@nec/mcp";
import { stableJsonKey } from "@nec/resolver-solana";

import { LIVE_BEFORE_MAX_OUTPUT_BYTES } from "../../../packages/mcp/src/live-before.js";
import { LIVE_TOOL_DEADLINE_MS, MULTICHAIN_CALLS_PER_MINUTE, MULTICHAIN_MAX_INFLIGHT } from "../../../packages/mcp/src/live-multichain.js";
import { simulatedHostFetch } from "../../../packages/mcp/test/helpers.js";
import {
  assertCaptureTarget, assessCaptureOutcomes, CAPTURE_CALLS, CAPTURE_CLIENT, captureHostedEnvelopes, classifyCallOutcome,
  EXPECTED_OUTCOMES, MIN_PACING_SECONDS, parseCaptureArgs, PINNED_BASE_MAINNET_TX, PINNED_BASE_SEPOLIA_TX, PINNED_SOLANA_DEVNET_SIGNATURE,
  PINNED_SOLANA_MAINNET_SIGNATURE, PROBE_ACTION_TARGET, PROBE_REQUEST_LABEL, resolvePacingSeconds, SDK_SCHEMA_REFUSAL_CODE,
  SYNTHETIC_BASE_MAINNET_TX, SYNTHETIC_BASE_SEPOLIA_TX, writeCapture,
} from "../capture-hosted.js";
import type { CallOutcomeKind, CaptureEra, HostedCapture } from "../capture-hosted.js";
import { reproduceObservationEnvelope } from "../reproduce.js";
import { main as verifyLiveBeforeCli, verifyLiveDiscoveryEnvelope, verifyLivePreflightEnvelope } from "../verify-live-before.js";

const origin = "https://mcp.example.org";
const host = "mcp.example.org";
const BASE = "https://mainnet.base.org";
const SOLANA = "https://api.mainnet-beta.solana.com";
const BASE_SEPOLIA = "https://sepolia.base.org";
const SOLANA_DEVNET = "https://api.devnet.solana.com";
const SOURCES: readonly string[] = [BASE, SOLANA, BASE_SEPOLIA, SOLANA_DEVNET];
const SOL_ID = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const DEVNET_ID = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const EVM_METHODS = ["eth_chainId", "eth_getTransactionReceipt", "eth_getBlockByHash", "eth_getTransactionByHash"];
const SOL_METHODS = ["getGenesisHash", "getTransaction", "getSignatureStatuses", "getBlock"];

type Capture = { rpcMethod: string; rpcParams: unknown[]; resultJson: string };
const load = <T = { captures: Capture[] }>(path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as T;
const EVM = load("../../../packages/mcp/test/fixtures/base-mainnet-l2-finalized-positive-evm.json");
const SEPOLIA = load<{ subject: { txHash: string }; captures: Capture[] }>(
  "../../../packages/adapter-erc4337/test/fixtures/base-sepolia-external-v06-userop.json");
const DEVNET = load<{ subject: { signature: string }; captures: Capture[] }>(
  "../../../packages/resolver-solana/test/fixtures/solana-devnet-before-probe.json");
const fixtures: [string, Capture[]][] = [
  [BASE, EVM.captures],
  [BASE, load("../../../packages/mcp/test/fixtures/base-mainnet-l2-finalized-positive-opstack.json").captures
    .filter((c) => c.rpcMethod === "eth_getBlockByNumber")],
  [SOLANA, load("../../../packages/resolver-solana/test/fixtures/solana-mainnet-x402-real.json").captures],
  [BASE_SEPOLIA, SEPOLIA.captures],
  [SOLANA_DEVNET, DEVNET.captures],
  // SIMULATED (the last two entries): each made-up SYNTHETIC-SUBJECT hash is answered as not found.
  [BASE, ["eth_getTransactionReceipt", "eth_getTransactionByHash"].map((rpcMethod) => ({
    rpcMethod, rpcParams: [SYNTHETIC_BASE_MAINNET_TX], resultJson: "null",
  }))],
  [BASE_SEPOLIA, ["eth_getTransactionReceipt", "eth_getTransactionByHash"].map((rpcMethod) => ({
    rpcMethod, rpcParams: [SYNTHETIC_BASE_SEPOLIA_TX], resultJson: "null",
  }))],
];
const REAL_FIXTURES = fixtures.slice(0, -2);

/** Every checked-in *.json under a `fixtures` directory of packages/ or examples/ (no symlinks, no node_modules). */
function checkedInFixtureFiles(): URL[] {
  const files: URL[] = [];
  const walk = (dir: URL, inFixtures: boolean) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== "node_modules" && !entry.name.startsWith(".")) {
        walk(new URL(`${entry.name}/`, dir), inFixtures || entry.name === "fixtures");
      } else if (entry.isFile() && inFixtures && entry.name.endsWith(".json")) {
        files.push(new URL(entry.name, dir));
      }
    }
  };
  for (const root of ["packages/", "examples/"]) walk(new URL(`../../../${root}`, import.meta.url), false);
  return files;
}

/** Same exact-lookup fake provider as reproduce.test.ts (raw resultJson bytes; throws on anything else). */
function fakeProvider(
  onRead: (method: string) => void = () => {},
  onAnswer: (source: string, method: string, params: unknown[], result: string) => void = () => {},
): typeof fetch {
  const queues = new Map<string, string[]>();
  for (const [source, captures] of fixtures) {
    for (const c of captures) {
      const key = `${source} ${c.rpcMethod} ${stableJsonKey(c.rpcParams)}`;
      queues.set(key, [...(queues.get(key) ?? []), c.resultJson]);
    }
  }
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const source = new URL(url).origin;
    if (!SOURCES.includes(source)) throw new Error("Unexpected outbound destination");
    const q = JSON.parse(init?.body as string) as { id: unknown; method: string; params?: unknown[] };
    onRead(q.method);
    const queue = queues.get(`${source} ${q.method} ${stableJsonKey(q.params ?? [])}`);
    if (queue === undefined || queue.length === 0) throw new Error(`Unexpected request: ${q.method}`);
    const result = queue.length > 1 ? queue.shift()! : queue[0]!;
    onAnswer(source, q.method, q.params ?? [], result);
    const response = new Response(`{"jsonrpc":"2.0","id":${JSON.stringify(q.id)},"result":${result}}`, {
      status: 200, headers: { "content-type": "application/json" },
    });
    Object.defineProperty(response, "url", { value: new URL(url).href });
    return response;
  };
}

async function withHostedServer<T>(provider: typeof fetch, fn: (port: number) => Promise<T>): Promise<T> {
  const server = await startNeMcpHttpServer({
    host: "127.0.0.1", port: 0, hosted: { publicOrigin: origin }, liveEvidence: createMultichainTool(provider),
  });
  try { return await fn(server.port); } finally { await server.close(); }
}

/** A paced sleep that advances the faked Date; reads are attributed to the call index (= sleeps so far). */
function pacedRun() {
  const sleeps: number[] = [];
  const reads: { call: number; method: string }[] = [];
  const answers: { call: number; source: string; method: string; params: unknown[]; result: string }[] = [];
  const indexOf = (id: string) => CAPTURE_CALLS.findIndex((c) => c.id === id);
  return {
    sleeps, reads,
    provider: fakeProvider(
      (method) => reads.push({ call: sleeps.length, method }),
      (source, method, params, result) => answers.push({ call: sleeps.length, source, method, params, result }),
    ),
    sleep: async (ms: number) => { sleeps.push(ms); vi.setSystemTime(Date.now() + ms); },
    readsOf: (id: string) => reads.filter((r) => r.call === indexOf(id)).map((r) => r.method),
    answersOf: (id: string) => answers.filter((a) => a.call === indexOf(id))
      .map((a) => ({ source: a.source, method: a.method, params: a.params, result: a.result })),
  };
}

const realFetch = globalThis.fetch;
let globalFetchAttempts = 0;
beforeAll(() => {
  globalThis.fetch = (async () => {
    globalFetchAttempts += 1;
    throw new Error("global fetch is denied in hosted-reproduction tests");
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});
// Only Date is faked; setTimeout, AbortSignal.timeout and HTTP stay real.
beforeEach(() => {
  const start = Date.now();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(start);
});
afterEach(() => {
  vi.useRealTimers();
});

const liveToolNames: readonly string[] = LIVE_TOOL_NAMES.filter((name) => !(TOOL_NAMES as readonly string[]).includes(name));

/** Loopback outcome of every call (real fixtures; SIMULATED only for the synthetic subject). */
const LOOPBACK_OUTCOMES: Readonly<Record<string, readonly [CallOutcomeKind, string | null]>> = {
  "profiles": ["observed", null],
  "base-mainnet-pinned": ["observed", null],
  "base-mainnet-pinned-l2-finality": ["observed", null],
  "solana-mainnet-pinned": ["observed", null],
  "base-sepolia-pinned": ["observed", null],
  "solana-devnet-pinned": ["observed", null],
  "discover-mainnet": ["observed", null],
  "discover-testnet": ["observed", null],
  "discover-three-candidates": ["observed", null],
  "preflight-base-mainnet-probe": ["observed", null],
  "refuse-unsupported-network": ["input_refusal", SDK_SCHEMA_REFUSAL_CODE],
  "refuse-malformed-solana-signature": ["input_refusal", "MCP_MULTICHAIN_INPUT"],
  "refuse-l2-finality-on-solana": ["input_refusal", "MCP_MULTICHAIN_INPUT"],
  "synthetic-base-mainnet-subject": ["observed_insufficient", null],
};
const REFUSED_IDS = ["refuse-unsupported-network", "refuse-malformed-solana-signature", "refuse-l2-finality-on-solana"];
/**
 * JSON-RPC methods POSTed to /mcp before the first tools/call, unpaced: the legacy
 * tools/list client, the modern tools/list client, then the call client's handshake.
 */
const PRE_CALL_POSTS: Readonly<Record<CaptureEra, readonly string[]>> = {
  modern: ["initialize", "notifications/initialized", "tools/list", "server/discover", "tools/list", "server/discover"],
  legacy: ["initialize", "notifications/initialized", "tools/list", "server/discover", "tools/list", "initialize", "notifications/initialized"],
};

describe("capture-hosted MCP client (loopback only)", () => {
  it("pins the call list, its subjects and the frozen EXPECTED_OUTCOMES", () => {
    expect(CAPTURE_CLIENT.version).toBe("0.3.0");
    expect(PINNED_BASE_SEPOLIA_TX).toBe(SEPOLIA.subject.txHash);
    expect(PINNED_SOLANA_DEVNET_SIGNATURE).toBe(DEVNET.subject.signature);
    const tx = JSON.parse(EVM.captures.find((c) => c.rpcMethod === "eth_getTransactionByHash")!.resultJson) as { to: string };
    expect(PROBE_ACTION_TARGET).toBe(tx.to);
    // The made-up hashes appear in no real fixture; only the SIMULATED entries (last two) carry them.
    for (const [, captures] of REAL_FIXTURES) {
      for (const c of captures) {
        expect(JSON.stringify(c)).not.toContain(SYNTHETIC_BASE_MAINNET_TX.slice(2));
        expect(JSON.stringify(c)).not.toContain(SYNTHETIC_BASE_SEPOLIA_TX.slice(2));
      }
    }
    // The Base Sepolia synthetic hash: well formed, its own pattern, no pinned subject, in no checked-in fixture.
    expect(SYNTHETIC_BASE_SEPOLIA_TX).toMatch(/^0x[0-9a-f]{64}$/);
    expect(SYNTHETIC_BASE_SEPOLIA_TX.slice(2, 10)).not.toBe(SYNTHETIC_BASE_MAINNET_TX.slice(2, 10));
    for (const pinned of [
      SYNTHETIC_BASE_MAINNET_TX, PINNED_BASE_MAINNET_TX, PINNED_BASE_SEPOLIA_TX, PINNED_SOLANA_MAINNET_SIGNATURE, PINNED_SOLANA_DEVNET_SIGNATURE,
    ]) {
      expect(pinned).not.toContain(SYNTHETIC_BASE_SEPOLIA_TX.slice(2, 10));
    }
    const fixtureFiles = checkedInFixtureFiles();
    expect(fixtureFiles.length).toBeGreaterThan(REAL_FIXTURES.length);
    for (const file of fixtureFiles) {
      expect([file.href, readFileSync(file, "utf8").toLowerCase().includes(SYNTHETIC_BASE_SEPOLIA_TX.slice(2))]).toEqual([file.href, false]);
    }

    const ids = CAPTURE_CALLS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(Object.keys(EXPECTED_OUTCOMES).sort()).toEqual([...ids].sort());
    expect(Object.keys(LOOPBACK_OUTCOMES).sort()).toEqual([...ids].sort());
    expect(Object.isFrozen(EXPECTED_OUTCOMES) && Object.values(EXPECTED_OUTCOMES).every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(CAPTURE_CALLS)).toBe(true);
    for (const allowed of Object.values(EXPECTED_OUTCOMES)) {
      expect(allowed).not.toContain("observed_contradicted");
      expect(allowed).not.toContain("unclassified");
    }
    for (const id of REFUSED_IDS) expect(EXPECTED_OUTCOMES[id]).toEqual(["input_refusal"]);
    // Testnet: observed OR a typed pruned/source failure; never contradicted.
    for (const id of ["base-sepolia-pinned", "solana-devnet-pinned"]) {
      expect([...EXPECTED_OUTCOMES[id]!].sort()).toEqual(["observed", "observed_insufficient", "source_failure"]);
    }
    expect([...EXPECTED_OUTCOMES["discover-testnet"]!].sort()).toEqual(["observed", "source_failure"]);
    expect(EXPECTED_OUTCOMES["discover-three-candidates"]).toEqual(["observed", "source_failure"]);
    // A made-up subject is never "observed" and never contradicted.
    expect([...EXPECTED_OUTCOMES["synthetic-base-mainnet-subject"]!].sort()).toEqual(["observed_insufficient", "source_failure"]);

    const preflight = CAPTURE_CALLS.find((c) => c.id === "preflight-base-mainnet-probe")!;
    expect(preflight.label).toEqual({ live: PROBE_REQUEST_LABEL, loopback: PROBE_REQUEST_LABEL });
    expect(preflight.arguments).toMatchObject({
      selectedNetworkId: "eip155:8453",
      probeSubject: { networkId: "eip155:8453" },
      request: { networkId: "eip155:8453", metadata: { probeLabel: PROBE_REQUEST_LABEL } },
    });
    expect(PROBE_REQUEST_LABEL).toBe("capture-client-authored probe, no action executed, not the NEW-exact-action item");
    const synthetic = CAPTURE_CALLS.find((c) => c.id === "synthetic-base-mainnet-subject")!;
    expect(synthetic.label?.live).toMatch(/^SYNTHETIC-SUBJECT/);
    expect(synthetic.label?.loopback).toMatch(/^SIMULATED/);

    // One three-subject Discovery call: same REQUIREMENTS, the pinned mainnet subjects plus the Base Sepolia synthetic.
    const mainnet = CAPTURE_CALLS.find((c) => c.id === "discover-mainnet")!;
    const three = CAPTURE_CALLS.find((c) => c.id === "discover-three-candidates")!;
    expect(CAPTURE_CALLS).toHaveLength(14);
    expect(three.tool).toBe("discover_live_network_evidence");
    expect(three.arguments.requirements).toEqual(mainnet.arguments.requirements);
    expect(three.arguments.subjects).toEqual([
      ...(mainnet.arguments.subjects as unknown[]),
      { type: "transaction", networkId: "eip155:84532", txId: SYNTHETIC_BASE_SEPOLIA_TX },
    ]);
    expect(three.label?.live).toMatch(/^SYNTHETIC-SUBJECT/);
    expect(three.label?.live).toContain("not-found is not proof of nonexistence or of network unavailability");
    expect(three.label?.loopback).toMatch(/^SIMULATED/);
  });

  it("captures the full call list in both eras; outcomes are expected, resolve envelopes reproduce, BEFORE envelopes verify", async () => {
    // The default loopback pacing stays 0; this test opts into live pacing to drive the faked clock.
    expect(resolvePacingSeconds(assertCaptureTarget("http://127.0.0.1:4178/mcp"))).toBe(0);
    // The three-subject call runs under unchanged budgets, deadline and output bound.
    expect({ MULTICHAIN_CALLS_PER_MINUTE, MULTICHAIN_MAX_INFLIGHT, LIVE_TOOL_DEADLINE_MS, LIVE_BEFORE_MAX_OUTPUT_BYTES }).toEqual({
      MULTICHAIN_CALLS_PER_MINUTE: 8, MULTICHAIN_MAX_INFLIGHT: 2, LIVE_TOOL_DEADLINE_MS: 35_000, LIVE_BEFORE_MAX_OUTPUT_BYTES: 180_000,
    });
    for (const era of ["legacy", "modern"] as const) {
      const run = pacedRun();
      const capture = await withHostedServer(run.provider, (port) => captureHostedEnvelopes({
        url: `http://127.0.0.1:${port}/mcp`, era, pacingSeconds: MIN_PACING_SECONDS,
        fetch: simulatedHostFetch(port, host),
        sleep: run.sleep,
      }));
      expect(capture).toMatchObject({
        schema: "ne-hosted-capture/v0.1", loopback: true, pacingSeconds: 75, callEra: era, acquiringExecutable: null,
        client: { name: "ne-hosted-capture", version: "0.3.0" },
      });
      expect(run.sleeps).toEqual(Array(CAPTURE_CALLS.length - 1).fill(75_000));
      expect(run.sleeps).toEqual(Array(13).fill(75_000));

      expect(capture.toolsList.map((t) => t.era)).toEqual(["legacy", "modern"]);
      expect(liveToolNames).toHaveLength(3);
      for (const listed of capture.toolsList) {
        const tools = listed.tools as { name: string; annotations?: Record<string, unknown>; inputSchema?: unknown }[];
        expect(tools).toHaveLength(6);
        expect(tools.map((t) => t.name).sort()).toEqual([...LIVE_TOOL_NAMES].sort());
        for (const tool of tools) {
          expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: liveToolNames.includes(tool.name) });
        }
        // No Tanenbaum: the live AFTER tool accepts exactly the four live networks.
        const schema = JSON.stringify(tools.find((t) => t.name === LIVE_MULTICHAIN_TOOL)?.inputSchema);
        for (const networkId of LIVE_MULTICHAIN_NETWORK_IDS) expect(schema).toContain(networkId);
        expect(schema).not.toContain("eip155:57057");
      }

      // Every call: exactly one typed outcome, inside EXPECTED_OUTCOMES.
      expect(capture.calls.map((c) => c.id)).toEqual(CAPTURE_CALLS.map((c) => c.id));
      const outcomes = Object.fromEntries(capture.calls.map((c) => {
        const o = classifyCallOutcome(c);
        return [c.id, [o.kind, o.code]];
      }));
      expect(outcomes).toEqual(LOOPBACK_OUTCOMES);
      expect(assessCaptureOutcomes(capture.calls).filter((a) => !a.expected)).toEqual([]);
      const byId = new Map(capture.calls.map((c) => [c.id, c]));
      const profiles = (byId.get("profiles")?.structuredContent as { profiles: { family: string; networkId: string }[] }).profiles;
      expect(profiles.map((p) => p.family)).toEqual(["opstack", "opstack", "solana", "solana"]);
      expect(profiles.map((p) => p.networkId)).not.toContain("eip155:57057");

      // Refused inputs (and the offline profiles tool) make zero provider calls.
      for (const id of ["profiles", ...REFUSED_IDS]) expect(run.readsOf(id)).toEqual([]);
      for (const id of REFUSED_IDS) expect(byId.get(id)?.structuredContent).toBeNull();
      expect(run.readsOf("base-mainnet-pinned")).toEqual(EVM_METHODS);
      expect(run.readsOf("base-mainnet-pinned-l2-finality").slice(0, 4)).toEqual(EVM_METHODS);
      expect(run.readsOf("solana-mainnet-pinned")).toEqual(SOL_METHODS);
      expect(run.readsOf("base-sepolia-pinned")).toEqual(EVM_METHODS);
      expect(run.readsOf("solana-devnet-pinned")).toEqual(SOL_METHODS);
      expect(run.readsOf("discover-mainnet")).toEqual([...EVM_METHODS, ...SOL_METHODS]);
      expect(run.readsOf("discover-testnet")).toEqual([...EVM_METHODS, ...SOL_METHODS]);
      // The three-subject call: EVM 4 + Solana 4 + Base Sepolia eth_chainId/receipt/tx = 11 reads.
      const threeReads = run.readsOf("discover-three-candidates");
      expect(threeReads).toEqual([...EVM_METHODS, ...SOL_METHODS, "eth_chainId", "eth_getTransactionReceipt", "eth_getTransactionByHash"]);
      expect(threeReads).toHaveLength(11);
      // Base Sepolia: the real fixture eth_chainId bytes; the synthetic hash is answered null (SIMULATED).
      const sepoliaChainId = SEPOLIA.captures.find((c) => c.rpcMethod === "eth_chainId")!;
      expect(sepoliaChainId).toMatchObject({ rpcParams: [], resultJson: "\"0x14a34\"" });
      expect(run.answersOf("discover-three-candidates").filter((a) => a.source === BASE_SEPOLIA)).toEqual([
        { source: BASE_SEPOLIA, method: "eth_chainId", params: [], result: sepoliaChainId.resultJson },
        { source: BASE_SEPOLIA, method: "eth_getTransactionReceipt", params: [SYNTHETIC_BASE_SEPOLIA_TX], result: "null" },
        { source: BASE_SEPOLIA, method: "eth_getTransactionByHash", params: [SYNTHETIC_BASE_SEPOLIA_TX], result: "null" },
      ]);
      // The synthetic hash is answered only by the three-subject call.
      for (const call of CAPTURE_CALLS.filter((c) => c.id !== "discover-three-candidates")) {
        expect(JSON.stringify(run.answersOf(call.id))).not.toContain(SYNTHETIC_BASE_SEPOLIA_TX);
      }
      expect(run.readsOf("preflight-base-mainnet-probe")).toEqual(EVM_METHODS);
      expect(run.readsOf("synthetic-base-mainnet-subject")).toEqual(["eth_chainId", "eth_getTransactionReceipt", "eth_getTransactionByHash"]);

      // Resolve envelopes reproduce byte-identically; the OP Stack supplement never does.
      const resolved = capture.calls.filter((c) => c.tool === LIVE_MULTICHAIN_TOOL && !c.isError);
      expect(resolved.map((c) => c.id)).toEqual([
        "base-mainnet-pinned", "base-mainnet-pinned-l2-finality", "solana-mainnet-pinned",
        "base-sepolia-pinned", "solana-devnet-pinned", "synthetic-base-mainnet-subject",
      ]);
      for (const call of resolved) {
        const report = await reproduceObservationEnvelope(call.structuredContent);
        expect(report).toMatchObject({ status: "reproduced", reason: "byte_identical" });
        expect(report.hostedFragmentDigest).toBe(report.reproducedFragmentDigest);
        if (call.id === "base-mainnet-pinned-l2-finality") {
          expect(report.opStackSupplement).toMatchObject({
            status: "not_reproducible", withdrawalFinalization: "not_evaluated", ethereumSettlement: "not_evaluated",
          });
        } else {
          expect(report).not.toHaveProperty("opStackSupplement");
        }
      }
      // The made-up subject: insufficient, never contradicted, labelled SIMULATED on loopback.
      const synthetic = byId.get("synthetic-base-mainnet-subject")!;
      expect(synthetic.label).toMatch(/^SIMULATED/);
      const syntheticEvidence = (synthetic.structuredContent as any).fragment.networkEvidence;
      expect(syntheticEvidence.execution.verdict).toBe("insufficient");
      for (const dimension of Object.values(syntheticEvidence) as any[]) expect(dimension.verdict).not.toBe("contradicted");

      // BEFORE/Discovery envelopes verify; Core context is never reported as verified.
      for (const [id, expected] of [
        ["discover-mainnet", [["eip155:8453", "conditional"], [SOL_ID, "eligible"]]],
        ["discover-testnet", [["eip155:84532", "conditional"], [DEVNET_ID, "eligible"]]],
        ["discover-three-candidates", [["eip155:8453", "conditional"], ["eip155:84532", "ineligible"], [SOL_ID, "eligible"]]],
      ] as const) {
        const call = byId.get(id)!;
        const report = verifyLiveDiscoveryEnvelope(call.structuredContent, { expected: call.arguments });
        expect(report).toMatchObject({ status: "verified", reason: "envelope_verified", contextualVerification: "context_not_returned" });
        expect(report.candidates.map((c) => [c.networkId, c.classification])).toEqual(expected);
        expect(report.candidates.every((c) => c.observationAgeMs === 0)).toBe(true);
      }
      // The three-class call is labelled SIMULATED on loopback; its synthetic Base Sepolia path is ineligible, never observed.
      const three = byId.get("discover-three-candidates")!;
      expect(three.label).toMatch(/^SIMULATED/);
      const absent = (three.structuredContent as any).candidates.find((c: any) => c.networkId === "eip155:84532");
      expect(absent.capabilities.execution.availability).toBe("unavailable");
      expect(JSON.stringify(absent.evidenceCaptures)).not.toContain(SYNTHETIC_BASE_SEPOLIA_TX.slice(2));
      // The separate preflight on the caller's explicit choice verifies against its returned context.
      const preflight = byId.get("preflight-base-mainnet-probe")!;
      expect(preflight.label).toBe(PROBE_REQUEST_LABEL);
      expect(preflight.structuredContent).toMatchObject({
        choiceSource: "caller", selectedNetworkId: "eip155:8453",
        preflight: { request: { metadata: { probeLabel: PROBE_REQUEST_LABEL } } },
      });
      expect(verifyLivePreflightEnvelope(preflight.structuredContent, { expected: preflight.arguments })).toMatchObject({
        status: "verified", reason: "envelope_verified", contextualVerification: "returned_context_verified",
        selectedNetworkId: "eip155:8453", preflightStatus: "blocked",
      });

      if (era === "modern") {
        const dir = mkdtempSync(join(tmpdir(), "ne-hosted-capture-"));
        try {
          const out = join(dir, "capture.json");
          writeCapture(out, capture);
          const written = JSON.parse(readFileSync(out, "utf8")) as HostedCapture;
          expect(written).toEqual(JSON.parse(JSON.stringify(capture)));
          expect((await reproduceObservationEnvelope(written.calls[1]?.structuredContent)).status).toBe("reproduced");
          expect(assessCaptureOutcomes(written.calls).every((a) => a.expected)).toBe(true);
          // The all-verified capture passes the verifier CLI's exit rule.
          const printed: string[] = [];
          const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
            printed.push(String(chunk));
            return true;
          });
          try {
            expect(await verifyLiveBeforeCli(["--capture", out])).toBe(0);
            expect((JSON.parse(printed.join("")) as { classCoverage: unknown }).classCoverage).toEqual({
              callId: "discover-three-candidates", required: ["conditional", "eligible", "ineligible"],
              observed: [
                { networkId: "eip155:8453", classification: "conditional" }, { networkId: "eip155:84532", classification: "ineligible" },
                { networkId: SOL_ID, classification: "eligible" },
              ],
              met: true,
            });
            // A genuine testnet discovery filed under the mainnet id (with its testnet arguments) does not count.
            const relabelled = join(dir, "relabelled.json");
            writeCapture(relabelled, {
              ...capture,
              calls: capture.calls.filter((c) => c.id !== "discover-mainnet")
                .map((c) => (c.id === "discover-testnet" ? { ...c, id: "discover-mainnet" } : c)),
            });
            printed.length = 0;
            expect(await verifyLiveBeforeCli(["--capture", relabelled])).toBe(1);
            const report = JSON.parse(printed.join("")) as { missingVerified: string[]; reports: { id: string; report: { reason: string } }[] };
            expect(report.missingVerified).toEqual(["discover-mainnet"]);
            expect(report.reports.find((r) => r.id === "discover-mainnet")?.report.reason).toBe("request_binding_mismatch");
          } finally {
            write.mockRestore();
          }
          expect(() => writeCapture(out, capture)).toThrow();
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
    expect(globalFetchAttempts).toBe(0);
  }, 120_000);

  it("enforces >= 75 s pacing between calls for a non-loopback https target", async () => {
    const run = pacedRun();
    const capture = await withHostedServer(run.provider, (port) => captureHostedEnvelopes({
      url: `${origin}/mcp`,
      era: "legacy",
      fetch: simulatedHostFetch(port, host), // test-only: the https name is routed to loopback
      sleep: run.sleep,
    }));
    expect(MIN_PACING_SECONDS).toBe(75);
    expect(capture).toMatchObject({ loopback: false, pacingSeconds: 75, callEra: "legacy" });
    expect(run.sleeps).toEqual(Array(CAPTURE_CALLS.length - 1).fill(75_000));
    // The non-loopback label of the made-up subject.
    expect(capture.calls.find((c) => c.id === "synthetic-base-mainnet-subject")?.label).toMatch(/^SYNTHETIC-SUBJECT/);
    expect(capture.calls.find((c) => c.id === "discover-three-candidates")?.label).toMatch(/^SYNTHETIC-SUBJECT/);
    expect(assessCaptureOutcomes(capture.calls).filter((a) => !a.expected)).toEqual([]);
    expect(globalFetchAttempts).toBe(0);
  }, 60_000);

  it("refuses unsafe targets and pacing before any request", async () => {
    let requests = 0;
    const spy: typeof fetch = async () => {
      requests += 1;
      throw new Error("must not be called");
    };
    for (const options of [
      { url: `${origin}/mcp`, pacingSeconds: 74 },
      { url: "http://mcp.example.org/mcp" },
      { url: "ftp://127.0.0.1/mcp" },
      { url: "https://user:secret@mcp.example.org/mcp" },
      { url: "" },
    ]) {
      await expect(captureHostedEnvelopes({ ...options, fetch: spy })).rejects.toThrow();
    }
    expect(requests).toBe(0);

    const out = ["--out", "capture.json"];
    expect(() => parseCaptureArgs(out)).toThrow("--url is required");
    expect(() => parseCaptureArgs(["--url", `${origin}/mcp`])).toThrow("--out is required");
    expect(() => parseCaptureArgs(["--url", "http://mcp.example.org/mcp", ...out])).toThrow();
    expect(() => parseCaptureArgs(["--url", `${origin}/mcp`, "--pacing-seconds", "10", ...out])).toThrow(">= 75");
    expect(() => parseCaptureArgs(["--url", `${origin}/mcp`, "--method", "eth_sendRawTransaction", ...out])).toThrow("unknown argument");
    expect(() => parseCaptureArgs(["--url", `${origin}/mcp`, "--era", "future", ...out])).toThrow();
    expect(() => parseCaptureArgs(["--url", `${origin}/mcp`, "--acquiring-sha", "main", ...out])).toThrow();
    expect(parseCaptureArgs(["--url", `${origin}/mcp`, ...out])).toEqual({
      url: `${origin}/mcp`, out: "capture.json", pacingSeconds: 75, era: "modern",
    });
    expect(parseCaptureArgs(["--url", "http://127.0.0.1:4178/mcp", "--era", "legacy", "--acquiring-sha", "a".repeat(40), ...out])).toEqual({
      url: "http://127.0.0.1:4178/mcp", out: "capture.json", pacingSeconds: 0, era: "legacy", acquiringExecutableSha: "a".repeat(40),
    });
    expect(globalFetchAttempts).toBe(0);
  });

  it("pins the HTTP ingress POSTs sent before the first tools/call to the README's count", async () => {
    for (const era of ["modern", "legacy"] as const) {
      const posts: string[] = [];
      let reachedToolsCall = false;
      await withHostedServer(fakeProvider(), async (port) => {
        const inner = simulatedHostFetch(port, host);
        const counting: typeof fetch = async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          if (init?.method === "POST" && url.pathname === "/mcp") {
            const method = (JSON.parse(String(init.body)) as { method?: unknown }).method;
            if (method === "tools/call") {
              reachedToolsCall = true;
              throw new Error("stopped at the first tools/call");
            }
            posts.push(String(method));
          }
          return inner(input, init);
        };
        await expect(captureHostedEnvelopes({ url: `http://127.0.0.1:${port}/mcp`, era, fetch: counting })).rejects.toThrow();
      });
      expect(reachedToolsCall).toBe(true);
      expect([era, posts]).toEqual([era, PRE_CALL_POSTS[era]]);
    }
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const modern = PRE_CALL_POSTS.modern.length;
    const legacy = PRE_CALL_POSTS.legacy.length;
    expect(readme).toContain(
      `| HTTP ingress POSTs to \`/mcp\` before the first \`tools/call\` | ${modern} (\`--era modern\`), ${legacy} (\`--era legacy\`) |`);
    expect(readme).toContain(
      `| Minimum HTTP ingress quota a target must allow | ${modern + 1}/min (\`--era modern\`), ${legacy + 1}/min (\`--era legacy\`) |`);
    expect(globalFetchAttempts).toBe(0);
  }, 60_000);

  it("never follows a redirect off the --url target", async () => {
    const servers: Server[] = [];
    const listen = async (handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<number> => {
      const server = createServer(handler);
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      return (server.address() as AddressInfo).port;
    };
    let onTarget = 0;
    let offTarget = 0;
    const secondPort = await listen((req, res) => {
      offTarget += 1;
      req.resume();
      res.writeHead(500).end();
    });
    const firstPort = await listen((req, res) => {
      onTarget += 1;
      req.resume();
      res.writeHead(307, { location: `http://127.0.0.1:${secondPort}/mcp` }).end();
    });
    const url = `http://127.0.0.1:${firstPort}/mcp`;
    try {
      // Control: an unguarded fetch follows the 307 to the second server.
      const naive = await realFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      await naive.body?.cancel();
      expect([naive.status, onTarget, offTarget]).toEqual([500, 1, 1]);
      onTarget = 0;
      offTarget = 0;
      // The capture client, handed the same fetch, reaches --url and fails closed at its redirect.
      await expect(captureHostedEnvelopes({ url, fetch: realFetch })).rejects.toThrow();
      expect(onTarget).toBeGreaterThanOrEqual(1);
      expect(offTarget).toBe(0);
    } finally {
      for (const server of servers) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
    expect(globalFetchAttempts).toBe(0);
  });
});
