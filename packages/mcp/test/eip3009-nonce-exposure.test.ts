/**
 * H-c1 reproduction (test-only): the EXISTING generic EVM replay+evaluate
 * path already exposes the EIP-3009 `AuthorizationUsed(address,bytes32)`
 * nonce as topics[2] of a generic `evm.log` observed effect. No Core,
 * resolver or adapter change; adapter-x402 is used only for its keccak.
 *
 * Real capture only: resolver-opstack base-mainnet-usdc-transfer.fixture.json
 * (Base mainnet USDC, tx 0xcf496b…5afb, captured 2026-08-24), replayed
 * verbatim. This is an AFTER observation of a past transaction. It is NOT a
 * pre-execution anchor: no preflight preimage is known for this nonce, so
 * fixedBeforeExecution stays false and nothing is anchored. Exposure of a
 * 32-byte value != commitment to any request or policy.
 *
 * Negative: the real Solana mainnet fixture yields no `evm.log` effect, so
 * anchor (c) is not applicable there. No network I/O: global fetch throws.
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeNecWireJson, encodeNecWireJson, isDigest } from "@nec/core";
import type { NetworkEvidenceFragment, ObservedEffect } from "@nec/core";
import { ERC20_TRANSFER_EVENT_TOPIC, keccak256Hex, utf8Bytes } from "@nec/adapter-x402";
import { evaluateTransactionAcquisition, replayTransactionAcquisition } from "@nec/resolver-evm";
import { evaluateSolanaTransaction, replaySolanaTransaction } from "@nec/resolver-solana";

const json = (path: string): any => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const usdc = json("../../resolver-opstack/test/fixtures/base-mainnet-usdc-transfer.fixture.json");
const sol = json("../../resolver-solana/test/fixtures/solana-mainnet-x402-real.json");

const TX = "0xcf496bca417f033e3ce5ad167e82a5bf95b2d815e4493de2f4943d3058b85afb";
// topics[2] as recorded in the receipt capture's resultJson bytes.
const RECORDED_NONCE = "0x4a0189886fa9ad178790263a6625c1fdb1fd08a65671298ba6146dbb8584d0cd";
const AUTHORIZATION_USED_TOPIC = "0x" + keccak256Hex(utf8Bytes("AuthorizationUsed(address,bytes32)"));
// No preflight PreflightResult (or any other artifact) predating this
// transaction is known whose artifactDigest equals this nonce.
const FIXED_BEFORE_EXECUTION = false;

const effectsOf = (fragment: NetworkEvidenceFragment): ObservedEffect[] =>
  fragment.networkEvidence.observedEffects ?? [];
const topicsOf = (effect: ObservedEffect): string[] => effect.fields.topics as string[];
const authorizationUsed = (fragment: NetworkEvidenceFragment): ObservedEffect[] =>
  effectsOf(fragment).filter(e => e.type === "evm.log" && topicsOf(e)[0] === AUTHORIZATION_USED_TOPIC);
function collectKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const v of value) collectKeys(v, out);
  else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) { out.push(k); collectKeys(v, out); }
  }
  return out;
}

let fetchCalls = 0;
const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async () => {
    fetchCalls++;
    throw new Error("network I/O is forbidden in eip3009-nonce-exposure tests");
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("EIP-3009 AuthorizationUsed nonce exposure on a real Base mainnet USDC capture", () => {
  it("topic0 identity is computed, not recalled: exactly one recorded log carries keccak('AuthorizationUsed(address,bytes32)')", () => {
    // Self-check of the same keccak against the adapter's pinned Transfer topic.
    expect("0x" + keccak256Hex(utf8Bytes("Transfer(address,address,uint256)"))).toBe(ERC20_TRANSFER_EVENT_TOPIC);
    expect(AUTHORIZATION_USED_TOPIC).toMatch(/^0x[0-9a-f]{64}$/);

    expect(usdc.subject.txHash).toBe(TX);
    expect(usdc.source).toMatchObject({ networkId: "eip155:8453", chainId: 8453 });
    const receiptCaptures = usdc.captures.filter((c: any) => c.rpcMethod === "eth_getTransactionReceipt");
    expect(receiptCaptures).toHaveLength(1);
    const logs = JSON.parse(receiptCaptures[0].resultJson).logs as { topics: string[] }[];
    const matching = logs.filter(l => l.topics[0] === AUTHORIZATION_USED_TOPIC);
    expect(matching, "H-c1: recorded topic0 equals keccak256('AuthorizationUsed(address,bytes32)')").toHaveLength(1);
    expect(fetchCalls).toBe(0);
  });

  it("replay + evaluate exposes the nonce as topics[2] of one generic evm.log effect citing the receipt; wire round-trip keeps it; nothing is anchored", async () => {
    const acquisition = await replayTransactionAcquisition(usdc, { includeTransaction: true });
    const evaluation = evaluateTransactionAcquisition(acquisition);
    const fragment = evaluation.fragment;
    expect(fragment.subject).toEqual({ type: "transaction", networkId: "eip155:8453", txId: TX });
    expect(evaluation.observedEffects).toEqual(effectsOf(fragment));

    const found = authorizationUsed(fragment);
    expect(found).toHaveLength(1);
    const effect = found[0] as ObservedEffect;
    expect(effect.type).toBe("evm.log");
    expect(effect.fields.address).toBe("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
    expect(effect.fields.data).toBe("0x");
    expect(effect.fields.transactionHash).toBe(TX);
    const topics = topicsOf(effect);
    expect(topics).toHaveLength(3);
    expect(topics[0]).toBe(AUTHORIZATION_USED_TOPIC);
    expect(topics[1]).toMatch(/^0x0{24}[0-9a-f]{40}$/);
    const nonce = topics[2] as string;
    expect(nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(nonce).toBe(RECORDED_NONCE);

    // The effect cites exactly the receipt capture's evidence ref.
    const receiptRefs = fragment.evidence.filter(r => r.metadata?.rpcMethod === "eth_getTransactionReceipt");
    expect(receiptRefs).toHaveLength(1);
    expect(receiptRefs[0]?.locator).toBe(`eth_getTransactionReceipt:${JSON.stringify(TX)}`);
    expect(effect.evidence).toEqual([receiptRefs[0]?.id]);
    expect(effect.basis).toEqual(["source_observation"]);

    // What the hosted AFTER envelope carries: JSON.parse(encodeNecWireJson(fragment)).
    const wire = encodeNecWireJson("network-evidence-fragment", fragment);
    const decoded = decodeNecWireJson("network-evidence-fragment", wire);
    expect(authorizationUsed(decoded)).toEqual([effect]);
    const hosted = JSON.parse(wire) as NetworkEvidenceFragment;
    expect(authorizationUsed(hosted)).toEqual([effect]);

    // Width-only: 32 bytes fit the Core digest shape. That is NOT a match
    // against any preimage: no preflight preimage is known for this nonce,
    // so fixedBeforeExecution is false and nothing is anchored.
    const widthOnly = "sha256:" + nonce.slice(2);
    expect(isDigest(widthOnly), "width-only: nonce fits sha256:<64 hex>; NOT a preimage match").toBe(true);
    expect(FIXED_BEFORE_EXECUTION, "no preflight preimage known for this nonce: fixedBeforeExecution false, nothing anchored").toBe(false);
    // The AFTER fragment itself carries no preflight reference and no Core
    // digest equal to the nonce.
    expect(collectKeys(hosted).filter(k => /preflight/i.test(k))).toEqual([]);
    expect(wire).not.toContain(widthOnly);
    expect(fetchCalls).toBe(0);
  });

  it("negative: the real Solana mainnet fixture fragment has no evm.log effect, so anchor (c) is not applicable there", async () => {
    const fragment = evaluateSolanaTransaction(await replaySolanaTransaction(sol)).fragment;
    expect(fragment.subject).toMatchObject({ type: "transaction", txId: sol.subject.signature });
    const effects = effectsOf(fragment);
    expect(effects.length).toBeGreaterThan(0);
    expect(effects.filter(e => e.type === "evm.log")).toEqual([]);
    expect(authorizationUsed(fragment)).toEqual([]);
    expect(fetchCalls).toBe(0);
  });
});
