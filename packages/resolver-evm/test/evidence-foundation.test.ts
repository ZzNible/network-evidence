import { describe, expect, it } from "vitest";

import {
  acquireTransactionObservation,
  buildEvmAcquisitionFixture,
  buildEvidenceRefs,
  replayTransactionAcquisition,
  toNetworkFingerprint,
  toSubjectRef,
} from "../src/index.js";
import { validateEvidenceRef, validateNetworkFingerprint, validateSubjectRef } from "@nec/core";
import type { EvmAcquisitionFixture } from "../src/index.js";
import { validateEvmAcquisitionFixture } from "../src/index.js";
import { readFileSync } from "node:fs";
import { NOW, TX, happyPathResponses, scriptedFetch, source, successBlockResultText, successReceiptResultText } from "./helpers.js";

function successFixture(): EvmAcquisitionFixture {
  return validateEvmAcquisitionFixture(
    JSON.parse(readFileSync(new URL("./fixtures/sepolia-success.json", import.meta.url), "utf8")) as unknown,
  );
}

describe("public core integration foundation", () => {
  it("projects the acquisition into a valid core SubjectRef", async () => {
    const acquisition = await replayTransactionAcquisition(successFixture());
    const subject = toSubjectRef(acquisition);
    expect(() => validateSubjectRef(subject)).not.toThrow();
    expect(subject).toEqual({ type: "transaction", networkId: "eip155:11155111", txId: acquisition.subject.txHash });
  });

  it("projects the acquired block into a valid core NetworkFingerprint with derived UTC timestamp", async () => {
    const acquisition = await replayTransactionAcquisition(successFixture());
    const fingerprint = toNetworkFingerprint(acquisition);
    expect(() => validateNetworkFingerprint(fingerprint)).not.toThrow();
    expect(fingerprint.networkId).toBe("eip155:11155111");
    expect(fingerprint.chainId).toBe(11155111);
    expect(fingerprint.observedAt.blockNumber).toBe(100000n);
    expect(fingerprint.observedAt.blockId).toBe(acquisition.block?.hash);
    // Deterministic conversion of the captured bigint seconds.
    expect(fingerprint.observedAt.timestamp).toBe(
      new Date(Number(acquisition.block!.timestamp) * 1000).toISOString(),
    );
  });

  it("builds one deterministic EvidenceRef per capture; refs validate against @nec/core", async () => {
    const acquisition = await replayTransactionAcquisition(successFixture());
    const refs = buildEvidenceRefs(acquisition);
    expect(refs).toHaveLength(acquisition.captures.length);
    for (const ref of refs) {
      expect(() => validateEvidenceRef(ref)).not.toThrow();
    }
    // Deterministic ids bound to capture content.
    expect(buildEvidenceRefs(acquisition).map((r) => r.id)).toEqual(refs.map((r) => r.id));
    const receiptRef = refs.find((r) => r.metadata?.rpcMethod === "eth_getTransactionReceipt");
    expect(receiptRef?.sourceId).toBe("src.sepolia.primary");
    expect(receiptRef?.independenceGroup).toBe("sepolia-rpc-a");
    expect(receiptRef?.blockNumber).toBe(100000n);
    expect(receiptRef?.blockId).toBe(acquisition.receipt?.blockHash);
    // Exact provider bytes travel opaquely and digest-bound.
    expect(receiptRef?.nativeSource?.namespace).toBe("nec.resolver-evm.rpc-result");
    expect(receiptRef?.nativeSource?.contentDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("keeps two sources observing the same subject distinguishable at the EvidenceRef level", async () => {
    const base = successFixture();
    const other = validateEvmAcquisitionFixture({
      ...JSON.parse(JSON.stringify(base)),
      source: { ...base.source, sourceId: "src.sepolia.backup", independenceGroup: "sepolia-rpc-b" },
    });
    const a = buildEvidenceRefs(await replayTransactionAcquisition(base));
    const b = buildEvidenceRefs(await replayTransactionAcquisition(other));
    expect(a.map((r) => r.id)).not.toEqual(b.map((r) => r.id));
    expect(a.map((r) => r.sourceId)).toEqual(["src.sepolia.primary", "src.sepolia.primary", "src.sepolia.primary"]);
    expect(b.map((r) => r.sourceId)).toEqual(["src.sepolia.backup", "src.sepolia.backup", "src.sepolia.backup"]);
    // Same semantic anchor position (same block), different provenance.
    expect(a[1]?.blockNumber).toEqual(b[1]?.blockNumber);
  });

  it("attaches nativeSource only within the core payload budget, keeping the record digest either way", async () => {
    const oversized = "0x" + "61".repeat(300_000); // 300 KB of provider data
    const { fetchFn } = scriptedFetch(
      happyPathResponses({
        receipt: successReceiptResultText({ reconciliationBlob: oversized }),
        block: successBlockResultText(),
      }),
    );
    const acquisition = await acquireTransactionObservation({ source: source(), txHash: TX, now: NOW, fetchFn });
    const refs = buildEvidenceRefs(acquisition);
    const receiptRef = refs.find((r) => r.metadata?.rpcMethod === "eth_getTransactionReceipt");
    expect(receiptRef?.nativeSource).toBeUndefined();
    expect(receiptRef?.contentDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    // The raw capture still carries the full bytes for independent replay.
    expect(acquisition.captures[1]?.resultText).toContain(oversized.slice(0, 64));
    // And the fixture projection stays replayable.
    const replayed = await replayTransactionAcquisition(buildEvmAcquisitionFixture(acquisition));
    expect(replayed.receipt?.extras["reconciliationBlob"]).toBe(oversized);
  });
});
