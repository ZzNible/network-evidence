import { describe, expect, it } from "vitest";

import { validateConflict, validateNetworkFingerprint, validateObservedEffect } from "@nec/core";
import type { Conflict } from "@nec/core";

import {
  buildCheckConflict,
  buildEvaluationFingerprint,
  buildLogObservedEffect,
  captureEvidenceIndex,
  decimalString,
  EVM_LOG_EFFECT_TYPE,
  LOG_EFFECT_DIGEST_DOMAIN,
} from "../src/fragment.js";
import { buildEvidenceRefs } from "../src/evidence.js";
import { acquireTransactionObservation } from "../src/index.js";
import type { EvmTransactionAcquisition } from "../src/index.js";
import {
  BLOCK_HASH,
  CHAIN_ID_DEC,
  NETWORK_ID,
  NOW,
  TOKEN,
  TX,
  TRANSFER_TOPIC,
  happyPathResponses,
  scriptedFetch,
  source,
  successBlockResultText,
  successReceiptResultText,
  transferLog,
} from "./helpers.js";

async function acquire(
  opts: Parameters<typeof happyPathResponses>[0] = {},
): Promise<EvmTransactionAcquisition> {
  const { fetchFn } = scriptedFetch(happyPathResponses(opts));
  return acquireTransactionObservation({ source: source(), txHash: TX, now: NOW, fetchFn });
}

describe("evaluation fragment builders (pure core projections)", () => {
  it("anchors the fingerprint at the observed block with a derived UTC timestamp", async () => {
    const acquisition = await acquire({ block: successBlockResultText() });
    const fingerprint = buildEvaluationFingerprint(acquisition);
    expect(() => validateNetworkFingerprint(fingerprint)).not.toThrow();
    expect(fingerprint.networkId).toBe(NETWORK_ID);
    expect(fingerprint.chainId).toBe(CHAIN_ID_DEC);
    expect(fingerprint.observedAt.blockNumber).toBe(100000n);
    expect(fingerprint.observedAt.blockId).toBe(BLOCK_HASH);
    expect(fingerprint.observedAt.timestamp).toBeDefined();
  });

  it("emits an EMPTY anchor when no block was observed and invents none", async () => {
    const acquisition = await acquire({ receipt: "null" });
    const fingerprint = buildEvaluationFingerprint(acquisition);
    expect(() => validateNetworkFingerprint(fingerprint)).not.toThrow();
    expect(fingerprint.networkId).toBe(NETWORK_ID);
    expect(fingerprint.observedAt).toEqual({});
    // An empty anchor carries no block claim whatsoever.
    expect(fingerprint.observedAt.blockNumber).toBeUndefined();
    expect(fingerprint.observedAt.blockId).toBeUndefined();
  });

  it("maps each logical read to its EvidenceRef through the citation index", async () => {
    const acquisition = await acquire({
      block: successBlockResultText(),
      transaction: undefined,
    });
    const refs = buildEvidenceRefs(acquisition);
    const index = captureEvidenceIndex(acquisition, refs);
    expect(index.chainId).toEqual(refs.find((r) => r.metadata?.rpcMethod === "eth_chainId")?.id);
    expect(index.receipt).toEqual(
      refs.find((r) => r.metadata?.rpcMethod === "eth_getTransactionReceipt")?.id,
    );
    expect(index.block).toEqual(refs.find((r) => r.metadata?.rpcMethod === "eth_getBlockByHash")?.id);
    expect(index.transaction).toBeUndefined();

    // A null-result block read still produces a capture and thus a citation.
    const nullBlock = await acquire({ block: "null" });
    const nullIndex = captureEvidenceIndex(nullBlock, buildEvidenceRefs(nullBlock));
    expect(nullIndex.block).toBeDefined();
  });

  it("rejects an index built over foreign refs", async () => {
    const acquisition = await acquire({ block: successBlockResultText() });
    expect(() => captureEvidenceIndex(acquisition, [])).toThrow(/one ref per capture/);
  });

  it("converts bigints to exact decimal strings and rejects negatives", () => {
    expect(decimalString(0n)).toBe("0");
    expect(decimalString(100000n)).toBe("100000");
    expect(decimalString(10n ** 40n)).toBe("1" + "0".repeat(40));
    expect(() => decimalString(-1n)).toThrow(/negative/);
  });

  it("builds a validated, JSON-safe evm.log observed effect with decimal-string quantities", async () => {
    const acquisition = await acquire({
      receipt: successReceiptResultText({ logs: [JSON.parse(transferLog("0x7")) as object] }),
      block: successBlockResultText(),
    });
    const log = acquisition.receipt?.logs[0];
    expect(log).toBeDefined();
    const refs = buildEvidenceRefs(acquisition);
    const receiptRefId = refs.find((r) => r.metadata?.rpcMethod === "eth_getTransactionReceipt")!
      .id;
    const effect = buildLogObservedEffect(log!, receiptRefId);

    expect(() => validateObservedEffect(effect)).not.toThrow();
    expect(effect.type).toBe(EVM_LOG_EFFECT_TYPE);
    expect(effect.basis).toEqual(["source_observation"]);
    expect(effect.evidence).toEqual([receiptRefId]);
    expect(effect.fields.address).toBe(TOKEN);
    expect(effect.fields.blockNumber).toBe("100000");
    expect(effect.fields.transactionIndex).toBe("0");
    expect(effect.fields.logIndex).toBe("7");
    expect(effect.fields.removed).toBe(false);

    // Generic fields are strictly JSON-safe: round-trip loses nothing and
    // no bigint survives serialization (JSON.stringify would throw on one).
    const roundTrip = JSON.parse(JSON.stringify(effect)) as typeof effect;
    expect(roundTrip).toEqual(effect);
    expect((effect.fields.topics as string[])[0]).toBe(TRANSFER_TOPIC);
  });

  it("derives the effect id deterministically from content and distinguishes different logs", async () => {
    const acquisition = await acquire({
      receipt: successReceiptResultText({
        logs: [JSON.parse(transferLog("0x0")) as object, JSON.parse(transferLog("0x1")) as object],
      }),
      block: successBlockResultText(),
    });
    const refs = buildEvidenceRefs(acquisition);
    const receiptRefId = refs.find((r) => r.metadata?.rpcMethod === "eth_getTransactionReceipt")!
      .id;
    const [a, b] = acquisition.receipt!.logs.map((log) => buildLogObservedEffect(log, receiptRefId));
    expect(a!.id).toMatch(/^evm-log-[0-9a-f]{16}$/);
    expect(a!.id).not.toBe(b!.id);
    expect(buildLogObservedEffect(acquisition.receipt!.logs[0]!, receiptRefId).id).toBe(a!.id);
  });

  it("keeps huge block numbers exact as decimal strings inside effect fields", async () => {
    const hugeHex = `0x${(10n ** 30n).toString(16)}`;
    const acquisition = await acquire({
      receipt: successReceiptResultText({
        blockNumber: hugeHex,
        logs: [JSON.parse(transferLog("0x0", { blockNumber: hugeHex })) as object],
      }),
      block: successBlockResultText({ number: hugeHex }),
    });
    const refs = buildEvidenceRefs(acquisition);
    const receiptRefId = refs.find((r) => r.metadata?.rpcMethod === "eth_getTransactionReceipt")!
      .id;
    const effect = buildLogObservedEffect(acquisition.receipt!.logs[0]!, receiptRefId);
    expect(effect.fields.blockNumber).toBe(`1${"0".repeat(30)}`);
    expect(() => validateObservedEffect(effect)).not.toThrow();
  });

  it("builds a core-valid conflict with a stable id and deduped citations", () => {
    const conflict = buildCheckConflict({
      check: { code: "LOG_NOT_REMOVED", passed: false, detail: "logIndex=3 removed=true" },
      qualifier: "log:3",
      scope: { kind: "dimension", dimension: "execution" },
      material: true,
      evidenceIds: ["evm-receipt-a", "evm-receipt-a"],
      description: "test conflict",
    });
    expect(() => validateConflict(conflict)).not.toThrow();
    expect(conflict.id).toBe("nec-evm-conflict:LOG_NOT_REMOVED:log:3");
    expect(conflict.code).toBe("LOG_NOT_REMOVED");
    expect(conflict.material).toBe(true);
    expect(conflict.evidence).toEqual(["evm-receipt-a"]);
    expect(conflict.scope).toEqual({ kind: "dimension", dimension: "execution" });
    expect((conflict.metadata as { checkDetail?: string }).checkDetail).toBe("logIndex=3 removed=true");

    const again = buildCheckConflict({
      check: { code: "LOG_NOT_REMOVED", passed: false, detail: "logIndex=3 removed=true" },
      qualifier: "log:3",
      scope: { kind: "dimension", dimension: "execution" },
      material: true,
      evidenceIds: ["evm-receipt-a"],
      description: "test conflict",
    });
    expect(again).toEqual(conflict satisfies Conflict);
  });

  it("derives distinct conflict ids for distinct qualifiers of the same check code", () => {
    const base = {
      check: { code: "LOG_BLOCK_COHERENT" as const, passed: false, detail: "x" },
      scope: { kind: "dimension" as const, dimension: "execution" as const },
      material: true,
      evidenceIds: ["e1"],
      description: "d",
    };
    const one = buildCheckConflict({ ...base, qualifier: "log:0" });
    const two = buildCheckConflict({ ...base, qualifier: "log:1" });
    expect(one.id).not.toBe(two.id);
    expect(() => validateConflict(one)).not.toThrow();
    expect(() => validateConflict(two)).not.toThrow();
  });

  it("uses a domain-separated digest for effect identity", () => {
    // Same fields under a different domain would give a different digest; the
    // constant pins the resolver-local namespace so identities cannot collide
    // with other digest domains.
    expect(LOG_EFFECT_DIGEST_DOMAIN).toBe("nec.resolver-evm.log-effect");
  });
});
