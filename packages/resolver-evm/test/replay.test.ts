import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import {
  acquireTransactionObservation,
  buildEvmAcquisitionFixture,
  replayTransactionAcquisition,
  validateEvmAcquisitionFixture,
  NecResolverEvmError,
} from "../src/index.js";
import type { EvmTransactionAcquisition } from "../src/index.js";
import { NOW, TX, happyPathResponses, scriptedFetch, source, successBlockResultText, successReceiptResultText } from "./helpers.js";

function fixtureDirFile(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as unknown;
}

async function liveSuccess(): Promise<EvmTransactionAcquisition> {
  const { fetchFn } = scriptedFetch(happyPathResponses({ block: successBlockResultText() }));
  return acquireTransactionObservation({ source: source(), txHash: TX, now: NOW, fetchFn });
}

describe("committed JSON fixtures replay offline", () => {
  it.each(["sepolia-success.json", "sepolia-reverted.json", "sepolia-missing-receipt.json"])(
    "%s validates and replays with consistent results",
    async (name) => {
      const fixture = validateEvmAcquisitionFixture(fixtureDirFile(name));
      const acquisition = await replayTransactionAcquisition(fixture);
      expect(acquisition.profile).toBe("nec-resolver-evm-acquisition-v1");
      expect(Object.isFrozen(acquisition)).toBe(true);
      if (name === "sepolia-reverted.json") expect(acquisition.receipt?.status).toBe("reverted");
      if (name === "sepolia-missing-receipt.json") expect(acquisition.receipt).toBeNull();
      // Revert is coherent evidence, not an inconsistency.
      expect(acquisition.consistent).toBe(true);
    },
  );

  it("fixture files never carry endpoint URLs or credentials", () => {
    for (const name of ["sepolia-success.json", "sepolia-reverted.json", "sepolia-missing-receipt.json"]) {
      const text = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
      expect(text).not.toMatch(/https?:\/\//);
      expect(text.toLowerCase()).not.toContain("apikey");
      expect(text.toLowerCase()).not.toContain("secret");
      expect(text.toLowerCase()).not.toContain("token");
      expect(text.toLowerCase()).not.toContain("password");
    }
  });

  it("replay performs zero network calls (global fetch must never be touched)", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("network access during replay");
    }) as typeof fetch;
    try {
      const acquisition = await replayTransactionAcquisition(fixtureDirFile("sepolia-success.json"));
      expect(acquisition.receipt?.blockNumber).toBe(100000n);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("deterministic replay identity", () => {
  it("replaying the same fixture twice yields identical normalized observations and captures", async () => {
    const fixture = validateEvmAcquisitionFixture(fixtureDirFile("sepolia-success.json"));
    const a = await replayTransactionAcquisition(fixture);
    const b = await replayTransactionAcquisition(fixture);
    const canon = (value: EvmTransactionAcquisition) =>
      JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? `${v}n` : v));
    expect(canon(a)).toBe(canon(b));
    expect(a.captures.map((c) => c.contentDigest)).toEqual(b.captures.map((c) => c.contentDigest));
  });

  it("live acquisition round-trips through buildEvmAcquisitionFixture to a byte-identical replay", async () => {
    const live = await liveSuccess();
    const fixture = buildEvmAcquisitionFixture(live);
    const replayed = await replayTransactionAcquisition(JSON.parse(JSON.stringify(fixture)));
    expect(replayed.receipt).toEqual(live.receipt);
    expect(replayed.block).toEqual(live.block);
    expect(replayed.chain).toEqual(live.chain);
    expect(replayed.checks).toEqual(live.checks);
    expect(replayed.captures).toEqual(live.captures);
    expect(replayed.consistent).toBe(live.consistent);
  });
});

describe("invalid or mismatched fixtures fail closed", () => {
  it.each([
    ["bad schemaVersion", { schemaVersion: "nec-resolver-evm-fixture-v2" }],
    ["unknown top key", { curator: "x" }],
    ["bad acquiredAt", { acquiredAt: "2026-03-14T09:26:53Z" }],
    ["impossible calendar date", { acquiredAt: "2026-02-30T00:00:00.000Z" }],
    ["explicit undefined optional", { sourceOverride: true }],
    ["httpStatus out of range", { captureIndex: -1 }],
  ])("%s", async (name, _probe) => {
    void name;
    const fixture = structuredCloneSafe(fixtureDirFile("sepolia-success.json")) as Record<string, unknown>;
    applyProbe(fixture);
    function applyProbe(target: Record<string, unknown>): void {
      switch (name) {
        case "bad schemaVersion":
          target.schemaVersion = "nec-resolver-evm-fixture-v2";
          break;
        case "unknown top key":
          target.curator = "x";
          break;
        case "bad acquiredAt":
          target.acquiredAt = "2026-03-14T09:26:53Z";
          break;
        case "impossible calendar date":
          target.acquiredAt = "2026-02-30T00:00:00.000Z";
          break;
        case "explicit undefined optional":
          target.source = { ...(target.source as object), independenceGroup: undefined };
          break;
        case "httpStatus out of range": {
          const captures = target.captures as Array<Record<string, unknown>>;
          captures[0]!.httpStatus = 99;
          break;
        }
      }
    }
    expect(() => validateEvmAcquisitionFixture(fixture)).toThrowError(NecResolverEvmError);
  });

  it("rejects duplicate captures for the same request", () => {
    const fixture = structuredCloneSafe(fixtureDirFile("sepolia-missing-receipt.json")) as Record<string, unknown>;
    (fixture.captures as unknown[]).push((fixture.captures as unknown[])[0]);
    expect(() => validateEvmAcquisitionFixture(fixture)).toThrowError(/duplicate capture/);
  });

  it("rejects getter-poisoned capture objects without reading values", () => {
    let getterReads = 0;
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, "rpcMethod", {
      enumerable: true,
      get() {
        getterReads += 1;
        return "eth_chainId";
      },
    });
    hostile.rpcParams = [];
    hostile.httpStatus = 200;
    hostile.resultJson = '"0x1"';
    expect(() => validateEvmAcquisitionFixture({ ...minimalValid(), captures: [hostile] })).toThrowError(
      /accessor|exotic|unknown key|must be/i,
    );
    // The validator rejected the shape without executing the accessor.
    expect(getterReads).toBe(0);
  });

  it("rejects exotic prototypes in the fixture tree", () => {
    class Hostile extends Array {}
    const fixture = minimalValid();
    (fixture.captures as unknown[])[0] = new Hostile();
    expect(() => validateEvmAcquisitionFixture(fixture)).toThrowError(NecResolverEvmError);
  });

  it("rejects non-safe integers in rpcParams", () => {
    const fixture = minimalValid();
    ((fixture.captures as unknown[])[0] as Record<string, unknown>).rpcParams = [9007199254740993];
    expect(() => validateEvmAcquisitionFixture(fixture)).toThrowError(/non-safe-integer/);
  });

  it("rejects an unparseable stored result envelope", () => {
    const fixture = minimalValid();
    ((fixture.captures as unknown[])[0] as Record<string, unknown>).resultJson = '{"unterminated:';
    expect(() => validateEvmAcquisitionFixture(fixture)).toThrowError(NecResolverEvmError);
  });

  it("fails closed when the pipeline needs a capture the fixture does not carry", async () => {
    const fixture = structuredCloneSafe(fixtureDirFile("sepolia-success.json")) as Record<string, unknown>;
    fixture.captures = (fixture.captures as unknown[]).slice(0, 2); // drop block capture
    await expect(replayTransactionAcquisition(fixture)).rejects.toThrowError(EVM_REPLAY_UNMATCHED);
  });

  it("fails closed when the fixture carries captures the pipeline never requests", async () => {
    const fixture = structuredCloneSafe(fixtureDirFile("sepolia-missing-receipt.json")) as Record<string, unknown>;
    (fixture.captures as unknown[]).push({
      rpcMethod: "eth_getTransactionByHash",
      rpcParams: [TX],
      httpStatus: 200,
      resultJson: "null",
    });
    await expect(replayTransactionAcquisition(fixture)).rejects.toThrowError(EVM_REPLAY_UNUSED);
  });

  it("replays provider error envelopes into controlled acquisition failures", async () => {
    const fixture = structuredCloneSafe(fixtureDirFile("sepolia-missing-receipt.json")) as Record<string, unknown>;
    delete (fixture.captures as unknown[])[1];
    (fixture.captures as unknown[])[1] = {
      rpcMethod: "eth_getTransactionReceipt",
      rpcParams: [TX],
      httpStatus: 200,
      error: { code: -32000, message: "receipt backend unavailable" },
    };
    await expect(replayTransactionAcquisition(fixture)).rejects.toThrowError(/receipt backend unavailable/);
  });
});

const EVM_REPLAY_UNMATCHED = "no fixture capture matches";
const EVM_REPLAY_UNUSED = "never requested";

function structuredCloneSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? String(v) : v))) as T;
}

function minimalValid(): Record<string, unknown> {
  return {
    schemaVersion: "nec-resolver-evm-fixture-v1",
    acquiredAt: NOW,
    source: {
      sourceId: "src.sepolia.primary",
      sourceType: "evm_rpc",
      networkId: "eip155:11155111",
      chainId: 11155111,
    },
    subject: { txHash: TX },
    captures: [
      { rpcMethod: "eth_chainId", rpcParams: [], httpStatus: 200, resultJson: '"0xaa36a7"' },
    ],
  };
}
