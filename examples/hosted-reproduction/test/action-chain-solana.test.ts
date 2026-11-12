/**
 * Solana parity of the GT-02 action chain (test-only; examples-only; closes no
 * gate row; GT-02 stays OPEN):
 *   capture-action --mode resolve -> verify-evidence-result CLI -> build-action-case
 * on solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp / 4DYWUMEx…LF71.
 *
 * Every MCP call goes to a LOOPBACK hosted-mode server (startNeMcpHttpServer,
 * SIMULATED public Host header, test-only helper). Its live tools read a fake
 * provider that serves only declared reads: the checked-in real Solana mainnet
 * capture (resolver-solana solana-mainnet-x402-real.json), matched by exact
 * method and params at https://api.mainnet-beta.solana.com/ only, and, for the
 * single Base pairing negative, the checked-in real F1 x402 #1062 Base capture
 * at https://mainnet.base.org/ only. Any other URL or read throws. Global fetch
 * throws and is counted.
 *
 * Clock: SIMULATED_REPLAY_CLOCK. Only Date is faked, only while capturing.
 *  - The positive BEFORE is TEST-DERIVED, as in verify-evidence-result.test.ts:204-213:
 *    createMultichainTool over a SIMULATED null Solana answer at 2026-05-10T20:00:00.000Z
 *    (before the subject block, 2026-05-10T20:29:19Z), then deriveSolanaBeforePreflightResult.
 *    It is SIMULATED, fixedBeforeExecution:false, and not a genuine caller action
 *    fixed before execution. The preflight request is TEST-AUTHORED.
 *  - The resolve runs at the fixture's recorded acquisition time 2026-08-26T20:01:41.884Z.
 *  - The provider REFUSES to serve recorded Solana bytes under any clock earlier than
 *    the block time. Under the pre-block clock the SIMULATED null answers are served
 *    instead: getTransaction null, getSignatureStatuses value [null] (the recorded RPC
 *    context envelope is kept, as in the reference derivation), and getGenesisHash.
 *    getGenesisHash is the network identity constant; it carries no subject bytes.
 *  - A served Solana preflight is only ever a NEGATIVE. No second, older real Solana
 *    capture exists, so no served positive Solana preflight exists.
 * The efda0ca-shaped AFTER-only context (here with the Solana subject) is refused and
 * never verified. No EVM bytes are relabelled.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { canonicalJsonBytes, computeEvidencePolicyDigest, decodeNecWireJson, encodeNecWireJson } from "@nec/core";
import type { EvidencePolicy, EvidenceRequest, NecWireType, PolicyDimension, PreflightRequest } from "@nec/core";
import { validateLensBrowserSafeCaseV01 } from "@nec/lens";
import { createMultichainTool, startNeMcpHttpServer } from "@nec/mcp";
import { exchangeIdentityKey } from "@nec/resolver-evm";
import { deriveSolanaBeforePreflightResult } from "@nec/resolver-solana";

// Test-only imports of server source for the SIMULATED BEFORE derivation (as in
// verify-evidence-result.test.ts). The verifier and the builder never import them.
import { foundationFromObservation } from "../../../packages/mcp/src/live-before.js";
import type { TransactionSubject } from "../../../packages/mcp/src/live-multichain.js";
import { simulatedHostFetch } from "../../../packages/mcp/test/helpers.js";
import { validateNeMapsCollectionV01 } from "../../ne-maps/collection.js";
import {
  ACTION_CASE_BUILD_SCHEMA, ANCHOR_ACCEPTANCE, COMPOSITION_RULE, CONTINUITY_LIMITATION, GATE_ROW, HOSTED_LABEL, LOOPBACK_LABEL,
  main as buildMain,
} from "../build-action-case.js";
import { ACTION_CAPTURE_TOOLS, evidenceContextSha256, main as captureMain } from "../capture-action.js";
import { EVIDENCE_RESULT_NON_CLAIMS, main as verifyMain, verifyEvidenceResultEnvelope } from "../verify-evidence-result.js";

/** Counts Hub admissions made through the public @nec/hub entry point (the builder's). */
const hubCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock("@nec/hub", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@nec/hub")>();
  return {
    ...actual,
    normalizeNetworkEvidenceV01: (input: Parameters<typeof actual.normalizeNetworkEvidenceV01>[0]) => {
      hubCalls.count += 1;
      return actual.normalizeNetworkEvidenceV01(input);
    },
  };
});

interface Capture { rpcMethod: string; rpcParams: unknown[]; resultJson: string }
const load = (path: string): any => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const solRaw = load("../../../packages/resolver-solana/test/fixtures/solana-mainnet-x402-real.json");
const probeRaw = load(
  "../../historical-compat/authority/fixtures/F1-x402-1062-partial/source/network-evidence/fixtures/base-mainnet-x402-1062-usdc-transfer.fixture.json");
const solCapture = (method: string): Capture => (solRaw.captures as Capture[]).find((c) => c.rpcMethod === method)!;

const ORIGIN = "https://mcp.example.org";
const HOST = "mcp.example.org";
const SOL_URL = "https://api.mainnet-beta.solana.com/";
const BASE_URL = "https://mainnet.base.org/";
const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" as const;
const BASE = "eip155:8453" as const;
const SOL_SUBJECT: TransactionSubject = { type: "transaction", networkId: SOL, txId: solRaw.subject.signature };
const EVM_PROBE: TransactionSubject = { type: "transaction", networkId: BASE, txId: probeRaw.subject.txHash };

const SOL_PREFLIGHT_AT = "2026-05-10T20:00:00.000Z";
const SOL_BLOCK_AT = "2026-05-10T20:29:19.000Z"; // blockTime 1778444959
const SOL_AFTER_AT = "2026-08-26T20:01:41.884Z"; // recorded acquisition time of the Solana fixture
const SOL_BLOCK_MS = Date.parse(SOL_BLOCK_AT);
/** Base preflight clock of the sibling tests (only for the Base pairing negative). */
const BASE_PREFLIGHT_AT = "2026-10-09T15:00:00.000Z";
/** The label of the only positive BEFORE in this file; it is not a genuine pre-execution fix. */
const SIMULATED_REPLAY_CLOCK = Object.freeze({
  clock: "SIMULATED_REPLAY_CLOCK", before: "SIMULATED null pre-execution Solana probe (test-derived)",
  preflightAt: SOL_PREFLIGHT_AT, resolveAt: SOL_AFTER_AT, fixedBeforeExecution: false,
} as const);

/** The subject's own recorded bytes that must never be served before the block time. */
const SUBJECT_TX = JSON.parse(solCapture("getTransaction").resultJson) as { slot: number; blockTime: number };
const SUBJECT_BLOCK = JSON.parse(solCapture("getBlock").resultJson) as { blockhash: string; blockTime: number };

/** Lens construction time, given on the command line; never a clock read. */
const CREATED_AT = "2026-11-03T00:00:00.000Z";
const CASE_ID = "ne-l045-solana-action-case";

/** Test-authored private strings. */
const SOL_ACCOUNT = "NeL045TestAuthoredSolanaAccount7c1e";
const PREFLIGHT_NOTE = "ne-l045-private-preflight-note-5a2d";
const RESULT_NOTE = "ne-l045-private-result-note-e93b";
const PREFLIGHT_REQUEST_ID = "ne-l045-caller-preflight";
const RESULT_REQUEST_ID = "ne-l045-caller-result";

const SOL_ACTION = { kind: "spl_token.transfer_checked", target: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", fields: { expectedAmount: "5000" } };
const EVM_ACTION = { kind: "evm.transaction", target: "0x4200000000000000000000000000000000000015", fields: { expectedStatus: "success" } };
function policyOf(content: Omit<EvidencePolicy, "digest">): EvidencePolicy {
  return { ...content, digest: computeEvidencePolicyDigest(content) };
}
const SOL_POLICY = policyOf({
  id: "ne-l045-policy", version: "1", requiredDimensions: ["execution", "finality"] as PolicyDimension[], desiredDimensions: [],
});
const BASE_POLICY = policyOf({
  id: "ne-l045-base-policy", version: "1", requiredDimensions: ["execution", "dataBinding"] as PolicyDimension[],
});

const wire = (type: NecWireType, value: unknown): Record<string, unknown> => JSON.parse(encodeNecWireJson(type, value)) as Record<string, unknown>;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const at = (iso: string): void => { vi.setSystemTime(new Date(iso)); };
/** Key-order-independent JSON, for exact params matching. */
const stable = (value: unknown): string => JSON.stringify(value, (_key, v: unknown) => (
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : v));

/** TEST-AUTHORED caller PreflightRequest for the Solana subject. */
function solPreflightRequest(): PreflightRequest {
  return {
    schemaVersion: "0.1", requestId: PREFLIGHT_REQUEST_ID, networkId: SOL, account: SOL_ACCOUNT,
    action: SOL_ACTION, evidencePolicy: SOL_POLICY, metadata: { callerNote: PREFLIGHT_NOTE },
  };
}
/** TEST-AUTHORED caller request file for a SERVED Solana preflight (negatives only). */
function solPreflightArguments(): Record<string, unknown> {
  return { selectedNetworkId: SOL, probeSubject: { ...SOL_SUBJECT }, request: solPreflightRequest() };
}
/** TEST-AUTHORED Base request file, for the Base pairing negative only. */
function basePreflightArguments(): Record<string, unknown> {
  return {
    selectedNetworkId: BASE, probeSubject: { ...EVM_PROBE },
    request: { schemaVersion: "0.1", requestId: "ne-l045-base-preflight", networkId: BASE, action: EVM_ACTION, evidencePolicy: BASE_POLICY },
  };
}

/** GT-02 step 6 shape (TEST-AUTHORED): the EvidenceRequest over a preflight and its capability snapshot. */
function contextOver(preflight: Record<string, unknown>, capabilitySnapshot: Record<string, unknown>): Record<string, any> {
  const decoded = decodeNecWireJson("preflight-result", JSON.stringify(preflight));
  const request: EvidenceRequest = {
    schemaVersion: "0.1", requestId: RESULT_REQUEST_ID, networkId: SOL,
    subject: { type: "transaction", networkId: SOL, txId: SOL_SUBJECT.txId },
    action: decoded.request.action, evidencePolicy: decoded.request.evidencePolicy,
    preflight: { requestId: decoded.request.requestId, digest: decoded.artifactDigest },
    metadata: { callerNote: RESULT_NOTE },
  };
  return { request: wire("evidence-request", request), preflight, capabilitySnapshot };
}

/** efda0ca-shaped (Solana subject): AFTER-only, no preflight, policy authored after the block. */
function efdaContext(): Record<string, unknown> {
  const request: EvidenceRequest = {
    schemaVersion: "0.1", requestId: "efda0ca-shaped", networkId: SOL,
    subject: { type: "transaction", networkId: SOL, txId: SOL_SUBJECT.txId },
    action: SOL_ACTION,
    evidencePolicy: policyOf({
      id: "efda0ca-shaped-policy", version: "2026-10-26", requiredDimensions: ["execution", "observedEffects"] as PolicyDimension[],
      rules: { authoredAt: "2026-10-26T00:00:00.000Z" },
    }),
  };
  return { request: wire("evidence-request", request) };
}

type ServedKind = "recorded" | "simulated_null" | "network_identity" | "recorded_base";
interface Served { readonly url: string; readonly method: string; readonly at: number; readonly kind: ServedKind; readonly body: string }
/** Every answer any fake provider of this file served, with the (faked) clock it was served under. */
const served: Served[] = [];

interface ProviderOptions {
  /** recorded: the real Solana bytes, refused before the block time; simulated_null: the SIMULATED pre-execution answers. */
  readonly solana?: "recorded" | "simulated_null";
  /** The real F1 x402 #1062 Base capture, exact method+params, at the Base URL only. */
  readonly base?: true;
}

/** Declared reads only; any other URL, method or params throws before anything is served. */
function provider(options: ProviderOptions): typeof fetch {
  const baseQueues = new Map<string, Capture[]>();
  if (options.base === true) {
    for (const capture of probeRaw.captures as Capture[]) {
      const key = exchangeIdentityKey(capture.rpcMethod, capture.rpcParams);
      baseQueues.set(key, [...(baseQueues.get(key) ?? []), capture]);
    }
  }
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).href;
    const solana = url === SOL_URL && options.solana !== undefined;
    const base = url === BASE_URL && options.base === true;
    if (!solana && !base) throw new Error("undeclared destination");
    const query = JSON.parse(String(init?.body)) as { id: number; method: string; params?: unknown[] };
    const now = Date.now();
    let resultText: string;
    let kind: ServedKind;
    if (solana) {
      const found = (solRaw.captures as Capture[])
        .find((c) => c.rpcMethod === query.method && stable(c.rpcParams) === stable(query.params ?? []));
      if (found === undefined) throw new Error("undeclared Solana read");
      if (options.solana === "recorded") {
        if (now < SOL_BLOCK_MS) throw new Error("recorded Solana bytes before the block time");
        resultText = found.resultJson;
        kind = "recorded";
      } else if (query.method === "getGenesisHash") {
        resultText = found.resultJson;
        kind = "network_identity";
      } else if (query.method === "getTransaction" || query.method === "getBlock") {
        resultText = "null";
        kind = "simulated_null";
      } else if (query.method === "getSignatureStatuses") {
        const result = JSON.parse(found.resultJson) as { value: unknown[] };
        result.value = [null];
        resultText = JSON.stringify(result);
        kind = "simulated_null";
      } else throw new Error("undeclared Solana read");
    } else {
      const capture = baseQueues.get(exchangeIdentityKey(query.method, query.params ?? []))?.shift();
      if (capture === undefined) throw new Error("undeclared Base read");
      resultText = capture.resultJson;
      kind = "recorded_base";
    }
    const body = `{"jsonrpc":"2.0","id":${JSON.stringify(query.id)},"result":${resultText}}`;
    served.push({ url, method: query.method, at: now, kind, body });
    const response = new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    Object.defineProperty(response, "url", { value: url });
    return response;
  };
}

/** One fresh hosted-mode loopback server per capture; records the JSON-RPC methods POSTed to it. */
async function withServer<T>(fetchFn: typeof fetch, fn: (url: string, mcpFetch: typeof fetch, posts: string[]) => Promise<T>): Promise<T> {
  const server = await startNeMcpHttpServer({
    host: "127.0.0.1", port: 0, hosted: { publicOrigin: ORIGIN }, liveEvidence: createMultichainTool(fetchFn),
  });
  try {
    const inner = simulatedHostFetch(server.port, HOST);
    const posts: string[] = [];
    const counting: typeof fetch = async (input, init) => {
      if (init?.method === "POST") posts.push(String((JSON.parse(String(init.body)) as { method?: unknown }).method));
      return inner(input, init);
    };
    return await fn(`http://127.0.0.1:${server.port}/mcp`, counting, posts);
  } finally {
    await server.close();
  }
}

/** SIMULATED_REPLAY_CLOCK pre-execution Solana probe (verify-evidence-result.test.ts:204-213): the source does not know the signature yet. */
async function solanaContext(): Promise<Record<string, any>> {
  at(SOL_PREFLIGHT_AT);
  const probe = await createMultichainTool(provider({ solana: "simulated_null" }))({ subject: SOL_SUBJECT });
  expect(probe.acquisition).toMatchObject({ transactionObserved: false, blockObserved: false });
  const source = foundationFromObservation(probe);
  if (source.family !== "solana") throw new Error("expected the Solana BEFORE foundation");
  const preflight = deriveSolanaBeforePreflightResult(source.foundation, solPreflightRequest());
  return contextOver(wire("preflight-result", preflight), wire("capability-snapshot", source.foundation.snapshot));
}

async function stdoutOf<T>(fn: () => Promise<T>): Promise<{ value: T; text: string }> {
  const printed: string[] = [];
  const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    printed.push(String(chunk));
    return true;
  });
  try {
    const value = await fn();
    return { value, text: printed.join("") };
  } finally {
    write.mockRestore();
  }
}
async function verifyCli(argv: string[]): Promise<{ code: number; text: string; out: any }> {
  const { value, text } = await stdoutOf(() => verifyMain(argv));
  return { code: value, text, out: JSON.parse(text) };
}
async function buildCli(argv: string[]): Promise<{ code: number; text: string; out: any }> {
  const { value, text } = await stdoutOf(() => buildMain(argv));
  return { code: value, text, out: JSON.parse(text) };
}
async function captureCli(argv: string[], fetchFn: typeof fetch): Promise<number> {
  return (await stdoutOf(() => captureMain(argv, { fetch: fetchFn }))).value;
}

const toolCalls = (posts: readonly string[]) => posts.filter((method) => method === "tools/call").length;
const decodePreflight = (context: any) => decodeNecWireJson("preflight-result", JSON.stringify(context.preflight));
const decodeFragment = (envelope: any) => decodeNecWireJson("network-evidence-fragment", JSON.stringify(envelope.fragment));
const errorCode = (call: any): string => (JSON.parse(call.content[0].text) as { error: { code: string } }).error.code;

/** Every string of a JSON value with the key it sits under. */
function stringsOf(value: unknown, parent: string, out: [string, string][] = []): [string, string][] {
  if (typeof value === "string") out.push([parent, value]);
  else if (Array.isArray(value)) for (const item of value) stringsOf(item, parent, out);
  else if (value !== null && typeof value === "object") for (const [key, item] of Object.entries(value)) stringsOf(item, key, out);
  return out;
}

const MAPS_COLLECTION = new URL("../../ne-maps/data/collection.json", import.meta.url);
const MAPS_COLLECTION_SHA = new URL("../../ne-maps/data/COLLECTION.sha256", import.meta.url);
const SOURCE_DIR = new URL("../", import.meta.url);
const sourceFiles = (): string[] => readdirSync(SOURCE_DIR).filter((name) => /\.(ts|md)$/.test(name)).sort();

const realFetch = globalThis.fetch;
let globalFetchCalls = 0;
let dir = "";
let outCount = 0;
const file = (name: string) => join(dir, name);
const freshOut = () => file(`case-${++outCount}.json`);
const caseArgs = (out: string) => ["--case-id", CASE_ID, "--created-at", CREATED_AT, "--out", out];
const fx: Record<string, any> = {};

beforeAll(async () => {
  fx.mapsCollectionBytes = readFileSync(MAPS_COLLECTION);
  fx.mapsCollectionShaBytes = readFileSync(MAPS_COLLECTION_SHA);
  fx.sourceBytes = new Map(sourceFiles().map((name) => [name, readFileSync(new URL(name, SOURCE_DIR))]));
  dir = mkdtempSync(join(tmpdir(), "ne-action-chain-solana-"));
  globalThis.fetch = (async () => {
    globalFetchCalls += 1;
    throw new Error("global fetch is denied in action-chain-solana tests");
  }) as typeof fetch;
  // Only Date is faked, only while capturing; setTimeout, AbortSignal.timeout and HTTP stay real.
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    // Positive BEFORE: test-derived SIMULATED null probe, no server.
    let mark = served.length;
    fx.context = await solanaContext();
    fx.nullProbeServed = served.slice(mark);
    fx.contextText = `${JSON.stringify(fx.context, null, 2)}\n`;
    writeFileSync(file("evidence-context.json"), fx.contextText);

    // GT-02 step 7 shape: the resolve through the capture CLI, at the recorded clock.
    at(SOL_AFTER_AT);
    mark = served.length;
    fx.resolveCode = await withServer(provider({ solana: "recorded" }), async (url, fetchFn, posts) => {
      const code = await captureCli([
        "--mode", "resolve", "--url", url, "--network-id", SOL, "--tx-id", SOL_SUBJECT.txId,
        "--context", file("evidence-context.json"), "--out", file("resolve-capture.json"),
      ], fetchFn);
      fx.resolvePosts = [...posts];
      return code;
    });
    fx.resolveServed = served.slice(mark);
    fx.resolveText = readFileSync(file("resolve-capture.json"), "utf8");
    fx.resolveCapture = JSON.parse(fx.resolveText);

    // (b) SERVED Solana null-probe preflight at the pre-block clock: SIMULATED null answers only.
    writeFileSync(file("sol-preflight-arguments.json"), JSON.stringify(solPreflightArguments(), null, 2));
    at(SOL_PREFLIGHT_AT);
    mark = served.length;
    fx.nullPreflightCode = await withServer(provider({ solana: "simulated_null" }), async (url, fetchFn, posts) => {
      const code = await captureCli([
        "--mode", "preflight", "--url", url, "--request", file("sol-preflight-arguments.json"),
        "--out", file("null-preflight-capture.json"),
      ], fetchFn);
      fx.nullPreflightPosts = [...posts];
      return code;
    });
    fx.nullPreflightServed = served.slice(mark);
    fx.nullPreflightCapture = JSON.parse(readFileSync(file("null-preflight-capture.json"), "utf8"));

    // (c) SERVED real-bytes Solana preflight at the recorded clock (after the block), used as the context preflight.
    at(SOL_AFTER_AT);
    mark = served.length;
    fx.latePreflightCode = await withServer(provider({ solana: "recorded" }), (url, fetchFn) => captureCli([
      "--mode", "preflight", "--url", url, "--request", file("sol-preflight-arguments.json"),
      "--out", file("late-preflight-capture.json"),
    ], fetchFn));
    fx.latePreflightServed = served.slice(mark);
    fx.latePreflightCapture = JSON.parse(readFileSync(file("late-preflight-capture.json"), "utf8"));
    const lateEnv = fx.latePreflightCapture.call.structuredContent;
    fx.lateContext = contextOver(lateEnv.preflight, lateEnv.capabilitySnapshot);
    writeFileSync(file("late-context.json"), JSON.stringify(fx.lateContext, null, 2));
    fx.lateResolveCode = await withServer(provider({ solana: "recorded" }), (url, fetchFn) => captureCli([
      "--mode", "resolve", "--url", url, "--network-id", SOL, "--tx-id", SOL_SUBJECT.txId,
      "--context", file("late-context.json"), "--out", file("late-resolve-capture.json"),
    ], fetchFn));
    fx.lateResolveCapture = JSON.parse(readFileSync(file("late-resolve-capture.json"), "utf8"));

    // (d) A Base preflight capture (real F1 bytes at the Base URL only), for pairing with the Solana resolve.
    writeFileSync(file("base-preflight-arguments.json"), JSON.stringify(basePreflightArguments(), null, 2));
    at(BASE_PREFLIGHT_AT);
    mark = served.length;
    fx.basePreflightCode = await withServer(provider({ base: true }), (url, fetchFn) => captureCli([
      "--mode", "preflight", "--url", url, "--request", file("base-preflight-arguments.json"),
      "--out", file("base-preflight-capture.json"),
    ], fetchFn));
    fx.basePreflightServed = served.slice(mark);
    fx.basePreflightCapture = JSON.parse(readFileSync(file("base-preflight-capture.json"), "utf8"));

    // (e) efda0ca-shaped AFTER-only context (Solana subject), through the capture CLI.
    writeFileSync(file("efda-context.json"), JSON.stringify(efdaContext()));
    at(SOL_AFTER_AT);
    mark = served.length;
    fx.efdaCode = await withServer(provider({ solana: "recorded" }), async (url, fetchFn, posts) => {
      const code = await captureCli([
        "--mode", "resolve", "--url", url, "--network-id", SOL, "--tx-id", SOL_SUBJECT.txId,
        "--context", file("efda-context.json"), "--out", file("efda-capture.json"),
      ], fetchFn);
      fx.efdaPosts = [...posts];
      return code;
    });
    fx.efdaServed = served.slice(mark);
    fx.efdaCapture = JSON.parse(readFileSync(file("efda-capture.json"), "utf8"));
  } finally {
    vi.useRealTimers();
  }
  // (a) One changed context value (same capture).
  const changed = clone(fx.context);
  changed.request.metadata.callerNote = `${RESULT_NOTE}x`;
  writeFileSync(file("context-changed.json"), JSON.stringify(changed, null, 2));
}, 120_000);

afterAll(() => {
  globalThis.fetch = realFetch;
  if (dir !== "") rmSync(dir, { recursive: true, force: true });
});

describe("Solana action chain: capture-action resolve -> verify CLI -> build-action-case (loopback only; GT-02 stays OPEN)", () => {
  const base = () => ["--capture", file("resolve-capture.json"), "--context", file("evidence-context.json")];

  it("BEFORE: the context preflight is the test-derived SIMULATED null probe at 2026-05-10T20:00:00.000Z, fixedBeforeExecution false", () => {
    expect(SIMULATED_REPLAY_CLOCK.fixedBeforeExecution).toBe(false);
    expect(SIMULATED_REPLAY_CLOCK.clock).toBe("SIMULATED_REPLAY_CLOCK");
    expect(SOL_SUBJECT.txId.startsWith("4DYWUMEx")).toBe(true);
    expect(SOL_SUBJECT.txId.endsWith("LF71")).toBe(true);
    expect(solRaw.acquiredAt).toBe(SOL_AFTER_AT);
    expect(SUBJECT_TX.blockTime * 1000).toBe(SOL_BLOCK_MS);
    expect(SUBJECT_BLOCK.blockTime * 1000).toBe(SOL_BLOCK_MS);
    const preflight = decodePreflight(fx.context);
    expect(preflight.generatedAt).toBe(SOL_PREFLIGHT_AT);
    expect(Date.parse(preflight.generatedAt)).toBeLessThan(SOL_BLOCK_MS);
    expect(Date.parse(SOL_AFTER_AT)).toBeGreaterThan(SOL_BLOCK_MS);
    expect(preflight.request).toMatchObject({
      requestId: PREFLIGHT_REQUEST_ID, networkId: SOL, account: SOL_ACCOUNT, action: SOL_ACTION, metadata: { callerNote: PREFLIGHT_NOTE },
    });
    expect(preflight.request.evidencePolicy.digest).toBe(SOL_POLICY.digest);
    // The null probe saw no transaction and no block: SIMULATED answers, never the subject's bytes.
    expect(fx.nullProbeServed.map((s: Served) => [s.method, s.kind, s.at])).toEqual([
      ["getGenesisHash", "network_identity", Date.parse(SOL_PREFLIGHT_AT)],
      ["getTransaction", "simulated_null", Date.parse(SOL_PREFLIGHT_AT)],
      ["getSignatureStatuses", "simulated_null", Date.parse(SOL_PREFLIGHT_AT)],
    ]);
    expect(globalFetchCalls).toBe(0);
  });

  it("capture-action --mode resolve: one tools/call; arguments {subject} only; contextSha256 over canonicalJsonBytes; no context string leaks", () => {
    expect(fx.resolveCode).toBe(0);
    expect(toolCalls(fx.resolvePosts)).toBe(1);
    const capture = fx.resolveCapture;
    expect(capture).toMatchObject({ mode: "resolve", loopback: true, acquiringExecutable: null });
    expect(new URL(capture.target).hostname).toBe("127.0.0.1");
    expect(Object.keys(capture.call).sort()).toEqual(["arguments", "contextSha256", "isError", "structuredContent", "tool"]);
    expect(capture.call.tool).toBe(ACTION_CAPTURE_TOOLS.resolve);
    expect(capture.call.arguments).toEqual({ subject: SOL_SUBJECT });
    expect(capture.call.isError).toBe(false);
    const expected = `sha256:${createHash("sha256").update(canonicalJsonBytes(fx.context)).digest("hex")}`;
    expect(capture.call.contextSha256).toBe(expected);
    expect(capture.call.contextSha256).toBe(evidenceContextSha256(fx.context));
    expect(capture.call.structuredContent.evidenceResult.status).toBe("composed");
    expect(capture.call.structuredContent.subject).toEqual(SOL_SUBJECT);
    // The four recorded Solana reads, served at the recorded clock only.
    expect(fx.resolveServed.map((s: Served) => [s.url, s.method, s.kind, s.at])).toEqual(
      ["getGenesisHash", "getTransaction", "getSignatureStatuses", "getBlock"].map((m) => [SOL_URL, m, "recorded", Date.parse(SOL_AFTER_AT)]));

    const preflight = decodePreflight(fx.context);
    const snapshot = decodeNecWireJson("capability-snapshot", JSON.stringify(fx.context.capabilitySnapshot));
    const privateStrings = [
      SOL_ACCOUNT, PREFLIGHT_NOTE, RESULT_NOTE, PREFLIGHT_REQUEST_ID, preflight.artifactDigest, preflight.generatedAt, snapshot.artifactDigest,
    ];
    for (const secret of privateStrings) {
      expect([secret, fx.contextText.includes(secret)]).toEqual([secret, true]); // positive control
      expect([secret, fx.resolveText.includes(secret)]).toEqual([secret, false]);
    }
    expect(globalFetchCalls).toBe(0);
  });

  it("verify CLI: exit 0 verified/composed_result_verified, anchor not_applicable, fixedBeforeExecution false; two runs byte-identical", async () => {
    const runs = [await verifyCli(base()), await verifyCli(base())];
    expect(runs[1]!.text).toBe(runs[0]!.text);
    const run = runs[0]!;
    expect(run.code).toBe(0);
    const recorded = fx.resolveCapture.call.contextSha256;
    expect(run.out).toMatchObject({
      schema: "ne-hosted-evidence-result-cli-report/v0.1", requireAnchored: false, acquiringExecutable: null,
      contextSha256: { recorded, recomputed: recorded, match: true }, preflightAnchor: null,
      exitCode: 0, exitReason: "composed_result_verified",
    });
    expect(run.out.report).toMatchObject({
      status: "verified", reason: "composed_result_verified", stage: "composition", servedStatus: "composed",
      expectedOutcome: "composable", fixedBeforeExecution: false,
      resultArtifactDigest: fx.resolveCapture.call.structuredContent.evidenceResult.result.artifactDigest,
    });
    expect(run.out.report.anchor).toMatchObject({ status: "not_applicable", reason: "non_evm_subject", fixedBeforeExecution: false });
    expect(run.text).not.toMatch(/"fixedBeforeExecution":\s*true/);
    expect(globalFetchCalls).toBe(0);
  });

  it("--require-anchored: verify exit 1 not_anchored; the builder exits 1 and writes nothing", async () => {
    const argv = [...base(), "--require-anchored"];
    const verify = await verifyCli(argv);
    expect([verify.code, verify.out.exitReason, verify.out.report.status]).toEqual([1, "not_anchored", "verified"]);
    expect(verify.out.report.anchor.status).toBe("not_applicable");
    const out = freshOut();
    hubCalls.count = 0;
    const build = await buildCli([...argv, ...caseArgs(out)]);
    expect([build.code, build.out.exitReason, build.out.written, build.out.hosted]).toEqual([1, "not_anchored", false, null]);
    expect(build.out.verification).toEqual(verify.out);
    expect([existsSync(out), hubCalls.count]).toEqual([false, 0]);
    expect(globalFetchCalls).toBe(0);
  });

  it("builder positive: exit 0; both validators pass; Core digests preserved; settlement unknown; finality never stronger; anchor not_applicable", async () => {
    const out = freshOut();
    hubCalls.count = 0;
    const run = await buildCli([...base(), ...caseArgs(out)]);
    expect(run.code).toBe(0);
    expect(run.out).toMatchObject({
      schema: ACTION_CASE_BUILD_SCHEMA, hosted: "loopback", exitCode: 0, exitReason: "composed_result_verified", written: true,
    });
    expect(run.out.verification).toEqual((await verifyCli(base())).out);
    expect(hubCalls.count).toBe(1); // positive control for the no-Hub-call negatives

    const text = readFileSync(out, "utf8");
    const collection = JSON.parse(text);
    expect(validateNeMapsCollectionV01(collection, { validateLens: (lens) => validateLensBrowserSafeCaseV01(lens) })).toEqual(collection);
    expect(collection.cases).toHaveLength(1);
    const item = collection.cases[0];
    expect(() => validateLensBrowserSafeCaseV01(item.lens)).not.toThrow();
    expect([item.id, item.lens.caseId, item.lens.createdAt]).toEqual([CASE_ID, CASE_ID, CREATED_AT]);

    const envelope = fx.resolveCapture.call.structuredContent;
    const result = decodeNecWireJson("network-evidence-result", JSON.stringify(envelope.evidenceResult.result));
    expect(item.lens.coreResultPreservation.sourceArtifactDigest).toBe(result.artifactDigest);
    expect(item.lens.coreResultPreservation.sourceSemanticDigest).toBe(result.semanticDigest);
    expect(item.lens.coreResultPreservation.subject).toEqual(SOL_SUBJECT);
    expect(item.exactAction).toMatchObject({ kind: "transaction", networkId: SOL, id: SOL_SUBJECT.txId, realityClass: LOOPBACK_LABEL });

    const byId = new Map<string, any>(item.lens.propositions.map((p: any) => [p.propositionId, p]));
    // Settlement: unknown, no assessment, the fragment's own SOLANA_SETTLEMENT_NOT_EVALUATED reason.
    const settlement = result.networkEvidence.settlement;
    expect(settlement).not.toHaveProperty("verdict");
    expect(settlement.reason).toMatch(/^SOLANA_SETTLEMENT_NOT_EVALUATED/);
    const settlementProposition = byId.get("network.settlement");
    expect(settlementProposition.availability).toBe("unknown");
    expect(settlementProposition.assessments).toEqual([]);
    expect(settlementProposition.limitations).toEqual([settlement.reason]);
    expect(settlementProposition.limitations[0]).toMatch(/^SOLANA_SETTLEMENT_NOT_EVALUATED/);
    // Finality: exactly the Core verdict (itself the reproduced fragment's), never stronger.
    const finality = result.networkEvidence.finality;
    expect(finality).toEqual(decodeFragment(envelope).networkEvidence.finality);
    const finalityProposition = byId.get("network.finality");
    expect(finalityProposition.assessments.map((a: any) => a.value)).toEqual(finality.verdict === undefined ? [] : [finality.verdict]);
    expect(finalityProposition.availability).toBe(
      finality.verdict !== undefined ? "available" : finality.applicability === "not_applicable" ? "not_applicable" : "unknown");
    // No string calls anything cryptographic or independently verified (negated statements only).
    const flagged = stringsOf(collection, "").filter(([, s]) => /cryptograph|independent(ly)?[\s_]+(source[\s_]+)?verif/i.test(s));
    for (const [parent, s] of flagged) {
      expect([s, parent === "doesNotEstablish" || /\b(not|never|no)\b/i.test(s)]).toEqual([s, true]);
    }
    // No edge, no reordering.
    expect(item.lens.relations).toEqual([]);
    expect(item.trailPropositionOrder).toEqual(item.lens.propositions.map((p: any) => p.propositionId));

    // Labels and provenance.
    expect(item.lens.limitations).toContain(CONTINUITY_LIMITATION);
    expect(item.lens.limitations).toContain(LOOPBACK_LABEL);
    expect(item.lens.limitations).toContain(GATE_ROW);
    expect(text).not.toContain(HOSTED_LABEL);
    const provenance = item.extensions.provenance;
    expect(provenance).toMatchObject({
      hosted: LOOPBACK_LABEL, acquiringExecutable: "null", contextSha256: fx.resolveCapture.call.contextSha256,
      resultArtifactDigest: result.artifactDigest, preflightCapture: "not given", requireAnchored: "false",
      fixedBeforeExecution: "false", anchorAcceptance: ANCHOR_ACCEPTANCE, compositionRule: COMPOSITION_RULE, gateRow: GATE_ROW,
    });
    expect(JSON.parse(provenance.anchor)).toEqual({ status: "not_applicable", reason: "non_evm_subject" });
    expect(collection.nonClaims.slice(-EVIDENCE_RESULT_NON_CLAIMS.length)).toEqual([...EVIDENCE_RESULT_NON_CLAIMS]);
    expect(collection.TARGET_CORE_MUTATIONS).toBe(0);
    expect(text).not.toMatch(/fixedBeforeExecution"\s*:\s*(true|"true")/);
    for (const key of ["caseVerdict", "confidence", "trustScore", "score", "policyDecision", "rank", "ranking"]) {
      expect([key, text.includes(key)]).toEqual([key, false]);
    }

    // Privacy: none of the context's private strings reach the collection.
    const preflight = decodePreflight(fx.context);
    for (const secret of [SOL_ACCOUNT, PREFLIGHT_NOTE, RESULT_NOTE, PREFLIGHT_REQUEST_ID, RESULT_REQUEST_ID, preflight.artifactDigest]) {
      expect([secret, fx.contextText.includes(secret)]).toEqual([secret, true]); // positive control
      expect([secret, text.includes(secret)]).toEqual([secret, false]);
    }
    expect(text).not.toContain("/mcp");

    // Deterministic: a second build gives byte-identical output.
    const again = freshOut();
    expect((await buildCli([...base(), ...caseArgs(again)])).code).toBe(0);
    expect(readFileSync(again, "utf8")).toBe(text);
    expect(globalFetchCalls).toBe(0);
  });

  it("(a) one changed context value: context_digest_mismatch; exit 1; nothing written", async () => {
    const argv = ["--capture", file("resolve-capture.json"), "--context", file("context-changed.json")];
    const verify = await verifyCli(argv);
    expect([verify.code, verify.out.exitReason, verify.out.report, verify.out.contextSha256.match]).toEqual([1, "context_digest_mismatch", null, false]);
    const out = freshOut();
    hubCalls.count = 0;
    const build = await buildCli([...argv, ...caseArgs(out)]);
    expect([build.code, build.out.exitReason, build.out.written]).toEqual([1, "context_digest_mismatch", false]);
    expect([existsSync(out), hubCalls.count]).toEqual([false, 0]);
    expect(globalFetchCalls).toBe(0);
  });

  it("(b) a served Solana null-probe preflight is isError MCP_LIVE_PREFLIGHT_UNAVAILABLE and is never verified as --preflight-capture", async () => {
    expect(fx.nullPreflightCode).toBe(1);
    expect(toolCalls(fx.nullPreflightPosts)).toBe(1);
    const call = fx.nullPreflightCapture.call;
    expect(fx.nullPreflightCapture.mode).toBe("preflight");
    expect([call.tool, call.isError, call.structuredContent]).toEqual([ACTION_CAPTURE_TOOLS.preflight, true, null]);
    expect(errorCode(call)).toBe("MCP_LIVE_PREFLIGHT_UNAVAILABLE");
    expect(fx.nullPreflightServed.map((s: Served) => [s.method, s.kind])).toEqual([
      ["getGenesisHash", "network_identity"], ["getTransaction", "simulated_null"], ["getSignatureStatuses", "simulated_null"],
    ]);

    const argv = [...base(), "--preflight-capture", file("null-preflight-capture.json")];
    const verify = await verifyCli(argv);
    expect([verify.code, verify.out.exitReason, verify.out.report.status]).toEqual([1, "preflight_capture_unbound", "verified"]);
    expect(verify.out.preflightAnchor).toMatchObject({
      status: "not_reproducible", reason: "envelope_invalid", stage: "preflight_envelope",
      preflightArtifactDigest: null, fixedBeforeExecution: false,
    });
    const out = freshOut();
    hubCalls.count = 0;
    const build = await buildCli([...argv, ...caseArgs(out)]);
    expect([build.code, build.out.exitReason, build.out.written]).toEqual([1, "preflight_capture_unbound", false]);
    expect(build.out.verification).toEqual(verify.out);
    expect([existsSync(out), hubCalls.count]).toEqual([false, 0]);
    // Nor is it a resolve capture.
    const asCapture = await verifyCli(["--capture", file("null-preflight-capture.json"), "--context", file("evidence-context.json")]);
    expect([asCapture.code, asCapture.out.exitReason]).toEqual([1, "capture_invalid"]);
    expect(globalFetchCalls).toBe(0);
  });

  it("(c) a served real-bytes Solana preflight at the recorded clock, used as the context preflight, is refused: preflight_not_before_block", async () => {
    expect(fx.latePreflightCode).toBe(0);
    const env = fx.latePreflightCapture.call.structuredContent;
    expect(env.selectedNetworkId).toBe(SOL);
    const late = decodePreflight(fx.lateContext);
    expect(late.generatedAt).toBe(SOL_AFTER_AT);
    expect(Date.parse(late.generatedAt)).toBeGreaterThanOrEqual(SOL_BLOCK_MS);
    expect(fx.latePreflightServed.map((s: Served) => [s.method, s.kind, s.at])).toEqual(
      ["getGenesisHash", "getTransaction", "getSignatureStatuses", "getBlock"].map((m) => [m, "recorded", Date.parse(SOL_AFTER_AT)]));
    // The server refuses to compose.
    expect(fx.lateResolveCode).toBe(0);
    expect(fx.lateResolveCapture.call.structuredContent.evidenceResult).toEqual({ status: "not_composed", reason: "preflight_not_before_block" });

    const argv = ["--capture", file("late-resolve-capture.json"), "--context", file("late-context.json")];
    const verify = await verifyCli(argv);
    expect([verify.code, verify.out.exitReason]).toEqual([1, "not_verified"]);
    expect(verify.out.report).toMatchObject({
      status: "not_composed_reproduced", reason: "preflight_not_before_block", expectedOutcome: "preflight_not_before_block",
      resultArtifactDigest: null, fixedBeforeExecution: false,
    });
    const out = freshOut();
    hubCalls.count = 0;
    const build = await buildCli([...argv, ...caseArgs(out)]);
    expect([build.code, build.out.exitReason, build.out.written]).toEqual([1, "not_verified", false]);
    expect([existsSync(out), hubCalls.count]).toEqual([false, 0]);
    // SIMULATED pairing: the composed envelope with the late context is composed_unjustified.
    expect(await verifyEvidenceResultEnvelope({ envelope: fx.resolveCapture.call.structuredContent, evidenceContext: fx.lateContext }))
      .toMatchObject({ status: "diverged", reason: "composed_unjustified", expectedOutcome: "preflight_not_before_block", fixedBeforeExecution: false });
    // As --preflight-capture to the positive resolve it is not that context's preflight.
    const unbound = await verifyCli([...base(), "--preflight-capture", file("late-preflight-capture.json")]);
    expect([unbound.code, unbound.out.exitReason]).toEqual([1, "preflight_capture_unbound"]);
    expect(unbound.out.preflightAnchor.status).not.toBe("anchored");
    expect(unbound.out.preflightAnchor.fixedBeforeExecution).toBe(false);
    expect(globalFetchCalls).toBe(0);
  });

  it("(d) a Base preflight capture paired with the Solana resolve capture is never verified (network_mismatch; unbound)", async () => {
    expect(fx.basePreflightCode).toBe(0);
    const env = fx.basePreflightCapture.call.structuredContent;
    expect([env.selectedNetworkId, env.probeSubject.networkId, decodeNecWireJson("preflight-result", JSON.stringify(env.preflight)).request.networkId])
      .toEqual([BASE, BASE, BASE]);
    expect(fx.basePreflightServed.every((s: Served) => s.url === BASE_URL && s.kind === "recorded_base" && s.method.startsWith("eth_"))).toBe(true);
    expect(fx.basePreflightServed.length).toBeGreaterThan(0);

    const argv = [...base(), "--preflight-capture", file("base-preflight-capture.json")];
    const verify = await verifyCli(argv);
    expect([verify.code, verify.out.exitReason, verify.out.report.status]).toEqual([1, "preflight_capture_unbound", "verified"]);
    expect(verify.out.preflightAnchor).toMatchObject({
      status: "diverged", reason: "network_mismatch", stage: "anchor", fixedBeforeExecution: false,
    });
    const out = freshOut();
    hubCalls.count = 0;
    const build = await buildCli([...argv, ...caseArgs(out)]);
    expect([build.code, build.out.exitReason, build.out.written]).toEqual([1, "preflight_capture_unbound", false]);
    expect([existsSync(out), hubCalls.count]).toEqual([false, 0]);
    expect(globalFetchCalls).toBe(0);
  });

  it("(e) the efda0ca-shaped AFTER-only context is refused as MCP_EVIDENCE_CONTEXT_NO_PREFLIGHT; never verified; nothing written", async () => {
    expect(fx.efdaCode).toBe(1);
    expect(toolCalls(fx.efdaPosts)).toBe(1);
    expect(fx.efdaServed).toEqual([]); // refused before any provider read
    const call = fx.efdaCapture.call;
    expect([call.isError, call.structuredContent]).toEqual([true, null]);
    expect(call.contextSha256).toBe(evidenceContextSha256(efdaContext()));
    expect(errorCode(call)).toBe("MCP_EVIDENCE_CONTEXT_NO_PREFLIGHT");

    const argv = ["--capture", file("efda-capture.json"), "--context", file("efda-context.json")];
    const verify = await verifyCli(argv);
    expect([verify.code, verify.out.exitReason, verify.out.contextSha256.match]).toEqual([1, "not_verified", true]);
    expect(verify.out.report).toMatchObject({ status: "not_reproducible", reason: "envelope_invalid", anchor: null, fixedBeforeExecution: false });
    const out = freshOut();
    hubCalls.count = 0;
    const build = await buildCli([...argv, ...caseArgs(out)]);
    expect([build.code, build.out.exitReason, build.out.written]).toEqual([1, "not_verified", false]);
    expect([existsSync(out), hubCalls.count]).toEqual([false, 0]);
    // With the real composed capture: the digest differs; the verifier itself says context_invalid at request.preflight.
    const mismatch = await verifyCli(["--capture", file("resolve-capture.json"), "--context", file("efda-context.json")]);
    expect([mismatch.code, mismatch.out.exitReason]).toEqual([1, "context_digest_mismatch"]);
    expect(await verifyEvidenceResultEnvelope({ envelope: fx.resolveCapture.call.structuredContent, evidenceContext: efdaContext() }))
      .toMatchObject({
        status: "not_reproducible", reason: "context_invalid", stage: "context",
        firstDiffPointer: "/evidenceContext/request/preflight", anchor: null, fixedBeforeExecution: false,
      });
    expect(globalFetchCalls).toBe(0);
  });

  it("hygiene: the provider serves declared reads only; any other URL throws; recorded Solana bytes are refused before the block time", async () => {
    const before = served.length;
    const rpc = (method: string, params: unknown[] = []) => ({ method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const sol = provider({ solana: "recorded" });
    await expect(sol("https://example.org/", rpc("getGenesisHash"))).rejects.toThrow("undeclared destination");
    await expect(sol(BASE_URL, rpc("eth_chainId"))).rejects.toThrow("undeclared destination");
    await expect(sol("https://api.devnet.solana.com/", rpc("getGenesisHash"))).rejects.toThrow("undeclared destination");
    await expect(sol(SOL_URL, rpc("getAccountInfo", [SOL_SUBJECT.txId]))).rejects.toThrow("undeclared Solana read");
    await expect(sol(SOL_URL, rpc("getTransaction", [SOL_SUBJECT.txId, { commitment: "confirmed" }]))).rejects.toThrow("undeclared Solana read");
    await expect(provider({ base: true })(SOL_URL, rpc("getGenesisHash"))).rejects.toThrow("undeclared destination");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      for (const iso of [SOL_PREFLIGHT_AT, new Date(SOL_BLOCK_MS - 1).toISOString()]) {
        at(iso);
        await expect(sol(SOL_URL, rpc("getGenesisHash"))).rejects.toThrow("recorded Solana bytes before the block time");
      }
    } finally {
      vi.useRealTimers();
    }
    expect(served.length).toBe(before);
    expect(globalFetchCalls).toBe(0);
  });

  it("hygiene: no recorded Solana bytes under a pre-block clock; no EVM bytes relabelled; global fetch never called", () => {
    const solana = served.filter((s) => s.url === SOL_URL);
    expect(solana.length).toBeGreaterThan(0);
    for (const s of solana.filter((x) => x.kind === "recorded")) expect([s.method, s.at >= SOL_BLOCK_MS]).toEqual([s.method, true]);
    const preBlock = served.filter((s) => s.at < SOL_BLOCK_MS);
    expect(preBlock.length).toBeGreaterThan(0); // positive control: the two null probes
    for (const s of preBlock) {
      expect([s.method, s.url, s.kind === "network_identity" || s.kind === "simulated_null"]).toEqual([s.method, SOL_URL, true]);
      for (const subjectBytes of [String(SUBJECT_TX.slot), String(SUBJECT_TX.blockTime), SUBJECT_BLOCK.blockhash, SOL_SUBJECT.txId]) {
        expect([s.method, subjectBytes, s.body.includes(subjectBytes)]).toEqual([s.method, subjectBytes, false]);
      }
    }
    // Only Solana methods at the Solana URL, only eth_ methods (F1 Base bytes) at the Base URL.
    for (const s of served) {
      expect([s.url, s.method, s.url === BASE_URL ? s.method.startsWith("eth_") && s.kind === "recorded_base" : !s.method.startsWith("eth_")])
        .toEqual([s.url, s.method, true]);
    }
    const baseBodies = new Set((probeRaw.captures as Capture[]).map((c) => c.resultJson));
    for (const s of solana) expect([...baseBodies].some((b) => s.body.includes(b))).toBe(false);
    for (const capture of [fx.resolveCapture, fx.lateResolveCapture]) {
      expect(capture.call.structuredContent.subject.networkId).toBe(SOL);
      expect(capture.call.structuredContent.source.networkId).toBe(SOL);
    }
    expect(globalFetchCalls).toBe(0);
  });

  it("isolation: collection.json, COLLECTION.sha256 and every hosted-reproduction source file are byte-unchanged; GT-02 stays OPEN", () => {
    expect(readFileSync(MAPS_COLLECTION).equals(fx.mapsCollectionBytes)).toBe(true);
    expect(readFileSync(MAPS_COLLECTION_SHA).equals(fx.mapsCollectionShaBytes)).toBe(true);
    const names = sourceFiles();
    expect(names).toEqual([...(fx.sourceBytes as Map<string, Buffer>).keys()]);
    expect(names).toContain("build-action-case.ts");
    for (const name of names) expect([name, readFileSync(new URL(name, SOURCE_DIR)).equals(fx.sourceBytes.get(name))]).toEqual([name, true]);
    const draft = readFileSync(new URL("../../../docs/distribution/MCP_PUBLIC_CONTRACT.md", import.meta.url), "utf8");
    expect(draft).toContain("The offline demo does not establish an authenticated or cryptographically anchored BEFORE.");
  });
});
