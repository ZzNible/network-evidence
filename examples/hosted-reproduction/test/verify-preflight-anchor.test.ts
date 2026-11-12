/**
 * verify-preflight-anchor.ts (examples-only; closes no gate row).
 *
 * REAL cases: hosted envelopes generated over a LOOPBACK hosted-mode server
 * (simulated public Host header, test-only helper) whose live tools read a
 * fake provider fetchFn serving ONE checked-in real capture's exact resultJson
 * bytes for its exact recorded params; anything else throws. Only Date is
 * faked: pinned to the Base 0x71c9 capture's recorded acquisition instant as in
 * packages/mcp/test/live-before-preflight-separation.test.ts, and to the Base
 * Sepolia capture's own instant for the Sepolia preflight:
 * - Base mainnet 0x71c9e27a…625c (mcp base-mainnet-l2-finalized-positive-evm.json):
 *   the caller preflight of the separation test, and the AFTER envelope.
 * - Base mainnet USDC 0xcf496b…5afb (resolver-opstack base-mainnet-usdc-transfer.fixture.json): AFTER.
 * - Solana mainnet 4DYWUMEx…LF71 (resolver-solana solana-mainnet-x402-real.json): AFTER and a caller preflight.
 * - Base Sepolia 0xde8916c8…ed45 (adapter-erc4337 base-sepolia-external-v06-userop.json): a caller preflight.
 * The Sepolia and Solana requests are test-authored readiness probes; no action is executed.
 * None of the REAL cases is anchored and none is fixedBeforeExecution.
 *
 * SIMULATED cases (countsForGate:false): pure Core artifacts on a made-up
 * subject under eip155:31337 (a local development chain id, never a live
 * profile; nothing is fetched for it), built only from made-up values that
 * are asserted absent from every checked-in JSON fixture. No real hash or
 * capture byte is reused.
 *
 * Global fetch throws; no live network call is made anywhere in this file.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  buildPreflightResult, computeEvidencePolicyDigest, computeResolverManifestDigest, decodeNecWireJson, encodeNecWireJson,
  verifyPreflightResultIntegrity,
} from "@nec/core";
import type {
  CapabilityName, NetworkEvidenceFragment, ObservedEffect, PolicyDimension, PreflightRequest, PreflightResult, ResolverManifest,
} from "@nec/core";
import { createMultichainTool, LIVE_MULTICHAIN_TOOL, LIVE_PREFLIGHT_TOOL_NAME, LIVE_TOOL_NAMES, startNeMcpHttpServer } from "@nec/mcp";
import { evaluateTransactionAcquisition, replayTransactionAcquisition } from "@nec/resolver-evm";

import { simulatedHostFetch } from "../../../packages/mcp/test/helpers.js";
import { reproduceObservationEnvelope } from "../reproduce.js";
import { verifyLivePreflightEnvelope } from "../verify-live-before.js";
import {
  ANCHOR_CHECK_ORDER, ANCHOR_NON_CLAIMS, AUTHORIZATION_USED_TOPIC, matchPreflightAnchor, verifyPreflightAnchor,
} from "../verify-preflight-anchor.js";
import type { PreflightAnchorReport } from "../verify-preflight-anchor.js";

type Capture = { rpcMethod: string; rpcParams: unknown[]; resultJson: string };
type Fixture = { acquiredAt: string; subject: { txHash?: string; signature?: string }; captures: Capture[] };
const load = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as Fixture;
const EVM = load("../../../packages/mcp/test/fixtures/base-mainnet-l2-finalized-positive-evm.json");
const USDC = load("../../../packages/resolver-opstack/test/fixtures/base-mainnet-usdc-transfer.fixture.json");
const SOL = load("../../../packages/resolver-solana/test/fixtures/solana-mainnet-x402-real.json");
const SEPOLIA = load("../../../packages/adapter-erc4337/test/fixtures/base-sepolia-external-v06-userop.json");

const ORIGIN = "https://mcp.example.org";
const HOST = "mcp.example.org";
const BASE_ID = "eip155:8453";
const SEPOLIA_ID = "eip155:84532";
const SOL_ID = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOURCES: Readonly<Record<string, string>> = {
  [BASE_ID]: "https://mainnet.base.org/", [SEPOLIA_ID]: "https://sepolia.base.org/", [SOL_ID]: "https://api.mainnet-beta.solana.com/",
};
const PINNED_AT = EVM.acquiredAt;
const USDC_TOKEN = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
// topics[2] of the AuthorizationUsed log as recorded in the USDC receipt capture (eip3009-nonce-exposure.test.ts).
const RECORDED_USDC_NONCE = "0x4a0189886fa9ad178790263a6625c1fdb1fd08a65671298ba6146dbb8584d0cd";

const txOf = (fixture: Fixture) => JSON.parse(fixture.captures.find((c) => c.rpcMethod === "eth_getTransactionByHash")!.resultJson) as { to: string };
const logsOf = (fixture: Fixture) =>
  (JSON.parse(fixture.captures.find((c) => c.rpcMethod === "eth_getTransactionReceipt")!.resultJson) as { logs: { address: string; topics: string[] }[] }).logs;
const subject = (networkId: string, txId: string) => ({ type: "transaction", networkId, txId });
const BASE_SUBJECT = subject(BASE_ID, EVM.subject.txHash!);
const USDC_SUBJECT = subject(BASE_ID, USDC.subject.txHash!);
const SOL_SUBJECT = subject(SOL_ID, SOL.subject.signature!);
const SEPOLIA_SUBJECT = subject(SEPOLIA_ID, SEPOLIA.subject.txHash!);

/** The caller request of live-before-preflight-separation.test.ts: the real Base transaction's own `to` as target. */
const ACTION_TARGET = txOf(EVM).to;
const POLICY_CONTENT = { id: "caller_policy_requires_finality", version: "1", requiredDimensions: ["execution", "finality"] as PolicyDimension[] };
const POLICY = { ...POLICY_CONTENT, digest: computeEvidencePolicyDigest(POLICY_CONTENT) };
const BASE_PREFLIGHT_ARGS = {
  selectedNetworkId: BASE_ID, probeSubject: BASE_SUBJECT,
  request: {
    schemaVersion: "0.1", requestId: "ne_caller_preflight_1", networkId: BASE_ID,
    action: { kind: "evm.contract_call", target: ACTION_TARGET }, evidencePolicy: POLICY,
  },
};
const PROBE_LABEL = "test-authored readiness probe, no action executed";
const SEPOLIA_PREFLIGHT_ARGS = {
  selectedNetworkId: SEPOLIA_ID, probeSubject: SEPOLIA_SUBJECT,
  request: {
    schemaVersion: "0.1", requestId: "ne_anchor_sepolia_preflight_1", networkId: SEPOLIA_ID,
    action: { kind: "evm.contract_call", target: txOf(SEPOLIA).to }, evidencePolicy: POLICY, metadata: { probeLabel: PROBE_LABEL },
  },
};
const SOL_PREFLIGHT_ARGS = {
  selectedNetworkId: SOL_ID, probeSubject: SOL_SUBJECT,
  request: {
    schemaVersion: "0.1", requestId: "ne_anchor_solana_preflight_1", networkId: SOL_ID,
    action: { kind: "spl_token.transfer_checked" }, evidencePolicy: POLICY, metadata: { probeLabel: PROBE_LABEL },
  },
};
/** The one AuthorizationUsed log recorded in the USDC receipt capture. */
const USDC_AUTHORIZATION_USED = logsOf(USDC).find((l) => l.topics[0] === AUTHORIZATION_USED_TOPIC)!;
// The account is copied from the AFTER capture (topics[1] of that log) only to cover how the field is carried
// through the verifier; it implies nothing about who authored or requested the USDC action.
const USDC_ACCOUNT = `0x${USDC_AUTHORIZATION_USED.topics[1]!.slice(2 + 24)}`;
/** A test-authored caller preflight whose target is the USDC token, so step 5 passes and step 6 runs on real bytes. */
const USDC_TARGET_PREFLIGHT_ARGS = {
  selectedNetworkId: BASE_ID, probeSubject: BASE_SUBJECT,
  request: {
    schemaVersion: "0.1", requestId: "ne_anchor_usdc_target_preflight_1", networkId: BASE_ID,
    action: { kind: "evm.contract_call", target: USDC_TOKEN }, account: USDC_ACCOUNT, evidencePolicy: POLICY,
    metadata: { probeLabel: PROBE_LABEL },
  },
};

/** Serves ONE real fixture's exact resultJson bytes for its exact recorded params, at its own origin only. */
function provider(networkId: string, fixture: Fixture): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).href;
    if (url !== SOURCES[networkId]) throw new Error("Unapproved fake endpoint");
    const q = JSON.parse(init?.body as string) as { id: unknown; method: string; params?: unknown[] };
    const found = fixture.captures.find((c) => c.rpcMethod === q.method && isDeepStrictEqual(q.params ?? [], c.rpcParams));
    if (found === undefined) throw new Error(`Unexpected request: ${q.method}`);
    const response = new Response(`{"jsonrpc":"2.0","id":${JSON.stringify(q.id)},"result":${found.resultJson}}`, {
      status: 200, headers: { "content-type": "application/json" },
    });
    Object.defineProperty(response, "url", { value: url });
    return response;
  };
}

/** One hosted opt-in loopback server + one modern MCP client session, Date pinned; returns the structuredContent. */
async function hostedCall(fetchFn: typeof fetch, pinnedAt: string, name: string, args: Record<string, unknown>): Promise<any> {
  vi.setSystemTime(Date.parse(pinnedAt));
  const server = await startNeMcpHttpServer({
    host: "127.0.0.1", port: 0, hosted: { publicOrigin: ORIGIN }, liveEvidence: createMultichainTool(fetchFn),
  });
  try {
    const client = new Client({ name: "verify-preflight-anchor-test", version: "1" }, { versionNegotiation: { mode: "auto" } });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), { fetch: simulatedHostFetch(server.port, HOST) }));
    try {
      const result = await client.callTool({ name, arguments: args }) as { isError?: boolean; content?: unknown; structuredContent?: unknown };
      expect([name, result.isError ?? false, result.isError ? JSON.stringify(result.content) : null]).toEqual([name, false, null]);
      return JSON.parse(JSON.stringify(result.structuredContent)) as unknown;
    } finally {
      await client.close();
    }
  } finally {
    await server.close();
  }
}

const json = (value: unknown): any => JSON.parse(JSON.stringify(value));
const mutate = (envelope: unknown, change: (copy: any) => void): any => {
  const copy = json(envelope);
  change(copy);
  return copy;
};
const flip = (digest: string) => `${digest.slice(0, -1)}${digest.endsWith("0") ? "1" : "0"}`;
const nonceOf = (digest: string) => `0x${digest.slice("sha256:".length)}`;
const sha256 = (text: string) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
const authorizationUsed = (fragment: { networkEvidence: { observedEffects?: ObservedEffect[] } }) =>
  (fragment.networkEvidence.observedEffects ?? []).filter((e) => e.type === "evm.log" && (e.fields.topics as string[])[0] === AUTHORIZATION_USED_TOPIC);

const realFetch = globalThis.fetch;
let fetchCalls = 0;
const real: Record<
  "basePreflight" | "sepoliaPreflight" | "solanaPreflight" | "usdcTargetPreflight" | "baseAfter" | "usdcAfter" | "solanaAfter", any
> = {
  basePreflight: null, sepoliaPreflight: null, solanaPreflight: null, usdcTargetPreflight: null,
  baseAfter: null, usdcAfter: null, solanaAfter: null,
};
beforeAll(async () => {
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("global fetch is denied in verify-preflight-anchor tests");
  }) as typeof fetch;
  // Only Date is faked; setTimeout, AbortSignal.timeout and HTTP stay real.
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    real.basePreflight = await hostedCall(provider(BASE_ID, EVM), PINNED_AT, LIVE_PREFLIGHT_TOOL_NAME, BASE_PREFLIGHT_ARGS);
    real.baseAfter = await hostedCall(provider(BASE_ID, EVM), PINNED_AT, LIVE_MULTICHAIN_TOOL, { subject: BASE_SUBJECT });
    real.usdcAfter = await hostedCall(provider(BASE_ID, USDC), PINNED_AT, LIVE_MULTICHAIN_TOOL, { subject: USDC_SUBJECT });
    real.solanaAfter = await hostedCall(provider(SOL_ID, SOL), PINNED_AT, LIVE_MULTICHAIN_TOOL, { subject: SOL_SUBJECT });
    real.solanaPreflight = await hostedCall(provider(SOL_ID, SOL), PINNED_AT, LIVE_PREFLIGHT_TOOL_NAME, SOL_PREFLIGHT_ARGS);
    real.usdcTargetPreflight = await hostedCall(provider(BASE_ID, EVM), PINNED_AT, LIVE_PREFLIGHT_TOOL_NAME, USDC_TARGET_PREFLIGHT_ARGS);
    real.sepoliaPreflight = await hostedCall(provider(SEPOLIA_ID, SEPOLIA), SEPOLIA.acquiredAt, LIVE_PREFLIGHT_TOOL_NAME, SEPOLIA_PREFLIGHT_ARGS);
  } finally {
    vi.useRealTimers();
  }
}, 60_000);
afterAll(() => {
  globalThis.fetch = realFetch;
});

// ---------------------------------------------------------------------------
// SIMULATED pure-core material (made-up values only)
// ---------------------------------------------------------------------------

const SIM_NETWORK = "eip155:31337";
/** Made-up 8-hex units; their doubled forms are asserted absent from every checked-in JSON fixture. */
const SIM_UNITS = { tx: "51ca7e00", block: "51b10c00", target: "51700ce0", other: "51e3170e", account: "51acc0de", authorizer: "51f0e1a0" };
const SIM_TX = `0x${SIM_UNITS.tx.repeat(8)}`;
const SIM_BLOCK = `0x${SIM_UNITS.block.repeat(8)}`;
const SIM_TARGET = `0x${SIM_UNITS.target.repeat(5)}`;
const SIM_OTHER_EMITTER = `0x${SIM_UNITS.other.repeat(5)}`;
const SIM_ACCOUNT = `0x${SIM_UNITS.account.repeat(5)}`;
const SIM_OTHER_AUTHORIZER = `0x${SIM_UNITS.authorizer.repeat(5)}`;
const SIM_GENERATED_AT = "2031-03-03T03:03:03.003Z";
const SIM_BLOCK_TIME = "2031-03-03T03:03:09.000Z";
const SIM_MANIFEST_CONTENT: Omit<ResolverManifest, "digest"> = {
  id: "simulated-anchor-resolver", version: "0.0.0-simulated", networkFamilies: ["eip155"], implementation: {},
  supportedCapabilities: ["execution"] as CapabilityName[], sourceRequirements: [{ sourceType: "simulated", required: true }],
};
const SIM_MANIFEST: ResolverManifest = { ...SIM_MANIFEST_CONTENT, digest: computeResolverManifestDigest(SIM_MANIFEST_CONTENT) };
const SIM_POLICY_CONTENT = { id: "simulated_anchor_policy", version: "1", requiredDimensions: ["execution"] as PolicyDimension[] };
const SIM_REQUEST: PreflightRequest = {
  schemaVersion: "0.1", requestId: "simulated_anchor_preflight_1", networkId: SIM_NETWORK, account: SIM_ACCOUNT,
  action: { kind: "evm.contract_call", target: SIM_TARGET },
  evidencePolicy: { ...SIM_POLICY_CONTENT, digest: computeEvidencePolicyDigest(SIM_POLICY_CONTENT) },
  metadata: { label: "SIMULATED" },
};

/** SIMULATED: a Core-built PreflightResult (no readiness claimed, so no capability snapshot is needed). */
function simPreflight(): PreflightResult {
  const notDerived = () => ({ status: "unknown" as const });
  return buildPreflightResult({
    schemaVersion: "0.1", generatedAt: SIM_GENERATED_AT,
    network: { networkId: SIM_NETWORK, chainId: 31337, observedAt: {} },
    request: SIM_REQUEST,
    evidenceReadiness: {
      execution: notDerived(), observedEffects: notDerived(), dataBinding: notDerived(), settlement: notDerived(), finality: notDerived(),
    },
    blockers: [], warnings: [], evidence: [],
    evidencePolicy: { id: SIM_REQUEST.evidencePolicy.id, version: SIM_REQUEST.evidencePolicy.version, digest: SIM_REQUEST.evidencePolicy.digest },
    resolver: { id: SIM_MANIFEST.id, version: SIM_MANIFEST.version, digest: SIM_MANIFEST.digest },
  }, { resolver: SIM_MANIFEST });
}

interface SimLog { readonly address: string; readonly nonce: string; readonly logIndex: number; readonly authorizer?: string }
const pad32 = (address: string) => `0x${"0".repeat(24)}${address.slice(2)}`;

/** SIMULATED: a Core NetworkEvidenceFragment with generic evm.log AuthorizationUsed effects on the made-up subject. */
function simFragment(logs: readonly SimLog[], blockTime = SIM_BLOCK_TIME): NetworkEvidenceFragment {
  const effects = logs.map((log): ObservedEffect => ({
    id: `simulated-log-${log.logIndex}`, type: "evm.log",
    fields: {
      address: log.address, topics: [AUTHORIZATION_USED_TOPIC, pad32(log.authorizer ?? SIM_ACCOUNT), log.nonce], data: "0x",
      blockNumber: "7", blockHash: SIM_BLOCK, transactionHash: SIM_TX, transactionIndex: "0", logIndex: String(log.logIndex), removed: false,
    },
    basis: ["source_observation"], evidence: ["simulated-receipt-1"],
  }));
  return {
    network: { networkId: SIM_NETWORK, chainId: 31337, observedAt: { blockNumber: 7n, blockId: SIM_BLOCK, timestamp: blockTime } },
    subject: { type: "transaction", networkId: SIM_NETWORK, txId: SIM_TX },
    networkEvidence: { observedEffects: effects },
    evidence: [{ id: "simulated-receipt-1", sourceId: "simulated.source", sourceType: "simulated", retrievedAt: blockTime }],
    conflicts: [], warnings: [],
  };
}

/** One bit of the last hex digit flipped. */
const flipBit = (hex: string) => `${hex.slice(0, -1)}${(parseInt(hex.slice(-1), 16) ^ 1).toString(16)}`;

function jsonFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) jsonFiles(path, out);
    else if (entry.isFile() && entry.name.endsWith(".json")) out.push(path);
  }
  return out;
}

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

describe("verify-preflight-anchor (offline, fail closed, examples-only)", () => {
  it("topic0 is computed at runtime and matches the recorded USDC receipt; the 0x71c9 receipt has no log at all", () => {
    expect(AUTHORIZATION_USED_TOPIC).toMatch(/^0x[0-9a-f]{64}$/);
    expect(EVM.subject.txHash).toBe("0x71c9e27a7195bdecf1c63e73d5f959c96ddb35a27f6f1308835494c3156d625c");
    expect(USDC.subject.txHash).toBe("0xcf496bca417f033e3ce5ad167e82a5bf95b2d815e4493de2f4943d3058b85afb");
    expect(SEPOLIA.subject.txHash).toBe("0xde8916c81ef6a7b36ddf9f7b44d1ca096e4db4818eddfd5e16eda8a7c292ed45");
    expect(ACTION_TARGET).toBe("0x4200000000000000000000000000000000000015");
    const recorded = logsOf(USDC).filter((l) => l.topics[0] === AUTHORIZATION_USED_TOPIC);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ address: USDC_TOKEN });
    expect(recorded[0]!.topics[2]).toBe(RECORDED_USDC_NONCE);
    expect(logsOf(EVM)).toEqual([]);
    expect(fetchCalls).toBe(0);
  });

  it("the real loopback envelopes satisfy the wrapper's preconditions (preflights verified, AFTER envelopes reproduced)", async () => {
    for (const [envelope, args] of [
      [real.basePreflight, BASE_PREFLIGHT_ARGS], [real.sepoliaPreflight, SEPOLIA_PREFLIGHT_ARGS], [real.solanaPreflight, SOL_PREFLIGHT_ARGS],
    ] as const) {
      expect(verifyLivePreflightEnvelope(envelope, { expected: args })).toMatchObject({
        status: "verified", reason: "envelope_verified", selectedNetworkId: args.selectedNetworkId,
      });
    }
    // Generated with the pinned clock: the Core generatedAt is the probe's recorded instant.
    expect(real.basePreflight.preflight.generatedAt).toBe(PINNED_AT);
    expect(real.basePreflight.preflight.status).toBe("blocked");
    expect(real.sepoliaPreflight.preflight.generatedAt).toBe(SEPOLIA.acquiredAt);
    for (const envelope of [real.baseAfter, real.usdcAfter, real.solanaAfter]) {
      expect(await reproduceObservationEnvelope(envelope)).toMatchObject({ status: "reproduced", reason: "byte_identical" });
    }
    // The USDC AFTER envelope carries the recorded nonce in its one AuthorizationUsed effect, and it is not this preflight's digest.
    const usdcLogs = authorizationUsed(real.usdcAfter.fragment);
    expect(usdcLogs.map((e) => [e.fields.address, (e.fields.topics as string[])[2]])).toEqual([[USDC_TOKEN, RECORDED_USDC_NONCE]]);
    expect(RECORDED_USDC_NONCE).not.toBe(nonceOf(real.basePreflight.preflight.artifactDigest));
    expect(fetchCalls).toBe(0);
  });

  it("REAL negatives: each status is what the frozen order produces; never anchored, never fixedBeforeExecution", async () => {
    const cases: [string, any, any, PreflightAnchorReport["status"], PreflightAnchorReport["reason"]][] = [
      // USDC 0xcf49…5afb: (1) Core integrity holds, (2) eip155:8453 on both sides, (3) EVM transaction subject,
      // (4) exactly one AuthorizationUsed log, (5) its emitter is the USDC token 0x8335…2913, not the caller's declared
      // target 0x4200…0015 -> insufficient:emitter_unbound. Step 6 never runs, so nonce 0x4a01…d0cd is never compared.
      ["USDC 0xcf49…5afb AFTER vs the real Base caller preflight", real.basePreflight, real.usdcAfter, "insufficient", "emitter_unbound"],
      // 0x71c9…625c: (1)-(3) hold; its receipt has "logs":[] -> (4) not_anchored:no_authorization_used_log.
      ["0x71c9…625c AFTER vs the real Base caller preflight", real.basePreflight, real.baseAfter, "not_anchored", "no_authorization_used_log"],
      // Solana mainnet AFTER against the Base preflight: (2) runs before (3), so eip155:8453 != solana:5eyk… -> network_mismatch.
      ["Solana mainnet AFTER vs the real Base caller preflight", real.basePreflight, real.solanaAfter, "diverged", "network_mismatch"],
      // Solana mainnet AFTER against a Solana caller preflight: (1)-(2) hold, (3) not an EVM subject -> not_applicable.
      ["Solana mainnet AFTER vs a real Solana caller preflight", real.solanaPreflight, real.solanaAfter, "not_applicable", "non_evm_subject"],
      // network_mismatch on real material: the Base Sepolia caller preflight (eip155:84532) against the Base mainnet (eip155:8453) AFTER.
      ["0x71c9…625c AFTER vs a real Base Sepolia caller preflight", real.sepoliaPreflight, real.baseAfter, "diverged", "network_mismatch"],
    ];
    for (const [name, preflightEnvelope, afterEnvelope, status, reason] of cases) {
      const report = await verifyPreflightAnchor({ preflightEnvelope, afterEnvelope });
      const reproduced = await reproduceObservationEnvelope(afterEnvelope);
      expect([name, report]).toEqual([name, {
        status, reason, stage: "anchor",
        preflightArtifactDigest: preflightEnvelope.preflight.artifactDigest,
        observedNonce: null,
        afterFragmentDigest: reproduced.reproducedFragmentDigest,
        fixedBeforeExecution: false,
        nonClaims: ANCHOR_NON_CLAIMS,
      }]);
    }

    // The same USDC verdict on the resolver-opstack fixture replayed directly through the existing evaluator.
    const direct = evaluateTransactionAcquisition(
      await replayTransactionAcquisition(USDC as unknown as Parameters<typeof replayTransactionAcquisition>[0], { includeTransaction: true })).fragment;
    const basePreflight = decodeNecWireJson("preflight-result", JSON.stringify(real.basePreflight.preflight));
    expect(matchPreflightAnchor(basePreflight, direct)).toMatchObject({
      status: "insufficient", reason: "emitter_unbound", observedNonce: null, fixedBeforeExecution: false,
    });
    expect(fetchCalls).toBe(0);
  });

  it("REAL emitter-bound path: a caller preflight targeting the USDC token passes step 5, step 6 runs -> not_anchored:nonce_digest_mismatch", async () => {
    // The account comes from the capture bytes, never typed in.
    expect(USDC_ACCOUNT).toMatch(/^0x[0-9a-f]{40}$/);
    expect(`0x${"0".repeat(24)}${USDC_ACCOUNT.slice(2)}`).toBe(USDC_AUTHORIZATION_USED.topics[1]);
    expect(USDC_AUTHORIZATION_USED).toMatchObject({ address: USDC_TOKEN });

    const envelope = real.usdcTargetPreflight;
    expect(verifyLivePreflightEnvelope(envelope, { expected: USDC_TARGET_PREFLIGHT_ARGS })).toMatchObject({
      status: "verified", reason: "envelope_verified", selectedNetworkId: BASE_ID,
    });
    // account and target survive verbatim in the Core request.
    expect(envelope.preflight.request).toEqual(USDC_TARGET_PREFLIGHT_ARGS.request);

    // Clock order: this preflight was authored after the USDC action, so it is not a BEFORE.
    const block = JSON.parse(USDC.captures.find((c) => c.rpcMethod === "eth_getBlockByHash")!.resultJson) as { timestamp: string };
    expect(block.timestamp).toBe("0x6a7a415b");
    expect(envelope.preflight.generatedAt).toBe(PINNED_AT);
    expect(Date.parse(envelope.preflight.generatedAt)).toBeGreaterThan(Number(BigInt(block.timestamp)) * 1000);

    // (1)-(4) hold, (5) the emitter equals the declared target, (6) the one bound nonce 0x4a01…d0cd is not
    // this preflight's artifactDigest -> not_anchored:nonce_digest_mismatch. Steps 7 and 8 never run.
    expect(RECORDED_USDC_NONCE).not.toBe(nonceOf(envelope.preflight.artifactDigest));
    const reproduced = await reproduceObservationEnvelope(real.usdcAfter);
    const expected = {
      status: "not_anchored", reason: "nonce_digest_mismatch", stage: "anchor",
      preflightArtifactDigest: envelope.preflight.artifactDigest,
      observedNonce: "0x4a0189886fa9ad178790263a6625c1fdb1fd08a65671298ba6146dbb8584d0cd",
      afterFragmentDigest: reproduced.reproducedFragmentDigest,
      fixedBeforeExecution: false,
      nonClaims: ANCHOR_NON_CLAIMS,
    };
    const first = await verifyPreflightAnchor({ preflightEnvelope: envelope, afterEnvelope: real.usdcAfter });
    expect(first).toEqual(expected);
    const second = await verifyPreflightAnchor({ preflightEnvelope: envelope, afterEnvelope: real.usdcAfter });
    expect(second).toEqual(first);

    // The same verdict on the resolver-opstack fixture replayed directly through the existing evaluator.
    const direct = evaluateTransactionAcquisition(
      await replayTransactionAcquisition(USDC as unknown as Parameters<typeof replayTransactionAcquisition>[0], { includeTransaction: true })).fragment;
    const preflight = decodeNecWireJson("preflight-result", JSON.stringify(envelope.preflight));
    expect(matchPreflightAnchor(preflight, direct)).toMatchObject({
      status: expected.status, reason: expected.reason, observedNonce: expected.observedNonce, fixedBeforeExecution: false,
    });
    expect(fetchCalls).toBe(0);
  });

  it("envelope failures are propagated unchanged; never anchored", async () => {
    const base = real.basePreflight;
    const after = real.usdcAfter;
    const getter = json(after);
    Object.defineProperty(getter, "acquiredAt", { get: () => after.acquiredAt, enumerable: true });
    const preflightCases: [string, any][] = [
      ["mutated preflight self-digest", mutate(base, (p) => { p.preflight.artifactDigest = flip(p.preflight.artifactDigest); })],
      ["choice not by the caller", mutate(base, (p) => { p.choiceSource = "nec"; })],
      ["missing resolverManifest", mutate(base, (p) => { delete p.resolverManifest; })],
    ];
    for (const [name, envelope] of preflightCases) {
      const direct = verifyLivePreflightEnvelope(envelope);
      expect(direct.status).not.toBe("verified");
      const report = await verifyPreflightAnchor({ preflightEnvelope: envelope, afterEnvelope: after });
      expect([name, report.status, report.reason, report.stage]).toEqual([name, direct.status, direct.reason, "preflight_envelope"]);
      expect(report).toMatchObject({ observedNonce: null, afterFragmentDigest: null, fixedBeforeExecution: false });
    }
    const afterCases: [string, any][] = [
      ["unknown AFTER schema", mutate(after, (a) => { a.schema = "ne-mcp-observation-envelope/v0.2"; })],
      ["AFTER subject rebound to another transaction", mutate(after, (a) => { a.subject.txId = EVM.subject.txHash; })],
      ["AFTER capture digest tampered", mutate(after, (a) => {
        a.acquisition.captures[1].contentDigest = flip(a.acquisition.captures[1].contentDigest);
      })],
      ["AFTER accessor property", getter],
    ];
    for (const [name, envelope] of afterCases) {
      const direct = await reproduceObservationEnvelope(envelope);
      expect(direct.status).not.toBe("reproduced");
      const report = await verifyPreflightAnchor({ preflightEnvelope: base, afterEnvelope: envelope });
      expect([name, report.status, report.reason, report.stage]).toEqual([name, direct.status, direct.reason, "after_envelope"]);
      expect(report).toMatchObject({
        preflightArtifactDigest: base.preflight.artifactDigest, observedNonce: null, afterFragmentDigest: null, fixedBeforeExecution: false,
      });
    }
    expect(fetchCalls).toBe(0);
  });

  it("SIMULATED values are made up: absent from every checked-in JSON fixture", () => {
    const files = [...jsonFiles(join(ROOT, "packages")), ...jsonFiles(join(ROOT, "examples"))];
    expect(files.length).toBeGreaterThan(20);
    const needles = [...Object.values(SIM_UNITS).map((unit) => unit.repeat(2)), simPreflight().artifactDigest.slice("sha256:".length)];
    const offenders = files.flatMap((file) => {
      const text = readFileSync(file, "utf8").toLowerCase();
      return needles.filter((needle) => text.includes(needle)).map((needle) => `${file}: ${needle}`);
    });
    expect(offenders).toEqual([]);
  });

  it("SIMULATED pure-core cases (countsForGate:false) walk the frozen order", () => {
    const pf = simPreflight();
    expect(verifyPreflightResultIntegrity(pf)).toBe(true);
    expect(pf.status).toBe("unknown");
    const nonce = nonceOf(pf.artifactDigest);
    const flipped = flipBit(nonce);
    expect(flipped).not.toBe(nonce);
    const anchoredFragment = simFragment([{ address: SIM_TARGET, nonce, logIndex: 0 }]);

    // SIMULATED: the bound policy is edited (with a consistent new policy digest) but artifactDigest is left stale.
    const stale = structuredClone(pf) as PreflightResult;
    const editedPolicy = { ...SIM_POLICY_CONTENT, requiredDimensions: ["execution", "observedEffects"] as PolicyDimension[] };
    const editedDigest = computeEvidencePolicyDigest(editedPolicy);
    stale.request.evidencePolicy = { ...editedPolicy, digest: editedDigest };
    stale.evidencePolicy = { id: editedPolicy.id, version: editedPolicy.version, digest: editedDigest };
    expect(stale.artifactDigest).toBe(pf.artifactDigest);
    expect(verifyPreflightResultIntegrity(stale)).toBe(false);

    const cases: { name: string; label: "SIMULATED"; countsForGate: false; preflight: PreflightResult; fragment: NetworkEvidenceFragment;
      status: PreflightAnchorReport["status"]; reason: PreflightAnchorReport["reason"]; observedNonce: string | null }[] = [
      { name: "anchored", label: "SIMULATED", countsForGate: false, preflight: pf, fragment: anchoredFragment,
        status: "anchored", reason: "preflight_digest_committed_as_nonce", observedNonce: nonce },
      { name: "one-bit-flip twin", label: "SIMULATED", countsForGate: false, preflight: pf,
        fragment: simFragment([{ address: SIM_TARGET, nonce: flipped, logIndex: 0 }]),
        status: "not_anchored", reason: "nonce_digest_mismatch", observedNonce: flipped },
      { name: "duplicated log", label: "SIMULATED", countsForGate: false, preflight: pf,
        fragment: simFragment([{ address: SIM_TARGET, nonce, logIndex: 0 }, { address: SIM_TARGET, nonce, logIndex: 1 }]),
        status: "ambiguous", reason: "nonce_digest_multiple_matches", observedNonce: null },
      { name: "emitter different from target", label: "SIMULATED", countsForGate: false, preflight: pf,
        fragment: simFragment([{ address: SIM_OTHER_EMITTER, nonce, logIndex: 0 }]),
        status: "insufficient", reason: "emitter_unbound", observedNonce: null },
      // The nonce still equals the claimed (stale) artifactDigest; integrity fails first.
      { name: "policy edited, stale artifactDigest", label: "SIMULATED", countsForGate: false, preflight: stale, fragment: anchoredFragment,
        status: "diverged", reason: "preflight_integrity_failed", observedNonce: null },
      { name: "authorizer differs from request.account", label: "SIMULATED", countsForGate: false, preflight: pf,
        fragment: simFragment([{ address: SIM_TARGET, nonce, logIndex: 0, authorizer: SIM_OTHER_AUTHORIZER }]),
        status: "diverged", reason: "authorizer_mismatch", observedNonce: nonce },
      { name: "block time before preflight.generatedAt", label: "SIMULATED", countsForGate: false, preflight: pf,
        fragment: simFragment([{ address: SIM_TARGET, nonce, logIndex: 0 }], "2031-03-03T03:03:02.000Z"),
        status: "diverged", reason: "clock_inconsistent", observedNonce: nonce },
    ];
    for (const c of cases) {
      expect([c.label, c.countsForGate]).toEqual(["SIMULATED", false]);
      const report = matchPreflightAnchor(c.preflight, c.fragment);
      expect([c.name, report]).toEqual([c.name, {
        status: c.status, reason: c.reason, stage: "anchor",
        preflightArtifactDigest: pf.artifactDigest,
        observedNonce: c.observedNonce,
        afterFragmentDigest: sha256(encodeNecWireJson("network-evidence-fragment", c.fragment)),
        fixedBeforeExecution: c.status === "anchored",
        nonClaims: ANCHOR_NON_CLAIMS,
      }]);
    }
    expect(fetchCalls).toBe(0);
  });

  it("determinism: two runs give byte-identical reports, global fetch is never called and no clock is read", async () => {
    const pf = simPreflight();
    const anchoredFragment = simFragment([{ address: SIM_TARGET, nonce: nonceOf(pf.artifactDigest), logIndex: 0 }]);
    const RealDate = globalThis.Date;
    let clockReads = 0;
    const runs: string[] = [];
    globalThis.Date = new Proxy(RealDate, {
      construct(target, args, newTarget) {
        if (args.length === 0) clockReads += 1;
        return Reflect.construct(target, args, newTarget) as object;
      },
      apply(target, thisArg, args) {
        clockReads += 1;
        return Reflect.apply(target, thisArg, args) as unknown;
      },
      get(target, key, receiver) {
        if (key === "now") return () => { clockReads += 1; return target.now(); };
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    try {
      for (let i = 0; i < 2; i++) {
        runs.push(JSON.stringify([
          await verifyPreflightAnchor({ preflightEnvelope: real.basePreflight, afterEnvelope: real.usdcAfter }),
          await verifyPreflightAnchor({ preflightEnvelope: real.basePreflight, afterEnvelope: real.baseAfter }),
          await verifyPreflightAnchor({ preflightEnvelope: real.solanaPreflight, afterEnvelope: real.solanaAfter }),
          await verifyPreflightAnchor({ preflightEnvelope: real.sepoliaPreflight, afterEnvelope: real.baseAfter }),
          matchPreflightAnchor(pf, anchoredFragment),
        ]));
      }
    } finally {
      globalThis.Date = RealDate;
    }
    expect(runs[1]).toBe(runs[0]);
    expect(clockReads).toBe(0);
    expect(fetchCalls).toBe(0);
  });

  it("non-claims, README check order, tools/list and GT-02 stay as they are", () => {
    const nonClaims = ANCHOR_NON_CLAIMS.join(" ");
    expect(nonClaims).toMatch(/does not prove that the observed effects match the action, nor settlement, finality or any economic consequence/);
    expect(nonClaims).toMatch(/never makes efda0ca or any existing AFTER fixedBeforeExecution/);
    expect(nonClaims).toMatch(/not a preimage match/);
    expect(Object.isFrozen(ANCHOR_NON_CLAIMS) && Object.isFrozen(ANCHOR_CHECK_ORDER)).toBe(true);

    // The README lists the frozen order as status:reason, in the same order as the code.
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const start = readme.indexOf("## Pre-execution anchor verification");
    expect(start).toBeGreaterThan(0);
    const section = readme.slice(start);
    let at = -1;
    for (const [status, reason] of ANCHOR_CHECK_ORDER) {
      const next = section.indexOf(`\`${status}:${reason}\``, at + 1);
      expect([status, reason, next > at]).toEqual([status, reason, true]);
      at = next;
    }

    // No new MCP tool.
    expect(LIVE_TOOL_NAMES.some((name) => /anchor/i.test(name))).toBe(false);
    // GT-02 stays OPEN in the approval draft.
    const draft = readFileSync(new URL("../../../docs/distribution/MCP_PUBLIC_CONTRACT.md", import.meta.url), "utf8");
    expect(draft).toContain("The offline demo does not establish an authenticated or cryptographically anchored BEFORE.");
  });
});
