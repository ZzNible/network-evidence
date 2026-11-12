/**
 * Offline reproduction of hosted multichain envelopes. Envelopes are produced
 * by the REAL createMultichainTool over a fake provider fetchFn that serves the
 * checked-in Base mainnet and Solana mainnet capture fixtures byte-exactly
 * (pattern: packages/mcp/test/live-opstack.test.ts:57-97). Global fetch throws:
 * no live network call happens anywhere in this file.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeNecWireJson, encodeNecWireJson, nativeSourceContentDigest } from "@nec/core";
import { createMultichainTool, LIVE_MULTICHAIN_NETWORK_IDS } from "@nec/mcp";
import { stableJsonKey } from "@nec/resolver-solana";

import { LIVE_MULTICHAIN_SCHEMA } from "../../../packages/mcp/src/live-multichain.js";
import { LIVE_ENVELOPE_NETWORK_IDS, LIVE_ENVELOPE_SCHEMA, reproduceObservationEnvelope } from "../reproduce.js";

type Capture = { rpcMethod: string; rpcParams: unknown[]; resultJson: string };
const load = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as { captures: Capture[] };
const evmFixture = load("../../../packages/mcp/test/fixtures/base-mainnet-l2-finalized-positive-evm.json");
const opFixture = load("../../../packages/mcp/test/fixtures/base-mainnet-l2-finalized-positive-opstack.json");
const solFixture = load("../../../packages/resolver-solana/test/fixtures/solana-mainnet-x402-real.json");

const BASE = "https://mainnet.base.org";
const SOLANA = "https://api.mainnet-beta.solana.com";
const EVM_TX = "0x71c9e27a7195bdecf1c63e73d5f959c96ddb35a27f6f1308835494c3156d625c";
const SOL_TX = "4DYWUMExSrMNxYLjUuH9G8feN4fmYXm4ToCx7gGaAEjJRf2QNrE8LsvoFSGhXwQJrchhgrnGpUFwjxrci9PRLF71";
const evmSubject = { type: "transaction" as const, networkId: "eip155:8453" as const, txId: EVM_TX };
const solSubject = { type: "transaction" as const, networkId: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" as const, txId: SOL_TX };

/** Fake provider: exact (origin, method, params) lookup, raw resultJson bytes, throws on anything else. */
function fakeProvider(opts: { nullReceipt?: boolean } = {}) {
  const queues = new Map<string, string[]>();
  const add = (origin: string, c: Capture) => {
    const key = `${origin} ${c.rpcMethod} ${stableJsonKey(c.rpcParams)}`;
    queues.set(key, [...(queues.get(key) ?? []), c.resultJson]);
  };
  for (const c of evmFixture.captures) add(BASE, c);
  for (const c of opFixture.captures) if (c.rpcMethod === "eth_getBlockByNumber") add(BASE, c);
  for (const c of solFixture.captures) add(SOLANA, c);
  const methods: string[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const origin = new URL(url).origin;
    if (origin !== BASE && origin !== SOLANA) throw new Error("Unexpected outbound destination");
    const q = JSON.parse(init?.body as string) as { id: unknown; method: string; params?: unknown[] };
    methods.push(q.method);
    const key = `${origin} ${q.method} ${stableJsonKey(q.params ?? [])}`;
    const queue = queues.get(key);
    if (queue === undefined || queue.length === 0) throw new Error(`Unexpected request: ${key}`);
    let result = queue.length > 1 ? queue.shift()! : queue[0]!;
    if (opts.nullReceipt && (q.method === "eth_getTransactionReceipt" || q.method === "eth_getTransactionByHash")) result = "null";
    const response = new Response(`{"jsonrpc":"2.0","id":${JSON.stringify(q.id)},"result":${result}}`, {
      status: 200, headers: { "content-type": "application/json" },
    });
    Object.defineProperty(response, "url", { value: new URL(url).href });
    return response;
  };
  return { fetchFn, methods };
}

/** One real tool invocation, then a JSON round trip as an MCP transport delivers structuredContent. */
async function envelopeFor(subject: typeof evmSubject | typeof solSubject, opts: { nullReceipt?: boolean; includeL2Finality?: boolean } = {}) {
  const provider = fakeProvider(opts);
  const out = await createMultichainTool(provider.fetchFn)({
    subject, ...(opts.includeL2Finality === true ? { includeL2Finality: true } : {}),
  });
  return { envelope: JSON.parse(JSON.stringify(out)) as any, methods: provider.methods };
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const sha256 = (text: string) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
const canonicalWire = (fragment: unknown) =>
  encodeNecWireJson("network-evidence-fragment", decodeNecWireJson("network-evidence-fragment", JSON.stringify(fragment)));
function refIndex(envelope: any, method: string): number {
  const index = envelope.fragment.evidence.findIndex((r: any) => r.metadata.rpcMethod === method);
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}
function captureIndex(envelope: any, method: string): number {
  const index = envelope.acquisition.captures.findIndex((c: any) => c.rpcMethod === method);
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}

const realFetch = globalThis.fetch;
let evm: any;
let sol: any;

beforeAll(async () => {
  globalThis.fetch = (async () => {
    throw new Error("global fetch is denied in hosted-reproduction tests");
  }) as typeof fetch;
  evm = (await envelopeFor(evmSubject)).envelope;
  sol = (await envelopeFor(solSubject)).envelope;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("hosted envelope reproduction: positives", () => {
  it("pins the strict envelope identity to the live MCP constants and denies global fetch", async () => {
    expect(LIVE_ENVELOPE_SCHEMA).toBe(LIVE_MULTICHAIN_SCHEMA);
    expect([...LIVE_ENVELOPE_NETWORK_IDS]).toEqual([...LIVE_MULTICHAIN_NETWORK_IDS]);
    await expect(fetch("https://example.org")).rejects.toThrow("global fetch is denied");
  });

  it("EVM Base mainnet envelope reproduces byte-identically, twice", async () => {
    const { envelope, methods } = await envelopeFor(evmSubject);
    expect(methods).toEqual(["eth_chainId", "eth_getTransactionReceipt", "eth_getBlockByHash", "eth_getTransactionByHash"]);
    const report = await reproduceObservationEnvelope(envelope);
    expect(report).toEqual({
      status: "reproduced", reason: "byte_identical",
      hostedFragmentDigest: sha256(canonicalWire(envelope.fragment)),
      reproducedFragmentDigest: sha256(canonicalWire(envelope.fragment)),
    });
    // The hosted structuredContent fragment IS the canonical wire, byte for byte.
    expect(JSON.stringify(envelope.fragment)).toBe(canonicalWire(envelope.fragment));
    expect(envelope.fragment.networkEvidence.execution.verdict).toBe("supported");
    expect(envelope.fragment.networkEvidence).not.toHaveProperty("settlement");
    expect(envelope.fragment.networkEvidence).not.toHaveProperty("finality");
    expect(JSON.stringify(await reproduceObservationEnvelope(clone(envelope)))).toBe(JSON.stringify(report));
  });

  it("Solana mainnet envelope reproduces byte-identically, twice", async () => {
    const { envelope, methods } = await envelopeFor(solSubject);
    expect(methods).toEqual(["getGenesisHash", "getTransaction", "getSignatureStatuses", "getBlock"]);
    const report = await reproduceObservationEnvelope(envelope);
    expect(report).toEqual({
      status: "reproduced", reason: "byte_identical",
      hostedFragmentDigest: sha256(canonicalWire(envelope.fragment)),
      reproducedFragmentDigest: sha256(canonicalWire(envelope.fragment)),
    });
    expect(JSON.stringify(envelope.fragment)).toBe(canonicalWire(envelope.fragment));
    // Source-reported finalized commitment only; never settlement.
    expect(envelope.fragment.networkEvidence.finality.verdict).toBe("supported");
    expect(envelope.fragment.networkEvidence.finality.metadata.economicIrreversibilityEstablished).toBe(false);
    expect(envelope.fragment.networkEvidence).not.toHaveProperty("settlement");
    expect(JSON.stringify(await reproduceObservationEnvelope(clone(envelope)))).toBe(JSON.stringify(report));
  });

  it("OP Stack supplement is always not_reproducible; only verdict class, anchor and not_evaluated fields are echoed", async () => {
    const { envelope } = await envelopeFor(evmSubject, { includeL2Finality: true });
    const op = envelope.opStackFinality;
    expect(op.toolStatus).toBe("evaluated");
    const report = await reproduceObservationEnvelope(envelope);
    expect(report.status).toBe("reproduced");
    expect(report.opStackSupplement).toEqual({
      status: "not_reproducible", reason: "opstack_supplement_without_raw_bytes",
      verdictClass: op.fragment.networkEvidence.finality.verdict,
      anchoredBlockHash: op.fragment.network.observedAt.blockId,
      withdrawalFinalization: "not_evaluated", ethereumSettlement: "not_evaluated",
    });
    // observedAt is a separate later read; it is not required to equal acquiredAt.
    const shifted = clone(envelope);
    shifted.opStackFinality.observedAt = "1999-01-01T00:00:00.000Z";
    expect(await reproduceObservationEnvelope(shifted)).toEqual(report);
  });

  it("null receipt reproduces as insufficient, never contradicted; unevaluated supplement stays not_reproducible", async () => {
    const { envelope, methods } = await envelopeFor(evmSubject, { nullReceipt: true, includeL2Finality: true });
    expect(methods).toEqual(["eth_chainId", "eth_getTransactionReceipt", "eth_getTransactionByHash"]);
    expect(envelope.acquisition.transactionObserved).toBe(false);
    const report = await reproduceObservationEnvelope(envelope);
    expect(report.status).toBe("reproduced");
    expect(report.reproducedFragmentDigest).toBe(sha256(canonicalWire(envelope.fragment)));
    const execution = decodeNecWireJson("network-evidence-fragment", JSON.stringify(envelope.fragment)).networkEvidence.execution;
    expect(execution?.verdict).toBe("insufficient");
    expect(execution?.verdict).not.toBe("contradicted");
    expect(report.opStackSupplement).toEqual({
      status: "not_reproducible", reason: "opstack_supplement_without_raw_bytes",
      verdictClass: "not_evaluated", anchoredBlockHash: null,
      withdrawalFinalization: "not_evaluated", ethereumSettlement: "not_evaluated",
    });
  });
});

describe("hosted envelope reproduction: negatives fail closed", () => {
  it("flipped nativeSource byte => diverged on the native digest (EVM and Solana)", async () => {
    for (const [base, method] of [[evm, "eth_getTransactionReceipt"], [sol, "getTransaction"]] as const) {
      const env = clone(base);
      const j = refIndex(env, method);
      const bytes = Buffer.from(env.fragment.evidence[j].nativeSource.payload, "base64");
      bytes[10] = bytes[10]! ^ 0x01;
      env.fragment.evidence[j].nativeSource.payload = bytes.toString("base64");
      const report = await reproduceObservationEnvelope(env);
      expect(report).toEqual({
        status: "diverged", reason: "native_source_digest_mismatch",
        firstDiffPointer: `/fragment/evidence/${j}/nativeSource/contentDigest`,
        hostedFragmentDigest: null, reproducedFragmentDigest: null,
      });
    }
  });

  it("substituted payload with a recomputed nativeSource digest => diverged on the capture contentDigest", async () => {
    const cases = [
      [evm, "eth_getTransactionReceipt", '"status":"0x1"', '"status":"0x0"'],
      [sol, "getSignatureStatuses", '"confirmationStatus":"finalized"', '"confirmationStatus":"confirmed"'],
    ] as const;
    for (const [base, method, from, to] of cases) {
      const env = clone(base);
      const j = refIndex(env, method);
      const native = env.fragment.evidence[j].nativeSource;
      const text = Buffer.from(native.payload, "base64").toString("utf8");
      const substituted = new TextEncoder().encode(text.replace(from, to));
      expect(Buffer.from(substituted).toString("utf8")).not.toBe(text);
      native.payload = Buffer.from(substituted).toString("base64");
      native.contentDigest = nativeSourceContentDigest(substituted);
      const report = await reproduceObservationEnvelope(env);
      expect(report.status).toBe("diverged");
      expect(report.reason).toBe("capture_content_digest_mismatch");
      expect(report.firstDiffPointer).toBe(`/acquisition/captures/${captureIndex(env, method)}/contentDigest`);
      expect(report.hostedFragmentDigest).toBe(sha256(canonicalWire(env.fragment)));
      expect(report.reproducedFragmentDigest).not.toBeNull();
      expect(report.reproducedFragmentDigest).not.toBe(report.hostedFragmentDigest);
    }
  });

  it("txId swap => diverged (envelope subject only, and subject + fragment subject)", async () => {
    const other = "0x" + "ab".repeat(32);
    const shallow = clone(evm);
    shallow.subject.txId = other;
    expect(await reproduceObservationEnvelope(shallow)).toMatchObject({
      status: "diverged", reason: "subject_binding_mismatch", firstDiffPointer: "/fragment/subject/txId",
    });
    const deep = clone(evm);
    deep.subject.txId = other;
    deep.fragment.subject.txId = other;
    expect(await reproduceObservationEnvelope(deep)).toMatchObject({ status: "diverged", reason: "locator_subject_mismatch" });
  });

  it("Base <-> Base Sepolia networkId swap => diverged (subject only, and consistently relabelled)", async () => {
    const shallow = clone(evm);
    shallow.subject.networkId = "eip155:84532";
    expect(await reproduceObservationEnvelope(shallow)).toMatchObject({
      status: "diverged", reason: "subject_binding_mismatch", firstDiffPointer: "/fragment/subject/networkId",
    });
    // Relabel every network field; raw eth_chainId bytes still say 0x2105.
    const text = JSON.stringify(evm).replaceAll('"eip155:8453"', '"eip155:84532"').replace(/"chainId":8453(?=[,}])/g, '"chainId":84532');
    const relabelled = JSON.parse(text);
    expect(relabelled.source.chainId).toBe(84532);
    expect(await reproduceObservationEnvelope(relabelled)).toMatchObject({ status: "diverged", reason: "replay_rejected" });
  });

  it("ref without nativeSource => not_reproducible:native_source_absent (a valid >256 KiB observation, not a defect)", async () => {
    for (const [base, method] of [[evm, "eth_getBlockByHash"], [sol, "getTransaction"]] as const) {
      const env = clone(base);
      const j = refIndex(env, method);
      delete env.fragment.evidence[j].nativeSource;
      const report = await reproduceObservationEnvelope(env);
      expect(report).toMatchObject({
        status: "not_reproducible", reason: "native_source_absent", firstDiffPointer: `/fragment/evidence/${j}/nativeSource`,
        reproducedFragmentDigest: null,
      });
      expect(report.hostedFragmentDigest).toBe(sha256(canonicalWire(env.fragment)));
    }
  });

  it("capture/ref count mismatch => diverged", async () => {
    for (const base of [evm, sol]) {
      const env = clone(base);
      env.acquisition.captures.pop();
      expect(await reproduceObservationEnvelope(env)).toMatchObject({
        status: "diverged", reason: "capture_ref_count_mismatch", firstDiffPointer: "/acquisition/captures",
      });
    }
  });

  it("unknown schema, unsupported networks, claim assessment and malformed input are not reproducible", async () => {
    const schema = clone(evm);
    schema.schema = "ne-mcp-observation-envelope/v0.2";
    expect(await reproduceObservationEnvelope(schema)).toEqual({
      status: "not_reproducible", reason: "unknown_schema", firstDiffPointer: "/schema",
      hostedFragmentDigest: null, reproducedFragmentDigest: null,
    });
    for (const networkId of ["eip155:1", "eip155:57057", "eip155:11155111"]) {
      const env = clone(evm);
      env.subject.networkId = networkId;
      expect(await reproduceObservationEnvelope(env)).toMatchObject({ status: "not_reproducible", reason: "unsupported_network" });
    }
    const claim = clone(evm);
    claim.claimAssessment = { protocol: "x402-evm", assessmentType: "adapter_local_protocol_assessment", evaluation: {}, nonClaims: [] };
    expect(await reproduceObservationEnvelope(claim)).toMatchObject({ status: "not_reproducible", reason: "claim_assessment_out_of_scope" });
    const extra = clone(sol);
    extra.unexpected = true;
    expect(await reproduceObservationEnvelope(extra)).toMatchObject({ status: "not_reproducible", reason: "envelope_invalid", firstDiffPointer: "/unexpected" });
    const solanaWithSupplement = clone(sol);
    solanaWithSupplement.opStackFinality = { toolStatus: "not_evaluated" };
    expect(await reproduceObservationEnvelope(solanaWithSupplement)).toMatchObject({ status: "not_reproducible", reason: "envelope_invalid" });
    for (const junk of [null, "envelope", [evm], 42, { get schema() { return LIVE_ENVELOPE_SCHEMA; } }]) {
      expect(await reproduceObservationEnvelope(junk)).toMatchObject({ status: "not_reproducible", reason: "envelope_invalid" });
    }
  });

  it("tampered hosted bindings never reproduce", async () => {
    const warning = clone(evm);
    expect(warning.fragment.warnings.length).toBeGreaterThan(0);
    warning.fragment.warnings[0].message = "tampered after acquisition";
    expect(await reproduceObservationEnvelope(warning)).toMatchObject({
      status: "diverged", reason: "fragment_wire_mismatch", firstDiffPointer: "/fragment/warnings/0/message",
    });

    const flag = clone(sol);
    flag.acquisition.consistent = !flag.acquisition.consistent;
    expect(await reproduceObservationEnvelope(flag)).toMatchObject({
      status: "diverged", reason: "acquisition_projection_mismatch", firstDiffPointer: "/acquisition/consistent",
    });

    const bytes = clone(evm);
    bytes.acquisition.captures[0].resultBytes += 1;
    expect(await reproduceObservationEnvelope(bytes)).toMatchObject({
      status: "diverged", reason: "capture_metadata_mismatch", firstDiffPointer: "/acquisition/captures/0/resultBytes",
    });

    const method = clone(evm);
    const j = refIndex(method, "eth_chainId");
    method.acquisition.captures[captureIndex(method, "eth_chainId")].rpcMethod = "eth_call";
    method.fragment.evidence[j].metadata.rpcMethod = "eth_call";
    method.fragment.evidence[j].locator = "eth_call:[]";
    expect(await reproduceObservationEnvelope(method)).toMatchObject({
      status: "not_reproducible", reason: "rpc_method_not_allowlisted", firstDiffPointer: `/fragment/evidence/${j}/locator`,
    });

    const unbound = clone(sol);
    unbound.acquisition.captures[1].contentDigest = "sha256:" + "0".repeat(64);
    expect(await reproduceObservationEnvelope(unbound)).toMatchObject({
      status: "diverged", reason: "capture_ref_binding_mismatch", firstDiffPointer: "/acquisition/captures/1/contentDigest",
    });
  });
});
