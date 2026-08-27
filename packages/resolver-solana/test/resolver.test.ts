import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  acquireSolanaTransaction,
  evaluateSolanaTransaction,
  replaySolanaTransaction,
  TOKEN_2022_PROGRAM,
  validateSolanaAcquisitionFixture,
} from "../src/index.js";

const SIGNATURE = "4DYWUMExSrMNxYLjUuH9G8feN4fmYXm4ToCx7gGaAEjJRf2QNrE8LsvoFSGhXwQJrchhgrnGpUFwjxrci9PRLF71";
const NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const FULL_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const fixtureText = readFileSync(new URL("./fixtures/solana-mainnet-x402-real.json", import.meta.url), "utf8");
type MutableFixture = any;

function fixture(): MutableFixture { return JSON.parse(fixtureText); }
function capture(f: MutableFixture, method: string): MutableFixture {
  const found = f.captures.find((entry: MutableFixture) => entry.rpcMethod === method);
  if (!found) throw new Error(`missing ${method}`);
  return found;
}
function result(f: MutableFixture, method: string): MutableFixture { return JSON.parse(capture(f, method).resultJson); }
function setResult(f: MutableFixture, method: string, value: unknown): void { capture(f, method).resultJson = JSON.stringify(value); }
function parts(f = fixture()) {
  const tx = result(f, "getTransaction");
  const transaction = tx.transaction;
  const message = transaction.message;
  const meta = tx.meta;
  return { f, tx, message, meta, instructions: message.instructions as MutableFixture[], keys: message.accountKeys as string[] };
}
function transferIndex(p: ReturnType<typeof parts>): number {
  const programIndex = p.keys.indexOf("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  return p.instructions.findIndex((instruction) => instruction.programIdIndex === programIndex);
}

describe("real mainnet fixture", () => {
  it("replays with zero network calls and repeated replay is deep-equal", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error("poisoned"))) as typeof fetch;
    try {
      const a = await replaySolanaTransaction(fixture());
      const b = await replaySolanaTransaction(fixture());
      expect(a).toEqual(b);
      expect(a.genesisHash).toBe(FULL_GENESIS);
      expect(a.source.networkId).toBe(NETWORK);
      expect(a.subject.signature).toBe(SIGNATURE);
      expect(a.transaction?.slot).toBe(418897974n);
      expect(a.transaction?.successful).toBe(true);
      expect(a.signatureStatus.value?.confirmationStatus).toBe("finalized");
      expect(a.block?.blockhash).toBe("5n9NnMBpvH2SVjG4rfdZNFQaHUuKejeK4wXcdmEKG9LV");
      expect(a.consistent).toBe(true);
    } finally { globalThis.fetch = original; }
  });

  it("proves execution, finalized slot/block binding, and one exact TransferChecked", async () => {
    const out = evaluateSolanaTransaction(await replaySolanaTransaction(fixture())).fragment;
    expect(out.subject).toEqual({ type: "transaction", networkId: NETWORK, txId: SIGNATURE });
    expect(out.network).toMatchObject({ networkId: NETWORK, genesisId: FULL_GENESIS, observedAt: { blockNumber: 418897974n, blockId: "5n9NnMBpvH2SVjG4rfdZNFQaHUuKejeK4wXcdmEKG9LV" } });
    expect(out.networkEvidence.execution?.verdict).toBe("supported");
    expect(out.networkEvidence.finality?.verdict).toBe("supported");
    expect(out.networkEvidence.settlement).toBeUndefined();
    expect(out.networkEvidence.observedEffects).toHaveLength(1);
    expect(out.networkEvidence.observedEffects?.[0]?.fields).toMatchObject({
      tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      source: "DMJ2By4ZCnStePpyt82gYMNYbsur1iE1YmVG2GmEdU6x",
      destination: "3pkdujCUZ9GWXe8V3cG2wWygBMB57xCHt6nFmWw5zzdz",
      authority: "5Quv32NFLRPvZGtuGrT9AGasz6U8x29jF6kxLCeFznrz",
      amount: "5000", decimals: 6,
      location: { kind: "topLevel", topLevelIndex: 2, stackHeight: 1 },
      transactionSignature: SIGNATURE,
    });
  });

  it("fixture is ordered, endpoint-free, credential-free, and private-path-free", () => {
    const valid = validateSolanaAcquisitionFixture(fixture());
    expect(valid.captures.map((entry) => entry.rpcMethod)).toEqual(["getGenesisHash", "getTransaction", "getSignatureStatuses", "getBlock"]);
    const text = JSON.stringify(valid);
    expect(text).not.toMatch(/https?:\/\//i);
    expect(text).not.toMatch(/api[_-]?key|access[_-]?token|authorization|credential|secret|\/home\/|\/Users\//i);
  });
});

describe("strict acquisition and decoding", () => {
  it("rejects malformed base58 signature", async () => {
    const f = fixture(); f.subject.signature = "not-a-signature";
    await expect(replaySolanaTransaction(f)).rejects.toMatchObject({ code: "SOLANA_INPUT_INVALID" });
  });
  it("rejects configured network / getGenesisHash mismatch", async () => {
    const f = fixture(); setResult(f, "getGenesisHash", "11111111111111111111111111111111");
    await expect(replaySolanaTransaction(f)).rejects.toMatchObject({ code: "SOLANA_NETWORK_MISMATCH" });
  });
  it("preserves getTransaction null plus missing signature status", async () => {
    const f = fixture(); setResult(f, "getTransaction", null);
    const status = result(f, "getSignatureStatuses"); status.value[0] = null; setResult(f, "getSignatureStatuses", status); f.captures.pop();
    const a = await replaySolanaTransaction(f);
    expect(a.transaction).toBeNull(); expect(a.signatureStatus.value).toBeNull();
    expect(evaluateSolanaTransaction(a).fragment.networkEvidence.execution?.verdict).toBe("insufficient");
  });
  it.each([
    ["malformed envelope", "not-json", "SOLANA_MALFORMED_RESPONSE"],
    ["RPC error", '{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"no"}}', "SOLANA_RPC_ERROR_RESPONSE"],
  ])("rejects %s", async (_name, body, code) => {
    await expect(acquireSolanaTransaction({
      source: { sourceId: "scripted", sourceType: "svm_rpc", networkId: NETWORK, transport: { url: "https://example.invalid" } },
      signature: SIGNATURE, now: "2026-08-26T00:00:00.000Z",
      fetchFn: async () => new Response(body, { status: 200 }),
    })).rejects.toMatchObject({ code });
  });
  it("supports a synthetic legacy transaction and top-level TransferChecked", async () => {
    const p = parts(); p.tx.version = "legacy"; delete p.message.addressTableLookups; delete p.meta.loadedAddresses; setResult(p.f, "getTransaction", p.tx);
    const a = await replaySolanaTransaction(p.f);
    expect(a.transaction?.version).toBe("legacy"); expect(a.transaction?.transferChecked[0]?.location.kind).toBe("topLevel");
  });
  it("supports v0 with loaded writable and readonly addresses", async () => {
    const p = parts(); p.tx.version = 0;
    p.message.addressTableLookups = [{ accountKey: p.keys[1], writableIndexes: [0], readonlyIndexes: [1] }];
    p.meta.loadedAddresses = { writable: [p.keys[2]], readonly: [p.keys[3]] };
    p.instructions.push({ programIdIndex: 0, accounts: [p.keys.length, p.keys.length + 1], data: "" });
    setResult(p.f, "getTransaction", p.tx);
    const a = await replaySolanaTransaction(p.f);
    expect(a.transaction?.version).toBe(0); expect(a.transaction?.effectiveAccountKeys).toHaveLength(p.keys.length + 2);
  });
  it("fails closed for unresolved ALT-derived account space", async () => {
    const p = parts(); p.tx.version = 0;
    p.message.addressTableLookups = [{ accountKey: p.keys[1], writableIndexes: [0], readonlyIndexes: [] }]; delete p.meta.loadedAddresses;
    setResult(p.f, "getTransaction", p.tx);
    await expect(replaySolanaTransaction(p.f)).rejects.toMatchObject({ code: "SOLANA_INCOMPLETE_ACCOUNT_KEYS" });
  });
  it("rejects unsupported transaction version", async () => {
    const p = parts(); p.tx.version = 1; setResult(p.f, "getTransaction", p.tx);
    await expect(replaySolanaTransaction(p.f)).rejects.toMatchObject({ code: "SOLANA_UNSUPPORTED_TRANSACTION_VERSION" });
  });
  it.each(["account", "program"])("rejects %s index out of range", async (kind) => {
    const p = parts(); if (kind === "account") p.instructions[0].accounts = [p.keys.length]; else p.instructions[0].programIdIndex = p.keys.length;
    setResult(p.f, "getTransaction", p.tx);
    await expect(replaySolanaTransaction(p.f)).rejects.toMatchObject({ code: "SOLANA_MALFORMED_RESPONSE" });
  });
  it("rejects malformed relevant instruction data", async () => {
    const p = parts(); p.instructions[transferIndex(p)].data = "D"; setResult(p.f, "getTransaction", p.tx);
    await expect(replaySolanaTransaction(p.f)).rejects.toMatchObject({ code: "SOLANA_MALFORMED_RESPONSE" });
  });
  it("decodes CPI TransferChecked and preserves location/stack height", async () => {
    const p = parts(); const [transfer] = p.instructions.splice(transferIndex(p), 1);
    p.meta.innerInstructions = [{ index: 0, instructions: [{ ...transfer, stackHeight: 2 }] }]; setResult(p.f, "getTransaction", p.tx);
    expect((await replaySolanaTransaction(p.f)).transaction?.transferChecked[0]?.location).toEqual({ kind: "inner", parentTopLevelIndex: 0, innerIndex: 0, stackHeight: 2 });
  });
  it("recognizes Token-2022 TransferChecked", async () => {
    const p = parts(); p.keys[p.keys.indexOf("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")] = TOKEN_2022_PROGRAM; setResult(p.f, "getTransaction", p.tx);
    expect((await replaySolanaTransaction(p.f)).transaction?.transferChecked[0]?.tokenProgram).toBe(TOKEN_2022_PROGRAM);
  });
  it("failed transaction containing TransferChecked emits no positive effect", async () => {
    const p = parts(); p.meta.err = { InstructionError: [2, "Custom"] }; setResult(p.f, "getTransaction", p.tx);
    const status = result(p.f, "getSignatureStatuses"); status.value[0].err = p.meta.err; setResult(p.f, "getSignatureStatuses", status);
    const out = evaluateSolanaTransaction(await replaySolanaTransaction(p.f)).fragment;
    expect(out.networkEvidence.execution?.verdict).toBe("contradicted"); expect(out.networkEvidence.observedEffects).toEqual([]);
  });
  it("successful transaction without TransferChecked emits no effect", async () => {
    const p = parts(); p.instructions.splice(transferIndex(p), 1); setResult(p.f, "getTransaction", p.tx);
    expect(evaluateSolanaTransaction(await replaySolanaTransaction(p.f)).fragment.networkEvidence.observedEffects).toEqual([]);
  });
  it.each(["processed", "confirmed"])("does not equate %s with finalized", async (confirmationStatus) => {
    const f = fixture(); const status = result(f, "getSignatureStatuses"); status.value[0].confirmationStatus = confirmationStatus; setResult(f, "getSignatureStatuses", status);
    expect(evaluateSolanaTransaction(await replaySolanaTransaction(f)).fragment.networkEvidence.finality?.verdict).toBe("insufficient");
  });
  it("supports mutually consistent finalized observations", async () => {
    expect(evaluateSolanaTransaction(await replaySolanaTransaction(fixture())).fragment.networkEvidence.finality?.verdict).toBe("supported");
  });
  it("surfaces transaction/status error disagreement", async () => {
    const f = fixture(); const status = result(f, "getSignatureStatuses"); status.value[0].err = { Different: true }; setResult(f, "getSignatureStatuses", status);
    const out = evaluateSolanaTransaction(await replaySolanaTransaction(f)).fragment;
    expect(out.conflicts.some((c) => c.code === "STATUS_ERROR_MATCHES_TRANSACTION")).toBe(true); expect(out.networkEvidence.execution?.verdict).toBe("ambiguous");
  });
  it("surfaces slot/block disagreement", async () => {
    const f = fixture(); const block = result(f, "getBlock"); block.parentSlot = 418897974; setResult(f, "getBlock", block);
    const out = evaluateSolanaTransaction(await replaySolanaTransaction(f)).fragment;
    expect(out.conflicts.some((c) => c.code === "BLOCK_PARENT_PRECEDES_SLOT")).toBe(true); expect(out.networkEvidence.finality?.verdict).toBe("ambiguous");
  });
});

describe("fixture replay boundary", () => {
  it("rejects unmatched requests", async () => {
    const f = fixture(); capture(f, "getBlock").rpcMethod = "getBlocks";
    await expect(replaySolanaTransaction(f)).rejects.toMatchObject({ code: "SOLANA_REPLAY_UNMATCHED_REQUEST" });
  });
  it("rejects unused captures", async () => {
    const f = fixture(); setResult(f, "getTransaction", null);
    await expect(replaySolanaTransaction(f)).rejects.toMatchObject({ code: "SOLANA_REPLAY_UNUSED_CAPTURES" });
  });
  it("rejects endpoint, credential, and private metadata leakage", () => {
    for (const leaked of ["https://rpc.example", "api_key=abc", "/home/alice/private.json"]) {
      const f = fixture(); f.source.sourceId = leaked; expect(() => validateSolanaAcquisitionFixture(f)).toThrow();
    }
  });
});

describe("CPI trace completeness", () => {
  it.each(["null", "absent"])("does not infer a complete CPI trace when innerInstructions is %s", async (kind) => {
    const p = parts();
    if (kind === "null") p.meta.innerInstructions = null; else delete p.meta.innerInstructions;
    setResult(p.f, "getTransaction", p.tx);
    const acquisition = await replaySolanaTransaction(p.f);
    expect(acquisition.transaction?.instructionTraceComplete).toBe(false);
    expect(evaluateSolanaTransaction(acquisition).fragment.networkEvidence.dataBinding?.metadata?.instructionTraceComplete).toBe(false);
  });
  it("treats an explicit empty innerInstructions array as a complete-empty trace", async () => {
    const p = parts(); p.meta.innerInstructions = []; setResult(p.f, "getTransaction", p.tx);
    const acquisition = await replaySolanaTransaction(p.f);
    expect(acquisition.transaction?.instructionTraceComplete).toBe(true);
    expect(evaluateSolanaTransaction(acquisition).fragment.networkEvidence.dataBinding?.metadata?.instructionTraceComplete).toBe(true);
  });
});
