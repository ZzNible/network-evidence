/**
 * Hosted-only, read-only, caller-CHOSEN evidence preflight.
 *
 * Accepts an authentic, complete caller-supplied Core PreflightRequest and a
 * SAME-NETWORK, exact completed transaction as a capability probe only.
 * One new fixed-source observation is fed into the existing BEFORE resolver,
 * then Core builds/verifies a native PreflightResult against the complete
 * ResolverManifest + CapabilitySnapshot. No recommendation, wallet simulation,
 * expected-action inference, network transfer or full result fabrication.
 */
import {
  decodeNecWireJson, encodeNecWireJson, verifyCapabilitySnapshot,
  verifyPreflightResult,
} from "@nec/core";
import type { PreflightRequest, PreflightResult } from "@nec/core";
import { deriveEvmBeforePreflightResult, parseTransactionHashInput } from "@nec/resolver-evm";
import { deriveSolanaBeforePreflightResult, parseSignature } from "@nec/resolver-solana";
import { foundationFromObservation } from "./live-before.js";
import { LIVE_MULTICHAIN_NETWORK_IDS } from "./live-multichain.js";
import type { MultichainTool, TransactionSubject } from "./live-multichain.js";
import { NeMcpError } from "./errors.js";

export const LIVE_PREFLIGHT_TOOL_NAME = "preflight_live_network_evidence";
export const LIVE_PREFLIGHT_SCHEMA = "ne-mcp-live-preflight/v0.1";
export const LIVE_PREFLIGHT_MAX_INPUT_BYTES = 30_000;
export const LIVE_PREFLIGHT_MAX_OUTPUT_BYTES = 180_000;

export interface LivePreflightInput {
  /** Caller choice is NOT a Core Discovery recommendation. */
  readonly selectedNetworkId: TransactionSubject["networkId"];
  /** A previously completed exact transaction used ONLY as a fresh source probe. */
  readonly probeSubject: TransactionSubject;
  /** COMPLETE Core request: original expected action and caller's policy. */
  readonly request: unknown;
}
export interface LivePreflightOutput {
  readonly schema: typeof LIVE_PREFLIGHT_SCHEMA;
  readonly observationKind: "live_source_observation";
  readonly choiceSource: "caller";
  readonly selectedNetworkId: string;
  readonly probeSubject: TransactionSubject;
  readonly probeObservedAt: string;
  readonly source: { readonly sourceId: string; readonly sourceType: string };
  readonly evidenceCaptures: readonly { readonly rpcMethod: string; readonly contentDigest: string }[];
  readonly verifiedBy: "@nec/core";
  /** Self-digest and full-context verified native Core artifact, NOT a new schema. */
  readonly preflight: Record<string, unknown>;
  readonly capabilitySnapshot: Record<string, unknown>;
  readonly resolverManifest: Record<string, unknown>;
  readonly nonClaims: readonly string[];
}
function invalid(): never {
  throw new NeMcpError("MCP_LIVE_PREFLIGHT_INPUT",
    "expected one explicitly selected Base/Solana network, same-network canonical transaction probe and complete valid Core PreflightRequest with caller-supplied action/policy");
}
function unavailable(): never {
  throw new NeMcpError("MCP_LIVE_PREFLIGHT_UNAVAILABLE",
    "the exact completed source capability probe was not established; no network readiness conclusion was produced");
}
function contextInvalid(): never {
  throw new NeMcpError("MCP_LIVE_PREFLIGHT_CONTEXT_INVALID",
    "native preflight composition or complete Core-context verification failed; no provider outage/readiness verdict is inferred");
}
function tooLarge(): never {
  throw new NeMcpError("MCP_LIVE_PREFLIGHT_TOO_LARGE",
    "native preflight and complete context exceed bounded MCP output size");
}
function preserveOrUnavailable(error: unknown): never {
  if (error instanceof NeMcpError && [
    "MCP_MULTICHAIN_RATE_LIMIT", "MCP_MULTICHAIN_TOO_LARGE",
    "MCP_LIVE_EVM_RATE_LIMIT", "MCP_LIVE_EVM_TOO_LARGE",
  ].includes(error.code)) throw error;
  return unavailable();
}

/** One fixed read-only acquisition through the very same shared AFTER/BEFORE RPC budget. */
export function createLivePreflightTool(resolve: MultichainTool):
  (input: LivePreflightInput) => Promise<LivePreflightOutput> {
  return async (input) => {
    let request: PreflightRequest;
    const selected = input?.selectedNetworkId;
    const probe = input?.probeSubject;
    if (!input || !LIVE_MULTICHAIN_NETWORK_IDS.includes(selected) ||
      !probe || probe.type !== "transaction" || probe.networkId !== selected ||
      typeof probe.txId !== "string") invalid();
    // Fail entire input BEFORE the first network call, including the nested
    // original Core policy digest and exact intended action descriptor.
    try {
      const raw = JSON.stringify(input);
      if (Buffer.byteLength(raw) > LIVE_PREFLIGHT_MAX_INPUT_BYTES) invalid();
      if (Object.keys(input).some(k => !["selectedNetworkId", "probeSubject", "request"].includes(k))) invalid();
      if (Object.keys(probe).some(k => !["type", "networkId", "txId"].includes(k))) invalid();
      if (selected.startsWith("eip155:")) {
        if (!/^0x[0-9a-f]{64}$/.test(probe.txId)) invalid();
        parseTransactionHashInput(probe.txId);
      } else parseSignature(probe.txId);
      request = decodeNecWireJson("preflight-request", JSON.stringify(input.request));
    } catch { return invalid(); }
    if (request.networkId !== selected) invalid();

    let observation;
    try {
      observation = await resolve({subject:probe});
      if (observation.subject.networkId !== selected || observation.subject.txId !== probe.txId) unavailable();
      // A null/pruned/pending probe does NOT mean the network lacks the
      // ability to acquire evidence. Unlike Discovery's explicit unknown
      // candidates, this caller-selected readiness probe REQUIRES one
      // actually established completed exact action as source baseline.
      // Never turn absence of the user's example tx into network BLOCKED.
      const acquired = observation.acquisition;
      if (selected.startsWith("eip155:")) {
        if (!acquired.transactionObserved || !acquired.blockObserved ||
            acquired.transactionLookupUsable !== true || !acquired.consistent ||
            !acquired.captures.some(c => c.rpcMethod === "eth_getBlockByHash")) unavailable();
      } else {
        const path = acquired.solanaProbe;
        if (!acquired.transactionObserved || !acquired.blockObserved ||
            !acquired.consistent || path === undefined ||
            !path.lookupsCoherent || !path.finalizedCommitmentObserved ||
            !acquired.captures.some(c => c.rpcMethod === "getBlock") ||
            Object.keys(path.paths).length !== 4 ||
            !(["genesisidentity", "transaction", "signaturestatus", "finalizedblock"] as const)
              .every(k => path.paths[k] === "usable")) unavailable();
      }
    } catch (error) { return preserveOrUnavailable(error); }

    // Classify a source-probe failure separately from a native Core
    // construction/verification bug: both fail closed but neither is a
    // credible negative claim about the selected network.
    let context: ReturnType<typeof foundationFromObservation>;
    try { context = foundationFromObservation(observation); }
    catch { return unavailable(); }
    try {
      const { foundation } = context;
      if (foundation.network.networkId !== selected ||
          foundation.snapshot.network.networkId !== selected) contextInvalid();
      const preflight: PreflightResult = context.family === "evm"
        ? deriveEvmBeforePreflightResult(context.foundation, request)
        : deriveSolanaBeforePreflightResult(context.foundation, request);
      // Contextual (not only integrity) verification against COMPLETE
      // native manifest + snapshot; never accept naked caller digest checks.
      if (!verifyCapabilitySnapshot(foundation.snapshot, {
        resolver: foundation.manifest, networkId: selected,
      }) || !verifyPreflightResult(preflight, {
        resolver: foundation.manifest, capabilitySnapshot: foundation.snapshot,
      })) contextInvalid();
      // Core's contextual result verifier binds snapshot/manifest but does
      // not claim continuity with THIS caller's request. Require exact
      // canonical Core wire equality, not merely requestId/network equality.
      if (encodeNecWireJson("preflight-request", preflight.request) !==
            encodeNecWireJson("preflight-request", request) ||
          preflight.request.requestId !== request.requestId ||
          preflight.request.networkId !== selected ||
          preflight.network.networkId !== selected ||
          preflight.capabilitySnapshot?.digest !== foundation.snapshot.artifactDigest ||
          preflight.resolver.digest !== foundation.manifest.digest) contextInvalid();

      const saved = decodeNecWireJson("preflight-result",
        encodeNecWireJson("preflight-result", preflight));
      if (!verifyPreflightResult(saved, {
        resolver: foundation.manifest, capabilitySnapshot: foundation.snapshot,
      })) contextInvalid();

      const response: LivePreflightOutput = {
        schema: LIVE_PREFLIGHT_SCHEMA, observationKind: "live_source_observation",
        choiceSource: "caller", selectedNetworkId: selected, probeSubject: probe,
        probeObservedAt: observation.acquiredAt,
        source: { sourceId: observation.source.sourceId, sourceType: observation.source.sourceType },
        evidenceCaptures: observation.acquisition.captures.map(x => ({
          rpcMethod: x.rpcMethod, contentDigest: x.contentDigest,
        })),
        verifiedBy: "@nec/core",
        preflight: JSON.parse(encodeNecWireJson("preflight-result", saved)) as Record<string, unknown>,
        capabilitySnapshot: JSON.parse(
          encodeNecWireJson("capability-snapshot", foundation.snapshot)) as Record<string, unknown>,
        resolverManifest: JSON.parse(
          encodeNecWireJson("resolver-manifest", foundation.manifest)) as Record<string, unknown>,
        nonClaims: [
          "The selected network, intended action and evidence policy were supplied by the caller. NEC did not choose a network or independently verify the actor's original intent.",
          "Only a coherently observed completed probe is accepted. An absent, pruned, pending or unfinalized probe is reported as observation UNAVAILABLE, never as a reason to call the selected network blocked or incapable.",
          "The exact completed probe transaction only tests the configured source's evidence-read paths at the recorded time; it is NOT the future intended action, its execution, or an availability guarantee.",
          "Core preflight status is evidence READINESS, never wallet readiness, account balance, signing capability, gas funding, transaction execution, economic or protocol settlement.",
          "A not_applicable/blocked required policy dimension may reflect limits of this selected resolver's evidence vocabulary, NOT a finding that the entire blockchain network cannot implement that capability.",
          "Generic EVM preflight cannot evaluate OP Stack L2 finality or Ethereum L1 settlement; the separate optional AFTER OP Stack finality fragment does not confer preflight readiness.",
          "Solana finalized preflight is source-reported RPC commitment only, never independently cryptographically verified finality or economic irreversibility.",
          "The native PreflightResult and its context are NOT a full Core NetworkEvidenceResult and may not be admitted as a Hub/Lens case.",
        ],
      };
      if (Buffer.byteLength(JSON.stringify(response)) > LIVE_PREFLIGHT_MAX_OUTPUT_BYTES) tooLarge();
      return response;
    } catch (error) {
      if (error instanceof NeMcpError &&
          ["MCP_LIVE_PREFLIGHT_CONTEXT_INVALID", "MCP_LIVE_PREFLIGHT_TOO_LARGE"].includes(error.code)) throw error;
      return contextInvalid();
    }
  };
}
