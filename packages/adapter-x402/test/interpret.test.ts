import { describe, expect, it } from "vitest";

import { interpretObservedEffect } from "../src/index.js";
import type { ObservedEffect } from "@nec/core";
import { OTHER_TOKEN, PAYER, RECIPIENT, TRANSFER_TOPIC, amountWord, padTopic } from "./helpers.js";

function effectWith(fields: Record<string, unknown>, id = "eff_x"): ObservedEffect {
  return {
    id,
    type: "evm.log",
    fields,
    basis: ["source_observation"],
    evidence: [`ev_${id}`],
  };
}

const BASE_FIELDS = {
  address: OTHER_TOKEN,
  topics: [TRANSFER_TOPIC, padTopic(PAYER), padTopic(RECIPIENT)],
  data: amountWord("1000000"),
  removed: false,
};

describe("interpretObservedEffect", () => {
  it("decodes a well-formed Transfer-shaped log", () => {
    const result = interpretObservedEffect(
      effectWith({ ...BASE_FIELDS, address: OTHER_TOKEN, logIndex: "0x1", transactionHash: `0x${"7a".repeat(32)}` }),
    );
    expect(result.status).toBe("transfer");
    if (result.status !== "transfer") return;
    expect(result.observation.asset).toBe(OTHER_TOKEN);
    expect(result.observation.from).toBe(PAYER);
    expect(result.observation.to).toBe(RECIPIENT);
    expect(result.observation.amount).toBe("1000000");
    expect(result.observation.logIndex).toBe("1");
    expect(result.observation.evidenceIds).toEqual(["ev_eff_x"]);
  });

  it("is shape-driven: a Transfer-shaped log is a candidate regardless of its type label", () => {
    const labeled = { ...effectWith(BASE_FIELDS), type: "something.else" };
    expect(interpretObservedEffect(labeled).status).toBe("transfer");
  });

  it("treats non-Transfer topics as unrelated", () => {
    expect(
      interpretObservedEffect(effectWith({ ...BASE_FIELDS, topics: [`0x${"99".repeat(32)}`] })),
    ).toMatchObject({ status: "unrelated" });
    expect(interpretObservedEffect(effectWith({ ...BASE_FIELDS, topics: [] }))).toMatchObject({
      status: "unrelated",
    });
    // Malformed first topic cannot even establish candidacy.
    expect(
      interpretObservedEffect(effectWith({ ...BASE_FIELDS, topics: ["nope"] })),
    ).toMatchObject({ status: "unrelated" });
  });

  it("excludes removed logs with the removed reason", () => {
    const result = interpretObservedEffect(effectWith({ ...BASE_FIELDS, removed: true }));
    expect(result.status).toBe("excluded");
    if (result.status !== "excluded") return;
    expect(result.reason).toBe("removed");
  });

  it("excludes malformed transfer claims with details", () => {
    const cases: Array<Record<string, unknown>> = [
      { ...BASE_FIELDS, removed: "false" }, // non-boolean removed
      {}, // empty fields
      // missing removed entirely:
      {
        address: OTHER_TOKEN,
        topics: [TRANSFER_TOPIC, padTopic(PAYER), padTopic(RECIPIENT)],
        data: amountWord("1"),
      },
      { ...BASE_FIELDS, topics: [TRANSFER_TOPIC, padTopic(PAYER)] }, // 2 topics
      { ...BASE_FIELDS, data: "0x" }, // no value word (non-standard)
      { ...BASE_FIELDS, data: `0x${"0".repeat(63)}` }, // odd digit count
      { ...BASE_FIELDS, address: "not-an-address" },
      { ...BASE_FIELDS, transactionHash: "short" },
      { ...BASE_FIELDS, blockNumber: "-5" }, // signed — not a quantity
      { ...BASE_FIELDS, blockNumber: "0x08453" }, // non-canonical hex (leading zero)
      { ...BASE_FIELDS, logIndex: "1e3" }, // exponent — not a quantity
    ];
    for (let i = 0; i < cases.length; i++) {
      const result = interpretObservedEffect(effectWith(cases[i]!));
      expect(result.status, `case ${i}`).toBe("excluded");
    }
  });

  it("accepts exact DECIMAL context quantities as emitted by the frozen generic EVM projection", () => {
    // @nec/resolver-evm's buildLogObservedEffect projects bigint quantities
    // to decimal strings; such a log must interpret cleanly.
    const result = interpretObservedEffect(
      effectWith({
        ...BASE_FIELDS,
        blockNumber: "100000",
        logIndex: "1",
        transactionIndex: "0",
      }),
    );
    expect(result.status).toBe("transfer");
    if (result.status !== "transfer") return;
    expect(result.observation.blockNumber).toBe("100000");
    expect(result.observation.logIndex).toBe("1");
  });

  it("requires zero padding on indexed address topics", () => {
    const dirtyTopic = `0x${"ff".repeat(12)}${PAYER.slice(2)}`;
    const result = interpretObservedEffect(
      effectWith({ ...BASE_FIELDS, topics: [TRANSFER_TOPIC, dirtyTopic, padTopic(RECIPIENT)] }),
    );
    expect(result.status).toBe("excluded");
    if (result.status !== "excluded") return;
    expect(result.detail).toContain("zero-padded");
  });

  it("decodes maximal uint256 amounts exactly", () => {
    const maxWord = `0x${"ff".repeat(32)}`;
    const result = interpretObservedEffect(effectWith({ ...BASE_FIELDS, data: maxWord }));
    expect(result.status).toBe("transfer");
    if (result.status !== "transfer") return;
    expect(result.observation.amount).toBe(
      "115792089237316195423570985008687907853269984665640564039457584007913129639935",
    );
  });
});
