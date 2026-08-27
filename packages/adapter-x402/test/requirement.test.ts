import { describe, expect, it } from "vitest";

import {
  NecAdapterX402Error,
  computeRequirementDigest,
  parseAtomicAmount,
  parseCaip2EvmNetwork,
  parseX402ExactPaymentRequirement,
} from "../src/index.js";

const VALID = {
  x402Version: "2",
  scheme: "exact",
  network: "eip155:8453",
  asset: `0x${"cc".repeat(20)}`,
  payTo: `0x${"bb".repeat(20)}`,
  amount: "1000000",
};

describe("requirement parsing", () => {
  it("accepts a valid requirement and normalizes it", () => {
    const req = parseX402ExactPaymentRequirement({ ...VALID, x402Version: 2 });
    expect(req).toMatchObject({
      x402Version: "2",
      scheme: "exact",
      network: "eip155:8453",
      chainId: 8453,
      amount: "1000000",
    });
    expect(Object.keys(req).sort()).toEqual([
      "amount",
      "asset",
      "chainId",
      "network",
      "payTo",
      "scheme",
      "x402Version",
    ]);
    expect("payer" in req).toBe(false);
  });

  it("binds payer only when supplied", () => {
    const withPayer = parseX402ExactPaymentRequirement({
      ...VALID,
      payer: `0x${"AA".repeat(20)}`,
    });
    expect(withPayer.payer).toBe(`0x${"aa".repeat(20)}`);
  });

  it("normalizes EIP-55 checksummed addresses to lowercase", () => {
    const req = parseX402ExactPaymentRequirement({
      ...VALID,
      asset: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
    });
    expect(req.asset).toBe("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed");
  });

  it("rejects unsupported versions and schemes", () => {
    expect(() => parseX402ExactPaymentRequirement({ ...VALID, x402Version: "1" })).toThrowError(
      new RegExp("X402_VERSION_UNSUPPORTED"),
    );
    expect(() => parseX402ExactPaymentRequirement({ ...VALID, scheme: "upto" })).toThrowError(
      new RegExp("X402_SCHEME_UNSUPPORTED"),
    );
    expect(() =>
      parseX402ExactPaymentRequirement({ ...VALID, scheme: "EXACT" }),
    ).toThrowError(new RegExp("X402_SCHEME_UNSUPPORTED"));
  });

  it("rejects unknown and missing fields (fail closed)", () => {
    expect(() =>
      parseX402ExactPaymentRequirement({ ...VALID, extra: true }),
    ).toThrowError(new RegExp('unknown field "extra"'));
    expect(() => {
      const { amount: _amount, ...rest } = VALID;
      void _amount;
      return parseX402ExactPaymentRequirement(rest);
    }).toThrowError(new RegExp("missing required field"));
    expect(() => parseX402ExactPaymentRequirement(null)).toThrowError(NecAdapterX402Error);
    expect(() => parseX402ExactPaymentRequirement([VALID])).toThrowError(NecAdapterX402Error);
  });

  it("rejects malformed CAIP-2 networks", () => {
    for (const bad of [
      "eip155",
      "eip155:",
      ":8453",
      "eip155:8453:extra",
      "EIP155:8453",
      "ei p155:8453",
      "eip155:0x8453",
      "",
    ]) {
      expect(() => parseX402ExactPaymentRequirement({ ...VALID, network: bad })).toThrowError(
        /X402_NETWORK_MALFORMED/,
      );
    }
    // Non-string networks fail earlier, at requirement field validation.
    expect(() => parseX402ExactPaymentRequirement({ ...VALID, network: 42 })).toThrowError(
      /X402_REQUIREMENT_INVALID/,
    );
  });

  it("rejects non-eip155 families and bad eip155 references", () => {
    expect(() => parseX402ExactPaymentRequirement({ ...VALID, network: "solana:mainnet" })).toThrowError(
      new RegExp("X402_NETWORK_FAMILY_UNSUPPORTED"),
    );
    expect(() => parseX402ExactPaymentRequirement({ ...VALID, network: "eip155:08453" })).toThrowError(
      /X402_CHAIN_ID_OUT_OF_RANGE/,
    );
    expect(() => parseX402ExactPaymentRequirement({ ...VALID, network: "eip155:99999999999999999999" }))
      .toThrowError(/X402_CHAIN_ID_OUT_OF_RANGE/);
    expect(parseCaip2EvmNetwork("eip155:8453")).toMatchObject({
      namespace: "eip155",
      chainId: 8453,
    });
  });

  it("rejects invalid amounts", () => {
    expect(() => parseX402ExactPaymentRequirement({ ...VALID, amount: "" })).toThrowError(
      /X402_AMOUNT_INVALID/,
    );
    expect(() => parseX402ExactPaymentRequirement({ ...VALID, amount: "0" })).toThrowError(
      /greater than zero/,
    );
    for (const bad of ["-1", "+1", " 1", "1 ", "1.5", "1e6", "0x10", "١٢٣"]) {
      expect(() => parseX402ExactPaymentRequirement({ ...VALID, amount: bad })).toThrowError(
        /X402_AMOUNT_INVALID/,
      );
    }
    expect(() => parseAtomicAmount("1".repeat(1001))).toThrowError(/decimal digits/);
  });

  it("canonicalizes amounts and keeps huge values exact", () => {
    expect(parseAtomicAmount("007")).toBe("7");
    const huge = "123456789012345678901234567890123456789012345678901234567890";
    const req = parseX402ExactPaymentRequirement({ ...VALID, amount: huge });
    expect(req.amount).toBe(huge);
  });
});

describe("requirement digest", () => {
  it("is stable across equivalent spellings and differs on substance", () => {
    const lower = parseX402ExactPaymentRequirement(VALID);
    const checksummed = parseX402ExactPaymentRequirement({
      ...VALID,
      asset: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
      payTo: `0x${"BB".repeat(20)}`,
    });
    // Different assets are different requirements even after normalization.
    expect(computeRequirementDigest(lower)).not.toBe(computeRequirementDigest(checksummed));

    const again = parseX402ExactPaymentRequirement(VALID);
    expect(computeRequirementDigest(lower)).toBe(computeRequirementDigest(again));
  });
});
