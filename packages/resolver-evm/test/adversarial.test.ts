import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";

import {
  acquireTransactionObservation,
  NecResolverEvmError,
  replayTransactionAcquisition,
  scanRpcEnvelope,
  validateEvmAcquisitionFixture,
} from "../src/index.js";
import { NOW, TX, happyPathResponses, scriptedFetch, source, successBlockResultText } from "./helpers.js";

const SRC_DIR = new URL("../src/", import.meta.url);

describe("determinism and hygiene invariants", () => {
  it("source contains no clock or randomness reads", () => {
    for (const name of readdirSync(SRC_DIR)) {
      if (!name.endsWith(".ts")) continue;
      const text = readFileSync(new URL(name, SRC_DIR), "utf8");
      expect(text).not.toMatch(/Date\.now\(/);
      expect(text).not.toMatch(/Math\.random\(/);
    }
  });

  it("envelope scanner preserves byte-exact result text with provider key order and whitespace", () => {
    const weirdResult = '{"zzz": 1,"aaa":2,   "blockNumber":"0x186a0" ,"nested":{"b":[1,2,{"c":"\\u00e9"}]}}';
    const envelope = scanRpcEnvelope(`{"jsonrpc":"2.0","id":99,"result":${weirdResult}}`);
    if (envelope.kind !== "result") throw new Error("expected result");
    expect(envelope.resultText).toBe(weirdResult);
  });

  it("envelope scanner rejects duplicates, trailing content and non-envelope bodies", () => {
    expect(() => scanRpcEnvelope('{"jsonrpc":"2.0","id":1,"result":1,"result":2}')).toThrowError(NecResolverEvmError);
    expect(() => scanRpcEnvelope('{"jsonrpc":"2.0","id":1,"error":{"code":1,"message":"x"},"result":2}')).toThrowError(
      NecResolverEvmError,
    );
    expect(() => scanRpcEnvelope('{"jsonrpc":"2.0","id":1,"result":1} trailing')).toThrowError(/trailing/);
    expect(() => scanRpcEnvelope('{"jsonrpc":"2.0","id":1}')).toThrowError(/neither "result" nor "error"/);
    expect(() => scanRpcEnvelope('{"jsonrpc":"2.0","id":1,"error":{"message":"no code"}}')).toThrowError(
      /requires "code" and "message"/,
    );
    expect(() =>
      scanRpcEnvelope(`${`{"a":`.repeat(65)}1${`}`.repeat(65)}`),
    ).toThrowError(NecResolverEvmError);
  });

  it("own __proto__ data inside provider results stays inert and cannot pollute prototypes", async () => {
    const hostile = `{"transactionHash":"${TX}","transactionIndex":"0x0","blockHash":"0x${"ab".repeat(32)}",` +
      `"blockNumber":"0x186a0","from":"0x${"aa".repeat(20)}","to":null,"contractAddress":null,` +
      `"status":"0x1","gasUsed":"0x5208","cumulativeGasUsed":"0x13108","logsBloom":"0x${"0".repeat(512)}",` +
      `"logs":[],"__proto__":{"polluted":true}}`;
    const { fetchFn } = scriptedFetch(happyPathResponses({ receipt: hostile, block: successBlockResultText() }));
    const acquisition = await acquireTransactionObservation({
      source: source(),
      txHash: TX,
      now: NOW,
      fetchFn,
    });
    expect((Object.prototype as unknown as Record<string, unknown>).polluted).toBeUndefined();
    expect((acquisition.receipt?.extras as Record<string, unknown>)["__proto__"]).toEqual({ polluted: true });
  });

  it("reserved score keys cannot enter normalized records through provider extras", async () => {
    const receipt = successReceiptTextWithExtra("confidence", 0.9);
    const { fetchFn } = scriptedFetch(happyPathResponses({ receipt }));
    await expect(
      acquireTransactionObservation({ source: source(), txHash: TX, now: NOW, fetchFn }),
    ).rejects.toThrowError(/reserved key "confidence"/);
  });

  it("deeply nested extras fail closed on the core depth bound", async () => {
    let deep: unknown = 1;
    for (let i = 0; i < 70; i++) deep = { nested: deep };
    const receipt = successReceiptTextWithExtra("deep", deep);
    const { fetchFn } = scriptedFetch(happyPathResponses({ receipt }));
    await expect(
      acquireTransactionObservation({ source: source(), txHash: TX, now: NOW, fetchFn }),
    ).rejects.toThrowError(NecResolverEvmError);
  });

  it("fixture objects are frozen after validation; mutation attempts cannot alter replay", async () => {
    const fixtureValue = JSON.parse(
      readFileSync(new URL("./fixtures/sepolia-success.json", import.meta.url), "utf8"),
    ) as Record<string, unknown>;
    const fixture = validateEvmAcquisitionFixture(fixtureValue);
    expect(Object.isFrozen(fixture)).toBe(true);
    expect(Object.isFrozen(fixture.captures)).toBe(true);
    expect(Object.isFrozen(fixture.source)).toBe(true);
    await expect(replayTransactionAcquisition(fixture)).resolves.toBeTruthy();
  });

  it("uppercase hash quantities from a hostile provider fail closed (canonical lowercase only)", async () => {
    const receipt = successReceiptTextWithExtra("ignored", true).replace(
      '"blockNumber":"0x186a0"',
      '"blockNumber":"0X186A0"',
    );
    const { fetchFn } = scriptedFetch(happyPathResponses({ receipt }));
    await expect(
      acquireTransactionObservation({ source: source(), txHash: TX, now: NOW, fetchFn }),
    ).rejects.toThrowError(/hex quantity/);
  });

  it("non-object receipts fail closed", async () => {
    const { fetchFn } = scriptedFetch(happyPathResponses({ receipt: "[1,2,3]" }));
    await expect(
      acquireTransactionObservation({ source: source(), txHash: TX, now: NOW, fetchFn }),
    ).rejects.toThrowError(/must be a JSON object/);
  });

  it("wrong-type fields fail closed without coercion", async () => {
    const receipt = successReceiptTextWithExtra("ignored", true).replace('"status":"0x1"', '"status":true');
    const { fetchFn } = scriptedFetch(happyPathResponses({ receipt }));
    await expect(
      acquireTransactionObservation({ source: source(), txHash: TX, now: NOW, fetchFn }),
    ).rejects.toThrowError(/receipt\.status/);
  });
});

function successReceiptTextWithExtra(key: string, value: unknown): string {
  return JSON.stringify({
    transactionHash: TX,
    transactionIndex: "0x0",
    blockHash: `0x${"ab".repeat(32)}`,
    blockNumber: "0x186a0",
    from: `0x${"aa".repeat(20)}`,
    to: `0x${"bb".repeat(20)}`,
    contractAddress: null,
    cumulativeGasUsed: "0x13108",
    effectiveGasPrice: "0x3b9aca00",
    gasUsed: "0x5208",
    logs: [],
    logsBloom: `0x${"0".repeat(512)}`,
    status: "0x1",
    type: "0x2",
    [key]: value,
  });
}
