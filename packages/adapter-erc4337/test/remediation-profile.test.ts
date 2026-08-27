import { describe, expect, it } from "vitest";

import {
  assessErc4337UserOperation,
  ENTRY_POINT_PROFILES,
  ERC4337_CONFLICT_CODES,
  parseErc4337Claim,
} from "../src/index.js";

import {
  buildFragment,
  CREDITS_CONTRACT,
  ENTRY_POINT,
  OTHER_ACCOUNT,
  SENDER,
  TOKEN_ID,
  transferSingleEffect,
  TX,
  userOpEventEffect,
  USER_OP_HASH,
} from "./helpers.js";

const V06 = ENTRY_POINT_PROFILES["v0.6"];
const V07 = ENTRY_POINT_PROFILES["v0.7"];

describe("EntryPoint profile/version binding (fail closed)", () => {
  it("rejects an unknown profile at intake", () => {
    expect(() =>
      parseErc4337Claim({
        network: "eip155:8453",
        bundleTransactionHash: TX,
        entryPoint: V07,
        entryPointProfile: "v0.99",
        userOperation: { sender: SENDER },
      }),
    ).toThrow(/ENTRYPOINT_PROFILE_UNKNOWN|profile/);
  });

  it("rejects a declared profile whose emitter disagrees with the claimed entryPoint (intake fail closed)", () => {
    // Emitter is the v0.7 address but the profile declares v0.6.
    expect(() =>
      parseErc4337Claim({
        network: "eip155:8453",
        bundleTransactionHash: TX,
        entryPoint: V07,
        entryPointProfile: "v0.6",
        userOperation: { sender: SENDER },
      }),
    ).toThrow(/ENTRYPOINT_PROFILE_MISMATCH|profile/);
  });

  it("accepts a correctly bound profile + emitter and supports the proposition", () => {
    const fragment = buildFragment({
      effects: [userOpEventEffect("uop", { emitter: V06 })],
    });
    const evaluation = assessErc4337UserOperation(
      {
        network: "eip155:8453",
        bundleTransactionHash: TX,
        entryPoint: V06,
        entryPointProfile: "v0.6",
        userOperation: { userOpHash: USER_OP_HASH, sender: SENDER },
      },
      fragment,
    );
    expect(evaluation.outcome.verdict).toBe("supported");
    expect(evaluation.claim.entryPointProfile).toBe("v0.6");
  });

  it("profile mismatch (wrong generation) cannot launder a shaped event from another EntryPoint", () => {
    // Claim pins v0.6 emitter; evidence carries a v0.7-shaped event.
    const fragment = buildFragment({
      effects: [userOpEventEffect("uop", { emitter: V07 }), transferSingleEffect("burn")],
    });
    const evaluation = assessErc4337UserOperation(
      {
        network: "eip155:8453",
        bundleTransactionHash: TX,
        entryPoint: V06,
        entryPointProfile: "v0.6",
        userOperation: { userOpHash: USER_OP_HASH, sender: SENDER },
        expectedEffect: {
          kind: "erc1155-burn",
          contract: CREDITS_CONTRACT,
          from: SENDER,
          tokenId: TOKEN_ID,
          value: "1",
        },
      },
      fragment,
    );
    // The v0.7-shaped event is excluded as a non-claimed emitter; the
    // proposition cannot be supported by a mismatched profile/generation.
    expect(evaluation.outcome.verdict).toBe("insufficient");
    expect(evaluation.candidateCount).toBe(0);
    expect(evaluation.nonEntryEmitterCount).toBe(1);
  });

  it("a coherent profile binding does not emit a spurious profile conflict", () => {
    const fragment = buildFragment({
      effects: [userOpEventEffect("uop", { emitter: V07, sender: OTHER_ACCOUNT })],
    });
    const evaluation = assessErc4337UserOperation(
      {
        network: "eip155:8453",
        bundleTransactionHash: TX,
        entryPoint: V07,
        entryPointProfile: "v0.7",
        userOperation: { userOpHash: USER_OP_HASH, sender: SENDER },
      },
      fragment,
    );
    expect(evaluation.outcome.verdict).toBe("contradicted");
    expect(
      evaluation.outcome.materialConflictIds.some((id) =>
        id.includes(ERC4337_CONFLICT_CODES.entryPointProfileMismatch),
      ),
    ).toBe(false);
  });
});
