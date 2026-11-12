/**
 * The reproduce CLI exit rule (`evaluateReproductionCapture` / `main`) over the
 * full 14-call capture, built as capture-loopback.test.ts builds it: the capture
 * client against a LOOPBACK hosted-mode server (simulated public Host header),
 * whose live tools run over a fake provider fetchFn serving checked-in real
 * capture fixtures, plus the SIMULATED nulls for the two made-up
 * SYNTHETIC-SUBJECT hashes. Only Date is faked (paced sleeps advance it).
 * Every negative is a SIMULATED single-call edit of a copy of that capture.
 * Global fetch throws. No live network call happens anywhere in this file.
 * Exit 0 closes no gate row: GT-04 and GT-06 stay OPEN.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createMultichainTool, startNeMcpHttpServer } from "@nec/mcp";
import { stableJsonKey } from "@nec/resolver-solana";

import { simulatedHostFetch } from "../../../packages/mcp/test/helpers.js";
import {
  assessCaptureOutcomes, CAPTURE_CALLS, captureHostedEnvelopes, EXPECTED_OUTCOMES, MIN_PACING_SECONDS, SYNTHETIC_BASE_MAINNET_TX,
  SYNTHETIC_BASE_SEPOLIA_TX,
} from "../capture-hosted.js";
import type { HostedCapture } from "../capture-hosted.js";
import {
  evaluateReproductionCapture, main, REPRODUCTION_REPORT_SCHEMA, REQUIRED_REPRODUCED_CALLS,
} from "../reproduce.js";
import type { CaptureReproductionDecision } from "../reproduce.js";

const origin = "https://mcp.example.org";
const host = "mcp.example.org";
const BASE = "https://mainnet.base.org";
const SOLANA = "https://api.mainnet-beta.solana.com";
const BASE_SEPOLIA = "https://sepolia.base.org";
const SOLANA_DEVNET = "https://api.devnet.solana.com";
const SOURCES: readonly string[] = [BASE, SOLANA, BASE_SEPOLIA, SOLANA_DEVNET];
const RESOLVE = "resolve_transaction_evidence";
const COMMIT = "a".repeat(40);

type Capture = { rpcMethod: string; rpcParams: unknown[]; resultJson: string };
type Call = HostedCapture["calls"][number];
const load = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as { captures: Capture[] };
/** Same fixture set as capture-loopback.test.ts; the last two entries are SIMULATED. */
const fixtures: [string, Capture[]][] = [
  [BASE, load("../../../packages/mcp/test/fixtures/base-mainnet-l2-finalized-positive-evm.json").captures],
  [BASE, load("../../../packages/mcp/test/fixtures/base-mainnet-l2-finalized-positive-opstack.json").captures
    .filter((c) => c.rpcMethod === "eth_getBlockByNumber")],
  [SOLANA, load("../../../packages/resolver-solana/test/fixtures/solana-mainnet-x402-real.json").captures],
  [BASE_SEPOLIA, load("../../../packages/adapter-erc4337/test/fixtures/base-sepolia-external-v06-userop.json").captures],
  [SOLANA_DEVNET, load("../../../packages/resolver-solana/test/fixtures/solana-devnet-before-probe.json").captures],
  // SIMULATED: each made-up SYNTHETIC-SUBJECT hash is answered as not found.
  [BASE, ["eth_getTransactionReceipt", "eth_getTransactionByHash"].map((rpcMethod) => ({
    rpcMethod, rpcParams: [SYNTHETIC_BASE_MAINNET_TX], resultJson: "null",
  }))],
  [BASE_SEPOLIA, ["eth_getTransactionReceipt", "eth_getTransactionByHash"].map((rpcMethod) => ({
    rpcMethod, rpcParams: [SYNTHETIC_BASE_SEPOLIA_TX], resultJson: "null",
  }))],
];

/** Same exact-lookup fake provider as capture-loopback.test.ts (raw resultJson bytes; throws on anything else). */
function fakeProvider(): typeof fetch {
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
    const queue = queues.get(`${source} ${q.method} ${stableJsonKey(q.params ?? [])}`);
    if (queue === undefined || queue.length === 0) throw new Error(`Unexpected request: ${q.method}`);
    const result = queue.length > 1 ? queue.shift()! : queue[0]!;
    const response = new Response(`{"jsonrpc":"2.0","id":${JSON.stringify(q.id)},"result":${result}}`, {
      status: 200, headers: { "content-type": "application/json" },
    });
    Object.defineProperty(response, "url", { value: new URL(url).href });
    return response;
  };
}

const realFetch = globalThis.fetch;
let globalFetchAttempts = 0;
let capture: HostedCapture;

beforeAll(async () => {
  globalThis.fetch = (async () => {
    globalFetchAttempts += 1;
    throw new Error("global fetch is denied in hosted-reproduction tests");
  }) as typeof fetch;
  const start = Date.now();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(start);
  try {
    const server = await startNeMcpHttpServer({
      host: "127.0.0.1", port: 0, hosted: { publicOrigin: origin }, liveEvidence: createMultichainTool(fakeProvider()),
    });
    try {
      capture = await captureHostedEnvelopes({
        url: `http://127.0.0.1:${server.port}/mcp`, era: "modern", pacingSeconds: MIN_PACING_SECONDS,
        fetch: simulatedHostFetch(server.port, host),
        // Each paced sleep advances the faked Date: every call lands in a fresh live budget window.
        sleep: async (ms: number) => { vi.setSystemTime(Date.now() + ms); },
      });
    } finally {
      await server.close();
    }
  } finally {
    vi.useRealTimers();
  }
  // As written to and read back from a capture file.
  capture = JSON.parse(JSON.stringify(capture)) as HostedCapture;
}, 120_000);
afterAll(() => {
  globalThis.fetch = realFetch;
});

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const callOf = (id: string): Call => {
  const call = capture.calls.find((c) => c.id === id);
  expect(call, id).toBeDefined();
  return clone(call!);
};
const withCalls = (calls: readonly Call[]): HostedCapture => ({ ...clone(capture), calls: clone(calls) });
const replaced = (id: string, call: Call): HostedCapture => withCalls(capture.calls.map((c) => (c.id === id ? call : c)));
const without = (...ids: string[]): HostedCapture => withCalls(capture.calls.filter((c) => !ids.includes(c.id)));
const decide = (value: unknown): Promise<CaptureReproductionDecision> => evaluateReproductionCapture(value, COMMIT);

/** SIMULATED: a typed source failure edited into a copy of the capture; not a network observation. */
function simulatedSourceFailure(id: string): Call {
  const fixed = CAPTURE_CALLS.find((c) => c.id === id)!;
  return {
    id, tool: fixed.tool, arguments: clone(fixed.arguments), isError: true, structuredContent: null,
    content: [{
      type: "text",
      text: JSON.stringify({ error: { code: "MCP_MULTICHAIN_SOURCE_FAILED", message: "SIMULATED source failure; not a network observation" } }),
    }],
    label: "SIMULATED: source failure edited into a copy of the loopback capture; not a network observation",
  };
}

/** SIMULATED: a non-error result carrying another call's real envelope, filed under `id`. */
function simulatedEnvelopeUnder(id: string, envelopeFrom: string): Call {
  const fixed = CAPTURE_CALLS.find((c) => c.id === id)!;
  return {
    id, tool: fixed.tool, arguments: clone(fixed.arguments), isError: false,
    structuredContent: clone(callOf(envelopeFrom).structuredContent),
    label: `SIMULATED: the real ${envelopeFrom} envelope filed under ${id}; not a network observation`,
  };
}

describe("reproduce CLI exit rule (loopback capture, fail closed)", () => {
  it("pins the schema, the required ids and the loopback capture; global fetch is denied", async () => {
    expect(REPRODUCTION_REPORT_SCHEMA).toBe("ne-hosted-reproduction-report/v0.1");
    expect([...REQUIRED_REPRODUCED_CALLS]).toEqual(["base-mainnet-pinned", "solana-mainnet-pinned"]);
    expect(Object.isFrozen(REQUIRED_REPRODUCED_CALLS)).toBe(true);
    for (const id of REQUIRED_REPRODUCED_CALLS) {
      const fixed = CAPTURE_CALLS.find((c) => c.id === id);
      expect([id, fixed?.tool, Object.keys(fixed?.arguments ?? {})]).toEqual([id, RESOLVE, ["subject"]]);
      expect(EXPECTED_OUTCOMES[id]).toEqual(["observed", "source_failure"]);
    }
    // Positive control: the capture is the full 14-call loopback capture, every outcome expected.
    expect(capture.calls.map((c) => c.id)).toEqual(CAPTURE_CALLS.map((c) => c.id));
    expect(capture.calls).toHaveLength(14);
    expect(capture).toMatchObject({ schema: "ne-hosted-capture/v0.1", loopback: true, callEra: "modern", acquiringExecutable: null });
    expect(assessCaptureOutcomes(capture.calls).filter((a) => !a.expected)).toEqual([]);

    await expect(fetch("https://example.org")).rejects.toThrow("global fetch is denied");
    expect(globalFetchAttempts).toBe(1);
    globalFetchAttempts = 0;
  });

  it("R1: the full 14-call loopback capture exits 0 with missingReproduced []", async () => {
    const { exitCode, output } = await decide(capture);
    expect(exitCode).toBe(0);
    expect(output.missingReproduced).toEqual([]);
    expect(Object.keys(output)).toEqual(["schema", "acquiringExecutable", "reproducingCommit", "outcomes", "reports", "missingReproduced"]);
    expect(output).toMatchObject({ schema: "ne-hosted-reproduction-report/v0.1", acquiringExecutable: null, reproducingCommit: COMMIT });
    expect(output.outcomes).toEqual(assessCaptureOutcomes(capture.calls));
    expect(output.outcomes).toHaveLength(14);
    expect(output.outcomes.every((o) => o.expected)).toBe(true);
    expect(output.reports.map((r) => [r.id, r.report.status, r.subjectBound])).toEqual([
      ["base-mainnet-pinned", "reproduced", true],
      ["base-mainnet-pinned-l2-finality", "reproduced", true],
      ["solana-mainnet-pinned", "reproduced", true],
      ["base-sepolia-pinned", "reproduced", true],
      ["solana-devnet-pinned", "reproduced", true],
      ["synthetic-base-mainnet-subject", "reproduced", true],
    ]);
    // Deterministic: two decisions over the same capture serialize byte-identically.
    expect(JSON.stringify((await decide(clone(capture))).output)).toBe(JSON.stringify(output));
    expect(globalFetchAttempts).toBe(0);
  }, 60_000);

  it("the CLI prints the decision, byte-identical across two runs, and returns its exit code", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ne-reproduce-cli-"));
    const printed: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      printed.push(String(chunk));
      return true;
    });
    try {
      const full = join(dir, "capture.json");
      writeFileSync(full, `${JSON.stringify(capture, null, 2)}\n`, { flag: "wx" });
      const runs: string[] = [];
      for (let i = 0; i < 2; i++) {
        printed.length = 0;
        expect(await main(["--capture", full, "--reproducing-commit", COMMIT])).toBe(0);
        runs.push(printed.join(""));
      }
      expect(runs[1]).toBe(runs[0]);
      const report = JSON.parse(runs[0]!) as { schema: string; missingReproduced: string[] };
      expect(report.schema).toBe("ne-hosted-reproduction-report/v0.1");
      expect(report).toEqual(JSON.parse(JSON.stringify((await decide(capture)).output)));

      const noSolana = join(dir, "no-solana.json");
      writeFileSync(noSolana, JSON.stringify(replaced("solana-mainnet-pinned", simulatedSourceFailure("solana-mainnet-pinned"))), { flag: "wx" });
      printed.length = 0;
      expect(await main(["--capture", noSolana])).toBe(1);
      expect(JSON.parse(printed.join(""))).toMatchObject({
        schema: "ne-hosted-reproduction-report/v0.1", reproducingCommit: null, missingReproduced: ["solana-mainnet-pinned"],
      });
      await expect(main(["--capture", full, "--reproducing-commit", "main"])).rejects.toThrow("--reproducing-commit");
      await expect(main([])).rejects.toThrow("--capture");
    } finally {
      write.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
    expect(globalFetchAttempts).toBe(0);
  }, 60_000);

  it("R2: a SIMULATED MCP_MULTICHAIN_SOURCE_FAILED on solana-mainnet-pinned is an expected outcome, yet exits 1", async () => {
    const edited = replaced("solana-mainnet-pinned", simulatedSourceFailure("solana-mainnet-pinned"));
    const { exitCode, output } = await decide(edited);
    expect(output.outcomes.find((o) => o.id === "solana-mainnet-pinned")).toEqual({
      id: "solana-mainnet-pinned", outcome: { kind: "source_failure", code: "MCP_MULTICHAIN_SOURCE_FAILED" }, expected: true,
    });
    expect(output.outcomes.every((o) => o.expected)).toBe(true);
    expect(output.reports.map((r) => r.id)).not.toContain("solana-mainnet-pinned");
    expect(output.reports.every((r) => r.report.status === "reproduced" && r.subjectBound)).toBe(true);
    expect(output.missingReproduced).toEqual(["solana-mainnet-pinned"]);
    expect(exitCode).toBe(1);
    // The EVM side alike.
    const noBase = await decide(replaced("base-mainnet-pinned", simulatedSourceFailure("base-mainnet-pinned")));
    expect([noBase.exitCode, noBase.output.missingReproduced]).toEqual([1, ["base-mainnet-pinned"]]);
    expect(globalFetchAttempts).toBe(0);
  }, 60_000);

  it("R3: a capture with only base-mainnet-pinned exits 1 with missingReproduced ['solana-mainnet-pinned']", async () => {
    const { exitCode, output } = await decide(withCalls([callOf("base-mainnet-pinned")]));
    expect(output.outcomes).toEqual([{ id: "base-mainnet-pinned", outcome: { kind: "observed", code: null }, expected: true }]);
    expect(output.reports.map((r) => [r.id, r.report.status, r.subjectBound])).toEqual([["base-mainnet-pinned", "reproduced", true]]);
    expect(output.missingReproduced).toEqual(["solana-mainnet-pinned"]);
    expect(exitCode).toBe(1);
    const onlySolana = await decide(withCalls([callOf("solana-mainnet-pinned")]));
    expect([onlySolana.exitCode, onlySolana.output.missingReproduced]).toEqual([1, ["base-mainnet-pinned"]]);
    expect(globalFetchAttempts).toBe(0);
  }, 60_000);

  it("R4: a SIMULATED refused-id call returning isError:false with an envelope is outside EXPECTED_OUTCOMES and exits 1", async () => {
    // The real Solana envelope under refuse-l2-finality-on-solana: it reproduces and even binds the subject;
    // only the outcome rule refuses it.
    const id = "refuse-l2-finality-on-solana";
    const { exitCode, output } = await decide(replaced(id, simulatedEnvelopeUnder(id, "solana-mainnet-pinned")));
    expect(output.outcomes.find((o) => o.id === id)).toEqual({ id, outcome: { kind: "observed", code: null }, expected: false });
    expect(output.reports.find((r) => r.id === id)).toMatchObject({ report: { status: "reproduced" }, subjectBound: true });
    expect(output.missingReproduced).toEqual([]);
    expect(exitCode).toBe(1);
    for (const [refused, from] of [
      ["refuse-unsupported-network", "base-mainnet-pinned"], ["refuse-malformed-solana-signature", "solana-mainnet-pinned"],
    ] as const) {
      const decision = await decide(replaced(refused, simulatedEnvelopeUnder(refused, from)));
      expect([refused, decision.exitCode, decision.output.outcomes.find((o) => o.id === refused)?.expected]).toEqual([refused, 1, false]);
    }
    expect(globalFetchAttempts).toBe(0);
  }, 60_000);

  it("R5: the real Solana envelope filed under base-mainnet-pinned exits 1; Base is not counted as reproduced", async () => {
    const id = "base-mainnet-pinned";
    const { exitCode, output } = await decide(replaced(id, simulatedEnvelopeUnder(id, "solana-mainnet-pinned")));
    // Its outcome is in EXPECTED_OUTCOMES and its envelope reproduces; the subject binding refuses it.
    expect(output.outcomes.find((o) => o.id === id)).toEqual({ id, outcome: { kind: "observed", code: null }, expected: true });
    expect(output.outcomes.every((o) => o.expected)).toBe(true);
    expect(output.reports.find((r) => r.id === id)).toMatchObject({ report: { status: "reproduced" }, subjectBound: false });
    expect(output.missingReproduced).toEqual(["base-mainnet-pinned"]);
    expect(exitCode).toBe(1);
    // The Base l2-finality call (same Base subject, other id) does not stand in for base-mainnet-pinned.
    expect(output.reports.find((r) => r.id === "base-mainnet-pinned-l2-finality")).toMatchObject({ subjectBound: true });
    // Swapped both ways: neither required id counts.
    const swapped = await decide(withCalls(capture.calls.map((c) => (
      c.id === "base-mainnet-pinned" ? simulatedEnvelopeUnder(c.id, "solana-mainnet-pinned")
        : c.id === "solana-mainnet-pinned" ? simulatedEnvelopeUnder(c.id, "base-mainnet-pinned") : c))));
    expect([swapped.exitCode, swapped.output.missingReproduced]).toEqual([1, ["base-mainnet-pinned", "solana-mainnet-pinned"]]);
    expect(globalFetchAttempts).toBe(0);
  }, 60_000);

  it("R6: calls [] exits 1; so do a capture without calls and a malformed call", async () => {
    const empty = await decide(withCalls([]));
    expect(empty).toEqual({
      exitCode: 1,
      output: {
        schema: "ne-hosted-reproduction-report/v0.1", acquiringExecutable: null, reproducingCommit: COMMIT,
        outcomes: [], reports: [], missingReproduced: ["base-mainnet-pinned", "solana-mainnet-pinned"],
      },
    });
    for (const value of [null, {}, { calls: null }, { calls: [null] }]) expect((await decide(value)).exitCode).toBe(1);
    // A full capture plus one call whose isError is not a boolean.
    const malformed = { ...clone(capture), calls: [...clone(capture.calls), { ...callOf("base-mainnet-pinned"), isError: "false" }] };
    const decision = await decide(malformed);
    expect([decision.exitCode, decision.output.missingReproduced]).toEqual([1, []]);
    expect(globalFetchAttempts).toBe(0);
  }, 60_000);

  it("R7: synthetic-base-mainnet-subject observed_insufficient is allowed, not required, and does not change the exit", async () => {
    const id = "synthetic-base-mainnet-subject";
    expect(REQUIRED_REPRODUCED_CALLS).not.toContain(id);
    const full = await decide(capture);
    expect(full.output.outcomes.find((o) => o.id === id)).toEqual({ id, outcome: { kind: "observed_insufficient", code: null }, expected: true });
    expect(full.output.reports.find((r) => r.id === id)).toMatchObject({ report: { status: "reproduced" }, subjectBound: true });
    for (const [name, edited] of [
      ["present", capture], ["absent", without(id)], ["SIMULATED source failure", replaced(id, simulatedSourceFailure(id))],
    ] as const) {
      const decision = await decide(edited);
      expect([name, decision.exitCode, decision.output.missingReproduced]).toEqual([name, 0, []]);
    }
    expect(globalFetchAttempts).toBe(0);
  }, 60_000);

  it("R8: the base-mainnet-pinned-l2-finality supplement is never required and never claimed reproduced", async () => {
    const id = "base-mainnet-pinned-l2-finality";
    expect(REQUIRED_REPRODUCED_CALLS).not.toContain(id);
    const { output } = await decide(capture);
    expect(output.reports.find((r) => r.id === id)?.report.opStackSupplement).toMatchObject({
      status: "not_reproducible", reason: "opstack_supplement_without_raw_bytes",
      withdrawalFinalization: "not_evaluated", ethereumSettlement: "not_evaluated",
    });
    const supplements = output.reports.flatMap((r) => (r.report.opStackSupplement === undefined ? [] : [[r.id, r.report.opStackSupplement.status]]));
    expect(supplements).toEqual([[id, "not_reproducible"]]);
    for (const [name, edited] of [["absent", without(id)], ["SIMULATED source failure", replaced(id, simulatedSourceFailure(id))]] as const) {
      const decision = await decide(edited);
      expect([name, decision.exitCode, decision.output.missingReproduced]).toEqual([name, 0, []]);
    }
    // The l2-finality call never stands in for the required Base call.
    const onlyL2 = await decide(without("base-mainnet-pinned"));
    expect([onlyL2.exitCode, onlyL2.output.missingReproduced]).toEqual([1, ["base-mainnet-pinned"]]);
    expect(globalFetchAttempts).toBe(0);
  }, 60_000);

  it("README: the exit rule sits outside the GT-02 operator sequence; no gate row closed", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const sequenceStart = readme.indexOf("### GT-02 operator sequence");
    const sequenceEnd = readme.indexOf("## Capture client", sequenceStart);
    expect(sequenceStart).toBeGreaterThan(0);
    expect(sequenceEnd).toBeGreaterThan(sequenceStart);
    const start = readme.indexOf("### Reproduce CLI exit rule (`reproduce.ts --capture`)");
    expect(start).toBeGreaterThan(0);
    expect(start < sequenceStart || start >= sequenceEnd).toBe(true);
    const end = readme.indexOf("\n## ", start);
    expect(end).toBeGreaterThan(start);
    expect(end <= sequenceStart || start >= sequenceEnd).toBe(true);
    const section = readme.slice(start, end).replace(/\s+/g, " ");
    for (const part of [
      "`base-mainnet-pinned` and `solana-mainnet-pinned`", "`EXPECTED_OUTCOMES`", "`CAPTURE_CALLS[id].arguments.subject`",
      "`missingReproduced`", "`outcomes`", "`ne-hosted-reproduction-report/v0.1`", "GT-04 and GT-06 stay OPEN.",
    ]) expect(section, part).toContain(part);
    expect(readme.slice(sequenceStart, sequenceEnd)).not.toContain("missingReproduced");
  });
});
