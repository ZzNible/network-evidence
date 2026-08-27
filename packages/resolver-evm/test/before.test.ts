/**
 * BEFORE-side foundation tests (generic EVM v0.1).
 *
 * Covers the semantic split (SUPPORT vs AVAILABILITY vs OBSERVED EVIDENCE),
 * conservative manifest authority, fail-closed probe validation (ghost
 * evidence, network mismatch, cross-network refs), discovery-ready candidate
 * data, preflight evidence readiness (ready/blocked/unknown/not_applicable),
 * and determinism/purity of the pure derivation model.
 */

import { describe, expect, it } from "vitest";

import {
  buildCapabilitySnapshot,
  capabilityIsDeterministicallyUnavailable,
  capabilityIsUsable,
  composeDiscoveryMatch,
  computeEvidencePolicyDigest,
  verifyCapabilitySnapshot,
  verifyCapabilitySnapshotIntegrity,
  verifyPreflightResult,
  verifyPreflightResultIntegrity,
} from "@nec/core";
import type {
  CapabilitySnapshot,
  CapabilitySnapshotContent,
  EvidencePolicy,
  EvidenceRef,
  PolicyDimension,
  PreflightRequest,
} from "@nec/core";

import { NecResolverEvmError } from "../src/index.js";
import type { NecResolverEvmErrorCode } from "../src/index.js";
import {
  deriveEvmBeforeFoundation,
  deriveEvmBeforePreflightResult,
  evmBeforeResolverManifest,
  PROBE_PATH_METADATA_KEY,
} from "../src/before.js";
import type { EvmBeforeFoundation, EvmCapabilityProbeObservation, EvmProbePath } from "../src/before.js";

// ---------------------------------------------------------------------------
// Deterministic sample world
// ---------------------------------------------------------------------------

const T0 = "2026-03-14T09:26:53.589Z";
const T1 = "2026-03-14T09:31:53.589Z";
const NET = "eip155:11155111";
const OTHER_NET = "eip155:8453";

const PATH_DIGESTS: Record<EvmProbePath, string> = {
  chainidentity: `sha256:${"aa".repeat(32)}`,
  receipt: `sha256:${"bb".repeat(32)}`,
  block: `sha256:${"cc".repeat(32)}`,
  transaction: `sha256:${"dd".repeat(32)}`,
};

function probeRef(path: EvmProbePath, overrides: Partial<EvidenceRef> = {}): EvidenceRef {
  return {
    id: overrides.id ?? `ev-probe-${path}`,
    sourceId: "src.sepolia.primary",
    sourceType: "evm_rpc",
    locator: `probe:${path}`,
    retrievedAt: T0,
    contentDigest: PATH_DIGESTS[path],
    networkId: NET,
    metadata: { [PROBE_PATH_METADATA_KEY]: path },
    ...overrides,
  };
}

function healthyEvidence(): EvidenceRef[] {
  return [
    probeRef("chainidentity"),
    probeRef("receipt"),
    probeRef("block"),
    probeRef("transaction"),
  ];
}

function healthyObservation(
  overrides: Partial<EvmCapabilityProbeObservation> = {},
): EvmCapabilityProbeObservation {
  return {
    network: NET,
    chainId: 11155111,
    source: { sourceId: "src.sepolia.primary", sourceType: "evm_rpc" },
    observedAt: T0,
    rpcReachable: true,
    chainIdentityObserved: true,
    receiptLookupUsable: true,
    blockLookupUsable: true,
    transactionLookupUsable: true,
    evidence: healthyEvidence(),
    ...overrides,
  };
}

function foundation(observation: EvmCapabilityProbeObservation = healthyObservation()): EvmBeforeFoundation {
  return deriveEvmBeforeFoundation({ networkId: NET, observation });
}

function policy(required: PolicyDimension[], desired?: PolicyDimension[]): EvidencePolicy {
  const content = {
    id: "payment-basic",
    version: "1",
    requiredDimensions: required,
    ...(desired === undefined ? {} : { desiredDimensions: desired }),
  };
  return { ...content, digest: computeEvidencePolicyDigest(content) };
}

function preflightRequest(
  evidencePolicy: EvidencePolicy,
  overrides: Partial<PreflightRequest> = {},
): PreflightRequest {
  return {
    schemaVersion: "0.1",
    requestId: "pf_req_1",
    networkId: NET,
    action: { kind: "erc20.transfer", target: `0x${"aa".repeat(20)}`, value: "0" },
    evidencePolicy,
    ...overrides,
  };
}

function expectEvmError(fn: () => unknown, code: NecResolverEvmErrorCode): void {
  let error: unknown;
  try {
    fn();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(NecResolverEvmError);
  expect((error as NecResolverEvmError).code).toBe(code);
}

function snapshotIds(snapshot: CapabilitySnapshot): Set<string> {
  return new Set(snapshot.evidence.map((ref) => ref.id));
}

// ---------------------------------------------------------------------------
// Resolver manifest authority
// ---------------------------------------------------------------------------

describe("generic EVM resolver manifest", () => {
  it("claims exactly execution, observedEffects and dataBinding", () => {
    const manifest = evmBeforeResolverManifest();
    expect([...manifest.supportedCapabilities].sort()).toEqual([
      "dataBinding",
      "execution",
      "observedEffects",
    ]);
    expect(manifest.networkFamilies).toEqual(["eip155"]);
    expect(() => verifyCapabilitySnapshotIntegrity(expect.anything())).not.toThrow(); // guard sanity
    // Digest is self-consistent through the core verifier surface.
    expect(verifyCapabilitySnapshot(foundation().snapshot, {
      resolver: manifest,
      networkId: NET,
    })).toBe(true);
  });

  it("never claims settlement, finality, simulation, batching or any model dimension", () => {
    const claimed = new Set<string>(evmBeforeResolverManifest().supportedCapabilities);
    for (const name of [
      "settlement",
      "finality",
      "simulation",
      "batching",
      "executionModel",
      "accountModel",
      "gasModel",
    ]) {
      expect(claimed.has(name)).toBe(false);
    }
  });

  it("is frozen and digest-stable across calls", () => {
    const a = evmBeforeResolverManifest();
    const b = evmBeforeResolverManifest();
    expect(Object.isFrozen(a)).toBe(true);
    expect(a.digest).toBe(b.digest);
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// Happy-path derivation
// ---------------------------------------------------------------------------

describe("foundation derivation (all three supported and available)", () => {
  it("produces a contextually verifiable CapabilitySnapshot", () => {
    const f = foundation();
    expect(verifyCapabilitySnapshotIntegrity(f.snapshot)).toBe(true);
    expect(
      verifyCapabilitySnapshot(f.snapshot, { resolver: f.manifest, networkId: NET }),
    ).toBe(true);
    expect(f.snapshot.generatedAt).toBe(T0);
    expect(f.network.networkId).toBe(NET);
    expect(f.candidate.snapshot).toBe(f.snapshot);
    expect(f.candidate.resolver).toBe(f.manifest);
  });

  it("marks all three capabilities supported AND available with concrete resolvable citations", () => {
    const f = foundation();
    const known = snapshotIds(f.snapshot);
    for (const name of ["execution", "observedEffects", "dataBinding"] as const) {
      const state = f.snapshot.evidenceCapabilities[name];
      expect(state.support).toBe("supported");
      expect(state.availability).toBe("available");
      expect(state.evidence!.length).toBeGreaterThan(0);
      for (const id of state.evidence!) expect(known.has(id)).toBe(true);
      expect(capabilityIsUsable(state, f.snapshot.evidence)).toBe(true);
    }
    // Deterministic provenance projection: chain identity first, then paths.
    expect(f.snapshot.evidenceCapabilities.observedEffects.evidence).toEqual([
      "ev-probe-chainidentity",
      "ev-probe-receipt",
    ]);
    expect(f.snapshot.evidenceCapabilities.dataBinding.evidence).toEqual([
      "ev-probe-chainidentity",
      "ev-probe-receipt",
      "ev-probe-block",
      "ev-probe-transaction",
    ]);
  });

  it("keeps settlement and finality unsupported and deterministically unavailable", () => {
    const f = foundation();
    for (const name of ["settlement", "finality"] as const) {
      const state = f.snapshot.evidenceCapabilities[name];
      expect(state.support).toBe("unsupported");
      expect(capabilityIsDeterministicallyUnavailable(state)).toBe(true);
      expect(state.evidence).toBeUndefined();
    }
  });

  it("leaves every execution-family capability slot unclaimed", () => {
    const f = foundation();
    for (const key of [
      "executionModel",
      "accountModel",
      "gasModel",
      "simulation",
      "batching",
    ] as const) {
      expect(f.snapshot.executionCapabilities[key]).toBeUndefined();
    }
  });

  it("classifies acquisition-style refs by metadata.rpcMethod when no explicit probe tag exists", () => {
    const f = foundation(
      healthyObservation({
        evidence: [
          probeRef("chainidentity", { id: "ev-chainid", metadata: { rpcMethod: "eth_chainId" } }),
          probeRef("receipt", { id: "ev-receipt", metadata: { rpcMethod: "eth_getTransactionReceipt" } }),
          probeRef("block", { id: "ev-block", metadata: { rpcMethod: "eth_getBlockByHash" } }),
          probeRef("transaction", { id: "ev-tx", metadata: { rpcMethod: "eth_getTransactionByHash" } }),
        ],
      }),
    );
    expect(f.snapshot.evidenceCapabilities.observedEffects.evidence).toEqual([
      "ev-chainid",
      "ev-receipt",
    ]);
    expect(f.snapshot.evidenceCapabilities.execution.availability).toBe("available");
  });
});

// ---------------------------------------------------------------------------
// Fail-closed probe validation
// ---------------------------------------------------------------------------

describe("probe observation fail-closed validation", () => {
  it("rejects an observation whose network differs from the requested target", () => {
    expectEvmError(
      () => deriveEvmBeforeFoundation({ networkId: NET, observation: healthyObservation({ network: OTHER_NET }) }),
      "EVM_NETWORK_MISMATCH",
    );
  });

  it("rejects cross-network EvidenceRefs inside the probe table", () => {
    expectEvmError(
      () =>
        foundation(
          healthyObservation({
            evidence: [probeRef("receipt", { networkId: OTHER_NET })],
          }),
        ),
      "EVM_NETWORK_MISMATCH",
    );
  });

  it("fails ghost evidence: positive lookup flag without any backing EvidenceRef", () => {
    expectEvmError(
      () =>
        foundation(
          healthyObservation({
            receiptLookupUsable: true,
            evidence: healthyEvidence().filter((ref) => ref.id !== "ev-probe-receipt"),
          }),
        ),
      "EVM_OBSERVATION_INCOMPLETE",
    );
  });

  it("fails ghost reachability: rpcReachable=true with an empty evidence table", () => {
    expectEvmError(
      () => foundation(healthyObservation({ evidence: [] })),
      "EVM_OBSERVATION_INCOMPLETE",
    );
  });

  it("rejects duplicate EvidenceIds", () => {
    expectEvmError(
      () =>
        foundation(
          healthyObservation({
            evidence: [probeRef("receipt"), { ...probeRef("receipt"), locator: "duplicate" }],
          }),
        ),
      "EVM_FIXTURE_INVALID",
    );
  });

  it("rejects structurally invalid EvidenceRefs", () => {
    expectEvmError(
      () =>
        foundation(
          healthyObservation({
            evidence: [probeRef("receipt", { contentDigest: "0x1234" })],
          }),
        ),
      "EVM_FIXTURE_INVALID",
    );
  });

  it("rejects unknown probePath tags (fail closed, never inert)", () => {
    expectEvmError(
      () =>
        foundation(
          healthyObservation({
            evidence: [probeRef("receipt", { metadata: { [PROBE_PATH_METADATA_KEY]: "nonsense" } })],
          }),
        ),
      "EVM_FIXTURE_INVALID",
    );
  });

  it("rejects malformed flags and unknown keys", () => {
    expectEvmError(
      () =>
        foundation(
          healthyObservation({
            receiptLookupUsable: "yes",
          } as unknown as Partial<EvmCapabilityProbeObservation>),
        ),
      "EVM_FIXTURE_INVALID",
    );
    expectEvmError(
      () =>
        foundation(healthyObservation({ extra: true } as unknown as Partial<EvmCapabilityProbeObservation>)),
      "EVM_FIXTURE_INVALID",
    );
  });

  it("rejects a malformed observedAt timestamp", () => {
    expectEvmError(
      () => foundation(healthyObservation({ observedAt: "2026-03-14T09:26:53Z" })),
      "EVM_TIME_INVALID",
    );
  });
});

// ---------------------------------------------------------------------------
// Availability semantics (outage changes availability, never support)
// ---------------------------------------------------------------------------

describe("capability availability semantics", () => {
  it("RPC outage makes everything unavailable while support stays untouched", () => {
    const f = foundation(healthyObservation({ rpcReachable: false }));
    for (const name of ["execution", "observedEffects", "dataBinding"] as const) {
      const state = f.snapshot.evidenceCapabilities[name];
      expect(state.support).toBe("supported");
      expect(state.availability).toBe("unavailable");
      expect(state.reason).toContain("did not answer");
      expect(state.evidence).toBeUndefined();
    }
  });

  it("a broken receipt path takes down every supported capability", () => {
    const f = foundation(
      healthyObservation({
        receiptLookupUsable: false,
        evidence: healthyEvidence().filter((ref) => ref.id !== "ev-probe-receipt"),
      }),
    );
    for (const name of ["execution", "observedEffects", "dataBinding"] as const) {
      expect(f.snapshot.evidenceCapabilities[name].availability).toBe("unavailable");
      expect(f.snapshot.evidenceCapabilities[name].support).toBe("supported");
    }
  });

  it("a broken block path leaves observedEffects available but blocks execution and dataBinding", () => {
    const f = foundation(
      healthyObservation({
        blockLookupUsable: false,
        evidence: healthyEvidence().filter((ref) => ref.id !== "ev-probe-block"),
      }),
    );
    expect(f.snapshot.evidenceCapabilities.observedEffects.availability).toBe("available");
    expect(f.snapshot.evidenceCapabilities.execution.availability).toBe("unavailable");
    expect(f.snapshot.evidenceCapabilities.dataBinding.availability).toBe("unavailable");
  });

  it("a broken transaction path degrades only dataBinding", () => {
    const f = foundation(
      healthyObservation({
        transactionLookupUsable: false,
        evidence: healthyEvidence().filter((ref) => ref.id !== "ev-probe-transaction"),
      }),
    );
    expect(f.snapshot.evidenceCapabilities.execution.availability).toBe("available");
    expect(f.snapshot.evidenceCapabilities.observedEffects.availability).toBe("available");
    expect(f.snapshot.evidenceCapabilities.dataBinding.availability).toBe("unavailable");
  });

  it("an unobserved chain identity yields UNKNOWN availability, never a silent positive", () => {
    const f = foundation(healthyObservation({ chainIdentityObserved: false }));
    for (const name of ["execution", "observedEffects", "dataBinding"] as const) {
      const state = f.snapshot.evidenceCapabilities[name];
      expect(state.support).toBe("supported");
      expect(state.availability).toBe("unknown");
      expect(capabilityIsDeterministicallyUnavailable(state)).toBe(false);
      expect(capabilityIsUsable(state, f.snapshot.evidence)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Discovery-ready candidate data
// ---------------------------------------------------------------------------

describe("discovery-ready candidate data", () => {
  it("composes an eligible match for a required supported+available capability", () => {
    const f = foundation();
    const composed = composeDiscoveryMatch(
      { requirements: [{ capability: "execution", strength: "required" }] },
      f.candidate,
    );
    expect(composed.classification).toBe("eligible");
    expect(composed.evaluations[0]?.status).toBe("satisfied");
    expect(composed.evaluations[0]?.reason).toBe("capability is usable");
  });

  it("downgrades to conditional for a DESIRED unsupported dimension", () => {
    const f = foundation();
    const composed = composeDiscoveryMatch(
      {
        requirements: [
          { capability: "execution", strength: "required" },
          { capability: "settlement", strength: "desired" },
        ],
      },
      f.candidate,
    );
    expect(composed.classification).toBe("conditional");
    expect(composed.evaluations[1]?.status).toBe("unsatisfied");
  });

  it("renders a REQUIRED unsupported dimension ineligible", () => {
    const f = foundation();
    const composed = composeDiscoveryMatch(
      { requirements: [{ capability: "finality", strength: "required" }] },
      f.candidate,
    );
    expect(composed.classification).toBe("ineligible");
    expect(composed.evaluations[0]?.status).toBe("unsatisfied");
  });

  it("never satisfies a required capability while supported but unavailable", () => {
    const f = foundation(healthyObservation({ rpcReachable: false }));
    const composed = composeDiscoveryMatch(
      { requirements: [{ capability: "execution", strength: "required" }] },
      f.candidate,
    );
    expect(composed.classification).toBe("ineligible");
    expect(composed.evaluations[0]?.status).toBe("unsatisfied");
    expect(composed.evaluations[0]?.reason).toBe("capability is deterministically unavailable");
  });
});

// ---------------------------------------------------------------------------
// Preflight evidence readiness
// ---------------------------------------------------------------------------

describe("preflight evidence readiness", () => {
  it("derives a READY preflight when every required dimension is evidenced and usable", () => {
    const f = foundation();
    const result = deriveEvmBeforePreflightResult(f, preflightRequest(policy(["execution", "observedEffects"], ["finality"])));
    expect(result.status).toBe("ready");
    expect(result.evidenceReadiness.execution.status).toBe("ready");
    expect(result.evidenceReadiness.observedEffects.status).toBe("ready");
    expect(result.evidenceReadiness.finality.status).toBe("not_applicable");
    expect(verifyPreflightResultIntegrity(result)).toBe(true);
    expect(
      verifyPreflightResult(result, { resolver: f.manifest, capabilitySnapshot: f.snapshot }),
    ).toBe(true);
  });

  it("is BLOCKED when a required dimension's acquisition path is broken", () => {
    const f = foundation(
      healthyObservation({
        receiptLookupUsable: false,
        evidence: healthyEvidence().filter((ref) => ref.id !== "ev-probe-receipt"),
      }),
    );
    const result = deriveEvmBeforePreflightResult(f, preflightRequest(policy(["observedEffects"])));
    expect(result.status).toBe("blocked");
    expect(result.evidenceReadiness.observedEffects.status).toBe("blocked");
    expect(result.blockers).toEqual([]);
  });

  it("is UNKNOWN when a required dimension's usability is undetermined", () => {
    const f = foundation(healthyObservation({ chainIdentityObserved: false }));
    const result = deriveEvmBeforePreflightResult(f, preflightRequest(policy(["execution"])));
    expect(result.status).toBe("unknown");
    expect(result.evidenceReadiness.execution.status).toBe("unknown");
  });

  it("treats a REQUIRED unsupported dimension as definite policy infeasibility (blocked)", () => {
    const f = foundation();
    const result = deriveEvmBeforePreflightResult(f, preflightRequest(policy(["settlement"])));
    expect(result.evidenceReadiness.settlement.status).toBe("not_applicable");
    expect(result.status).toBe("blocked");
  });

  it("lets DESIRED unsupported dimensions stay visible without preventing ready", () => {
    const f = foundation();
    const result = deriveEvmBeforePreflightResult(
      f,
      preflightRequest(policy(["execution"], ["settlement", "finality"])),
    );
    expect(result.status).toBe("ready");
    expect(result.evidenceReadiness.settlement.status).toBe("not_applicable");
    expect(result.evidenceReadiness.finality.status).toBe("not_applicable");
  });

  it("keeps preflight evidence closed over the referenced snapshot", () => {
    const f = foundation();
    const result = deriveEvmBeforePreflightResult(f, preflightRequest(policy(["execution"])));
    const tableIds = new Set(result.evidence.map((ref) => ref.id));
    for (const check of Object.values(result.evidenceReadiness)) {
      for (const id of check.evidence ?? []) {
        expect(tableIds.has(id)).toBe(true);
      }
    }
    expect(result.capabilitySnapshot).toEqual({
      id: f.snapshot.id,
      digest: f.snapshot.artifactDigest,
    });
    for (const ref of result.evidence) {
      expect(snapshotIds(f.snapshot).has(ref.id)).toBe(true);
    }
  });

  it("fails closed on a preflight request for a different network", () => {
    const f = foundation();
    expectEvmError(
      () =>
        deriveEvmBeforePreflightResult(
          f,
          preflightRequest(policy(["execution"]), { networkId: OTHER_NET }),
        ),
      "EVM_NETWORK_MISMATCH",
    );
  });
});

// ---------------------------------------------------------------------------
// Determinism, purity and manifest-authority enforcement
// ---------------------------------------------------------------------------

describe("determinism and hygiene", () => {
  it("derives byte-stable artifacts from identical inputs with no wall clock", () => {
    const observation = healthyObservation();
    const a = foundation(observation);
    const b = foundation(observation);
    expect(a.snapshot.artifactDigest).toBe(b.snapshot.artifactDigest);
    expect(a.snapshot.generatedAt).toBe(observation.observedAt);
    const pa = deriveEvmBeforePreflightResult(a, preflightRequest(policy(["execution"])));
    const pb = deriveEvmBeforePreflightResult(b, preflightRequest(policy(["execution"])));
    expect(pa.artifactDigest).toBe(pb.artifactDigest);
    expect(pa.generatedAt).toBe(observation.observedAt);
  });

  it("binds probe time into the artifact digests", () => {
    const earlier = foundation(healthyObservation({ observedAt: T0 }));
    const later = foundation(healthyObservation({ observedAt: T1 }));
    expect(later.snapshot.artifactDigest).not.toBe(earlier.snapshot.artifactDigest);
    expect(later.snapshot.generatedAt).toBe(T1);
  });

  it("returns deeply frozen artifacts", () => {
    const f = foundation();
    const result = deriveEvmBeforePreflightResult(f, preflightRequest(policy(["execution"])));
    expect(Object.isFrozen(f)).toBe(true);
    expect(Object.isFrozen(f.manifest)).toBe(true);
    expect(Object.isFrozen(f.snapshot)).toBe(true);
    expect(Object.isFrozen(f.candidate)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.evidenceReadiness)).toBe(true);
    expect(Object.isFrozen(result.evidenceReadiness.execution)).toBe(true);
  });

  it("enforces manifest authority against a forged snapshot claiming settlement", () => {
    const f = foundation();
    const forged: CapabilitySnapshotContent = {
      schemaVersion: "0.1",
      id: "evm-capsnap-forged",
      generatedAt: T0,
      network: f.network,
      evidenceCapabilities: {
        ...f.snapshot.evidenceCapabilities,
        settlement: { support: "supported", availability: "available" },
      },
      executionCapabilities: {},
      evidence: [...f.snapshot.evidence],
      resolver: { id: f.manifest.id, version: f.manifest.version, digest: f.manifest.digest },
    };
    expect(() =>
      buildCapabilitySnapshot(forged, { resolver: f.manifest, networkId: NET }),
    ).toThrow(/supportedCapabilities/);
  });
});
