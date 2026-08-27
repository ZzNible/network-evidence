import { describe, expect, it } from "vitest";

import {
  assessErc4337UserOperation,
  ERC4337_CONFLICT_CODES,
  ERC4337_NON_CLAIMS,
  ERC4337_WARNING_CODES,
  EXPECTED_EFFECT_KIND_ERC1155_BURN,
  interpretTransferBatchEffect,
  keccak256Hex,
  TRANSFER_BATCH_SIGNATURE,
  TRANSFER_BATCH_TOPIC0,
  utf8Bytes,
  ZERO_ADDRESS,
} from "../src/index.js";
import type { ObservedEffect } from "@nec/core";

import {
  buildFragment,
  CREDITS_CONTRACT,
  ENTRY_POINT,
  OTHER_ACCOUNT,
  OTHER_CONTRACT,
  padTopic,
  SENDER,
  TOKEN_ID,
  transferBatchEffect,
  transferSingleEffect,
  TX,
  userOpEventEffect,
  USER_OP_HASH,
  hexWord,
} from "./helpers.js";

const CLAIM = {
  network: "eip155:8453",
  bundleTransactionHash: TX,
  entryPoint: ENTRY_POINT,
  entryPointProfile: "v0.7",
  userOperation: { userOpHash: USER_OP_HASH, sender: SENDER },
};

const BURN = {
  kind: EXPECTED_EFFECT_KIND_ERC1155_BURN,
  contract: CREDITS_CONTRACT,
  from: SENDER,
  tokenId: TOKEN_ID,
  value: "1",
};

describe("pinned TransferBatch topic0 derivation", () => {
  it("keccak256 of the canonical TransferBatch signature equals the pin", () => {
    expect(`0x${keccak256Hex(utf8Bytes(TRANSFER_BATCH_SIGNATURE))}`).toBe(TRANSFER_BATCH_TOPIC0);
    expect(TRANSFER_BATCH_TOPIC0).toBe(
      "0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb",
    );
  });
});

describe("interpretTransferBatchEffect — strict ABI", () => {
  it("decodes a well-formed batch with multiple members deterministically", () => {
    const effect = transferBatchEffect("batch", {
      from: SENDER,
      to: ZERO_ADDRESS,
      ids: ["1", "2", TOKEN_ID],
      values: ["10", "20", "1"],
    });
    const result = interpretTransferBatchEffect(effect);
    expect(result.status).toBe("transferBatch");
    if (result.status !== "transferBatch") return;
    expect(result.observation.contract).toBe(CREDITS_CONTRACT);
    expect(result.observation.from).toBe(SENDER);
    expect(result.observation.to).toBe(ZERO_ADDRESS);
    expect(result.observation.members).toHaveLength(3);
    expect(result.observation.members[0]!.memberId).toBe("batch#0");
    expect(result.observation.members[0]!.tokenId).toBe("1");
    expect(result.observation.members[0]!.value).toBe("10");
    expect(result.observation.members[2]!.tokenId).toBe(TOKEN_ID);
    expect(result.observation.members[2]!.value).toBe("1");
    expect(result.observation.members.every((m) => m.to === ZERO_ADDRESS)).toBe(true);
  });

  it("projects a mint member (from == zero) without calling it a burn", () => {
    const effect = transferBatchEffect("mintbatch", {
      from: ZERO_ADDRESS,
      to: OTHER_ACCOUNT,
      ids: ["5"],
      values: ["100"],
    });
    const result = interpretTransferBatchEffect(effect);
    if (result.status !== "transferBatch") throw new Error("expected batch");
    expect(result.observation.members[0]!.from).toBe(ZERO_ADDRESS);
    expect(result.observation.members[0]!.to).toBe(OTHER_ACCOUNT);
  });

  it("treats other topic0 values as unrelated", () => {
    const effect: ObservedEffect = {
      id: "n",
      type: "evm.log",
      fields: {
        address: CREDITS_CONTRACT,
        topics: [`0x${"33".repeat(32)}`, padTopic(SENDER), padTopic(ZERO_ADDRESS), padTopic(ZERO_ADDRESS)],
        data: "0x",
        removed: false,
      },
      basis: ["source_observation"],
      evidence: ["ev_n"],
    };
    expect(interpretTransferBatchEffect(effect).status).toBe("unrelated");
  });

  it.each([
    ["removed batch", { removed: true }],
    [
      "wrong topic count",
      { topicsOverride: [TRANSFER_BATCH_TOPIC0, padTopic(SENDER), padTopic(ZERO_ADDRESS)] },
    ],
    [
      "malformed address padding",
      {
        topicsOverride: [
          TRANSFER_BATCH_TOPIC0,
          padTopic(SENDER),
          `0x01${"00".repeat(11)}${SENDER.slice(2)}`,
          padTopic(ZERO_ADDRESS),
        ],
      },
    ],
  ])("excludes malformed relevant TransferBatch: %s", (_name, opts) => {
    const result = interpretTransferBatchEffect(transferBatchEffect("b", opts as never));
    expect(result.status).toBe("excluded");
    expect((result as { reason: string }).reason).toBe(
      (opts as { removed?: boolean }).removed ? "removed" : "malformed",
    );
  });

  it("excludes ids/values length mismatch (malformed relevant)", () => {
    const result = interpretTransferBatchEffect(
      transferBatchEffect("mismatch", { ids: ["1", "2"], values: ["1"] }),
    );
    expect(result.status).toBe("excluded");
    expect((result as { reason: string }).reason).toBe("malformed");
  });

  it("excludes trailing words after the decoded arrays", () => {
    const base = transferBatchEffect("trail", { ids: ["1"], values: ["1"] });
    const data = (base.fields["data"] as string) + "00".repeat(32);
    const result = interpretTransferBatchEffect(transferBatchEffect("trail", { dataOverride: data }));
    expect(result.status).toBe("excluded");
    expect((result as { detail: string }).detail).toMatch(/trailing/);
  });

  it("excludes truncated arrays (claimed length exceeds data)", () => {
    // headIds=0x40(2), headValues=0xa0(5), idsCount=2, id1, id2, valuesCount=3, then cut off.
    const data = `0x${hexWord("64")}${hexWord("160")}${hexWord("2")}${hexWord("1")}${hexWord("2")}${hexWord("3")}`;
    const result = interpretTransferBatchEffect(transferBatchEffect("trunc", { dataOverride: data }));
    expect(result.status).toBe("excluded");
    expect((result as { detail: string }).detail).toMatch(/truncated/);
  });

  it("excludes overlapping array spans", () => {
    const data = `0x${hexWord("64")}${hexWord("64")}${hexWord("1")}${hexWord("1")}${hexWord("1")}${hexWord("1")}`;
    const result = interpretTransferBatchEffect(transferBatchEffect("overlap", { dataOverride: data }));
    expect(result.status).toBe("excluded");
    expect((result as { detail: string }).detail).toMatch(/overlap/);
  });

  it("excludes non-aligned head offsets", () => {
    const data = `0x${hexWord("65")}${hexWord("0")}${hexWord("1")}${hexWord("1")}`;
    const result = interpretTransferBatchEffect(
      transferBatchEffect("unaligned", { dataOverride: data }),
    );
    expect(result.status).toBe("excluded");
    expect((result as { detail: string }).detail).toMatch(/aligned/);
  });
});

describe("evaluation — TransferBatch exact-burn correlation", () => {
  it("supports an exact TransferBatch member burn (co-observed in same bundle)", () => {
    const fragment = buildFragment({
      effects: [
        userOpEventEffect("uop"),
        transferBatchEffect("batch", { from: SENDER, to: ZERO_ADDRESS, ids: [TOKEN_ID], values: ["1"] }),
      ],
    });
    const evaluation = assessErc4337UserOperation({ ...CLAIM, expectedEffect: BURN }, fragment);
    expect(evaluation.outcome.verdict).toBe("supported");
    expect(evaluation.matchingBurns).toHaveLength(1);
    expect(evaluation.matchingBurns[0]!.carrier).toBe("transferBatch");
    expect(evaluation.matchingBurns[0]!.effectId).toBe("batch#0");
    expect(evaluation.transferBatchCandidateCount).toBe(1);
    expect(evaluation.correlationStrength).toBe("same_bundle_only");
    expect(evaluation.nonClaims).toContain("CAUSAL_ATTRIBUTION_NOT_ESTABLISHED");
  });

  it("batch wrong contract never satisfies (insufficient, never refutes)", () => {
    const fragment = buildFragment({
      effects: [
        userOpEventEffect("uop"),
        transferBatchEffect("batch", {
          contract: OTHER_CONTRACT,
          from: SENDER,
          to: ZERO_ADDRESS,
          ids: [TOKEN_ID],
          values: ["1"],
        }),
      ],
    });
    const evaluation = assessErc4337UserOperation({ ...CLAIM, expectedEffect: BURN }, fragment);
    expect(evaluation.outcome.verdict).toBe("insufficient");
    expect(evaluation.matchingBurns).toHaveLength(0);
  });

  it("batch wrong from never satisfies the expectation", () => {
    const fragment = buildFragment({
      effects: [
        userOpEventEffect("uop"),
        transferBatchEffect("batch", {
          from: OTHER_ACCOUNT,
          to: ZERO_ADDRESS,
          ids: [TOKEN_ID],
          values: ["1"],
        }),
      ],
    });
    const evaluation = assessErc4337UserOperation({ ...CLAIM, expectedEffect: BURN }, fragment);
    expect(evaluation.outcome.verdict).toBe("insufficient");
  });

  it("batch wrong tokenId contradicts the exact expectation", () => {
    const fragment = buildFragment({
      effects: [
        userOpEventEffect("uop"),
        transferBatchEffect("batch", {
          from: SENDER,
          to: ZERO_ADDRESS,
          ids: ["999"],
          values: ["1"],
        }),
      ],
    });
    const evaluation = assessErc4337UserOperation({ ...CLAIM, expectedEffect: BURN }, fragment);
    expect(evaluation.outcome.verdict).toBe("contradicted");
    expect(evaluation.conflictingBurns[0]?.violations).toEqual(["tokenId:999"]);
  });

  it("batch wrong value contradicts the exact expectation", () => {
    const fragment = buildFragment({
      effects: [
        userOpEventEffect("uop"),
        transferBatchEffect("batch", {
          from: SENDER,
          to: ZERO_ADDRESS,
          ids: [TOKEN_ID],
          values: ["2"],
        }),
      ],
    });
    const evaluation = assessErc4337UserOperation({ ...CLAIM, expectedEffect: BURN }, fragment);
    expect(evaluation.outcome.verdict).toBe("contradicted");
    expect(evaluation.conflictingBurns[0]?.violations).toEqual(["value:2"]);
  });

  it("a batch mint (from == zero) is NEVER classified as a burn", () => {
    const fragment = buildFragment({
      effects: [
        userOpEventEffect("uop"),
        transferBatchEffect("batch", {
          from: ZERO_ADDRESS,
          to: SENDER,
          ids: [TOKEN_ID],
          values: ["1"],
        }),
      ],
    });
    const evaluation = assessErc4337UserOperation({ ...CLAIM, expectedEffect: BURN }, fragment);
    expect(evaluation.outcome.verdict).toBe("insufficient");
    expect(evaluation.matchingBurns).toHaveLength(0);
    expect(
      evaluation.warnings.some((w) => w.code === ERC4337_WARNING_CODES.erc1155MintIsNotBurn),
    ).toBe(true);
  });

  it("malformed relevant TransferBatch fails closed to ambiguous", () => {
    const malformed = transferBatchEffect("bad", { ids: ["1", "2"], values: ["1"] });
    const fragment = buildFragment({ effects: [userOpEventEffect("uop"), malformed] });
    const evaluation = assessErc4337UserOperation({ ...CLAIM, expectedEffect: BURN }, fragment);
    expect(evaluation.outcome.verdict).toBe("ambiguous");
    expect(
      evaluation.outcome.materialConflictIds.some((id) => id.includes("MALFORMED_TRANSFER_BATCH")),
    ).toBe(true);
  });

  it("removed TransferBatch is excluded, never positive evidence", () => {
    const removed = transferBatchEffect("removed", {
      removed: true,
      from: SENDER,
      to: ZERO_ADDRESS,
      ids: [TOKEN_ID],
      values: ["1"],
    });
    const fragment = buildFragment({ effects: [userOpEventEffect("uop"), removed] });
    const evaluation = assessErc4337UserOperation({ ...CLAIM, expectedEffect: BURN }, fragment);
    expect(evaluation.outcome.verdict).toBe("insufficient");
    expect(evaluation.matchingBurns).toHaveLength(0);
  });

  it("operator != from with correct from is still a supported exact burn", () => {
    const single = transferSingleEffect("single", { operator: OTHER_ACCOUNT, from: SENDER });
    const batch = transferBatchEffect("batch", {
      operator: OTHER_ACCOUNT,
      from: SENDER,
      to: ZERO_ADDRESS,
      ids: [TOKEN_ID],
      values: ["1"],
    });
    for (const burn of [single, batch]) {
      const fragment = buildFragment({ effects: [userOpEventEffect("uop"), burn] });
      const evaluation = assessErc4337UserOperation({ ...CLAIM, expectedEffect: BURN }, fragment);
      expect(evaluation.outcome.verdict).toBe("supported");
    }
  });

  it("two exact members inside one batch are a duplicate (ambiguous)", () => {
    const batch = transferBatchEffect("batch", {
      from: SENDER,
      to: ZERO_ADDRESS,
      ids: [TOKEN_ID, TOKEN_ID],
      values: ["1", "1"],
    });
    const fragment = buildFragment({ effects: [userOpEventEffect("uop"), batch] });
    const evaluation = assessErc4337UserOperation({ ...CLAIM, expectedEffect: BURN }, fragment);
    expect(evaluation.outcome.verdict).toBe("ambiguous");
    expect(evaluation.matchingBurns).toHaveLength(2);
    expect(
      evaluation.outcome.materialConflictIds.some((id) => id.includes("DUPLICATE_EXACT_BURNS")),
    ).toBe(true);
  });

  it("single + batch duplicate exact burn is a material conflict (ambiguous)", () => {
    const single = transferSingleEffect("single");
    const batch = transferBatchEffect("batch", {
      from: SENDER,
      to: ZERO_ADDRESS,
      ids: [TOKEN_ID],
      values: ["1"],
    });
    const fragment = buildFragment({ effects: [userOpEventEffect("uop"), single, batch] });
    const evaluation = assessErc4337UserOperation({ ...CLAIM, expectedEffect: BURN }, fragment);
    expect(evaluation.outcome.verdict).toBe("ambiguous");
    expect(evaluation.matchingBurns).toHaveLength(2);
    expect(
      evaluation.outcome.materialConflictIds.some((id) => id.includes("DUPLICATE_EXACT_BURNS")),
    ).toBe(true);
  });

  it("two separate TransferBatch carriers with the same exact burn member are a material duplicate (ambiguous, no first-match)", () => {
    // Two DISTINCT TransferBatch carriers, each carrying one member that
    // exactly matches the expected burn. No single-carrier case.
    const batchA = transferBatchEffect("batchA", {
      from: SENDER,
      to: ZERO_ADDRESS,
      ids: [TOKEN_ID],
      values: ["1"],
    });
    const batchB = transferBatchEffect("batchB", {
      from: SENDER,
      to: ZERO_ADDRESS,
      ids: [TOKEN_ID],
      values: ["1"],
    });
    const fragment = buildFragment({ effects: [userOpEventEffect("uop"), batchA, batchB] });
    const evaluation = assessErc4337UserOperation({ ...CLAIM, expectedEffect: BURN }, fragment);
    // material duplicate-exact-burn conflict => ambiguous, never first-match
    expect(evaluation.outcome.verdict).toBe("ambiguous");
    expect(
      evaluation.outcome.materialConflictIds.some((id) => id.includes("DUPLICATE_EXACT_BURNS")),
    ).toBe(true);
    // ALL exact candidates are surfaced deterministically; none dropped.
    expect(evaluation.matchingBurns).toHaveLength(2);
    expect(evaluation.matchingBurns.every((b) => b.carrier === "transferBatch")).toBe(true);
    expect(evaluation.matchingBurns.map((b) => b.effectId).sort()).toEqual([
      "batchA#0",
      "batchB#0",
    ]);
  });

  it("partial burns whose values sum to the expected are NOT aggregated", () => {
    const p1 = transferSingleEffect("p1", { value: "1" });
    const p2 = transferSingleEffect("p2", { value: "2" });
    const fragment = buildFragment({ effects: [userOpEventEffect("uop"), p1, p2] });
    const evaluation = assessErc4337UserOperation(
      { ...CLAIM, expectedEffect: { ...BURN, value: "3" } },
      fragment,
    );
    expect(evaluation.matchingBurns).toHaveLength(0);
    expect(evaluation.matchingBurns.every((b) => b.value === "3")).toBe(true);
  });

  it("failed selected UserOperation + exact matching burn => contradicted, burn separately observed", () => {
    const fragment = buildFragment({
      effects: [userOpEventEffect("uop", { success: false }), transferSingleEffect("burn")],
    });
    const evaluation = assessErc4337UserOperation({ ...CLAIM, expectedEffect: BURN }, fragment);
    expect(evaluation.outcome.verdict).toBe("contradicted");
    expect(evaluation.selectedUserOperationFailure?.reason).toBe("userOperationFailed");
    expect(evaluation.matchingBurns).toHaveLength(1);
    expect(evaluation.matchingBurns[0]!.effectId).toBe("burn");
  });

  it("foreign EntryPoint + canonical topic cannot launder a positive burn", () => {
    const foreignUop = userOpEventEffect("foreign", { emitter: `0x${"e5".repeat(20)}` });
    const fragment = buildFragment({ effects: [foreignUop, transferSingleEffect("burn")] });
    const evaluation = assessErc4337UserOperation({ ...CLAIM, expectedEffect: BURN }, fragment);
    expect(evaluation.outcome.verdict).toBe("insufficient");
    expect(evaluation.candidateCount).toBe(0);
    expect(evaluation.nonEntryEmitterCount).toBe(1);
    expect(evaluation.matchingBurns).toHaveLength(1);
  });

  it("every assessment exposes the same-bundle-only causal boundary explicitly", () => {
    const fragment = buildFragment({
      effects: [userOpEventEffect("uop"), transferSingleEffect("burn")],
    });
    const evaluation = assessErc4337UserOperation({ ...CLAIM, expectedEffect: BURN }, fragment);
    expect(evaluation.correlationStrength).toBe("same_bundle_only");
    expect(evaluation.nonClaims).toContain("CAUSAL_ATTRIBUTION_NOT_ESTABLISHED");
    expect(evaluation.nonClaims).toContain("ENTRYPOINT_IMPLEMENTATION_VERSION_NOT_VERIFIED");
  });
});
