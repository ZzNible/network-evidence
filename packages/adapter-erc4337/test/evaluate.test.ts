import { describe, expect, it } from "vitest";

import {
  buildEvidenceSnapshot,
  buildNetworkEvidenceResult,
  computeEvidencePolicyDigest,
  computeResolverManifestDigest,
} from "@nec/core";
import type {
  EvidencePolicy,
  EvidenceRequest,
  NetworkEvidenceResult,
  ObservedEffect,
  ResolverManifest,
} from "@nec/core";

import {
  assessErc4337UserOperation,
  ERC4337_CLAIM_LABELS,
  ERC4337_NON_CLAIMS,
  ERC4337_WARNING_CODES,
  evaluateErc4337Bundle,
  EXPECTED_EFFECT_KIND_ERC1155_BURN,
  NecAdapterErc4337Error,
  ZERO_ADDRESS,
} from "../src/index.js";
import {
  buildFragment,
  CREDITS_CONTRACT,
  ENTRY_POINT,
  NETWORK_ID,
  OTHER_ACCOUNT,
  OTHER_CONTRACT,
  OTHER_USER_OP_HASH,
  SENDER,
  TOKEN_ID,
  transferSingleEffect,
  TX,
  unrelatedEffect,
  userOpEventEffect,
  USER_OP_HASH,
  BURN_VALUE,
} from "./helpers.js";

const CLAIM = {
  network: NETWORK_ID,
  bundleTransactionHash: TX,
  entryPoint: ENTRY_POINT,
  entryPointProfile: "v0.7",
  userOperation: { userOpHash: USER_OP_HASH, sender: SENDER },
};

const CLAIM_NO_HASH = {
  network: NETWORK_ID,
  bundleTransactionHash: TX,
  entryPoint: ENTRY_POINT,
  entryPointProfile: "v0.7",
  userOperation: { sender: SENDER },
};

const BURN = {
  kind: EXPECTED_EFFECT_KIND_ERC1155_BURN,
  contract: CREDITS_CONTRACT,
  from: SENDER,
  tokenId: TOKEN_ID,
  value: BURN_VALUE,
};

describe("assessErc4337UserOperation — supported paths", () => {
  it("supports an exact successful UserOperation inside the bound bundle", () => {
    const fragment = buildFragment({
      effects: [userOpEventEffect("uop")],
    });
    const evaluation = assessErc4337UserOperation(CLAIM, fragment);
    expect(evaluation.outcome.verdict).toBe("supported");
    expect(evaluation.subjectMatchesClaim).toBe(true);
    expect(evaluation.selectedUserOperation?.userOpHash).toBe(USER_OP_HASH);
    expect(evaluation.claimLabel).toBe(ERC4337_CLAIM_LABELS.supported);
  });

  it("supports op + exact burn when both are observed", () => {
    const fragment = buildFragment({
      effects: [userOpEventEffect("uop"), transferSingleEffect("burn"), unrelatedEffect("noise")],
    });
    const evaluation = assessErc4337UserOperation({ ...CLAIM, expectedEffect: BURN }, fragment);
    expect(evaluation.outcome.verdict).toBe("supported");
    expect(evaluation.matchingBurns).toHaveLength(1);
    expect(evaluation.unrelatedEffectCount).toBe(1);
  });

  it("selects by sender when no userOpHash is supplied", () => {
    const fragment = buildFragment({ effects: [userOpEventEffect("uop")] });
    const evaluation = assessErc4337UserOperation(CLAIM_NO_HASH, fragment);
    expect(evaluation.outcome.verdict).toBe("supported");
    expect(evaluation.selectedUserOperation?.sender).toBe(SENDER);
  });
});

describe("bundle vs UserOperation separation (invariants)", () => {
  it("(1) receipt success + no UserOperationEvent is INSUFFICIENT, never supported", () => {
    const fragment = buildFragment({ effects: [unrelatedEffect("n1"), transferSingleEffect("t1")] });
    const evaluation = assessErc4337UserOperation(CLAIM, fragment);
    expect(evaluation.outcome.verdict).toBe("insufficient");
    expect(evaluation.execution.verdict).toBe("supported"); // bundle executed
    expect(
      evaluation.warnings.some((w) => w.code === ERC4337_WARNING_CODES.noUserOperationEventObserved),
    ).toBe(true);
  });

  it("(2) two UserOperations: selecting one cannot borrow the other's success", () => {
    const failedOther = userOpEventEffect("uop-other", {
      userOpHash: OTHER_USER_OP_HASH,
      sender: OTHER_ACCOUNT,
      success: false,
    });
    const mine = userOpEventEffect("uop-mine");
    const fragment = buildFragment({ effects: [mine, failedOther] });
    // The bundle receipt is a success; the OTHER op failed. My op must stay supported.
    const good = assessErc4337UserOperation(CLAIM, fragment);
    expect(good.outcome.verdict).toBe("supported");
    expect(good.selectedUserOperation?.effectId).toBe(mine.id);

    // Expecting the FAILED op contradicts even though the bundle succeeded.
    const bad = assessErc4337UserOperation(
      { ...CLAIM, userOperation: { userOpHash: OTHER_USER_OP_HASH, sender: OTHER_ACCOUNT } },
      fragment,
    );
    expect(bad.outcome.verdict).toBe("contradicted");
    expect(bad.selectedUserOperationFailure?.reason).toBe("userOperationFailed");
  });

  it("(3) userOpHash mismatch is not ignored", () => {
    const fragment = buildFragment({ effects: [userOpEventEffect("uop")] }); // hash USER_OP_HASH
    const evaluation = assessErc4337UserOperation(
      { ...CLAIM, userOperation: { userOpHash: `0x${"11".repeat(32)}`, sender: SENDER } },
      fragment,
    );
    expect(evaluation.outcome.verdict).toBe("insufficient");
    expect(evaluation.selectedUserOperation).toBeUndefined();
  });

  it("(4) sender mismatch on the hash-selected event is not ignored (contradicted)", () => {
    const fragment = buildFragment({
      effects: [userOpEventEffect("uop", { sender: OTHER_ACCOUNT })],
    });
    const evaluation = assessErc4337UserOperation(CLAIM, fragment);
    expect(evaluation.outcome.verdict).toBe("contradicted");
    expect(evaluation.selectedUserOperationFailure?.reason).toBe("senderMismatch");
  });

  it("(5) selected event success=false overrides bundle receipt success", () => {
    const fragment = buildFragment({
      effects: [userOpEventEffect("uop", { success: false })],
      executionDim: { verdict: "supported" }, // explicit successful receipt
    });
    const evaluation = assessErc4337UserOperation(CLAIM, fragment);
    expect(evaluation.outcome.verdict).toBe("contradicted");
    expect(evaluation.selectedUserOperationFailure?.reason).toBe("userOperationFailed");
    expect(evaluation.execution.verdict).toBe("supported"); // reported separately, unchanged
  });

  it("(6) unrelated UserOperationEvents do not break an exactly identified target", () => {
    const strangerA = userOpEventEffect("stranger-a", {
      userOpHash: `0x${"aa".repeat(32)}`,
      sender: OTHER_ACCOUNT,
    });
    const strangerB = userOpEventEffect("stranger-b", {
      userOpHash: `0x${"bb".repeat(32)}`,
      sender: `0x${"c9".repeat(20)}`,
    });
    const mine = userOpEventEffect("mine");
    const fragment = buildFragment({ effects: [strangerA, mine, strangerB] });
    const evaluation = assessErc4337UserOperation(CLAIM, fragment);
    expect(evaluation.outcome.verdict).toBe("supported");
    expect(evaluation.candidateCount).toBe(3);
  });

  it("(7) duplicate exact candidates fail closed as ambiguous (no first-match)", () => {
    const a = userOpEventEffect("dup-a");
    const b = userOpEventEffect("dup-b"); // identical identity fields
    const fragment = buildFragment({ effects: [a, b] });
    const withHash = assessErc4337UserOperation(CLAIM, fragment);
    expect(withHash.outcome.verdict).toBe("ambiguous");
    expect(withHash.outcome.materialConflictIds.some((id) => id.includes("DUPLICATE_EXACT"))).toBe(true);
    expect(withHash.selectedUserOperation).toBeUndefined();

    const noHash = assessErc4337UserOperation(CLAIM_NO_HASH, fragment);
    expect(noHash.outcome.verdict).toBe("ambiguous");
  });
});

describe("ERC-1155 burn correlation", () => {
  function fragmentWith(effects: readonly ObservedEffect[]) {
    return buildFragment({ effects });
  }

  it("wrong contract never satisfies nor refutes (insufficient)", () => {
    const fragment = fragmentWith([
      userOpEventEffect("uop"),
      transferSingleEffect("burn", { contract: OTHER_CONTRACT }),
    ]);
    const evaluation = assessErc4337UserOperation({ ...CLAIM, expectedEffect: BURN }, fragment);
    expect(evaluation.outcome.verdict).toBe("insufficient");
    expect(evaluation.matchingBurns).toHaveLength(0);
  });

  it("another account's burn never satisfies the expectation (insufficient)", () => {
    const fragment = fragmentWith([
      userOpEventEffect("uop"),
      transferSingleEffect("burn", { from: OTHER_ACCOUNT }),
    ]);
    const evaluation = assessErc4337UserOperation({ ...CLAIM, expectedEffect: BURN }, fragment);
    expect(evaluation.outcome.verdict).toBe("insufficient");
  });

  it("nonzero `to` (transfer, not burn) is insufficiency, never satisfaction", () => {
    const fragment = fragmentWith([
      userOpEventEffect("uop"),
      transferSingleEffect("xfer", { to: OTHER_ACCOUNT }),
    ]);
    const evaluation = assessErc4337UserOperation({ ...CLAIM, expectedEffect: BURN }, fragment);
    expect(evaluation.outcome.verdict).toBe("insufficient");
  });

  it("same account/contract burn with wrong tokenId contradicts the exact expectation", () => {
    const fragment = fragmentWith([
      userOpEventEffect("uop"),
      transferSingleEffect("burn", { tokenId: "999" }),
    ]);
    const evaluation = assessErc4337UserOperation({ ...CLAIM, expectedEffect: BURN }, fragment);
    expect(evaluation.outcome.verdict).toBe("contradicted");
    expect(evaluation.conflictingBurns[0]?.violations).toEqual(["tokenId:999"]);
  });

  it("same account/contract burn with wrong value contradicts the exact expectation", () => {
    const fragment = fragmentWith([
      userOpEventEffect("uop"),
      transferSingleEffect("burn", { value: "2" }),
    ]);
    const evaluation = assessErc4337UserOperation({ ...CLAIM, expectedEffect: BURN }, fragment);
    expect(evaluation.outcome.verdict).toBe("contradicted");
    expect(evaluation.conflictingBurns[0]?.violations).toEqual(["value:2"]);
  });

  it("a mint (from == zero -> account) is NEVER classified as burn", () => {
    const mint = transferSingleEffect("mint", { from: ZERO_ADDRESS, to: SENDER });
    const fragment = fragmentWith([userOpEventEffect("uop"), mint]);
    const evaluation = assessErc4337UserOperation({ ...CLAIM, expectedEffect: BURN }, fragment);
    expect(evaluation.outcome.verdict).toBe("insufficient");
    expect(evaluation.matchingBurns).toHaveLength(0);
    // The mint on the expected contract is explicitly surfaced as mint
    // semantics — never silently ignored, never treated as a burn.
    expect(
      evaluation.warnings.some((w) => w.code === ERC4337_WARNING_CODES.erc1155MintIsNotBurn),
    ).toBe(true);
  });

  it("unrelated TransferSingle beside a valid exact burn does not break support", () => {
    const otherBurn = transferSingleEffect("other-burn", {
      contract: OTHER_CONTRACT,
      tokenId: "5",
      value: "50",
    });
    const exactBurn = transferSingleEffect("exact-burn");
    const fragment = fragmentWith([userOpEventEffect("uop"), otherBurn, exactBurn]);
    const evaluation = assessErc4337UserOperation({ ...CLAIM, expectedEffect: BURN }, fragment);
    expect(evaluation.outcome.verdict).toBe("supported");
    expect(evaluation.transferSingleCandidateCount).toBe(2);
    expect(evaluation.matchingBurns.map((b) => b.effectId)).toEqual(["exact-burn"]);
  });

  it("duplicate exact burns fail closed as ambiguous (material conflict, never first-match)", () => {
    const b1 = transferSingleEffect("b1");
    const b2 = transferSingleEffect("b2");
    const fragment = fragmentWith([userOpEventEffect("uop"), b1, b2]);
    const evaluation = assessErc4337UserOperation({ ...CLAIM, expectedEffect: BURN }, fragment);
    expect(evaluation.outcome.verdict).toBe("ambiguous");
    // Both exact burns are still reported, but the combined proposition is a
    // material conflict, not a positive assertion.
    expect(evaluation.matchingBurns).toHaveLength(2);
    expect(
      evaluation.outcome.materialConflictIds.some((id) => id.includes("DUPLICATE_EXACT_BURNS")),
    ).toBe(true);
    expect(
      evaluation.warnings.some((w) => w.code === ERC4337_WARNING_CODES.duplicateExactBurns),
    ).toBe(true);
    expect(evaluation.nonClaims).toContain("DOUBLE_EXECUTION_RISK_NOT_ADDRESSED");
  });

  it("missing expected burn yields insufficient even when the op matched", () => {
    const fragment = fragmentWith([userOpEventEffect("uop")]);
    const evaluation = assessErc4337UserOperation({ ...CLAIM, expectedEffect: BURN }, fragment);
    expect(evaluation.outcome.verdict).toBe("insufficient");
  });

  it("malformed relevant TransferSingle fails closed to ambiguous (never clean absence)", () => {
    const malformed = transferSingleEffect("bad", { dataOverride: `0x${"ab".repeat(120)}` });
    const fragment = fragmentWith([userOpEventEffect("uop"), malformed]);
    const evaluation = assessErc4337UserOperation({ ...CLAIM, expectedEffect: BURN }, fragment);
    expect(evaluation.outcome.verdict).toBe("ambiguous");
    expect(
      evaluation.outcome.materialConflictIds.some((id) => id.includes("MALFORMED_TRANSFER_SINGLE")),
    ).toBe(true);
  });

  it("removed TransferSingle matching the target is excluded, never positive evidence", () => {
    const removedExact = transferSingleEffect("removed", { removed: true });
    const fragment = fragmentWith([userOpEventEffect("uop"), removedExact]);
    const evaluation = assessErc4337UserOperation({ ...CLAIM, expectedEffect: BURN }, fragment);
    expect(evaluation.outcome.verdict).toBe("insufficient");
    expect(evaluation.matchingBurns).toHaveLength(0);
  });
});

function ZERO_ADDR(): string {
  return ZERO_ADDRESS;
}

describe("binding, emitters and intake", () => {
  it("subject mismatch under matched network is ambiguous via conflict", () => {
    const fragment = buildFragment({
      subject: { type: "transaction", networkId: NETWORK_ID, txId: `0x${"99".repeat(32)}` },
      effects: [userOpEventEffect("uop")],
    });
    const evaluation = assessErc4337UserOperation(CLAIM, fragment);
    expect(evaluation.outcome.verdict).toBe("ambiguous");
    expect(evaluation.subjectMatchesClaim).toBe(false);
  });

  it("network mismatch is a clean contradiction", () => {
    const fragment = buildFragment({
      networkId: "eip155:84532",
      effects: [userOpEventEffect("uop")],
    });
    const evaluation = assessErc4337UserOperation(CLAIM, fragment);
    expect(evaluation.outcome.verdict).toBe("contradicted");
    expect(evaluation.observedNetwork.matchedRequirement).toBe(false);
  });

  it("events emitted by a non-claimed EntryPoint are never candidates", () => {
    const fake = userOpEventEffect("fake", { emitter: `0x${"e5".repeat(20)}` });
    const fragment = buildFragment({ effects: [fake] });
    const evaluation = assessErc4337UserOperation(CLAIM, fragment);
    expect(evaluation.outcome.verdict).toBe("insufficient");
    expect(evaluation.nonEntryEmitterCount).toBe(1);
    expect(evaluation.candidateCount).toBe(0);
  });

  it("observation bound to another transaction is excluded + conflicted", () => {
    const foreignTx = `0x${"64".repeat(32)}`;
    const effect = userOpEventEffect("foreign", { transactionHash: foreignTx });
    const fragment = buildFragment({ effects: [effect] });
    const evaluation = assessErc4337UserOperation(CLAIM, fragment);
    expect(evaluation.outcome.verdict).toBe("ambiguous");
    expect(evaluation.transactionHashMismatches[0]?.observedTransactionHash).toBe(foreignTx);
  });

  it("absent execution dimension stays unproven (insufficient, never positive)", () => {
    const fragment = buildFragment({ omitExecution: true, effects: [userOpEventEffect("uop")] });
    const evaluation = assessErc4337UserOperation(CLAIM, fragment);
    expect(evaluation.outcome.applicability).toBe("applicable");
    expect(evaluation.outcome.verdict).toBe("insufficient");
    expect(evaluation.execution.providedByFragment).toBe(false);
    expect(
      evaluation.warnings.some((w) => w.code === ERC4337_WARNING_CODES.executionDimensionAbsent),
    ).toBe(true);
  });

  it("unknown execution dimension poisons the whole proposition to unknown", () => {
    const fragment = buildFragment({
      effects: [userOpEventEffect("uop")],
      executionDim: { applicability: "unknown", verdict: undefined },
    });
    const evaluation = assessErc4337UserOperation(CLAIM, fragment);
    expect(evaluation.outcome.applicability).toBe("unknown");
    expect(evaluation.outcome.verdict).toBeUndefined();
  });

  it("invalid claim or invalid fragment throws controlled errors (no degraded verdict)", () => {
    const fragment = buildFragment({ effects: [userOpEventEffect("uop")] });
    expect(() =>
      assessErc4337UserOperation(
        { ...CLAIM, entryPoint: "not-an-address" },
        fragment,
      ),
    ).toThrow(NecAdapterErc4337Error);
    const broken = buildFragment({ effects: [userOpEventEffect("uop")] });
    (broken.networkEvidence.execution as unknown as Record<string, unknown>)["applicability"] =
      "nonsense";
    expect(() => assessErc4337UserOperation(CLAIM, broken)).toThrow();
  });

  it("every assessment carries the permanent non-claims and finality warning", () => {
    const fragment = buildFragment({ effects: [userOpEventEffect("uop")] });
    const evaluation = assessErc4337UserOperation(CLAIM, fragment);
    expect(evaluation.nonClaims).toEqual(ERC4337_NON_CLAIMS);
    expect(evaluation.nonClaims).toContain("L2_BLOCK_FINALITY_NOT_ESTABLISHED");
    expect(evaluation.nonClaims).toContain("WITHDRAWAL_FINALIZATION_NOT_ESTABLISHED");
    expect(
      evaluation.warnings.some((w) => w.code === ERC4337_WARNING_CODES.finalityNotEstablished),
    ).toBe(true);
  });

  it("is deterministic across repeated assessment", () => {
    const fragment = buildFragment({
      effects: [userOpEventEffect("uop"), transferSingleEffect("burn"), unrelatedEffect("n")],
    });
    const claim = { ...CLAIM, expectedEffect: BURN };
    expect(canonicalShape(assessErc4337UserOperation(claim, fragment))).toEqual(
      canonicalShape(assessErc4337UserOperation(claim, fragment)),
    );
    function canonicalShape(evaluation: ReturnType<typeof assessErc4337UserOperation>) {
      return JSON.stringify(
        { outcome: evaluation.outcome, warnings: evaluation.warnings, candidates: evaluation.candidateCount },
        null,
        0,
      );
    }
  });
});

describe("compatibility wrapper over NetworkEvidenceResult", () => {
  function resultArtifact(base: ReturnType<typeof buildFragment>): NetworkEvidenceResult {
    const policyContent = {
      id: "erc4337-basic",
      version: "1",
      requiredDimensions: ["execution", "observedEffects"] as import("@nec/core").PolicyDimension[],
      desiredDimensions: ["finality"] as import("@nec/core").PolicyDimension[],
    };
    const policy = { ...policyContent, digest: computeEvidencePolicyDigest(policyContent) } as EvidencePolicy;
    const manifestContent = {
      id: "resolver-evm",
      version: "0.1.0",
      networkFamilies: ["eip155"],
      implementation: { package: "@nec/resolver-evm" },
      supportedCapabilities: [
        "execution",
        "observedEffects",
        "dataBinding",
        "executionModel",
      ] as import("@nec/core").CapabilityName[],
      sourceRequirements: [{ sourceType: "evm_rpc", required: true }],
    };
    const manifest = {
      ...manifestContent,
      digest: computeResolverManifestDigest(manifestContent),
    } as ResolverManifest;
    const snapshot = buildEvidenceSnapshot(
      {
        id: "snap_1",
        createdAt: "2026-01-01T00:00:00.000Z",
        networkFingerprint: base.network,
        anchors: [
          {
            networkId: base.network.networkId,
            blockNumber: base.network.observedAt.blockNumber,
            timestamp: "2026-01-01T00:00:00.000Z",
            role: "execution_observation",
          },
        ],
        evidence: [...base.evidence],
        resolverManifestDigest: manifest.digest,
        policyDigest: policy.digest,
      },
      { policy, resolver: manifest },
    );
    const request: EvidenceRequest = {
      schemaVersion: "0.1",
      requestId: "req_erc4337_test",
      networkId: base.network.networkId,
      subject: base.subject,
      action: { kind: "erc4337.userOperation", target: ENTRY_POINT, value: "0" },
      evidencePolicy: policy,
    };
    return buildNetworkEvidenceResult(
      {
        schemaVersion: "0.1",
        requestId: request.requestId,
        generatedAt: "2026-01-02T12:30:00.000Z",
        network: base.network,
        subject: base.subject,
        action: request.action,
        policy: { id: policy.id, version: policy.version, digest: policy.digest },
        snapshot: { id: snapshot.id, digest: snapshot.digest },
        networkEvidence: {
          execution: base.networkEvidence.execution!,
          dataBinding: { applicability: "unknown", basis: [], evidence: [] },
          observedEffects: [...(base.networkEvidence.observedEffects ?? [])],
          settlement: { applicability: "unknown", basis: [], evidence: [] },
          finality: { applicability: "unknown", basis: [], evidence: [] },
        },
        evidence: [...base.evidence],
        conflicts: [...base.conflicts],
        warnings: [],
        resolver: { id: manifest.id, version: manifest.version, digest: manifest.digest },
      },
      { policy, snapshot, resolver: manifest, request },
    );
  }

  it("evaluates a complete result artifact through the same internal path", () => {
    const fragment = buildFragment({ effects: [userOpEventEffect("uop")] });
    const viaResult = evaluateErc4337Bundle(CLAIM, resultArtifact(fragment));
    const viaFragment = assessErc4337UserOperation(CLAIM, fragment);
    expect(viaResult.outcome.verdict).toBe("supported");
    expect(viaResult.outcome).toEqual(viaFragment.outcome);
  });

  it("result subject binding works identically through the wrapper", () => {
    const evaluation = evaluateErc4337Bundle(
      { ...CLAIM, expectedEffect: BURN },
      resultArtifact(buildFragment({ effects: [userOpEventEffect("uop"), transferSingleEffect("burn")] })),
    );
    expect(evaluation.outcome.verdict).toBe("supported");
    expect(evaluation.subjectMatchesClaim).toBe(true);
    expect(evaluation.matchingBurns).toHaveLength(1);
  });
});
