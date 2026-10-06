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
  ENTRY_POINT_PROFILES,
  ERC4337_CLAIM_LABELS,
  ERC4337_NON_CLAIMS,
  ERC4337_WARNING_CODES,
  keccak256Hex,
  USER_OPERATION_EVENT_TOPIC0,
  utf8Bytes,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// EXTERNAL PUBLIC ERC-4337 fixture (Base Sepolia, EntryPoint v0.6). Only the
// transaction REFERENCE came from a public response to the Alchemy/Rundler
// outreach; the raw on-chain captures were reacquired independently,
// read-only, through the FROZEN @nec/resolver-evm pipeline (chainId +
// receipt + block-by-hash + transaction-by-hash captures from ONE source).
// One-source evidence: no cross-source independence is claimed.
//
// BOUNDARY: the on-chain receipt supports inclusion + execution success of
// the exact UserOperation in this exact bundle. It does NOT establish which
// bundler software (Rundler or otherwise) built or submitted the bundle —
// that would require an off-chain bundler trace, which this fixture does not
// contain. The bundle tx sender below is an EOA observed on chain and is
// deliberately NOT labelled as any bundler implementation.
//
// Every expected value below was re-derived from the RAW captures during
// acquisition; no pre-decoded third-party output is copied into evidence.
// ---------------------------------------------------------------------------

const FIXTURE = "base-sepolia-external-v06-userop.json";
const NETWORK = "eip155:84532";
const BUNDLE_TX = "0xde8916c81ef6a7b36ddf9f7b44d1ca096e4db4818eddfd5e16eda8a7c292ed45";
const BLOCK_NUMBER = 12168926n; // 0xb9aede
const BLOCK_HASH = "0x18cb57a710d328ea6304fc3be9ec47a34fbc54480cc42af59195d5a8e4763cbc";
const ENTRY_POINT_V06 = ENTRY_POINT_PROFILES["v0.6"];
const BUNDLE_TX_FROM = "0x9e375d31a8d0ed88d0ede9c7a3f775965d9442f2"; // observed EOA only
const USER_OP_HASH = "0x5f1e12031272034de5460796bd5cabe903a8ee6845fcab5fde18c4de632acfcf";
const SENDER_EIP55 = "0xFeF5B40AB4c543137262253dBaf7843Bd9b3e5B6";
const SENDER = SENDER_EIP55.toLowerCase();
const PAYMASTER = "0x8817340e0a3435e06254f2ed411e6418cd070d6f";
const NONCE = "31730356888106998500778810771485237444608";
const ACTUAL_GAS_COST = "10026199539816";
const ACTUAL_GAS_USED = "186726";
const TARGET_LOG_INDEX = 14n; // 0xe
/** A sender with TWO UserOperations in this same bundle (log 0x5 and 0x9). */
const REPEATED_SENDER = "0x9272f8c4b4f26a79701dd2272f7e0c82fb3cded2";
/** Canonical EntryPoint v0.6 handleOps: 11-field UserOperation tuple + beneficiary. */
const HANDLE_OPS_V06_SIGNATURE =
  "handleOps((address,uint256,bytes,bytes,uint256,uint256,uint256,uint256,uint256,bytes,bytes)[],address)";
const HANDLE_OPS_V06_SELECTOR = "0x1fad948c";

function loadFixture(): unknown {
  return JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", FIXTURE), "utf8"));
}

function claim(userOperation: Record<string, unknown>): Record<string, unknown> {
  // NO expectedEffect: this public fixture carries no ERC-1155 expectation.
  return {
    network: NETWORK,
    bundleTransactionHash: BUNDLE_TX,
    entryPoint: ENTRY_POINT_V06,
    entryPointProfile: "v0.6",
    userOperation,
  };
}

async function replayFragment(raw: unknown) {
  const acquisition = await replayTransactionAcquisition(raw, { includeTransaction: true });
  return { acquisition, fragment: evaluateTransactionAcquisition(acquisition).fragment };
}

describe("external public Base Sepolia v0.6 UserOperation fixture (offline replay)", () => {
  const raw = loadFixture();
  const fixture = validateEvmAcquisitionFixture(raw);

  it("carries clean provenance: no credentials, endpoints or local paths", () => {
    const text = JSON.stringify(raw);
    expect(text).not.toMatch(/authorization/i);
    expect(text).not.toMatch(/api[_-]?key/i);
    expect(text).not.toMatch(/https?:\/\//); // endpoint URLs are never stored
    expect(text).not.toMatch(/\/home\/|\/Users\/|[A-Z]:\\/); // no local paths
    expect(text).not.toMatch(/rundler|alchemy/i); // no provenance labels smuggled in
    expect(FIXTURE).not.toMatch(/rundler|alchemy/i); // filename is provenance-neutral too
    expect(fixture.schemaVersion).toBe("nec-resolver-evm-fixture-v1");
    expect(fixture.source.networkId).toBe(NETWORK);
    expect(fixture.source.chainId).toBe(84532);
    expect(fixture.subject.txHash).toBe(BUNDLE_TX);
    expect(fixture.captures.map((c) => c.rpcMethod)).toEqual([
      "eth_chainId",
      "eth_getTransactionReceipt",
      "eth_getBlockByHash",
      "eth_getTransactionByHash",
    ]);
    expect(fixture.captures[2]!.rpcParams).toEqual([BLOCK_HASH, false]);
  });

  it("replays offline into a consistent acquisition pinned to the observed block", async () => {
    const { acquisition } = await replayFragment(raw);
    expect(acquisition.consistent).toBe(true);
    expect(acquisition.checks.every((c) => c.passed)).toBe(true);
    expect(acquisition.chain.chainId).toBe(84532n);
    expect(acquisition.receipt?.status).toBe("success");
    expect(acquisition.receipt?.blockNumber).toBe(BLOCK_NUMBER);
    expect(acquisition.receipt?.blockHash).toBe(BLOCK_HASH);
    expect(acquisition.block?.number).toBe(BLOCK_NUMBER);
    expect(acquisition.block?.hash).toBe(BLOCK_HASH);
    // The bundle tx is a call INTO the v0.6 EntryPoint from an observed EOA.
    expect(acquisition.receipt?.to).toBe(ENTRY_POINT_V06);
    expect(acquisition.receipt?.from).toBe(BUNDLE_TX_FROM);
    expect(acquisition.transaction?.to).toBe(ENTRY_POINT_V06);
    expect(acquisition.transaction?.from).toBe(BUNDLE_TX_FROM);
  });

  it("raw tx input begins with the canonical v0.6 handleOps selector (test-only sanity)", async () => {
    // Selector sanity on raw calldata only; calldata is NOT parsed and the
    // userOpHash is NOT recomputed from it (not an adapter requirement).
    const selector = `0x${keccak256Hex(utf8Bytes(HANDLE_OPS_V06_SIGNATURE)).slice(0, 8)}`;
    expect(selector).toBe(HANDLE_OPS_V06_SELECTOR);
    const { acquisition } = await replayFragment(raw);
    const input = acquisition.transaction?.input ?? "";
    expect(input.length).toBeGreaterThan(10);
    expect(input.slice(0, 10)).toBe(HANDLE_OPS_V06_SELECTOR);
  });

  it("raw receipt carries SEVEN EntryPoint UserOperationEvents; exactly one matches the hash", async () => {
    const { acquisition } = await replayFragment(raw);
    const logs = acquisition.receipt?.logs ?? [];
    const uops = logs.filter((l) => l.topics[0] === USER_OPERATION_EVENT_TOPIC0);
    expect(uops).toHaveLength(7);
    expect(uops.every((l) => l.address === ENTRY_POINT_V06)).toBe(true);
    const target = uops.filter((l) => l.topics[1] === USER_OP_HASH);
    expect(target).toHaveLength(1);
    expect(target[0]!.logIndex).toBe(TARGET_LOG_INDEX);
  });

  it("supports ONLY the bounded proposition: this exact UserOperation succeeded in this exact bundle", async () => {
    const { fragment } = await replayFragment(raw);
    const evaluation = assessErc4337UserOperation(
      claim({ userOpHash: USER_OP_HASH, sender: SENDER_EIP55 }),
      fragment,
    );
    expect(evaluation.outcome.applicability).toBe("applicable");
    expect(evaluation.outcome.verdict).toBe("supported");
    expect(evaluation.outcome.materialConflictIds).toEqual([]);
    expect(evaluation.execution.verdict).toBe("supported");
    expect(evaluation.subjectMatchesClaim).toBe(true);
    expect(evaluation.observedNetwork).toEqual({ networkId: NETWORK, chainId: 84532, matchedRequirement: true });
    expect(evaluation.bundleTransactionHash).toBe(BUNDLE_TX);
    expect(evaluation.correlationStrength).toBe("same_bundle_only");
    expect(evaluation.claim.entryPointProfile).toBe("v0.6");
    expect(evaluation.claim.expectedEffect).toBeUndefined();
    // Operation-only claim: the label must NOT assert any co-observed effect.
    expect(evaluation.claimLabel).toBe(ERC4337_CLAIM_LABELS.supportedUserOperationOnly);
    expect(evaluation.claimLabel).toBe(
      "OBSERVED_ENTRYPOINT_EVIDENCE_SUPPORTS_SUCCESSFUL_SELECTED_USEROPERATION_IN_EXACT_BUNDLE",
    );
    expect(evaluation.claimLabel).not.toBe(ERC4337_CLAIM_LABELS.supported);
    expect(evaluation.claimLabel).not.toMatch(/EXPECTED_EFFECT|CO_OBSERVED|EFFECT/);

    // All seven EntryPoint events are bound candidates; hash selection picks one.
    expect(evaluation.candidateCount).toBe(7);
    expect(evaluation.nonEntryEmitterCount).toBe(0);
    expect(evaluation.excludedCandidates).toEqual([]);
    expect(evaluation.transactionHashMismatches).toEqual([]);

    const selected = evaluation.selectedUserOperation;
    expect(selected).toBeDefined();
    expect(selected?.emitter).toBe(ENTRY_POINT_V06);
    expect(selected?.userOpHash).toBe(USER_OP_HASH);
    expect(selected?.sender).toBe(SENDER);
    expect(selected?.paymaster).toBe(PAYMASTER);
    expect(selected?.nonce).toBe(NONCE);
    expect(selected?.success).toBe(true);
    expect(selected?.actualGasCost).toBe(ACTUAL_GAS_COST);
    expect(selected?.actualGasUsed).toBe(ACTUAL_GAS_USED);
    expect(selected?.transactionHash).toBe(BUNDLE_TX);
    expect(selected?.blockNumber).toBe(BLOCK_NUMBER.toString());
    expect(selected?.logIndex).toBe(TARGET_LOG_INDEX.toString()); // decimal string
    expect(evaluation.selectedUserOperationFailure).toBeUndefined();

    // No ERC-1155 effect was expected, so none is correlated either way.
    expect(evaluation.matchingBurns).toEqual([]);
    expect(evaluation.conflictingBurns).toEqual([]);
  });

  it("an unknown userOpHash is insufficient despite the successful bundle and six other ops", async () => {
    const { fragment } = await replayFragment(raw);
    const evaluation = assessErc4337UserOperation(
      claim({ userOpHash: `0x${"00".repeat(32)}`, sender: SENDER }),
      fragment,
    );
    expect(evaluation.outcome.verdict).toBe("insufficient");
    expect(evaluation.execution.verdict).toBe("supported"); // bundle itself succeeded
    expect(evaluation.selectedUserOperation).toBeUndefined();
  });

  it("a wrong sender for the exact hash is contradicted (senderMismatch)", async () => {
    const { fragment } = await replayFragment(raw);
    const evaluation = assessErc4337UserOperation(
      claim({ userOpHash: USER_OP_HASH, sender: REPEATED_SENDER }),
      fragment,
    );
    expect(evaluation.outcome.verdict).toBe("contradicted");
    expect(evaluation.selectedUserOperationFailure?.reason).toBe("senderMismatch");
    expect(evaluation.selectedUserOperationFailure?.observation.sender).toBe(SENDER);
  });

  it("sender-only selection fails closed when that sender has two ops in the bundle", async () => {
    const { fragment } = await replayFragment(raw);
    const repeated = assessErc4337UserOperation(claim({ sender: REPEATED_SENDER }), fragment);
    expect(repeated.outcome.verdict).toBe("ambiguous");
    expect(repeated.selectedUserOperation).toBeUndefined();
    // The target sender appears once, so sender-only selection is unique.
    const unique = assessErc4337UserOperation(claim({ sender: SENDER }), fragment);
    expect(unique.outcome.verdict).toBe("supported");
    expect(unique.selectedUserOperation?.userOpHash).toBe(USER_OP_HASH);
  });

  it("finality remains NOT ESTABLISHED", async () => {
    const { fragment } = await replayFragment(raw);
    expect(fragment.networkEvidence.finality).toBeUndefined();
    const evaluation = assessErc4337UserOperation(
      claim({ userOpHash: USER_OP_HASH, sender: SENDER }),
      fragment,
    );
    expect(
      evaluation.warnings.some((w) => w.code === ERC4337_WARNING_CODES.finalityNotEstablished),
    ).toBe(true);
    expect(evaluation.nonClaims).toContain("L2_BLOCK_FINALITY_NOT_ESTABLISHED");
    expect(evaluation.nonClaims).toContain("WITHDRAWAL_FINALIZATION_NOT_ESTABLISHED");
    expect(evaluation.nonClaims).toContain("ECONOMIC_IRREVERSIBILITY_NOT_ESTABLISHED");
  });

  it("makes no bundler / Rundler provenance claim", async () => {
    const { fragment } = await replayFragment(raw);
    const evaluation = assessErc4337UserOperation(
      claim({ userOpHash: USER_OP_HASH, sender: SENDER }),
      fragment,
    );
    // The permanent non-claims are unchanged; bundler behavior is explicitly
    // NOT evaluated. There is no dedicated bundler-IDENTITY code: this
    // boundary lives in this test + README, not in adapter semantics.
    expect(evaluation.nonClaims).toEqual(ERC4337_NON_CLAIMS);
    expect(evaluation.nonClaims).toContain("BUNDLER_BEHAVIOR_NOT_EVALUATED");
    const text = JSON.stringify(evaluation);
    expect(text).not.toMatch(/rundler|alchemy/i);
    expect(evaluation.claimLabel).not.toMatch(/BUNDLER/);
    // The bundle tx sender is never surfaced as a bundler attribution.
    expect(text).not.toContain(BUNDLE_TX_FROM);
  });

  it("is deterministic across repeated offline replay + assessment", async () => {
    const run = async (): Promise<string> => {
      const { fragment } = await replayFragment(raw);
      const evaluation = assessErc4337UserOperation(
        claim({ userOpHash: USER_OP_HASH, sender: SENDER }),
        fragment,
      );
      return JSON.stringify(evaluation);
    };
    expect(await run()).toBe(await run());
  });
});
