import { afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  acquireTransactionObservation,
  buildCapture,
  createRecordingFetch,
  NecResolverEvmError,
  replayTransactionAcquisition,
  scanRpcEnvelope,
  sourceProvenance,
  validateEvmAcquisitionFixture,
  validateEvmRpcSourceDescriptor,
  validateFixtureCaptureShape,
} from "../src/index.js";
import type { EvmTransactionAcquisition } from "../src/index.js";
import {
  CHAIN_ID_HEX,
  NETWORK_ID,
  NOW,
  TX,
  CHAIN_ID_DEC,
  happyPathResponses,
  rpcResult,
  scriptedFetch,
  source,
  successBlockResultText,
  successReceiptResultText,
} from "./helpers.js";

// ---------------------------------------------------------------------------
// Local-only HTTP fixtures for redirect provenance (no external network).
// ---------------------------------------------------------------------------

let upstream: { server: Server; port: number; state: { hits: number } } | undefined;
let redirector: { server: Server; port: number } | undefined;
let sameOriginRedirector: { server: Server; port: number } | undefined;
const allServers: Server[] = [];

async function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

/** Valid JSON-RPC upstream: answers every known read by echoing the request id. */
async function startUpstream(): Promise<{ server: Server; port: number; state: { hits: number } }> {
  const state = { hits: 0 };
  const results: Record<string, string> = {
    eth_chainId: JSON.stringify(CHAIN_ID_HEX),
    eth_getTransactionReceipt: successReceiptResultText(),
    eth_getBlockByHash: successBlockResultText(),
  };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      state.hits += 1;
      let idText = "null";
      let method = "";
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        idText = JSON.stringify(parsed.id ?? null);
        method = typeof parsed.method === "string" ? parsed.method : "";
      } catch {
        method = "";
      }
      const result = results[method];
      if (result === undefined) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end('{"jsonrpc":"2.0","id":null,"error":{"code":-32601,"message":"no method"}}');
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(`{"jsonrpc":"2.0","id":${idText},"result":${result}}`);
    });
  });
  const port = await listen(server);
  allServers.push(server);
  return { server, port, state };
}

/** Answers every request with a 302 pointing at another local origin. */
async function startRedirector(target: string): Promise<{ server: Server; port: number }> {
  const server = createServer((_req, res) => {
    res.writeHead(302, { Location: target });
    res.end();
  });
  const port = await listen(server);
  allServers.push(server);
  return { server, port };
}

afterAll(async () => {
  for (const server of allServers) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// ---------------------------------------------------------------------------
// Shared hostile-fixture builders
// ---------------------------------------------------------------------------

function minimalValidFixture(): Record<string, unknown> {
  return {
    schemaVersion: "nec-resolver-evm-fixture-v1",
    acquiredAt: NOW,
    source: {
      sourceId: "src.sepolia.primary",
      sourceType: "evm_rpc",
      networkId: NETWORK_ID,
      chainId: CHAIN_ID_DEC,
    },
    subject: { txHash: TX },
    captures: [
      { rpcMethod: "eth_chainId", rpcParams: [], httpStatus: 200, resultJson: '"0xaa36a7"' },
    ],
  };
}

// ---------------------------------------------------------------------------
// FINDING A1 — redirect provenance
// ---------------------------------------------------------------------------

describe("A1: provenance-changing redirects fail closed", () => {
  it("configured source A redirected to local source B cannot yield captures attributed to A", async () => {
    upstream = await startUpstream();
    redirector = await startRedirector(`http://127.0.0.1:${upstream.port}/upstream-b`);
    // Server B MUST be reachable and healthy in isolation.
    const healthy = await acquireTransactionObservation({
      source: { ...source(), transport: { kind: "http", url: `http://127.0.0.1:${upstream.port}/b` } },
      txHash: TX,
      now: NOW,
      fetchFn: fetch,
    });
    expect(healthy.captures.length).toBeGreaterThan(0);
    expect(upstream.state.hits).toBeGreaterThanOrEqual(1);
    upstream.state.hits = 0;

    // Prove the scenario is REAL: an unguarded fetch WOULD silently follow
    // configured source A -> local source B across origins...
    const naive = await fetch(`http://127.0.0.1:${redirector.port}/a`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"jsonrpc":"2.0","id":0,"method":"eth_chainId","params":[]}',
    });
    await naive.body?.cancel();
    expect(new URL(naive.url).origin).toBe(new URL(`http://127.0.0.1:${upstream.port}/b`).origin);
    expect(upstream.state.hits).toBe(1);

    // ...yet the guarded acquisition fails CLOSED with a controlled error,
    // never acquiring a single byte from B: no capture, no EvidenceRef,
    // nothing attributed to configured source A.
    const error: unknown = await acquireTransactionObservation({
      source: { ...source(), transport: { kind: "http", url: `http://127.0.0.1:${redirector.port}/a` } },
      txHash: TX,
      now: NOW,
      fetchFn: fetch,
    }).then(
      (value: EvmTransactionAcquisition) => value,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(NecResolverEvmError);
    expect((error as Error).message).not.toMatch(/127\.0\.0\.1/);
    expect((error as Error).message).not.toMatch(/https?:\/\//);
    expect(upstream.state.hits).toBe(1);
  });

  it("even a same-origin path redirect is rejected uniformly (simplest safe policy)", async () => {
    // Point the redirect back at ITSELF (same origin, different path).
    const self = await startRedirector("");
    const selfPort = self.port;
    await self.server.close();
    sameOriginRedirector = await startRedirector(`http://127.0.0.1:${selfPort}/elsewhere`);
    const error: unknown = await acquireTransactionObservation({
      source: { ...source(), transport: { kind: "http", url: `http://127.0.0.1:${sameOriginRedirector.port}/a` } },
      txHash: TX,
      now: NOW,
      fetchFn: fetch,
    }).then(
      (value: EvmTransactionAcquisition) => value,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(NecResolverEvmError);
  });

  it("defense in depth: a response whose final URL carries another origin is dropped before recording", async () => {
    const sink: unknown[] = [];
    const spoofed = new Response(rpcResult('"0xaa36a7"'));
    Object.defineProperty(spoofed, "url", { value: "http://other-origin.example/rpc" });
    const recording = createRecordingFetch(sink as never, async () => spoofed, {
      expectedOrigin: new URL("https://sepolia.example/rpc").origin,
    });
    await expect(
      recording("https://sepolia.example/rpc", {
        method: "POST",
        body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}',
      }),
    ).rejects.toThrowError(/configured source origin/);
    expect(sink).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// FINDING A2 — JSON-RPC request/response binding
// ---------------------------------------------------------------------------

describe("A2: strict envelope scanning of jsonrpc/id", () => {
  it('rejects duplicate "id" member', () => {
    expect(() => scanRpcEnvelope('{"jsonrpc":"2.0","id":1,"id":2,"result":1}')).toThrowError(/duplicate "id"/);
  });

  it('rejects duplicate "jsonrpc" member', () => {
    expect(() => scanRpcEnvelope('{"jsonrpc":"2.0","jsonrpc":"2.0","id":1,"result":1}')).toThrowError(
      /duplicate "jsonrpc"/,
    );
  });

  it('rejects jsonrpc other than exactly "2.0"', () => {
    expect(() => scanRpcEnvelope('{"jsonrpc":"1.0","id":1,"result":1}')).toThrowError(/exactly "2\.0"/);
    expect(() => scanRpcEnvelope('{"id":1,"result":1}')).toThrowError(/missing "jsonrpc"/);
  });

  it("rejects invalid id types (boolean/object/float)", () => {
    expect(() => scanRpcEnvelope('{"jsonrpc":"2.0","id":true,"result":1}')).toThrowError(/"id" must be/);
    expect(() => scanRpcEnvelope('{"jsonrpc":"2.0","id":{"x":1},"result":1}')).toThrowError(/"id" must be/);
    expect(() => scanRpcEnvelope('{"jsonrpc":"2.0","id":1.5,"result":1}')).toThrowError(/"id" must be/);
  });

  it("accepts string/null ids and exposes the scanned id", () => {
    expect(scanRpcEnvelope('{"jsonrpc":"2.0","id":"abc-7","result":1}')).toMatchObject({ kind: "result", id: "abc-7" });
    expect(scanRpcEnvelope('{"jsonrpc":"2.0","id":null,"result":1}')).toMatchObject({ kind: "result", id: null });
  });

  it("keeps batch responses rejected", () => {
    expect(() => scanRpcEnvelope('[{"jsonrpc":"2.0","id":1,"result":1}]')).toThrowError(NecResolverEvmError);
  });
});

describe("A2: response id binds to the actual outbound request id", () => {
  const provenance = sourceProvenance(source());

  it("matching request/response id succeeds", () => {
    const capture = buildCapture({
      provenance,
      rpcMethod: "eth_chainId",
      rpcRequestId: 42,
      rpcParams: [],
      httpStatus: 200,
      responseBody: '{"jsonrpc":"2.0","id":42,"result":"0xaa36a7"}',
      acquiredAt: NOW,
    });
    expect(capture.resultText).toBe('"0xaa36a7"');
    expect(capture.sourceId).toBe(provenance.sourceId);
  });

  it("mismatched response id fails closed", () => {
    expect(() =>
      buildCapture({
        provenance,
        rpcMethod: "eth_chainId",
        rpcRequestId: 42,
        rpcParams: [],
        httpStatus: 200,
        responseBody: '{"jsonrpc":"2.0","id":43,"result":"0xaa36a7"}',
        acquiredAt: NOW,
      }),
    ).toThrowError(/does not match the outbound request id/);
  });

  it("missing response id (where a request id exists) fails closed", () => {
    expect(() =>
      buildCapture({
        provenance,
        rpcMethod: "eth_chainId",
        rpcRequestId: 42,
        rpcParams: [],
        httpStatus: 200,
        responseBody: '{"jsonrpc":"2.0","result":"0xaa36a7"}',
        acquiredAt: NOW,
      }),
    ).toThrowError(/does not match the outbound request id/);
  });

  it("records the actual outbound request id on the recording transport", async () => {
    const sink: Array<{ rpcRequestId: unknown }> = [];
    const recording = createRecordingFetch(sink as never, async (_input, init) => {
      const body = typeof init?.body === "string" ? init.body : "{}";
      const id = (JSON.parse(body) as Record<string, unknown>).id;
      return new Response(`{"jsonrpc":"2.0","id":${JSON.stringify(id)},"result":"0xaa36a7"}`);
    });
    await recording("https://sepolia.example/rpc", {
      method: "POST",
      body: '{"jsonrpc":"2.0","id":987,"method":"eth_chainId","params":[]}',
    });
    expect(sink[0]?.rpcRequestId).toBe(987);
  });

  it("live pipeline: mismatched response id fails closed; echoed id succeeds", async () => {
    const mismatched = happyPathResponses({});
    (mismatched[0] as { mutate?: (body: string) => string }).mutate = (body: string) =>
      body.replace(/^(\{"jsonrpc":"2\.0","id":)[^,]*/, (_m, p1: string) => `${p1}424242`);
    const { fetchFn } = scriptedFetch(mismatched);
    await expect(
      acquireTransactionObservation({ source: source(), txHash: TX, now: NOW, fetchFn }),
    ).rejects.toThrowError(/does not match the outbound request id/);

    const { fetchFn: echoing } = scriptedFetch(happyPathResponses({ block: successBlockResultText() }));
    const acquisition = await acquireTransactionObservation({
      source: source(),
      txHash: TX,
      now: NOW,
      fetchFn: echoing,
    });
    expect(acquisition.captures.length).toBe(3);
    expect(acquisition.consistent).toBe(true);
  });

  it("live pipeline: duplicate id, duplicate jsonrpc and wrong version all fail closed", async () => {
    const dupId = happyPathResponses({});
    (dupId[0] as { mutate?: (body: string) => string }).mutate = (body: string) =>
      body.replace(/^(\{"jsonrpc":"2\.0","id":)([^,]*)/, (_m, p1: string, p2: string) => `${p1}${p2},${p1}${p2}`);
    const dupJsonrpc = happyPathResponses({});
    (dupJsonrpc[0] as { mutate?: (body: string) => string }).mutate = (body: string) =>
      body.replace(/^\{"jsonrpc":"2\.0",/, '{"jsonrpc":"2.0","jsonrpc":"2.0",');
    const wrongVersion = happyPathResponses({});
    (wrongVersion[0] as { mutate?: (body: string) => string }).mutate = (body: string) =>
      body.replace('"jsonrpc":"2.0"', '"jsonrpc":"1.0"');
    for (const responses of [dupId, dupJsonrpc, wrongVersion]) {
      const { fetchFn } = scriptedFetch(responses);
      await expect(
        acquireTransactionObservation({ source: source(), txHash: TX, now: NOW, fetchFn }),
      ).rejects.toThrowError(NecResolverEvmError);
    }
  });

  it("replay remains byte/deterministically equivalent after id binding (replay echoes actual ids)", async () => {
    const fixtureValue = committedFixture("sepolia-success.json");
    const a = await replayTransactionAcquisition(structuredCloneFixture(fixtureValue));
    const b = await replayTransactionAcquisition(structuredCloneFixture(fixtureValue));
    const canon = (value: EvmTransactionAcquisition) =>
      JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? `${v}n` : v));
    expect(canon(a)).toBe(canon(b));
    expect(a.captures.map((c) => c.contentDigest)).toEqual(b.captures.map((c) => c.contentDigest));

    // A responder answering with a WRONG (hardcoded) id cannot satisfy the
    // pipeline — proving replay traverses the same binding invariant.
    const wrongResponder = scriptedFetch([
      {
        expectMethod: "eth_chainId",
        bodyText: rpcResult('"0xaa36a7"'),
        mutate: (body) => body.replace(/^(\{"jsonrpc":"2\.0","id":)[^,]*/, (_m, p1: string) => `${p1}999999`),
      },
    ]);
    await expect(
      acquireTransactionObservation({ source: source(), txHash: TX, now: NOW, fetchFn: wrongResponder.fetchFn }),
    ).rejects.toThrowError(/does not match the outbound request id/);
  });
});

function committedFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as Record<string, unknown>;
}

function structuredCloneFixture(value: Record<string, unknown>): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

// ---------------------------------------------------------------------------
// FINDING C1 — getters never execute during hostile fixture rejection
// ---------------------------------------------------------------------------

describe("C1: rpcParams validation is descriptor-first end to end", () => {
  function captureWithParams(rpcParams: unknown): Record<string, unknown> {
    return { rpcMethod: "eth_chainId", rpcParams, httpStatus: 200, resultJson: '"0xaa36a7"' };
  }

  it("nested object getters are never invoked during rejection", () => {
    let reads = 0;
    const nested: Record<string, unknown> = {};
    Object.defineProperty(nested, "x", {
      enumerable: true,
      get() {
        reads += 1;
        return 1;
      },
    });
    const capture = captureWithParams([{ nested }]);
    expect(() => validateFixtureCaptureShape(capture)).toThrowError(NecResolverEvmError);
    expect(reads).toBe(0);

    const fixture = minimalValidFixture();
    (fixture.captures as Array<Record<string, unknown>>)[0] = capture;
    expect(() => validateEvmAcquisitionFixture(fixture)).toThrowError(NecResolverEvmError);
    expect(reads).toBe(0);
  });

  it("rpcParams array-index getters are never invoked during rejection", () => {
    let reads = 0;
    const arr: unknown[] = [];
    Object.defineProperty(arr, 0, {
      enumerable: true,
      get() {
        reads += 1;
        return 7;
      },
    });
    const capture = captureWithParams(arr);
    expect(() => validateFixtureCaptureShape(capture)).toThrowError(NecResolverEvmError);
    expect(reads).toBe(0);

    const fixture = minimalValidFixture();
    (fixture.captures as Array<Record<string, unknown>>)[0] = capture;
    expect(() => validateEvmAcquisitionFixture(fixture)).toThrowError(NecResolverEvmError);
    expect(reads).toBe(0);
  });

  it("throwing getters cannot escape as raw exceptions; rejection stays controlled", () => {
    let reads = 0;
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, "boom", {
      enumerable: true,
      get(): never {
        reads += 1;
        throw new RangeError("raw escape");
      },
    });
    const capture = captureWithParams([hostile]);
    const directError: unknown = (() => {
      try {
        validateFixtureCaptureShape(capture);
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(directError).toBeInstanceOf(NecResolverEvmError);
    expect(directError).not.toBeInstanceOf(RangeError);
    expect(reads).toBe(0);

    const fixture = minimalValidFixture();
    (fixture.captures as Array<Record<string, unknown>>)[0] = capture;
    const fixtureError: unknown = (() => {
      try {
        validateEvmAcquisitionFixture(fixture);
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(fixtureError).toBeInstanceOf(NecResolverEvmError);
    expect((fixtureError as Error).name).toBe("NecResolverEvmError");
    expect(reads).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// FINDING C2 — symbol-keyed hidden properties are rejected
// ---------------------------------------------------------------------------

describe("C2: symbol-keyed own properties fail closed", () => {
  const PAYLOAD = Symbol("hidden-payload");

  it("symbol key on a capture object is rejected", () => {
    const capture: Record<string, unknown> = {
      rpcMethod: "eth_chainId",
      rpcParams: [],
      httpStatus: 200,
      resultJson: '"0xaa36a7"',
      [PAYLOAD]: "smuggled",
    };
    expect(() => validateFixtureCaptureShape(capture)).toThrowError(/symbol-keyed property rejected/);

    const fixture = minimalValidFixture();
    (fixture.captures as Array<Record<string, unknown>>)[0] = capture;
    expect(() => validateEvmAcquisitionFixture(fixture)).toThrowError(/symbol-keyed property rejected/);
  });

  it("symbol key on a plain object nested in rpcParams is rejected", () => {
    const nested: Record<string, unknown> = { ok: 1, [PAYLOAD]: "smuggled" };
    const capture = {
      rpcMethod: "eth_chainId",
      rpcParams: [nested],
      httpStatus: 200,
      resultJson: '"0xaa36a7"',
    };
    const fixture = minimalValidFixture();
    (fixture.captures as Array<Record<string, unknown>>)[0] = capture;
    expect(() => validateEvmAcquisitionFixture(fixture)).toThrowError(/symbol-keyed property rejected/);
  });

  it("symbol key on an rpcParams array is rejected", () => {
    const arr: unknown[] = ["0xaa36a7"];
    Object.defineProperty(arr, PAYLOAD, { enumerable: true, value: "smuggled" });
    const capture = {
      rpcMethod: "eth_chainId",
      rpcParams: arr,
      httpStatus: 200,
      resultJson: '"0xaa36a7"',
    };
    const fixture = minimalValidFixture();
    (fixture.captures as Array<Record<string, unknown>>)[0] = capture;
    expect(() => validateEvmAcquisitionFixture(fixture)).toThrowError(/symbol-keyed property rejected/);
  });

  it("symbol key on a capture.error object is rejected", () => {
    const error: Record<string, unknown> = {
      code: -32000,
      message: "provider error",
      [PAYLOAD]: "smuggled",
    };
    const capture = {
      rpcMethod: "eth_getTransactionReceipt",
      rpcParams: [TX],
      httpStatus: 200,
      error,
    };
    const fixture = minimalValidFixture();
    (fixture.captures as Array<Record<string, unknown>>)[0] = capture;
    expect(() => validateEvmAcquisitionFixture(fixture)).toThrowError(/symbol-keyed property rejected/);
  });

  it("no hidden symbol payload survives a validated fixture", async () => {
    const fixture = validateEvmAcquisitionFixture(committedFixture("sepolia-success.json"));
    await replayTransactionAcquisition(committedFixture("sepolia-success.json"));
    let symbols = 0;
    const visit = (value: unknown): void => {
      if (value === null || typeof value !== "object") return;
      symbols += Reflect.ownKeys(value).filter((k) => typeof k === "symbol").length;
      for (const child of Object.values(value as Record<string, unknown>)) visit(child);
    };
    visit(fixture);
    expect(symbols).toBe(0);
  });

  it("symbol keys on the source descriptor are rejected", () => {
    const bad: unknown = { ...source(), [PAYLOAD]: "smuggled" };
    expect(() => validateEvmRpcSourceDescriptor(bad)).toThrowError(/symbol-keyed property rejected/);
  });
});
