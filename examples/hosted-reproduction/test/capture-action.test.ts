/**
 * capture-action.ts + the verify-evidence-result.ts CLI (examples-only; closes
 * no gate row; GT-02 stays OPEN).
 *
 * Every capture here goes to a LOOPBACK hosted-mode server
 * (startNeMcpHttpServer, SIMULATED public Host header, test-only helper) whose
 * live tools read a fake provider serving checked-in real Base mainnet capture
 * bytes (the subject 0x71c9…625c and the earlier F1 x402 #1062 probe) and
 * nothing else. Global fetch throws and is counted; the redirect test hands
 * the original fetch to the client against two loopback servers only.
 *
 * Clock: SIMULATED_REPLAY_CLOCK. Only Date is faked and it is pinned
 * explicitly, never read from the wall clock: the preflight runs at
 * 2026-10-09T15:00:00.000Z (before the subject block, 15:24:33Z) and the
 * resolve at 2026-10-09T15:42:11.665Z (after it). The preflight request is
 * TEST-AUTHORED, not an original caller's action; nothing here is a genuine
 * pre-execution fix (fixedBeforeExecution:false everywhere). The efda0ca-shaped
 * AFTER-only context is refused and never verified.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { canonicalJson, computeEvidencePolicyDigest, decodeNecWireJson, encodeNecWireJson } from "@nec/core";
import type { EvidencePolicy, EvidenceRequest, PolicyDimension } from "@nec/core";
import { createMultichainTool, startNeMcpHttpServer } from "@nec/mcp";
import { exchangeIdentityKey } from "@nec/resolver-evm";

import { simulatedHostFetch } from "../../../packages/mcp/test/helpers.js";
import {
  ACTION_CAPTURE_SCHEMA, ACTION_CAPTURE_TOOLS, captureAction, evidenceContextSha256, main as captureMain, parseActionArgs,
  writeActionCapture,
} from "../capture-action.js";
import type { ActionCapture } from "../capture-action.js";
import { CAPTURE_CALLS, CAPTURE_CLIENT, CAPTURE_SCHEMA, classifyCallOutcome, EXPECTED_OUTCOMES } from "../capture-hosted.js";
import { ACTION_CAPTURE_SCHEMA_ACCEPTED, main as verifyMain } from "../verify-evidence-result.js";
import { verifyLivePreflightEnvelope } from "../verify-live-before.js";

interface Capture { rpcMethod: string; rpcParams: unknown[]; resultJson: string }
const load = (path: string): any => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const subjectRaw = load("../../../packages/mcp/test/fixtures/base-mainnet-l2-finalized-positive-evm.json");
const opStackRaw = load("../../../packages/mcp/test/fixtures/base-mainnet-l2-finalized-positive-opstack.json");
const probeRaw = load(
  "../../historical-compat/authority/fixtures/F1-x402-1062-partial/source/network-evidence/fixtures/base-mainnet-x402-1062-usdc-transfer.fixture.json");

const ORIGIN = "https://mcp.example.org";
const HOST = "mcp.example.org";
const BASE = "eip155:8453";
const EVM_SUBJECT = { type: "transaction", networkId: BASE, txId: subjectRaw.subject.txHash as string };
const EVM_PROBE = { type: "transaction", networkId: BASE, txId: probeRaw.subject.txHash as string };

const PREFLIGHT_AT = "2026-10-09T15:00:00.000Z";
const LATE_PREFLIGHT_AT = "2026-10-09T15:30:00.000Z";
const BLOCK_AT = "2026-10-09T15:24:33.000Z";
const AFTER_AT = "2026-10-09T15:42:11.665Z";
/** The label of every BEFORE in this file; none is a genuine pre-execution fix. */
const SIMULATED_REPLAY_CLOCK = Object.freeze({
  clock: "SIMULATED_REPLAY_CLOCK", preflightAt: PREFLIGHT_AT, resolveAt: AFTER_AT, fixedBeforeExecution: false,
} as const);

/** Test-authored private strings that must never leave the context file in resolve mode. */
const ACCOUNT = `0x${"acc0de57".repeat(5)}`;
const PREFLIGHT_NOTE = "ne-l042-private-preflight-note-6d1f";
const RESULT_NOTE = "ne-l042-private-result-note-91c4";
const PREFLIGHT_REQUEST_ID = "ne-l042-caller-preflight";
const RESULT_REQUEST_ID = "ne-l042-caller-result";
const ACQUIRING_SHA = "a".repeat(40);

const EVM_ACTION = { kind: "evm.transaction", target: "0x4200000000000000000000000000000000000015", fields: { expectedStatus: "success" } };
function policyOf(content: Omit<EvidencePolicy, "digest">): EvidencePolicy {
  return { ...content, digest: computeEvidencePolicyDigest(content) };
}
const POLICY = policyOf({
  id: "ne-l042-policy", version: "1",
  requiredDimensions: ["execution", "dataBinding"] as PolicyDimension[], desiredDimensions: ["observedEffects", "finality"] as PolicyDimension[],
});

/** The caller's request file (TEST-AUTHORED): {selectedNetworkId, probeSubject, request}. */
function preflightArguments(): Record<string, unknown> {
  return {
    selectedNetworkId: BASE, probeSubject: { ...EVM_PROBE },
    request: {
      schemaVersion: "0.1", requestId: PREFLIGHT_REQUEST_ID, networkId: BASE, account: ACCOUNT,
      action: EVM_ACTION, evidencePolicy: POLICY, metadata: { callerNote: PREFLIGHT_NOTE },
    },
  };
}

/** GT-02 step 6 (TEST-AUTHORED): the EvidenceRequest over the captured preflight and snapshot. */
function contextFrom(capture: ActionCapture): Record<string, unknown> {
  const env = capture.call.structuredContent as { preflight: Record<string, unknown>; capabilitySnapshot: Record<string, unknown> };
  const decoded = decodeNecWireJson("preflight-result", JSON.stringify(env.preflight));
  const request: EvidenceRequest = {
    schemaVersion: "0.1", requestId: RESULT_REQUEST_ID, networkId: BASE,
    subject: { type: "transaction", networkId: BASE, txId: EVM_SUBJECT.txId },
    action: decoded.request.action, evidencePolicy: decoded.request.evidencePolicy,
    preflight: { requestId: decoded.request.requestId, digest: decoded.artifactDigest },
    metadata: { callerNote: RESULT_NOTE },
  };
  return {
    request: JSON.parse(encodeNecWireJson("evidence-request", request)) as unknown,
    preflight: env.preflight,
    capabilitySnapshot: env.capabilitySnapshot,
  };
}

/** efda0ca-shaped: AFTER-only, no preflight, policy authored after the block. */
function efdaContext(): Record<string, unknown> {
  const request: EvidenceRequest = {
    schemaVersion: "0.1", requestId: "efda0ca-shaped", networkId: BASE,
    subject: { type: "transaction", networkId: BASE, txId: EVM_SUBJECT.txId },
    action: EVM_ACTION,
    evidencePolicy: policyOf({
      id: "efda0ca-shaped-policy", version: "2026-10-26", requiredDimensions: ["execution", "observedEffects"],
      rules: { authoredAt: "2026-10-26T00:00:00.000Z" },
    }),
  };
  return { request: JSON.parse(encodeNecWireJson("evidence-request", request)) as unknown };
}

/** Exact-lookup fake provider over the checked-in Base captures; anything else throws. */
function provider(): typeof fetch {
  const queues = new Map<string, Capture[]>();
  for (const capture of [...subjectRaw.captures, ...opStackRaw.captures, ...probeRaw.captures] as Capture[]) {
    const key = exchangeIdentityKey(capture.rpcMethod, capture.rpcParams);
    queues.set(key, [...(queues.get(key) ?? []), capture]);
  }
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).href;
    if (url !== "https://mainnet.base.org/") throw new Error("undeclared destination");
    const query = JSON.parse(init?.body as string) as { id: number; method: string; params?: unknown[] };
    const capture = queues.get(exchangeIdentityKey(query.method, query.params ?? []))?.shift();
    if (capture === undefined) throw new Error("undeclared Base read");
    const response = new Response(`{"jsonrpc":"2.0","id":${JSON.stringify(query.id)},"result":${capture.resultJson}}`,
      { status: 200, headers: { "content-type": "application/json" } });
    Object.defineProperty(response, "url", { value: url });
    return response;
  };
}

/** One fresh hosted-mode loopback server per capture; records the JSON-RPC methods POSTed to it. */
async function withServer<T>(fn: (url: string, fetchFn: typeof fetch, posts: string[]) => Promise<T>): Promise<T> {
  const server = await startNeMcpHttpServer({
    host: "127.0.0.1", port: 0, hosted: { publicOrigin: ORIGIN }, liveEvidence: createMultichainTool(provider()),
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

const at = (iso: string): void => { vi.setSystemTime(new Date(iso)); };
const readJson = (path: string): any => JSON.parse(readFileSync(path, "utf8"));
const toolCalls = (posts: readonly string[]) => posts.filter((method) => method === "tools/call").length;
const beforeFirstCall = (posts: readonly string[]) => posts.slice(0, posts.indexOf("tools/call"));

/** Every key outside call.structuredContent. */
function ownKeys(capture: any): string[] {
  const keys: string[] = [];
  const walk = (value: unknown, path: string) => {
    if (path === "/call/structuredContent" || value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      keys.push(key);
      walk(child, `${path}/${key}`);
    }
  };
  walk(capture, "");
  return keys;
}

const realFetch = globalThis.fetch;
let globalFetchCalls = 0;
let dir = "";
const file = (name: string) => join(dir, name);
const fx: Record<string, any> = {};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ne-action-capture-"));
  globalThis.fetch = (async () => {
    globalFetchCalls += 1;
    throw new Error("global fetch is denied in capture-action tests");
  }) as typeof fetch;
  // Only Date is faked; setTimeout, AbortSignal.timeout and HTTP stay real.
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    // GT-02 step 3 shape (SIMULATED_REPLAY_CLOCK, loopback): the preflight, through the CLI.
    writeFileSync(file("preflight-arguments.json"), `${JSON.stringify(preflightArguments(), null, 2)}\n`);
    at(PREFLIGHT_AT);
    fx.preflightCode = await withServer(async (url, fetchFn, posts) => {
      const { value } = await stdoutOf(() => captureMain([
        "--mode", "preflight", "--url", url, "--request", file("preflight-arguments.json"),
        "--out", file("preflight-capture.json"), "--acquiring-sha", ACQUIRING_SHA,
      ], { fetch: fetchFn }));
      fx.preflightPosts = [...posts];
      return value;
    });
    fx.preflightText = readFileSync(file("preflight-capture.json"), "utf8");
    fx.preflightCapture = JSON.parse(fx.preflightText);

    // GT-02 steps 6 and 7 shape: the caller's context, then the resolve, through the CLI.
    fx.context = contextFrom(fx.preflightCapture);
    fx.contextText = `${JSON.stringify(fx.context, null, 2)}\n`;
    writeFileSync(file("evidence-context.json"), fx.contextText);
    at(AFTER_AT);
    fx.resolveCode = await withServer(async (url, fetchFn, posts) => {
      const { value } = await stdoutOf(() => captureMain([
        "--mode", "resolve", "--url", url, "--network-id", BASE, "--tx-id", EVM_SUBJECT.txId,
        "--context", file("evidence-context.json"), "--out", file("resolve-capture.json"),
      ], { fetch: fetchFn }));
      fx.resolvePosts = [...posts];
      return value;
    });
    fx.resolveText = readFileSync(file("resolve-capture.json"), "utf8");
    fx.resolveCapture = JSON.parse(fx.resolveText);

    // Negative: a preflight AFTER the block time (library API), then the resolve.
    at(LATE_PREFLIGHT_AT);
    const late = await withServer((url, fetchFn) => captureAction({ mode: "preflight", url, request: preflightArguments(), fetch: fetchFn }));
    writeActionCapture(file("late-preflight-capture.json"), late);
    fx.lateContext = contextFrom(late);
    writeFileSync(file("late-context.json"), JSON.stringify(fx.lateContext));
    at(AFTER_AT);
    const lateResolve = await withServer((url, fetchFn) => captureAction({
      mode: "resolve", url, subject: { networkId: BASE, txId: EVM_SUBJECT.txId }, evidenceContext: fx.lateContext, fetch: fetchFn,
    }));
    writeActionCapture(file("late-resolve-capture.json"), lateResolve);
    fx.lateResolve = lateResolve;

    // Negative: the efda0ca-shaped AFTER-only context, through the CLI.
    writeFileSync(file("efda-context.json"), JSON.stringify(efdaContext()));
    fx.efdaCode = await withServer(async (url, fetchFn, posts) => {
      const { value } = await stdoutOf(() => captureMain([
        "--mode", "resolve", "--url", url, "--network-id", BASE, "--tx-id", EVM_SUBJECT.txId,
        "--context", file("efda-context.json"), "--out", file("efda-capture.json"),
      ], { fetch: fetchFn }));
      fx.efdaPosts = [...posts];
      return value;
    });
    fx.efdaCapture = readJson(file("efda-capture.json"));
  } finally {
    vi.useRealTimers();
  }
}, 120_000);

afterAll(() => {
  globalThis.fetch = realFetch;
  if (dir !== "") rmSync(dir, { recursive: true, force: true });
});

describe("capture-action (single caller-authored call, loopback only) and the verify-evidence-result CLI", () => {
  it("capture-hosted.ts: only the four evidenceContext refusal codes were added; the frozen campaign is unchanged", () => {
    for (const code of [
      "MCP_EVIDENCE_CONTEXT_INVALID", "MCP_EVIDENCE_CONTEXT_NO_PREFLIGHT", "MCP_EVIDENCE_CONTEXT_CALLER_MANIFEST",
      "MCP_EVIDENCE_CONTEXT_TOO_LARGE",
    ]) {
      const outcome = classifyCallOutcome({
        id: "action-resolve", tool: "resolve_transaction_evidence", isError: true, structuredContent: null,
        content: [{ type: "text", text: JSON.stringify({ error: { code, message: "SIMULATED refusal text" } }) }],
      });
      expect([code, outcome]).toEqual([code, { kind: "input_refusal", code }]);
    }
    expect(CAPTURE_CALLS).toHaveLength(14);
    expect(Object.keys(EXPECTED_OUTCOMES).sort()).toEqual(CAPTURE_CALLS.map((c) => c.id).sort());
    expect(CAPTURE_CLIENT).toEqual({ name: "ne-hosted-capture", version: "0.3.0" });
    expect(CAPTURE_SCHEMA).toBe("ne-hosted-capture/v0.1");
    // withClient is neither exported nor reused.
    const hosted = readFileSync(new URL("../capture-hosted.ts", import.meta.url), "utf8");
    expect(hosted).toMatch(/\n {2}async function withClient</);
    expect(hosted).not.toMatch(/export[^\n]*withClient/);
    expect(readFileSync(new URL("../capture-action.ts", import.meta.url), "utf8")).not.toContain("withClient");
    expect(ACTION_CAPTURE_SCHEMA).toBe("ne-hosted-action-capture/v0.1");
    expect(ACTION_CAPTURE_SCHEMA_ACCEPTED).toBe(ACTION_CAPTURE_SCHEMA);
    expect(globalFetchCalls).toBe(0);
  });

  it("the loopback material is SIMULATED_REPLAY_CLOCK: preflight before the block, resolve after it", () => {
    expect(SIMULATED_REPLAY_CLOCK).toEqual({
      clock: "SIMULATED_REPLAY_CLOCK", preflightAt: PREFLIGHT_AT, resolveAt: AFTER_AT, fixedBeforeExecution: false,
    });
    const preflight = decodeNecWireJson("preflight-result", JSON.stringify(fx.preflightCapture.call.structuredContent.preflight));
    expect(preflight.generatedAt).toBe(PREFLIGHT_AT);
    expect(Date.parse(PREFLIGHT_AT)).toBeLessThan(Date.parse(BLOCK_AT));
    expect(fx.resolveCapture.call.structuredContent.acquiredAt).toBe(AFTER_AT);
    expect(Date.parse(AFTER_AT)).toBeGreaterThan(Date.parse(BLOCK_AT));
    const late = decodeNecWireJson("preflight-result", JSON.stringify(fx.lateContext.preflight));
    expect(late.generatedAt).toBe(LATE_PREFLIGHT_AT);
    expect(Date.parse(LATE_PREFLIGHT_AT)).toBeGreaterThan(Date.parse(BLOCK_AT));
    expect(globalFetchCalls).toBe(0);
  });

  it("preflight mode: one session, one tools/call; arguments and envelope verbatim; private; verifies against the request file", () => {
    expect(fx.preflightCode).toBe(0);
    expect(toolCalls(fx.preflightPosts)).toBe(1);
    expect(beforeFirstCall(fx.preflightPosts)).toEqual(["server/discover"]);
    const capture = fx.preflightCapture;
    const requestFile = readJson(file("preflight-arguments.json"));
    expect(capture).toMatchObject({
      schema: ACTION_CAPTURE_SCHEMA, mode: "preflight", loopback: true, callEra: "modern",
      acquiringExecutable: { sha: ACQUIRING_SHA, declaredBy: "operator", verifiedByThisClient: false },
      client: { name: "ne-hosted-action-capture" },
      privacy: { containsCallerPreflightRequest: true, privateByDefault: true, publishableWithoutReview: false },
    });
    expect(capture.call.tool).toBe(ACTION_CAPTURE_TOOLS.preflight);
    expect(capture.call.isError).toBe(false);
    expect(capture.call.arguments).toEqual(requestFile);
    expect(capture.call).not.toHaveProperty("contextSha256");
    expect(capture.privacy.statement).toMatch(/caller-authored PreflightRequest \(including any account and metadata\)/);
    expect(capture.nonClaims.join("\n")).toMatch(/caller-authored PreflightRequest verbatim \(including any account and metadata\)/);
    expect(capture.nonClaims.join("\n")).toMatch(/not publishable without review/);
    // Private by default because it does carry them.
    expect(fx.preflightText).toContain(ACCOUNT);
    expect(fx.preflightText).toContain(PREFLIGHT_NOTE);
    expect(verifyLivePreflightEnvelope(capture.call.structuredContent, { expected: requestFile })).toMatchObject({
      status: "verified", reason: "envelope_verified", contextualVerification: "returned_context_verified",
    });
    expect(globalFetchCalls).toBe(0);
  });

  it("resolve mode records the evidenceContext only as its canonical-bytes contextSha256, never its content", () => {
    expect(fx.resolveCode).toBe(0);
    expect(toolCalls(fx.resolvePosts)).toBe(1);
    expect(beforeFirstCall(fx.resolvePosts)).toEqual(["server/discover"]);
    const capture = fx.resolveCapture;
    expect(capture).toMatchObject({
      schema: ACTION_CAPTURE_SCHEMA, mode: "resolve", loopback: true, callEra: "modern", acquiringExecutable: null,
      privacy: {
        containsCallerPreflightRequest: false, evidenceContextContentRecorded: false, privateByDefault: true, publishableWithoutReview: false,
      },
    });
    expect(Object.keys(capture.call).sort()).toEqual(["arguments", "contextSha256", "isError", "structuredContent", "tool"]);
    expect(capture.call.tool).toBe(ACTION_CAPTURE_TOOLS.resolve);
    expect(capture.call.arguments).toEqual({ subject: EVM_SUBJECT });
    expect(capture.call.structuredContent.evidenceResult.status).toBe("composed");

    // sha256 over @nec/core canonicalJsonBytes(context): equal to the canonical text digest, not to the file bytes.
    const canonicalDigest = `sha256:${createHash("sha256").update(canonicalJson(fx.context), "utf8").digest("hex")}`;
    expect(capture.call.contextSha256).toBe(evidenceContextSha256(fx.context));
    expect(capture.call.contextSha256).toBe(canonicalDigest);
    expect(capture.call.contextSha256).not.toBe(`sha256:${createHash("sha256").update(fx.contextText, "utf8").digest("hex")}`);
    expect(capture.nonClaims.join("\n")).toMatch(/canonical-bytes digest, not a digest of the bytes sent on the wire/);

    // None of the context's account, metadata, preflight or snapshot strings is in the serialized capture.
    const preflight = decodeNecWireJson("preflight-result", JSON.stringify(fx.context.preflight));
    const snapshot = decodeNecWireJson("capability-snapshot", JSON.stringify(fx.context.capabilitySnapshot));
    const privateStrings = [
      ACCOUNT, PREFLIGHT_NOTE, RESULT_NOTE, PREFLIGHT_REQUEST_ID, preflight.artifactDigest, snapshot.artifactDigest,
    ];
    for (const secret of privateStrings) {
      expect([secret, fx.contextText.includes(secret)]).toEqual([secret, true]); // positive control
      expect([secret, fx.resolveText.includes(secret)]).toEqual([secret, false]);
    }
    expect(globalFetchCalls).toBe(0);
  });

  it("no capture field asserts precedence; loopback is derived from the URL hostname only", () => {
    for (const capture of [fx.preflightCapture, fx.resolveCapture, fx.efdaCapture]) {
      const keys = ownKeys(capture);
      expect(keys).not.toContain("clientObservedAt");
      expect(keys).not.toContain("fixedBeforeExecution");
      expect(capture.nonClaims.join("\n")).toContain(
        "loopback is derived from the --url hostname only; a non-loopback URL is not evidence of an authentic hosted server");
    }
    expect(globalFetchCalls).toBe(0);
  });

  it("verify CLI: exit 0 only for verified; anchor not_anchored and fixedBeforeExecution false", async () => {
    const run = await verifyCli(["--capture", file("resolve-capture.json"), "--context", file("evidence-context.json")]);
    expect(run.code).toBe(0);
    expect(run.out).toMatchObject({
      schema: "ne-hosted-evidence-result-cli-report/v0.1", requireAnchored: false, acquiringExecutable: null,
      contextSha256: { recorded: fx.resolveCapture.call.contextSha256, recomputed: fx.resolveCapture.call.contextSha256, match: true },
      preflightAnchor: null, exitCode: 0, exitReason: "composed_result_verified",
    });
    expect(run.out.report).toMatchObject({
      status: "verified", reason: "composed_result_verified", stage: "composition", fixedBeforeExecution: false,
      anchor: { status: "not_anchored", reason: "no_authorization_used_log", fixedBeforeExecution: false },
    });
    expect(run.text).not.toMatch(/"fixedBeforeExecution": true/);
    expect(globalFetchCalls).toBe(0);
  });

  it("context digest: a whitespace-only reformat keeps it; one changed value exits 1 before any verification", async () => {
    const reformatted = `${JSON.stringify(fx.context, null, 7)}\n\n`;
    expect(reformatted).not.toBe(fx.contextText);
    writeFileSync(file("context-reformatted.json"), reformatted);
    const same = await verifyCli(["--capture", file("resolve-capture.json"), "--context", file("context-reformatted.json")]);
    expect([same.code, same.out.contextSha256.match, same.out.report.status]).toEqual([0, true, "verified"]);

    const changed = JSON.parse(JSON.stringify(fx.context));
    changed.request.metadata.callerNote = `${RESULT_NOTE}x`;
    writeFileSync(file("context-changed.json"), JSON.stringify(changed, null, 2));
    const run = await verifyCli(["--capture", file("resolve-capture.json"), "--context", file("context-changed.json")]);
    expect(run.code).toBe(1);
    expect(run.out).toMatchObject({
      contextSha256: { recorded: fx.resolveCapture.call.contextSha256, recomputed: evidenceContextSha256(changed), match: false },
      report: null, preflightAnchor: null, exitCode: 1, exitReason: "context_digest_mismatch",
    });
    expect(globalFetchCalls).toBe(0);
  });

  it("--preflight-capture binds the served preflight; --require-anchored on a not_anchored report exits 1", async () => {
    const base = ["--capture", file("resolve-capture.json"), "--context", file("evidence-context.json")];
    const bound = await verifyCli([...base, "--preflight-capture", file("preflight-capture.json")]);
    expect(bound.code).toBe(0);
    expect(bound.out.preflightAnchor).toMatchObject({ status: "not_anchored", stage: "anchor", fixedBeforeExecution: false });
    expect(bound.out.preflightAnchor.preflightArtifactDigest).toBe(bound.out.report.anchor.preflightArtifactDigest);

    for (const argv of [[...base, "--require-anchored"], [...base, "--preflight-capture", file("preflight-capture.json"), "--require-anchored"]]) {
      const run = await verifyCli(argv);
      expect([run.code, run.out.exitReason, run.out.report.status, run.out.report.anchor.status])
        .toEqual([1, "not_anchored", "verified", "not_anchored"]);
    }
    // Another valid preflight (the late one) is not the context's preflight.
    const unbound = await verifyCli([...base, "--preflight-capture", file("late-preflight-capture.json")]);
    expect([unbound.code, unbound.out.exitReason]).toEqual([1, "preflight_capture_unbound"]);
    // Wrong capture kinds.
    const wrongPreflight = await verifyCli([...base, "--preflight-capture", file("resolve-capture.json")]);
    expect([wrongPreflight.code, wrongPreflight.out.exitReason]).toEqual([1, "preflight_capture_invalid"]);
    const wrongCapture = await verifyCli(["--capture", file("preflight-capture.json"), "--context", file("evidence-context.json")]);
    expect([wrongCapture.code, wrongCapture.out.exitReason, wrongCapture.out.report]).toEqual([1, "capture_invalid", null]);
    expect(globalFetchCalls).toBe(0);
  });

  it("a preflight after the block time is not_composed (preflight_not_before_block), never verified", async () => {
    expect(fx.lateResolve.call.structuredContent.evidenceResult).toEqual({ status: "not_composed", reason: "preflight_not_before_block" });
    const run = await verifyCli(["--capture", file("late-resolve-capture.json"), "--context", file("late-context.json")]);
    expect(run.code).toBe(1);
    expect(run.out.exitReason).toBe("not_verified");
    expect(run.out.report).toMatchObject({
      status: "not_composed_reproduced", reason: "preflight_not_before_block", fixedBeforeExecution: false,
    });
    expect(globalFetchCalls).toBe(0);
  });

  it("efda0ca-shaped AFTER-only context: refused by the server (NO_PREFLIGHT), isError recorded, input_refusal, never verified", async () => {
    expect(fx.efdaCode).toBe(1);
    expect(toolCalls(fx.efdaPosts)).toBe(1);
    const call = fx.efdaCapture.call;
    expect([call.isError, call.structuredContent]).toEqual([true, null]);
    expect(call.contextSha256).toBe(evidenceContextSha256(efdaContext()));
    expect(JSON.parse(call.content[0].text).error.code).toBe("MCP_EVIDENCE_CONTEXT_NO_PREFLIGHT");
    expect(classifyCallOutcome({ id: "action-resolve", ...call })).toEqual({ kind: "input_refusal", code: "MCP_EVIDENCE_CONTEXT_NO_PREFLIGHT" });
    const run = await verifyCli(["--capture", file("efda-capture.json"), "--context", file("efda-context.json")]);
    expect(run.code).toBe(1);
    expect(run.out.contextSha256.match).toBe(true);
    expect(run.out.exitReason).toBe("not_verified");
    expect(run.out.report).toMatchObject({ status: "not_reproducible", reason: "envelope_invalid", anchor: null, fixedBeforeExecution: false });
    expect(globalFetchCalls).toBe(0);
  });

  it("refuses an existing --out, unsafe targets, bad arguments and a non-canonical context before any request", async () => {
    let requests = 0;
    const spy: typeof fetch = async () => {
      requests += 1;
      throw new Error("must not be called");
    };
    // An existing --out is never overwritten.
    writeFileSync(file("existing.json"), "SENTINEL\n");
    await expect(captureMain([
      "--mode", "preflight", "--url", "http://127.0.0.1:9/mcp", "--request", file("preflight-arguments.json"), "--out", file("existing.json"),
    ], { fetch: spy })).rejects.toThrow("already exists");
    expect(() => writeActionCapture(file("existing.json"), fx.preflightCapture)).toThrow();
    expect(readFileSync(file("existing.json"), "utf8")).toBe("SENTINEL\n");

    for (const url of [
      "http://mcp.example.org/mcp", "https://user:secret@mcp.example.org/mcp", "https://mcp.example.org/mcp?token=x",
      "https://mcp.example.org/mcp#f", "ftp://127.0.0.1/mcp", "",
    ]) {
      await expect(captureAction({ mode: "preflight", url, request: preflightArguments(), fetch: spy })).rejects.toThrow();
      await expect(captureMain([
        "--mode", "preflight", "--url", url, "--request", file("preflight-arguments.json"), "--out", file("never.json"),
      ], { fetch: spy })).rejects.toThrow();
    }
    // A context outside nec-canonical-json-v1 cannot be digested and is never sent.
    await expect(captureAction({
      mode: "resolve", url: "http://127.0.0.1:9/mcp", subject: { networkId: BASE, txId: EVM_SUBJECT.txId },
      evidenceContext: { request: 1.5 }, fetch: spy,
    })).rejects.toThrow("nec-canonical-json-v1");
    expect(requests).toBe(0);

    const url = ["--url", "http://127.0.0.1:4178/mcp"];
    const out = ["--out", "x.json"];
    expect(() => parseActionArgs([...url, "--request", "r.json", ...out])).toThrow("--mode");
    expect(() => parseActionArgs(["--mode", "sign", ...url, ...out])).toThrow("--mode");
    expect(() => parseActionArgs(["--mode", "preflight", ...url, ...out])).toThrow("--request is required");
    expect(() => parseActionArgs(["--mode", "preflight", ...url, "--request", "r.json", "--context", "c.json", ...out])).toThrow("not accepted");
    expect(() => parseActionArgs(["--mode", "resolve", ...url, "--context", "c.json", "--network-id", BASE, ...out])).toThrow("--tx-id");
    expect(() => parseActionArgs(["--mode", "preflight", ...url, "--request", "r.json", "--acquiring-sha", "main", ...out])).toThrow();
    expect(() => parseActionArgs(["--mode", "preflight", ...url, "--request", "r.json", "--method", "eth_sendRawTransaction", ...out]))
      .toThrow("unknown argument");
    expect(() => parseActionArgs(["--mode", "preflight", ...url, "--request", "r.json", "--era", "future", ...out])).toThrow();
    expect(parseActionArgs(["--mode", "preflight", ...url, "--request", "r.json", ...out])).toEqual({
      mode: "preflight", url: "http://127.0.0.1:4178/mcp", out: "x.json", era: "modern", request: "r.json",
    });
    expect(globalFetchCalls).toBe(0);
  });

  it("the legacy era is requested and negotiated on its own single session", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      at(PREFLIGHT_AT);
      await withServer(async (url, fetchFn, posts) => {
        const capture = await captureAction({ mode: "preflight", url, era: "legacy", request: preflightArguments(), fetch: fetchFn });
        expect([capture.callEra, capture.call.isError]).toEqual(["legacy", false]);
        expect(toolCalls(posts)).toBe(1);
        expect(beforeFirstCall(posts)).toEqual(["initialize", "notifications/initialized"]);
      });
    } finally {
      vi.useRealTimers();
    }
    expect(globalFetchCalls).toBe(0);
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
    try {
      await expect(captureAction({
        mode: "resolve", url: `http://127.0.0.1:${firstPort}/mcp`, subject: { networkId: BASE, txId: EVM_SUBJECT.txId },
        evidenceContext: fx.context, fetch: realFetch,
      })).rejects.toThrow();
      expect(onTarget).toBeGreaterThanOrEqual(1);
      expect(offTarget).toBe(0);
    } finally {
      for (const server of servers) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
    expect(globalFetchCalls).toBe(0);
  });

  it("determinism: two verify runs print byte-identical output", async () => {
    const inputs = [
      ["--capture", file("resolve-capture.json"), "--context", file("evidence-context.json"), "--preflight-capture", file("preflight-capture.json")],
      ["--capture", file("resolve-capture.json"), "--context", file("context-changed.json")],
      ["--capture", file("late-resolve-capture.json"), "--context", file("late-context.json")],
      ["--capture", file("efda-capture.json"), "--context", file("efda-context.json")],
    ];
    const runs: string[] = [];
    for (let i = 0; i < 2; i++) {
      const texts: string[] = [];
      for (const argv of inputs) texts.push((await verifyCli(argv)).text);
      runs.push(texts.join("\u0000"));
    }
    expect(runs[1]).toBe(runs[0]);
    expect(globalFetchCalls).toBe(0);
  });

  it("README: GT-02 steps 3, 7 and 8 carry the exact commands; nothing was executed; GT-02 stays OPEN", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const start = readme.indexOf("### GT-02 operator sequence");
    const end = readme.indexOf("## Capture client", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const section = readme.slice(start, end).replace(/\s+/g, " ");
    expect(section).not.toContain("does not exist yet");
    expect(section).toContain("nothing here was executed");
    expect(section).toContain("tsx examples/hosted-reproduction/capture-action.ts --mode preflight");
    expect(section).toContain("tsx examples/hosted-reproduction/capture-action.ts --mode resolve");
    expect(section).toContain("tsx examples/hosted-reproduction/verify-evidence-result.ts --capture");
    expect(section.match(/HUMAN GATE/g)?.length ?? 0).toBeGreaterThanOrEqual(6);
    const whole = readme.replace(/\s+/g, " ");
    expect(whole).toContain("GT-02 stays OPEN.");
    expect(whole).toContain("`loopback` is derived from the `--url` hostname only");
    expect(whole).toContain("a canonical-bytes digest, never a digest of the wire bytes");
  });
});
