/**
 * READ-ONLY live BEFORE + Core Discovery bridge, opt-in in multichain mode.
 *
 * Uses only a freshly obtained exact-action observation from the shared
 * source-budgeted MCP resolver, and existing Core BEFORE + Discovery APIs.
 * Inability to fetch a candidate fails closed; it never manufactures a
 * "reachable" snapshot. No network ranking, selection or settlement.
 */
import { decodeNecWireJson, encodeNecWireJson, verifyDiscoverNetworksResult, isNecIdentifier } from "@nec/core";
import { parseTransactionHashInput } from "@nec/resolver-evm";
import { parseSignature } from "@nec/resolver-solana";
import type { DiscoveryRequirements, NetworkEvidenceFragment, CapabilitySnapshot } from "@nec/core";
import { discoverNetworks } from "@nec/discovery";
import type { DiscoveryCandidateContext } from "@nec/discovery";
import { deriveEvmBeforeFoundation } from "@nec/resolver-evm";
import { deriveSolanaBeforeFoundation, SOLANA_MAINNET_BEFORE_PROFILE, SOLANA_DEVNET_BEFORE_PROFILE } from "@nec/resolver-solana";
import { LIVE_MULTICHAIN_NETWORK_IDS } from "./live-multichain.js";
import type { MultichainTool, MultichainObservation, TransactionSubject } from "./live-multichain.js";
import { NeMcpError } from "./errors.js";

export const LIVE_BEFORE_TOOL_NAME = "discover_live_network_evidence";
export const LIVE_BEFORE_SCHEMA = "ne-mcp-live-discovery/v0.1";
export const LIVE_BEFORE_MAX_CANDIDATES = 2;
export const LIVE_BEFORE_MAX_AGE_MS = 180_000;
export const LIVE_BEFORE_MAX_OUTPUT_BYTES = 180_000;

export interface LiveBeforeInput {
  readonly requestId: string;
  readonly requirements: Record<string, unknown>;
  readonly subjects: readonly TransactionSubject[];
}

export interface LiveBeforeCandidateSummary {
  readonly id: string;
  readonly environment: "mainnet" | "testnet";
  readonly networkId: string;
  readonly classification: "eligible" | "conditional" | "ineligible";
  readonly observedAt: string;
  readonly sourceId: string;
  readonly sourceType: string;
  readonly snapshotId: string;
  readonly snapshotDigest: string;
  readonly resolver: { readonly id: string; readonly version: string; readonly digest: string };
  readonly evidenceCaptures: readonly { readonly rpcMethod: string; readonly contentDigest: string }[];
  readonly capabilities: CapabilitySnapshot["evidenceCapabilities"];
}

export interface LiveBeforeOutput {
  readonly schema: typeof LIVE_BEFORE_SCHEMA;
  readonly observationKind: "live_source_observation";
  readonly builtAndVerifiedBy: "@nec/discovery + @nec/core";
  readonly generatedAt: string;
  readonly result: Record<string, unknown>;
  readonly candidates: readonly LiveBeforeCandidateSummary[];
  readonly nonClaims: readonly string[];
}

const NETWORK_PROFILES = {
  "eip155:8453": { id: "base-mainnet", environment: "mainnet", family: "evm", chainId: 8453 },
  "eip155:84532": { id: "base-sepolia", environment: "testnet", family: "evm", chainId: 84532 },
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": { id: "solana-mainnet", environment: "mainnet", family: "solana" },
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1": { id: "solana-devnet", environment: "testnet", family: "solana" },
} as const;

function invalid(): never {
  throw new NeMcpError("MCP_LIVE_BEFORE_INPUT", "expected 1 or 2 distinct, fully identified Base or Solana transaction probes and valid Core DiscoveryRequirements");
}

function unavailable(): never {
  throw new NeMcpError("MCP_LIVE_BEFORE_UNAVAILABLE", "one or more exact live probe observations could not be established; no network availability claim was produced");
}

/** Does not claim more than a Core-validated observation and the backed paths. */
function foundationFromObservation(obs: MultichainObservation) {
  if (obs.observationKind !== "live_source_observation"
      || obs.artifactType !== "network-evidence-fragment"
      || obs.evidenceBasis !== "source_observation") unavailable();
  const profile = NETWORK_PROFILES[obs.subject.networkId];
  if (!profile || obs.source.networkId !== obs.subject.networkId) unavailable();
  const clock = Date.parse(obs.acquiredAt);
  if (!Number.isFinite(clock) || clock > Date.now() + 5_000 || Date.now() - clock > LIVE_BEFORE_MAX_AGE_MS) unavailable();
  let fragment: NetworkEvidenceFragment;
  try {
    fragment = decodeNecWireJson("network-evidence-fragment", JSON.stringify(obs.fragment));
  } catch { return unavailable(); }
  if (fragment.subject.type !== "transaction" || fragment.subject.networkId !== obs.subject.networkId
      || fragment.subject.txId !== obs.subject.txId || fragment.network.networkId !== obs.subject.networkId
      || !obs.acquisition.captures.length || !obs.acquisition.captures.every(c =>
        fragment.evidence.some(e => e.sourceId === obs.source.sourceId && e.contentDigest === c.contentDigest))) unavailable();
  const has = (method: string) => obs.acquisition.captures.some(c => c.rpcMethod === method);
  if (profile.family === "evm") {
    if (!obs.acquisition.consistent || obs.source.sourceType !== "evm_rpc"
        || obs.source.chainId !== profile.chainId
        || !has("eth_chainId") || !has("eth_getTransactionReceipt")
        || !has("eth_getTransactionByHash")) unavailable();
    return deriveEvmBeforeFoundation({ networkId: obs.subject.networkId, observation: {
      network: obs.subject.networkId, chainId: profile.chainId,
      source: { sourceId: obs.source.sourceId, sourceType: obs.source.sourceType },
      observedAt: obs.acquiredAt, rpcReachable: true,
      chainIdentityObserved: has("eth_chainId"),
      receiptLookupUsable: obs.acquisition.transactionObserved,
      blockLookupUsable: obs.acquisition.blockObserved,
      transactionLookupUsable: obs.acquisition.transactionLookupUsable === true,
      evidence: [...fragment.evidence],
    } });
  }
  if (obs.source.sourceType !== "svm_rpc" || !has("getGenesisHash") || !has("getTransaction") || !has("getSignatureStatuses")
      || obs.acquisition.solanaProbe === undefined) unavailable();
  const config = obs.subject.networkId === SOLANA_MAINNET_BEFORE_PROFILE.config.networkId
    ? SOLANA_MAINNET_BEFORE_PROFILE.config : SOLANA_DEVNET_BEFORE_PROFILE.config;
  if (fragment.network.genesisId !== config.genesisHash) unavailable();
  const beforeProbe = obs.acquisition.solanaProbe;
  return deriveSolanaBeforeFoundation({
    config, observationKind: "probe",
    observation: {
      network: obs.subject.networkId, source: { sourceId: obs.source.sourceId, sourceType: "svm_rpc" },
      observedAt: obs.acquiredAt, genesisHash: fragment.network.genesisId, rpcReachable: true,
      paths: beforeProbe.paths,
      finalizedCommitmentObserved: beforeProbe.finalizedCommitmentObserved,
      lookupsCoherent: beforeProbe.lookupsCoherent,
      evidence: [...fragment.evidence],
    },
  });
}

export function createLiveBeforeTool(resolve: MultichainTool): (input: LiveBeforeInput) => Promise<LiveBeforeOutput> {
  return async (input) => {
    if (!input || typeof input.requestId !== "string" || !isNecIdentifier(input.requestId) || !Array.isArray(input.subjects)
        || input.subjects.length < 1 || input.subjects.length > LIVE_BEFORE_MAX_CANDIDATES) invalid();
    let requirements: DiscoveryRequirements;
    try {
      requirements = decodeNecWireJson("discovery-requirements", JSON.stringify(input.requirements));
    } catch { return invalid(); }
    const subjects = input.subjects as readonly TransactionSubject[];
    // Validate the COMPLETE batch, including duplicates, before touching RPC.
    const ids = new Set<string>();
    for (const subject of subjects) {
      if (!subject || subject.type !== "transaction" || typeof subject.txId !== "string"
          || !LIVE_MULTICHAIN_NETWORK_IDS.includes(subject.networkId)) invalid();
      const profile = NETWORK_PROFILES[subject.networkId];
      if (!profile || ids.has(profile.id)) invalid();
      try {
        if (profile.family === "evm") parseTransactionHashInput(subject.txId);
        else parseSignature(subject.txId);
      } catch { invalid(); }
      ids.add(profile.id);
    }
    const candidates: DiscoveryCandidateContext[] = [];
    const observations: MultichainObservation[] = [];
    for (const subject of subjects) {
      const profile = NETWORK_PROFILES[subject.networkId];
      try {
        const observation = await resolve({ subject });
        if (observation.subject.networkId !== subject.networkId || observation.subject.txId !== subject.txId)
          unavailable();
        // source boundary already validated by resolve_transaction_evidence.
        const foundation = foundationFromObservation(observation);
        candidates.push({ id: profile.id, environment: profile.environment,
          network: foundation.network, manifest: foundation.manifest, snapshot: foundation.snapshot });
        observations.push(observation);
      } catch (error) {
        if (error instanceof NeMcpError && [
          "MCP_MULTICHAIN_RATE_LIMIT", "MCP_MULTICHAIN_TOO_LARGE",
          "MCP_LIVE_EVM_RATE_LIMIT", "MCP_LIVE_EVM_TOO_LARGE",
        ].includes(error.code)) throw error;
        return unavailable();
      }
    }
    try {
      const generatedAt = new Date().toISOString();
      const outcome = discoverNetworks({ requestId: input.requestId, generatedAt, requirements, candidates });
      if (!verifyDiscoverNetworksResult(outcome.result, outcome.verificationContext)) unavailable();
      const selected = outcome.candidates.map(c => {
        const ctx = candidates.find(x => x.id === c.id);
        const obs = observations.find(x => x.subject.networkId === c.networkId);
        if (!ctx || !obs) unavailable();
        return {
          id: c.id, environment: c.environment, networkId: c.networkId,
          classification: c.match.classification, observedAt: obs.acquiredAt,
          sourceId: obs.source.sourceId, sourceType: obs.source.sourceType,
          snapshotId: ctx.snapshot.id, snapshotDigest: ctx.snapshot.artifactDigest,
          resolver: { id: ctx.manifest.id, version: ctx.manifest.version, digest: ctx.manifest.digest },
          evidenceCaptures: obs.acquisition.captures.map(x => ({ rpcMethod: x.rpcMethod, contentDigest: x.contentDigest })),
          capabilities: ctx.snapshot.evidenceCapabilities,
        };
      });
      const response: LiveBeforeOutput = {
        schema: LIVE_BEFORE_SCHEMA, observationKind: "live_source_observation",
        builtAndVerifiedBy: "@nec/discovery + @nec/core", generatedAt,
        result: JSON.parse(encodeNecWireJson("discovery-result", outcome.result)) as Record<string, unknown>,
        candidates: selected,
        nonClaims: [
          "This classification uses exact fresh SOURCE-REPORTED RPC probe observations, not independent cryptographic verification or consensus.",
          "The time-bound availability and capability observations apply only to the probed action, source and collection instant. They are not uptime guarantees.",
          "An absent transaction/signature or pruned history is not proof of network unavailability; the relevant path remains insufficient.",
          "Generic EVM finality and settlement are not evaluated; Solana settlement is unsupported here and finalized commitment is source-reported only.",
          "A Core Discovery classification is not a recommendation, ranking or network choice; the caller must choose and preflight separately.",
          "The returned source refs/digests and Core result must not be interpreted as a complete Core NetworkEvidenceResult or Hub/Lens case.",
        ],
      };
      if (Buffer.byteLength(JSON.stringify(response)) > LIVE_BEFORE_MAX_OUTPUT_BYTES) unavailable();
      return response;
    } catch (error) {
      if (error instanceof NeMcpError) throw error;
      return unavailable();
    }
  };
}
