/**
 * NE-G2-TWOCALL (owner-ratified G2 option A), test only, on L048 e7a49f2.
 *
 * ONE hosted MCP session per SDK era makes TWO SEPARATE Core-verified
 * discover_live_network_evidence calls, one per exact pinned mainnet probe.
 * The external caller then picks its NONFIRST probe network and sends an
 * independent, complete Core PreflightRequest to preflight_live_network_evidence.
 * Each Discovery result carries exactly one candidate and one native Core
 * classification. No single result is asked to show all three classes, and
 * LIVE_BEFORE_MAX_CANDIDATES is unchanged.
 *
 * Offline replay only: an in-process fake provider, and a poisoned global fetch
 * that is counted and must stay at zero. Provider bytes:
 * - Base mainnet: the REAL historical-compat "F1" authority capture (x402 #1062
 *   USDC transfer 0x8e01…e696), each answer verbatim for the exact recorded params.
 * - Solana mainnet: the REAL "F3" source capture (resolver-solana
 *   solana-mainnet-x402-real.json, 4DYWUMEx…LF71), verbatim for the exact recorded params.
 * - SIMULATED_ABSENT_BASE_SUBJECT: a TEST-ONLY synthetic Base mainnet hash. It
 *   is NOT a transaction observed anywhere. Only its eth_chainId answer is real
 *   (F1 bytes, params []). Its receipt/transaction lookups answer JSON null. It
 *   claims neither that such a transaction exists or never existed, nor that
 *   Base or its source is unavailable.
 * - SIMULATED Solana outage (HTTP 503), used only by the test titled SIMULATED.
 *
 * The Solana action and policy are caller-supplied literals: the caller's
 * intended future action, not something derived from the probe transaction.
 *
 * SDK eras: mode "legacy" negotiates the legacy era. Mode "auto" is the only mode
 * this repository uses to negotiate the modern era. Right after connect and
 * before any tool call, each session asserts getProtocolEra() equals the
 * expected era, so a silent fallback fails the test.
 *
 * Only Date is faked, pinned to F3's recorded acquisition instant, so outputs
 * are byte-comparable across calls, sessions and eras. Real timers (whole-call
 * deadlines, HTTP) keep running.
 *
 * Scope: no MCP src or Core change. This test does not settle the disposition
 * of the historical NE-L011 G2 item, and claims no settlement, finality or
 * release readiness.
 */
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  computeEvidencePolicyDigest, decodeNecWireJson, encodeNecWireJson,
  verifyCapabilitySnapshot, verifyPreflightResult,
} from "@nec/core";
import type { EvidencePolicy, PolicyDimension, PreflightRequest } from "@nec/core";
import { startNeMcpHttpServer } from "../src/http.js";
import { LIVE_TOOL_NAMES } from "../src/tools.js";
import { createMultichainTool, LIVE_MULTICHAIN_TOOL, MULTICHAIN_CALLS_PER_MINUTE } from "../src/live-multichain.js";
import {
  LIVE_BEFORE_MAX_AGE_MS, LIVE_BEFORE_MAX_CANDIDATES, LIVE_BEFORE_MAX_OUTPUT_BYTES, LIVE_BEFORE_TOOL_NAME,
} from "../src/live-before.js";
import { LIVE_PREFLIGHT_MAX_INPUT_BYTES, LIVE_PREFLIGHT_TOOL_NAME } from "../src/live-preflight.js";
import { restrictedSolanaRpcFetch } from "../src/live-solana.js";
import { restrictedBaseRpcFetch } from "../src/live-evm.js";
import { collectKeys, FORBIDDEN_KEY_WORD, simulatedHostFetch } from "./helpers.js";

interface Capture { rpcMethod: string; rpcParams: unknown[]; resultJson: string }
interface Fixture { captures: Capture[] }
const F1_PATH = new URL(
  "../../../examples/historical-compat/authority/fixtures/F1-x402-1062-partial/source/network-evidence/fixtures/base-mainnet-x402-1062-usdc-transfer.fixture.json",
  import.meta.url);
const F3_PATH = new URL("../../resolver-solana/test/fixtures/solana-mainnet-x402-real.json", import.meta.url);
const F1_TEXT = readFileSync(F1_PATH, "utf8");
const F3_TEXT = readFileSync(F3_PATH, "utf8");
const F1 = JSON.parse(F1_TEXT) as Fixture & { source: { networkId: string; chainId: number }; subject: { txHash: string } };
const F3 = JSON.parse(F3_TEXT) as Fixture & { acquiredAt: string; source: { networkId: string }; subject: { signature: string } };

const REPO_ROOT = new URL("../../../", import.meta.url);
const DOC = readFileSync(new URL("docs/distribution/MCP_PUBLIC_CONTRACT.md", REPO_ROOT), "utf8");

const ORIGIN = "https://mcp.example.org";
const HOST = "mcp.example.org";
const BASE_ID = "eip155:8453" as const;
const SOL_ID = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" as const;
const BASE_URL = "https://mainnet.base.org/";
const SOL_URL = "https://api.mainnet-beta.solana.com/";
const APPROVED_URLS = [BASE_URL, SOL_URL];
const SOURCE_HOSTS = ["mainnet.base.org", "api.mainnet-beta.solana.com"];
const PINNED_AT = F3.acquiredAt;

const BASE_READS = ["eth_chainId", "eth_getTransactionReceipt", "eth_getBlockByHash", "eth_getTransactionByHash"];
const NULL_BASE_READS = ["eth_chainId", "eth_getTransactionReceipt", "eth_getTransactionByHash"];
const SOL_READS = ["getGenesisHash", "getTransaction", "getSignatureStatuses", "getBlock"];
const tagged = (endpoint: string, methods: readonly string[]) => methods.map(m => `${endpoint}:${m}`);

/** TEST-ONLY synthetic hash; never a real observed action. */
const ABSENT_TX = "0x" + "e".repeat(64);
const BASE_SUBJECT = { type: "transaction", networkId: BASE_ID, txId: F1.subject.txHash } as const;
const SOL_SUBJECT = { type: "transaction", networkId: SOL_ID, txId: F3.subject.signature } as const;
const SIMULATED_ABSENT_BASE_SUBJECT = { type: "transaction", networkId: BASE_ID, txId: ABSENT_TX } as const;

/** Explicit caller DiscoveryRequirements, identical for both calls. Nothing is inferred. */
const REQUIREMENTS = { requirements: [
  { capability: "execution", strength: "required" },
  { capability: "finality", strength: "desired" },
] };
const DISCOVERY_BASE = { requestId: "ne_g2a_discovery_base_1", requirements: REQUIREMENTS, subjects: [BASE_SUBJECT] };
const DISCOVERY_SOLANA = { requestId: "ne_g2a_discovery_solana_1", requirements: REQUIREMENTS, subjects: [SOL_SUBJECT] };
const DISCOVERY_ABSENT = {
  requestId: "ne_g2a_discovery_absent_1", requirements: REQUIREMENTS, subjects: [SIMULATED_ABSENT_BASE_SUBJECT],
};

/** The caller's own ordered probe list. "First" means submission order, not any Discovery order. */
const SUBMITTED = [BASE_SUBJECT, SOL_SUBJECT] as const;
/** Fixed before any tool call: the caller picks its NONFIRST probe's network. */
const CALLER_CHOICE_INDEX = 1 as const;
const CHOSEN = SUBMITTED[CALLER_CHOICE_INDEX];

const POLICY_CONTENT = {
  id: "caller_policy_g2a_execution_finality", version: "1",
  requiredDimensions: ["execution", "finality"] as PolicyDimension[],
};
const POLICY: EvidencePolicy = { ...POLICY_CONTENT, digest: computeEvidencePolicyDigest(POLICY_CONTENT) };
/** COMPLETE caller-built Core request for the chosen network. The action is the caller's intended future action. */
const SOL_REQUEST: PreflightRequest = {
  schemaVersion: "0.1", requestId: "ne_g2a_caller_preflight_1", networkId: CHOSEN.networkId,
  action: { kind: "spl_token.transfer_checked", target: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", fields: { expectedAmount: "5000" } },
  evidencePolicy: POLICY,
};
const PREFLIGHT_INPUT = { selectedNetworkId: CHOSEN.networkId, probeSubject: CHOSEN, request: SOL_REQUEST };
const PREFLIGHT_INPUT_FIXED = JSON.stringify(PREFLIGHT_INPUT);
/** A caller who still chooses Base, probing with the SIMULATED absent subject. */
const ABSENT_REQUEST: PreflightRequest = {
  schemaVersion: "0.1", requestId: "ne_g2a_caller_preflight_absent_1", networkId: BASE_ID,
  action: { kind: "erc20.transfer", target: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", fields: { expectedAmount: "1000" } },
  evidencePolicy: POLICY,
};
const ABSENT_PREFLIGHT_INPUT = { selectedNetworkId: BASE_ID, probeSubject: SIMULATED_ABSENT_BASE_SUBJECT, request: ABSENT_REQUEST };

/** Served order of the hosted live-mode server (L048 pin). */
const LIVE_TOOL_ORDER = [
  "list_network_profiles", "discover_network_candidates", "get_reviewed_evidence_case",
  LIVE_PREFLIGHT_TOOL_NAME, LIVE_BEFORE_TOOL_NAME, LIVE_MULTICHAIN_TOOL,
] as const;
/** Keys that would carry choice or policy semantics in a Discovery output. */
const CHOICE_KEYS = ["choiceSource", "selectedNetworkId", "evidencePolicy", "preflight", "selected", "choice"];
const AVAILABILITY_VOCABULARY = ["available", "degraded", "unavailable", "unknown"];

const ERAS = [
  { era: "legacy", mode: "legacy" },
  { era: "modern", mode: "auto" },
] as const;
type Era = (typeof ERAS)[number];

/** Exactly one ```json ne-distribution:descriptions block (pinned at L048), parsed. */
function descriptionsBlock(): Readonly<Record<string, string>> {
  const found = [...DOC.matchAll(/^```json ne-distribution:descriptions\n([\s\S]*?)\n```$/gm)];
  expect(found, "descriptions block").toHaveLength(1);
  return JSON.parse(found[0]![1]!) as Record<string, string>;
}

const captureOf = (fixture: Fixture, method: string): Capture => {
  const found = fixture.captures.find(c => c.rpcMethod === method);
  if (!found) throw Error(`missing pinned capture ${method}`);
  return found;
};

/**
 * Serves only the two approved origins. Any unrecorded method or params throws.
 * SIMULATED: the absent Base hash's receipt/transaction lookups answer null, and
 * `state.solanaDown` makes every Solana read answer HTTP 503.
 */
function provider() {
  const reads: string[] = [];
  const urls = new Set<string>();
  const state = { solanaDown: false };
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).href;
    urls.add(url);
    const endpoint = url === BASE_URL ? "base-mainnet" : url === SOL_URL ? "solana-mainnet" : null;
    if (endpoint === null) throw Error("Unapproved fake endpoint");
    const req = JSON.parse(init?.body as string) as { id: number; method: string; params?: unknown[] };
    reads.push(`${endpoint}:${req.method}`);
    const respond = (body: string, status: number, contentType: string) => {
      const response = new Response(body, { status, headers: { "content-type": contentType } });
      Object.defineProperty(response, "url", { value: url });
      return response;
    };
    if (endpoint === "solana-mainnet" && state.solanaDown) return respond("SIMULATED provider outage", 503, "text/plain");
    const params = req.params ?? [];
    let resultText: string;
    if (endpoint === "base-mainnet" && isDeepStrictEqual(params, [ABSENT_TX])
        && (req.method === "eth_getTransactionReceipt" || req.method === "eth_getTransactionByHash")) {
      resultText = "null";
    } else {
      const found = captureOf(endpoint === "base-mainnet" ? F1 : F3, req.method);
      if (!isDeepStrictEqual(params, found.rpcParams)) throw Error("Unexpected mock params");
      resultText = found.resultJson;
    }
    return respond(`{"jsonrpc":"2.0","id":${JSON.stringify(req.id)},"result":${resultText}}`, 200, "application/json");
  };
  return { fetchFn, reads, urls, state };
}

type Call = (name: string, args: Record<string, unknown>) => Promise<any>;

/** One hosted opt-in server plus ONE MCP client session in an explicitly pinned SDK era. Returns every tool response as text. */
async function hostedSession(era: Era, fetchFn: typeof fetch, run: (call: Call, client: Client) => Promise<void>): Promise<string[]> {
  const seen: string[] = [];
  const server = await startNeMcpHttpServer({
    host: "127.0.0.1", port: 0, hosted: { publicOrigin: ORIGIN }, liveEvidence: createMultichainTool(fetchFn),
  });
  try {
    const client = new Client({ name: `before-choice-preflight-flow-${era.era}`, version: "1" }, { versionNegotiation: { mode: era.mode } });
    await client.connect(new StreamableHTTPClientTransport(new URL(ORIGIN + "/mcp"), { fetch: simulatedHostFetch(server.port, HOST) }));
    try {
      expect(client.getProtocolEra(), era.mode).toBe(era.era);
      await run(async (name, args) => {
        const result = await client.callTool({ name, arguments: args });
        seen.push(JSON.stringify(result));
        return result;
      }, client);
    } finally { await client.close(); }
  } finally { await server.close(); }
  return seen;
}

/** tools/list must be exactly the L048 surface: 6 tools, draft-pinned descriptions, unchanged input limits. */
async function servedSurface(client: Client): Promise<string> {
  const { tools } = await client.listTools();
  expect(tools.map(t => t.name)).toEqual([...LIVE_TOOL_ORDER]);
  const block = descriptionsBlock();
  const descriptions = Object.fromEntries(tools.map(t => [t.name, t.description]));
  for (const name of LIVE_TOOL_ORDER) expect(descriptions[name], name).toBe(block[name]);
  const before = tools.find(t => t.name === LIVE_BEFORE_TOOL_NAME)?.inputSchema as any;
  const preflight = tools.find(t => t.name === LIVE_PREFLIGHT_TOOL_NAME)?.inputSchema as any;
  const limits = {
    subjects: [before.properties.subjects.minItems, before.properties.subjects.maxItems],
    requestId: [before.properties.requestId.minLength, before.properties.requestId.maxLength],
    subjectTxId: [before.properties.subjects.items.properties.txId.minLength, before.properties.subjects.items.properties.txId.maxLength],
    probeTxId: [preflight.properties.probeSubject.properties.txId.minLength, preflight.properties.probeSubject.properties.txId.maxLength],
  };
  expect(limits).toEqual({
    subjects: [1, LIVE_BEFORE_MAX_CANDIDATES], requestId: [2, 90], subjectTxId: [43, 100], probeTxId: [43, 100],
  });
  return JSON.stringify({ descriptions, limits });
}

/** A failed tool call: bounded safe error only, no structured evidence. */
function errorCode(result: any): string {
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toBeUndefined();
  const parsed = JSON.parse(result.content[0].text as string) as { error: { code: string; cause: unknown } };
  expect(parsed.error.cause).toBeNull();
  return parsed.error.code;
}

/** A refused call. Schema-level refusals are not NE error envelopes, so only the refusal itself is asserted. */
function refused(result: any): void {
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toBeUndefined();
}

function stringsOf(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringsOf(item, out);
  else if (typeof value === "object" && value !== null) for (const item of Object.values(value)) stringsOf(item, out);
  return out;
}

/** Native per-result view: exactly one candidate, decoded (digest-checked) Core result, Core's own evaluations. */
function nativeView(sc: any, requestId: string) {
  expect(sc).toMatchObject({
    schema: "ne-mcp-live-discovery/v0.1", observationKind: "live_source_observation",
    builtAndVerifiedBy: "@nec/discovery + @nec/core", generatedAt: PINNED_AT,
  });
  const core = decodeNecWireJson("discovery-result", JSON.stringify(sc.result));
  expect(core.requestId).toBe(requestId);
  expect(core.request.requirements).toEqual(REQUIREMENTS.requirements);
  expect(core.matches).toHaveLength(1);
  expect(sc.candidates).toHaveLength(1);
  const match = core.matches[0]!;
  const candidate = sc.candidates[0];
  expect(match.network.networkId).toBe(candidate.networkId);
  expect(match.classification).toBe(candidate.classification);
  expect(match.capabilitySnapshot.digest).toBe(candidate.snapshotDigest);
  expect(candidate.snapshotDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(candidate.observedAt).toBe(PINNED_AT);
  for (const state of Object.values(candidate.capabilities) as any[]) expect(AVAILABILITY_VOCABULARY).toContain(state.availability);
  return {
    core, candidate,
    view: {
      id: candidate.id as string, environment: candidate.environment as string, networkId: candidate.networkId as string,
      classification: match.classification,
      evaluations: match.evaluations.map(e => [e.requirement.capability, e.status]),
      sourceType: candidate.sourceType as string,
      reads: candidate.evidenceCaptures.map((c: any) => c.rpcMethod as string),
    },
  };
}
type NativeView = ReturnType<typeof nativeView>;

/** Native capability dimensions this result reports as NOT available, with their native availability. */
const notAvailable = (capabilities: Record<string, any>) =>
  Object.entries(capabilities).filter(([, s]) => s.availability !== "available").map(([k, s]) => [k, s.availability]);

const BASE_VIEW = {
  id: "base-mainnet", environment: "mainnet", networkId: BASE_ID, classification: "conditional",
  evaluations: [["execution", "satisfied"], ["finality", "unsatisfied"]], sourceType: "evm_rpc", reads: BASE_READS,
};
const SOL_VIEW = {
  id: "solana-mainnet", environment: "mainnet", networkId: SOL_ID, classification: "eligible",
  evaluations: [["execution", "satisfied"], ["finality", "satisfied"]], sourceType: "svm_rpc", reads: SOL_READS,
};
const ABSENT_VIEW = {
  id: "base-mainnet", environment: "mainnet", networkId: BASE_ID, classification: "ineligible",
  evaluations: [["execution", "unsatisfied"], ["finality", "unsatisfied"]], sourceType: "evm_rpc", reads: NULL_BASE_READS,
};

function expectNoChoiceSemantics(discovery: any): void {
  const keys = collectKeys(discovery);
  for (const key of keys) expect(key).not.toMatch(FORBIDDEN_KEY_WORD);
  for (const key of CHOICE_KEYS) expect(keys.has(key), key).toBe(false);
  const nonClaims = discovery.nonClaims.join(" ");
  expect(nonClaims).toContain("not a recommendation, ranking or network choice");
  expect(nonClaims).toContain("choose and preflight separately");
  expect(nonClaims).toContain("not proof of network unavailability");
}

/** The caller's independent Solana preflight: native Core-verified, ready, continuous with the SECOND Discovery result only. */
function expectChosenSolanaPreflight(out: any, chosen: NativeView, unchosen: NativeView): void {
  expect(out).toMatchObject({
    schema: "ne-mcp-live-preflight/v0.1", observationKind: "live_source_observation", choiceSource: "caller",
    selectedNetworkId: SOL_ID, probeSubject: SOL_SUBJECT, probeObservedAt: PINNED_AT, verifiedBy: "@nec/core",
    source: { sourceId: chosen.candidate.sourceId, sourceType: "svm_rpc" },
  });
  expect(out.probeSubject).toEqual(SOL_SUBJECT);
  const result = decodeNecWireJson("preflight-result", JSON.stringify(out.preflight));
  const snapshot = decodeNecWireJson("capability-snapshot", JSON.stringify(out.capabilitySnapshot));
  const manifest = decodeNecWireJson("resolver-manifest", JSON.stringify(out.resolverManifest));
  expect(verifyCapabilitySnapshot(snapshot, { resolver: manifest, networkId: SOL_ID })).toBe(true);
  expect(verifyPreflightResult(result, { resolver: manifest, capabilitySnapshot: snapshot })).toBe(true);

  // Exact caller request, policy digest and action survive unchanged.
  expect(result.request).toEqual(SOL_REQUEST);
  expect(encodeNecWireJson("preflight-request", result.request)).toBe(encodeNecWireJson("preflight-request", SOL_REQUEST));
  expect(result.request.evidencePolicy.digest).toBe(computeEvidencePolicyDigest(POLICY_CONTENT));
  expect(result.network.networkId).toBe(SOL_ID);

  // Native readiness: finality is source-reported only; settlement is never ready.
  expect(result.status).toBe("ready");
  expect(result.evidenceReadiness.execution.status).toBe("ready");
  expect(result.evidenceReadiness.finality).toMatchObject({
    status: "ready", metadata: { doesNotEstablish: expect.arrayContaining(["settlement", "independent_cryptographic_verification"]) },
  });
  expect(result.evidenceReadiness.settlement.status).toBe("not_applicable");
  expect(snapshot.evidenceCapabilities.settlement).toMatchObject({ support: "unsupported", availability: "unavailable" });
  expect(snapshot.evidenceCapabilities.finality).toMatchObject({ metadata: { basis: "source_observation" } });

  // Subject/basis/digest continuity with the chosen (second) Discovery result.
  // The preflight carries none of it as input. It re-derives the same
  // snapshot from a fresh read of the same probe at the same pinned instant.
  expect(snapshot.network.networkId).toBe(chosen.candidate.networkId);
  expect(snapshot.id).toBe(chosen.candidate.snapshotId);
  expect(snapshot.artifactDigest).toBe(chosen.candidate.snapshotDigest);
  expect(snapshot.artifactDigest).toBe(chosen.core.matches[0]!.capabilitySnapshot.digest);
  expect(result.capabilitySnapshot).toMatchObject({ id: chosen.candidate.snapshotId, digest: chosen.candidate.snapshotDigest });
  expect([manifest.id, manifest.version, manifest.digest]).toEqual([
    chosen.candidate.resolver.id, chosen.candidate.resolver.version, chosen.candidate.resolver.digest,
  ]);
  expect(result.resolver.digest).toBe(manifest.digest);
  expect(out.evidenceCaptures).toEqual(chosen.candidate.evidenceCaptures);

  // Independence: no Discovery result digest or request id, and nothing from the unchosen first result.
  const text = JSON.stringify(out);
  for (const marker of [
    unchosen.candidate.snapshotDigest, unchosen.core.artifactDigest, chosen.core.artifactDigest,
    DISCOVERY_BASE.requestId, DISCOVERY_SOLANA.requestId,
  ]) expect(text).not.toContain(marker);
  for (const key of collectKeys(out)) expect(key).not.toMatch(FORBIDDEN_KEY_WORD);
  const nonClaims = out.nonClaims.join(" ");
  expect(nonClaims).toContain("NEC did not choose a network");
  expect(nonClaims).toContain("NOT a full Core NetworkEvidenceResult");
  expect(nonClaims).toContain("never independently cryptographically verified finality");
  expect(out).not.toHaveProperty("networkEvidenceResult");
}

const realFetch = globalThis.fetch;
let globalFetchAttempts = 0;
beforeAll(() => {
  // POISONED: answers like a cooperative JSON-RPC endpoint with forged bytes.
  // Any use would show up in the counter, which must stay at zero.
  globalThis.fetch = (async () => {
    globalFetchAttempts += 1;
    return new Response('{"jsonrpc":"2.0","id":1,"result":"0x1"}', { status: 200, headers: { "content-type": "application/json" } });
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

describe("NE-G2-A: two separate Discovery calls in one hosted session -> caller-chosen nonfirst probe network -> independent Core preflight", () => {
  it("pins the L048 surface constants, the real fixture identities, the synthetic absent hash and the fixed nonfirst caller choice", () => {
    expect(F1.subject.txHash).toBe("0x8e01aace01ced4155b30d636b547727becdbb8a700f9b7f54ed02c4d629ae696");
    expect(F1.source).toMatchObject({ networkId: BASE_ID, chainId: 8453 });
    expect(F3.subject.signature).toBe("4DYWUMExSrMNxYLjUuH9G8feN4fmYXm4ToCx7gGaAEjJRf2QNrE8LsvoFSGhXwQJrchhgrnGpUFwjxrci9PRLF71");
    expect(F3.source.networkId).toBe(SOL_ID);
    expect(PINNED_AT).toBe("2026-08-26T20:01:41.884Z");
    expect(captureOf(F1, "eth_chainId")).toMatchObject({ rpcParams: [], resultJson: "\"0x2105\"" });
    // The synthetic absent hash is not the subject of, nor present in, any pinned capture.
    expect(ABSENT_TX).not.toBe(F1.subject.txHash);
    expect(F1_TEXT).not.toContain(ABSENT_TX.slice(2));
    expect(F3_TEXT).not.toContain(ABSENT_TX.slice(2));
    // Bounds unchanged: no enlarged candidate cap, budget or input limit; still 6 live tools.
    expect({ LIVE_BEFORE_MAX_CANDIDATES, MULTICHAIN_CALLS_PER_MINUTE, LIVE_PREFLIGHT_MAX_INPUT_BYTES, LIVE_BEFORE_MAX_AGE_MS, LIVE_BEFORE_MAX_OUTPUT_BYTES })
      .toEqual({ LIVE_BEFORE_MAX_CANDIDATES: 3, MULTICHAIN_CALLS_PER_MINUTE: 8, LIVE_PREFLIGHT_MAX_INPUT_BYTES: 30_000, LIVE_BEFORE_MAX_AGE_MS: 180_000, LIVE_BEFORE_MAX_OUTPUT_BYTES: 180_000 });
    expect([...LIVE_TOOL_NAMES].sort()).toEqual([...LIVE_TOOL_ORDER].sort());
    // The caller's nonfirst choice and complete request are literals fixed before any call.
    expect(CALLER_CHOICE_INDEX).toBeGreaterThan(0);
    expect(CHOSEN).toEqual(SOL_SUBJECT);
    expect(CHOSEN.networkId).not.toBe(SUBMITTED[0].networkId);
    expect(Object.keys(PREFLIGHT_INPUT).sort()).toEqual(["probeSubject", "request", "selectedNetworkId"]);
    expect(Buffer.byteLength(PREFLIGHT_INPUT_FIXED)).toBeLessThan(LIVE_PREFLIGHT_MAX_INPUT_BYTES);
  });

  it("legacy and modern eras: two separate Core-verified Discovery calls (Base F1, then Solana F3) give distinct native classes; the caller's nonfirst choice is preflighted independently under the shared 8/min budget", async () => {
    const surfaces: string[] = [];
    const outputs: string[][] = [];
    for (const era of ERAS) {
      const p = provider();
      const texts: string[] = [];
      const seen = await hostedSession(era, p.fetchFn, async (call, client) => {
        surfaces.push(await servedSurface(client));
        expect(p.reads).toHaveLength(0);

        // (1) FIRST separate Discovery call: exactly the pinned Base mainnet probe.
        const first = await call(LIVE_BEFORE_TOOL_NAME, DISCOVERY_BASE);
        expect(first.isError).toBeFalsy();
        expect(p.reads).toEqual(tagged("base-mainnet", BASE_READS));
        // (2) SECOND separate Discovery call: exactly the pinned Solana mainnet probe.
        const second = await call(LIVE_BEFORE_TOOL_NAME, DISCOVERY_SOLANA);
        expect(second.isError).toBeFalsy();
        expect(p.reads).toEqual([...tagged("base-mainnet", BASE_READS), ...tagged("solana-mainnet", SOL_READS)]);

        // Each result is its own Core result with ONE native class. All three classes are never required in one result.
        const a = nativeView(first.structuredContent, DISCOVERY_BASE.requestId);
        const b = nativeView(second.structuredContent, DISCOVERY_SOLANA.requestId);
        expect(a.view).toEqual(BASE_VIEW);
        expect(b.view).toEqual(SOL_VIEW);
        expect(a.view.classification).not.toBe(b.view.classification);
        expect(a.core.artifactDigest).not.toBe(b.core.artifactDigest);
        expect(a.candidate.snapshotDigest).not.toBe(b.candidate.snapshotDigest);
        expect(JSON.stringify(first.structuredContent.result)).not.toContain(SOL_ID);
        expect(JSON.stringify(second.structuredContent.result)).not.toContain(BASE_ID);

        // Source limits per result, as native capability states.
        // Base: generic EVM resolver, finality and settlement unsupported.
        expect(a.candidate.capabilities.execution.availability).toBe("available");
        expect(a.candidate.capabilities.finality).toMatchObject({ support: "unsupported", availability: "unavailable" });
        expect(a.candidate.capabilities.settlement).toMatchObject({ support: "unsupported", availability: "unavailable" });
        expect(notAvailable(a.candidate.capabilities)).toEqual(expect.arrayContaining([["finality", "unavailable"], ["settlement", "unavailable"]]));
        // Solana: finality only as source-reported finalized commitment; settlement unsupported.
        expect(b.candidate.capabilities.execution.availability).toBe("available");
        expect(b.candidate.capabilities.finality).toMatchObject({
          support: "supported", availability: "available", metadata: { basis: "source_observation" },
        });
        expect(b.candidate.capabilities.settlement).toMatchObject({ support: "unsupported", availability: "unavailable" });
        expect(notAvailable(b.candidate.capabilities)).toEqual([["settlement", "unavailable"]]);

        // No ranking, recommendation, choice or policy in either Discovery output.
        expectNoChoiceSemantics(first.structuredContent);
        expectNoChoiceSemantics(second.structuredContent);

        // (3) The external caller picks its NONFIRST probe network. It checks that
        // the second call answered exactly that probe. Its request was fixed
        // before any call and carries no Discovery digest, snapshot id, request
        // id or class.
        expect(b.candidate.networkId).toBe(CHOSEN.networkId);
        expect(a.candidate.networkId).not.toBe(CHOSEN.networkId);
        expect(JSON.stringify(PREFLIGHT_INPUT)).toBe(PREFLIGHT_INPUT_FIXED);
        const digests = [...stringsOf(first.structuredContent), ...stringsOf(second.structuredContent)].filter(s => s.startsWith("sha256:"));
        expect(digests.length).toBeGreaterThan(4);
        for (const marker of [
          ...digests, a.candidate.snapshotId, b.candidate.snapshotId, DISCOVERY_BASE.requestId, DISCOVERY_SOLANA.requestId,
        ]) expect(PREFLIGHT_INPUT_FIXED).not.toContain(marker);
        expect(PREFLIGHT_INPUT_FIXED).not.toMatch(/eligible|conditional/);

        // (4) Independent preflight on the chosen network: one fresh Solana probe, no Base read.
        const pre = await call(LIVE_PREFLIGHT_TOOL_NAME, PREFLIGHT_INPUT);
        expect(pre.isError).toBeFalsy();
        expect(p.reads.slice(BASE_READS.length + SOL_READS.length)).toEqual(tagged("solana-mainnet", SOL_READS));
        expectChosenSolanaPreflight(pre.structuredContent, b, a);

        // (5) Same-session shared budget: 2 Discovery admissions + 1 preflight; repeats spend the rest.
        for (let n = 4; n <= MULTICHAIN_CALLS_PER_MINUTE; n++) {
          const again = await call(LIVE_PREFLIGHT_TOOL_NAME, PREFLIGHT_INPUT);
          expect(again.content[0].text).toBe(pre.content[0].text);
        }
        const reads = p.reads.length;
        expect(reads).toBe(BASE_READS.length + SOL_READS.length * (MULTICHAIN_CALLS_PER_MINUTE - 1));
        expect(errorCode(await call(LIVE_PREFLIGHT_TOOL_NAME, PREFLIGHT_INPUT))).toBe("MCP_MULTICHAIN_RATE_LIMIT");
        expect(errorCode(await call(LIVE_BEFORE_TOOL_NAME, DISCOVERY_SOLANA))).toBe("MCP_MULTICHAIN_RATE_LIMIT");
        expect(errorCode(await call(LIVE_BEFORE_TOOL_NAME, DISCOVERY_BASE))).toBe("MCP_MULTICHAIN_RATE_LIMIT");
        expect(p.reads).toHaveLength(reads); // no provider read after the budget

        texts.push(JSON.stringify(first.structuredContent), JSON.stringify(second.structuredContent), JSON.stringify(pre.structuredContent));
      });
      for (const text of seen) for (const host of SOURCE_HOSTS) expect(text).not.toContain(host);
      for (const url of p.urls) expect(APPROVED_URLS).toContain(url);
      outputs.push(texts);
    }
    // Both pinned eras serve the same surface and the same native artifacts byte for byte.
    expect(surfaces).toHaveLength(2);
    expect(surfaces[1]).toBe(surfaces[0]);
    expect(outputs).toHaveLength(2);
    expect(outputs[1]).toEqual(outputs[0]);
    expect(globalFetchAttempts).toBe(0);
  }, 60_000);

  it("SIMULATED absent Base subject and SIMULATED Solana outage, legacy and modern eras: Discovery says ineligible without relabeling; the caller's preflight on it, and on an unavailable chosen source, is MCP_LIVE_PREFLIGHT_UNAVAILABLE, never blocked or finality", async () => {
    for (const era of ERAS) {
      const p = provider();
      const seen = await hostedSession(era, p.fetchFn, async (call) => {
        // FIRST Discovery call: the SIMULATED absent Base subject only.
        const first = await call(LIVE_BEFORE_TOOL_NAME, DISCOVERY_ABSENT);
        expect(first.isError).toBeFalsy();
        expect(p.reads).toEqual(tagged("base-mainnet", NULL_BASE_READS));
        const a = nativeView(first.structuredContent, DISCOVERY_ABSENT.requestId);
        expect(a.view).toEqual(ABSENT_VIEW);
        expect(a.candidate.capabilities.execution.availability).toBe("unavailable");
        expect(a.candidate.capabilities.finality).toMatchObject({ support: "unsupported", availability: "unavailable" });
        expect(notAvailable(a.candidate.capabilities)).toEqual(expect.arrayContaining([["execution", "unavailable"]]));
        // Never relabeled as the real captured transaction: no block capture, no real-hash pairing.
        expect(a.view.reads).not.toContain("eth_getBlockByHash");
        expect(JSON.stringify(first.structuredContent)).not.toContain(F1.subject.txHash);
        expectNoChoiceSemantics(first.structuredContent);
        expect(JSON.stringify(first.structuredContent)).not.toMatch(/blocked/i);

        // SECOND separate Discovery call: the real Solana probe stays eligible in its own result.
        const second = await call(LIVE_BEFORE_TOOL_NAME, DISCOVERY_SOLANA);
        expect(second.isError).toBeFalsy();
        const b = nativeView(second.structuredContent, DISCOVERY_SOLANA.requestId);
        expect(b.view).toEqual(SOL_VIEW);
        expect(a.view.classification).not.toBe(b.view.classification);

        // The caller still chooses Base with the absent probe: the probe is unavailable, NOT a blocked network.
        let mark = p.reads.length;
        const absent = await call(LIVE_PREFLIGHT_TOOL_NAME, ABSENT_PREFLIGHT_INPUT);
        expect(errorCode(absent)).toBe("MCP_LIVE_PREFLIGHT_UNAVAILABLE");
        expect(absent.content[0].text).not.toMatch(/blocked|contradicted|not_applicable|ineligible|final|\bready\b/i);
        expect(p.reads.slice(mark)).toEqual(tagged("base-mainnet", NULL_BASE_READS));

        // The same session's nonfirst Solana choice is unaffected.
        mark = p.reads.length;
        const pre = await call(LIVE_PREFLIGHT_TOOL_NAME, PREFLIGHT_INPUT);
        expect(pre.isError).toBeFalsy();
        expect(p.reads.slice(mark)).toEqual(tagged("solana-mainnet", SOL_READS));
        expect(pre.structuredContent).toMatchObject({ choiceSource: "caller", selectedNetworkId: SOL_ID, probeSubject: SOL_SUBJECT });
        expect(decodeNecWireJson("preflight-result", JSON.stringify(pre.structuredContent.preflight)).status).toBe("ready");

        // SIMULATED outage of the chosen source: fail closed, no readiness or blocked verdict.
        p.state.solanaDown = true;
        mark = p.reads.length;
        const down = await call(LIVE_PREFLIGHT_TOOL_NAME, PREFLIGHT_INPUT);
        expect(errorCode(down)).toBe("MCP_LIVE_PREFLIGHT_UNAVAILABLE");
        expect(down.content[0].text).not.toMatch(/blocked|contradicted|not_applicable|ineligible|final|\bready\b/i);
        const outageReads = p.reads.slice(mark);
        expect(outageReads.length).toBeGreaterThanOrEqual(1);
        expect(outageReads.length).toBeLessThanOrEqual(SOL_READS.length);
        for (const read of outageReads) expect(read.startsWith("solana-mainnet:")).toBe(true);
      });
      for (const text of seen) for (const host of SOURCE_HOSTS) expect(text).not.toContain(host);
      for (const url of p.urls) expect(APPROVED_URLS).toContain(url);
    }
    expect(globalFetchAttempts).toBe(0);
  }, 60_000);

  it("unapproved RPC endpoints and network ids never succeed: strict hosted inputs are refused before any read, and both fixed-source guards reject foreign URLs and foreign response origins; the poisoned global fetch is never used", async () => {
    for (const era of ERAS) {
      const p = provider();
      await hostedSession(era, p.fetchFn, async (call) => {
        refused(await call(LIVE_PREFLIGHT_TOOL_NAME, { ...PREFLIGHT_INPUT, rpcUrl: "https://rpc.attacker.example/" }));
        refused(await call(LIVE_PREFLIGHT_TOOL_NAME, { ...PREFLIGHT_INPUT, selectedNetworkId: "eip155:1" }));
        refused(await call(LIVE_BEFORE_TOOL_NAME, { ...DISCOVERY_SOLANA, rpcUrl: "https://rpc.attacker.example/" }));
        refused(await call(LIVE_BEFORE_TOOL_NAME, { ...DISCOVERY_SOLANA, subjects: [{ ...SOL_SUBJECT, networkId: "eip155:1" }] }));
        refused(await call(LIVE_BEFORE_TOOL_NAME, { ...DISCOVERY_SOLANA, subjects: [{ ...SOL_SUBJECT, url: "https://rpc.attacker.example/" }] }));
      });
      expect(p.reads).toHaveLength(0);
      expect(p.urls.size).toBe(0);
    }

    const FOREIGN = "https://rpc.attacker.example/";
    let innerCalls = 0;
    const foreignOrigin = (async () => {
      innerCalls += 1;
      const response = new Response('{"jsonrpc":"2.0","id":1,"result":"0x2105"}', { status: 200, headers: { "content-type": "application/json" } });
      Object.defineProperty(response, "url", { value: FOREIGN });
      return response;
    }) as typeof fetch;
    const solana = restrictedSolanaRpcFetch(foreignOrigin, "solana-mainnet");
    const solBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getGenesisHash", params: [] });
    await expect(solana(FOREIGN, { method: "POST", body: solBody })).rejects.toMatchObject({ code: "MCP_MULTICHAIN_SOURCE_FAILED" });
    expect(innerCalls).toBe(0);
    await expect(solana(SOL_URL, { method: "POST", body: solBody })).rejects.toMatchObject({ code: "MCP_MULTICHAIN_SOURCE_FAILED" });
    expect(innerCalls).toBe(1);

    const base = restrictedBaseRpcFetch(foreignOrigin, "base-mainnet");
    const baseBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] });
    await expect(base(FOREIGN, { method: "POST", body: baseBody })).rejects.toMatchObject({ code: "MCP_LIVE_EVM_RPC_FAILED" });
    expect(innerCalls).toBe(1);
    await expect(base(BASE_URL, { method: "POST", body: baseBody })).rejects.toMatchObject({ code: "MCP_LIVE_EVM_RPC_FAILED" });
    expect(innerCalls).toBe(2);

    expect(globalFetchAttempts).toBe(0);
  }, 60_000);
});
