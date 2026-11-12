/**
 * Hub/Lens admission boundary. Real AFTER outputs of the existing resolvers
 * are partial Core NetworkEvidenceFragments: no request, expected action,
 * policy, snapshot or self-digests exist for them, so Hub must refuse them on
 * every input kind and Lens must refuse them even inside a Hub-shaped record.
 * Conversely, Hub admission of a valid NetworkEvidenceResult is structural
 * only; it is NOT contextual verification (verifyNetworkEvidenceResult).
 *
 * Zero network I/O: fixtures are replayed through the resolvers' own replay
 * fetch, the hosted tool runs behind a fake provider that refuses undeclared
 * destinations (loopback MCP transport only), and global fetch throws.
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  NecValidationError,
  NecWireError,
  buildEvidenceSnapshot,
  computeEvidencePolicyDigest,
  computeResolverManifestDigest,
  decodeNecWireJson,
  encodeNecWireJson,
  verifyNetworkEvidenceResult,
} from "@nec/core";
import type {
  EvidencePolicy,
  EvidenceRequest,
  EvidenceSnapshot,
  Hex,
  NetworkEvidenceBuildContext,
  NetworkEvidenceFragment,
  NetworkEvidenceResult,
  ResolverManifest,
} from "@nec/core";
import { evaluateTransactionAcquisition, replayTransactionAcquisition } from "@nec/resolver-evm";
import {
  BASE_MAINNET_OPSTACK_BEFORE_PROFILE,
  evaluateOpStackFinality,
  replayOpStackFinalityObservation,
} from "@nec/resolver-opstack";
import { evaluateSolanaTransaction, replaySolanaTransaction } from "@nec/resolver-solana";

import { HUB_RECORD_SCHEMA_VERSION, normalizeNetworkEvidenceV01 } from "../../hub/src/index.js";
import type { HubNetworkEvidenceRecordV01 } from "../../hub/src/index.js";
import { buildLensCaseFromHubV01 } from "../../lens/src/index.js";
import {
  buildSyntheticCoreResult,
  buildSyntheticCoreWire,
  SYNTHETIC_SEMANTIC_DIGEST,
} from "../../../examples/integrability-fixture/golden-core.js";
import { startNeMcpHttpServer } from "../src/http.js";
import { createMultichainTool, LIVE_MULTICHAIN_TOOL } from "../src/live-multichain.js";
import { simulatedHostFetch } from "./helpers.js";

const json = (path: string): any => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const baseEvmRaw = json("./fixtures/base-mainnet-l2-finalized-positive-evm.json");
const baseOpRaw = json("./fixtures/base-mainnet-l2-finalized-positive-opstack.json");
const sepoliaRaw = json("../../resolver-evm/test/fixtures/sepolia-success.json");
const solanaRaw = json("../../resolver-solana/test/fixtures/solana-mainnet-x402-real.json");
const usdc = json("../../resolver-opstack/test/fixtures/base-mainnet-usdc-transfer.fixture.json");

const ORIGIN = "https://mcp.example.org", HOST = "mcp.example.org";
const EVM = "eip155:8453" as const, SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" as const;
const usdcSubject = { type: "transaction" as const, networkId: EVM, txId: usdc.subject.txHash as string };
const solSubject = { type: "transaction" as const, networkId: SOL, txId: solanaRaw.subject.signature as string };

const META = {
  caseId: "hub-admission-boundary",
  namespace: "nec.mcp.test",
  createdAt: "2026-10-07T00:00:00.000Z",
} as const;

// ---------------------------------------------------------------------------
// Verification context of the SYNTHETIC golden result. golden-core.ts keeps
// these builders private; the values below are copied verbatim and the
// positive control (verify === true) proves they are the exact context.
// ---------------------------------------------------------------------------
const T0 = "2026-01-01T00:00:00.000Z";
const AB32: Hex = `0x${"ab".repeat(32)}`;
const TX32: Hex = `0x${"11".repeat(32)}`;
const TARGET20: Hex = `0x${"aa".repeat(20)}`;
const POLICY_CONTENT: Omit<EvidencePolicy, "digest"> = {
  id: "payment-basic",
  version: "1",
  requiredDimensions: ["execution", "observedEffects"],
  desiredDimensions: ["finality"],
};
const MANIFEST_CONTENT: Omit<ResolverManifest, "digest"> = {
  id: "resolver-evm",
  version: "0.1.0",
  networkFamilies: ["eip155"],
  implementation: { package: "@nec/resolver-evm" },
  supportedCapabilities: ["execution", "observedEffects"],
  sourceRequirements: [{ sourceType: "evm_rpc", required: true }],
};

function policyOf(content: Omit<EvidencePolicy, "digest">): EvidencePolicy {
  return { ...content, digest: computeEvidencePolicyDigest(content) };
}

function snapshotOf(id: string, policy: EvidencePolicy, resolver: ResolverManifest): EvidenceSnapshot {
  const content: Omit<EvidenceSnapshot, "digest"> = {
    id,
    createdAt: T0,
    networkFingerprint: { networkId: "eip155:8453", chainId: 8453, observedAt: { blockNumber: 1000n, blockId: AB32 } },
    anchors: [{ networkId: "eip155:8453", blockNumber: 1000n, blockId: AB32, timestamp: T0, role: "execution_observation" }],
    evidence: [{
      id: "ev_receipt_1",
      sourceId: "src.rpc.primary",
      sourceType: "evm_rpc",
      retrievedAt: T0,
      contentDigest: `sha256:${"dd".repeat(32)}`,
      locator: "eth_getTransactionReceipt/0x11...",
      independenceGroup: "rpc-primary",
    }],
    resolverManifestDigest: resolver.digest,
    policyDigest: policy.digest,
  };
  return buildEvidenceSnapshot(content);
}

function requestOf(policy: EvidencePolicy, value: string): EvidenceRequest {
  return {
    schemaVersion: "0.1",
    requestId: "req_1",
    networkId: "eip155:8453",
    subject: { type: "transaction", networkId: "eip155:8453", txId: TX32 },
    action: { kind: "erc20.transfer", target: TARGET20, value },
    evidencePolicy: policy,
  };
}

function goldenContext(): NetworkEvidenceBuildContext {
  const policy = policyOf(POLICY_CONTENT);
  const resolver: ResolverManifest = { ...MANIFEST_CONTENT, digest: computeResolverManifestDigest(MANIFEST_CONTENT) };
  return { policy, resolver, snapshot: snapshotOf("snap_1", policy, resolver), request: requestOf(policy, "0") };
}

// ---------------------------------------------------------------------------
// Rejection helpers
// ---------------------------------------------------------------------------

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected the boundary to reject, but it admitted the input");
}

function expectCoreRejection(fn: () => unknown): void {
  const error = thrownBy(fn);
  // Rejected by Core validation/decoding authority, not by Hub envelope checks.
  expect(error instanceof NecValidationError || error instanceof NecWireError).toBe(true);
}

function hubShapedRecord(result: unknown, sourceType: string): HubNetworkEvidenceRecordV01 {
  return {
    schemaVersion: HUB_RECORD_SCHEMA_VERSION,
    sourceType,
    sourceSchemaVersion: "0.1",
    validation: { validator: "@nec/core", method: "validateNetworkEvidenceResult", wireProfile: null },
    result,
  } as unknown as HubNetworkEvidenceRecordV01;
}

/** Hub refuses `object` and `wire` under both input kinds and both wireTypes; Lens refuses it wrapped. */
function expectRejectedByHubAndLens(object: unknown, wire: string): void {
  expectCoreRejection(() =>
    normalizeNetworkEvidenceV01({ kind: "network_evidence_result", result: object as NetworkEvidenceResult }));
  expect(() => normalizeNetworkEvidenceV01({
    kind: "nec_wire_json_v1",
    wireType: "network-evidence-fragment",
    wire,
  } as never)).toThrow(/wireType must be network-evidence-result/);
  expectCoreRejection(() =>
    normalizeNetworkEvidenceV01({ kind: "nec_wire_json_v1", wireType: "network-evidence-result", wire }));

  expectCoreRejection(() =>
    buildLensCaseFromHubV01({ hubRecord: hubShapedRecord(object, "network_evidence_result"), ...META }));
  expect(() =>
    buildLensCaseFromHubV01({ hubRecord: hubShapedRecord(object, "network_evidence_fragment"), ...META }),
  ).toThrow(/incompatible Hub source record/);
}

function fragmentWire(fragment: NetworkEvidenceFragment): string {
  // Positive control: this is an authentic, Core-encodable fragment.
  return encodeNecWireJson("network-evidence-fragment", fragment);
}

const RESULT_ONLY_FIELDS = [
  "schemaVersion", "requestId", "generatedAt", "request", "action",
  "policy", "snapshot", "resolver", "semanticDigest", "artifactDigest",
] as const;

function expectFragmentShape(fragment: object): void {
  for (const key of RESULT_ONLY_FIELDS) expect(fragment).not.toHaveProperty(key);
}

// ---------------------------------------------------------------------------
// Real AFTER fragments
// ---------------------------------------------------------------------------

async function baseEvmFragment(): Promise<NetworkEvidenceFragment> {
  return evaluateTransactionAcquisition(await replayTransactionAcquisition(baseEvmRaw, { includeTransaction: true })).fragment;
}

async function realFragments(): Promise<Array<[string, NetworkEvidenceFragment]>> {
  const baseEvm = await baseEvmFragment();
  const sepolia = evaluateTransactionAcquisition(await replayTransactionAcquisition(sepoliaRaw)).fragment;
  const opStack = evaluateOpStackFinality({
    config: BASE_MAINNET_OPSTACK_BEFORE_PROFILE.config,
    evm: await replayTransactionAcquisition(baseEvmRaw, { includeTransaction: true }),
    finality: await replayOpStackFinalityObservation(baseOpRaw),
  }).fragment;
  const solana = evaluateSolanaTransaction(await replaySolanaTransaction(solanaRaw)).fragment;
  return [
    ["base mainnet EVM", baseEvm],
    ["sepolia-success EVM replay", sepolia],
    ["base mainnet OP Stack finality-only", opStack],
    ["solana mainnet x402 real", solana],
  ];
}

function capturedSources() {
  const methods: string[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const q = JSON.parse(init?.body as string) as { method: string; id: number };
    let fixture: any;
    if (url.includes("mainnet.base.org")) fixture = usdc;
    else if (url.includes("api.mainnet-beta.solana.com")) fixture = solanaRaw;
    else throw Error("not a declared fake RPC destination");
    const found = fixture.captures.find((c: any) => c.rpcMethod === q.method);
    if (!found) throw Error("unexpected RPC method " + q.method);
    methods.push(q.method);
    const result = new Response(JSON.stringify({ jsonrpc: "2.0", id: q.id, result: JSON.parse(found.resultJson) }), {
      status: 200, headers: { "content-type": "application/json" },
    });
    Object.defineProperty(result, "url", { value: new URL(url).href });
    return result;
  };
  return { fetchFn, methods };
}

const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async () => {
    throw new Error("network I/O is forbidden in hub-admission-boundary tests");
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("Hub/Lens admission boundary for real AFTER fragments", () => {
  it("rejects genuine EVM, OP Stack finality-only and Solana fragments on both Hub input kinds and in Lens", async () => {
    const fragments = await realFragments();
    expect(fragments.map(([, f]) => f.subject.networkId)).toEqual([EVM, "eip155:11155111", EVM, SOL]);
    const [, baseEvm] = fragments[0]!;
    const [, opStack] = fragments[2]!;
    expect(baseEvm.networkEvidence.execution?.verdict).toBe("supported");
    expect(opStack.networkEvidence.finality?.verdict).toBe("supported");
    expect(opStack.networkEvidence).not.toHaveProperty("execution");
    expect(opStack.networkEvidence).not.toHaveProperty("settlement");

    for (const [, fragment] of fragments) {
      expectFragmentShape(fragment);
      const wire = fragmentWire(fragment);
      expectRejectedByHubAndLens(fragment, wire);
      // The wire-decoded runtime object is rejected exactly the same way.
      expectRejectedByHubAndLens(decodeNecWireJson("network-evidence-fragment", wire), wire);
    }
  });

  it("rejects the hosted resolve_transaction_evidence structuredContent.fragment", async () => {
    const p = capturedSources();
    const server = await startNeMcpHttpServer({
      host: "127.0.0.1", port: 0, hosted: { publicOrigin: ORIGIN }, liveEvidence: createMultichainTool(p.fetchFn),
    });
    try {
      const hostFetch = simulatedHostFetch(server.port, HOST);
      for (const mode of ["legacy", "auto"] as const) {
        const client = new Client({ name: "hub-admission-boundary", version: "1" }, { versionNegotiation: { mode } });
        await client.connect(new StreamableHTTPClientTransport(new URL(ORIGIN + "/mcp"), { fetch: hostFetch }));
        try {
          for (const subject of [usdcSubject, solSubject]) {
            const out = await client.callTool({ name: LIVE_MULTICHAIN_TOOL, arguments: { subject } });
            expect(out.isError).toBeFalsy();
            const structured = out.structuredContent as Record<string, any>;
            expect(structured.artifactType).toBe("network-evidence-fragment");
            const fragment = structured.fragment as Record<string, unknown>;
            expectFragmentShape(fragment);
            const wire = JSON.stringify(fragment);
            const decoded = decodeNecWireJson("network-evidence-fragment", wire);
            expect(decoded.subject).toEqual(subject);
            expectRejectedByHubAndLens(fragment, wire);
            expectRejectedByHubAndLens(decoded, wire);
          }
        } finally {
          await client.close();
        }
      }
    } finally {
      await server.close();
    }
    expect(p.methods).toContain("eth_getTransactionReceipt");
    expect(p.methods).toContain("getTransaction");
  });

  it("rejects a fragment with pasted request/policy/snapshot/digest fields", async () => {
    const fragment = await baseEvmFragment();
    const golden = buildSyntheticCoreResult();
    const goldenWire = JSON.parse(buildSyntheticCoreWire()) as Record<string, unknown>;
    const fragmentWireObject = JSON.parse(fragmentWire(fragment)) as Record<string, any>;
    const pick = (source: Record<string, unknown>) =>
      Object.fromEntries(RESULT_ONLY_FIELDS.map((key) => [key, source[key]]));

    const pasted = { ...fragment, ...pick(golden as unknown as Record<string, unknown>) };
    const pastedWire = JSON.stringify({ ...fragmentWireObject, ...pick(goldenWire) });
    expectRejectedByHubAndLens(pasted, pastedWire);

    // Same paste with the absent dimensions back-filled from the golden result:
    // structurally complete, still not a Core result for this subject.
    const completed = {
      ...pasted,
      networkEvidence: { ...golden.networkEvidence, ...fragment.networkEvidence },
    };
    const completedWire = JSON.stringify({
      ...fragmentWireObject,
      ...pick(goldenWire),
      networkEvidence: { ...(goldenWire.networkEvidence as object), ...fragmentWireObject.networkEvidence },
    });
    expectRejectedByHubAndLens(completed, completedWire);
  });
});

describe("Hub admission is not contextual verification", () => {
  it("admits the golden synthetic result on both kinds while swapped context fails verifyNetworkEvidenceResult", () => {
    const records = [
      normalizeNetworkEvidenceV01({ kind: "network_evidence_result", result: buildSyntheticCoreResult() }),
      normalizeNetworkEvidenceV01({
        kind: "nec_wire_json_v1", wireType: "network-evidence-result", wire: buildSyntheticCoreWire(),
      }),
    ];
    const context = goldenContext();
    const swappedPolicy = policyOf({ ...POLICY_CONTENT, version: "2" });

    for (const hub of records) {
      expect(hub.result.semanticDigest).toBe(SYNTHETIC_SEMANTIC_DIGEST);
      expect(hub.validation).not.toHaveProperty("context");
      // Positive control: the reconstructed context is the exact golden context.
      expect(verifyNetworkEvidenceResult(hub.result, context)).toBe(true);
      expect(() => buildLensCaseFromHubV01({ hubRecord: hub, ...META })).not.toThrow();

      expect(verifyNetworkEvidenceResult(hub.result, { ...context, policy: swappedPolicy })).toBe(false);
      expect(verifyNetworkEvidenceResult(hub.result, {
        ...context, request: requestOf(context.policy, "1"),
      })).toBe(false);
      expect(verifyNetworkEvidenceResult(hub.result, {
        ...context, snapshot: snapshotOf("snap_2", context.policy, context.resolver),
      })).toBe(false);
    }
  });
});
