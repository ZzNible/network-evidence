import { describe, expect, it } from "vitest";

import type { ObservedEffect } from "@nec/core";

import {
  decodeIndexedAddressTopic,
  interpretTransferSingleEffect,
  interpretUserOperationEventEffect,
  keccak256Hex,
  TRANSFER_SINGLE_SIGNATURE,
  TRANSFER_SINGLE_TOPIC0,
  utf8Bytes,
  USER_OPERATION_EVENT_SIGNATURE,
  USER_OPERATION_EVENT_TOPIC0,
  ZERO_ADDRESS,
} from "../src/index.js";
import {
  CREDITS_CONTRACT,
  ENTRY_POINT,
  OTHER_ACCOUNT,
  padTopic,
  SENDER,
  TOKEN_ID,
  transferSingleEffect,
  userOpEventEffect,
  word,
} from "./helpers.js";

describe("pinned topic0 derivation", () => {
  it("keccak256 of the canonical UserOperationEvent signature equals the pin", () => {
    expect(`0x${keccak256Hex(utf8Bytes(USER_OPERATION_EVENT_SIGNATURE))}`).toBe(
      USER_OPERATION_EVENT_TOPIC0,
    );
    expect(USER_OPERATION_EVENT_TOPIC0).toBe(
      "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f",
    );
  });

  it("the old draft uint64-nonce signature does NOT produce the pin", () => {
    const draft = "UserOperationEvent(bytes32,address,address,uint64,bool,uint256,uint256)";
    expect(`0x${keccak256Hex(utf8Bytes(draft))}`).not.toBe(USER_OPERATION_EVENT_TOPIC0);
  });

  it("keccak256 of the canonical TransferSingle signature equals the pin", () => {
    expect(`0x${keccak256Hex(utf8Bytes(TRANSFER_SINGLE_SIGNATURE))}`).toBe(
      TRANSFER_SINGLE_TOPIC0,
    );
    expect(TRANSFER_SINGLE_TOPIC0).toBe(
      "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62",
    );
  });
});

describe("interpretUserOperationEventEffect", () => {
  it("decodes a well-formed event exactly", () => {
    const effect = userOpEventEffect("u1");
    const result = interpretUserOperationEventEffect(effect);
    expect(result.status).toBe("userOperationEvent");
    if (result.status !== "userOperationEvent") return;
    expect(result.observation.emitter).toBe(ENTRY_POINT);
    expect(result.observation.sender).toBe(SENDER);
    expect(result.observation.paymaster).toBe(ZERO_ADDRESS);
    expect(result.observation.success).toBe(true);
    expect(result.observation.nonce).toMatch(/^[0-9]+$/);
    expect(result.observation.evidenceIds).toEqual(["ev_u1"]);
    expect(result.observation.transactionHash).toBeDefined();
  });

  it("classifies other topic0 values as unrelated", () => {
    const effect: ObservedEffect = {
      id: "x",
      type: "evm.log",
      fields: {
        address: ENTRY_POINT,
        topics: [`0x${"11".repeat(32)}`, padTopic(SENDER)],
        data: "0x",
        removed: false,
      },
      basis: ["source_observation"],
      evidence: ["ev_x"],
    };
    expect(interpretUserOperationEventEffect(effect).status).toBe("unrelated");
  });

  it("excludes removed events (never reinterpreted as canonical)", () => {
    const result = interpretUserOperationEventEffect(userOpEventEffect("u2", { removed: true }));
    expect(result).toMatchObject({ status: "excluded", reason: "removed" });
  });

  it.each([
    [
      "missing topic",
      { topicsOverride: [USER_OPERATION_EVENT_TOPIC0, `0x${"94".repeat(32)}`, padTopic(SENDER)] },
    ],
    [
      "oversized topic",
      {
        topicsOverride: [
          USER_OPERATION_EVENT_TOPIC0,
          `0x${"94".repeat(32)}`,
          padTopic(SENDER),
          `0x${"00".repeat(12)}${ZERO_ADDRESS.slice(2)}ff`,
        ],
      },
    ],
    [
      "malformed address padding in sender topic",
      {
        topicsOverride: [
          USER_OPERATION_EVENT_TOPIC0,
          `0x${"94".repeat(32)}`,
          `0xff${"00".repeat(10)}${SENDER.slice(2)}`,
          padTopic(ZERO_ADDRESS),
        ],
      },
    ],
    ["short data", { dataOverride: `0x${"ab".repeat(120)}` }],
    ["oversized data", { dataOverride: `0x${"ab".repeat(320)}` }],
    ["noncanonical success bool", { dataOverride: [word("1"), word("2"), word("3"), word("4")].join("") }],
    ["bad removed flag", { omitRemoved: true }],
  ])("excludes malformed relevant shape: %s", (_name, opts) => {
    const result = interpretUserOperationEventEffect(userOpEventEffect("m", opts));
    expect(result.status).toBe("excluded");
    expect((result as { reason: string }).reason).toBe("malformed");
  });

  it("excludes a relevant event whose context fields are malformed", () => {
    const effect = userOpEventEffect("ctx");
    effect.fields["logIndex"] = "0x00ff"; // noncanonical hex quantity
    const result = interpretUserOperationEventEffect(effect);
    expect(result.status).toBe("excluded");
    expect((result as { detail: string }).detail).toMatch(/quantity/);
  });

  it("rejects a non-record fields carrier deterministically", () => {
    const broken = { id: "b", type: "evm.log", fields: "nope", basis: [], evidence: [] };
    const result = interpretUserOperationEventEffect(broken as unknown as ObservedEffect);
    expect(result.status).toBe("excluded");
    expect((result as { detail: string }).detail).toMatch(/plain record/);
  });

  it("normalizes mixed-case hashes deterministically", () => {
    const effect = userOpEventEffect("mix", { userOpHash: `0x${"AB".repeat(32)}` });
    const result = interpretUserOperationEventEffect(effect);
    if (result.status !== "userOperationEvent") throw new Error("expected observation");
    expect(result.observation.userOpHash).toBe(`0x${"ab".repeat(32)}`);
  });
});

describe("interpretTransferSingleEffect", () => {
  it("decodes a well-formed burn-shaped TransferSingle exactly", () => {
    const result = interpretTransferSingleEffect(transferSingleEffect("t1"));
    expect(result.status).toBe("transferSingle");
    if (result.status !== "transferSingle") return;
    expect(result.observation.contract).toBe(CREDITS_CONTRACT);
    expect(result.observation.from).toBe(SENDER);
    expect(result.observation.to).toBe(ZERO_ADDRESS);
    expect(result.observation.tokenId).toBe(TOKEN_ID);
    expect(result.observation.value).toBe("1");
  });

  it("classifies a real mint shape as a usable TransferSingle (burn decision is evaluation's)", () => {
    const mint = transferSingleEffect("mint", { from: ZERO_ADDRESS, to: OTHER_ACCOUNT });
    const result = interpretTransferSingleEffect(mint);
    expect(result.status).toBe("transferSingle");
  });

  it.each([
    ["missing topic", { topicsOverride: [TRANSFER_SINGLE_TOPIC0, padTopic(SENDER), padTopic(ZERO_ADDRESS)] }],
    ["short data", { dataOverride: "0x" + word(TOKEN_ID).slice(2) }],
    ["oversized data", { dataOverride: `0x${"ab".repeat(192)}` }],
    [
      "malformed padding on from",
      {
        topicsOverride: [
          TRANSFER_SINGLE_TOPIC0,
          padTopic(SENDER),
          `0x01${"00".repeat(11)}${SENDER.slice(2)}`,
          padTopic(ZERO_ADDRESS),
        ],
      },
    ],
  ])("excludes malformed relevant TransferSingle: %s", (_name, opts) => {
    const result = interpretTransferSingleEffect(transferSingleEffect("m", opts as never));
    expect(result.status).toBe("excluded");
    expect((result as { reason: string }).reason).toBe("malformed");
  });

  it("treats other topic0 values as unrelated", () => {
    const effect: ObservedEffect = {
      id: "n",
      type: "evm.log",
      fields: {
        address: CREDITS_CONTRACT,
        topics: [`0x${"22".repeat(32)}`, padTopic(SENDER)],
        data: "0x",
        removed: false,
      },
      basis: ["source_observation"],
      evidence: ["ev_n"],
    };
    expect(interpretTransferSingleEffect(effect).status).toBe("unrelated");
  });
});

describe("decodeIndexedAddressTopic", () => {
  it("decodes zero-padded addresses and rejects bad padding", () => {
    expect(decodeIndexedAddressTopic(padTopic(SENDER))).toBe(SENDER);
    expect(decodeIndexedAddressTopic(`0x01${"00".repeat(11)}${SENDER.slice(2)}`)).toBe("");
  });
});
