/**
 * Pinned adapter-local claim verdicts. Each case pins the EXACT native
 * adapter outcome (supported / contradicted / insufficient / ambiguous) and,
 * separately, the generic Core execution verdict of the source fragment. The
 * two are never derived from each other: a claim verdict is NOT a Core
 * NetworkEvidenceResult, and a missing/null observation is never contradicted.
 *
 * Path: resolveWithOptionalClaim over createMultichainTool behind a fake
 * provider (declared Base/Solana destinations only; global fetch throws).
 * Ethereum Sepolia (eip155:11155111) is NOT an MCP-served network, so
 * resolveWithOptionalClaim refuses it before any RPC (pinned below); the
 * resolver-evm Sepolia fixtures are therefore replayed unchanged through the
 * resolver's own replay and assessed by the SAME native adapter entry
 * (assessX402ExactPayment) that resolveWithOptionalClaim dispatches to. They
 * are never relabelled as a Base observation.
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assessX402ExactPayment,
  PROPOSITION_NAMESPACE as X402_NAMESPACE,
  X402_CLAIM_LABELS,
  X402_CONFLICT_CODES,
} from "@nec/adapter-x402";
import {
  ENTRY_POINT_PROFILES,
  ENTRY_POINT_V0_7_OBSERVED_ON_BASE,
  ERC4337_CLAIM_LABELS,
} from "@nec/adapter-erc4337";
import { evaluateTransactionAcquisition, replayTransactionAcquisition } from "@nec/resolver-evm";
import { createMultichainTool } from "../src/live-multichain.js";
import { resolveWithOptionalClaim } from "../src/live-claim.js";
import type { ClaimBoundObservation } from "../src/live-claim.js";

const json = (path: string): any => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const usdc = json("../../resolver-opstack/test/fixtures/base-mainnet-usdc-transfer.fixture.json");
const erc = json("../../adapter-erc4337/test/fixtures/base-mainnet-redeem-bundle.json");
const ercV06 = json("../../adapter-erc4337/test/fixtures/base-sepolia-external-v06-userop.json");
const sol = json("../../resolver-solana/test/fixtures/solana-mainnet-x402-real.json");
const sepoliaReverted = json("../../resolver-evm/test/fixtures/sepolia-reverted.json");
const sepoliaMissing = json("../../resolver-evm/test/fixtures/sepolia-missing-receipt.json");

const EVM = "eip155:8453" as const, BASE_SEPOLIA = "eip155:84532" as const;
const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" as const;
const SEPOLIA = "eip155:11155111";
const usdcSubject = { type: "transaction" as const, networkId: EVM, txId: usdc.subject.txHash as string };
const ercSubject = { type: "transaction" as const, networkId: EVM, txId: erc.subject.txHash as string };
const ercV06Subject = { type: "transaction" as const, networkId: BASE_SEPOLIA, txId: ercV06.subject.txHash as string };
const solSubject = { type: "transaction" as const, networkId: SOL, txId: sol.subject.signature as string };

// SYNTHETIC claimant requirement assembled for this test from a public USDC
// Transfer observation. It is NOT original x402 PaymentRequirements.
const x402Native = {
  requirement: {
    x402Version: "2", scheme: "exact", network: EVM,
    asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    payTo: "0x11f591c3496c0632e7b173184f5bc71dc941125d",
    amount: "1000",
  },
  paymentTxHash: usdcSubject.txId,
};
// SYNTHETIC claimant requirement for the SYNTHETIC resolver-evm Sepolia
// fixtures (placeholder tx/block/addresses). NOT original x402 terms and
// NOT a real chain observation.
const sepoliaX402 = (paymentTxHash: string) => ({
  requirement: {
    x402Version: "2", scheme: "exact", network: SEPOLIA,
    asset: `0x${"cc".repeat(20)}`,
    payTo: `0x${"bb".repeat(20)}`,
    amount: "1000",
  },
  paymentTxHash,
});
// SYNTHETIC claimant requirement; the contemporaneous x402 handshake
// artifacts were NOT recovered for this historical Solana transaction.
const svmNative = {
  requirement: {
    x402Version: 2, scheme: "exact", network: SOL,
    asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    payTo: "CNkB2jCHvnjF6zzmK2QeL9qEWBcq2oSq5t1DBnD59yJj",
    amount: "5000", maxTimeoutSeconds: 300,
    extra: { feePayer: "BENrLoUbndxoNMUS5JXApGMtNykLjFXXixMtpDwDR9SP" },
  },
  paymentSignature: solSubject.txId,
};
// Structured expectation copied from the pinned public on-chain
// UserOperationEvent of the Base mainnet redeem bundle.
const ercNative = {
  network: EVM, bundleTransactionHash: ercSubject.txId,
  entryPoint: ENTRY_POINT_V0_7_OBSERVED_ON_BASE,
  entryPointProfile: "v0.7",
  userOperation: {
    userOpHash: "0x94e3b302718e1f594c903cdb8237741c02edf12495cc78b34e30b9cfcfe5ae31",
    sender: "0xf64dd2892370f6d75aa1bd0f10da312235a06a1e",
  },
};
// userOpHash/sender copied from the on-chain UserOperationEvent (logIndex 0xe)
// of the public Base Sepolia fixture, which was emitted by EntryPoint v0.6.
const ercV06Op = {
  userOpHash: "0x5f1e12031272034de5460796bd5cabe903a8ee6845fcab5fde18c4de632acfcf",
  sender: "0xfef5b40ab4c543137262253dbaf7843bd9b3e5b6",
};

function fromCapture(fixture: any, method: string): unknown {
  const found = fixture.captures.find((c: any) => c.rpcMethod === method);
  if (!found) throw Error("unexpected RPC method " + method);
  return JSON.parse(found.resultJson);
}

/**
 * Fake provider. `baseNullReceipt` and `solanaNullTx` SIMULATE a source that
 * returns null for a real public subject; that is absence of observation at
 * this fake source, never an observation of non-existence on chain.
 */
function fakeSources(opts: { baseNullReceipt?: boolean; solanaNullTx?: boolean } = {}) {
  const methods: string[] = [];
  let activeBase: any = usdc;
  const fetchFn: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const q = JSON.parse(init?.body as string) as { method: string; id: number; params?: unknown[] };
    let result: unknown;
    if (url.includes("mainnet.base.org")) {
      if (opts.baseNullReceipt) {
        if (q.method === "eth_chainId") result = "0x2105";
        else if (q.method === "eth_getTransactionReceipt" || q.method === "eth_getTransactionByHash") result = null;
        else throw Error("unexpected RPC method " + q.method);
      } else {
        if (q.method === "eth_getTransactionReceipt") activeBase = String(q.params?.[0]) === ercSubject.txId ? erc : usdc;
        result = fromCapture(activeBase, q.method);
      }
    } else if (url.includes("sepolia.base.org")) {
      result = fromCapture(ercV06, q.method);
    } else if (url.includes("api.mainnet-beta.solana.com")) {
      if (opts.solanaNullTx && q.method === "getTransaction") result = null;
      else if (opts.solanaNullTx && q.method === "getSignatureStatuses") {
        const status = fromCapture(sol, q.method) as { value: unknown[] };
        status.value = [null];
        result = status;
      } else if (opts.solanaNullTx && q.method === "getBlock") throw Error("getBlock must not follow a null getTransaction");
      else result = fromCapture(sol, q.method);
    } else throw Error("not a declared fake RPC destination");
    methods.push(q.method);
    const response = new Response(JSON.stringify({ jsonrpc: "2.0", id: q.id, result }), {
      status: 200, headers: { "content-type": "application/json" },
    });
    Object.defineProperty(response, "url", { value: new URL(url).href });
    return response;
  };
  return { fetchFn, methods };
}

const evaluation = (out: ClaimBoundObservation): any => {
  expect(out.claimAssessment?.assessmentType).toBe("adapter_local_protocol_assessment");
  expect(out.claimAssessment?.evaluation.subjectMatchesClaim).toBe(true);
  return out.claimAssessment?.evaluation;
};
/** Generic Core execution verdict of the source fragment, read independently. */
const coreExecution = (fragment: unknown): unknown => (fragment as any).networkEvidence.execution.verdict;

const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async () => {
    throw new Error("network I/O is forbidden in live-claim-verdicts tests");
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("ERC-4337 pinned claim verdicts", () => {
  it("on-chain-copied userOp terms on the Base mainnet redeem bundle are supported; an absent userOpHash is insufficient", async () => {
    const p = fakeSources(), resolve = createMultichainTool(p.fetchFn);
    const out = await resolveWithOptionalClaim(resolve, { subject: ercSubject, claim: { protocol: "erc4337", claim: ercNative } });
    const ev = evaluation(out);
    expect(ev.outcome).toMatchObject({ applicability: "applicable", verdict: "supported", materialConflictIds: [] });
    expect(ev.claimLabel).toBe(ERC4337_CLAIM_LABELS.supportedUserOperationOnly);
    expect(ev.selectedUserOperation).toMatchObject({
      userOpHash: ercNative.userOperation.userOpHash, sender: ercNative.userOperation.sender,
      emitter: ENTRY_POINT_V0_7_OBSERVED_ON_BASE, success: true,
    });
    expect(ev.execution.verdict).toBe("supported");
    expect(coreExecution(out.fragment)).toBe("supported");
    expect(p.methods).toEqual(["eth_chainId", "eth_getTransactionReceipt", "eth_getBlockByHash", "eth_getTransactionByHash"]);

    const absent = await resolveWithOptionalClaim(resolve, { subject: ercSubject, claim: { protocol: "erc4337", claim: {
      ...ercNative, userOperation: { ...ercNative.userOperation, userOpHash: "0x" + "77".repeat(32) },
    } } });
    const ab = evaluation(absent);
    expect(ab.outcome).toMatchObject({ applicability: "applicable", verdict: "insufficient", materialConflictIds: [] });
    expect(ab.outcome.verdict).not.toBe("contradicted");
    expect(ab.claimLabel).toBe(ERC4337_CLAIM_LABELS.insufficient);
    expect(ab).not.toHaveProperty("selectedUserOperation");
    // Same usable EntryPoint candidates were inspected; none carries the hash.
    expect(ab.candidateCount).toBe(ev.candidateCount);
    expect(ab.candidateCount).toBeGreaterThan(0);
    // Core execution stays supported: bundle success != this UserOperation.
    expect(ab.execution.verdict).toBe("supported");
    expect(coreExecution(absent.fragment)).toBe("supported");
  });

  it("Base Sepolia v0.6 bundle versus the v0.7 profile: incoherent emitter rejected before RPC, coherent v0.7 claim insufficient", async () => {
    const p = fakeSources(), resolve = createMultichainTool(p.fetchFn);
    // v0.6 EntryPoint address declared under the v0.7 profile: native parser refuses.
    await expect(resolveWithOptionalClaim(resolve, { subject: ercV06Subject, claim: { protocol: "erc4337", claim: {
      network: BASE_SEPOLIA, bundleTransactionHash: ercV06Subject.txId,
      entryPoint: ENTRY_POINT_PROFILES["v0.6"], entryPointProfile: "v0.7", userOperation: ercV06Op,
    } } })).rejects.toMatchObject({ code: "MCP_CLAIM_INVALID" });
    expect(p.methods).toEqual([]);

    const out = await resolveWithOptionalClaim(resolve, { subject: ercV06Subject, claim: { protocol: "erc4337", claim: {
      network: BASE_SEPOLIA, bundleTransactionHash: ercV06Subject.txId,
      entryPoint: ENTRY_POINT_PROFILES["v0.7"], entryPointProfile: "v0.7", userOperation: ercV06Op,
    } } });
    const ev = evaluation(out);
    expect(ev.outcome).toMatchObject({ applicability: "applicable", verdict: "insufficient", materialConflictIds: [] });
    expect(ev.outcome.verdict).not.toBe("contradicted");
    // All seven UserOperationEvents were emitted by v0.6, not the claimed v0.7 EntryPoint.
    expect(ev.candidateCount).toBe(0);
    expect(ev.nonEntryEmitterCount).toBe(7);
    expect(ev).not.toHaveProperty("selectedUserOperation");
    expect(ev.execution.verdict).toBe("supported");
    expect(coreExecution(out.fragment)).toBe("supported");
    expect(p.methods).toEqual(["eth_chainId", "eth_getTransactionReceipt", "eth_getBlockByHash", "eth_getTransactionByHash"]);
  });
});

describe("x402 EVM pinned claim verdicts (SYNTHETIC terms)", () => {
  it("Ethereum Sepolia is refused by resolveWithOptionalClaim before any RPC", async () => {
    const p = fakeSources(), resolve = createMultichainTool(p.fetchFn);
    const subject = { type: "transaction", networkId: SEPOLIA, txId: sepoliaReverted.subject.txHash } as any;
    await expect(resolveWithOptionalClaim(resolve, { subject, claim: {
      protocol: "x402-evm", claim: sepoliaX402(sepoliaReverted.subject.txHash),
    } })).rejects.toMatchObject({ code: "MCP_CLAIM_INVALID" });
    await expect(resolve({ subject })).rejects.toMatchObject({ code: "MCP_MULTICHAIN_INPUT" });
    expect(p.methods).toEqual([]);
  });

  it("sepolia-reverted.json is contradicted; Core execution is contradicted", async () => {
    const fragment = evaluateTransactionAcquisition(await replayTransactionAcquisition(sepoliaReverted)).fragment;
    expect(fragment.subject).toEqual({ type: "transaction", networkId: SEPOLIA, txId: sepoliaReverted.subject.txHash });
    const ev = assessX402ExactPayment(sepoliaX402(sepoliaReverted.subject.txHash), fragment);
    expect(ev.subjectMatchesClaim).toBe(true);
    expect(ev.observedNetwork.matchedRequirement).toBe(true);
    expect(ev.outcome).toMatchObject({ applicability: "applicable", verdict: "contradicted", materialConflictIds: [] });
    expect(ev.claim).toBe(X402_CLAIM_LABELS.contradicted);
    expect(ev.candidateCount).toBe(0);
    expect(ev.execution.verdict).toBe("contradicted");
    expect(coreExecution(fragment)).toBe("contradicted");
  });

  it("sepolia-missing-receipt.json is insufficient, never contradicted; Core execution is insufficient", async () => {
    const fragment = evaluateTransactionAcquisition(await replayTransactionAcquisition(sepoliaMissing)).fragment;
    expect(fragment.subject).toEqual({ type: "transaction", networkId: SEPOLIA, txId: sepoliaMissing.subject.txHash });
    const ev = assessX402ExactPayment(sepoliaX402(sepoliaMissing.subject.txHash), fragment);
    expect(ev.subjectMatchesClaim).toBe(true);
    expect(ev.outcome).toMatchObject({ applicability: "applicable", verdict: "insufficient", materialConflictIds: [] });
    expect(ev.outcome.verdict).not.toBe("contradicted");
    expect(ev.claim).toBe(X402_CLAIM_LABELS.insufficient);
    expect(ev.execution.verdict).toBe("insufficient");
    expect(coreExecution(fragment)).toBe("insufficient");
  });

  it("a simulated null Base receipt through resolveWithOptionalClaim is insufficient, never contradicted", async () => {
    const p = fakeSources({ baseNullReceipt: true }), resolve = createMultichainTool(p.fetchFn);
    const out = await resolveWithOptionalClaim(resolve, { subject: usdcSubject, claim: { protocol: "x402-evm", claim: x402Native } });
    expect(out.acquisition.transactionObserved).toBe(false);
    const ev = evaluation(out);
    expect(ev.outcome).toMatchObject({ applicability: "applicable", verdict: "insufficient", materialConflictIds: [] });
    expect(ev.outcome.verdict).not.toBe("contradicted");
    expect(ev.execution.verdict).toBe("insufficient");
    expect(coreExecution(out.fragment)).toBe("insufficient");
    expect(p.methods).toEqual(["eth_chainId", "eth_getTransactionReceipt", "eth_getTransactionByHash"]);
  });

  it("wrong-amount terms on the real Base USDC transfer are ambiguous with the exact expectation conflict id", async () => {
    const p = fakeSources(), resolve = createMultichainTool(p.fetchFn);
    const matching = evaluation(await resolveWithOptionalClaim(resolve, { subject: usdcSubject, claim: { protocol: "x402-evm", claim: x402Native } }));
    expect(matching.outcome.verdict).toBe("supported");
    expect(matching.matchingTransfers).toHaveLength(1);
    const effectId = matching.matchingTransfers[0].effectId as string;

    const wrong = await resolveWithOptionalClaim(resolve, { subject: usdcSubject, claim: { protocol: "x402-evm", claim: {
      ...x402Native, requirement: { ...x402Native.requirement, amount: "2000" },
    } } });
    const ev = evaluation(wrong);
    const conflictId = `${X402_NAMESPACE}:${X402_CONFLICT_CODES.paymentExpectationMismatch}:${effectId}`;
    expect(ev.outcome).toMatchObject({ applicability: "applicable", verdict: "ambiguous" });
    expect(ev.claim).toBe(X402_CLAIM_LABELS.ambiguous);
    expect(ev.expectationConflictIds).toEqual([conflictId]);
    expect(ev.outcome.materialConflictIds).toContain(conflictId);
    expect(ev.matchingTransfers).toEqual([]);
    // Payee/amount mismatch never rewrites generic execution.
    expect(ev.execution.verdict).toBe("supported");
    expect(coreExecution(wrong.fragment)).toBe("supported");
  });
});

describe("x402 SVM pinned claim verdicts (SYNTHETIC terms)", () => {
  it("getTransaction null yields insufficient, never contradicted; Core execution is insufficient", async () => {
    const p = fakeSources({ solanaNullTx: true }), resolve = createMultichainTool(p.fetchFn);
    const out = await resolveWithOptionalClaim(resolve, { subject: solSubject, claim: { protocol: "x402-svm", claim: svmNative } });
    expect(out.acquisition.transactionObserved).toBe(false);
    const ev = evaluation(out);
    expect(ev.outcome).toMatchObject({ applicability: "applicable", verdict: "insufficient", materialConflictIds: [] });
    expect(ev.outcome.verdict).not.toBe("contradicted");
    expect(ev.settlementInferred).toBe(false);
    expect(ev.matchingTransfers).toEqual([]);
    expect(ev.execution.verdict).toBe("insufficient");
    expect(coreExecution(out.fragment)).toBe("insufficient");
    expect((out.fragment as any).networkEvidence.finality.verdict).not.toBe("supported");
    expect(p.methods).toEqual(["getGenesisHash", "getTransaction", "getSignatureStatuses"]);
  });
});
