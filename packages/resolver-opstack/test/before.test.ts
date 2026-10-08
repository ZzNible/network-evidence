/**
 * OP Stack BEFORE overlay tests (v0.1) for the explicit Base mainnet and
 * Base Sepolia profiles.
 *
 * Covers: manifest authority (finality yes, settlement never), explicit
 * profiles with labels kept outside evidence truth, contextually verifiable
 * CapabilitySnapshot / DiscoveryCandidate / DiscoverNetworksResult /
 * PreflightResult on BOTH profiles, the finality availability ladder,
 * fail-closed probe validation, the finality != settlement != withdrawal
 * finalization boundary, and offline historical replay of the pinned real
 * fixtures (current availability stays UNKNOWN).
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildCapabilitySnapshot,
  buildDiscoverNetworksResult,
  canonicalJson,
  capabilityIsDeterministicallyUnavailable,
  capabilityIsUsable,
  composeDiscoveryMatch,
  computeEvidencePolicyDigest,
  verifyCapabilitySnapshot,
  verifyDiscoverNetworksResult,
  verifyPreflightResult,
} from "@nec/core";
import type {
  CapabilitySnapshotContent,
  DiscoveryRequirements,
  EvidencePolicy,
  EvidenceRef,
  PolicyDimension,
  PreflightRequest,
} from "@nec/core";
import { deriveEvmBeforeFoundation, evmBeforeResolverManifest } from "@nec/resolver-evm";
import type { EvmCapabilityProbeObservation } from "@nec/resolver-evm";

import {
  BASE_MAINNET_OPSTACK_BEFORE_PROFILE,
  BASE_OPSTACK_BEFORE_PROFILES,
  BASE_SEPOLIA_OPSTACK_BEFORE_PROFILE,
  deriveOpStackBeforeFoundation,
  deriveOpStackBeforePreflightResult,
  NecResolverOpStackError,
  OPSTACK_FINALITY_DOES_NOT_ESTABLISH,
  OPSTACK_PROBE_PATH_METADATA_KEY,
  opStackBeforeResolverManifest,
  replayOpStackBeforeFoundation,
  replayOpStackFinalityObservation,
} from "../src/index.js";
import type {
  NecResolverOpStackErrorCode,
  OpStackBeforeFoundation,
  OpStackBeforeProfile,
  OpStackFinalityConfig,
  OpStackFinalityProbeObservation,
  OpStackFinalityProbePath,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Deterministic synthetic probe world (one probe time per burst)
// ---------------------------------------------------------------------------

const T0 = "2026-10-08T06:00:00.000Z";
const T1 = "2026-10-08T06:05:00.000Z";

const EVM_PATHS = ["chainidentity", "receipt", "block", "transaction"] as const;
const FINALITY_PATHS: readonly OpStackFinalityProbePath[] = ["chainidentity", "finalizedhead", "safehead", "latesthead"];

function digest(seed: string): string {
  return `sha256:${createHash("sha256").update(seed).digest("hex")}`;
}

function evmRef(profile: OpStackBeforeProfile, path: (typeof EVM_PATHS)[number]): EvidenceRef {
  return {
    id: `ev-evm-${path}`,
    sourceId: "src.probe.primary",
    sourceType: "evm_rpc",
    locator: `probe:${path}`,
    retrievedAt: T0,
    contentDigest: digest(`${profile.id}:evm:${path}`),
    networkId: profile.config.networkId,
    metadata: { probePath: path },
  };
}

function finalityRef(profile: OpStackBeforeProfile, path: OpStackFinalityProbePath, overrides: Partial<EvidenceRef> = {}): EvidenceRef {
  return {
    id: `ev-op-${path}`,
    sourceId: "src.probe.primary",
    sourceType: "evm_rpc",
    locator: `probe:opstack:${path}`,
    retrievedAt: T0,
    contentDigest: digest(`${profile.id}:op:${path}`),
    networkId: profile.config.networkId,
    metadata: { [OPSTACK_PROBE_PATH_METADATA_KEY]: path },
    ...overrides,
  };
}

function evmObservation(
  profile: OpStackBeforeProfile,
  overrides: Partial<EvmCapabilityProbeObservation> = {},
): EvmCapabilityProbeObservation {
  return {
    network: profile.config.networkId,
    chainId: profile.config.chainId,
    source: { sourceId: "src.probe.primary", sourceType: "evm_rpc" },
    observedAt: T0,
    rpcReachable: true,
    chainIdentityObserved: true,
    receiptLookupUsable: true,
    blockLookupUsable: true,
    transactionLookupUsable: true,
    evidence: EVM_PATHS.map((path) => evmRef(profile, path)),
    ...overrides,
  };
}

function finalityObservation(
  profile: OpStackBeforeProfile,
  overrides: Partial<OpStackFinalityProbeObservation> = {},
): OpStackFinalityProbeObservation {
  return {
    network: profile.config.networkId,
    chainId: profile.config.chainId,
    source: { sourceId: "src.probe.primary", sourceType: "evm_rpc" },
    observedAt: T0,
    rpcReachable: true,
    chainIdentityObserved: true,
    finalizedHeadLookupUsable: true,
    safeHeadLookupUsable: true,
    latestHeadLookupUsable: true,
    headOrderingCoherent: true,
    evidence: FINALITY_PATHS.map((path) => finalityRef(profile, path)),
    ...overrides,
  };
}

function withoutRef(observation: OpStackFinalityProbeObservation, path: OpStackFinalityProbePath): EvidenceRef[] {
  return observation.evidence.filter((ref) => ref.id !== `ev-op-${path}`);
}

function probeFoundation(
  profile: OpStackBeforeProfile,
  finality: Partial<OpStackFinalityProbeObservation> | null = {},
  evm: Partial<EvmCapabilityProbeObservation> = {},
): OpStackBeforeFoundation {
  return deriveOpStackBeforeFoundation({
    config: profile.config,
    observationKind: "probe",
    evmObservation: evmObservation(profile, evm),
    ...(finality === null ? {} : { finalityObservation: finalityObservation(profile, finality) }),
  });
}

function policy(required: PolicyDimension[], desired?: PolicyDimension[]): EvidencePolicy {
  const content = {
    id: "base-action-evidence",
    version: "1",
    requiredDimensions: required,
    ...(desired === undefined ? {} : { desiredDimensions: desired }),
  };
  return { ...content, digest: computeEvidencePolicyDigest(content) };
}

function preflightRequest(profile: OpStackBeforeProfile, evidencePolicy: EvidencePolicy, networkId?: string): PreflightRequest {
  return {
    schemaVersion: "0.1",
    requestId: `pf_${profile.id}`,
    networkId: networkId ?? profile.config.networkId,
    action: { kind: "erc20.transfer", target: `0x${"aa".repeat(20)}`, value: "0" },
    evidencePolicy,
  };
}

function expectOpError(fn: () => unknown, code: NecResolverOpStackErrorCode): void {
  let error: unknown;
  try {
    fn();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(NecResolverOpStackError);
  expect((error as NecResolverOpStackError).code).toBe(code);
}

async function expectOpErrorAsync(fn: () => Promise<unknown>, code: NecResolverOpStackErrorCode): Promise<void> {
  let error: unknown;
  try {
    await fn();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(NecResolverOpStackError);
  expect((error as NecResolverOpStackError).code).toBe(code);
}

function json(value: unknown): string {
  return canonicalJson(value as never);
}

// ---------------------------------------------------------------------------
// Pinned real fixtures (read-only public-RPC captures; see README)
// ---------------------------------------------------------------------------

function fixturePath(relative: string): string {
  return fileURLToPath(new URL(relative, import.meta.url));
}

const REAL = {
  "base-mainnet": {
    evm: "./fixtures/base-mainnet-usdc-transfer.fixture.json",
    evmSha256: "e82b76bd7b195f0f0aff54362be26691774cee7e3633dd395bb5c32e80854279",
    finality: "./fixtures/base-mainnet-finality.fixture.json",
    finalitySha256: "d3973e836e37e7f1255b59b26dc932155ed966edbd6476d6c3397a07c53b2388",
  },
  "base-sepolia": {
    evm: "../../adapter-erc4337/test/fixtures/base-sepolia-external-v06-userop.json",
    evmSha256: "37f7da5719220a16a2841a08360eff4738aab9bbc4873dcbf79307847f4131a3",
    finality: "./fixtures/base-sepolia-finality.fixture.json",
    finalitySha256: "14145495bb347ae5f7daf4c53f08254acc222aaa238d87626fc674ea2205848e",
  },
} as const;

function readPinned(relative: string, sha256: string): unknown {
  const bytes = readFileSync(fixturePath(relative));
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(sha256);
  return JSON.parse(bytes.toString("utf8")) as unknown;
}

function realFixtures(profile: OpStackBeforeProfile): { evmFixture: unknown; finalityFixture: unknown } {
  const pinned = REAL[profile.id as keyof typeof REAL];
  return {
    evmFixture: readPinned(pinned.evm, pinned.evmSha256),
    finalityFixture: readPinned(pinned.finality, pinned.finalitySha256),
  };
}

// ---------------------------------------------------------------------------
// Manifest authority
// ---------------------------------------------------------------------------

describe("OP Stack BEFORE manifest", () => {
  it("claims the generic EVM capabilities plus finality — never settlement", () => {
    const manifest = opStackBeforeResolverManifest();
    expect([...manifest.supportedCapabilities].sort()).toEqual([
      "dataBinding",
      "execution",
      "finality",
      "observedEffects",
    ]);
    for (const name of ["settlement", "simulation", "batching", "executionModel", "accountModel", "gasModel"]) {
      expect(manifest.supportedCapabilities as string[]).not.toContain(name);
    }
    expect(manifest.implementation).toEqual({ package: "@nec/resolver-opstack" });
    expect(manifest.metadata?.chainFamily).toBe("opstack");
    expect(manifest.metadata?.settlement).toBe("never claimed");
    expect(manifest.metadata?.finalityDoesNotEstablish).toEqual([...OPSTACK_FINALITY_DOES_NOT_ESTABLISH]);
  });

  it("names its generic EVM foundation exactly and is frozen/digest-stable", () => {
    const evm = evmBeforeResolverManifest();
    const manifest = opStackBeforeResolverManifest();
    expect(manifest.metadata?.genericEvmFoundation).toEqual({ id: evm.id, version: evm.version, digest: evm.digest });
    expect(manifest.digest).not.toBe(evm.digest);
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(opStackBeforeResolverManifest().digest).toBe(manifest.digest);
  });

  it("lists withdrawal/output-root finalization and settlement as NOT established", () => {
    for (const item of [
      "withdrawal_finalization",
      "output_root_finalization",
      "dispute_game_resolution",
      "settlement",
      "economic_irreversibility",
    ]) {
      expect(OPSTACK_FINALITY_DOES_NOT_ESTABLISH).toContain(item);
    }
  });
});

// ---------------------------------------------------------------------------
// Explicit profiles
// ---------------------------------------------------------------------------

describe("explicit Base BEFORE profiles", () => {
  it("configure Base mainnet and Base Sepolia explicitly as OP Stack", () => {
    expect(BASE_OPSTACK_BEFORE_PROFILES).toEqual([BASE_MAINNET_OPSTACK_BEFORE_PROFILE, BASE_SEPOLIA_OPSTACK_BEFORE_PROFILE]);
    expect(BASE_MAINNET_OPSTACK_BEFORE_PROFILE.config).toEqual({
      networkId: "eip155:8453",
      chainId: 8453,
      family: "opstack",
      ruleset: "opstack.rpc-finalized-head-v1",
      rulesetVersion: "1",
    });
    expect(BASE_SEPOLIA_OPSTACK_BEFORE_PROFILE.config).toEqual({
      networkId: "eip155:84532",
      chainId: 84532,
      family: "opstack",
      ruleset: "opstack.rpc-finalized-head-v1",
      rulesetVersion: "1",
    });
    expect(BASE_MAINNET_OPSTACK_BEFORE_PROFILE.environment).toBe("mainnet");
    expect(BASE_SEPOLIA_OPSTACK_BEFORE_PROFILE.environment).toBe("testnet");
    expect(Object.isFrozen(BASE_SEPOLIA_OPSTACK_BEFORE_PROFILE.config)).toBe(true);
    expect(Object.isFrozen(BASE_OPSTACK_BEFORE_PROFILES)).toBe(true);
  });

  it("never infers the OP Stack family from a chain id", () => {
    const { family: _family, ...noFamily } = BASE_MAINNET_OPSTACK_BEFORE_PROFILE.config;
    expectOpError(
      () =>
        deriveOpStackBeforeFoundation({
          config: noFamily as unknown as OpStackFinalityConfig,
          observationKind: "probe",
          evmObservation: evmObservation(BASE_MAINNET_OPSTACK_BEFORE_PROFILE),
        }),
      "OPSTACK_CONFIG_INVALID",
    );
    expectOpError(
      () =>
        deriveOpStackBeforeFoundation({
          config: { ...BASE_MAINNET_OPSTACK_BEFORE_PROFILE.config, family: "ethereum" } as unknown as OpStackFinalityConfig,
          observationKind: "probe",
          evmObservation: evmObservation(BASE_MAINNET_OPSTACK_BEFORE_PROFILE),
        }),
      "OPSTACK_CONFIG_INVALID",
    );
  });

  it("keeps environment labels outside every evidence artifact", () => {
    for (const profile of BASE_OPSTACK_BEFORE_PROFILES) {
      const f = probeFoundation(profile);
      const pf = deriveOpStackBeforePreflightResult(f, preflightRequest(profile, policy(["finality"])));
      for (const artifact of [f.manifest, f.snapshot, f.candidate, pf]) {
        const text = json(artifact);
        expect(text).not.toContain('"environment"');
        expect(text).not.toContain('"mainnet"');
        expect(text).not.toContain('"testnet"');
        expect(text).not.toContain(profile.label);
        expect(text).not.toContain(`"${profile.id}"`);
      }
    }
  });

  it("produces different snapshots for the two profiles from identical probe shapes", () => {
    const mainnet = probeFoundation(BASE_MAINNET_OPSTACK_BEFORE_PROFILE);
    const sepolia = probeFoundation(BASE_SEPOLIA_OPSTACK_BEFORE_PROFILE);
    expect(mainnet.snapshot.network.networkId).toBe("eip155:8453");
    expect(sepolia.snapshot.network.networkId).toBe("eip155:84532");
    expect(mainnet.snapshot.artifactDigest).not.toBe(sepolia.snapshot.artifactDigest);
  });
});

// ---------------------------------------------------------------------------
// Probe-derived BEFORE parity on BOTH Base profiles
// ---------------------------------------------------------------------------

describe.each(BASE_OPSTACK_BEFORE_PROFILES.map((profile) => [profile.label, profile] as const))(
  "BEFORE parity — %s",
  (_label, profile) => {
    it("produces a contextually verifiable CapabilitySnapshot with finality supported + available", () => {
      const f = probeFoundation(profile);
      expect(verifyCapabilitySnapshot(f.snapshot, { resolver: f.manifest, networkId: profile.config.networkId })).toBe(true);
      expect(f.snapshot.network.chainId).toBe(profile.config.chainId);
      expect(f.snapshot.network.metadata?.chainFamily).toBe("opstack");
      expect(f.snapshot.generatedAt).toBe(T0);
      const finality = f.snapshot.evidenceCapabilities.finality;
      expect(finality.support).toBe("supported");
      expect(finality.availability).toBe("available");
      expect(capabilityIsUsable(finality, f.snapshot.evidence)).toBe(true);
      expect(finality.evidence).toEqual([
        "ev-op-chainidentity",
        "ev-op-finalizedhead",
        "ev-op-safehead",
        "ev-op-latesthead",
        "ev-evm-chainidentity",
        "ev-evm-receipt",
        "ev-evm-block",
      ]);
      expect(finality.metadata?.ruleset).toBe("opstack.rpc-finalized-head-v1");
      expect(finality.metadata?.doesNotEstablish).toEqual([...OPSTACK_FINALITY_DOES_NOT_ESTABLISH]);
      for (const name of ["execution", "observedEffects", "dataBinding"] as const) {
        expect(f.snapshot.evidenceCapabilities[name].availability).toBe("available");
      }
    });

    it("reuses the generic EVM capability states verbatim", () => {
      const f = probeFoundation(profile);
      const generic = deriveEvmBeforeFoundation({ networkId: profile.config.networkId, observation: evmObservation(profile) });
      for (const name of ["execution", "observedEffects", "dataBinding"] as const) {
        expect(f.snapshot.evidenceCapabilities[name]).toEqual(generic.snapshot.evidenceCapabilities[name]);
      }
    });

    it("produces a discovery candidate that is eligible for required finality and verifiable in a DiscoverNetworksResult", () => {
      const f = probeFoundation(profile);
      const request: DiscoveryRequirements = {
        requirements: [
          { capability: "execution", strength: "required" },
          { capability: "finality", strength: "required" },
        ],
      };
      const composed = composeDiscoveryMatch(request, f.candidate);
      expect(composed.classification).toBe("eligible");
      const result = buildDiscoverNetworksResult(
        {
          schemaVersion: "0.1",
          requestId: `disc_${profile.id}`,
          generatedAt: T0,
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
      expect(
        verifyDiscoverNetworksResult(result, { capabilitySnapshots: [f.snapshot], resolverManifests: [f.manifest] }),
      ).toBe(true);
    });

    it("derives a READY evidence Preflight for required finality, verifiable in context", () => {
      const f = probeFoundation(profile);
      const pf = deriveOpStackBeforePreflightResult(f, preflightRequest(profile, policy(["execution", "finality"])));
      expect(pf.status).toBe("ready");
      expect(pf.evidenceReadiness.finality.status).toBe("ready");
      expect(pf.evidenceReadiness.settlement.status).toBe("not_applicable");
      expect(Object.keys(pf.evidenceReadiness).sort()).toEqual([
        "dataBinding",
        "execution",
        "finality",
        "observedEffects",
        "settlement",
      ]);
      expect(verifyPreflightResult(pf, { resolver: f.manifest, capabilitySnapshot: f.snapshot })).toBe(true);
    });

    it("keeps preflight evidence-readiness only (no wallet/funding/signing/submission fields)", () => {
      const f = probeFoundation(profile);
      const pf = deriveOpStackBeforePreflightResult(f, preflightRequest(profile, policy(["finality"])));
      const text = json(pf).toLowerCase();
      for (const word of ["wallet", "balance", "funding", "signature", "signing", "submission", "gasprice", "nonce"]) {
        expect(text).not.toContain(`"${word}`);
      }
    });
  },
);

// ---------------------------------------------------------------------------
// Finality availability ladder (support never changes)
// ---------------------------------------------------------------------------

describe("finality availability is derived from the probe observation", () => {
  const profile = BASE_SEPOLIA_OPSTACK_BEFORE_PROFILE;

  function finalityOf(f: OpStackBeforeFoundation) {
    return f.snapshot.evidenceCapabilities.finality;
  }

  it("absent finality probe -> unknown (manifest membership does not prove availability)", () => {
    const state = finalityOf(probeFoundation(profile, null));
    expect(state.support).toBe("supported");
    expect(state.availability).toBe("unknown");
    expect(state.evidence).toBeUndefined();
    const pf = deriveOpStackBeforePreflightResult(probeFoundation(profile, null), preflightRequest(profile, policy(["finality"])));
    expect(pf.status).toBe("unknown");
    expect(composeDiscoveryMatch({ requirements: [{ capability: "finality", strength: "required" }] }, probeFoundation(profile, null).candidate).classification).toBe("ineligible");
  });

  it("finality probe source unreachable -> unavailable", () => {
    const state = finalityOf(
      probeFoundation(profile, {
        rpcReachable: false,
        chainIdentityObserved: false,
        finalizedHeadLookupUsable: false,
        safeHeadLookupUsable: false,
        latestHeadLookupUsable: false,
        headOrderingCoherent: false,
        evidence: [],
      }),
    );
    expect(state.availability).toBe("unavailable");
    expect(capabilityIsDeterministicallyUnavailable(state)).toBe(true);
  });

  it("chain identity not observed by the finality probe -> unknown", () => {
    const base = finalityObservation(profile);
    const state = finalityOf(
      probeFoundation(profile, { chainIdentityObserved: false, evidence: withoutRef(base, "chainidentity") }),
    );
    expect(state.availability).toBe("unknown");
  });

  it("finalized head unusable -> unavailable even when safe/latest are usable (never substituted)", () => {
    const base = finalityObservation(profile);
    const f = probeFoundation(profile, {
      finalizedHeadLookupUsable: false,
      headOrderingCoherent: false,
      evidence: withoutRef(base, "finalizedhead"),
    });
    expect(finalityOf(f).availability).toBe("unavailable");
    expect(finalityOf(f).reason).toContain("never substituted");
    const pf = deriveOpStackBeforePreflightResult(f, preflightRequest(profile, policy(["finality"])));
    expect(pf.status).toBe("blocked");
  });

  it("safe or latest head unusable -> unavailable", () => {
    const base = finalityObservation(profile);
    for (const [flag, path] of [
      ["safeHeadLookupUsable", "safehead"],
      ["latestHeadLookupUsable", "latesthead"],
    ] as const) {
      const state = finalityOf(
        probeFoundation(profile, { [flag]: false, headOrderingCoherent: false, evidence: withoutRef(base, path) }),
      );
      expect(state.availability).toBe("unavailable");
    }
  });

  it("incoherent head ordering -> degraded (deterministically unavailable)", () => {
    const state = finalityOf(probeFoundation(profile, { headOrderingCoherent: false }));
    expect(state.availability).toBe("degraded");
    expect(capabilityIsDeterministicallyUnavailable(state)).toBe(true);
  });

  it("generic receipt/block anchor path unavailable -> finality unavailable; undetermined -> unknown", () => {
    const evm = evmObservation(profile);
    const noReceipt = probeFoundation(profile, {}, {
      receiptLookupUsable: false,
      evidence: evm.evidence.filter((ref) => ref.id !== "ev-evm-receipt"),
    });
    expect(finalityOf(noReceipt).availability).toBe("unavailable");
    const unknownIdentity = probeFoundation(profile, {}, {
      chainIdentityObserved: false,
      evidence: evm.evidence.filter((ref) => ref.id !== "ev-evm-chainidentity"),
    });
    expect(unknownIdentity.snapshot.evidenceCapabilities.execution.availability).toBe("unknown");
    expect(finalityOf(unknownIdentity).availability).toBe("unknown");
  });

  it("never lets an outage change support", () => {
    const state = finalityOf(probeFoundation(profile, { headOrderingCoherent: false }));
    expect(state.support).toBe("supported");
    expect(probeFoundation(profile).snapshot.evidenceCapabilities.settlement.support).toBe("unsupported");
  });
});

// ---------------------------------------------------------------------------
// Fail-closed probe validation
// ---------------------------------------------------------------------------

describe("fail-closed validation", () => {
  const profile = BASE_MAINNET_OPSTACK_BEFORE_PROFILE;

  it("rejects ghost evidence: positive finalized-head flag without a tagged ref", () => {
    const base = finalityObservation(profile);
    expectOpError(() => probeFoundation(profile, { evidence: withoutRef(base, "finalizedhead") }), "OPSTACK_OBSERVATION_INCOMPLETE");
  });

  it("rejects coherence claims without usable heads and positive flags while unreachable", () => {
    const base = finalityObservation(profile);
    expectOpError(
      () => probeFoundation(profile, { safeHeadLookupUsable: false, evidence: withoutRef(base, "safehead") }),
      "OPSTACK_OBSERVATION_INCOMPLETE",
    );
    expectOpError(() => probeFoundation(profile, { rpcReachable: false }), "OPSTACK_OBSERVATION_INCOMPLETE");
  });

  it("rejects unknown probePath tags", () => {
    expectOpError(
      () =>
        probeFoundation(profile, {
          evidence: [
            ...finalityObservation(profile).evidence,
            finalityRef(profile, "finalizedhead", { id: "ev-op-x", metadata: { probePath: "withdrawalfinalized" } }),
          ],
        }),
      "OPSTACK_PROBE_INVALID",
    );
  });

  it("rejects chain ids that differ from the explicit configuration", () => {
    expectOpError(() => probeFoundation(profile, { chainId: 84532 }), "OPSTACK_NETWORK_MISMATCH");
    expectOpError(() => probeFoundation(profile, {}, { chainId: 84532 }), "OPSTACK_NETWORK_MISMATCH");
  });

  it("rejects a positive chain identity claim without the observed chain id", () => {
    const { chainId: _c, ...noChain } = finalityObservation(profile);
    expectOpError(
      () =>
        deriveOpStackBeforeFoundation({
          config: profile.config,
          observationKind: "probe",
          evmObservation: evmObservation(profile),
          finalityObservation: noChain as OpStackFinalityProbeObservation,
        }),
      "OPSTACK_PROBE_INVALID",
    );
  });

  it("rejects observations for another network than the configured one", () => {
    expectOpError(
      () =>
        deriveOpStackBeforeFoundation({
          config: profile.config,
          observationKind: "probe",
          evmObservation: evmObservation(BASE_SEPOLIA_OPSTACK_BEFORE_PROFILE),
        }),
      "OPSTACK_NETWORK_MISMATCH",
    );
    expectOpError(
      () =>
        deriveOpStackBeforeFoundation({
          config: profile.config,
          observationKind: "probe",
          evmObservation: evmObservation(profile),
          finalityObservation: finalityObservation(BASE_SEPOLIA_OPSTACK_BEFORE_PROFILE, { chainId: 8453 }),
        }),
      "OPSTACK_NETWORK_MISMATCH",
    );
  });

  it("rejects cross-network and cross-source finality refs", () => {
    const refs = finalityObservation(profile).evidence;
    expectOpError(
      () => probeFoundation(profile, { evidence: [...refs.slice(1), { ...refs[0]!, networkId: "eip155:84532" }] }),
      "OPSTACK_NETWORK_MISMATCH",
    );
    expectOpError(
      () => probeFoundation(profile, { evidence: [...refs.slice(1), { ...refs[0]!, sourceId: "src.other" }] }),
      "OPSTACK_PROBE_INVALID",
    );
  });

  it("requires one probe time for probe observations", () => {
    expectOpError(() => probeFoundation(profile, { observedAt: T1 }), "OPSTACK_TIME_INVALID");
  });

  it("rejects EvidenceId collisions across the EVM and finality tables", () => {
    const evmIds = evmObservation(profile).evidence;
    expectOpError(
      () => probeFoundation(profile, { evidence: [...finalityObservation(profile).evidence, { ...finalityRef(profile, "safehead"), id: evmIds[0]!.id }] }),
      "OPSTACK_PROBE_INVALID",
    );
  });

  it("rejects unknown observation kinds and unknown keys", () => {
    expectOpError(
      () =>
        deriveOpStackBeforeFoundation({
          config: profile.config,
          observationKind: "live" as never,
          evmObservation: evmObservation(profile),
        }),
      "OPSTACK_PROBE_INVALID",
    );
    expectOpError(
      () => probeFoundation(profile, { settlementObserved: true } as unknown as Partial<OpStackFinalityProbeObservation>),
      "OPSTACK_PROBE_INVALID",
    );
    expectOpError(
      () =>
        deriveOpStackBeforeFoundation({
          config: profile.config,
          observationKind: "probe",
          evmObservation: evmObservation(profile),
          environment: "mainnet",
        } as never),
      "OPSTACK_PROBE_INVALID",
    );
  });

  it("re-types generic EVM rejections into the OP Stack error surface", () => {
    expectOpError(() => probeFoundation(profile, {}, { observedAt: "2026-10-08T06:00:00Z" }), "OPSTACK_TIME_INVALID");
    expectOpError(() => probeFoundation(profile, {}, { evidence: [] }), "OPSTACK_OBSERVATION_INCOMPLETE");
  });

  it("binds preflight to the OP Stack manifest and the snapshot network", () => {
    const f = probeFoundation(profile);
    expectOpError(
      () => deriveOpStackBeforePreflightResult(f, preflightRequest(profile, policy(["finality"]), "eip155:84532")),
      "OPSTACK_NETWORK_MISMATCH",
    );
    const generic = deriveEvmBeforeFoundation({ networkId: profile.config.networkId, observation: evmObservation(profile) });
    expectOpError(
      () =>
        deriveOpStackBeforePreflightResult(
          generic as unknown as OpStackBeforeFoundation,
          preflightRequest(profile, policy(["execution"])),
        ),
      "OPSTACK_PROBE_INVALID",
    );
  });
});

// ---------------------------------------------------------------------------
// THE semantic boundary: finality != settlement != withdrawal finalization
// ---------------------------------------------------------------------------

describe("finality is never settlement; withdrawal finalization is never inferred", () => {
  it.each(BASE_OPSTACK_BEFORE_PROFILES.map((profile) => [profile.label, profile] as const))(
    "%s: settlement stays unsupported while finality is available",
    (_label, profile) => {
      const f = probeFoundation(profile);
      expect(f.snapshot.evidenceCapabilities.finality.availability).toBe("available");
      const settlement = f.snapshot.evidenceCapabilities.settlement;
      expect(settlement.support).toBe("unsupported");
      expect(settlement.availability).toBe("unavailable");
      expect(settlement.evidence).toBeUndefined();
      expect(settlement.reason).toContain("never settlement");

      const discovery = composeDiscoveryMatch(
        {
          requirements: [
            { capability: "finality", strength: "required" },
            { capability: "settlement", strength: "required" },
          ],
        },
        f.candidate,
      );
      expect(discovery.classification).toBe("ineligible");
      expect(discovery.evaluations[0]?.status).toBe("satisfied");
      expect(discovery.evaluations[1]?.status).toBe("unsatisfied");

      const pf = deriveOpStackBeforePreflightResult(f, preflightRequest(profile, policy(["finality", "settlement"])));
      expect(pf.evidenceReadiness.finality.status).toBe("ready");
      expect(pf.evidenceReadiness.settlement.status).toBe("not_applicable");
      expect(pf.status).toBe("blocked");
    },
  );

  it("never leaves settlement positive in any finality scenario", () => {
    const profile = BASE_SEPOLIA_OPSTACK_BEFORE_PROFILE;
    const scenarios: Array<OpStackBeforeFoundation> = [
      probeFoundation(profile),
      probeFoundation(profile, null),
      probeFoundation(profile, { headOrderingCoherent: false }),
    ];
    for (const f of scenarios) {
      expect(f.snapshot.evidenceCapabilities.settlement.support).toBe("unsupported");
      expect(capabilityIsUsable(f.snapshot.evidenceCapabilities.settlement, f.snapshot.evidence)).toBe(false);
      expect(Object.keys(f.snapshot.executionCapabilities)).toEqual([]);
    }
  });

  it("records withdrawal/output-root finalization only as NOT established", () => {
    const f = probeFoundation(BASE_MAINNET_OPSTACK_BEFORE_PROFILE);
    const finality = f.snapshot.evidenceCapabilities.finality;
    expect(finality.metadata?.doesNotEstablish).toContain("withdrawal_finalization");
    expect(finality.metadata?.doesNotEstablish).toContain("output_root_finalization");
    expect(String(finality.metadata?.semantics)).toContain("never withdrawal or output-root finalization");
    // No capability name or probe path can express withdrawal finalization.
    expect(Object.keys(f.snapshot.evidenceCapabilities).sort()).toEqual([
      "dataBinding",
      "execution",
      "finality",
      "observedEffects",
      "settlement",
    ]);
  });

  it("rejects a forged snapshot claiming settlement against the OP Stack manifest", () => {
    const f = probeFoundation(BASE_MAINNET_OPSTACK_BEFORE_PROFILE);
    const forged: CapabilitySnapshotContent = {
      schemaVersion: "0.1",
      id: "opstack-capsnap-forged",
      generatedAt: T0,
      network: f.network,
      evidenceCapabilities: {
        ...f.snapshot.evidenceCapabilities,
        settlement: { ...f.snapshot.evidenceCapabilities.finality },
      },
      executionCapabilities: {},
      evidence: [...f.snapshot.evidence],
      resolver: { id: f.manifest.id, version: f.manifest.version, digest: f.manifest.digest },
    };
    expect(() =>
      buildCapabilitySnapshot(forged, { resolver: f.manifest, networkId: BASE_MAINNET_OPSTACK_BEFORE_PROFILE.config.networkId }),
    ).toThrow(/supportedCapabilities/);
  });
});

// ---------------------------------------------------------------------------
// Offline replay of the pinned real fixtures (historical_replay)
// ---------------------------------------------------------------------------

describe("historical replay of pinned real Base fixtures", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = vi.fn(() => {
      throw new Error("network access is forbidden during replay");
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it.each(BASE_OPSTACK_BEFORE_PROFILES.map((profile) => [profile.label, profile] as const))(
    "%s: replays offline into a verifiable snapshot whose current availability stays UNKNOWN",
    async (_label, profile) => {
      const f = await replayOpStackBeforeFoundation({ config: profile.config, ...realFixtures(profile) });
      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect(verifyCapabilitySnapshot(f.snapshot, { resolver: f.manifest, networkId: profile.config.networkId })).toBe(true);
      expect(f.snapshot.network.metadata?.observationKind).toBe("historical_replay");
      for (const name of ["execution", "observedEffects", "dataBinding", "finality"] as const) {
        const state = f.snapshot.evidenceCapabilities[name];
        expect(state.support).toBe("supported");
        expect(state.availability).toBe("unknown");
        expect(state.metadata?.currentAvailability).toBe("unknown");
        expect(state.metadata?.historicalAvailabilityAtCapture).toBe("available");
        expect(capabilityIsUsable(state, f.snapshot.evidence)).toBe(false);
        const known = new Set(f.snapshot.evidence.map((ref) => ref.id));
        for (const id of state.evidence ?? []) expect(known.has(id)).toBe(true);
      }
      const finality = f.snapshot.evidenceCapabilities.finality;
      expect(finality.evidence?.some((id) => id.startsWith("opstack-finalized-head-"))).toBe(true);
      expect(finality.metadata?.doesNotEstablish).toContain("withdrawal_finalization");
      expect(f.snapshot.evidenceCapabilities.settlement.support).toBe("unsupported");

      const discovery = composeDiscoveryMatch(
        { requirements: [{ capability: "finality", strength: "required" }] },
        f.candidate,
      );
      expect(discovery.classification).toBe("ineligible");
      expect(discovery.evaluations[0]?.status).toBe("unknown");

      const pf = deriveOpStackBeforePreflightResult(f, preflightRequest(profile, policy(["execution", "finality"])));
      expect(pf.status).toBe("unknown");
      expect(pf.evidenceReadiness.finality.status).toBe("unknown");
      expect(verifyPreflightResult(pf, { resolver: f.manifest, capabilitySnapshot: f.snapshot })).toBe(true);
    },
  );

  it("is deterministic: two replays produce identical snapshot digests", async () => {
    for (const profile of BASE_OPSTACK_BEFORE_PROFILES) {
      const a = await replayOpStackBeforeFoundation({ config: profile.config, ...realFixtures(profile) });
      const b = await replayOpStackBeforeFoundation({ config: profile.config, ...realFixtures(profile) });
      expect(a.snapshot.artifactDigest).toBe(b.snapshot.artifactDigest);
    }
  });

  it("pins the Base Sepolia finality burst: identity, ordered heads and a completed bounded walk", async () => {
    const { finalityFixture } = realFixtures(BASE_SEPOLIA_OPSTACK_BEFORE_PROFILE);
    const observation = await replayOpStackFinalityObservation(finalityFixture);
    expect(observation.consistent).toBe(true);
    expect(observation.chain.chainId).toBe(84532n);
    expect(observation.finalizedHead?.number).toBe(47835408n);
    expect(observation.ancestry?.requiredDepth).toBe(8n);
    expect(observation.ancestry?.blocks.length).toBe(8);
    expect(observation.ancestry?.blocks.every((block) => block !== null)).toBe(true);
    expect(observation.finalizedReRead?.hash).toBe(observation.finalizedHead?.hash);
    expect(observation.acquiredAt).toBe("2026-10-08T06:14:13.704Z");
  });

  it("without a finality fixture leaves finality unknown with no capture-time claim", async () => {
    const { evmFixture } = realFixtures(BASE_SEPOLIA_OPSTACK_BEFORE_PROFILE);
    const f = await replayOpStackBeforeFoundation({ config: BASE_SEPOLIA_OPSTACK_BEFORE_PROFILE.config, evmFixture });
    expect(f.snapshot.evidenceCapabilities.finality.availability).toBe("unknown");
    expect(f.snapshot.evidenceCapabilities.finality.metadata?.historicalAvailabilityAtCapture).toBe("unknown");
  });

  it("fails closed when a fixture does not match the configured network", async () => {
    await expectOpErrorAsync(
      () =>
        replayOpStackBeforeFoundation({
          config: BASE_MAINNET_OPSTACK_BEFORE_PROFILE.config,
          ...realFixtures(BASE_SEPOLIA_OPSTACK_BEFORE_PROFILE),
        }),
      "OPSTACK_NETWORK_MISMATCH",
    );
    const mainnet = realFixtures(BASE_MAINNET_OPSTACK_BEFORE_PROFILE);
    const sepolia = realFixtures(BASE_SEPOLIA_OPSTACK_BEFORE_PROFILE);
    await expectOpErrorAsync(
      () =>
        replayOpStackBeforeFoundation({
          config: BASE_MAINNET_OPSTACK_BEFORE_PROFILE.config,
          evmFixture: mainnet.evmFixture,
          finalityFixture: sepolia.finalityFixture,
        }),
      "OPSTACK_NETWORK_MISMATCH",
    );
  });

  it("fails closed on a tampered archived capture", async () => {
    const { evmFixture, finalityFixture } = realFixtures(BASE_SEPOLIA_OPSTACK_BEFORE_PROFILE);
    const tampered = JSON.parse(JSON.stringify(finalityFixture)) as { captures: Array<{ resultJson: string }> };
    tampered.captures[0]!.resultJson = '"0x2105"';
    await expect(
      replayOpStackBeforeFoundation({ config: BASE_SEPOLIA_OPSTACK_BEFORE_PROFILE.config, evmFixture, finalityFixture: tampered }),
    ).rejects.toBeInstanceOf(NecResolverOpStackError);
  });
});

// ---------------------------------------------------------------------------
// Determinism and hygiene
// ---------------------------------------------------------------------------

describe("determinism and hygiene", () => {
  it("derives byte-stable, deeply frozen artifacts", () => {
    const profile = BASE_MAINNET_OPSTACK_BEFORE_PROFILE;
    const a = probeFoundation(profile);
    const b = probeFoundation(profile);
    expect(a.snapshot.artifactDigest).toBe(b.snapshot.artifactDigest);
    const pa = deriveOpStackBeforePreflightResult(a, preflightRequest(profile, policy(["finality"])));
    const pb = deriveOpStackBeforePreflightResult(b, preflightRequest(profile, policy(["finality"])));
    expect(pa.artifactDigest).toBe(pb.artifactDigest);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.snapshot.evidenceCapabilities.finality)).toBe(true);
    expect(Object.isFrozen(pa)).toBe(true);
  });

  it("binds probe time into the snapshot digest", () => {
    const profile = BASE_SEPOLIA_OPSTACK_BEFORE_PROFILE;
    const early = probeFoundation(profile);
    const evm = evmObservation(profile);
    const late = deriveOpStackBeforeFoundation({
      config: profile.config,
      observationKind: "probe",
      evmObservation: { ...evm, observedAt: T1 },
      finalityObservation: finalityObservation(profile, { observedAt: T1 }),
    });
    expect(late.snapshot.generatedAt).toBe(T1);
    expect(late.snapshot.artifactDigest).not.toBe(early.snapshot.artifactDigest);
  });
});
