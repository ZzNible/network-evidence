import { describe, expect, it } from "vitest";
import { canonicalJson, computeEvidencePolicyDigest } from "@nec/core";
import type { EvidencePolicy, PolicyDimension } from "@nec/core";

import {
  ACTION_KIND_X402_PAYMENT,
  buildX402PaymentCorrelation,
  NecAdapterX402Error,
  parseX402PaymentClaim,
} from "../src/index.js";
import { AMOUNT_DEFAULT, NETWORK_ID, PAYER, RECIPIENT, TOKEN } from "./helpers.js";

const REQUIREMENT = {
  x402Version: "2",
  scheme: "exact",
  network: NETWORK_ID,
  asset: TOKEN,
  payTo: RECIPIENT,
  amount: AMOUNT_DEFAULT,
};

const TX_HASH = `0x${"7a".repeat(32)}`;

const policy: EvidencePolicy = (() => {
  const content = {
    id: "payment-basic",
    version: "1",
    requiredDimensions: ["execution", "observedEffects"] as PolicyDimension[],
    desiredDimensions: ["finality"] as PolicyDimension[],
  };
  return { ...content, digest: computeEvidencePolicyDigest(content) };
})();

describe("parseX402PaymentClaim", () => {
  it("normalizes the claim: lowercase tx hash + normalized requirement", () => {
    const claim = parseX402PaymentClaim({
      requirement: { ...REQUIREMENT, asset: `0x${"CC".repeat(20)}` },
      paymentTxHash: `0x${"7A".repeat(32)}`,
    });
    expect(claim.paymentTxHash).toBe(TX_HASH);
    expect(claim.requirement.asset).toBe(TOKEN);
    expect(Object.isFrozen(claim)).toBe(true);
  });

  it("is idempotent over its own normalized output", () => {
    const once = parseX402PaymentClaim({ requirement: REQUIREMENT, paymentTxHash: TX_HASH });
    const twice = parseX402PaymentClaim(once);
    expect(canonicalJson(twice as unknown as Record<string, unknown>)).toBe(
      canonicalJson(once as unknown as Record<string, unknown>),
    );
  });

  it("rejects unknown fields, missing fields and non-hash identities (fail closed)", () => {
    expect(() =>
      parseX402PaymentClaim({ requirement: REQUIREMENT, paymentTxHash: TX_HASH, extra: 1 }),
    ).toThrowError(/unknown field "extra"/);
    expect(() => parseX402PaymentClaim({ requirement: REQUIREMENT })).toThrowError(
      NecAdapterX402Error,
    );
    expect(() => parseX402PaymentClaim({ paymentTxHash: TX_HASH })).toThrowError(
      /missing required field "requirement"/,
    );
    for (const bad of ["0x1234", `0x${"7a".repeat(31)}`, `0x${"7g".repeat(32)}`, TX_HASH.slice(1)]) {
      expect(() =>
        parseX402PaymentClaim({ requirement: REQUIREMENT, paymentTxHash: bad }),
      ).toThrowError(/X402_TX_HASH_INVALID/);
    }
    expect(() => parseX402PaymentClaim(null)).toThrowError(NecAdapterX402Error);
  });
});

describe("buildX402PaymentCorrelation", () => {
  it("maps the claim onto frozen NEC contracts without making network claims", () => {
    const correlation = buildX402PaymentCorrelation({
      requirement: REQUIREMENT,
      paymentTxHash: TX_HASH,
    });
    // Exact subject: THE claimed payment transaction on the claim network.
    expect(correlation.subject).toEqual({
      type: "transaction",
      networkId: NETWORK_ID,
      txId: TX_HASH,
    });
    // EXPECTED payment semantics only.
    expect(correlation.action).toEqual({
      kind: ACTION_KIND_X402_PAYMENT,
      target: RECIPIENT,
      value: AMOUNT_DEFAULT,
      fields: { asset: TOKEN, scheme: "exact", x402Version: "2" },
    });
    expect("request" in correlation).toBe(false);
    // No observation/verdict/settlement-shaped keys exist at all.
    expect(Object.keys(correlation).sort()).toEqual(["action", "subject"]);
  });

  it("binds payer semantics into the action fields only when the requirement binds one", () => {
    const withPayer = buildX402PaymentCorrelation({
      requirement: { ...REQUIREMENT, payer: PAYER },
      paymentTxHash: TX_HASH,
    });
    expect(withPayer.action.fields).toMatchObject({ payer: PAYER });
  });

  it("builds a complete core-valid EvidenceRequest when policy + requestId are supplied", () => {
    const correlation = buildX402PaymentCorrelation(
      { requirement: REQUIREMENT, paymentTxHash: TX_HASH },
      { requestId: "req_demo_1", evidencePolicy: policy },
    );
    expect(correlation.request).toEqual({
      schemaVersion: "0.1",
      requestId: "req_demo_1",
      networkId: NETWORK_ID,
      subject: { type: "transaction", networkId: NETWORK_ID, txId: TX_HASH },
      action: correlation.action,
      evidencePolicy: policy,
    });
  });

  it("rejects incomplete request options and invalid request identities", () => {
    const claim = { requirement: REQUIREMENT, paymentTxHash: TX_HASH };
    expect(() => buildX402PaymentCorrelation(claim, { requestId: "req_x" })).toThrowError(
      /together/,
    );
    expect(() => buildX402PaymentCorrelation(claim, { evidencePolicy: policy })).toThrowError(
      /together/,
    );
    expect(() =>
      buildX402PaymentCorrelation(claim, { requestId: "", evidencePolicy: policy }),
    ).toThrowError();
  });

  it("is deterministic", () => {
    const input = { requirement: REQUIREMENT, paymentTxHash: TX_HASH };
    const a = buildX402PaymentCorrelation(input, { requestId: "req_demo_1", evidencePolicy: policy });
    const b = buildX402PaymentCorrelation(input, { requestId: "req_demo_1", evidencePolicy: policy });
    expect(canonicalJson(a as unknown as Record<string, unknown>)).toBe(
      canonicalJson(b as unknown as Record<string, unknown>),
    );
  });
});
