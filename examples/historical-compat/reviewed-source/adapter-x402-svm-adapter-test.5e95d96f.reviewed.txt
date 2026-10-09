import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import type { NetworkEvidenceFragment, ObservedEffect } from "@nec/core";
import {
  encodeBase58,
  evaluateSolanaTransaction,
  replaySolanaTransaction,
  SPL_TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
} from "@nec/resolver-solana";
import {
  assessX402SvmExactPayment,
  buildX402SvmCorrelation,
  deriveAssociatedTokenAddress,
  findProgramAddress,
  parseX402SvmExactRequirement,
  X402_SVM_NON_CLAIMS,
} from "../src/index.js";

const SIGNATURE = "4DYWUMExSrMNxYLjUuH9G8feN4fmYXm4ToCx7gGaAEjJRf2QNrE8LsvoFSGhXwQJrchhgrnGpUFwjxrci9PRLF71";
const NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PAY_TO = "CNkB2jCHvnjF6zzmK2QeL9qEWBcq2oSq5t1DBnD59yJj";
const FEE_PAYER = "BENrLoUbndxoNMUS5JXApGMtNykLjFXXixMtpDwDR9SP";
const SOURCE = "DMJ2By4ZCnStePpyt82gYMNYbsur1iE1YmVG2GmEdU6x";
const AUTHORITY = "5Quv32NFLRPvZGtuGrT9AGasz6U8x29jF6kxLCeFznrz";
const DESTINATION = "3pkdujCUZ9GWXe8V3cG2wWygBMB57xCHt6nFmWw5zzdz";
const fixtureText = readFileSync(new URL("../../resolver-solana/test/fixtures/solana-mainnet-x402-real.json", import.meta.url), "utf8");
let base: NetworkEvidenceFragment;

function requirement(overrides: Record<string, unknown> = {}) {
  return { x402Version: 2, scheme: "exact", network: NETWORK, asset: MINT, payTo: PAY_TO, amount: "5000", maxTimeoutSeconds: 300, extra: { feePayer: FEE_PAYER }, ...overrides };
}
function claim(requirementOverrides: Record<string, unknown> = {}, paymentSignature = SIGNATURE) {
  return { requirement: requirement(requirementOverrides), paymentSignature };
}
function clone(): any { return structuredClone(base); }
function realEffect(fragment: any): any { return fragment.networkEvidence.observedEffects[0]; }
function effect(overrides: Record<string, unknown> = {}, id = "effect-test"): ObservedEffect {
  const f = clone(); const original = realEffect(f);
  return { ...original, id, fields: { ...original.fields, ...overrides } };
}
function withIncompleteTrace(effects: ObservedEffect[] = [effect()]): any { const f = withEffects(effects); f.networkEvidence.dataBinding.metadata.instructionTraceComplete = false; return f; }
function withConflicts(conflicts: any[]): any {
  const f = clone(); f.conflicts = conflicts;
  for (const conflict of conflicts) {
    if (conflict.scope.kind === "dimension") f.networkEvidence[conflict.scope.dimension].verdict = "ambiguous";
  }
  return f;
}
function materialConflict(id: string, scope: Record<string, unknown>): any { return { id, code: id.toUpperCase().replace(/-/g, "_"), description: id, scope, evidence: [base.evidence[0]!.id], material: true }; }
function withEffects(effects: ObservedEffect[]): any { const f = clone(); f.networkEvidence.observedEffects = effects; return f; }
function assess(fragment: NetworkEvidenceFragment, requirementOverrides: Record<string, unknown> = {}, paymentSignature = SIGNATURE) {
  return assessX402SvmExactPayment(fragment, claim(requirementOverrides, paymentSignature));
}

beforeAll(async () => {
  base = evaluateSolanaTransaction(await replaySolanaTransaction(JSON.parse(fixtureText))).fragment;
});

describe("requirement, transaction binding, and canonical ATA", () => {
  it("normalizes x402 v2 exact SVM and preserves construction hints as context", () => {
    expect(parseX402SvmExactRequirement({ ...requirement(), extra: { feePayer: FEE_PAYER, memo: "invoice-1", recentBlockhash: MINT, lastValidBlockHeight: "291470237" } })).toMatchObject({ x402Version: "2", scheme: "exact", network: NETWORK, amount: "5000", extra: { feePayer: FEE_PAYER, memo: "invoice-1" } });
  });
  it("derives the canonical mainnet ATA known vector", () => {
    // Independently verified once with @solana/spl-token getAssociatedTokenAddressSync.
    expect(deriveAssociatedTokenAddress(PAY_TO, MINT, SPL_TOKEN_PROGRAM)).toBe(DESTINATION);
  });
  it("matches an independently sourced fixed Token-2022 ATA vector", () => {
    // Independently verified once with @solana/spl-token getAssociatedTokenAddressSync.
    expect(deriveAssociatedTokenAddress(PAY_TO, MINT, TOKEN_2022_PROGRAM)).toBe("9uET91v4qsqkN6WJTwDKxbaPKses2nqrNynv3B9ieP9X");
  });
  it.each([
    ["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d", false],
    [`solana:${NETWORK.slice("solana:".length, -1)}`, false],
    [`${NETWORK}1`, false],
    ["solana:00000000000000000000000000000000", false],
    [NETWORK, true],
  ])("enforces canonical 32-character Solana CAIP references", (network, accepted) => {
    if (accepted) expect(parseX402SvmExactRequirement(requirement({ network }))).toMatchObject({ network });
    else expect(() => parseX402SvmExactRequirement(requirement({ network }))).toThrow("network must carry exactly 32 canonical base58 characters");
  });
  it("allows 15 caller PDA seeds and rejects 16 because the bump is a seed", () => {
    expect(findProgramAddress(Array.from({ length: 15 }, () => new Uint8Array()), SPL_TOKEN_PROGRAM).address).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
    expect(() => findProgramAddress(Array.from({ length: 16 }, () => new Uint8Array()), SPL_TOKEN_PROGRAM)).toThrow("PDA seeds exceed Solana limits");
  });
  it("binds exact normalized requirement and exact signature into frozen NEC surfaces", () => {
    const correlation = buildX402SvmCorrelation(claim());
    expect(correlation.subject).toEqual({ type: "transaction", networkId: NETWORK, txId: SIGNATURE });
    expect(correlation.action).toMatchObject({ kind: "x402.svm.payment", target: PAY_TO, value: "5000", fields: { asset: MINT, feePayer: FEE_PAYER } });
  });
  it("rejects generic TransferChecked interpretation without a supplied x402 requirement", () => {
    expect(() => assessX402SvmExactPayment(base, { paymentSignature: SIGNATURE })).toThrow();
  });
});

describe("amount, exactly-one, program, and trace semantics", () => {
  it("supports the exact required amount", () => { expect(assess(base).outcome.verdict).toBe("supported"); });
  it("supports one overpayment under amount >= required", () => { expect(assess(base, { amount: "4999" }).outcome.verdict).toBe("supported"); });
  it("contradicts underpayment", () => { expect(assess(base, { amount: "5001" }).outcome.verdict).toBe("contradicted"); });
  it("supports the zero-amount boundary when one qualifying transfer exists", () => { expect(assess(base, { amount: "0" }).outcome.verdict).toBe("supported"); });
  it("contradicts zero qualifying transfers with complete usable evidence", () => { expect(assess(withEffects([])).outcome.verdict).toBe("contradicted"); });
  it("fails closed and exposes two qualifying transfers deterministically", () => {
    const a = effect({ location: { kind: "topLevel", topLevelIndex: 8 } }, "effect-z");
    const b = effect({ location: { kind: "inner", parentTopLevelIndex: 1, innerIndex: 2, stackHeight: 2 } }, "effect-a");
    const first = assess(withEffects([a, b])); const second = assess(withEffects([b, a]));
    expect(first.outcome.verdict).toBe("ambiguous");
    expect(first.matchingTransfers.map((entry) => entry.effectId)).toEqual(["effect-z", "effect-a"]);
    expect(second.matchingTransfers.map((entry) => entry.effectId)).toEqual(first.matchingTransfers.map((entry) => entry.effectId));
  });
  it("never aggregates split underpayments", () => {
    const a = effect({ amount: "2500", location: { kind: "topLevel", topLevelIndex: 3 } }, "split-a");
    const b = effect({ amount: "2500", location: { kind: "topLevel", topLevelIndex: 4 } }, "split-b");
    const out = assess(withEffects([a, b])); expect(out.qualifyingCandidateCount).toBe(0); expect(out.outcome.verdict).toBe("contradicted");
  });
  it("right mint / wrong destination does not qualify", () => { expect(assess(withEffects([effect({ destination: SOURCE })])).outcome.verdict).toBe("contradicted"); });
  it("right destination / wrong mint does not qualify", () => { expect(assess(withEffects([effect({ mint: SOURCE })])).outcome.verdict).toBe("contradicted"); });
  it("wrong token program fails closed", () => { expect(assess(withEffects([effect({ tokenProgram: "11111111111111111111111111111111" })])).outcome.verdict).toBe("ambiguous"); });
  it("supports canonical SPL Token", () => { expect(assess(base).matchingTransfers[0]?.tokenProgram).toBe(SPL_TOKEN_PROGRAM); });
  it("supports canonical Token-2022 with its own ATA derivation", () => {
    const destination = deriveAssociatedTokenAddress(PAY_TO, MINT, TOKEN_2022_PROGRAM);
    const out = assess(withEffects([effect({ tokenProgram: TOKEN_2022_PROGRAM, destination })]));
    expect(out.outcome.verdict).toBe("supported"); expect(out.matchingTransfers[0]?.tokenProgram).toBe(TOKEN_2022_PROGRAM);
  });
  it("supports top-level and CPI locations", () => {
    expect(assess(base).outcome.verdict).toBe("supported");
    expect(assess(withEffects([effect({ location: { kind: "inner", parentTopLevelIndex: 0, innerIndex: 1, stackHeight: 2 } })])).outcome.verdict).toBe("supported");
  });
  it("additional unrelated effects do not invalidate one payment", () => {
    const unrelated: ObservedEffect = { id: "unrelated", type: "solana.program.effect", fields: { program: "memo" }, basis: ["source_observation"], evidence: [base.evidence[0]!.id] };
    expect(assess(withEffects([effect({}, "payment"), unrelated])).outcome.verdict).toBe("supported");
  });
});

describe("fee payer, authority, execution, finality, and hostile evidence", () => {
  it("supports smart-wallet CPI with authority != feePayer and source != feePayer", () => {
    const out = assess(withEffects([effect({ location: { kind: "inner", parentTopLevelIndex: 1, innerIndex: 0, stackHeight: 3 }, authority: AUTHORITY, source: SOURCE })]));
    expect(out.outcome.verdict).toBe("supported"); expect(out.matchingTransfers[0]?.authority).not.toBe(FEE_PAYER); expect(out.matchingTransfers[0]?.source).not.toBe(FEE_PAYER);
  });
  it("feePayer == payTo remains inert context", () => {
    const out = assessX402SvmExactPayment(base, claim({ extra: { feePayer: PAY_TO } })); expect(out.outcome.verdict).toBe("supported");
  });
  it("malformed relevant effect is a material fail-closed conflict", () => {
    const out = assess(withEffects([effect({ amount: "05" })])); expect(out.outcome.verdict).toBe("ambiguous"); expect(out.excludedCandidates).toHaveLength(1);
  });
  it("failed execution cannot be laundered by a matching-looking transfer", () => {
    const f = clone(); f.networkEvidence.execution.verdict = "contradicted";
    const out = assess(f); expect(out.outcome.verdict).toBe("contradicted"); expect(out.claim).not.toContain("ONE_OBSERVED");
  });
  it("finalized transaction plus wrong payment remains invalid", () => {
    const out = assess(withEffects([effect({ destination: SOURCE })])); expect(out.networkFinality.verdict).toBe("supported"); expect(out.outcome.verdict).toBe("contradicted");
  });
  it("subject signature mismatch fails closed", () => {
    const other = encodeBase58(new Uint8Array(64).fill(7)); const out = assess(base, {}, other);
    expect(out.subjectMatchesClaim).toBe(false); expect(out.outcome.verdict).toBe("ambiguous");
  });
  it("effect signature mismatch fails closed", () => {
    const other = encodeBase58(new Uint8Array(64).fill(9)); const out = assess(withEffects([effect({ transactionSignature: other })]));
    expect(out.outcome.verdict).toBe("ambiguous");
  });
  it("network mismatch fails closed", () => {
    const f = clone(); f.network.networkId = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"; f.subject.networkId = f.network.networkId;
    const out = assess(f); expect(out.subjectMatchesClaim).toBe(false); expect(out.outcome.verdict).toBe("ambiguous");
  });
  it("never infers settlement and preserves permanent non-claims", () => {
    const out = assess(base); expect(out.settlementInferred).toBe(false); expect(out.nonClaims).toEqual(X402_SVM_NON_CLAIMS); expect(out.networkFinality.verdict).toBe("supported");
  });
  it("preserves the current-challenge / historical-transaction caveat", () => {
    const out = assessX402SvmExactPayment(base, claim(), { correlationStrength: "STRONG_BUT_ONE_FIELD_MISSING" });
    expect(out.correlation).toEqual({ strength: "STRONG_BUT_ONE_FIELD_MISSING", historicalPaymentRequirementsPublic: false, historicalPaymentPayloadPublic: false, historicalSettlementResponsePublic: false });
    expect(out.outcome.verdict).toBe("supported");
  });
});

describe("trace completeness and resolver conflict propagation", () => {
  it("incomplete trace with zero observed matches is insufficient, never contradicted", () => {
    expect(assess(withIncompleteTrace([])).outcome.verdict).toBe("insufficient");
  });
  it("incomplete trace with one top-level qualifying match is insufficient, never supported", () => {
    expect(assess(withIncompleteTrace()).outcome.verdict).toBe("insufficient");
  });
  it("an explicit complete-empty CPI trace allows one top-level qualifying match to support", () => {
    expect(assess(base).outcome.verdict).toBe("supported");
  });
  it("incomplete trace with two directly observed qualifying matches is ambiguous", () => {
    expect(assess(withIncompleteTrace([effect({}, "trace-a"), effect({ location: { kind: "topLevel", topLevelIndex: 9 } }, "trace-b")])).outcome.verdict).toBe("ambiguous");
  });
  it("payment-relevant dataBinding and execution conflicts prevent support", () => {
    for (const scope of [{ kind: "dimension", dimension: "dataBinding" }, { kind: "dimension", dimension: "execution" }]) {
      expect(assess(withConflicts([materialConflict(`conflict-${scope.dimension}`, scope)])).outcome.verdict).not.toBe("supported");
    }
  });
  it("a conflict attached to a relied-upon matching effect prevents support", () => {
    const id = base.networkEvidence.observedEffects![0]!.id;
    expect(assess(withConflicts([materialConflict("conflict-effect", { kind: "observed_effect", effectId: id })])).outcome.verdict).not.toBe("supported");
  });
  it("a finality-only conflict leaves payment independent while finality reflects it", () => {
    const out = assess(withConflicts([materialConflict("conflict-finality", { kind: "dimension", dimension: "finality" })]));
    expect(out.outcome.verdict).toBe("supported");
    expect(out.networkFinality.verdict).toBe("ambiguous");
  });
  it("conflict input order leaves outcome and reported conflict ids identical", () => {
    const first = materialConflict("conflict-a", { kind: "dimension", dimension: "dataBinding" });
    const second = materialConflict("conflict-b", { kind: "dimension", dimension: "execution" });
    const a = assess(withConflicts([first, second])); const b = assess(withConflicts([second, first]));
    expect(b.outcome).toEqual(a.outcome);
    expect(b.conflicts.map((conflict) => conflict.id)).toEqual(a.conflicts.map((conflict) => conflict.id));
  });
});
