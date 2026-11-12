/**
 * NE-L028: ONE discover_live_network_evidence call over three distinct exact
 * probe subjects yields ONE Core-verified discovery-result whose three
 * candidates carry the three Core classifications (eligible, conditional,
 * ineligible). Offline replay: an in-process fake provider; global fetch throws.
 *
 * Provider bytes:
 * - Base mainnet: the REAL historical-compat "F1" authority capture (x402 #1062
 *   USDC transfer 0x8e01…e696), every answer verbatim for the exact recorded params.
 * - Solana mainnet: the REAL "F3" source capture (resolver-solana
 *   solana-mainnet-x402-real.json, 4DYWUMEx…LF71), verbatim for the exact recorded params.
 * - Base Sepolia: a TEST-ONLY ABSENT probe. Its subject hash ABSENT_TX is
 *   synthetic and is NOT a transaction observed anywhere. Only the eth_chainId
 *   answer is real (adapter-erc4337 base-sepolia-external-v06-userop.json,
 *   "0x14a34"); the receipt and transaction lookups for ABSENT_TX answer JSON
 *   null. It claims neither that such a transaction occurred, nor that it never
 *   existed, nor that Base Sepolia or its source is unavailable.
 * Every other answer is a SIMULATED mutation, named in the test title.
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { decodeNecWireJson } from "@nec/core";
import { startNeMcpHttpServer } from "../src/http.js";
import { HOSTED_DEFAULT_LIMITS } from "../src/limits.js";
import { LIVE_EVM_MAX_CALLS_PER_MINUTE, LIVE_EVM_MAX_RPC_BYTES, LIVE_EVM_RPC_TIMEOUT_MS } from "../src/live-evm.js";
import {
  createMultichainTool, LIVE_TOOL_DEADLINE_MS, MULTICHAIN_CALLS_PER_MINUTE, MULTICHAIN_MAX_INFLIGHT, MULTICHAIN_RESULT_MAX_BYTES,
} from "../src/live-multichain.js";
import type { LiveCall, MultichainObservation, MultichainTool } from "../src/live-multichain.js";
import { SOLANA_READ_TIMEOUT_MS, SOLANA_RESPONSE_MAX_BYTES } from "../src/live-solana.js";
import {
  createLiveBeforeTool, LIVE_BEFORE_MAX_AGE_MS, LIVE_BEFORE_MAX_CANDIDATES, LIVE_BEFORE_MAX_OUTPUT_BYTES, LIVE_BEFORE_TOOL_NAME,
} from "../src/live-before.js";
import { simulatedHostFetch } from "./helpers.js";

interface Capture { rpcMethod: string; rpcParams: unknown[]; resultJson: string }
interface Fixture { captures: Capture[] }
const read = <T>(path: string): T => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as T;
const F1 = read<Fixture & { source: { networkId: string; chainId: number }; subject: { txHash: string } }>(
  "../../../examples/historical-compat/authority/fixtures/F1-x402-1062-partial/source/network-evidence/fixtures/base-mainnet-x402-1062-usdc-transfer.fixture.json");
const F3 = read<Fixture & { source: { networkId: string }; subject: { signature: string } }>(
  "../../resolver-solana/test/fixtures/solana-mainnet-x402-real.json");
const SEPOLIA_IDENTITY = read<Fixture & { source: { networkId: string; chainId: number }; subject: { txHash: string } }>(
  "../../adapter-erc4337/test/fixtures/base-sepolia-external-v06-userop.json");
const DEVNET = read<{ subject: { signature: string } }>("../../resolver-solana/test/fixtures/solana-devnet-before-probe.json");

const ORIGIN = "https://mcp.example.org";
const HOST = "mcp.example.org";
const BASE_ID = "eip155:8453";
const SEPOLIA_ID = "eip155:84532";
const SOLANA_ID = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
/** TEST-ONLY synthetic hash; never a real observed action. */
const ABSENT_TX = "0x" + "e".repeat(64);
const BASE_SUBJECT = { type: "transaction", networkId: BASE_ID, txId: F1.subject.txHash } as const;
const SOL_SUBJECT = { type: "transaction", networkId: SOLANA_ID, txId: F3.subject.signature } as const;
const ABSENT_SEPOLIA_SUBJECT = { type: "transaction", networkId: SEPOLIA_ID, txId: ABSENT_TX } as const;
const DEVNET_SUBJECT = { type: "transaction", networkId: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", txId: DEVNET.subject.signature } as const;
/** Explicit caller DiscoveryRequirements; nothing is inferred. */
const REQUIREMENTS = { requirements: [
  { capability: "execution", strength: "required" },
  { capability: "finality", strength: "desired" },
] };
const INPUT = {
  requestId: "ne_l028_three_candidates_1", requirements: REQUIREMENTS,
  subjects: [BASE_SUBJECT, SOL_SUBJECT, ABSENT_SEPOLIA_SUBJECT],
};
const BASE_READS = ["eth_chainId", "eth_getTransactionReceipt", "eth_getBlockByHash", "eth_getTransactionByHash"];
const SOL_READS = ["getGenesisHash", "getTransaction", "getSignatureStatuses", "getBlock"];
const ABSENT_READS = ["eth_chainId", "eth_getTransactionReceipt", "eth_getTransactionByHash"];
const tagged = (endpoint: string, methods: readonly string[]) => methods.map(m => `${endpoint}:${m}`);
/** The ordered provider reads of the ONE three-subject call (11; the worst case is 3 x 4 = 12). */
const ONE_CALL_READS = [
  ...tagged("base-mainnet", BASE_READS), ...tagged("solana-mainnet", SOL_READS), ...tagged("base-sepolia", ABSENT_READS),
];
const RPC_HOSTNAMES = ["mainnet.base.org", "sepolia.base.org", "api.mainnet-beta.solana.com"];
const ENDPOINTS: Readonly<Record<string, "base-mainnet" | "base-sepolia" | "solana-mainnet">> = {
  "https://mainnet.base.org/": "base-mainnet",
  "https://sepolia.base.org/": "base-sepolia",
  "https://api.mainnet-beta.solana.com/": "solana-mainnet",
};

const captureOf = (fixture: Fixture, method: string): Capture => {
  const found = fixture.captures.find(c => c.rpcMethod === method);
  if (!found) throw Error(`missing pinned capture ${method}`);
  return found;
};

interface Simulated {
  /** SIMULATED: Base Sepolia eth_chainId answered with the real F1 Base mainnet bytes ("0x2105"). */
  sepoliaForeignChainId?: boolean;
  /** SIMULATED: every Base Sepolia read answers this HTTP status with provider text. */
  sepoliaHttpStatus?: 503 | 429;
}

/** Serves only the three fixed origins; any unrecorded method or params throws. */
function provider(sim: Simulated = {}) {
  const reads: string[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).href;
    const endpoint = ENDPOINTS[url];
    if (endpoint === undefined) throw Error("Unapproved fake endpoint");
    const req = JSON.parse(init?.body as string) as { id: number; method: string; params?: unknown[] };
    reads.push(`${endpoint}:${req.method}`);
    const respond = (body: string, status: number, contentType: string) => {
      const response = new Response(body, { status, headers: { "content-type": contentType } });
      Object.defineProperty(response, "url", { value: url });
      return response;
    };
    const params = JSON.stringify(req.params ?? []);
    let resultText: string;
    if (endpoint === "base-sepolia") {
      if (sim.sepoliaHttpStatus !== undefined) return respond("SIMULATED provider text", sim.sepoliaHttpStatus, "text/plain");
      if (req.method === "eth_chainId" && params === "[]") {
        resultText = captureOf(sim.sepoliaForeignChainId ? F1 : SEPOLIA_IDENTITY, "eth_chainId").resultJson;
      } else if ((req.method === "eth_getTransactionReceipt" || req.method === "eth_getTransactionByHash")
          && params === JSON.stringify([ABSENT_TX])) {
        resultText = "null";
      } else throw Error("Unexpected Base Sepolia read");
    } else {
      const found = captureOf(endpoint === "base-mainnet" ? F1 : F3, req.method);
      if (params !== JSON.stringify(found.rpcParams)) throw Error("Unexpected mock params");
      resultText = found.resultJson;
    }
    return respond(`{"jsonrpc":"2.0","id":${JSON.stringify(req.id)},"result":${resultText}}`, 200, "application/json");
  };
  return { fetchFn, reads };
}

/** Records every resolve of the shared resolver: its LiveCall and its observation. */
function counted(resolve: MultichainTool) {
  const calls: (LiveCall | undefined)[] = [];
  const observations: MultichainObservation[] = [];
  const tool = Object.assign(async (input: Parameters<MultichainTool>[0]) => {
    calls.push(input.call);
    const observation = await resolve(input);
    observations.push(observation);
    return observation;
  }, { startCall: resolve.startCall! });
  return { tool: tool as MultichainTool, calls, observations };
}

const classes = (core: ReturnType<typeof decodeNecWireJson<"discovery-result">>) =>
  core.matches.map(m => [m.network.networkId, m.classification]);

const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async () => {
    throw new Error("network I/O is forbidden in live-before-three-candidates tests");
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("NE-L028: one hosted Discovery call, one Core result, three honest candidates", () => {
  it("pins the source identities and leaves every global budget, timeout and size ceiling unchanged", () => {
    expect(F1.subject.txHash).toBe("0x8e01aace01ced4155b30d636b547727becdbb8a700f9b7f54ed02c4d629ae696");
    expect(F1.source).toMatchObject({ networkId: BASE_ID, chainId: 8453 });
    expect(F3.subject.signature).toBe("4DYWUMExSrMNxYLjUuH9G8feN4fmYXm4ToCx7gGaAEjJRf2QNrE8LsvoFSGhXwQJrchhgrnGpUFwjxrci9PRLF71");
    expect(F3.source.networkId).toBe(SOLANA_ID);
    expect(SEPOLIA_IDENTITY.source).toMatchObject({ networkId: SEPOLIA_ID, chainId: 84532 });
    expect(captureOf(SEPOLIA_IDENTITY, "eth_chainId")).toMatchObject({ rpcParams: [], resultJson: "\"0x14a34\"" });
    // The synthetic absent hash is not the subject of any pinned capture.
    for (const real of [F1.subject.txHash, SEPOLIA_IDENTITY.subject.txHash]) expect(ABSENT_TX).not.toBe(real);
    expect(LIVE_BEFORE_MAX_CANDIDATES).toBe(3);
    expect({
      MULTICHAIN_CALLS_PER_MINUTE, MULTICHAIN_MAX_INFLIGHT, LIVE_TOOL_DEADLINE_MS, MULTICHAIN_RESULT_MAX_BYTES,
      LIVE_BEFORE_MAX_AGE_MS, LIVE_BEFORE_MAX_OUTPUT_BYTES,
      LIVE_EVM_RPC_TIMEOUT_MS, LIVE_EVM_MAX_RPC_BYTES, LIVE_EVM_MAX_CALLS_PER_MINUTE,
      SOLANA_READ_TIMEOUT_MS, SOLANA_RESPONSE_MAX_BYTES,
    }).toEqual({
      MULTICHAIN_CALLS_PER_MINUTE: 8, MULTICHAIN_MAX_INFLIGHT: 2, LIVE_TOOL_DEADLINE_MS: 35_000, MULTICHAIN_RESULT_MAX_BYTES: 450_000,
      LIVE_BEFORE_MAX_AGE_MS: 180_000, LIVE_BEFORE_MAX_OUTPUT_BYTES: 180_000,
      LIVE_EVM_RPC_TIMEOUT_MS: 6_000, LIVE_EVM_MAX_RPC_BYTES: 128_000, LIVE_EVM_MAX_CALLS_PER_MINUTE: 8,
      SOLANA_READ_TIMEOUT_MS: 8_000, SOLANA_RESPONSE_MAX_BYTES: 800_000,
    });
    expect(HOSTED_DEFAULT_LIMITS).toEqual({ maxConcurrent: 8, maxRequestsPerMinute: 240 });
  });

  it("ONE call -> ONE Core-verified discovery-result: conditional (Base mainnet), ineligible (test-only absent Base Sepolia), eligible (Solana mainnet)", async () => {
    const p = provider();
    const c = counted(createMultichainTool(p.fetchFn));
    const out = await createLiveBeforeTool(c.tool)(INPUT);

    // One tool call: three resolves sharing ONE LiveCall, 11 ordered provider reads.
    expect(c.calls).toHaveLength(3);
    expect(c.calls[0]).toBeDefined();
    expect(new Set(c.calls).size).toBe(1);
    expect(p.reads).toEqual(ONE_CALL_READS);
    expect(c.observations.map(o => o.subject)).toEqual(INPUT.subjects);

    expect(out).toMatchObject({
      schema: "ne-mcp-live-discovery/v0.1", observationKind: "live_source_observation",
      builtAndVerifiedBy: "@nec/discovery + @nec/core",
    });
    // Exactly one Core result; Core orders matches by candidate id.
    const core = decodeNecWireJson("discovery-result", JSON.stringify(out.result));
    expect(core.requestId).toBe(INPUT.requestId);
    expect(core.request.requirements).toEqual(REQUIREMENTS.requirements);
    expect(core.matches).toHaveLength(3);
    expect(classes(core)).toEqual([[BASE_ID, "conditional"], [SEPOLIA_ID, "ineligible"], [SOLANA_ID, "eligible"]]);
    expect(new Set(core.matches.map(m => m.classification)).size).toBe(3);
    expect(out.candidates.map(x => [x.id, x.environment, x.networkId, x.classification])).toEqual([
      ["base-mainnet", "mainnet", BASE_ID, "conditional"],
      ["base-sepolia", "testnet", SEPOLIA_ID, "ineligible"],
      ["solana-mainnet", "mainnet", SOLANA_ID, "eligible"],
    ]);
    out.candidates.forEach((x, i) => {
      expect(core.matches[i]?.capabilitySnapshot.digest).toBe(x.snapshotDigest);
      expect(x.snapshotDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    });
    expect(new Set(out.candidates.map(x => x.snapshotDigest)).size).toBe(3);

    // Each classification follows from Core's own requirement evaluations.
    const status = (i: number, capability: string) =>
      core.matches[i]?.evaluations.find(e => e.requirement.capability === capability)?.status;
    expect(status(0, "execution")).toBe("satisfied");
    expect(status(0, "finality")).toBeDefined();
    expect(status(0, "finality")).not.toBe("satisfied");
    expect(status(1, "execution")).toBeDefined();
    expect(status(1, "execution")).not.toBe("satisfied");
    expect(status(2, "execution")).toBe("satisfied");
    expect(status(2, "finality")).toBe("satisfied");

    const [base, absent, solana] = out.candidates;
    // Base: execution observed; generic EVM finality unsupported (only desired => conditional).
    expect(base?.capabilities.execution.availability).toBe("available");
    expect(base?.capabilities.finality).toMatchObject({ support: "unsupported", availability: "unavailable" });
    // Absent probe: execution not established => ineligible. Never supported or contradicted.
    expect(absent?.capabilities.execution.availability).toBe("unavailable");
    expect(absent?.capabilities.finality.availability).toBe("unavailable");
    // Solana: finality only as the source-reported finalized commitment.
    expect(solana?.capabilities.execution.availability).toBe("available");
    expect(solana?.capabilities.finality.availability).toBe("available");
    for (const x of out.candidates) {
      expect(x.capabilities.settlement.support).toBe("unsupported");
      expect(x.capabilities.settlement.availability).not.toBe("available");
    }

    // Exact source identity and byte-for-byte replay of the real captures.
    const obs = (networkId: string) => c.observations.find(o => o.subject.networkId === networkId)!;
    const sizes = (fixture: Fixture, methods: readonly string[]) =>
      methods.map(m => [m, 200, Buffer.byteLength(captureOf(fixture, m).resultJson)]);
    expect(obs(BASE_ID).acquisition.captures.map(x => [x.rpcMethod, x.httpStatus, x.resultBytes])).toEqual(sizes(F1, BASE_READS));
    expect(obs(SOLANA_ID).acquisition.captures.map(x => [x.rpcMethod, x.httpStatus, x.resultBytes])).toEqual(sizes(F3, SOL_READS));
    expect(obs(SEPOLIA_ID).acquisition.captures.map(x => [x.rpcMethod, x.httpStatus, x.resultBytes])).toEqual([
      ["eth_chainId", 200, Buffer.byteLength("\"0x14a34\"")],
      ["eth_getTransactionReceipt", 200, 4], ["eth_getTransactionByHash", 200, 4],
    ]);
    expect(obs(SEPOLIA_ID).source).toMatchObject({ networkId: SEPOLIA_ID, chainId: 84532, sourceType: "evm_rpc" });
    expect(obs(SEPOLIA_ID).acquisition).toMatchObject({ transactionObserved: false, transactionLookupUsable: false, blockObserved: false });
    const absentVerdict = (obs(SEPOLIA_ID).fragment as any).networkEvidence.execution.verdict;
    expect(absentVerdict).toBe("insufficient");
    for (const x of out.candidates) {
      const o = obs(x.networkId);
      expect([x.sourceId, x.sourceType, x.observedAt]).toEqual([o.source.sourceId, o.source.sourceType, o.acquiredAt]);
      expect(x.evidenceCaptures).toEqual(o.acquisition.captures.map(y => ({ rpcMethod: y.rpcMethod, contentDigest: y.contentDigest })));
      expect(x.evidenceCaptures.every(y => y.contentDigest.startsWith("sha256:"))).toBe(true);
    }

    // Non-claims and bounds.
    const nonClaims = out.nonClaims.join(" ");
    for (const phrase of [
      "not proof of network unavailability", "not a recommendation, ranking or network choice",
      "choose and preflight separately", "settlement", "complete Core NetworkEvidenceResult or Hub/Lens case",
      "no BEFORE/AFTER continuity, economic finality or NE Maps integration",
    ]) expect(nonClaims).toContain(phrase);
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThanOrEqual(LIVE_BEFORE_MAX_OUTPUT_BYTES);
    for (const host of RPC_HOSTNAMES) expect(JSON.stringify(out)).not.toContain(host);
  });

  it("MUTATION: a tampered classification or a swapped snapshot binding in the returned Core result fails Core decoding", async () => {
    const p = provider();
    const out = await createLiveBeforeTool(createMultichainTool(p.fetchFn))(INPUT);
    const flipped = JSON.parse(JSON.stringify(out.result)) as any;
    flipped.matches[0].classification = "eligible";
    expect(() => decodeNecWireJson("discovery-result", JSON.stringify(flipped))).toThrow();
    const promoted = JSON.parse(JSON.stringify(out.result)) as any;
    promoted.matches[1].classification = "conditional";
    expect(() => decodeNecWireJson("discovery-result", JSON.stringify(promoted))).toThrow();
    const swapped = JSON.parse(JSON.stringify(out.result)) as any;
    [swapped.matches[0].capabilitySnapshot, swapped.matches[2].capabilitySnapshot] =
      [swapped.matches[2].capabilitySnapshot, swapped.matches[0].capabilitySnapshot];
    expect(() => decodeNecWireJson("discovery-result", JSON.stringify(swapped))).toThrow();
  });

  it("MUTATION: changing only the caller requirements changes the classes natively (conditional comes from 'desired', not from this tool)", async () => {
    const p = provider();
    const before = createLiveBeforeTool(createMultichainTool(p.fetchFn));
    const required = await before({ ...INPUT, requirements: { requirements: [
      { capability: "execution", strength: "required" }, { capability: "finality", strength: "required" },
    ] } });
    expect(classes(decodeNecWireJson("discovery-result", JSON.stringify(required.result))))
      .toEqual([[BASE_ID, "ineligible"], [SEPOLIA_ID, "ineligible"], [SOLANA_ID, "eligible"]]);
    const executionOnly = await before({ ...INPUT, requirements: { requirements: [{ capability: "execution", strength: "required" }] } });
    expect(classes(decodeNecWireJson("discovery-result", JSON.stringify(executionOnly.result))))
      .toEqual([[BASE_ID, "eligible"], [SEPOLIA_ID, "ineligible"], [SOLANA_ID, "eligible"]]);
    expect(p.reads).toEqual([...ONE_CALL_READS, ...ONE_CALL_READS]);
  });

  it("SIMULATED Base Sepolia source failures (foreign chain id bytes, HTTP 503, HTTP 429) fail the WHOLE call closed: no partial result, never a rate-limit code", async () => {
    for (const sim of [{ sepoliaForeignChainId: true }, { sepoliaHttpStatus: 503 }, { sepoliaHttpStatus: 429 }] as const) {
      const p = provider(sim);
      await expect(createLiveBeforeTool(createMultichainTool(p.fetchFn))(INPUT))
        .rejects.toMatchObject({ code: "MCP_LIVE_BEFORE_UNAVAILABLE" });
      expect(p.reads).toEqual([
        ...tagged("base-mainnet", BASE_READS), ...tagged("solana-mainnet", SOL_READS), "base-sepolia:eth_chainId",
      ]);
    }
  });

  it("validates subjects, duplicate profiles, unsupported networks and the cap of exactly 3 BEFORE any RPC or budget charge", async () => {
    const p = provider();
    const c = counted(createMultichainTool(p.fetchFn));
    const before = createLiveBeforeTool(c.tool);
    const rejected: unknown[][] = [
      [],
      // Four distinct, otherwise valid fixed profiles: only the cap rejects it.
      [BASE_SUBJECT, SOL_SUBJECT, ABSENT_SEPOLIA_SUBJECT, DEVNET_SUBJECT],
      // Duplicate profile (second Base mainnet subject).
      [BASE_SUBJECT, SOL_SUBJECT, { ...BASE_SUBJECT, txId: ABSENT_TX }],
      // Unsupported network.
      [BASE_SUBJECT, SOL_SUBJECT, { ...ABSENT_SEPOLIA_SUBJECT, networkId: "eip155:57057" }],
      // Malformed or family-mismatched identifiers.
      [BASE_SUBJECT, SOL_SUBJECT, { ...ABSENT_SEPOLIA_SUBJECT, txId: "bad" }],
      [BASE_SUBJECT, SOL_SUBJECT, { ...DEVNET_SUBJECT, txId: ABSENT_TX }],
      [BASE_SUBJECT, SOL_SUBJECT, { ...ABSENT_SEPOLIA_SUBJECT, type: "block" }],
      [BASE_SUBJECT, SOL_SUBJECT, null],
    ];
    for (const subjects of rejected) {
      await expect(before({ ...INPUT, subjects: subjects as any })).rejects.toMatchObject({ code: "MCP_LIVE_BEFORE_INPUT" });
    }
    await expect(before({ ...INPUT, requirements: { requirements: [{ capability: "bogus", strength: "required" }] } }))
      .rejects.toMatchObject({ code: "MCP_LIVE_BEFORE_INPUT" });
    expect(c.calls).toHaveLength(0);
    expect(p.reads).toHaveLength(0);
    // Nothing was charged: the full budget still serves the three-subject call.
    const out = await before(INPUT);
    expect(out.candidates.map(x => x.classification)).toEqual(["conditional", "ineligible", "eligible"]);
  });

  it("budget: each subject takes one shared admission (8/min, never refunded); the third three-subject call fails MCP_MULTICHAIN_RATE_LIMIT on its third subject", async () => {
    const p = provider();
    const c = counted(createMultichainTool(p.fetchFn));
    const before = createLiveBeforeTool(c.tool);
    for (const n of [1, 2]) {
      const out = await before({ ...INPUT, requestId: `ne_l028_budget_${n}` });
      expect(out.candidates).toHaveLength(3);
    }
    expect(c.calls).toHaveLength(6);
    p.reads.length = 0;
    // Admissions 7 and 8 are taken and read; the budget is checked per subject, not reserved up front.
    await expect(before({ ...INPUT, requestId: "ne_l028_budget_3" })).rejects.toMatchObject({ code: "MCP_MULTICHAIN_RATE_LIMIT" });
    expect(p.reads).toEqual([...tagged("base-mainnet", BASE_READS), ...tagged("solana-mainnet", SOL_READS)]);
    p.reads.length = 0;
    await expect(before({ ...INPUT, requestId: "ne_l028_budget_4", subjects: [SOL_SUBJECT] }))
      .rejects.toMatchObject({ code: "MCP_MULTICHAIN_RATE_LIMIT" });
    expect(p.reads).toHaveLength(0);
  });

  it("hosted SDK (legacy and modern): one tools/call returns the one three-class Core result; the over-cap and duplicate inputs read nothing", async () => {
    const p = provider();
    const server = await startNeMcpHttpServer({
      host: "127.0.0.1", port: 0, hosted: { publicOrigin: ORIGIN }, liveEvidence: createMultichainTool(p.fetchFn),
    });
    try {
      const hostFetch = simulatedHostFetch(server.port, HOST);
      for (const mode of ["legacy", "auto"] as const) {
        const client = new Client({ name: "live-before-three-candidates-test", version: "1" }, { versionNegotiation: { mode } });
        await client.connect(new StreamableHTTPClientTransport(new URL(ORIGIN + "/mcp"), { fetch: hostFetch }));
        try {
          const { tools } = await client.listTools();
          const tool = tools.find(t => t.name === LIVE_BEFORE_TOOL_NAME);
          expect((tool?.inputSchema as any).properties.subjects.maxItems).toBe(3);
          p.reads.length = 0;
          for (const subjects of [
            [BASE_SUBJECT, SOL_SUBJECT, ABSENT_SEPOLIA_SUBJECT, DEVNET_SUBJECT],
            [BASE_SUBJECT, SOL_SUBJECT, { ...BASE_SUBJECT, txId: ABSENT_TX }],
          ]) {
            const refused = await client.callTool({ name: LIVE_BEFORE_TOOL_NAME, arguments: { ...INPUT, subjects } });
            expect(refused.isError).toBe(true);
            expect(refused.structuredContent).toBeUndefined();
          }
          expect(p.reads).toHaveLength(0);
          const result = await client.callTool({ name: LIVE_BEFORE_TOOL_NAME, arguments: INPUT });
          expect(result.isError).toBeFalsy();
          expect(p.reads).toEqual(ONE_CALL_READS);
          const sc = result.structuredContent as any;
          expect(sc.candidates.map((x: any) => [x.id, x.classification])).toEqual([
            ["base-mainnet", "conditional"], ["base-sepolia", "ineligible"], ["solana-mainnet", "eligible"],
          ]);
          const core = decodeNecWireJson("discovery-result", JSON.stringify(sc.result));
          expect(classes(core)).toEqual([[BASE_ID, "conditional"], [SEPOLIA_ID, "ineligible"], [SOLANA_ID, "eligible"]]);
          core.matches.forEach((m, i) => expect(m.capabilitySnapshot.digest).toBe(sc.candidates[i].snapshotDigest));
          for (const host of RPC_HOSTNAMES) expect(JSON.stringify(result)).not.toContain(host);
        } finally { await client.close(); }
      }
    } finally { await server.close(); }
  });
});
