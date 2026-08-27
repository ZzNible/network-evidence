import { describe, expect, it } from "vitest";

import { acquireTransactionObservation, NecResolverEvmError } from "../src/index.js";
import { happyPathResponses, NOW, OTHER_TX, TX, scriptedFetch, source, successBlockResultText, successReceiptResultText } from "./helpers.js";

describe("consistency invariants (semantic incoherence is captured, never hidden)", () => {
  it("surfaces a receipt transactionHash mismatch as a failed check", async () => {
    const mismatched = successReceiptResultText({ transactionHash: OTHER_TX });
    const { fetchFn } = scriptedFetch(happyPathResponses({ receipt: mismatched, block: successBlockResultText() }));
    const acquisition = await acquireTransactionObservation({ source: source(), txHash: TX, now: NOW, fetchFn });
    expect(acquisition.consistent).toBe(false);
    const failed = acquisition.checks.find((c) => c.code === "RECEIPT_TX_HASH_MATCHES_SUBJECT");
    expect(failed?.passed).toBe(false);
    expect(failed?.detail).toContain(OTHER_TX);
  });

  it("surfaces receipt/block hash mismatch as a failed check", async () => {
    const wrongBlock = successBlockResultText({ hash: `0x${"ef".repeat(32)}` });
    const { fetchFn } = scriptedFetch(happyPathResponses({ block: wrongBlock }));
    const acquisition = await acquireTransactionObservation({ source: source(), txHash: TX, now: NOW, fetchFn });
    expect(acquisition.consistent).toBe(false);
    expect(acquisition.checks.find((c) => c.code === "RECEIPT_BLOCK_HASH_MATCHES_BLOCK")?.passed).toBe(false);
    expect(acquisition.checks.find((c) => c.code === "RECEIPT_BLOCK_NUMBER_MATCHES_BLOCK")?.passed).toBe(true);
  });

  it("surfaces receipt/block number mismatch as a failed check", async () => {
    const wrongNumber = successBlockResultText({ number: "0x186a1" });
    const { fetchFn } = scriptedFetch(happyPathResponses({ block: wrongNumber }));
    const acquisition = await acquireTransactionObservation({ source: source(), txHash: TX, now: NOW, fetchFn });
    expect(acquisition.consistent).toBe(false);
    expect(acquisition.checks.find((c) => c.code === "RECEIPT_BLOCK_NUMBER_MATCHES_BLOCK")?.passed).toBe(false);
    expect(acquisition.checks.find((c) => c.code === "RECEIPT_BLOCK_HASH_MATCHES_BLOCK")?.passed).toBe(true);
  });

  it("surfaces log/block mismatch as a failed check", async () => {
    const badLog = JSON.parse(
      `{"address":"0x${"cc".repeat(20)}","topics":[],"data":"0x","blockNumber":"0x186a0",` +
        `"blockHash":"0x${"ee".repeat(32)}","transactionHash":"${TX}","transactionIndex":"0x0",` +
        `"logIndex":"0x0","removed":false}`,
    ) as Record<string, unknown>;
    const receipt = successReceiptResultText({ logs: [badLog] });
    const { fetchFn } = scriptedFetch(happyPathResponses({ receipt, block: successBlockResultText() }));
    const acquisition = await acquireTransactionObservation({ source: source(), txHash: TX, now: NOW, fetchFn });
    const logCheck = acquisition.checks.find((c) => c.code === "LOG_BLOCK_COHERENT");
    expect(logCheck?.passed).toBe(false);
    expect(logCheck?.detail).toContain(`0x${"ee".repeat(32)}`);
    expect(acquisition.consistent).toBe(false);
  });

  it("surfaces a removed log as a failed check", async () => {
    const removedLog = JSON.parse(
      `{"address":"0x${"cc".repeat(20)}","topics":[],"data":"0x","blockNumber":"0x186a0",` +
        `"blockHash":"0x${"ab".repeat(32)}","transactionHash":"${TX}","transactionIndex":"0x0",` +
        `"logIndex":"0x0","removed":true}`,
    ) as Record<string, unknown>;
    const receipt = successReceiptResultText({ logs: [removedLog] });
    const { fetchFn } = scriptedFetch(happyPathResponses({ receipt, block: successBlockResultText() }));
    const acquisition = await acquireTransactionObservation({ source: source(), txHash: TX, now: NOW, fetchFn });
    expect(acquisition.checks.find((c) => c.code === "LOG_NOT_REMOVED")?.passed).toBe(false);
  });

  it("fails closed when the configured network does not match eth_chainId", async () => {
    const { fetchFn } = scriptedFetch(happyPathResponses({ chainId: "0x1" }));
    await expect(
      acquireTransactionObservation({ source: source(), txHash: TX, now: NOW, fetchFn }),
    ).rejects.toThrowError(/chainId 1.*configured for chainId 11155111/s);
    await expect(
      acquireTransactionObservation({ source: source(), txHash: TX, now: NOW, fetchFn }),
    ).rejects.toBeInstanceOf(NecResolverEvmError);
  });

  it("records the queried-but-missing block as a failed coherence check", async () => {
    const responses = happyPathResponses({ block: "null" });
    // Replace the third response with a null-block body.
    const { fetchFn } = scriptedFetch([
      ...responses.slice(0, 2),
      { expectMethod: "eth_getBlockByHash", bodyText: `{"jsonrpc":"2.0","id":7,"result":null}` },
    ]);
    const acquisition = await acquireTransactionObservation({ source: source(), txHash: TX, now: NOW, fetchFn });
    expect(acquisition.block).toBeNull();
    expect(acquisition.consistent).toBe(false);
    expect(acquisition.checks.find((c) => c.code === "RECEIPT_BLOCK_HASH_MATCHES_BLOCK")?.passed).toBe(false);
  });

  it("flags a pending transaction object that contradicts its mined receipt", async () => {
    const pendingTx = `{"hash":"${TX}","nonce":"0x2a","blockHash":null,"blockNumber":null,` +
      `"transactionIndex":null,"from":"0x${"aa".repeat(20)}","to":"0x${"bb".repeat(20)}",` +
      `"value":"0x0","gas":"0x5208","input":"0x","type":"0x2","chainId":"0xaa36a7"}`;
    const { fetchFn } = scriptedFetch(
      happyPathResponses({
        block: successBlockResultText(),
        transaction: pendingTx,
      }),
    );
    const acquisition = await acquireTransactionObservation({
      source: source(),
      txHash: TX,
      now: NOW,
      fetchFn,
      includeTransaction: true,
    });
    expect(acquisition.transaction?.blockHash).toBeNull();
    expect(acquisition.checks.find((c) => c.code === "TRANSACTION_COHERENT_WITH_RECEIPT")?.passed).toBe(false);
  });
});

