/**
 * NE-P3 case flow: the optional `evidenceContext` of resolve_transaction_evidence
 * (the tool handler's resolveWithOptionalClaim) -> its Core NetworkEvidenceResult
 * -> generic @nec/hub normalization -> generic @nec/lens case and browser
 * projection -> the generic NE Maps validator over a single-case collection.
 * No Maps, Hub, Lens or Core code is specific to this case, and nothing is
 * written: the shipped collection.json is untouched.
 *
 * Offline replay only: recorded Base mainnet and Solana mainnet RPC bytes are
 * served by a fake provider for the two fixed origins; global fetch throws.
 * Every BEFORE is SIMULATED_REPLAY_CLOCK with fixedBeforeExecution:false: the EVM
 * preflight probes the earlier F1 x402 #1062 transaction at a pinned clock
 * before the subject block, and the Solana pre-execution probe is a SIMULATED
 * null answer at a pinned clock. Core preflight continuity is not precedence
 * and not policy satisfaction; no case here is a genuine pre-execution action.
 */
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildNetworkEvidenceResult, computeEvidencePolicyDigest, decodeNecWireJson, encodeNecWireJson, verifyNetworkEvidenceResult,
} from "@nec/core";
import type {
  EvidencePolicy, EvidenceRequest, NecWireType, NetworkEvidenceBuildContext, NetworkEvidenceResultContent, PolicyDimension,
  PreflightRequest, PreflightResult,
} from "@nec/core";
import { normalizeNetworkEvidenceV01 } from "@nec/hub";
import {
  buildLensCaseFromHubV01, projectLensBrowserSafeV01, serializeLensBrowserSafeV01, serializeLensCaseV01, validateLensBrowserSafeCaseV01,
} from "@nec/lens";
import { deriveSolanaBeforePreflightResult } from "@nec/resolver-solana";

import { validateNeMapsCollectionV01 } from "../collection.js";
import { foundationFromObservation } from "../../../packages/mcp/src/live-before.js";
import { resolveWithOptionalClaim } from "../../../packages/mcp/src/live-claim.js";
import { createMultichainTool } from "../../../packages/mcp/src/live-multichain.js";
import type { TransactionSubject } from "../../../packages/mcp/src/live-multichain.js";
import { createLivePreflightTool } from "../../../packages/mcp/src/live-preflight.js";

interface Capture { rpcMethod: string; rpcParams: unknown[]; resultJson: string }
const json = (path: string): any => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const subjectRaw = json("../../../packages/mcp/test/fixtures/base-mainnet-l2-finalized-positive-evm.json");
const probeRaw = json(
  "../../historical-compat/authority/fixtures/F1-x402-1062-partial/source/network-evidence/fixtures/base-mainnet-x402-1062-usdc-transfer.fixture.json");
const solRaw = json("../../../packages/resolver-solana/test/fixtures/solana-mainnet-x402-real.json");

const BASE = "eip155:8453" as const;
const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" as const;
const EVM_SUBJECT: TransactionSubject = { type: "transaction", networkId: BASE, txId: subjectRaw.subject.txHash };
const EVM_PROBE: TransactionSubject = { type: "transaction", networkId: BASE, txId: probeRaw.subject.txHash };
const SOL_SUBJECT: TransactionSubject = { type: "transaction", networkId: SOL, txId: solRaw.subject.signature };

const EVM_PREFLIGHT_AT = "2026-10-09T15:00:00.000Z";
const EVM_BLOCK_AT = "2026-10-09T15:24:33.000Z";
const EVM_AFTER_AT = "2026-10-09T15:42:11.665Z";
const SOL_PREFLIGHT_AT = "2026-05-10T20:00:00.000Z";
const SOL_BLOCK_AT = "2026-05-10T20:29:19.000Z";
const SOL_AFTER_AT = "2026-08-26T20:01:41.884Z";
const LENS_CREATED_AT = "2026-11-02T00:00:00.000Z";

const REPLAY_LIMITATION =
  "SIMULATED_REPLAY_CLOCK: the BEFORE preflight was replayed under a pinned clock over recorded bytes (fixedBeforeExecution:false); Core preflight continuity is not precedence and not policy satisfaction.";
const REPLAY_PROVENANCE = {
  beforeClock: "SIMULATED_REPLAY_CLOCK",
  fixedBeforeExecution: "false",
  continuity: "Core preflight continuity only; not precedence, not policy satisfaction",
  path: "resolve_transaction_evidence evidenceResult -> @nec/hub -> @nec/lens -> lens-browser/v0.1",
  realityClass: "offline replay of pinned recorded captures; not a live observation",
} as const;

/** Core's exact resolver-evm-generic v0.1.0 data-binding proposition; the only source text Lens may display. */
const DATA_BINDING_PROPOSITION = "The acquired receipt binds to the requested subject transaction id.";
const ADMITTED_BINDING_CAVEAT =
  "Lens display caveat: this verdict covers only the exact proposition evaluated by resolver-evm-generic v0.1.0 for the requested subject transaction id; it is not the full requested action and does not establish transfer amount, accounts, calldata, authorization, policy satisfaction, settlement or finality.";
const ONE_SOURCE_CAVEAT =
  "Lens display caveat: every cited evidence reference is an evm_rpc observation from one source in one declared independence group; this is a single-source observation, not independent corroboration or consensus.";
const SUPPORTED_GENERIC_CAVEAT =
  "Lens display caveat: this data-binding verdict covers only the source resolver's specific evaluated proposition, not the full requested action, its terms or authorization.";
const WITHHELD_CAVEAT =
  "Lens display caveat: source resolver proposition metadata is not admitted for browser display and is withheld; this generic statement does not restate the evaluated proposition.";
const SUPPORTED_GENERIC_STATEMENT = "Network Evidence data-binding assessment of the source resolver's specific evaluated proposition.";

/** Offline replay: Base by exact method+params, Solana by method; `solanaBeforeExecution` is SIMULATED. */
function provider(options: { solanaBeforeExecution?: boolean } = {}) {
  const baseCaptures = [...(subjectRaw.captures as Capture[]), ...(probeRaw.captures as Capture[])];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).href;
    const query = JSON.parse(init?.body as string) as { id: number; method: string; params?: unknown[] };
    let resultText: string;
    if (url === "https://mainnet.base.org/") {
      const params = JSON.stringify(query.params ?? []);
      const found = baseCaptures.find(c => c.rpcMethod === query.method && JSON.stringify(c.rpcParams) === params);
      if (!found) throw new Error("undeclared Base read");
      resultText = found.resultJson;
    } else if (url === "https://api.mainnet-beta.solana.com/") {
      const found = (solRaw.captures as Capture[]).find(c => c.rpcMethod === query.method);
      if (!found) throw new Error("undeclared Solana read");
      let result: unknown = JSON.parse(found.resultJson);
      if (options.solanaBeforeExecution) {
        if (query.method === "getTransaction" || query.method === "getBlock") result = null;
        if (query.method === "getSignatureStatuses") (result as { value: unknown[] }).value = [null];
      }
      resultText = JSON.stringify(result);
    } else throw new Error("undeclared destination");
    const response = new Response(`{"jsonrpc":"2.0","id":${JSON.stringify(query.id)},"result":${resultText}}`,
      { status: 200, headers: { "content-type": "application/json" } });
    Object.defineProperty(response, "url", { value: url });
    return response;
  };
  return { fetchFn };
}

const realFetch = globalThis.fetch;
let globalFetchCalls = 0;
beforeAll(() => {
  globalThis.fetch = (async () => {
    globalFetchCalls += 1;
    throw new Error("network I/O is forbidden in the live-result case flow");
  }) as typeof fetch;
});
afterAll(() => { globalThis.fetch = realFetch; });
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); });
afterEach(() => {
  vi.useRealTimers();
  expect(globalFetchCalls).toBe(0);
});

function at(iso: string): void {
  vi.setSystemTime(new Date(iso));
}
function wire(type: NecWireType, value: unknown): Record<string, unknown> {
  return JSON.parse(encodeNecWireJson(type, value)) as Record<string, unknown>;
}
function policyOf(content: Omit<EvidencePolicy, "digest">): EvidencePolicy {
  return { ...content, digest: computeEvidencePolicyDigest(content) };
}
/** Test-authored caller request (NOT an original caller's action or policy). */
function preflightRequest(networkId: string, required: PolicyDimension[], desired: PolicyDimension[] = []): PreflightRequest {
  return {
    schemaVersion: "0.1", requestId: "ne-p3-maps-preflight", networkId,
    action: networkId === BASE
      ? { kind: "evm.transaction", target: "0x4200000000000000000000000000000000000015", fields: { expectedStatus: "success" } }
      : { kind: "spl_token.transfer_checked", target: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", fields: { expectedAmount: "5000" } },
    evidencePolicy: policyOf({ id: "ne-p3-maps-policy", version: "1", requiredDimensions: required, desiredDimensions: desired }),
  };
}
function callerContext(subject: TransactionSubject, preflightWire: Record<string, unknown>, capabilitySnapshot: Record<string, unknown>) {
  const preflight: PreflightResult = decodeNecWireJson("preflight-result", JSON.stringify(preflightWire));
  const request: EvidenceRequest = {
    schemaVersion: "0.1", requestId: "ne-p3-maps-result", networkId: subject.networkId,
    subject: { type: "transaction", networkId: subject.networkId, txId: subject.txId },
    action: preflight.request.action,
    evidencePolicy: preflight.request.evidencePolicy,
    preflight: { requestId: preflight.request.requestId, digest: preflight.artifactDigest },
  };
  return { request: wire("evidence-request", request), preflight: preflightWire, capabilitySnapshot };
}

/** One served AFTER with a SIMULATED_REPLAY_CLOCK BEFORE, through the tool handler path. */
async function servedCase(family: "evm" | "solana") {
  let raw: ReturnType<typeof callerContext>;
  let subject: TransactionSubject;
  if (family === "evm") {
    at(EVM_PREFLIGHT_AT);
    const pre = await createLivePreflightTool(createMultichainTool(provider().fetchFn))({
      selectedNetworkId: BASE, probeSubject: EVM_PROBE, request: preflightRequest(BASE, ["execution", "dataBinding"], ["finality"]),
    });
    raw = callerContext(EVM_SUBJECT, pre.preflight, pre.capabilitySnapshot);
    subject = EVM_SUBJECT;
    at(EVM_AFTER_AT);
  } else {
    at(SOL_PREFLIGHT_AT);
    const probe = await createMultichainTool(provider({ solanaBeforeExecution: true }).fetchFn)({ subject: SOL_SUBJECT });
    expect(probe.acquisition).toMatchObject({ transactionObserved: false, blockObserved: false });
    const source = foundationFromObservation(probe);
    if (source.family !== "solana") throw new Error("expected the Solana BEFORE foundation");
    const preflight = deriveSolanaBeforePreflightResult(source.foundation, preflightRequest(SOL, ["execution", "finality"]));
    raw = callerContext(SOL_SUBJECT, wire("preflight-result", preflight), wire("capability-snapshot", source.foundation.snapshot));
    subject = SOL_SUBJECT;
    at(SOL_AFTER_AT);
  }
  const out = await resolveWithOptionalClaim(createMultichainTool(provider().fetchFn), { subject, evidenceContext: raw });
  return { raw, out, subject };
}

const CASES = [
  { family: "evm", caseId: "ne-p3-base-mainnet-replay", label: "Base mainnet", preflightAt: EVM_PREFLIGHT_AT, blockAt: EVM_BLOCK_AT,
    unknown: ["settlement", "finality"], warning: "EVM_DIMENSIONS_NOT_EVALUATED" },
  { family: "solana", caseId: "ne-p3-solana-mainnet-replay", label: "Solana mainnet", preflightAt: SOL_PREFLIGHT_AT, blockAt: SOL_BLOCK_AT,
    unknown: ["settlement"], warning: "SOLANA_SETTLEMENT_NOT_EVALUATED" },
] as const;

describe("evidenceContext result -> Core -> Hub -> Lens -> generic NE Maps (SIMULATED_REPLAY_CLOCK)", () => {
  it.each(CASES)("$label: Core re-verifies, Hub and Lens preserve digests, the single-case Maps collection validates", async (c) => {
    const { raw, out, subject } = await servedCase(c.family);
    const evidenceResult = out.evidenceResult;
    if (evidenceResult?.status !== "composed") throw new Error(`expected a composed result, got ${JSON.stringify(evidenceResult)}`);

    // Core: decode the served wire and re-verify with the complete caller context.
    const wireText = JSON.stringify(evidenceResult.result);
    const result = decodeNecWireJson("network-evidence-result", wireText);
    const snapshot = decodeNecWireJson("evidence-snapshot", JSON.stringify(evidenceResult.evidenceSnapshot));
    const manifest = decodeNecWireJson("resolver-manifest", JSON.stringify(evidenceResult.resolverManifest));
    const request = decodeNecWireJson("evidence-request", JSON.stringify(raw.request));
    const preflight = decodeNecWireJson("preflight-result", JSON.stringify(raw.preflight));
    const capabilitySnapshot = decodeNecWireJson("capability-snapshot", JSON.stringify(raw.capabilitySnapshot));
    expect(verifyNetworkEvidenceResult(result, {
      policy: request.evidencePolicy, snapshot, resolver: manifest, request, preflight,
      preflightContext: { resolver: manifest, capabilitySnapshot },
    })).toBe(true);
    expect(result.subject).toEqual(subject);

    // SIMULATED_REPLAY_CLOCK BEFORE: pinned clock, before the block; never claimed as precedence.
    expect(preflight.generatedAt).toBe(c.preflightAt);
    expect(result.network.observedAt.timestamp).toBe(c.blockAt);
    expect(Date.parse(preflight.generatedAt)).toBeLessThan(Date.parse(c.blockAt));
    expect(evidenceResult.nonClaims.join(" ")).toMatch(/Continuity is not precedence/);
    expect(evidenceResult.nonClaims.join(" ")).toMatch(/not policy satisfaction/);

    // Hub: both generic admission kinds keep the Core digests.
    const hubs = [
      normalizeNetworkEvidenceV01({ kind: "nec_wire_json_v1", wireType: "network-evidence-result", wire: wireText }),
      normalizeNetworkEvidenceV01({ kind: "network_evidence_result", result }),
    ];
    for (const hub of hubs) {
      expect(hub.result.artifactDigest).toBe(result.artifactDigest);
      expect(hub.result.semanticDigest).toBe(result.semanticDigest);
      expect(hub.result.networkEvidence).toEqual(result.networkEvidence);
    }
    // The AFTER fragment alone is still refused by Hub: only the Core result enters.
    expect(() => normalizeNetworkEvidenceV01({
      kind: "nec_wire_json_v1", wireType: "network-evidence-result", wire: JSON.stringify(out.fragment),
    })).toThrow();

    // Lens: generic case from either Hub record, digests preserved, replay label carried as a limitation.
    const meta = { caseId: c.caseId, namespace: "nec.mcp.evidence-context", createdAt: LENS_CREATED_AT, limitations: [REPLAY_LIMITATION] };
    const lensCases = hubs.map(hubRecord => buildLensCaseFromHubV01({ hubRecord, ...meta }));
    expect(JSON.stringify(lensCases[1])).toBe(JSON.stringify(lensCases[0]));
    const lensCase = lensCases[0]!;
    expect(lensCase.coreResultPreservation?.sourceArtifactDigest).toBe(result.artifactDigest);
    expect(lensCase.coreResultPreservation?.sourceSemanticDigest).toBe(result.semanticDigest);
    expect(lensCase.coreResultPreservation?.resolver).toEqual(result.resolver);
    expect(lensCase.limitations).toContain(REPLAY_LIMITATION);
    const browser = projectLensBrowserSafeV01(lensCase);
    expect(() => validateLensBrowserSafeCaseV01(browser)).not.toThrow();
    expect(browser.coreResultPreservation?.sourceArtifactDigest).toBe(result.artifactDigest);
    expect(browser.coreResultPreservation?.sourceSemanticDigest).toBe(result.semanticDigest);
    expect(browser.coreResultPreservation?.warningCodes).toContain(c.warning);

    // Unavailable dimensions stay unknown with no assessment; execution keeps its Core verdict.
    const byId = new Map(browser.propositions.map(p => [p.propositionId, p]));
    expect(byId.get("network.execution")?.assessments.map(a => a.value)).toEqual([result.networkEvidence.execution.verdict]);
    for (const name of c.unknown) {
      expect(result.networkEvidence[name]).toMatchObject({ applicability: "unknown", basis: [], evidence: [] });
      expect(result.networkEvidence[name]).not.toHaveProperty("verdict");
      expect(result.networkEvidence[name].reason).toMatch(new RegExp(`^${c.warning}: `));
      expect(byId.get(`network.${name}`)?.assessments).toEqual([]);
      expect(byId.get(`network.${name}`)?.availability).toBe("unknown");
    }

    // dataBinding: Core's verdict, basis and evidence copied unchanged; source text shown only for the
    // exact resolver-evm-generic v0.1.0 proposition; dimension metadata itself is never exported.
    const coreBinding = result.networkEvidence.dataBinding;
    const binding = byId.get("network.dataBinding")!;
    expect(coreBinding.verdict).toBe("supported");
    expect(binding.assessments).toHaveLength(1);
    expect(binding.assessments[0]).toMatchObject({
      value: coreBinding.verdict, basis: [...coreBinding.basis], evidenceRefs: coreBinding.evidence.map(id => `core-evidence:${id}`),
    });
    expect(binding.assessments[0]!.limitations).toEqual(binding.limitations);
    expect(binding).not.toHaveProperty("metadata");
    if (c.family === "evm") {
      expect(result.resolver).toMatchObject({ id: "resolver-evm-generic", version: "0.1.0" });
      expect(coreBinding.metadata).toEqual({ proposition: DATA_BINDING_PROPOSITION });
      const cited = coreBinding.evidence.map(id => result.evidence.find(ref => ref.id === id)!);
      expect(cited.length).toBeGreaterThan(0);
      for (const ref of cited) {
        expect(ref).toMatchObject({ sourceType: "evm_rpc", sourceId: cited[0]!.sourceId, independenceGroup: cited[0]!.independenceGroup });
        expect(ref.independenceGroup).toBeDefined();
      }
      expect(binding.statement).toBe(DATA_BINDING_PROPOSITION);
      expect(binding.limitations).toEqual([ADMITTED_BINDING_CAVEAT, ONE_SOURCE_CAVEAT]);
    } else {
      expect(result.resolver.id).not.toBe("resolver-evm-generic");
      expect(binding.statement).toBe(SUPPORTED_GENERIC_STATEMENT);
      expect(binding.limitations).toEqual([SUPPORTED_GENERIC_CAVEAT, WITHHELD_CAVEAT]);
      expect(serializeLensBrowserSafeV01(browser)).not.toContain(DATA_BINDING_PROPOSITION);
    }

    // Generic NE Maps: one case, the public Lens validator injected, labels kept as presentation-only provenance.
    const collection = {
      schemaVersion: "ne-maps-case-collection/v0.1",
      TARGET_CORE_MUTATIONS: 0,
      nonClaims: [
        "Maps does not resolve network evidence.",
        "Every BEFORE in this case is SIMULATED_REPLAY_CLOCK (fixedBeforeExecution:false); Core preflight continuity is not precedence and not policy satisfaction.",
        "Settlement and unevaluated finality are not established; missing is never zero.",
      ],
      cases: [{
        schemaVersion: "ne-maps-case/v0.1",
        id: c.caseId,
        display: {
          networkLabel: `${c.label} — SIMULATED_REPLAY_CLOCK replay, not a live observation`,
          title: `${c.label} evidenceContext replay — Core → Hub → Lens`,
          shape: "Offline replay · resolve_transaction_evidence evidenceResult · generic path",
        },
        exactAction: {
          kind: subject.type,
          networkId: subject.networkId,
          id: subject.txId,
          realityClass: "recorded AFTER replayed offline; BEFORE is SIMULATED_REPLAY_CLOCK, fixedBeforeExecution:false",
        },
        trailPropositionOrder: browser.propositions.map(p => p.propositionId),
        lens: JSON.parse(serializeLensBrowserSafeV01(browser)),
        extensions: { provenance: { ...REPLAY_PROVENANCE } },
      }],
    };
    expect(validateNeMapsCollectionV01(collection, { validateLens: lens => validateLensBrowserSafeCaseV01(lens) })).toBe(collection);
    expect(JSON.stringify(collection)).not.toMatch(/fixedBeforeExecution"\s*:\s*true/);
    const mapsBinding = collection.cases[0]!.lens.propositions.find((p: { propositionId: string }) => p.propositionId === "network.dataBinding");
    expect(mapsBinding.statement).toBe(c.family === "evm" ? DATA_BINDING_PROPOSITION : SUPPORTED_GENERIC_STATEMENT);
  });

  it("Solana same-phrase spoof (SIMULATED Core-valid rebuild): Core accepts it, Lens keeps the generic statement and never exports it", async () => {
    const { raw, out } = await servedCase("solana");
    const evidenceResult = out.evidenceResult;
    if (evidenceResult?.status !== "composed") throw new Error(`expected a composed result, got ${JSON.stringify(evidenceResult)}`);
    const served = decodeNecWireJson("network-evidence-result", JSON.stringify(evidenceResult.result));
    const snapshot = decodeNecWireJson("evidence-snapshot", JSON.stringify(evidenceResult.evidenceSnapshot));
    const manifest = decodeNecWireJson("resolver-manifest", JSON.stringify(evidenceResult.resolverManifest));
    const request = decodeNecWireJson("evidence-request", JSON.stringify(raw.request));
    const preflight = decodeNecWireJson("preflight-result", JSON.stringify(raw.preflight));
    const capabilitySnapshot = decodeNecWireJson("capability-snapshot", JSON.stringify(raw.capabilitySnapshot));
    const context: NetworkEvidenceBuildContext = {
      policy: request.evidencePolicy, snapshot, resolver: manifest, request, preflight,
      preflightContext: { resolver: manifest, capabilitySnapshot },
    };
    expect(served.subject.networkId).toBe(SOL);
    expect(served.resolver.id).not.toBe("resolver-evm-generic");
    expect(served.networkEvidence.dataBinding.metadata).not.toEqual({ proposition: DATA_BINDING_PROPOSITION });

    // SIMULATED: only the dataBinding metadata is replaced by the exact EVM proposition; Core rebuilds and verifies it.
    const { request: _request, semanticDigest: _semantic, artifactDigest: _artifact, ...content } = served;
    const spoofed = buildNetworkEvidenceResult({
      ...content,
      snapshot: { id: snapshot.id, digest: snapshot.digest },
      networkEvidence: {
        ...content.networkEvidence,
        dataBinding: { ...content.networkEvidence.dataBinding, metadata: { proposition: DATA_BINDING_PROPOSITION } },
      },
    } as unknown as NetworkEvidenceResultContent, context);
    expect(verifyNetworkEvidenceResult(spoofed, context)).toBe(true);
    expect(spoofed.networkEvidence.dataBinding.metadata).toEqual({ proposition: DATA_BINDING_PROPOSITION });
    expect(spoofed.networkEvidence.dataBinding.verdict).toBe("supported");

    const hubRecord = normalizeNetworkEvidenceV01({ kind: "network_evidence_result", result: spoofed });
    const lensCase = buildLensCaseFromHubV01({
      hubRecord, caseId: "ne-gt02-solana-spoof", namespace: "nec.mcp.evidence-context", createdAt: LENS_CREATED_AT, limitations: [REPLAY_LIMITATION],
    });
    const browser = projectLensBrowserSafeV01(lensCase);
    expect(() => validateLensBrowserSafeCaseV01(browser)).not.toThrow();
    expect(browser.coreResultPreservation?.sourceArtifactDigest).toBe(spoofed.artifactDigest);
    const binding = browser.propositions.find(p => p.propositionId === "network.dataBinding")!;
    expect(binding.statement).toBe(SUPPORTED_GENERIC_STATEMENT);
    expect(binding.limitations).toEqual([SUPPORTED_GENERIC_CAVEAT, WITHHELD_CAVEAT]);
    expect(binding.assessments.map(a => a.value)).toEqual(["supported"]);
    expect(serializeLensCaseV01(lensCase)).not.toContain(DATA_BINDING_PROPOSITION);
    expect(serializeLensBrowserSafeV01(browser)).not.toContain(DATA_BINDING_PROPOSITION);
  });
});
