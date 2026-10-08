/**
 * Solana BEFORE foundation tests (v0.1) for the explicit mainnet and devnet
 * profiles.
 *
 * Covers: manifest authority (finality yes, settlement never), explicit
 * genesis-bound profiles with labels kept outside evidence truth,
 * contextually verifiable CapabilitySnapshot / DiscoveryCandidate /
 * DiscoverNetworksResult / PreflightResult on BOTH profiles, the availability
 * ladder, fail-closed validation (network/genesis mismatch, ghost evidence),
 * the finality != settlement boundary, and offline historical replay of the
 * pinned real fixtures (current availability stays UNKNOWN).
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildCapabilitySnapshot,
  buildDiscoverNetworksResult,
  canonicalJson,
  capabilityIsUsable,
  composeDiscoveryMatch,
  computeEvidencePolicyDigest,
  computeResolverManifestDigest,
  verifyCapabilitySnapshot,
  verifyDiscoverNetworksResult,
  verifyPreflightResult,
} from "@nec/core";
import type {
  CapabilityName,
  CapabilitySnapshotContent,
  DiscoveryRequirements,
  EvidencePolicy,
  EvidenceRef,
  PolicyDimension,
  PreflightRequest,
  ResolverManifest,
} from "@nec/core";

import * as solana from "../src/index.js";
import {
  acquireSolanaTransaction,
  deriveSolanaBeforeFoundation,
  deriveSolanaBeforePreflightResult,
  evaluateSolanaTransaction,
  NecResolverSolanaError,
  replaySolanaBeforeFoundation,
  replaySolanaTransaction,
  SOLANA_BEFORE_PROFILES,
  SOLANA_DEVNET_BEFORE_PROFILE,
  SOLANA_FINALITY_DOES_NOT_ESTABLISH,
  SOLANA_MAINNET_BEFORE_PROFILE,
  SOLANA_PROBE_PATH_METADATA_KEY,
  solanaBeforeResolverManifest,
  solanaProbeObservationFromAcquisition,
} from "../src/index.js";
import type {
  NecResolverSolanaErrorCode,
  SolanaBeforeFoundation,
  SolanaBeforeProfile,
  SolanaCapabilityProbeObservation,
  SolanaProbePath,
  SolanaProbePathOutcome,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Deterministic synthetic probe world (one probe time)
// ---------------------------------------------------------------------------

const T0 = "2026-10-08T08:00:00.000Z";
const PATHS: readonly SolanaProbePath[] = ["genesisidentity", "transaction", "signaturestatus", "finalizedblock"];
const SUPPORTED = ["execution", "observedEffects", "dataBinding", "finality"] as const;

function digest(seed: string): string {
  return `sha256:${createHash("sha256").update(seed).digest("hex")}`;
}

function ref(profile: SolanaBeforeProfile, path: SolanaProbePath, overrides: Partial<EvidenceRef> = {}): EvidenceRef {
  return {
    id: `ev-sol-${path}`,
    sourceId: "src.probe.primary",
    sourceType: "svm_rpc",
    locator: `probe:${path}`,
    retrievedAt: T0,
    contentDigest: digest(`${profile.config.networkId}:${path}`),
    networkId: profile.config.networkId,
    metadata: { [SOLANA_PROBE_PATH_METADATA_KEY]: path },
    ...overrides,
  };
}

function allUsable(): Record<SolanaProbePath, SolanaProbePathOutcome> {
  return { genesisidentity: "usable", transaction: "usable", signaturestatus: "usable", finalizedblock: "usable" };
}

function observation(
  profile: SolanaBeforeProfile,
  overrides: Partial<SolanaCapabilityProbeObservation> = {},
): SolanaCapabilityProbeObservation {
  return {
    network: profile.config.networkId,
    source: { sourceId: "src.probe.primary", sourceType: "svm_rpc" },
    observedAt: T0,
    genesisHash: profile.config.genesisHash,
    rpcReachable: true,
    paths: allUsable(),
    finalizedCommitmentObserved: true,
    lookupsCoherent: true,
    evidence: PATHS.map((path) => ref(profile, path)),
    ...overrides,
  };
}

function probeFoundation(
  profile: SolanaBeforeProfile,
  overrides: Partial<SolanaCapabilityProbeObservation> = {},
): SolanaBeforeFoundation {
  return deriveSolanaBeforeFoundation({ config: profile.config, observationKind: "probe", observation: observation(profile, overrides) });
}

function policy(required: PolicyDimension[], desired?: PolicyDimension[]): EvidencePolicy {
  const content = {
    id: "solana-action-evidence",
    version: "1",
    requiredDimensions: required,
    ...(desired === undefined ? {} : { desiredDimensions: desired }),
  };
  return { ...content, digest: computeEvidencePolicyDigest(content) };
}

function preflightRequest(profile: SolanaBeforeProfile, evidencePolicy: EvidencePolicy, networkId?: string): PreflightRequest {
  return {
    schemaVersion: "0.1",
    requestId: `pf_${profile.id}`,
    networkId: networkId ?? profile.config.networkId,
    action: { kind: "spl.transfer_checked", target: "3pkdujCUZ9GWXe8V3cG2wWygBMB57xCHt6nFmWw5zzdz", value: "5000" },
    evidencePolicy,
  };
}

function discovery(f: SolanaBeforeFoundation, request: DiscoveryRequirements, requestId: string) {
  const composed = composeDiscoveryMatch(request, f.candidate);
  const result = buildDiscoverNetworksResult(
    {
      schemaVersion: "0.1",
      requestId,
      generatedAt: f.snapshot.generatedAt,
      request,
      matches: [
        {
          network: f.network,
          classification: composed.classification,
          evaluations: composed.evaluations,
          capabilitySnapshot: { id: f.snapshot.id, digest: f.snapshot.artifactDigest },
          evidence: [...f.snapshot.evidence],
        },
      ],
    },
    { capabilitySnapshots: [f.snapshot], resolverManifests: [f.manifest] },
  );
  expect(verifyDiscoverNetworksResult(result, { capabilitySnapshots: [f.snapshot], resolverManifests: [f.manifest] })).toBe(true);
  return composed;
}

function require1(capability: CapabilityName, strength: "required" | "desired" = "required"): DiscoveryRequirements {
  return { requirements: [{ capability, strength }] };
}

function expectSolError(fn: () => unknown, code: NecResolverSolanaErrorCode): void {
  let error: unknown;
  try {
    fn();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(NecResolverSolanaError);
  expect((error as NecResolverSolanaError).code).toBe(code);
}

async function expectSolErrorAsync(fn: () => Promise<unknown>, code: NecResolverSolanaErrorCode): Promise<void> {
  let error: unknown;
  try {
    await fn();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(NecResolverSolanaError);
  expect((error as NecResolverSolanaError).code).toBe(code);
}

function json(value: unknown): string {
  return canonicalJson(value as never);
}

// ---------------------------------------------------------------------------
// Pinned real fixtures (read-only public-RPC captures; see README)
// ---------------------------------------------------------------------------

const REAL = {
  "solana-mainnet": {
    path: "./fixtures/solana-mainnet-x402-real.json",
    sha256: "62b5191f62b61e9514f4be785d480828c496c199ef88ca763db51caf667d720a",
    acquiredAt: "2026-08-26T20:01:41.884Z",
  },
  "solana-devnet": {
    path: "./fixtures/solana-devnet-before-probe.json",
    sha256: "1b9b278db598b737bad69a675656d28c11f5ebf6ec9d6c2aef16a93df193282a",
    acquiredAt: "2026-10-08T07:38:57.014Z",
  },
} as const;

type MutableFixture = any;

function realFixture(profile: SolanaBeforeProfile): MutableFixture {
  const pinned = REAL[profile.id as keyof typeof REAL];
  const bytes = readFileSync(fileURLToPath(new URL(pinned.path, import.meta.url)));
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(pinned.sha256);
  return JSON.parse(bytes.toString("utf8"));
}

function captureOf(f: MutableFixture, method: string): MutableFixture {
  const found = f.captures.find((entry: MutableFixture) => entry.rpcMethod === method);
  if (!found) throw new Error(`missing ${method}`);
  return found;
}

/** Scripted transport over a fixture's captures (no network). */
function scriptedFetch(f: MutableFixture) {
  let cursor = 0;
  return async (_input: unknown, init?: RequestInit): Promise<Response> => {
    const request = JSON.parse(String(init?.body)) as { id: number };
    const capture = f.captures[cursor++];
    return new Response(`{"jsonrpc":"2.0","id":${request.id},"result":${capture.resultJson}}`, { status: 200 });
  };
}

// ---------------------------------------------------------------------------
// Manifest authority
// ---------------------------------------------------------------------------

describe("Solana BEFORE manifest", () => {
  it("claims exactly what the post-action resolver evaluates — never settlement", () => {
    const m = solanaBeforeResolverManifest();
    expect(m.id).toBe("resolver-solana-before");
    expect(m.version).toBe("0.1.0");
    expect(m.networkFamilies).toEqual(["solana"]);
    expect(m.implementation).toEqual({ package: "@nec/resolver-solana" });
    expect(m.supportedCapabilities).toEqual(["execution", "observedEffects", "dataBinding", "finality"]);
    expect(m.supportedCapabilities).not.toContain("settlement");
    expect(m.sourceRequirements).toEqual([{ sourceType: "svm_rpc", required: true }]);
  });

  it("is frozen and digest-stable", () => {
    const m = solanaBeforeResolverManifest();
    expect(Object.isFrozen(m)).toBe(true);
    expect(solanaBeforeResolverManifest()).toBe(m);
    const { digest: stored, ...content } = m;
    expect(computeResolverManifestDigest(content as Omit<ResolverManifest, "digest">)).toBe(stored);
  });

  it("states the finality boundary, the post-action profiles and the transaction-version scope", () => {
    const meta = solanaBeforeResolverManifest().metadata as Record<string, unknown>;
    expect(meta.finalityDoesNotEstablish).toEqual(["settlement", "economic_irreversibility", "independent_cryptographic_verification"]);
    expect(meta.settlement).toBe("never claimed");
    expect(meta.postActionAcquisitionProfile).toBe("nec-resolver-solana-acquisition-v1");
    expect(meta.postActionEvaluationProfile).toBe("nec-resolver-solana-evaluation-v1");
    expect(meta.requiredProbePaths).toEqual(PATHS);
    expect(meta.supportedTransactionVersions).toEqual(["legacy", "0"]);
  });
});

// ---------------------------------------------------------------------------
// Explicit profiles
// ---------------------------------------------------------------------------

describe("explicit Solana BEFORE profiles", () => {
  it("pins the exact mainnet and devnet genesis-bound identities", () => {
    expect(SOLANA_BEFORE_PROFILES.map((p) => [p.id, p.environment, p.config.networkId, p.config.genesisHash])).toEqual([
      ["solana-mainnet", "mainnet", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"],
      ["solana-devnet", "testnet", "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"],
    ]);
    for (const p of SOLANA_BEFORE_PROFILES) {
      expect(Object.isFrozen(p) && Object.isFrozen(p.config)).toBe(true);
      expect(p.config.networkId).toBe(`solana:${p.config.genesisHash.slice(0, 32)}`);
    }
  });

  it.each(SOLANA_BEFORE_PROFILES.map((p) => [p.id, p] as const))(
    "%s: the pinned genesis equals the FULL getGenesisHash result of its real read-only fixture",
    (_id, profile) => {
      const f = realFixture(profile);
      expect(JSON.parse(captureOf(f, "getGenesisHash").resultJson)).toBe(profile.config.genesisHash);
      expect(f.networkId).toBe(profile.config.networkId);
    },
  );

  it("produces different snapshots for the two profiles from identical probe shapes", () => {
    const mainnet = probeFoundation(SOLANA_MAINNET_BEFORE_PROFILE);
    const devnet = probeFoundation(SOLANA_DEVNET_BEFORE_PROFILE);
    expect(mainnet.snapshot.network.networkId).toBe("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
    expect(devnet.snapshot.network.networkId).toBe("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
    expect(mainnet.snapshot.artifactDigest).not.toBe(devnet.snapshot.artifactDigest);
  });
});

// ---------------------------------------------------------------------------
// Probe-derived BEFORE on BOTH profiles
// ---------------------------------------------------------------------------

describe.each(SOLANA_BEFORE_PROFILES.map((profile) => [profile.label, profile] as const))("BEFORE — %s", (_label, profile) => {
  it("produces a contextually verifiable CapabilitySnapshot bound to the full genesis hash", () => {
    const f = probeFoundation(profile);
    expect(verifyCapabilitySnapshot(f.snapshot, { resolver: f.manifest, networkId: profile.config.networkId })).toBe(true);
    const other = SOLANA_BEFORE_PROFILES.find((p) => p !== profile) as SolanaBeforeProfile;
    expect(verifyCapabilitySnapshot(f.snapshot, { resolver: f.manifest, networkId: other.config.networkId })).toBe(false);
    expect(f.snapshot.network.genesisId).toBe(profile.config.genesisHash);
    expect(f.snapshot.network.metadata).toEqual({
      chainFamily: "solana",
      observationKind: "probe",
      probeSource: { sourceId: "src.probe.primary", sourceType: "svm_rpc" },
    });
    expect(f.snapshot.generatedAt).toBe(T0);
    expect(f.snapshot.executionCapabilities).toEqual({});
    for (const name of SUPPORTED) {
      const state = f.snapshot.evidenceCapabilities[name];
      expect(state.support).toBe("supported");
      expect(state.availability).toBe("available");
      expect(state.evidence).toEqual(PATHS.map((path) => `ev-sol-${path}`));
      expect(capabilityIsUsable(state, f.snapshot.evidence)).toBe(true);
    }
    expect(f.snapshot.evidenceCapabilities.settlement).toMatchObject({ support: "unsupported", availability: "unavailable" });
    expect(f.snapshot.evidenceCapabilities.finality.metadata?.doesNotEstablish).toEqual([...SOLANA_FINALITY_DOES_NOT_ESTABLISH]);
  });

  it("produces an eligible discovery candidate, verifiable in a DiscoverNetworksResult", () => {
    const f = probeFoundation(profile);
    expect(f.candidate.network).toBe(f.snapshot.network);
    expect(f.candidate.resolver).toBe(f.manifest);
    const composed = discovery(
      f,
      { requirements: [{ capability: "execution", strength: "required" }, { capability: "finality", strength: "required" }] },
      `disc_${profile.id}`,
    );
    expect(composed.classification).toBe("eligible");
  });

  it("derives a READY evidence Preflight, verifiable in context", () => {
    const f = probeFoundation(profile);
    const pf = deriveSolanaBeforePreflightResult(f, preflightRequest(profile, policy(["execution", "observedEffects", "dataBinding", "finality"])));
    expect(pf.status).toBe("ready");
    for (const name of SUPPORTED) expect(pf.evidenceReadiness[name].status).toBe("ready");
    expect(pf.evidenceReadiness.settlement.status).toBe("not_applicable");
    expect(pf.evidenceReadiness.finality.metadata?.doesNotEstablish).toEqual([...SOLANA_FINALITY_DOES_NOT_ESTABLISH]);
    expect(verifyPreflightResult(pf, { resolver: f.manifest, capabilitySnapshot: f.snapshot })).toBe(true);
  });

  it("keeps preflight evidence-readiness only (no wallet/funding/signer/submission fields)", () => {
    const f = probeFoundation(profile);
    const pf = deriveSolanaBeforePreflightResult(f, preflightRequest(profile, policy(["finality"])));
    const text = json(pf).toLowerCase();
    for (const word of ["wallet", "balance", "funding", "signer", "signing", "submission", "sponsor", "facilitator", "lamports", "fee"]) {
      expect(text).not.toContain(`"${word}`);
    }
  });

  it("projects a completed acquisition (scripted transport standing in for a fresh probe) onto an available snapshot", async () => {
    const f = realFixture(profile);
    const acquisition = await acquireSolanaTransaction({
      source: { ...f.source, transport: { url: "https://scripted.invalid/" } },
      signature: f.subject.signature,
      now: T0,
      fetchFn: scriptedFetch(f),
    });
    const obs = solanaProbeObservationFromAcquisition(acquisition);
    expect(obs.paths).toEqual(allUsable());
    expect(obs.genesisHash).toBe(profile.config.genesisHash);
    const foundation = deriveSolanaBeforeFoundation({ config: profile.config, observationKind: "probe", observation: obs });
    // The cited refs are the post-action evaluator's own citation table.
    expect(foundation.snapshot.evidence.map((r) => r.id)).toEqual(evaluateSolanaTransaction(acquisition).fragment.evidence.map((r) => r.id));
    for (const name of SUPPORTED) expect(foundation.snapshot.evidenceCapabilities[name].availability).toBe("available");
    expect(discovery(foundation, require1("finality"), `disc_live_${profile.id}`).classification).toBe("eligible");
  });
});

// ---------------------------------------------------------------------------
// Availability ladder (support never changes)
// ---------------------------------------------------------------------------

describe("availability is derived from the probe observation", () => {
  const profile = SOLANA_DEVNET_BEFORE_PROFILE;

  function availability(f: SolanaBeforeFoundation) {
    for (const name of SUPPORTED) expect(f.snapshot.evidenceCapabilities[name].support).toBe("supported");
    return Object.fromEntries(SUPPORTED.map((name) => [name, f.snapshot.evidenceCapabilities[name].availability]));
  }

  const all = (value: string) => Object.fromEntries(SUPPORTED.map((name) => [name, value]));

  it("probe source unreachable -> unavailable (definite negative; preflight blocked)", () => {
    const f = probeFoundation(profile, {
      rpcReachable: false,
      paths: { genesisidentity: "unusable", transaction: "unusable", signaturestatus: "unusable", finalizedblock: "unusable" },
      finalizedCommitmentObserved: false,
      lookupsCoherent: false,
      genesisHash: undefined,
      evidence: [],
    } as Partial<SolanaCapabilityProbeObservation>);
    expect(availability(f)).toEqual(all("unavailable"));
    expect(f.snapshot.network.genesisId).toBeUndefined();
    expect(composeDiscoveryMatch(require1("execution"), f.candidate).evaluations[0]?.status).toBe("unsatisfied");
    expect(deriveSolanaBeforePreflightResult(f, preflightRequest(profile, policy(["execution"]))).status).toBe("blocked");
  });

  it("genesis identity read failed -> unavailable; not established -> unknown", () => {
    const failed = observation(profile, { paths: { ...allUsable(), genesisidentity: "unusable" }, genesisHash: undefined });
    failed.evidence.splice(0, 1);
    expect(availability(deriveSolanaBeforeFoundation({ config: profile.config, observationKind: "probe", observation: failed }))).toEqual(all("unavailable"));
    const unseen = observation(profile, { paths: { ...allUsable(), genesisidentity: "not_established" }, genesisHash: undefined });
    unseen.evidence.splice(0, 1);
    expect(availability(deriveSolanaBeforeFoundation({ config: profile.config, observationKind: "probe", observation: unseen }))).toEqual(all("unknown"));
  });

  it("identity not established + supplied genesisHash -> still bound, but genesisId is not presented as observed", () => {
    const supplied = observation(profile, { paths: { ...allUsable(), genesisidentity: "not_established" } });
    supplied.evidence.splice(0, 1);
    const f = deriveSolanaBeforeFoundation({ config: profile.config, observationKind: "probe", observation: supplied });
    expect(availability(f)).toEqual(all("unknown"));
    expect(f.snapshot.network.genesisId).toBeUndefined();
    expect(f.snapshot.network.metadata?.observationKind).toBe("probe");
    const forged = observation(profile, { paths: { ...allUsable(), genesisidentity: "not_established" }, genesisHash: `${profile.config.genesisHash.slice(0, -1)}${profile.config.genesisHash.endsWith("e") ? "f" : "e"}` });
    forged.evidence.splice(0, 1);
    expectSolError(() => deriveSolanaBeforeFoundation({ config: profile.config, observationKind: "probe", observation: forged }), "SOLANA_NETWORK_MISMATCH");
  });

  it.each(["transaction", "signaturestatus", "finalizedblock"] as const)("%s read failed -> every capability unavailable", (path) => {
    const f = probeFoundation(profile, { paths: { ...allUsable(), [path]: "unusable" }, lookupsCoherent: false, finalizedCommitmentObserved: path !== "signaturestatus" });
    expect(availability(f)).toEqual(all("unavailable"));
  });

  it.each(["transaction", "signaturestatus", "finalizedblock"] as const)("%s not established -> every capability unknown (never negative)", (path) => {
    const f = probeFoundation(profile, { paths: { ...allUsable(), [path]: "not_established" }, lookupsCoherent: false, finalizedCommitmentObserved: path !== "signaturestatus" });
    expect(availability(f)).toEqual(all("unknown"));
    expect(composeDiscoveryMatch(require1("execution"), f.candidate).evaluations[0]?.status).toBe("unknown");
  });

  it("mutually inconsistent lookups -> degraded (preflight blocked)", () => {
    const f = probeFoundation(profile, { lookupsCoherent: false });
    expect(availability(f)).toEqual(all("degraded"));
    expect(deriveSolanaBeforePreflightResult(f, preflightRequest(profile, policy(["dataBinding"]))).status).toBe("blocked");
  });

  it("finalized commitment not observed -> ONLY finality unknown", () => {
    const f = probeFoundation(profile, { finalizedCommitmentObserved: false });
    expect(availability(f)).toEqual({ execution: "available", observedEffects: "available", dataBinding: "available", finality: "unknown" });
    const pf = deriveSolanaBeforePreflightResult(f, preflightRequest(profile, policy(["execution", "finality"])));
    expect(pf.status).toBe("unknown");
    expect(pf.evidenceReadiness.execution.status).toBe("ready");
    expect(pf.evidenceReadiness.finality.status).toBe("unknown");
  });

  it("refs classified by metadata.rpcMethod are cited like explicit probePath tags", () => {
    const methods: Record<SolanaProbePath, string> = { genesisidentity: "getGenesisHash", transaction: "getTransaction", signaturestatus: "getSignatureStatuses", finalizedblock: "getBlock" };
    const f = probeFoundation(profile, { evidence: PATHS.map((path) => ref(profile, path, { metadata: { rpcMethod: methods[path] } })) });
    expect(availability(f)).toEqual(all("available"));
  });

  it("untagged refs stay inert provenance and are never cited", () => {
    const inert = ref(profile, "transaction", { id: "ev-inert", metadata: { note: "extra" } });
    const f = probeFoundation(profile, { evidence: [...PATHS.map((path) => ref(profile, path)), inert] });
    expect(f.snapshot.evidence.map((r) => r.id)).toContain("ev-inert");
    for (const name of SUPPORTED) expect(f.snapshot.evidenceCapabilities[name].evidence).not.toContain("ev-inert");
  });
});

// ---------------------------------------------------------------------------
// Fail-closed validation
// ---------------------------------------------------------------------------

describe("fail-closed validation", () => {
  const profile = SOLANA_MAINNET_BEFORE_PROFILE;
  const derive = (obs: unknown, config: unknown = profile.config, observationKind: unknown = "probe") => () =>
    deriveSolanaBeforeFoundation({ config, observationKind, observation: obs } as never);

  it("observation for another network fails closed", () => {
    expectSolError(derive(observation(SOLANA_DEVNET_BEFORE_PROFILE)), "SOLANA_NETWORK_MISMATCH");
  });

  it("observed genesis hash of another network fails closed", () => {
    expectSolError(derive(observation(profile, { genesisHash: SOLANA_DEVNET_BEFORE_PROFILE.config.genesisHash })), "SOLANA_NETWORK_MISMATCH");
  });

  it("a genesis hash sharing the 32-character CAIP prefix but differing in full fails closed", () => {
    const forged = `${profile.config.genesisHash.slice(0, -1)}e`;
    expect(forged.slice(0, 32)).toBe(profile.config.genesisHash.slice(0, 32));
    expectSolError(derive(observation(profile, { genesisHash: forged })), "SOLANA_NETWORK_MISMATCH");
  });

  it("a config whose networkId is not derived from its full genesis hash fails closed", () => {
    const config = { networkId: SOLANA_DEVNET_BEFORE_PROFILE.config.networkId, genesisHash: profile.config.genesisHash };
    expectSolError(derive(observation(profile), config), "SOLANA_NETWORK_MISMATCH");
    expectSolError(() => solana.validateSolanaBeforeNetworkConfig({ networkId: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", genesisHash: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }), "SOLANA_PROBE_INVALID");
  });

  it("cross-network evidence refs fail closed", () => {
    const evidence = PATHS.map((path) => ref(profile, path));
    evidence[1] = ref(profile, "transaction", { networkId: SOLANA_DEVNET_BEFORE_PROFILE.config.networkId });
    expectSolError(derive(observation(profile, { evidence })), "SOLANA_NETWORK_MISMATCH");
  });

  it("refs from a second source are rejected (single probe source)", () => {
    const evidence = PATHS.map((path) => ref(profile, path));
    evidence[2] = ref(profile, "signaturestatus", { sourceId: "src.other" });
    expectSolError(derive(observation(profile, { evidence })), "SOLANA_PROBE_INVALID");
  });

  it.each(PATHS)("a usable %s claim without a classified ref is ghost evidence", (path) => {
    const evidence = PATHS.filter((p) => p !== path).map((p) => ref(profile, p));
    expectSolError(derive(observation(profile, { evidence })), "SOLANA_OBSERVATION_INCOMPLETE");
  });

  it("contradictory positive claims are rejected", () => {
    expectSolError(derive(observation(profile, { rpcReachable: false })), "SOLANA_OBSERVATION_INCOMPLETE");
    expectSolError(derive(observation(profile, { evidence: [] })), "SOLANA_OBSERVATION_INCOMPLETE");
    expectSolError(derive(observation(profile, { paths: { ...allUsable(), signaturestatus: "not_established" }, lookupsCoherent: false })), "SOLANA_OBSERVATION_INCOMPLETE");
    expectSolError(derive(observation(profile, { paths: { ...allUsable(), finalizedblock: "not_established" } })), "SOLANA_OBSERVATION_INCOMPLETE");
  });

  it("a usable identity path must carry the observed full genesis hash", () => {
    const obs = observation(profile);
    delete (obs as { genesisHash?: string }).genesisHash;
    expectSolError(derive(obs), "SOLANA_PROBE_INVALID");
  });

  it("rejects unknown keys, kinds, outcomes, tags, duplicate ids and accessors", () => {
    expectSolError(derive({ ...observation(profile), extra: 1 }), "SOLANA_PROBE_INVALID");
    expectSolError(derive(observation(profile), profile.config, "live"), "SOLANA_PROBE_INVALID");
    expectSolError(derive(observation(profile, { paths: { ...allUsable(), transaction: "maybe" as SolanaProbePathOutcome } })), "SOLANA_PROBE_INVALID");
    expectSolError(derive(observation(profile, { evidence: [...PATHS.map((p) => ref(profile, p)), ref(profile, "transaction", { id: "ev-x", metadata: { probePath: "balance" } })] })), "SOLANA_PROBE_INVALID");
    expectSolError(derive(observation(profile, { evidence: [...PATHS.map((p) => ref(profile, p)), ref(profile, "transaction")] })), "SOLANA_PROBE_INVALID");
    expectSolError(derive(observation(profile, { source: { sourceId: "src.probe.primary", sourceType: "evm_rpc" as "svm_rpc" } })), "SOLANA_PROBE_INVALID");
    const accessor = observation(profile);
    Object.defineProperty(accessor, "rpcReachable", { get: () => true, enumerable: true });
    expectSolError(derive(accessor), "SOLANA_PROBE_INVALID");
  });

  it("rejects a malformed probe time", () => {
    expectSolError(derive(observation(profile, { observedAt: "2026-10-08T08:00:00Z" })), "SOLANA_TIME_INVALID");
  });

  it("preflight fails closed on network mismatch and on a foundation bound to another manifest", () => {
    const f = probeFoundation(profile);
    expectSolError(() => deriveSolanaBeforePreflightResult(f, preflightRequest(profile, policy(["execution"]), SOLANA_DEVNET_BEFORE_PROFILE.config.networkId)), "SOLANA_NETWORK_MISMATCH");
    const content = { ...solanaBeforeResolverManifest(), id: "resolver-other", digest: undefined };
    delete (content as { digest?: string }).digest;
    const other = { ...(content as Omit<ResolverManifest, "digest">), digest: computeResolverManifestDigest(content as Omit<ResolverManifest, "digest">) };
    const snapshot = buildCapabilitySnapshot(
      { ...(stripDigest(f.snapshot) as CapabilitySnapshotContent), resolver: { id: other.id, version: other.version, digest: other.digest } },
      { resolver: other, networkId: profile.config.networkId },
    );
    expectSolError(
      () => deriveSolanaBeforePreflightResult({ manifest: other, network: snapshot.network, snapshot, candidate: { network: snapshot.network, snapshot, resolver: other } }, preflightRequest(profile, policy(["execution"]))),
      "SOLANA_PROBE_INVALID",
    );
  });
});

function stripDigest(snapshot: SolanaBeforeFoundation["snapshot"]): Omit<SolanaBeforeFoundation["snapshot"], "artifactDigest"> {
  const { artifactDigest: _ignored, ...rest } = snapshot;
  return structuredClone(rest);
}

// ---------------------------------------------------------------------------
// Finality is never settlement
// ---------------------------------------------------------------------------

describe("finality never becomes settlement", () => {
  it.each(SOLANA_BEFORE_PROFILES.map((p) => [p.id, p] as const))("%s: available finality leaves settlement unsupported/unavailable", (_id, profile) => {
    const f = probeFoundation(profile);
    expect(f.snapshot.evidenceCapabilities.finality.availability).toBe("available");
    expect(f.snapshot.evidenceCapabilities.settlement).toEqual({
      support: "unsupported",
      availability: "unavailable",
      reason: "not claimed by the Solana BEFORE v0.1 manifest: an observed finalized commitment is never settlement or economic irreversibility",
    });
    const required = composeDiscoveryMatch(require1("settlement"), f.candidate);
    expect(required.classification).toBe("ineligible");
    expect(required.evaluations[0]?.status).toBe("unsatisfied");
    const desired = composeDiscoveryMatch(
      { requirements: [{ capability: "finality", strength: "required" }, { capability: "settlement", strength: "desired" }] },
      f.candidate,
    );
    expect(desired.classification).toBe("conditional");
    const pf = deriveSolanaBeforePreflightResult(f, preflightRequest(profile, policy(["finality", "settlement"])));
    expect(pf.status).toBe("blocked");
    expect(pf.evidenceReadiness.finality.status).toBe("ready");
    expect(pf.evidenceReadiness.settlement.status).toBe("not_applicable");
  });

  it("a forged snapshot claiming settlement is rejected by the core manifest-authority check", () => {
    const f = probeFoundation(SOLANA_MAINNET_BEFORE_PROFILE);
    const content = stripDigest(f.snapshot) as CapabilitySnapshotContent;
    const forged = {
      ...content,
      evidenceCapabilities: { ...content.evidenceCapabilities, settlement: { ...content.evidenceCapabilities.finality } },
    };
    expect(() => buildCapabilitySnapshot(forged, { resolver: f.manifest, networkId: SOLANA_MAINNET_BEFORE_PROFILE.config.networkId })).toThrow(/settlement/);
  });

  it("no artifact asserts settlement, economic irreversibility or cryptographic verification", () => {
    const f = probeFoundation(SOLANA_DEVNET_BEFORE_PROFILE);
    const pf = deriveSolanaBeforePreflightResult(f, preflightRequest(SOLANA_DEVNET_BEFORE_PROFILE, policy(["finality"])));
    const text = json({ m: f.manifest, s: f.snapshot, p: pf });
    expect(text).not.toMatch(/"(settled|irreversible|economicallyFinal)":true/);
    expect(text).not.toMatch(/"basis":(?:"|\[[^\]]*")cryptographic_verification"/);
    expect(f.snapshot.evidenceCapabilities.finality.metadata?.basis).toBe("source_observation");
  });
});

// ---------------------------------------------------------------------------
// Historical replay of the pinned real fixtures
// ---------------------------------------------------------------------------

describe.each(SOLANA_BEFORE_PROFILES.map((profile) => [profile.label, profile] as const))("historical replay — %s", (_label, profile) => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  const original = globalThis.fetch;
  beforeEach(() => {
    fetchSpy = vi.fn(() => Promise.reject(new Error("network access is forbidden in replay")));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = original;
  });

  it("replays offline and never presents archived observations as current availability", async () => {
    const pinned = REAL[profile.id as keyof typeof REAL];
    const f = await replaySolanaBeforeFoundation({ config: profile.config, fixture: realFixture(profile) });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(verifyCapabilitySnapshot(f.snapshot, { resolver: f.manifest, networkId: profile.config.networkId })).toBe(true);
    expect(f.snapshot.generatedAt).toBe(pinned.acquiredAt);
    expect(f.snapshot.network.genesisId).toBe(profile.config.genesisHash);
    expect(f.snapshot.network.metadata?.observationKind).toBe("historical_replay");
    for (const name of SUPPORTED) {
      const state = f.snapshot.evidenceCapabilities[name];
      expect(state.support).toBe("supported");
      expect(state.availability).toBe("unknown");
      expect(state.metadata).toMatchObject({
        observationKind: "historical_replay",
        historicalCaptureTime: pinned.acquiredAt,
        historicalAvailabilityAtCapture: "available",
        currentAvailability: "unknown",
      });
      expect(capabilityIsUsable(state, f.snapshot.evidence)).toBe(false);
    }
    expect(f.snapshot.evidenceCapabilities.settlement).toMatchObject({ support: "unsupported", availability: "unavailable" });
  });

  it("an archived fixture never makes a required capability eligible or a preflight ready", async () => {
    const f = await replaySolanaBeforeFoundation({ config: profile.config, fixture: realFixture(profile) });
    for (const name of SUPPORTED) {
      const required = discovery(f, require1(name), `disc_hist_${profile.id}_${name}`);
      expect(required.classification).toBe("ineligible");
      expect(required.evaluations[0]?.status).toBe("unknown");
      expect(composeDiscoveryMatch(require1(name, "desired"), f.candidate).classification).toBe("conditional");
    }
    const pf = deriveSolanaBeforePreflightResult(f, preflightRequest(profile, policy(["execution", "finality"])));
    expect(pf.status).toBe("unknown");
    expect(verifyPreflightResult(pf, { resolver: f.manifest, capabilitySnapshot: f.snapshot })).toBe(true);
  });

  it("cites the post-action evaluator's own citation ids and is deterministic", async () => {
    const a = await replaySolanaBeforeFoundation({ config: profile.config, fixture: realFixture(profile) });
    const b = await replaySolanaBeforeFoundation({ config: profile.config, fixture: realFixture(profile) });
    expect(a.snapshot.artifactDigest).toBe(b.snapshot.artifactDigest);
    const fragment = evaluateSolanaTransaction(await replaySolanaTransaction(realFixture(profile))).fragment;
    expect(a.snapshot.evidence.map((r) => r.id)).toEqual(fragment.evidence.map((r) => r.id));
    expect(a.snapshot.evidenceCapabilities.finality.evidence).toEqual(fragment.evidence.map((r) => r.id));
  });

  it("an incoherent archived capture records degraded at capture time, still unknown now", async () => {
    const fx = realFixture(profile);
    const status = JSON.parse(captureOf(fx, "getSignatureStatuses").resultJson);
    status.value[0].slot += 1;
    captureOf(fx, "getSignatureStatuses").resultJson = JSON.stringify(status);
    const f = await replaySolanaBeforeFoundation({ config: profile.config, fixture: fx });
    for (const name of SUPPORTED) {
      expect(f.snapshot.evidenceCapabilities[name].availability).toBe("unknown");
      expect(f.snapshot.evidenceCapabilities[name].metadata?.historicalAvailabilityAtCapture).toBe("degraded");
    }
  });

  it("a fixture of the other network fails closed", async () => {
    const other = SOLANA_BEFORE_PROFILES.find((p) => p !== profile) as SolanaBeforeProfile;
    await expectSolErrorAsync(() => replaySolanaBeforeFoundation({ config: other.config, fixture: realFixture(profile) }), "SOLANA_NETWORK_MISMATCH");
  });

  it("a tampered full genesis result fails closed in BEFORE even where the post-action prefix check passes", async () => {
    const fx = realFixture(profile);
    const forged = `${profile.config.genesisHash.slice(0, -1)}${profile.config.genesisHash.endsWith("e") ? "f" : "e"}`;
    captureOf(fx, "getGenesisHash").resultJson = JSON.stringify(forged);
    // Unchanged post-action semantics: the CAIP-prefix binding still holds.
    expect((await replaySolanaTransaction(fx)).genesisHash).toBe(forged);
    await expectSolErrorAsync(() => replaySolanaBeforeFoundation({ config: profile.config, fixture: fx }), "SOLANA_NETWORK_MISMATCH");
    const wrongPrefix = realFixture(profile);
    captureOf(wrongPrefix, "getGenesisHash").resultJson = JSON.stringify("11111111111111111111111111111111");
    await expectSolErrorAsync(() => replaySolanaBeforeFoundation({ config: profile.config, fixture: wrongPrefix }), "SOLANA_NETWORK_MISMATCH");
  });
});

// ---------------------------------------------------------------------------
// Environment labels never influence evidence truth
// ---------------------------------------------------------------------------

describe("environment labels never influence evidence truth", () => {
  it("relabelling a profile leaves every artifact byte-identical", () => {
    for (const profile of SOLANA_BEFORE_PROFILES) {
      const relabelled: SolanaBeforeProfile = { id: "x", label: "Anything", environment: profile.environment === "mainnet" ? "testnet" : "mainnet", config: profile.config };
      const a = probeFoundation(profile);
      const b = probeFoundation(relabelled);
      expect(b.snapshot.artifactDigest).toBe(a.snapshot.artifactDigest);
      const pa = deriveSolanaBeforePreflightResult(a, preflightRequest(profile, policy(["finality"])));
      const pb = deriveSolanaBeforePreflightResult(b, preflightRequest(profile, policy(["finality"])));
      expect(pb.artifactDigest).toBe(pa.artifactDigest);
    }
  });

  it("no label, profile id or environment enters a manifest, snapshot, candidate or preflight", async () => {
    for (const profile of SOLANA_BEFORE_PROFILES) {
      const f = await replaySolanaBeforeFoundation({ config: profile.config, fixture: realFixture(profile) });
      const pf = deriveSolanaBeforePreflightResult(f, preflightRequest({ ...profile, id: "neutral" }, policy(["finality"])));
      const text = json({ m: f.manifest, s: f.snapshot, c: f.candidate, p: pf });
      for (const needle of [profile.label, `"${profile.id}"`, '"environment"', '"testnet"', '"mainnet"', '"devnet"']) {
        expect(text).not.toContain(needle);
      }
    }
  });

  it("a profile object is never accepted as the derivation config", () => {
    expectSolError(
      () => deriveSolanaBeforeFoundation({ config: SOLANA_DEVNET_BEFORE_PROFILE as never, observationKind: "probe", observation: observation(SOLANA_DEVNET_BEFORE_PROFILE) }),
      "SOLANA_PROBE_INVALID",
    );
    expectSolError(
      () => deriveSolanaBeforeFoundation({ config: { ...SOLANA_DEVNET_BEFORE_PROFILE.config, environment: "testnet" } as never, observationKind: "probe", observation: observation(SOLANA_DEVNET_BEFORE_PROFILE) }),
      "SOLANA_PROBE_INVALID",
    );
  });
});

// ---------------------------------------------------------------------------
// Unknown required capability never becomes eligible
// ---------------------------------------------------------------------------

describe("unknown required capability never becomes eligible", () => {
  it.each(SUPPORTED)("required %s with an unestablished lookup is ineligible; desired is only conditional", (name) => {
    const profile = SOLANA_DEVNET_BEFORE_PROFILE;
    const f = probeFoundation(profile, { paths: { ...allUsable(), transaction: "not_established" }, lookupsCoherent: false });
    expect(f.snapshot.evidenceCapabilities[name].availability).toBe("unknown");
    const required = discovery(f, require1(name), `disc_unknown_${name}`);
    expect(required.classification).toBe("ineligible");
    expect(required.evaluations[0]?.status).toBe("unknown");
    expect(composeDiscoveryMatch(require1(name, "desired"), f.candidate).classification).toBe("conditional");
    expect(deriveSolanaBeforePreflightResult(f, preflightRequest(profile, policy([name]))).status).toBe("unknown");
  });

  it("finality unknown stays ineligible even when every other capability is available", () => {
    const f = probeFoundation(SOLANA_MAINNET_BEFORE_PROFILE, { finalizedCommitmentObserved: false });
    const composed = composeDiscoveryMatch(
      { requirements: [{ capability: "execution", strength: "required" }, { capability: "finality", strength: "required" }] },
      f.candidate,
    );
    expect(composed.classification).toBe("ineligible");
  });
});

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

describe("public BEFORE surface", () => {
  it("exposes the BEFORE entry points and keeps derivation internals private", () => {
    for (const name of [
      "deriveSolanaBeforeFoundation",
      "deriveSolanaBeforePreflightResult",
      "replaySolanaBeforeFoundation",
      "solanaBeforeResolverManifest",
      "solanaProbeObservationFromAcquisition",
      "validateSolanaBeforeNetworkConfig",
    ]) {
      expect(typeof (solana as Record<string, unknown>)[name], name).toBe("function");
    }
    expect(solana.SOLANA_BEFORE_PROFILE).toBe("solana-before-v0.1");
    for (const name of ["deriveState", "historicalState", "validateObservation", "COHERENCE_CHECKS", "retype"]) {
      expect((solana as Record<string, unknown>)[name], name).toBeUndefined();
    }
  });

  it("the package still depends only on @nec/core", () => {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies)).toEqual(["@nec/core"]);
  });
});
