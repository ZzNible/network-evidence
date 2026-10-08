/**
 * `discover_network_candidates`: a thin MCP boundary over the public
 * `@nec/discovery` orchestrator.
 *
 *   caller JSON (nec-wire-json-v1 Core artifacts)
 *     -> Core `decodeNecWireJson` (strict parse, bigint positions, Core validation)
 *     -> `discoverNetworks` (Core binding gate, Core classification, Core build + verify)
 *     -> Core `verifyDiscoverNetworksResult` once more at this boundary
 *     -> Core `encodeNecWireJson("discovery-result")` for the reply.
 *
 * This module never classifies, scores, ranks, recommends or chooses. Every
 * classification in the reply is copied from the Core-built, Core-verified
 * result. The outcome depends ONLY on the snapshots the caller supplied; this
 * server observed nothing.
 */

import { canonicalJson, decodeNecWireJson, encodeNecWireJson, verifyDiscoverNetworksResult, WIRE_PROFILE } from "@nec/core";
import type { CapabilitySnapshot, NecWireDecoded, NecWireType } from "@nec/core";
import { discoverNetworks } from "@nec/discovery";
import type { DiscoverNetworksOutcome, DiscoveryCandidateContext, DiscoveryEnvironment, DiscoveryScope } from "@nec/discovery";

import { NeMcpError } from "./errors.js";
import { fixedProfileEnvironments } from "./profiles.js";

export const DISCOVERY_SCHEMA = "ne-mcp-discovery/v0.1";

/** Maximum explicit candidate contexts per call (also enforced by the input schema). */
export const MAX_DISCOVERY_CANDIDATES = 16;

export interface DiscoverToolCandidate {
  readonly id: string;
  readonly environment: DiscoveryEnvironment;
  readonly network: Record<string, unknown>;
  readonly manifest: Record<string, unknown>;
  readonly snapshot: Record<string, unknown>;
}

export interface DiscoverToolInput {
  readonly requestId: string;
  readonly generatedAt: string;
  readonly requirements: Record<string, unknown>;
  readonly candidates: readonly DiscoverToolCandidate[];
  readonly scope?: DiscoveryScope | undefined;
}

export const DISCOVERY_QUALIFICATION: readonly string[] = Object.freeze([
  "Every classification was computed by @nec/core (composeDiscoveryMatch) through @nec/discovery and the result was built and verified by @nec/core; this MCP server does not classify.",
  "The outcome depends ONLY on the network/manifest/CapabilitySnapshot contexts supplied in this request. This server performed no network I/O and observed nothing; it cannot tell whether a supplied snapshot came from a live probe, a synthetic demo or an archived replay beyond what the snapshot itself records.",
  "Availability statements are those recorded in the supplied snapshots at their own generatedAt / observedAt times. They are not current (live) availability. Archived replay keeps current availability 'unknown'.",
  "Current support is not current availability. Resolver-manifest membership is not live availability.",
  "Network Evidence does not choose, score, rank or recommend. Candidate order is presentation-id order only. The caller chooses externally and must then run the resolver-specific evidence preflight for its chosen network.",
  "Finality is not settlement. No settlement, economic-irreversibility or live finality claim is made.",
  "The environment label is the caller's presentation metadata; it never changes a Core classification.",
]);

function decodeWire<T extends NecWireType>(type: T, value: unknown, path: string): NecWireDecoded[T] {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch (error) {
    throw new NeMcpError("MCP_INPUT_INVALID", `${path} is not JSON-serializable`, { cause: error });
  }
  try {
    return decodeNecWireJson(type, text);
  } catch (error) {
    throw new NeMcpError(
      "MCP_WIRE_DECODE_FAILED",
      `${path} was rejected by @nec/core as a ${type} in ${WIRE_PROFILE} form`,
      { cause: error },
    );
  }
}

function canonical(value: unknown, path: string): string {
  try {
    return canonicalJson(value);
  } catch (error) {
    throw new NeMcpError("MCP_INPUT_INVALID", `${path} is not a canonicalizable JSON value`, { cause: error });
  }
}

function declaredObservationKind(snapshot: CapabilitySnapshot): string | null {
  const kind = snapshot.network.metadata?.observationKind;
  return typeof kind === "string" ? kind : null;
}

function evidenceSourceIds(snapshot: CapabilitySnapshot): string[] {
  return [...new Set(snapshot.evidence.map((ref) => ref.sourceId))].sort();
}

/** Decode one caller candidate into the explicit Core context @nec/discovery consumes. */
function toContext(
  candidate: DiscoverToolCandidate,
  index: number,
  environments: ReadonlyMap<string, string>,
): DiscoveryCandidateContext {
  const path = `candidates[${index}]`;
  const manifest = decodeWire("resolver-manifest", candidate.manifest, `${path}.manifest`);
  const snapshot = decodeWire("capability-snapshot", candidate.snapshot, `${path}.snapshot`);
  // Core has no standalone wire type for NetworkFingerprint. Core Discovery
  // requires FULL fingerprint equality between the candidate network and the
  // snapshot's network, so the caller's wire `network` must be canonically
  // identical to the wire `snapshot.network` that Core just decoded; the
  // decoded fingerprint is then the candidate network (Core re-checks equality).
  const wireSnapshotNetwork = (candidate.snapshot as { network?: unknown }).network;
  if (canonical(candidate.network, `${path}.network`) !== canonical(wireSnapshotNetwork, `${path}.snapshot.network`)) {
    throw new NeMcpError(
      "MCP_CANDIDATE_NETWORK_MISMATCH",
      `${path}.network is not canonically identical to ${path}.snapshot.network (full fingerprint equality required; same networkId alone is insufficient)`,
    );
  }
  // MCP presentation guard: a label may not contradict the fixed public profile
  // inventory (e.g. zkSYS Tanenbaum labelled "mainnet"). Unknown networks keep
  // the caller's label as presentation metadata. Never passed to Core.
  const fixed = environments.get(snapshot.network.networkId);
  if (fixed !== undefined && fixed !== candidate.environment) {
    throw new NeMcpError(
      "MCP_ENVIRONMENT_LABEL_CONFLICT",
      `${path}.environment ${JSON.stringify(candidate.environment)} contradicts the fixed public profile for ${snapshot.network.networkId} (${JSON.stringify(fixed)})`,
    );
  }
  return { id: candidate.id, environment: candidate.environment, network: snapshot.network, manifest, snapshot };
}

export interface DiscoverToolOutput {
  readonly schema: typeof DISCOVERY_SCHEMA;
  readonly liveObservation: false;
  readonly networkChoice: string;
  readonly qualification: readonly string[];
  readonly coreVerification: {
    readonly builtAndVerifiedBy: string;
    readonly reverifiedAtMcpBoundary: true;
    readonly resultArtifactDigest: string;
    readonly wireProfile: string;
  };
  readonly candidates: readonly {
    readonly id: string;
    readonly environment: DiscoveryEnvironment;
    readonly environmentLabelSource: "caller";
    readonly networkId: string;
    readonly resolver: { readonly id: string; readonly version: string; readonly digest: string };
    readonly classification: string;
    readonly suppliedSnapshot: {
      readonly id: string;
      readonly artifactDigest: string;
      readonly generatedAt: string;
      readonly networkObservedAt: string | null;
      readonly declaredObservationKind: string | null;
      readonly evidenceSourceIds: readonly string[];
    };
  }[];
  readonly scope: DiscoverNetworksOutcome["scope"];
  readonly verificationContextRefs: {
    readonly capabilitySnapshots: readonly { readonly id: string; readonly digest: string }[];
    readonly resolverManifests: readonly { readonly id: string; readonly version: string; readonly digest: string }[];
  };
  /** THE Core DiscoverNetworksResult in nec-wire-json-v1 form (blockNumber values are decimal strings). */
  readonly coreResult: Record<string, unknown>;
}

/**
 * Run Core Discovery over explicit caller-supplied contexts. Throws
 * `NeMcpError` (boundary decoding/guards) or `NecDiscoveryError` (Discovery /
 * Core rejection, Core error preserved as `cause`).
 */
export function runDiscoverNetworkCandidates(input: DiscoverToolInput): DiscoverToolOutput {
  if (!Array.isArray(input.candidates) || input.candidates.length > MAX_DISCOVERY_CANDIDATES) {
    throw new NeMcpError("MCP_INPUT_INVALID", `candidates must be an array of at most ${MAX_DISCOVERY_CANDIDATES} entries`);
  }
  const requirements = decodeWire("discovery-requirements", input.requirements, "requirements");
  const environments = fixedProfileEnvironments();
  const candidates = input.candidates.map((candidate, index) => toContext(candidate, index, environments));

  const outcome = discoverNetworks({
    requestId: input.requestId,
    generatedAt: input.generatedAt,
    requirements,
    candidates,
    ...(input.scope === undefined ? {} : { scope: input.scope }),
  });

  if (!verifyDiscoverNetworksResult(outcome.result, outcome.verificationContext)) {
    throw new NeMcpError("MCP_RESULT_UNVERIFIED", "@nec/core did not re-verify the DiscoverNetworksResult at the MCP boundary");
  }
  const coreResult = JSON.parse(encodeNecWireJson("discovery-result", outcome.result)) as Record<string, unknown>;

  const snapshotsById = new Map(outcome.verificationContext.capabilitySnapshots.map((snapshot) => [snapshot.id, snapshot]));
  return {
    schema: DISCOVERY_SCHEMA,
    liveObservation: false,
    networkChoice:
      "none — Network Evidence does not choose, score, rank or recommend a network; the caller chooses externally",
    qualification: DISCOVERY_QUALIFICATION,
    coreVerification: {
      builtAndVerifiedBy: "@nec/core buildDiscoverNetworksResult + verifyDiscoverNetworksResult (via @nec/discovery discoverNetworks)",
      reverifiedAtMcpBoundary: true,
      resultArtifactDigest: outcome.result.artifactDigest,
      wireProfile: WIRE_PROFILE,
    },
    candidates: outcome.candidates.map((candidate) => {
      const snapshot = snapshotsById.get(candidate.match.capabilitySnapshot.id);
      if (snapshot === undefined) {
        throw new NeMcpError("MCP_RESULT_UNVERIFIED", "a Core match references a snapshot outside the verification context");
      }
      return {
        id: candidate.id,
        environment: candidate.environment,
        environmentLabelSource: "caller" as const,
        networkId: candidate.networkId,
        resolver: { id: candidate.resolver.id, version: candidate.resolver.version, digest: candidate.resolver.digest },
        classification: candidate.match.classification,
        suppliedSnapshot: {
          id: snapshot.id,
          artifactDigest: snapshot.artifactDigest,
          generatedAt: snapshot.generatedAt,
          networkObservedAt: snapshot.network.observedAt.timestamp ?? null,
          declaredObservationKind: declaredObservationKind(snapshot),
          evidenceSourceIds: evidenceSourceIds(snapshot),
        },
      };
    }),
    scope: outcome.scope,
    verificationContextRefs: {
      capabilitySnapshots: outcome.verificationContext.capabilitySnapshots.map((snapshot) => ({
        id: snapshot.id,
        digest: snapshot.artifactDigest,
      })),
      resolverManifests: outcome.verificationContext.resolverManifests.map((manifest) => ({
        id: manifest.id,
        version: manifest.version,
        digest: manifest.digest,
      })),
    },
    coreResult,
  };
}
