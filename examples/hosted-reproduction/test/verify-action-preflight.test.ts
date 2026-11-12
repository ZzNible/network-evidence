/**
 * verify-action-preflight.ts (GT-02 step 3a; examples-only; closes no gate row;
 * GT-02 stays OPEN).
 *
 * Every capture here goes through capture-action.ts to a LOOPBACK hosted-mode
 * server (startNeMcpHttpServer, SIMULATED public Host header, test-only helper)
 * whose live tools read a fake provider serving checked-in real capture bytes
 * and nothing else: Base mainnet (the F1 x402 #1062 probe and the 0x71c9…625c
 * subject) and Solana mainnet (4DYWUMEx…LF71). Global fetch throws and is
 * counted.
 *
 * Clock: SIMULATED_REPLAY_CLOCK. Only Date is faked, pinned explicitly and only
 * while the captures are produced: the Base preflights at
 * 2026-10-09T15:00:00.000Z (before the subject block, 15:24:33Z), the Solana
 * preflight and the resolve at 2026-10-09T15:42:11.665Z. Every request is
 * TEST-AUTHORED, not an original caller's action; nothing here is a genuine
 * pre-execution fix (fixedBeforeExecution:false everywhere).
 *
 * Negatives labelled SIMULATED edit ONE value of a copy of a real capture, or
 * (the KEY DIFFERENTIAL) rebuild the served manifest, capability snapshot and
 * preflight with ONE manifest field changed and consistent Core digests.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  buildCapabilitySnapshot, buildPreflightResult, computeEvidencePolicyDigest, computeResolverManifestDigest, decodeNecWireJson,
  encodeNecWireJson, verifyCapabilitySnapshot, verifyPreflightResult,
} from "@nec/core";
import type { EvidencePolicy, EvidenceRequest, NecWireType, PolicyDimension, ResolverManifest } from "@nec/core";
import { createMultichainTool, startNeMcpHttpServer } from "@nec/mcp";
import { evmBeforeResolverManifest, exchangeIdentityKey } from "@nec/resolver-evm";
import { solanaBeforeResolverManifest } from "@nec/resolver-solana";

import { simulatedHostFetch } from "../../../packages/mcp/test/helpers.js";
import { captureAction, main as captureMain, writeActionCapture } from "../capture-action.js";
import {
  ACTION_PREFLIGHT_CHECK_NON_CLAIMS, ACTION_PREFLIGHT_CHECK_SCHEMA, main as checkMain, parseActionPreflightArgs,
  verifyActionPreflightCapture,
} from "../verify-action-preflight.js";
import { verifyLivePreflightEnvelope } from "../verify-live-before.js";

interface Capture { rpcMethod: string; rpcParams: unknown[]; resultJson: string }
const load = (path: string): any => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const subjectRaw = load("../../../packages/mcp/test/fixtures/base-mainnet-l2-finalized-positive-evm.json");
const opStackRaw = load("../../../packages/mcp/test/fixtures/base-mainnet-l2-finalized-positive-opstack.json");
const probeRaw = load(
  "../../historical-compat/authority/fixtures/F1-x402-1062-partial/source/network-evidence/fixtures/base-mainnet-x402-1062-usdc-transfer.fixture.json");
const solRaw = load("../../../packages/resolver-solana/test/fixtures/solana-mainnet-x402-real.json");

const ORIGIN = "https://mcp.example.org";
const HOST = "mcp.example.org";
const BASE = "eip155:8453";
const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const EVM_PROBE = { type: "transaction", networkId: BASE, txId: probeRaw.subject.txHash as string };
const EVM_SUBJECT = { type: "transaction", networkId: BASE, txId: subjectRaw.subject.txHash as string };
const SOL_PROBE = { type: "transaction", networkId: SOL, txId: solRaw.subject.signature as string };

const PREFLIGHT_AT = "2026-10-09T15:00:00.000Z";
const BLOCK_AT = "2026-10-09T15:24:33.000Z";
const AFTER_AT = "2026-10-09T15:42:11.665Z";
/** The same pinned instant as the Solana preflight of verify-preflight-anchor.test.ts. */
const SOL_PREFLIGHT_AT = AFTER_AT;
/** The label of every BEFORE in this file; none is a genuine pre-execution fix. */
const SIMULATED_REPLAY_CLOCK = Object.freeze({
  clock: "SIMULATED_REPLAY_CLOCK", preflightAt: PREFLIGHT_AT, solanaPreflightAt: SOL_PREFLIGHT_AT, resolveAt: AFTER_AT,
  fixedBeforeExecution: false,
} as const);

/** Test-authored private strings that must never appear in a report. */
const ACCOUNT = `0x${"acc0de44".repeat(5)}`;
const MIXED_CASE_ACCOUNT = `0x${"ACC0DE44".repeat(5)}`;
const PREFLIGHT_REQUEST_ID = "ne-l044-caller-preflight";
const SOL_REQUEST_ID = "ne-l044-caller-solana-preflight";
const PREFLIGHT_NOTE = "ne-l044-private-preflight-note-5a2c";
const SOL_NOTE = "ne-l044-private-solana-note-8e1d";
const CHANGED_NOTE = "ne-l044-private-changed-note-c03f";
const LOWER_TARGET = "0x4200000000000000000000000000000000000015";
const CHECKSUMMED_TARGET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SOL_TARGET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const EVM_ACTION_KIND = "evm.transaction";
const SOL_ACTION_KIND = "spl_token.transfer_checked";

function policyOf(content: Omit<EvidencePolicy, "digest">): EvidencePolicy {
  return { ...content, digest: computeEvidencePolicyDigest(content) };
}
const POLICY = policyOf({
  id: "ne-l044-policy", version: "1",
  requiredDimensions: ["execution", "dataBinding"] as PolicyDimension[], desiredDimensions: ["observedEffects", "finality"] as PolicyDimension[],
});
/** Requires finality, which the generic EVM resolver does not support: Core composes status "blocked". */
const FINALITY_POLICY = policyOf({ id: "ne-l044-finality-policy", version: "1", requiredDimensions: ["execution", "finality"] as PolicyDimension[] });
const SOL_POLICY = policyOf({ id: "ne-l044-solana-policy", version: "1", requiredDimensions: ["execution", "finality"] as PolicyDimension[] });

/** A caller's request file (TEST-AUTHORED): {selectedNetworkId, probeSubject, request}. */
function evmArguments(request: Record<string, unknown> = {}): Record<string, any> {
  return {
    selectedNetworkId: BASE, probeSubject: { ...EVM_PROBE },
    request: {
      schemaVersion: "0.1", requestId: PREFLIGHT_REQUEST_ID, networkId: BASE, account: ACCOUNT,
      action: { kind: EVM_ACTION_KIND, target: LOWER_TARGET, fields: { expectedStatus: "success" } },
      evidencePolicy: POLICY, metadata: { callerNote: PREFLIGHT_NOTE },
      ...request,
    },
  };
}
function solanaArguments(): Record<string, any> {
  return {
    selectedNetworkId: SOL, probeSubject: { ...SOL_PROBE },
    request: {
      schemaVersion: "0.1", requestId: SOL_REQUEST_ID, networkId: SOL,
      action: { kind: SOL_ACTION_KIND, target: SOL_TARGET }, evidencePolicy: SOL_POLICY, metadata: { callerNote: SOL_NOTE },
    },
  };
}

/** GT-02 step 6 shape (TEST-AUTHORED): the EvidenceRequest over the captured preflight and snapshot. */
function contextFrom(capture: any): Record<string, unknown> {
  const env = capture.call.structuredContent;
  const decoded = decodeNecWireJson("preflight-result", JSON.stringify(env.preflight));
  const request: EvidenceRequest = {
    schemaVersion: "0.1", requestId: "ne-l044-caller-result", networkId: BASE,
    subject: { type: "transaction", networkId: BASE, txId: EVM_SUBJECT.txId },
    action: decoded.request.action, evidencePolicy: decoded.request.evidencePolicy,
    preflight: { requestId: decoded.request.requestId, digest: decoded.artifactDigest },
  };
  return {
    request: JSON.parse(encodeNecWireJson("evidence-request", request)) as unknown,
    preflight: env.preflight,
    capabilitySnapshot: env.capabilitySnapshot,
  };
}

/** Exact-lookup fake provider over the checked-in Base and Solana captures; anything else throws. */
function provider(): typeof fetch {
  const queues = new Map<string, Capture[]>();
  for (const capture of [...subjectRaw.captures, ...opStackRaw.captures, ...probeRaw.captures] as Capture[]) {
    const key = exchangeIdentityKey(capture.rpcMethod, capture.rpcParams);
    queues.set(key, [...(queues.get(key) ?? []), capture]);
  }
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).href;
    const query = JSON.parse(init?.body as string) as { id: number; method: string; params?: unknown[] };
    let resultJson: string;
    if (url === "https://mainnet.base.org/") {
      const capture = queues.get(exchangeIdentityKey(query.method, query.params ?? []))?.shift();
      if (capture === undefined) throw new Error("undeclared Base read");
      resultJson = capture.resultJson;
    } else if (url === "https://api.mainnet-beta.solana.com/") {
      const found = (solRaw.captures as Capture[])
        .find((c) => c.rpcMethod === query.method && isDeepStrictEqual(query.params ?? [], c.rpcParams));
      if (found === undefined) throw new Error("undeclared Solana read");
      resultJson = found.resultJson;
    } else {
      throw new Error("undeclared destination");
    }
    const response = new Response(`{"jsonrpc":"2.0","id":${JSON.stringify(query.id)},"result":${resultJson}}`,
      { status: 200, headers: { "content-type": "application/json" } });
    Object.defineProperty(response, "url", { value: url });
    return response;
  };
}

/** One fresh hosted-mode loopback server per capture. */
async function withServer<T>(fn: (url: string, fetchFn: typeof fetch) => Promise<T>): Promise<T> {
  const server = await startNeMcpHttpServer({
    host: "127.0.0.1", port: 0, hosted: { publicOrigin: ORIGIN }, liveEvidence: createMultichainTool(provider()),
  });
  try {
    return await fn(`http://127.0.0.1:${server.port}/mcp`, simulatedHostFetch(server.port, HOST));
  } finally {
    await server.close();
  }
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

async function checkCli(argv: string[]): Promise<{ code: number; text: string; out: any }> {
  const { value, text } = await stdoutOf(async () => checkMain(argv));
  return { code: value, text, out: JSON.parse(text) };
}

const at = (iso: string): void => { vi.setSystemTime(new Date(iso)); };
const json = (value: unknown): any => JSON.parse(JSON.stringify(value));
const mutate = (value: unknown, change: (copy: any) => void): any => {
  const copy = json(value);
  change(copy);
  return copy;
};
const wire = (type: NecWireType, value: unknown): Record<string, unknown> => JSON.parse(encodeNecWireJson(type, value)) as Record<string, unknown>;
const specifiersOf = (source: string): string[] =>
  [...source.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)"/g)].map((m) => m[1]!);

const realFetch = globalThis.fetch;
let globalFetchCalls = 0;
let dir = "";
const file = (name: string) => join(dir, name);
const readJson = (name: string): any => JSON.parse(readFileSync(file(name), "utf8"));
const writeJson = (name: string, value: unknown): void => { writeFileSync(file(name), `${JSON.stringify(value, null, 2)}\n`); };
const fx: Record<string, any> = {};

/** The captures with their own request files: `<name>-capture.json` + `<name>-arguments.json`. */
const PREFLIGHT_CAPTURES = ["preflight", "checksummed", "mixed-account", "blocked", "solana"] as const;
const argsOf = (capture: string, request: string, anchor = false): string[] => [
  "--preflight-capture", file(capture), "--request", file(request), ...(anchor ? ["--anchor-c-readiness"] : []),
];
/** Every CLI input of this file (positive, negatives, anchor readiness, drift). */
function everyArgv(): string[][] {
  const out: string[][] = [];
  for (const name of PREFLIGHT_CAPTURES) {
    for (const anchor of [false, true]) out.push(argsOf(`${name}-capture.json`, `${name}-arguments.json`, anchor));
  }
  out.push(argsOf("preflight-capture.json", "changed-arguments.json"));
  out.push(argsOf("drift-capture.json", "preflight-arguments.json", true));
  out.push(argsOf("resolve-capture.json", "preflight-arguments.json"));
  out.push(argsOf("is-error-capture.json", "preflight-arguments.json"));
  return out;
}

/**
 * SIMULATED, Core-consistent manifest drift: ONE manifest field (version) changed, the
 * digest recomputed by Core, then the capability snapshot and the preflight rebuilt by
 * Core against the drifted manifest. The caller request is untouched.
 */
function driftCapture(capture: any) {
  const env = capture.call.structuredContent;
  const pinned = evmBeforeResolverManifest();
  const { digest: _digest, ...pinnedContent } = pinned;
  const driftContent: Omit<ResolverManifest, "digest"> = { ...pinnedContent, version: "0.1.1-simulated-drift" };
  const drift: ResolverManifest = { ...driftContent, digest: computeResolverManifestDigest(driftContent) };
  const ref = { id: drift.id, version: drift.version, digest: drift.digest };
  const servedSnapshot = decodeNecWireJson("capability-snapshot", JSON.stringify(env.capabilitySnapshot));
  const { artifactDigest: _snapshotDigest, ...snapshotContent } = servedSnapshot;
  const snapshot = buildCapabilitySnapshot({ ...snapshotContent, resolver: ref }, { resolver: drift, networkId: BASE });
  const servedPreflight = decodeNecWireJson("preflight-result", JSON.stringify(env.preflight));
  const { artifactDigest: _preflightDigest, status: _status, ...preflightContent } = servedPreflight;
  const preflight = buildPreflightResult(
    { ...preflightContent, resolver: ref, capabilitySnapshot: { id: snapshot.id, digest: snapshot.artifactDigest } },
    { resolver: drift, capabilitySnapshot: snapshot },
  );
  return {
    drift, snapshot, preflight, servedPreflight,
    capture: mutate(capture, (c) => {
      c.call.structuredContent.preflight = wire("preflight-result", preflight);
      c.call.structuredContent.capabilitySnapshot = wire("capability-snapshot", snapshot);
      c.call.structuredContent.resolverManifest = wire("resolver-manifest", drift);
    }),
  };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ne-action-preflight-check-"));
  globalThis.fetch = (async () => {
    globalFetchCalls += 1;
    throw new Error("global fetch is denied in verify-action-preflight tests");
  }) as typeof fetch;
  // Only Date is faked, only while capturing; setTimeout, AbortSignal.timeout and HTTP stay real.
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    // GT-02 step 3 shape (SIMULATED_REPLAY_CLOCK, loopback): the preflight, through the capture CLI.
    writeJson("preflight-arguments.json", evmArguments());
    at(PREFLIGHT_AT);
    fx.captureCode = await withServer(async (url, fetchFn) => (await stdoutOf(() => captureMain([
      "--mode", "preflight", "--url", url, "--request", file("preflight-arguments.json"), "--out", file("preflight-capture.json"),
    ], { fetch: fetchFn }))).value);
    fx.capture = readJson("preflight-capture.json");

    // Other TEST-AUTHORED requests through the library API, same pinned instant.
    for (const [name, args] of [
      ["checksummed", evmArguments({ action: { kind: EVM_ACTION_KIND, target: CHECKSUMMED_TARGET, fields: { expectedStatus: "success" } } })],
      ["mixed-account", evmArguments({ account: MIXED_CASE_ACCOUNT })],
      ["blocked", evmArguments({ evidencePolicy: FINALITY_POLICY })],
    ] as const) {
      writeJson(`${name}-arguments.json`, args);
      writeActionCapture(file(`${name}-capture.json`),
        await withServer((url, fetchFn) => captureAction({ mode: "preflight", url, request: args, fetch: fetchFn })));
    }
    at(SOL_PREFLIGHT_AT);
    writeJson("solana-arguments.json", solanaArguments());
    writeActionCapture(file("solana-capture.json"),
      await withServer((url, fetchFn) => captureAction({ mode: "preflight", url, request: solanaArguments(), fetch: fetchFn })));

    // GT-02 step 7 shape: a loopback resolve-mode capture over the positive preflight.
    at(AFTER_AT);
    writeActionCapture(file("resolve-capture.json"), await withServer((url, fetchFn) => captureAction({
      mode: "resolve", url, subject: { networkId: BASE, txId: EVM_SUBJECT.txId }, evidenceContext: contextFrom(fx.capture), fetch: fetchFn,
    })));
  } finally {
    vi.useRealTimers();
  }
  // Derived inputs (no clock involved).
  const changed = evmArguments();
  changed.request.metadata.callerNote = CHANGED_NOTE;
  writeJson("changed-arguments.json", changed);
  fx.drift = driftCapture(fx.capture);
  writeJson("drift-capture.json", fx.drift.capture);
  writeJson("is-error-capture.json", mutate(fx.capture, (c) => { c.call.isError = true; }));
}, 120_000);

afterAll(() => {
  globalThis.fetch = realFetch;
  if (dir !== "") rmSync(dir, { recursive: true, force: true });
});

describe("verify-action-preflight (GT-02 step 3a; offline, fail closed, examples-only)", () => {
  it("static: imports only node built-ins, @nec/core, the two resolvers and two sibling verifiers; never a capture client or the MCP server", () => {
    const entry = new URL("../verify-action-preflight.ts", import.meta.url);
    const source = readFileSync(entry, "utf8");
    const specifiers = specifiersOf(source);
    expect(specifiers.length).toBeGreaterThan(5);
    const allowed = new Set([
      "@nec/core", "@nec/resolver-evm", "@nec/resolver-solana", "./verify-evidence-result.js", "./verify-live-before.js",
    ]);
    for (const specifier of specifiers) {
      expect([specifier, specifier.startsWith("node:") || allowed.has(specifier)]).toEqual([specifier, true]);
    }
    expect(source).not.toMatch(/\bimport\s*\(/);
    expect(source).not.toMatch(/\brequire\s*\(/);
    expect(source).not.toMatch(/\bfetch\b/);
    expect(source).not.toMatch(/\bDate\b/);
    expect(source).not.toMatch(/Math\.random|randomUUID|randomBytes|getRandomValues/);

    // The whole static import graph, through every relative import. (verify-live-before.ts loads
    // capture-hosted.js only by a dynamic import inside its own CLI main, which this module never calls.)
    const visited = new Set<string>();
    const external = new Set<string>();
    const walk = (from: URL): void => {
      if (visited.has(from.pathname)) return;
      visited.add(from.pathname);
      for (const specifier of specifiersOf(readFileSync(from, "utf8"))) {
        if (specifier.startsWith("./") || specifier.startsWith("../")) walk(new URL(specifier.replace(/\.js$/, ".ts"), from));
        else external.add(specifier);
      }
    };
    walk(entry);
    const names = [...visited].map((path) => path.slice(path.lastIndexOf("/") + 1));
    expect(names).toContain("verify-live-before.ts"); // positive control
    expect(names).toContain("verify-evidence-result.ts");
    for (const banned of ["capture-action.ts", "capture-hosted.ts"]) expect([banned, names.includes(banned)]).toEqual([banned, false]);
    expect([...visited].filter((path) => path.includes("/packages/mcp/"))).toEqual([]);
    expect([...external].filter((s) => s === "@nec/mcp" || s.startsWith("@modelcontextprotocol/") || s.includes("packages/mcp")))
      .toEqual([]);
    expect(globalFetchCalls).toBe(0);
  });

  it("the loopback material is SIMULATED_REPLAY_CLOCK, TEST-AUTHORED and produced through capture-action.ts", () => {
    expect(SIMULATED_REPLAY_CLOCK).toEqual({
      clock: "SIMULATED_REPLAY_CLOCK", preflightAt: PREFLIGHT_AT, solanaPreflightAt: SOL_PREFLIGHT_AT, resolveAt: AFTER_AT,
      fixedBeforeExecution: false,
    });
    expect(fx.captureCode).toBe(0);
    for (const name of PREFLIGHT_CAPTURES) {
      const capture = readJson(`${name}-capture.json`);
      expect([name, capture.schema, capture.mode, capture.loopback, capture.call.tool, capture.call.isError]).toEqual([
        name, "ne-hosted-action-capture/v0.1", "preflight", true, "preflight_live_network_evidence", false,
      ]);
      expect(capture.call.arguments).toEqual(readJson(`${name}-arguments.json`));
    }
    const preflight = decodeNecWireJson("preflight-result", JSON.stringify(fx.capture.call.structuredContent.preflight));
    expect(preflight.generatedAt).toBe(PREFLIGHT_AT);
    expect(Date.parse(PREFLIGHT_AT)).toBeLessThan(Date.parse(BLOCK_AT));
    const resolve = readJson("resolve-capture.json");
    expect([resolve.schema, resolve.mode, resolve.call.tool, resolve.call.isError, resolve.loopback]).toEqual([
      "ne-hosted-action-capture/v0.1", "resolve", "resolve_transaction_evidence", false, true,
    ]);
    expect(globalFetchCalls).toBe(0);
  });

  it("EVM loopback positive: exit 0, verified:preflight_capture_pinned against the caller's file and the pinned EVM manifest", async () => {
    const run = await checkCli(argsOf("preflight-capture.json", "preflight-arguments.json"));
    const pinned = evmBeforeResolverManifest();
    const preflight = decodeNecWireJson("preflight-result", JSON.stringify(fx.capture.call.structuredContent.preflight));
    expect(run.code).toBe(0);
    expect(run.out).toEqual({
      schema: ACTION_PREFLIGHT_CHECK_SCHEMA, anchorReadinessRequested: false,
      status: "verified", reason: "preflight_capture_pinned", stage: "complete",
      preflightEnvelope: { status: "verified", reason: "envelope_verified", contextualVerification: "returned_context_verified" },
      selectedNetworkId: BASE, preflightStatus: preflight.status,
      manifest: { family: "evm", pinnedDigest: pinned.digest, servedDigest: pinned.digest, pinned: true },
      fixedBeforeExecution: false, exitCode: 0, nonClaims: [...ACTION_PREFLIGHT_CHECK_NON_CLAIMS],
    });
    // The pure function gives the same report.
    expect(verifyActionPreflightCapture({ capture: fx.capture, requestFile: readJson("preflight-arguments.json") })).toEqual(run.out);
    expect(ACTION_PREFLIGHT_CHECK_SCHEMA).toBe("ne-hosted-action-preflight-check/v0.1");
    const nonClaims = ACTION_PREFLIGHT_CHECK_NON_CLAIMS.join(" ");
    for (const phrase of [
      "Exit 0 is not authorization to execute anything", "not precedence", "not policy satisfaction", "gas readiness",
      "Whether anchor (c) counts is an owner decision.", "GT-02 stays OPEN.", "fixedBeforeExecution is always false",
      "no EIP-3009 nonce, no EIP-712 field, no transaction input",
    ]) expect([phrase, nonClaims.includes(phrase)]).toEqual([phrase, true]);
    expect(run.text).not.toMatch(/"fixedBeforeExecution": true/);
    expect(globalFetchCalls).toBe(0);
  });

  it("preflightStatus is echoed, never gated: a real loopback preflight with Core status blocked still exits 0", async () => {
    const capture = readJson("blocked-capture.json");
    expect(decodeNecWireJson("preflight-result", JSON.stringify(capture.call.structuredContent.preflight)).status).toBe("blocked");
    const run = await checkCli(argsOf("blocked-capture.json", "blocked-arguments.json"));
    expect([run.code, run.out.status, run.out.reason, run.out.preflightStatus]).toEqual([0, "verified", "preflight_capture_pinned", "blocked"]);
    expect(globalFetchCalls).toBe(0);
  });

  it("a changed request field is not verified: exit 1, verifyLivePreflightEnvelope's status and reason propagated verbatim", async () => {
    const changed = readJson("changed-arguments.json");
    const direct = verifyLivePreflightEnvelope(fx.capture.call.structuredContent, { expected: changed });
    expect([direct.status, direct.reason]).toEqual(["diverged", "request_binding_mismatch"]);
    const run = await checkCli(argsOf("preflight-capture.json", "changed-arguments.json"));
    expect(run.code).toBe(1);
    expect(run.out).toMatchObject({
      status: direct.status, reason: direct.reason, stage: "preflight_envelope",
      preflightEnvelope: { status: direct.status, reason: direct.reason, contextualVerification: "not_verified" },
      manifest: null, fixedBeforeExecution: false, exitCode: 1,
    });
    // The capture's own call.arguments would verify: the check binds to the caller's file, never to them.
    expect(verifyLivePreflightEnvelope(fx.capture.call.structuredContent, { expected: fx.capture.call.arguments }).status).toBe("verified");

    // An absent, null or non-inert request file never skips the binding.
    const getter = readJson("preflight-arguments.json");
    const request = getter.request;
    delete getter.request;
    Object.defineProperty(getter, "request", { get: () => request, enumerable: true });
    for (const [label, requestFile] of [["absent", undefined], ["null", null], ["accessor", getter]] as const) {
      const report = verifyActionPreflightCapture({ capture: fx.capture, requestFile });
      expect([label, report.status, report.reason, report.stage, report.exitCode]).toEqual([
        label, "diverged", "request_binding_mismatch", "preflight_envelope", 1,
      ]);
    }
    expect(globalFetchCalls).toBe(0);
  });

  it("resolve-mode, isError and wrong-schema captures give capture_invalid before any envelope check", async () => {
    const requestFile = readJson("preflight-arguments.json");
    const cases: [string, unknown][] = [
      ["loopback resolve-mode capture", readJson("resolve-capture.json")],
      ["SIMULATED mode resolve", mutate(fx.capture, (c) => { c.mode = "resolve"; })],
      ["SIMULATED isError true", readJson("is-error-capture.json")],
      ["SIMULATED isError absent", mutate(fx.capture, (c) => { delete c.call.isError; })],
      ["SIMULATED wrong schema", mutate(fx.capture, (c) => { c.schema = "ne-hosted-capture/v0.1"; })],
      ["SIMULATED wrong tool", mutate(fx.capture, (c) => { c.call.tool = "resolve_transaction_evidence"; })],
      ["proxied capture", new Proxy(json(fx.capture), {})],
      ["null", null],
    ];
    for (const [label, capture] of cases) {
      const report = verifyActionPreflightCapture({ capture, requestFile, anchorReadiness: true });
      expect([label, report.status, report.reason, report.stage, report.preflightEnvelope, report.manifest, report.exitCode]).toEqual([
        label, "not_reproducible", "capture_invalid", "capture", null, null, 1,
      ]);
      expect(report.fixedBeforeExecution).toBe(false);
    }
    for (const name of ["resolve-capture.json", "is-error-capture.json"]) {
      const run = await checkCli(argsOf(name, "preflight-arguments.json"));
      expect([name, run.code, run.out.status, run.out.reason]).toEqual([name, 1, "not_reproducible", "capture_invalid"]);
    }
    expect(globalFetchCalls).toBe(0);
  });

  it("KEY DIFFERENTIAL: a SIMULATED Core-consistent drifted manifest verifies under verifyLivePreflightEnvelope and is refused here (manifest_not_pinned)", async () => {
    const { drift, snapshot, preflight, servedPreflight, capture } = fx.drift;
    const pinned = evmBeforeResolverManifest();
    expect(drift.digest).not.toBe(pinned.digest);
    // Exactly one manifest field differs (besides the recomputed digest).
    expect(drift.version).toBe("0.1.1-simulated-drift");
    expect({ ...drift, version: pinned.version, digest: pinned.digest }).toEqual(pinned);
    // Positive controls: Core accepts the drifted context, and the caller request is unchanged.
    expect(verifyCapabilitySnapshot(snapshot, { resolver: drift, networkId: BASE })).toBe(true);
    expect(verifyPreflightResult(preflight, { resolver: drift, capabilitySnapshot: snapshot })).toBe(true);
    expect(encodeNecWireJson("preflight-request", preflight.request)).toBe(encodeNecWireJson("preflight-request", servedPreflight.request));
    expect(verifyLivePreflightEnvelope(capture.call.structuredContent, { expected: readJson("preflight-arguments.json") })).toMatchObject({
      status: "verified", reason: "envelope_verified", contextualVerification: "returned_context_verified",
    });
    for (const anchor of [false, true]) {
      const run = await checkCli(argsOf("drift-capture.json", "preflight-arguments.json", anchor));
      expect(run.code).toBe(1);
      expect(run.out).toMatchObject({
        status: "diverged", reason: "manifest_not_pinned", stage: "pinned_manifest",
        preflightEnvelope: { status: "verified", reason: "envelope_verified", contextualVerification: "returned_context_verified" },
        manifest: { family: "evm", pinnedDigest: pinned.digest, servedDigest: drift.digest, pinned: false },
        fixedBeforeExecution: false, exitCode: 1,
      });
    }
    expect(globalFetchCalls).toBe(0);
  });

  it("anchor readiness (only with --anchor-c-readiness): lowercase Base target anchor_ready; checksummed target insufficient; Solana not_applicable", async () => {
    const ready = await checkCli(argsOf("preflight-capture.json", "preflight-arguments.json", true));
    expect([ready.code, ready.out.anchorReadinessRequested, ready.out.status, ready.out.reason, ready.out.stage]).toEqual([
      0, true, "anchor_ready", "anchor_c_bindable", "complete",
    ]);
    for (const [name, status, reason] of [
      ["checksummed", "insufficient", "anchor_target_not_bindable"],
      ["mixed-account", "insufficient", "anchor_account_not_bindable"],
      ["solana", "not_applicable", "non_evm_subject"],
    ] as const) {
      const withFlag = await checkCli(argsOf(`${name}-capture.json`, `${name}-arguments.json`, true));
      expect([name, withFlag.code, withFlag.out.status, withFlag.out.reason, withFlag.out.stage, withFlag.out.manifest.pinned]).toEqual([
        name, 1, status, reason, "anchor_readiness", true,
      ]);
      // Without the flag the same capture is verified: readiness is never part of the default check.
      const without = await checkCli(argsOf(`${name}-capture.json`, `${name}-arguments.json`));
      expect([name, without.code, without.out.status, without.out.reason]).toEqual([name, 0, "verified", "preflight_capture_pinned"]);
    }
    const solana = await checkCli(argsOf("solana-capture.json", "solana-arguments.json"));
    const solanaPinned = solanaBeforeResolverManifest();
    expect(solana.out).toMatchObject({
      selectedNetworkId: SOL,
      manifest: { family: "solana", pinnedDigest: solanaPinned.digest, servedDigest: solanaPinned.digest, pinned: true },
    });
    // The checksummed target is a 0x+40-hex address with upper-case hex digits.
    expect(CHECKSUMMED_TARGET.toLowerCase()).toMatch(/^0x[0-9a-f]{40}$/);
    expect(CHECKSUMMED_TARGET).not.toBe(CHECKSUMMED_TARGET.toLowerCase());
    expect(globalFetchCalls).toBe(0);
  });

  it("privacy: no report carries a requestId, account, action or metadata string, a nonce-width hex, a preflight digest or an extra field", async () => {
    const preflightDigests = PREFLIGHT_CAPTURES.map((name) =>
      String(readJson(`${name}-capture.json`).call.structuredContent.preflight.artifactDigest).slice("sha256:".length));
    const secrets = [
      PREFLIGHT_REQUEST_ID, SOL_REQUEST_ID, ACCOUNT, MIXED_CASE_ACCOUNT, PREFLIGHT_NOTE, SOL_NOTE, LOWER_TARGET, CHECKSUMMED_TARGET,
      SOL_TARGET, EVM_ACTION_KIND, SOL_ACTION_KIND, "expectedStatus", "callerNote", ...preflightDigests,
    ];
    // Positive control: every one of them is in the private inputs.
    const inputs = [
      ...PREFLIGHT_CAPTURES.map((name) => readFileSync(file(`${name}-capture.json`), "utf8")),
    ].join("\n");
    for (const secret of secrets) expect([secret, inputs.includes(secret)]).toEqual([secret, true]);
    expect(readFileSync(file("changed-arguments.json"), "utf8")).toContain(CHANGED_NOTE);

    const topKeys = [
      "schema", "anchorReadinessRequested", "status", "reason", "stage", "preflightEnvelope", "selectedNetworkId", "preflightStatus",
      "manifest", "fixedBeforeExecution", "exitCode", "nonClaims",
    ];
    for (const argv of everyArgv()) {
      const run = await checkCli(argv);
      for (const secret of [...secrets, CHANGED_NOTE]) expect([argv, secret, run.text.includes(secret)]).toEqual([argv, secret, false]);
      expect(run.text).not.toMatch(/0x[0-9a-fA-F]{64}/);
      expect(Object.keys(run.out)).toEqual(topKeys);
      if (run.out.preflightEnvelope !== null) expect(Object.keys(run.out.preflightEnvelope)).toEqual(["status", "reason", "contextualVerification"]);
      if (run.out.manifest !== null) expect(Object.keys(run.out.manifest)).toEqual(["family", "pinnedDigest", "servedDigest", "pinned"]);
      expect(run.out.fixedBeforeExecution).toBe(false);
      expect(run.out.nonClaims).toEqual([...ACTION_PREFLIGHT_CHECK_NON_CLAIMS]);
    }
    expect(globalFetchCalls).toBe(0);
  });

  it("determinism: two runs are byte-identical; global fetch is never called; Date is never read", async () => {
    const inputs = everyArgv();
    const runs: string[] = [];
    const RealDate = globalThis.Date;
    let clockReads = 0;
    globalThis.Date = new Proxy(RealDate, {
      construct(target, args, newTarget) {
        if (args.length === 0) clockReads += 1;
        return Reflect.construct(target, args, newTarget) as object;
      },
      apply(target, thisArg, args) {
        clockReads += 1;
        return Reflect.apply(target, thisArg, args) as unknown;
      },
      get(target, key, receiver) {
        if (key === "now") return () => { clockReads += 1; return target.now(); };
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    try {
      for (let i = 0; i < 2; i++) {
        const texts: string[] = [];
        for (const argv of inputs) texts.push((await checkCli(argv)).text);
        runs.push(texts.join("\u0000"));
      }
    } finally {
      globalThis.Date = RealDate;
    }
    expect(clockReads).toBe(0);
    expect(runs[1]).toBe(runs[0]);
    expect(globalFetchCalls).toBe(0);
  });

  it("arguments: --preflight-capture and --request are required; unknown or repeated flags are refused", () => {
    const files = ["--preflight-capture", "c.json", "--request", "r.json"];
    expect(parseActionPreflightArgs(files)).toEqual({ preflightCapture: "c.json", request: "r.json", anchorReadiness: false });
    expect(parseActionPreflightArgs([...files, "--anchor-c-readiness"]))
      .toEqual({ preflightCapture: "c.json", request: "r.json", anchorReadiness: true });
    expect(() => parseActionPreflightArgs(["--request", "r.json"])).toThrow("--preflight-capture");
    expect(() => parseActionPreflightArgs(["--preflight-capture", "c.json"])).toThrow("--request");
    expect(() => parseActionPreflightArgs([...files, "--url", "https://mcp.example.org/mcp"])).toThrow("unknown argument");
    expect(() => parseActionPreflightArgs([...files, "--request", "x.json"])).toThrow("more than once");
    expect(() => parseActionPreflightArgs([...files, "--anchor-c-readiness", "--anchor-c-readiness"])).toThrow("more than once");
    expect(() => parseActionPreflightArgs(["--preflight-capture", "--request", "r.json"])).toThrow("requires a value");
  });

  it("README: step 3a sits between steps 3 and 4 without renumbering; HUMAN GATE markers kept; GT-02 stays OPEN", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const start = readme.indexOf("### GT-02 operator sequence");
    const end = readme.indexOf("## Capture client", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const section = readme.slice(start, end).replace(/\s+/g, " ");
    const step3 = section.indexOf("3. **HUMAN GATE (hosted run, Q3");
    const step3a = section.indexOf("3a. ");
    const step4 = section.indexOf("4. Optional, **HUMAN GATE");
    expect(step3).toBeGreaterThan(0);
    expect(step3a).toBeGreaterThan(step3);
    expect(step4).toBeGreaterThan(step3a);
    const text = section.slice(step3a, step4);
    expect(text).toContain("tsx examples/hosted-reproduction/verify-action-preflight.ts --preflight-capture");
    expect(text).toContain("diverged:manifest_not_pinned");
    expect(text).not.toContain("9. ");
    expect(text).not.toContain("10. ");
    expect(section.indexOf("9. ")).toBeGreaterThan(step4);
    for (const marker of ["1. ", "2. ", "5. ", "6. ", "7. ", "8. ", "9. ", "10. "]) expect([marker, section.includes(marker)]).toEqual([marker, true]);
    expect(section.match(/HUMAN GATE/g)?.length ?? 0).toBeGreaterThanOrEqual(6);
    expect(section).toContain("nothing here was executed");
    const whole = readme.replace(/\s+/g, " ");
    expect(whole).toContain("## Action preflight check (`verify-action-preflight.ts`)");
    expect(whole).toContain("GT-02 stays OPEN.");
    const draft = readFileSync(new URL("../../../docs/distribution/MCP_PUBLIC_CONTRACT.md", import.meta.url), "utf8");
    expect(draft).toContain("The offline demo does not establish an authenticated or cryptographically anchored BEFORE.");
  });
});
