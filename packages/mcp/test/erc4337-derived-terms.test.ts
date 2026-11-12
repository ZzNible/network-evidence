/**
 * ERC-4337 matching-term independence on the pinned Base mainnet redeem
 * bundle (adapter-erc4337/test/fixtures/base-mainnet-redeem-bundle.json).
 *
 * The claim terms are DERIVED, not copied from the UserOperationEvent: the
 * test ABI-decodes handleOps(PackedUserOperation[],address) from the
 * eth_getTransactionByHash capture `input` ONLY (never the receipt or its
 * logs) and recomputes the EntryPoint v0.7 userOpHash with the adapter's
 * exported keccak256/keccak256Hex. The derived terms are same-transaction
 * calldata, not an external prior artifact; they are assessed through
 * resolveWithOptionalClaim.
 *
 * The resolver reads the real captures, served verbatim (exact resultJson
 * bytes) for the exact recorded method and params on the fixed Base mainnet
 * origin; anything else throws, and global fetch throws.
 *
 * Out of scope here: a wrong sender (already pinned as contradicted in
 * adapter-erc4337/test/fixture-real.test.ts).
 */
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  ENTRY_POINT_PROFILES,
  ENTRY_POINT_V0_7_OBSERVED_ON_BASE,
  ERC4337_CLAIM_LABELS,
  keccak256,
  keccak256Hex,
  utf8Bytes,
} from "@nec/adapter-erc4337";
import { exchangeIdentityKey } from "@nec/resolver-evm";
import { createMultichainTool } from "../src/live-multichain.js";
import { resolveWithOptionalClaim } from "../src/live-claim.js";
import type { ClaimBoundObservation } from "../src/live-claim.js";

interface Capture { rpcMethod: string; rpcParams: unknown[]; httpStatus: number; resultJson: string }
const FIXTURE = JSON.parse(readFileSync(
  new URL("../../adapter-erc4337/test/fixtures/base-mainnet-redeem-bundle.json", import.meta.url), "utf8",
)) as { subject: { txHash: string }; captures: Capture[] };

const BASE_ID = "eip155:8453" as const;
const BASE_URL = "https://mainnet.base.org/";
const SUBJECT = { type: "transaction", networkId: BASE_ID, txId: FIXTURE.subject.txHash } as const;

/** The only derivation input: the eth_getTransactionByHash capture. */
const TX = JSON.parse(FIXTURE.captures.find(c => c.rpcMethod === "eth_getTransactionByHash")!.resultJson) as
  { hash: string; to: string; chainId: string; input: string };

const HANDLE_OPS_SIGNATURE = "handleOps((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes)[],address)";
/** Expected values (the event's), used only as assertions, never as claim terms. */
const EXPECTED_USER_OP_HASH = "0x94e3b302718e1f594c903cdb8237741c02edf12495cc78b34e30b9cfcfe5ae31";
const EXPECTED_SENDER = "0xf64dd2892370f6d75aa1bd0f10da312235a06a1e";

function hexToBytes(hex: string): Uint8Array {
  const body = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (body.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(body)) throw Error("malformed hex");
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(body.slice(2 * i, 2 * i + 2), 16);
  return out;
}
const bytesToHex = (bytes: Uint8Array): string => "0x" + [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}
/** abi.encode of one uint256 (or a left-padded address). */
function word(value: bigint): Uint8Array {
  if (value < 0n || value >= 1n << 256n) throw Error("word out of range");
  return hexToBytes(value.toString(16).padStart(64, "0"));
}

/** ABI reader over the handleOps arguments (calldata after the selector), bounds-checked. */
function reader(args: Uint8Array) {
  const raw = (at: number): Uint8Array => {
    if (!Number.isSafeInteger(at) || at < 0 || at + 32 > args.length) throw Error("ABI word out of bounds");
    return args.slice(at, at + 32);
  };
  const uint = (at: number): bigint => BigInt(bytesToHex(raw(at)));
  const offset = (at: number): number => {
    const value = uint(at);
    if (value >= BigInt(args.length)) throw Error("ABI offset out of bounds");
    return Number(value);
  };
  const address = (at: number): string => {
    const bytes = raw(at);
    if (bytes.slice(0, 12).some(b => b !== 0)) throw Error("dirty address word");
    return bytesToHex(bytes.slice(12));
  };
  const bytes = (at: number): Uint8Array => {
    const length = offset(at);
    if (at + 32 + length > args.length) throw Error("ABI bytes out of bounds");
    return args.slice(at + 32, at + 32 + length);
  };
  return { raw, uint, offset, address, bytes };
}

interface PackedUserOperation {
  sender: string; nonce: bigint; initCode: Uint8Array; callData: Uint8Array; accountGasLimits: Uint8Array;
  preVerificationGas: bigint; gasFees: Uint8Array; paymasterAndData: Uint8Array; signature: Uint8Array;
}

/** handleOps(PackedUserOperation[] ops, address beneficiary) decoded from raw calldata. */
function decodeHandleOps(input: string): { selector: string; ops: PackedUserOperation[] } {
  const data = hexToBytes(input);
  const selector = bytesToHex(data.slice(0, 4));
  const r = reader(data.slice(4));
  const array = r.offset(0);
  const count = r.offset(array);
  const heads = array + 32;
  const ops: PackedUserOperation[] = [];
  for (let i = 0; i < count; i++) {
    // Tuple-internal offsets are relative to the tuple start.
    const op = heads + r.offset(heads + 32 * i);
    ops.push({
      sender: r.address(op),
      nonce: r.uint(op + 32),
      initCode: r.bytes(op + r.offset(op + 64)),
      callData: r.bytes(op + r.offset(op + 96)),
      accountGasLimits: r.raw(op + 128),
      preVerificationGas: r.uint(op + 160),
      gasFees: r.raw(op + 192),
      paymasterAndData: r.bytes(op + r.offset(op + 224)),
      signature: r.bytes(op + r.offset(op + 256)),
    });
  }
  return { selector, ops };
}

/**
 * EntryPoint v0.7 getUserOpHash:
 * keccak256(abi.encode(keccak256(abi.encode(sender, nonce, keccak(initCode), keccak(callData),
 *   accountGasLimits, preVerificationGas, gasFees, keccak(paymasterAndData))), entryPoint, chainId)).
 */
function userOpHashV07(op: PackedUserOperation, entryPoint: string, chainId: bigint): string {
  const packed = keccak256(concat(
    word(BigInt(op.sender)), word(op.nonce), keccak256(op.initCode), keccak256(op.callData),
    op.accountGasLimits, word(op.preVerificationGas), op.gasFees, keccak256(op.paymasterAndData),
  ));
  return "0x" + keccak256Hex(concat(packed, word(BigInt(entryPoint)), word(chainId)));
}

/** Real captures served verbatim for the exact recorded method and params; anything else throws. */
function provider() {
  const queues = new Map<string, Capture[]>();
  for (const capture of FIXTURE.captures) {
    const key = exchangeIdentityKey(capture.rpcMethod, capture.rpcParams);
    queues.set(key, [...(queues.get(key) ?? []), capture]);
  }
  const methods: string[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).href;
    if (url !== BASE_URL || init?.method !== "POST") throw Error("Unapproved fake endpoint");
    const query = JSON.parse(init?.body as string) as { id: number; method: string; params?: unknown[] };
    const key = exchangeIdentityKey(query.method, query.params ?? []);
    const capture = queues.get(key)?.shift();
    if (capture === undefined) throw Error(`Unexpected mock request ${key}`);
    methods.push(query.method);
    const response = new Response(`{"jsonrpc":"2.0","id":${JSON.stringify(query.id)},"result":${capture.resultJson}}`, {
      status: capture.httpStatus, headers: { "content-type": "application/json" },
    });
    Object.defineProperty(response, "url", { value: url });
    return response;
  };
  const unused = () => [...queues.values()].reduce((n, queue) => n + queue.length, 0);
  return { fetchFn, methods, unused };
}

async function assess(claim: Record<string, unknown>): Promise<ClaimBoundObservation> {
  const source = provider();
  const out = await resolveWithOptionalClaim(createMultichainTool(source.fetchFn), {
    subject: SUBJECT, claim: { protocol: "erc4337", claim },
  });
  expect(source.methods).toEqual(["eth_chainId", "eth_getTransactionReceipt", "eth_getBlockByHash", "eth_getTransactionByHash"]);
  expect(source.unused()).toBe(0);
  return out;
}
const evaluation = (out: ClaimBoundObservation): any => {
  expect(out.claimAssessment?.assessmentType).toBe("adapter_local_protocol_assessment");
  expect(out.claimAssessment?.evaluation.subjectMatchesClaim).toBe(true);
  return out.claimAssessment?.evaluation;
};
/** Generic Core execution verdict of the source fragment, read independently. */
const coreExecution = (out: ClaimBoundObservation): unknown => (out.fragment as any).networkEvidence.execution.verdict;

const claimFor = (userOpHash: string, sender: string, profile: "v0.6" | "v0.7" = "v0.7") => ({
  network: BASE_ID, bundleTransactionHash: SUBJECT.txId,
  entryPoint: profile === "v0.7" ? ENTRY_POINT_V0_7_OBSERVED_ON_BASE : ENTRY_POINT_PROFILES["v0.6"],
  entryPointProfile: profile,
  userOperation: { userOpHash, sender },
});

const realFetch = globalThis.fetch;
let globalFetchAttempts = 0;
beforeAll(() => {
  globalThis.fetch = (async () => {
    globalFetchAttempts += 1;
    throw new Error("network I/O is forbidden in erc4337-derived-terms tests");
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});
afterEach(() => {
  expect(globalFetchAttempts).toBe(0);
});

describe("ERC-4337 terms derived from the pinned Base mainnet bundle's handleOps calldata", () => {
  const { selector, ops } = decodeHandleOps(TX.input);
  const matching = ops.filter(op => userOpHashV07(op, ENTRY_POINT_V0_7_OBSERVED_ON_BASE, 8453n) === EXPECTED_USER_OP_HASH);

  it("the calldata is EntryPoint v0.7 handleOps and exactly one decoded op recomputes to the event's userOpHash and sender", () => {
    expect(TX.hash).toBe(SUBJECT.txId);
    expect(TX.to).toBe(ENTRY_POINT_V0_7_OBSERVED_ON_BASE);
    expect(BigInt(TX.chainId)).toBe(8453n);
    expect("0x" + keccak256Hex(utf8Bytes(HANDLE_OPS_SIGNATURE)).slice(0, 8)).toBe("0x765e827f");
    expect(selector).toBe("0x765e827f");
    expect(ops.length).toBeGreaterThan(0);
    expect(matching).toHaveLength(1);
    expect(matching[0]!.sender).toBe(EXPECTED_SENDER);
  });

  it("derived terms through resolveWithOptionalClaim: supported, supportedUserOperationOnly, Core execution supported", async () => {
    const op = matching[0]!;
    const derivedHash = userOpHashV07(op, ENTRY_POINT_V0_7_OBSERVED_ON_BASE, 8453n);
    const out = await assess(claimFor(derivedHash, op.sender));
    const ev = evaluation(out);
    expect(ev.outcome).toMatchObject({ applicability: "applicable", verdict: "supported", materialConflictIds: [] });
    expect(ev.claimLabel).toBe(ERC4337_CLAIM_LABELS.supportedUserOperationOnly);
    expect(ev.selectedUserOperation).toMatchObject({
      userOpHash: derivedHash, sender: op.sender, emitter: ENTRY_POINT_V0_7_OBSERVED_ON_BASE, success: true,
    });
    expect(ev.execution.verdict).toBe("supported");
    expect(coreExecution(out)).toBe("supported");
  });

  it("derived-hash variants (nonce+1, chainId 84532, coherent v0.6 form) are insufficient, never contradicted; Core execution supported", async () => {
    const op = matching[0]!;
    const derivedHash = userOpHashV07(op, ENTRY_POINT_V0_7_OBSERVED_ON_BASE, 8453n);
    const variants = [
      { name: "nonce+1", claim: claimFor(userOpHashV07({ ...op, nonce: op.nonce + 1n }, ENTRY_POINT_V0_7_OBSERVED_ON_BASE, 8453n), op.sender) },
      { name: "chainId 84532", claim: claimFor(userOpHashV07(op, ENTRY_POINT_V0_7_OBSERVED_ON_BASE, 84532n), op.sender) },
      { name: "v0.6", claim: claimFor(userOpHashV07(op, ENTRY_POINT_PROFILES["v0.6"], 8453n), op.sender, "v0.6") },
    ];
    const hashes = variants.map(v => v.claim.userOperation.userOpHash);
    expect(new Set([derivedHash, ...hashes]).size).toBe(4);
    for (const variant of variants) {
      const out = await assess(variant.claim);
      const ev = evaluation(out);
      expect(ev.outcome, variant.name).toMatchObject({ applicability: "applicable", verdict: "insufficient", materialConflictIds: [] });
      expect(ev.outcome.verdict, variant.name).not.toBe("contradicted");
      expect(ev, variant.name).not.toHaveProperty("selectedUserOperation");
      expect(ev.execution.verdict, variant.name).toBe("supported");
      expect(coreExecution(out), variant.name).toBe("supported");
    }
  });
});
