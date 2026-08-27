import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import type { ObservedEffect } from "@nec/core";

import {
  replayTransactionAcquisition,
  validateEvmAcquisitionFixture,
} from "@nec/resolver-evm";

import {
  interpretTransferBatchEffect,
  TRANSFER_BATCH_TOPIC0,
  ZERO_ADDRESS,
  keccak256Hex,
  utf8Bytes,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Real Ethereum-mainnet TransferBatch observation, reacquired read-only
// through the FROZEN @nec/resolver-evm pipeline and stored as a
// nec-resolver-evm-fixture-v1 capture. Facts below were re-derived from RAW
// receipt material during acquisition — no third-party decoded output copied.
// ---------------------------------------------------------------------------

const TX = "0xa18c7de72da745bfc667b24ea79d7fb793cec4ad9e469b7d69aa6840b0b61ea4";
const EMITTER = "0x019e1afe1de8fa2321782d32eea58d4b98b3a90e";
const OPERATOR = "0x79b26eb18b4c9209c866c25b0e6e37dc5d4f4b2b";
const FROM = "0xbfe3270664ff9bfedc9910561eccac5a45b9b23e";
const EXPECTED_BLOCK_HASH = "0xf034ba52501bf0e9161d5ae898bd5dfbb1d6c28420792d0639a9a31110447724";
// The canonical writer brief lists block 25824427, but that number does NOT
// correspond to its own block hash. The real on-chain block for this hash is
// 25819051 (0x189f7ab). The fixture records the REAL canonical number.
const REAL_BLOCK_NUMBER = 25819051n;
const EXPECTED_IDS = ["7", "7", "11", "11", "11", "11"];
const EXPECTED_VALUES = ["1", "1", "1", "1", "1", "1"];
const LOG_INDEX = "533"; // 0x215

const fixtureName = "ethereum-mainnet-transferbatch-real.json";

function loadFixture(): unknown {
  return JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", fixtureName), "utf8"));
}

/** Build a generic ObservedEffect from the RAW captured TransferBatch log. */
function realTransferBatchEffect(): ObservedEffect {
  const fixture = loadFixture() as {
    captures: Array<{ rpcMethod: string; resultJson: string }>;
  };
  const receiptCapture = fixture.captures.find((c) => c.rpcMethod === "eth_getTransactionReceipt");
  if (receiptCapture === undefined) throw new Error("receipt capture missing");
  const receipt = JSON.parse(receiptCapture.resultJson) as {
    logs: Array<{
      address: string;
      topics: string[];
      data: string;
      removed: boolean;
      blockNumber: string;
      transactionHash: string;
      logIndex: string;
    }>;
  };
  const log = receipt.logs.find(
    (l) =>
      l.address.toLowerCase() === EMITTER &&
      l.topics[0]?.toLowerCase() === TRANSFER_BATCH_TOPIC0,
  );
  if (log === undefined) throw new Error("real TransferBatch log not found");
  return {
    id: "real-transferbatch",
    type: "evm.log",
    fields: {
      address: log.address,
      topics: log.topics,
      data: log.data,
      removed: log.removed,
      blockNumber: log.blockNumber,
      transactionHash: log.transactionHash,
      logIndex: log.logIndex,
    },
    basis: ["source_observation"],
    evidence: ["ev_real_receipt"],
  };
}

describe("real ethereum-mainnet TransferBatch fixture (offline replay)", () => {
  const raw = loadFixture();

  it("carries clean provenance: no credentials, endpoints or local paths", () => {
    const text = JSON.stringify(raw);
    expect(text).not.toMatch(/authorization/i);
    expect(text).not.toMatch(/api[_-]?key/i);
    expect(text).not.toMatch(/bearer/i);
    expect(text).not.toMatch(/https?:\/\//); // endpoint URLs are never stored
    expect(text).not.toMatch(/\/home\/|\/Users\/|ssh:|token=/i);
  });

  it("is a valid nec-resolver-evm-fixture-v1 capture of the expected subject", () => {
    const fixture = validateEvmAcquisitionFixture(raw);
    expect(fixture.schemaVersion).toBe("nec-resolver-evm-fixture-v1");
    expect(fixture.source.networkId).toBe("eip155:1");
    expect(fixture.source.chainId).toBe(1);
    expect(fixture.subject.txHash).toBe(TX);
    // minimum acquisition surface: chainId + receipt + block (no transaction)
    expect(fixture.captures.map((c) => c.rpcMethod)).toEqual([
      "eth_chainId",
      "eth_getTransactionReceipt",
      "eth_getBlockByHash",
    ]);
  });

  it("replays offline with network access poisoned and is deterministic", async () => {
    const fixture = validateEvmAcquisitionFixture(raw);
    const realFetch = globalThis.fetch;
    // Prove zero network: any network attempt must throw.
    globalThis.fetch = (() => {
      throw new Error("network must not be used during offline replay");
    }) as typeof fetch;
    try {
      const a = await replayTransactionAcquisition(fixture);
      const b = await replayTransactionAcquisition(fixture);
      expect(a).toEqual(b); // deterministic deep equality
      expect(a.consistent).toBe(true);
      expect(a.chain.chainId).toBe(1n);
      expect(a.subject.txHash).toBe(TX);
      expect(a.receipt?.status).toBe("success");
      expect(a.receipt?.blockNumber).toBe(REAL_BLOCK_NUMBER);
      expect(a.receipt?.blockHash).toBe(EXPECTED_BLOCK_HASH);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("asserts the exact canonical TransferBatch observation independently", () => {
    const interpretation = interpretTransferBatchEffect(realTransferBatchEffect());
    if (interpretation.status !== "transferBatch") {
      throw new Error(`expected transferBatch interpretation, got ${interpretation.status}`);
    }
    const obs = interpretation.observation;
    expect(obs.contract).toBe(EMITTER);
    expect(obs.operator).toBe(OPERATOR);
    expect(obs.from).toBe(FROM);
    expect(obs.to).toBe(ZERO_ADDRESS);
    expect(obs.members).toHaveLength(6);
    expect(obs.members.map((m) => m.tokenId)).toEqual(EXPECTED_IDS);
    expect(obs.members.map((m) => m.value)).toEqual(EXPECTED_VALUES);
    // every projected member is a deterministic burn (to == zero)
    expect(obs.members.every((m) => m.to === ZERO_ADDRESS)).toBe(true);
    // holder correlation uses `from`; operator may differ and is NOT assumed
    // to be the owner.
    expect(obs.operator.toLowerCase()).not.toBe(obs.from.toLowerCase());
    expect(obs.members[0]!.memberId).toBe("real-transferbatch#0");
  });

  it("pins the TransferBatch topic0 to the canonical keccak256 signature", () => {
    expect(`0x${keccak256Hex(utf8Bytes("TransferBatch(address,address,address,uint256[],uint256[])"))}`).toBe(
      TRANSFER_BATCH_TOPIC0,
    );
    expect(TRANSFER_BATCH_TOPIC0).toBe(
      "0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb",
    );
  });
});
