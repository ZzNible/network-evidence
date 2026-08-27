import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  evaluateTransactionAcquisition,
  replayTransactionAcquisition,
  validateEvmAcquisitionFixture,
} from "@nec/resolver-evm";

import {
  assessErc4337UserOperation,
  ERC4337_WARNING_CODES,
  EXPECTED_EFFECT_KIND_ERC1155_BURN,
  ENTRY_POINT_V0_7_OBSERVED_ON_BASE,
  TRANSFER_SINGLE_TOPIC0,
  USER_OPERATION_EVENT_TOPIC0,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Independently re-established facts for the primary Nevermined redemption
// bundle (Base mainnet). These were re-derived from RAW receipt material
// during fixture acquisition — no pre-decoded third-party output was copied.
// ---------------------------------------------------------------------------

const PRIMARY_TX = "0x79549bcf07ac093eabc682e472c59e1c22858f9af14f77d0a0074fd11d3e578b";
const PRIMARY_BLOCK = 45309460n;
const USER_OP_HASH = "0x94e3b302718e1f594c903cdb8237741c02edf12495cc78b34e30b9cfcfe5ae31";
const SENDER = "0xf64dd2892370f6d75aa1bd0f10da312235a06a1e";
const CREDITS = "0xb2f9bb43f768e0d4adca49ce708acbe577bc2d64";
const TOKEN_ID = "107134729016282785317688751027026876438402324055584221042936325851129895197441";

const SECONDARY_TX = "0x2d0423f4e962f6d6c45d29db57b8d0444bcfcebb6e3ef512c351238d2451ff3a";
const SECONDARY_OP_A_HASH = "0x25559b0604e25d3a4b4f64ec525fb017675a625fb2861b59ea7f889fe3eb7271";
const SECONDARY_OP_A_SENDER = "0x45b2c38b6efbde5e6134d4f332f01cfa516930b6";
const SECONDARY_MINT_ID = "86840200123100766993569678560615076357227318064098275246495913091041571748245";

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8"));
}

function primaryClaim(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    network: "eip155:8453",
    bundleTransactionHash: PRIMARY_TX,
    entryPoint: ENTRY_POINT_V0_7_OBSERVED_ON_BASE,
    entryPointProfile: "v0.7",
    userOperation: { userOpHash: USER_OP_HASH, sender: SENDER },
    ...extra,
  };
}

describe("primary real fixture (offline replay)", () => {
  const raw = loadFixture("base-mainnet-redeem-bundle.json");
  const fixture = validateEvmAcquisitionFixture(raw);

  it("carries clean provenance: no credentials, endpoints or local paths", () => {
    const text = JSON.stringify(raw);
    expect(text).not.toMatch(/authorization/i);
    expect(text).not.toMatch(/api[_-]?key/i);
    expect(text).not.toMatch(/https?:\/\//); // endpoint URLs are never stored
    expect(fixture.schemaVersion).toBe("nec-resolver-evm-fixture-v1");
    expect(fixture.source.networkId).toBe("eip155:8453");
    expect(fixture.subject.txHash).toBe(PRIMARY_TX);
    expect(fixture.captures.map((c) => c.rpcMethod)).toEqual([
      "eth_chainId",
      "eth_getTransactionReceipt",
      "eth_getBlockByHash",
      "eth_getTransactionByHash",
    ]);
  });

  it("replays offline into a consistent acquisition at the observed block", async () => {
    const acquisition = await replayTransactionAcquisition(raw, { includeTransaction: true });
    expect(acquisition.consistent).toBe(true);
    expect(acquisition.receipt?.status).toBe("success");
    expect(acquisition.receipt?.blockNumber).toBe(PRIMARY_BLOCK);
  });

  it("supports the exact redemption proposition against raw chain evidence", async () => {
    const acquisition = await replayTransactionAcquisition(raw, { includeTransaction: true });
    const { fragment } = evaluateTransactionAcquisition(acquisition);
    const evaluation = assessErc4337UserOperation(
      primaryClaim({
        expectedEffect: {
          kind: EXPECTED_EFFECT_KIND_ERC1155_BURN,
          contract: CREDITS,
          from: SENDER,
          tokenId: TOKEN_ID,
          value: "1",
        },
      }),
      fragment,
    );
    expect(evaluation.outcome.verdict).toBe("supported");
    expect(evaluation.subjectMatchesClaim).toBe(true);

    // Exact UserOperation independently identified inside THIS bundle.
    expect(evaluation.selectedUserOperation).toBeDefined();
    expect(evaluation.selectedUserOperation?.userOpHash).toBe(USER_OP_HASH);
    expect(evaluation.selectedUserOperation?.sender).toBe(SENDER);
    expect(evaluation.selectedUserOperation?.success).toBe(true);
    expect(evaluation.candidateCount).toBe(1);

    // Exact ERC-1155 burn independently observed (to == zero).
    expect(evaluation.matchingBurns).toHaveLength(1);
    const burn = evaluation.matchingBurns[0]!;
    expect(burn.contract).toBe(CREDITS);
    expect(burn.from).toBe(SENDER);
    expect(burn.to).toBe("0x0000000000000000000000000000000000000000");
    expect(burn.tokenId).toBe(TOKEN_ID);
    expect(burn.value).toBe("1");
  });

  it("raw receipt carries exactly one relevant UserOperationEvent + one burn", async () => {
    const acquisition = await replayTransactionAcquisition(raw, { includeTransaction: true });
    const logs = acquisition.receipt?.logs ?? [];
    const uops = logs.filter((l) => l.topics[0] === USER_OPERATION_EVENT_TOPIC0);
    const singles = logs.filter((l) => l.topics[0] === TRANSFER_SINGLE_TOPIC0);
    expect(uops).toHaveLength(1);
    expect(singles).toHaveLength(1);
    expect(uops[0]!.address).toBe(ENTRY_POINT_V0_7_OBSERVED_ON_BASE.toLowerCase());
    expect(uops[0]!.topics[1]).toBe(USER_OP_HASH);
    // success word decodes to canonical 1
    const data = uops[0]!.data.slice(2);
    expect(BigInt(`0x${data.slice(64, 128)}`)).toBe(1n);
  });

  it("contradicts a wrong-sender expectation against the same raw event", async () => {
    const acquisition = await replayTransactionAcquisition(raw, { includeTransaction: true });
    const { fragment } = evaluateTransactionAcquisition(acquisition);
    const evaluation = assessErc4337UserOperation(
      primaryClaim({
        userOperation: { userOpHash: USER_OP_HASH, sender: "0x1234567890abcdef1234567890abcdef12345678" },
      }),
      fragment,
    );
    expect(evaluation.outcome.verdict).toBe("contradicted");
    expect(evaluation.selectedUserOperationFailure?.reason).toBe("senderMismatch");
  });

  it("yields insufficiency for an unknown userOpHash despite successful bundle", async () => {
    const acquisition = await replayTransactionAcquisition(raw, { includeTransaction: true });
    const { fragment } = evaluateTransactionAcquisition(acquisition);
    const evaluation = assessErc4337UserOperation(
      primaryClaim({
        userOperation: { userOpHash: `0x${"00".repeat(32)}`, sender: SENDER },
      }),
      fragment,
    );
    expect(evaluation.outcome.verdict).toBe("insufficient");
    expect(evaluation.execution.verdict).toBe("supported"); // bundle itself succeeded
  });

  it("contradicts a wrong-tokenId burn expectation (same account, same contract)", async () => {
    const acquisition = await replayTransactionAcquisition(raw, { includeTransaction: true });
    const { fragment } = evaluateTransactionAcquisition(acquisition);
    const evaluation = assessErc4337UserOperation(
      primaryClaim({
        expectedEffect: {
          kind: EXPECTED_EFFECT_KIND_ERC1155_BURN,
          contract: CREDITS,
          from: SENDER,
          tokenId: "999",
          value: "1",
        },
      }),
      fragment,
    );
    expect(evaluation.outcome.verdict).toBe("contradicted");
    expect(evaluation.conflictingBurns).toHaveLength(1);
  });

  it("is deterministic across repeated offline replay + assessment", async () => {
    const run = async (): Promise<string> => {
      const acquisition = await replayTransactionAcquisition(raw, { includeTransaction: true });
      const { fragment } = evaluateTransactionAcquisition(acquisition);
      const evaluation = assessErc4337UserOperation(
        primaryClaim({
          expectedEffect: {
            kind: EXPECTED_EFFECT_KIND_ERC1155_BURN,
            contract: CREDITS,
            from: SENDER,
            tokenId: TOKEN_ID,
            value: "1",
          },
        }),
        fragment,
      );
      return JSON.stringify({
        outcome: evaluation.outcome,
        warnings: evaluation.warnings,
        selected: evaluation.selectedUserOperation,
        burns: evaluation.matchingBurns,
      });
    };
    expect(await run()).toBe(await run());
  });
});

describe("secondary real fixture: two UserOperations in one bundle", () => {
  it("selects one exact operation without borrowing bundle-wide success", async () => {
    const raw = loadFixture("base-mainnet-purchase-bundle.json");
    const acquisition = await replayTransactionAcquisition(raw, { includeTransaction: true });
    const { fragment } = evaluateTransactionAcquisition(acquisition);

    // Exactly TWO UserOperations executed in this single bundle tx.
    const uopEffects = (fragment.networkEvidence.observedEffects ?? []).filter(
      (e) => (e.fields.topics as string[])[0] === USER_OPERATION_EVENT_TOPIC0 &&
             ((e.fields.address as string).toLowerCase() === ENTRY_POINT_V0_7_OBSERVED_ON_BASE.toLowerCase()),
    );
    expect(uopEffects.length).toBeGreaterThanOrEqual(2);
    expect(fragment.networkEvidence.execution?.verdict).toBe("supported");

    // Expecting op A by its exact hash: uniquely identified and supported.
    const evaluationA = assessErc4337UserOperation(
      {
        network: "eip155:8453",
        bundleTransactionHash: SECONDARY_TX,
        entryPoint: ENTRY_POINT_V0_7_OBSERVED_ON_BASE,
        entryPointProfile: "v0.7",
        userOperation: { userOpHash: SECONDARY_OP_A_HASH, sender: SECONDARY_OP_A_SENDER },
      },
      fragment,
    );
    expect(evaluationA.outcome.verdict).toBe("supported");
    expect(evaluationA.selectedUserOperation?.userOpHash).toBe(SECONDARY_OP_A_HASH);

    // An unknown hash cannot borrow the bundle's success nor op A's success.
    const evaluationMissing = assessErc4337UserOperation(
      {
        network: "eip155:8453",
        bundleTransactionHash: SECONDARY_TX,
        entryPoint: ENTRY_POINT_V0_7_OBSERVED_ON_BASE,
        entryPointProfile: "v0.7",
        userOperation: { userOpHash: `0x${"77".repeat(32)}`, sender: SECONDARY_OP_A_SENDER },
      },
      fragment,
    );
    expect(evaluationMissing.outcome.verdict).toBe("insufficient");
    expect(evaluationMissing.selectedUserOperation).toBeUndefined();

    // Sender-only selection still resolves exactly one candidate per sender.
    const evaluationBySender = assessErc4337UserOperation(
      {
        network: "eip155:8453",
        bundleTransactionHash: SECONDARY_TX,
        entryPoint: ENTRY_POINT_V0_7_OBSERVED_ON_BASE,
        entryPointProfile: "v0.7",
        userOperation: { sender: SECONDARY_OP_A_SENDER },
      },
      fragment,
    );
    expect(evaluationBySender.outcome.verdict).toBe("supported");
  });

  it("proves a real mint is never classified as a burn", async () => {
    const raw = loadFixture("base-mainnet-purchase-bundle.json");
    const acquisition = await replayTransactionAcquisition(raw, { includeTransaction: true });
    const { fragment } = evaluateTransactionAcquisition(acquisition);

    const evaluation = assessErc4337UserOperation(
      {
        network: "eip155:8453",
        bundleTransactionHash: SECONDARY_TX,
        entryPoint: ENTRY_POINT_V0_7_OBSERVED_ON_BASE,
        entryPointProfile: "v0.7",
        userOperation: { userOpHash: SECONDARY_OP_A_HASH, sender: SECONDARY_OP_A_SENDER },
        expectedEffect: {
          kind: EXPECTED_EFFECT_KIND_ERC1155_BURN,
          contract: CREDITS,
          from: SECONDARY_OP_A_SENDER,
          tokenId: SECONDARY_MINT_ID,
          value: "100",
        },
      },
      fragment,
    );
    // The only TransferSingle on the credits contract here is a MINT
    // (from == zero -> subscriber): it must NOT satisfy the burn claim.
    expect(evaluation.matchingBurns).toHaveLength(0);
    expect(
      evaluation.warnings.some((w) => w.code === ERC4337_WARNING_CODES.erc1155MintIsNotBurn),
    ).toBe(true);
    expect(["insufficient", "ambiguous"]).toContain(evaluation.outcome.verdict);
  });
});
