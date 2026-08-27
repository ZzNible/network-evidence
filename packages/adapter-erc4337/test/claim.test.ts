import { describe, expect, it } from "vitest";

import { canonicalJson, computeEvidencePolicyDigest } from "@nec/core";
import type { EvidencePolicy, PolicyDimension } from "@nec/core";

import {
  ACTION_KIND_ERC4337_USEROPERATION,
  buildErc4337Correlation,
  computeErc4337ClaimDigest,
  ENTRY_POINT_V0_7_OBSERVED_ON_BASE,
  EXPECTED_EFFECT_KIND_ERC1155_BURN,
  NecAdapterErc4337Error,
  parseErc4337Claim,
} from "../src/index.js";
import { CREDITS_CONTRACT, ENTRY_POINT, NETWORK_ID, SENDER, TOKEN_ID, TX } from "./helpers.js";

const BASE_CLAIM = {
  network: NETWORK_ID,
  bundleTransactionHash: TX,
  entryPoint: ENTRY_POINT,
  entryPointProfile: "v0.7",
  userOperation: { sender: SENDER },
};

describe("parseErc4337Claim", () => {
  it("normalizes a minimal claim (defaults requireSuccess=true)", () => {
    const claim = parseErc4337Claim({
      ...BASE_CLAIM,
      bundleTransactionHash: `0x${TX.slice(2).toUpperCase()}`,
      entryPoint: `0x${ENTRY_POINT.slice(2).toUpperCase()}`,
    });
    expect(claim.network).toBe(NETWORK_ID);
    expect(claim.chainId).toBe(8453);
    expect(claim.bundleTransactionHash).toBe(TX);
    expect(claim.entryPoint).toBe(ENTRY_POINT);
    expect(claim.userOperation.requireSuccess).toBe(true);
    expect(claim.userOperation.userOpHash).toBeUndefined();
    expect(claim.expectedEffect).toBeUndefined();
  });

  it("accepts EIP-55 mixed-case addresses and verifies the checksum", () => {
    // Real checksummed form of the observed Base EntryPoint address.
    const claim = parseErc4337Claim({
      ...BASE_CLAIM,
      entryPoint: "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
    });
    expect(claim.entryPoint).toBe(ENTRY_POINT_V0_7_OBSERVED_ON_BASE.toLowerCase());
  });

  it("rejects a bad EIP-55 checksum", () => {
    // Flip one hex letter's case in the checksummed EntryPoint address:
    // still mixed-case, so the checksum check runs and must fail.
    const corrupted = "0x0000000071727dE22E5E9d8BAf0edAc6f37da032";
    expect(corrupted).not.toBe("0x0000000071727De22E5E9d8BAf0edAc6f37da032");
    expect(() => parseErc4337Claim({ ...BASE_CLAIM, entryPoint: corrupted })).toThrow(
      /checksum/,
    );
  });

  it("keeps an exact userOpHash (normalized lowercase)", () => {
    const hash = `0x${"AB".repeat(32)}`;
    const claim = parseErc4337Claim({
      ...BASE_CLAIM,
      userOperation: { userOpHash: hash, sender: SENDER },
    });
    expect(claim.userOperation.userOpHash).toBe(hash.toLowerCase());
  });

  it("rejects malformed userOpHash / tx hash / unknown fields", () => {
    expect(() =>
      parseErc4337Claim({ ...BASE_CLAIM, userOperation: { userOpHash: "0x1234", sender: SENDER } }),
    ).toThrow(/bytes32/);
    expect(() =>
      parseErc4337Claim({ ...BASE_CLAIM, bundleTransactionHash: "0xdeadbeef" }),
    ).toThrow(NecAdapterErc4337Error);
    expect(() => parseErc4337Claim({ ...BASE_CLAIM, extra: true })).toThrow(/unknown field/);
    expect(() => parseErc4337Claim(null)).toThrow(NecAdapterErc4337Error);
  });

  it("rejects requireSuccess=false (v0.1 is success-only, fail closed)", () => {
    expect(() =>
      parseErc4337Claim({
        ...BASE_CLAIM,
        userOperation: { sender: SENDER, requireSuccess: false },
      }),
    ).toThrow(/success-only/);
  });

  it("parses the exact ERC-1155 burn expectation with canonical decimals", () => {
    const claim = parseErc4337Claim({
      ...BASE_CLAIM,
      expectedEffect: {
        kind: EXPECTED_EFFECT_KIND_ERC1155_BURN,
        contract: `0x${CREDITS_CONTRACT.slice(2).toUpperCase()}`,
        from: SENDER,
        tokenId: `00${TOKEN_ID}`,
        value: "1",
      },
    });
    expect(claim.expectedEffect).toEqual({
      kind: "erc1155-burn",
      contract: CREDITS_CONTRACT,
      from: SENDER,
      tokenId: TOKEN_ID,
      value: "1",
    });
  });

  it("rejects wrong effect kind, zero value and malformed amounts", () => {
    expect(() =>
      parseErc4337Claim({
        ...BASE_CLAIM,
        expectedEffect: { kind: "erc20-transfer", contract: CREDITS_CONTRACT, from: SENDER, tokenId: "1", value: "1" },
      }),
    ).toThrow(/erc1155-burn/);
    expect(() =>
      parseErc4337Claim({
        ...BASE_CLAIM,
        expectedEffect: { kind: "erc1155-burn", contract: CREDITS_CONTRACT, from: SENDER, tokenId: "1", value: "0" },
      }),
    ).toThrow(/greater than zero/);
    expect(() =>
      parseErc4337Claim({
        ...BASE_CLAIM,
        expectedEffect: { kind: "erc1155-burn", contract: CREDITS_CONTRACT, from: SENDER, tokenId: "-1", value: "1" },
      }),
    ).toThrow(NecAdapterErc4337Error);
    expect(() =>
      parseErc4337Claim({
        ...BASE_CLAIM,
        expectedEffect: { kind: "erc1155-burn", contract: CREDITS_CONTRACT, from: SENDER, tokenId: "1" },
      }),
    ).toThrow(/missing required field "value"/);
  });

  it("rejects non-eip155 networks and malformed CAIP-2", () => {
    expect(() =>
      parseErc4337Claim({ ...BASE_CLAIM, network: "eip155:999", chainId: 1 }),
    ).toThrow(/chain id/);
    expect(() => parseErc4337Claim({ ...BASE_CLAIM, network: "solana:mainnet" })).toThrow(
      /eip155/,
    );
    expect(() => parseErc4337Claim({ ...BASE_CLAIM, network: "not-a-caip2" })).toThrow(
      NecAdapterErc4337Error,
    );
  });

  it("digest is canonical over the normalized claim (idempotent intake)", () => {
    const raw = {
      network: NETWORK_ID,
      bundleTransactionHash: TX,
      entryPoint: ENTRY_POINT,
      entryPointProfile: "v0.7",
      userOperation: { sender: `0x${SENDER.slice(2).toUpperCase()}` },
      expectedEffect: {
        kind: EXPECTED_EFFECT_KIND_ERC1155_BURN,
        contract: CREDITS_CONTRACT,
        from: SENDER,
        tokenId: TOKEN_ID,
        value: "01",
      },
    };
    const a = computeErc4337ClaimDigest(parseErc4337Claim(raw));
    const b = computeErc4337ClaimDigest(parseErc4337Claim(raw));
    // Re-parsing a NORMALIZED claim must be an identity operation.
    const normalized = parseErc4337Claim(raw);
    const c = computeErc4337ClaimDigest(parseErc4337Claim(normalized));
    expect(a).toBe(b);
    expect(c).toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
    // A different claim digests differently.
    const different = parseErc4337Claim({
      ...BASE_CLAIM,
      userOperation: { sender: SENDER },
      expectedEffect: {
        kind: EXPECTED_EFFECT_KIND_ERC1155_BURN,
        contract: CREDITS_CONTRACT,
        from: SENDER,
        tokenId: TOKEN_ID,
        value: "2",
      },
    });
    expect(computeErc4337ClaimDigest(different)).not.toBe(a);
    expect(canonicalJson(parseErc4337Claim(raw))).toContain(TOKEN_ID);
  });
});

describe("buildErc4337Correlation", () => {
  const policy: EvidencePolicy = (() => {
    const content = {
      id: "erc4337-basic",
      version: "1",
      requiredDimensions: ["execution", "observedEffects"] as PolicyDimension[],
      desiredDimensions: ["finality"] as PolicyDimension[],
    };
    return { ...content, digest: computeEvidencePolicyDigest(content) };
  })();

  it("maps the claim to an exact transaction subject + expectation action", () => {
    const correlation = buildErc4337Correlation(BASE_CLAIM);
    expect(correlation.subject).toEqual({
      type: "transaction",
      networkId: NETWORK_ID,
      txId: TX,
    });
    expect(correlation.action.kind).toBe(ACTION_KIND_ERC4337_USEROPERATION);
    expect(correlation.action.target).toBe(ENTRY_POINT);
    expect((correlation.action.fields as Record<string, unknown>)["sender"]).toBe(SENDER);
    expect(correlation.request).toBeUndefined();
  });

  it("builds a complete EvidenceRequest only with requestId+policy together", () => {
    expect(() =>
      buildErc4337Correlation(BASE_CLAIM, { requestId: "req_1" }),
    ).toThrow(/together/);
    const withRequest = buildErc4337Correlation(BASE_CLAIM, {
      requestId: "req_erc4337",
      evidencePolicy: policy,
    });
    expect(withRequest.request?.requestId).toBe("req_erc4337");
    expect(withRequest.request?.subject).toEqual(correlationSubject());
    function correlationSubject() {
      return { type: "transaction", networkId: NETWORK_ID, txId: TX };
    }
  });
});
