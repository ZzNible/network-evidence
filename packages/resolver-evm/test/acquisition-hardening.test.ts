import { describe, expect, it } from "vitest";

import {
  acquireTransactionObservation,
  createRecordingFetch,
  NecResolverEvmError,
} from "../src/index.js";
import type { EvmRpcSourceDescriptor } from "../src/index.js";
import {
  BLOCK_NUMBER_HEX,
  CHAIN_ID_DEC,
  NETWORK_ID,
  NOW,
  TX,
  rpcError,
  rpcResult,
  scriptedFetch,
  successBlockResultText,
  successReceiptResultText,
} from "./helpers.js";

function baseSource(overrides: Partial<EvmRpcSourceDescriptor> = {}): EvmRpcSourceDescriptor {
  return {
    sourceId: "src.sepolia.primary",
    sourceType: "evm_rpc",
    networkId: NETWORK_ID,
    chainId: CHAIN_ID_DEC,
    transport: { kind: "http", url: "https://sepolia.example/rpc/v3/SECRET-TOKEN" },
    ...overrides,
  };
}

function happy(opts: { receipt?: string; block?: string } = {}): Array<{
  expectMethod: string;
  bodyText: string;
  status?: number;
}> {
  return [
    { expectMethod: "eth_chainId", bodyText: rpcResult('"0xaa36a7"') },
    { expectMethod: "eth_getTransactionReceipt", bodyText: rpcResult(opts.receipt ?? successReceiptResultText()) },
    ...(opts.block === undefined ? [] : [{ expectMethod: "eth_getBlockByHash", bodyText: rpcResult(opts.block) }]),
  ];
}

describe("input validation fails closed", () => {
  it.each([
    ["ftp endpoint", { transport: { kind: "http", url: "ftp://sepolia.example" } }],
    ["credentials in url", { transport: { kind: "http", url: "https://user:pass@sepolia.example" } }],
    ["unknown key", { curator: "someone" }],
    ["bad sourceId grammar", { sourceId: "has space" }],
    ["bad networkId", { networkId: "not a network id!" }],
    ["zero chainId", { chainId: 0 }],
    ["missing transport", { transport: undefined }],
  ])("rejects source descriptor: %s", async (_name, overrides) => {
    const bad = overrides as unknown as Record<string, unknown>;
    await expect(
      acquireTransactionObservation({
        source: { ...baseSource(), ...bad } as EvmRpcSourceDescriptor,
        txHash: TX,
        now: NOW,
        fetchFn: async () => new Response("{}"),
      }),
    ).rejects.toBeInstanceOf(NecResolverEvmError);
  });

  it.each(["0x1234", `0X${"11".repeat(32)}`, `0x${"11".repeat(31)}`, `0x${"AA".repeat(32)}`, "", 42 as unknown as string])(
    "rejects malformed txHash %j",
    async (hash) => {
      const { fetchFn } = scriptedFetch(happy());
      await expect(
        acquireTransactionObservation({ source: baseSource(), txHash: hash, now: NOW, fetchFn }),
      ).rejects.toThrowError(NecResolverEvmError);
    },
  );

  it.each(["2026-03-14T09:26:53Z", "not-a-time", "2026-13-01T00:00:00.000Z"])("rejects invalid acquisition time %j", async (now) => {
    const { fetchFn } = scriptedFetch(happy({ block: successBlockResultText() }));
    await expect(
      acquireTransactionObservation({ source: baseSource(), txHash: TX, now, fetchFn }),
    ).rejects.toThrowError(NecResolverEvmError);
  });

  it("refuses to run without an explicit fetchFn (no implicit network)", async () => {
    await expect(
      acquireTransactionObservation({ source: baseSource(), txHash: TX, now: NOW, fetchFn: undefined }),
    ).rejects.toThrowError(/implicit global network access/);
  });
});

describe("resource and hostile-response handling on the live path", () => {
  it("does not lose precision on a hostile oversized block quantity", async () => {
    // 40 significant hex digits (~2^158) — far beyond Number precision.
    const hostileNumber = "0x1234567890abcdef1234567890abcdef12345678";
    const receipt = successReceiptResultText({ blockNumber: hostileNumber });
    const block = successBlockResultText({
      number: hostileNumber,
      transactions: [],
      gasUsed: "0x5208",
    });
    const { fetchFn } = scriptedFetch(happy({ receipt, block }));
    const acquisition = await acquireTransactionObservation({ source: baseSource(), txHash: TX, now: NOW, fetchFn });

    const expected = BigInt(hostileNumber);
    expect(acquisition.receipt?.blockNumber).toBe(expected);
    expect(acquisition.block?.number).toBe(expected);
    // The same value through Number would have lost digits:
    expect(String(Number(expected))).not.toBe(String(expected));
    // And the raw text preserves the provider's exact bytes.
    expect(acquisition.captures[1]?.resultText).toContain(hostileNumber);
  });

  it("rejects absurd quantities beyond the decimal-digit bound", async () => {
    const huge = `0x${"f".repeat(1001)}`;
    const receipt = successReceiptResultText({ gasUsed: huge });
    const { fetchFn } = scriptedFetch(happy({ receipt, block: successBlockResultText() }));
    await expect(
      acquireTransactionObservation({ source: baseSource(), txHash: TX, now: NOW, fetchFn }),
    ).rejects.toThrowError(/exceeds 1000 digits/);
  });

  it("wraps JSON-RPC error envelopes into controlled errors without leaking the endpoint", async () => {
    const responses = happy();
    responses[1] = { expectMethod: "eth_getTransactionReceipt", bodyText: rpcError(-32005, "rate limited") };
    const { fetchFn } = scriptedFetch(responses);
    const error = await acquireTransactionObservation({
      source: baseSource(),
      txHash: TX,
      now: NOW,
      fetchFn,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NecResolverEvmError);
    expect((error as Error).message).toContain("rate limited");
    expect((error as Error).message).not.toContain("https://");
    expect((error as Error).message).not.toContain("SECRET-TOKEN");
  });

  it("wraps HTTP-level failures with redaction", async () => {
    const responses = happy();
    responses[1] = { expectMethod: "eth_getTransactionReceipt", bodyText: "<html>gateway timeout</html>", status: 504 };
    const { fetchFn } = scriptedFetch(responses);
    const error = await acquireTransactionObservation({
      source: baseSource(),
      txHash: TX,
      now: NOW,
      fetchFn,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NecResolverEvmError);
    expect((error as Error).message).not.toContain("https://");
  });

  it("records acquiredAt exclusively from context (no clock reads)", async () => {
    const t1 = "2026-01-01T00:00:00.000Z";
    const t2 = "2027-12-31T23:59:59.999Z";
    const a = await run(t1);
    const b = await run(t2);
    for (const capture of a.captures) expect(capture.acquiredAt).toBe(t1);
    for (const capture of b.captures) expect(capture.acquiredAt).toBe(t2);
    // Normalized observations are time-independent; only captures bind time.
    expect(a.receipt).toEqual(b.receipt);

    async function run(now: string) {
      const { fetchFn } = scriptedFetch(happy({ block: successBlockResultText() }));
      return acquireTransactionObservation({ source: baseSource(), txHash: TX, now, fetchFn });
    }
  });

  it("keeps two configured sources distinguishable (no provenance laundering)", async () => {
    const world = happy({ block: successBlockResultText() });
    const a = await acquireTransactionObservation({
      source: baseSource(),
      txHash: TX,
      now: NOW,
      fetchFn: scriptedFetch(world.map((r) => ({ ...r }))).fetchFn,
    });
    const b = await acquireTransactionObservation({
      source: { ...baseSource(), sourceId: "src.sepolia.backup", independenceGroup: "sepolia-rpc-b" },
      txHash: TX,
      now: NOW,
      fetchFn: scriptedFetch(world.map((r) => ({ ...r }))).fetchFn,
    });
    const digestsA = a.captures.map((c) => c.contentDigest);
    const digestsB = b.captures.map((c) => c.contentDigest);
    expect(digestsA).not.toEqual(digestsB);
    expect(a.source.sourceId).not.toBe(b.source.sourceId);
    expect(a.source.independenceGroup).not.toBe(b.source.independenceGroup);
    // Identical semantics, different provenance.
    expect(a.receipt).toEqual(b.receipt);
    expect(a.subject).toEqual(b.subject);
  });

  it("rejects batched outbound payloads in the recording fetch", async () => {
    const sink: unknown[] = [];
    const recording = createRecordingFetch(sink as never, async () => new Response("{}"));
    await expect(
      recording("https://x.example", {
        method: "POST",
        body: '[{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}]',
      }),
    ).rejects.toThrowError(/batched JSON-RPC/);
  });

  it("freezes acquisitions so captured provenance cannot be mutated after the fact", async () => {
    const { fetchFn } = scriptedFetch(happy({ block: successBlockResultText() }));
    const acquisition = await acquireTransactionObservation({ source: baseSource(), txHash: TX, now: NOW, fetchFn });
    expect(Object.isFrozen(acquisition)).toBe(true);
    expect(Object.isFrozen(acquisition.captures[0])).toBe(true);
    expect(Object.isFrozen(acquisition.checks)).toBe(true);
  });

  it("preserves unconsumed provider fields as bounded extras", async () => {
    const receiptWithExtras = successReceiptResultText({ reconciliationSeed: "0xdeadbeef" });
    const { fetchFn } = scriptedFetch(happy({ receipt: receiptWithExtras, block: successBlockResultText() }));
    const acquisition = await acquireTransactionObservation({ source: baseSource(), txHash: TX, now: NOW, fetchFn });
    expect(acquisition.receipt?.extras["reconciliationSeed"]).toBe("0xdeadbeef");
  });

  it("documents canonical quantity acceptance: leading zeros normalize to exact bigint while raw text is preserved", async () => {
    const padded = BLOCK_NUMBER_HEX.replace("0x186a0", "0x00000000000186a0");
    const receipt = successReceiptResultText({ blockNumber: padded });
    const block = successBlockResultText({ number: padded });
    const { fetchFn } = scriptedFetch(happy({ receipt, block }));
    const acquisition = await acquireTransactionObservation({ source: baseSource(), txHash: TX, now: NOW, fetchFn });
    expect(acquisition.receipt?.blockNumber).toBe(100000n);
    expect(acquisition.captures[1]?.resultText).toContain(padded);
  });
});
