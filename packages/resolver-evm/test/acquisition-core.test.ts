import { describe, expect, it } from "vitest";

import { acquireTransactionObservation } from "../src/index.js";
import {
  BLOCK_HASH,
  CHAIN_ID_DEC,
  FROM,
  MINER,
  NETWORK_ID,
  NOW,
  TO,
  TOKEN,
  TX,
  happyPathResponses,
  scriptedFetch,
  source,
  successBlockResultText,
  successReceiptResultText,
  successTransactionResultText,
  transferLog,
} from "./helpers.js";

describe("live acquisition path (scripted offline fetch, ordinary Viem pipeline)", () => {
  it("acquires a successful transaction with full provenance and passed checks", async () => {
    const { fetchFn, seen } = scriptedFetch(happyPathResponses({ block: successBlockResultText() }));
    const acquisition = await acquireTransactionObservation({ source: source(), txHash: TX, now: NOW, fetchFn });

    expect(acquisition.profile).toBe("nec-resolver-evm-acquisition-v1");
    expect(acquisition.source.sourceId).toBe("src.sepolia.primary");
    expect(acquisition.source.networkId).toBe(NETWORK_ID);
    expect(acquisition.subject.txHash).toBe(TX);
    expect(acquisition.acquiredAt).toBe(NOW);
    expect(acquisition.chain.chainId).toBe(BigInt(CHAIN_ID_DEC));
    expect(acquisition.consistent).toBe(true);
    expect(seen.methods).toEqual(["eth_chainId", "eth_getTransactionReceipt", "eth_getBlockByHash"]);

    expect(acquisition.receipt?.status).toBe("success");
    expect(acquisition.receipt?.blockNumber).toBe(100000n);
    expect(acquisition.receipt?.from).toBe(FROM);
    expect(acquisition.receipt?.to).toBe(TO);
    expect(acquisition.block?.hash).toBe(BLOCK_HASH);
    expect(acquisition.block?.number).toBe(100000n);
    expect(acquisition.block?.miner).toBe(MINER);

    for (const capture of acquisition.captures) {
      expect(capture.sourceId).toBe("src.sepolia.primary");
      expect(capture.independenceGroup).toBe("sepolia-rpc-a");
      expect(capture.acquiredAt).toBe(NOW);
      expect(capture.contentDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
    const serialized = JSON.stringify(acquisition, (_key, v: unknown) => (typeof v === "bigint" ? `${v}n` : v));
    expect(serialized).not.toContain("https://");
    expect(serialized).not.toContain("SECRET-TOKEN");
  });

  it("captures byte-exact raw result text including logs", async () => {
    const receiptText = successReceiptResultText();
    const { fetchFn } = scriptedFetch(happyPathResponses({ receipt: receiptText, block: successBlockResultText() }));
    const acquisition = await acquireTransactionObservation({ source: source(), txHash: TX, now: NOW, fetchFn });
    expect(acquisition.captures[1]?.resultText).toBe(receiptText);
  });

  it("optionally queries the transaction and cross-checks coherence", async () => {
    const { fetchFn } = scriptedFetch(
      happyPathResponses({
        receipt: successReceiptResultText(),
        block: successBlockResultText(),
        transaction: successTransactionResultText(),
      }),
    );
    const acquisition = await acquireTransactionObservation({
      source: source(),
      txHash: TX,
      now: NOW,
      fetchFn,
      includeTransaction: true,
    });
    expect(acquisition.captures).toHaveLength(4);
    expect(acquisition.transaction?.value).toBe(10000000000000000n);
    expect(acquisition.consistent).toBe(true);
  });

  it("normalizes a reverted transaction as evidence, not as failure", async () => {
    const reverted = successReceiptResultText({ status: "0x0", gasUsed: "0x1194", cumulativeGasUsed: "0x1194" });
    const { fetchFn } = scriptedFetch(happyPathResponses({ receipt: reverted, block: successBlockResultText() }));
    const acquisition = await acquireTransactionObservation({ source: source(), txHash: TX, now: NOW, fetchFn });
    expect(acquisition.receipt?.status).toBe("reverted");
    expect(acquisition.consistent).toBe(true);
  });

  it("records a null receipt as confirmed absence and makes no further reads", async () => {
    const { fetchFn, seen } = scriptedFetch(happyPathResponses({ receipt: "null" }));
    const acquisition = await acquireTransactionObservation({ source: source(), txHash: TX, now: NOW, fetchFn });
    expect(seen.methods).toEqual(["eth_chainId", "eth_getTransactionReceipt"]);
    expect(acquisition.receipt).toBeNull();
    expect(acquisition.block).toBeUndefined();
    expect(acquisition.captures).toHaveLength(2);
    expect(acquisition.consistent).toBe(true);
  });

  it("normalizes receipt logs deterministically with bigint indices", async () => {
    const log0 = JSON.parse(transferLog("0x0")) as Record<string, unknown>;
    const log1 = JSON.parse(transferLog("0x1")) as Record<string, unknown>;
    const receiptWithLogs = successReceiptResultText({ logs: [log0, log1] });
    const { fetchFn } = scriptedFetch(happyPathResponses({ receipt: receiptWithLogs, block: successBlockResultText() }));
    const acquisition = await acquireTransactionObservation({ source: source(), txHash: TX, now: NOW, fetchFn });
    expect(acquisition.receipt?.logs).toHaveLength(2);
    expect(acquisition.receipt?.logs[0]?.address).toBe(TOKEN);
    expect(acquisition.receipt?.logs[1]?.logIndex).toBe(1n);
    expect(acquisition.checks.filter((c) => c.code.startsWith("LOG_"))).toHaveLength(6);
    expect(acquisition.consistent).toBe(true);
  });
});
