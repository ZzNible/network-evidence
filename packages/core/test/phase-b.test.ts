import { describe, expect, it } from "vitest";

import {
  assertNativeId,
  assertNecIdentifier,
  buildCapabilitySnapshot,
  buildDiscoverNetworksResult,
  buildNetworkEvidenceResult,
  buildPreflightResult,
  capabilityIsUsable,
  composeDiscoveryMatch,
  composePreflightStatus,
  composeVerdict,
  computeEvidencePolicyDigest,
  computeEvidenceRequestDigest,
  computeResolverManifestDigest,
  decodeNecWireJson,
  encodeNecWireJson,
  CAPABILITY_NAMES,
  POLICY_DIMENSIONS,
  isNecIdentifier,
  isPolicyDimension,
  NecValidationError,
  toPreflightResultRef,
  validateCapabilityRequirement,
  validateDiscoveryRequirements,
  validateEvidenceDimension,
  validateEvidencePolicy,
  validateEvidenceRequest,
  validateResolverManifest,
  validateWarning,
  verifyCapabilitySnapshotIntegrity,
  verifyNetworkEvidenceResultIntegrity,
} from "../src/index.js";
import type {
  CapabilitySnapshot,
  DiscoveryRequirements,
  EvidenceDimension,
  EvidenceRequest,
  NetworkEvidenceResult,
  PreflightResult,
} from "../src/index.js";
import {
  blocker,
  discoveryMatch,
  discoveryRequirements,
  evidenceRef,
  evidenceRequestContent,
  fingerprint,
  fullManifest,
  fullPolicy,
  NETWORK,
  preflightCapabilitySnapshot,
  preflightContext,
  readiness,
  subject,
  preflightRequestContent,
  validCapabilitySnapshotContent,
  validPreflightResultContent,
  validResultContent,
  resultContext,
  T0,
} from "./fixtures.js";

/**
 * PHASE B — PUBLIC CONTRACT SEMANTICS FREEZE (R3 revision).
 *
 * Closed vocabularies (capabilities + policy dimensions), the ONE normative
 * discovery composer and its truth table, the policy-aware THREE-STATE
 * preflight composer and its truth table, PreflightResult identity via the
 * embedded request's requestId, the EvidenceRequest -> Preflight -> Result
 * continuity chain INCLUDING ActionDescriptor continuity, THE single
 * verdict/applicability state machine shared by composer and artifact
 * validator, and the NEC-owned identifier grammar.
 */

// ---------------------------------------------------------------------------
// Shared coherent world helpers
// ---------------------------------------------------------------------------

const USABLE = {
  support: "supported" as const,
  availability: "available" as const,
  evidence: ["ev_receipt_1"],
};

function capSnap(overrides: Record<string, unknown> = {}): CapabilitySnapshot {
  return buildCapabilitySnapshot(
    validCapabilitySnapshotContent({
      network: fingerprint(),
      resolver: { id: fullManifest().id, version: fullManifest().version, digest: fullManifest().digest },
      ...overrides,
    }),
    { resolver: fullManifest(), networkId: overrides.network === undefined ? NETWORK : (overrides.network as { networkId: string }).networkId },
  );
}

function discoveryWorldCaps(): CapabilitySnapshot {
  return capSnap({
    id: "capsnap_world",
    evidenceCapabilities: {
      execution: { ...USABLE },
      observedEffects: { ...USABLE },
      dataBinding: { support: "unsupported", availability: "unavailable" },
      settlement: { support: "unsupported", availability: "unavailable" },
      finality: { support: "unknown", availability: "unknown" },
    },
    executionCapabilities: {},
  });
}

function candidate(snapshot = discoveryWorldCaps(), networkId: string = NETWORK) {
  const snap =
    networkId === snapshot.network.networkId
      ? snapshot
      : capSnap({
          network: fingerprint({ networkId }),
          evidenceCapabilities: snapshot.evidenceCapabilities,
          executionCapabilities: snapshot.executionCapabilities,
        });
  return {
    network: fingerprint({ networkId }),
    snapshot: snap,
    resolver: fullManifest(),
  };
}

// ---------------------------------------------------------------------------
// 1. Closed capability vocabulary + closed policy dimensions + NO constraints
// ---------------------------------------------------------------------------

describe("closed v0.1 vocabularies fail closed", () => {
  it("arbitrary capability strings are rejected in requirements", () => {
    expect(() =>
      validateCapabilityRequirement({ capability: "teleport", strength: "required" }),
    ).toThrow(NecValidationError);
    expect(() =>
      validateCapabilityRequirement({ capability: "Execution", strength: "required" }),
    ).toThrow(NecValidationError);
    expect(() => validateCapabilityRequirement({ capability: "", strength: "required" })).toThrow();
    // Every vocabulary member is accepted, in both strengths.
    for (const name of CAPABILITY_NAMES) {
      expect(() => validateCapabilityRequirement({ capability: name, strength: "required" })).not.toThrow();
      expect(() => validateCapabilityRequirement({ capability: name, strength: "desired" })).not.toThrow();
    }
  });

  it("R3: CapabilityRequirement.constraints is REJECTED as an unknown field", () => {
    expect(() =>
      validateCapabilityRequirement({
        capability: "execution",
        strength: "required",
        constraints: { minConfirmations: 12 },
      }),
    ).toThrow(/unknown field\(s\) "constraints"/);
    // No generic custom-predicate replacement exists either.
    expect(() =>
      validateCapabilityRequirement({
        capability: "execution",
        strength: "required",
        predicate: "custom",
      } as never),
    ).toThrow(/unknown field/);
    // Discovery requests inherit the rejection through nested validation.
    expect(() =>
      validateDiscoveryRequirements({
        requirements: [
          { capability: "execution", strength: "required", constraints: {} },
        ],
      }),
    ).toThrow(/unknown field/);
  });

  it("arbitrary capability strings are rejected in manifests", () => {
    const bad = {
      id: "resolver-x",
      version: "1",
      digest: `sha256:${"11".repeat(32)}`, // shape-valid; vocabulary check fires before self-digest
      networkFamilies: ["eip155"],
      implementation: {},
      supportedCapabilities: ["execution", "quantumLift"],
      sourceRequirements: [],
    };
    expect(() => validateResolverManifest(bad as never)).toThrow(/supportedCapabilities/);
    // Duplicate capability names are also rejected (set-like).
    expect(() =>
      validateResolverManifest({
        ...bad,
        supportedCapabilities: ["execution", "execution"],
      } as never),
    ).toThrow(/duplicate entry/);
  });

  it("arbitrary policy dimensions are rejected; exactly the five resolvable dimensions exist", () => {
    const base = { id: "p", version: "1" };
    for (const dims of [["mood"], ["Execution"], ["execution", "mood"]]) {
      expect(() =>
        validateEvidencePolicy({
          ...base,
          requiredDimensions: dims,
          digest: `sha256:${"aa".repeat(32)}`,
        } as never),
      ).toThrow(NecValidationError);
    }
    expect(() =>
      validateEvidencePolicy({
        ...base,
        requiredDimensions: ["execution"],
        desiredDimensions: ["vibes"],
        digest: `sha256:${"aa".repeat(32)}`,
      } as never),
    ).toThrow(/desiredDimensions/);
    expect(POLICY_DIMENSIONS).toEqual([
      "execution",
      "observedEffects",
      "dataBinding",
      "settlement",
      "finality",
    ]);
    for (const dim of POLICY_DIMENSIONS) {
      expect(isPolicyDimension(dim)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Capability claim authority + probe targeting + manifest authority
// ---------------------------------------------------------------------------

describe("capability claim authority and probe target binding", () => {
  it("supported+available without resolvable evidence is NOT usable; with it can be usable", () => {
    const table = [evidenceRef()];
    expect(capabilityIsUsable({ support: "supported", availability: "available" }, table)).toBe(false);
    expect(capabilityIsUsable({ support: "supported", availability: "available", evidence: [] }, table)).toBe(false);
    expect(capabilityIsUsable({ ...USABLE }, table)).toBe(true);
    expect(
      capabilityIsUsable(
        { support: "conditional", availability: "available", evidence: ["ev_receipt_1"] },
        table,
      ),
    ).toBe(false);
    expect(
      capabilityIsUsable(
        { support: "supported", availability: "degraded", evidence: ["ev_receipt_1"] },
        table,
      ),
    ).toBe(false);
  });

  it("probe capability target/network mismatch rejected by the builder context", () => {
    expect(() =>
      buildCapabilitySnapshot(validCapabilitySnapshotContent(), {
        resolver: fullManifest(),
        networkId: "eip155:1",
      }),
    ).toThrow(/does not match the explicitly requested target/);
  });

  it("snapshot resolver reference must exactly match id+version+digest of the provided manifest", () => {
    const content = validCapabilitySnapshotContent();
    content.resolver = { id: fullManifest().id, version: "0.0.1", digest: fullManifest().digest };
    expect(() =>
      buildCapabilitySnapshot(content, { resolver: fullManifest(), networkId: NETWORK }),
    ).toThrow(/snapshot resolver reference does not exactly match/);
    const ok = buildCapabilitySnapshot(validCapabilitySnapshotContent(), {
      resolver: fullManifest(),
      networkId: NETWORK,
    });
    expect(verifyCapabilitySnapshotIntegrity(ok)).toBe(true);
  });

  it("capability evidence citations must resolve against the snapshot evidence table", () => {
    const content = validCapabilitySnapshotContent();
    content.evidenceCapabilities = {
      ...content.evidenceCapabilities,
      finality: { support: "supported", availability: "available", evidence: ["ev_ghost"] },
    };
    expect(() =>
      buildCapabilitySnapshot(content, { resolver: fullManifest(), networkId: NETWORK }),
    ).toThrow(/dangling provenance/);
  });
});

// ---------------------------------------------------------------------------
// 3. Discovery — ONE normative composer, truth table
// ---------------------------------------------------------------------------

describe("discovery composer truth table", () => {
  const req = (requirements: Partial<DiscoveryRequirements> = {}) =>
    discoveryRequirements({
      requirements: [{ capability: "execution", strength: "required" }],
      ...requirements,
    });

  it("all-required-satisfied is eligible (with deterministic composer reason)", () => {
    const out = composeDiscoveryMatch(req(), candidate());
    expect(out.classification).toBe("eligible");
    expect(out.evaluations[0]!.status).toBe("satisfied");
    expect(out.evaluations[0]!.evidence).toEqual(["ev_receipt_1"]);
    expect(out.evaluations[0]!.reason).toBe("capability is usable");
  });

  it("denylist wins over everything (even allowlist membership)", () => {
    const out = composeDiscoveryMatch(req({ networkAllowlist: [NETWORK], networkDenylist: [NETWORK] }), candidate());
    expect(out.classification).toBe("ineligible");
  });

  it("a non-empty allowlist excludes unlisted networks", () => {
    const out = composeDiscoveryMatch(req({ networkAllowlist: ["eip155:1"] }), candidate());
    expect(out.classification).toBe("ineligible");
  });

  it("REQUIRED + unsatisfied can never be eligible", () => {
    const snap = capSnap({
      id: "capsnap_neg",
      evidenceCapabilities: {
        execution: { support: "unsupported", availability: "unavailable" },
        observedEffects: { ...USABLE },
        dataBinding: { support: "unsupported", availability: "unavailable" },
        settlement: { support: "unsupported", availability: "unavailable" },
        finality: { support: "unknown", availability: "unknown" },
      },
      executionCapabilities: {},
    });
    const out = composeDiscoveryMatch(req(), candidate(snap));
    expect(out.classification).toBe("ineligible");
    expect(out.evaluations[0]!.status).toBe("unsatisfied");
  });

  it("REQUIRED + unknown can never be silently eligible", () => {
    const snap = capSnap({
      id: "capsnap_unproven",
      evidenceCapabilities: {
        execution: { support: "supported", availability: "available", evidence: [] }, // positive claim without proof
        observedEffects: { ...USABLE },
        dataBinding: { support: "unsupported", availability: "unavailable" },
        settlement: { support: "unsupported", availability: "unavailable" },
        finality: { support: "unknown", availability: "unknown" },
      },
      executionCapabilities: {},
    });
    const out = composeDiscoveryMatch(req(), candidate(snap));
    expect(out.classification).toBe("ineligible");
    expect(out.evaluations[0]!.status).toBe("unknown");
  });

  it("desired unsatisfied/unknown only downgrades to conditional; desired satisfied keeps eligible", () => {
    const conditionalReq = req({
      requirements: [
        { capability: "execution", strength: "required" },
        { capability: "finality", strength: "desired" },
      ],
    });
    expect(composeDiscoveryMatch(conditionalReq, candidate()).classification).toBe("conditional");

    const eligibleReq = req({
      requirements: [
        { capability: "execution", strength: "required" },
        { capability: "observedEffects", strength: "desired" },
      ],
    });
    expect(composeDiscoveryMatch(eligibleReq, candidate()).classification).toBe("eligible");
  });

  it("an absent optional execution-family slot evaluates as unknown and blocks a REQUIRED requirement", () => {
    const out = composeDiscoveryMatch(
      discoveryRequirements({ requirements: [{ capability: "simulation", strength: "required" }] }),
      candidate(),
    );
    expect(out.classification).toBe("ineligible");
    expect(out.evaluations[0]!.status).toBe("unknown");
    expect(out.evaluations[0]!.reason).toBe("capability absent from the capability snapshot");
  });

  it("discovery cannot reference an unrelated capability snapshot (digest/id checked)", () => {
    const snap = discoveryWorldCaps();
    const content = {
      schemaVersion: "0.1" as const,
      requestId: "disc_req_9",
      generatedAt: T0,
      request: discoveryRequirements(),
      matches: [
        discoveryMatch({
          capabilitySnapshot: { id: snap.id, digest: `sha256:${"11".repeat(32)}` }, // wrong digest
        }),
      ],
    };
    expect(() =>
      buildDiscoverNetworksResult(content, {
        capabilitySnapshots: [snap],
        resolverManifests: [fullManifest()],
      }),
    ).toThrow(/does not match the supplied CapabilitySnapshot artifactDigest/);

    const ghost = {
      schemaVersion: "0.1" as const,
      requestId: "disc_req_9",
      generatedAt: T0,
      request: discoveryRequirements(),
      matches: [
        discoveryMatch({ capabilitySnapshot: { id: "capsnap_other", digest: snap.artifactDigest } }),
      ],
    };
    expect(() =>
      buildDiscoverNetworksResult(ghost, {
        capabilitySnapshots: [snap],
        resolverManifests: [fullManifest()],
      }),
    ).toThrow(/complete context required/);
  });

  it("composer agreement: stored classification/evaluations that disagree are rejected", () => {
    const snap = discoveryWorldCaps();
    const content = {
      schemaVersion: "0.1" as const,
      requestId: "disc_req_11",
      generatedAt: T0,
      request: discoveryRequirements({
        requirements: [{ capability: "settlement", strength: "required" }],
      }),
      matches: [
        discoveryMatch({
          evaluations: [
            {
              requirement: { capability: "settlement", strength: "required" },
              status: "satisfied", // LIE: settlement is unsupported here
              reason: "capability is usable",
              evidence: ["ev_receipt_1"],
            },
          ],
          capabilitySnapshot: { id: snap.id, digest: snap.artifactDigest },
        }),
      ],
    };
    expect(() =>
      buildDiscoverNetworksResult(content, {
        capabilitySnapshots: [snap],
        resolverManifests: [fullManifest()],
      }),
    ).toThrow(/disagrees with the normative composer/);

    const honest = {
      ...content,
      matches: [
        discoveryMatch({
          classification: "ineligible" as const,
          evaluations: [
            {
              requirement: { capability: "settlement", strength: "required" },
              status: "unsatisfied",
              reason: "capability is deterministically unavailable",
            },
          ],
          capabilitySnapshot: { id: snap.id, digest: snap.artifactDigest },
        }),
      ],
    };
    const built = buildDiscoverNetworksResult(honest, {
      capabilitySnapshots: [snap],
      resolverManifests: [fullManifest()],
    });
    expect(built.matches[0]!.classification).toBe("ineligible");
  });

  it("candidate network != snapshot FINGERPRINT is rejected (full equality, R3)", () => {
    const snap = discoveryWorldCaps(); // targets eip155:8453
    // Different networkId entirely...
    expect(() =>
      composeDiscoveryMatch(discoveryRequirements(), {
        network: fingerprint({ networkId: "eip155:1" }),
        snapshot: snap,
        resolver: fullManifest(),
      }),
    ).toThrow(/full fingerprint equality|required/i);
    // ...and same networkId but a DIFFERENT fingerprint body is equally rejected.
    expect(() =>
      composeDiscoveryMatch(discoveryRequirements(), {
        network: fingerprint({ chainId: 9999 }),
        snapshot: snap,
        resolver: fullManifest(),
      }),
    ).toThrow(/full fingerprint equality|required/i);
  });
});

// ---------------------------------------------------------------------------
// 4. Policy-aware preflight — THREE-STATE truth table
// ---------------------------------------------------------------------------

describe("policy-aware preflight status composer (three states, R3)", () => {
  function checks(executionStatus: ReturnType<typeof readiness>, others: ReturnType<typeof readiness>) {
    return {
      evidenceReadiness: {
        execution: executionStatus,
        observedEffects: others,
        dataBinding: others,
        settlement: others,
        finality: others,
      },
      blockers: [] as PreflightResult["blockers"],
    };
  }

  it("required + ready permits overall ready", () => {
    expect(
      composePreflightStatus({
        ...checks(readiness("ready"), readiness("not_applicable")),
        requiredDimensions: ["execution"],
      }),
    ).toBe("ready");
  });

  it("required + blocked prevents readiness (blocked)", () => {
    expect(
      composePreflightStatus({
        ...checks(readiness("blocked"), readiness("not_applicable")),
        requiredDimensions: ["execution"],
      }),
    ).toBe("blocked");
  });

  it("R3: required + unknown => UNKNOWN (never partial, never ready)", () => {
    expect(
      composePreflightStatus({
        ...checks(readiness("unknown"), readiness("ready")),
        requiredDimensions: ["execution"],
      }),
    ).toBe("unknown");
  });

  it("required + not_applicable prevents readiness (blocked) — required dimensions cannot disappear", () => {
    expect(
      composePreflightStatus({
        ...checks(readiness("not_applicable"), readiness("ready")),
        requiredDimensions: ["execution"],
      }),
    ).toBe("blocked");
  });

  it("R3 REGRESSION PROOF: required all ready + desired unknown => READY", () => {
    // Policy requires ONLY execution; finality is desired-but-unknown.
    const status = composePreflightStatus({
      evidenceReadiness: {
        execution: readiness("ready"),
        observedEffects: readiness("not_applicable"),
        dataBinding: readiness("not_applicable"),
        settlement: readiness("not_applicable"),
        finality: readiness("unknown"), // desired dimension, unknown
      },
      blockers: [],
      requiredDimensions: ["execution"],
    });
    expect(status).toBe("ready");

    // Artifact-level proof: the builder recomputes READY, and the desired
    // dimension's unknown stays visible in evidenceReadiness.
    const otherPolicyContent = { ...fullPolicy(), requiredDimensions: ["execution" as const], desiredDimensions: ["finality" as const] };
    const otherPolicy = { ...otherPolicyContent, digest: computeEvidencePolicyDigest(otherPolicyContent) };
    const built = buildPreflightResult(
      validPreflightResultContent({
        request: { ...preflightRequestContent(), evidencePolicy: otherPolicy },
        evidencePolicy: {
          id: otherPolicy.id,
          version: otherPolicy.version,
          digest: otherPolicy.digest,
        },
        evidenceReadiness: {
          execution: readiness("ready", { evidence: ["ev_receipt_1"] }),
          observedEffects: readiness("not_applicable"),
          dataBinding: readiness("not_applicable"),
          settlement: readiness("not_applicable"),
          finality: readiness("unknown"),
        },
      }),
      preflightContext(),
    );
    expect(built.status).toBe("ready");
    expect(built.evidenceReadiness.finality.status).toBe("unknown");
  });

  it("any blocker means the overall status cannot be ready", () => {
    expect(
      composePreflightStatus({
        ...checks(readiness("ready"), readiness("not_applicable")),
        blockers: [blocker()],
        requiredDimensions: ["execution"],
      }),
    ).toBe("blocked");
  });

  it("artifact-level: preflight result/request network mismatch rejected", () => {
    const content = validPreflightResultContent();
    content.network = fingerprint({ networkId: "eip155:1" });
    expect(() => buildPreflightResult(content, preflightContext())).toThrow(
      /does not equal the preflight request networkId/,
    );
  });

  it("artifact-level: a REQUIRED dimension left not_applicable cannot yield a ready artifact", () => {
    const content = validPreflightResultContent({
      evidenceReadiness: {
        execution: readiness("ready", { evidence: ["ev_receipt_1"] }),
        observedEffects: readiness("not_applicable"), // required by the bound policy
        dataBinding: readiness("not_applicable"),
        settlement: readiness("not_applicable"),
        finality: readiness("not_applicable"),
      },
    });
    const built = buildPreflightResult(content, preflightContext());
    expect(built.status).toBe("blocked");
  });

  it("R3: positive ready that CANNOT be derived from the supplied capability context is rejected", () => {
    // Snapshot where execution is NOT usable (no cited evidence) while the
    // check claims ready.
    const weakSnap = buildCapabilitySnapshot(
      {
        ...validCapabilitySnapshotContent(),
        id: "capsnap_weak",
        evidenceCapabilities: {
          execution: { support: "supported", availability: "available", evidence: [] },
          observedEffects: { ...USABLE },
          dataBinding: { support: "unsupported", availability: "unavailable" },
          settlement: { support: "unsupported", availability: "unavailable" },
          finality: { support: "unknown", availability: "unknown" },
        },
        executionCapabilities: {},
      },
      { resolver: fullManifest(), networkId: NETWORK },
    );
    expect(() =>
      buildPreflightResult(
        validPreflightResultContent({
          capabilitySnapshot: { id: weakSnap.id, digest: weakSnap.artifactDigest },
        }),
        {
          resolver: fullManifest(),
          capabilitySnapshot: weakSnap,
        },
      ),
    ).toThrow(/"ready" cannot be derived/);

    // A ready claim with NO capability snapshot at all => rejected outright.
    // FREEZE-FINAL: the builder context is REQUIRED (TS-level); a JS call
    // omitting it fails closed on the required-context guard...
    const noRef = validPreflightResultContent();
    delete (noRef as Record<string, unknown>).capabilitySnapshot;
    expect(() =>
      buildPreflightResult(noRef, undefined as never),
    ).toThrow(/requires the COMPLETE verification context/);
    // ...and a context WITHOUT the capability snapshot a ready claim needs
    // fails closed on the derivability gate.
    expect(() =>
      buildPreflightResult(validPreflightResultContent(), { resolver: fullManifest() }),
    ).toThrow(
      /readiness must be derivable|complete CapabilitySnapshot/,
    );
  });

  it("R3: an UNSUPPORTED manifest capability cannot become ready", () => {
    // The restricted fixture manifest lists only execution+observedEffects+
    // dataBinding. A snapshot trying to claim settlement USABLE cannot even
    // be BUILT against it (manifest authority lives in the builder itself).
    const settlementUsable = {
      execution: { ...USABLE },
      observedEffects: { ...USABLE },
      dataBinding: { support: "unsupported" as const, availability: "unavailable" as const },
      settlement: { ...USABLE }, // NOT listed under supportedCapabilities
      finality: { support: "unknown" as const, availability: "unknown" as const },
    };
    expect(() =>
      buildCapabilitySnapshot(
        {
          ...validCapabilitySnapshotContent(),
          id: "capsnap_rogue",
          evidenceCapabilities: settlementUsable,
          executionCapabilities: {},
        },
        { resolver: fullManifest(), networkId: NETWORK },
      ),
    ).toThrow(/does not list it under supportedCapabilities/);

    // Even when a snapshot was built against an EXTENDED manifest, verifying
    // a preflight against the RESTRICTED manifest fails closed before any
    // readiness claim for that capability could be derived.
    const extended = {
      ...fullManifest(),
      supportedCapabilities: [...fullManifest().supportedCapabilities, "settlement" as const],
    };
    const extendedWithDigest = { ...extended, digest: computeResolverDigest(extended) };
    const rogueSnap = buildCapabilitySnapshot(
      {
        ...validCapabilitySnapshotContent(),
        id: "capsnap_extended",
        resolver: {
          id: extendedWithDigest.id,
          version: extendedWithDigest.version,
          digest: extendedWithDigest.digest,
        },
        evidenceCapabilities: settlementUsable,
        executionCapabilities: {},
      },
      { resolver: extendedWithDigest, networkId: NETWORK },
    );
    const content = validPreflightResultContent({
      capabilitySnapshot: { id: rogueSnap.id, digest: rogueSnap.artifactDigest },
      evidenceReadiness: {
        execution: readiness("ready", { evidence: ["ev_receipt_1"] }),
        observedEffects: readiness("ready"),
        dataBinding: readiness("not_applicable"),
        settlement: readiness("ready"), // claims readiness for an unlisted capability
        finality: readiness("not_applicable"),
      },
    });
    expect(() =>
      buildPreflightResult(content, { resolver: fullManifest(), capabilitySnapshot: rogueSnap }),
    ).toThrow(/does not match the provided resolver manifest|does not list it under supportedCapabilities|"ready" cannot be derived/);

    function computeResolverDigest(m: typeof fullManifest extends () => infer R ? R : never): string {
      return computeResolverManifestDigest(m);
    }
  });

  it("R3: overall status cannot be caller-authored contrary to the composer", () => {
    const content = validPreflightResultContent() as Record<string, unknown>;
    content.status = "blocked"; // caller tries to claim blocked for a ready world
    expect(() => buildPreflightResult(content as never, preflightContext())).toThrow(
      /self-digest field "status"/,
    );
  });

  it("dangling readiness evidence rejected", () => {
    const content = validPreflightResultContent({
      evidenceReadiness: {
        execution: readiness("ready", { evidence: ["ev_receipt_1"] }),
        observedEffects: readiness("ready"),
        dataBinding: readiness("not_applicable"),
        settlement: readiness("not_applicable"),
        finality: readiness("ready", { evidence: ["ev_ghost"] }),
      },
    });
    expect(() => buildPreflightResult(content, preflightContext())).toThrow(/dangling provenance/);
  });

  it("mismatched capability snapshot rejected in the preflight context", () => {
    const realSnap = preflightCapabilitySnapshot();
    const content = validPreflightResultContent({
      capabilitySnapshot: { id: realSnap.id, digest: realSnap.artifactDigest },
    });

    // Wrong snapshot supplied (digest differs) -> builder rejects.
    expect(() =>
      buildPreflightResult(content, { resolver: fullManifest(), capabilitySnapshot: discoveryWorldCaps() }),
    ).toThrow(/capabilitySnapshot reference does not match/);

    // Correct snapshot verifies.
    expect(buildPreflightResult(content, preflightContext()).artifactDigest).toBeTruthy();

    // Snapshot targeting another network fails (fingerprint mismatch).
    const foreign = capSnap({
      id: "capsnap_foreign",
      network: fingerprint({ networkId: "eip155:1" }),
      evidenceCapabilities: {
        execution: { ...USABLE },
        observedEffects: { ...USABLE },
        dataBinding: { support: "unsupported", availability: "unavailable" },
        settlement: { support: "unsupported", availability: "unavailable" },
        finality: { support: "unknown", availability: "unknown" },
      },
      executionCapabilities: {},
    });
    expect(() =>
      buildPreflightResult(
        {
          ...content,
          capabilitySnapshot: { id: foreign.id, digest: foreign.artifactDigest },
        },
        { resolver: fullManifest(), capabilitySnapshot: foreign },
      ),
    ).toThrow(/full fingerprint equality|canonically equal/);
  });
});

// ---------------------------------------------------------------------------
// 5. Preflight identity + EvidenceRequest continuity chain (incl. ACTION)
// ---------------------------------------------------------------------------

describe("PreflightResult identity and request->preflight->result continuity", () => {
  function preflightBuilt(): PreflightResult {
    return buildPreflightResult(validPreflightResultContent(), preflightContext());
  }

  function requestWithPreflight(pf: PreflightResult, overrides: Partial<EvidenceRequest> = {}): EvidenceRequest {
    return evidenceRequestContent({ preflight: toPreflightResultRef(pf), ...overrides });
  }

  it("R3: PreflightRequest has requestId; ref binds request.requestId + artifactDigest", () => {
    const pf = preflightBuilt();
    expect(pf.request.requestId).toBe("pf_req_1");
    expect((pf as unknown as Record<string, unknown>).requestId).toBeUndefined();
    expect(toPreflightResultRef(pf)).toEqual({ requestId: "pf_req_1", digest: pf.artifactDigest });
  });

  it("R3: arbitrary unrelated requestId cannot be inserted into the ref", () => {
    const pf = preflightBuilt();
    const forged = { requestId: "pf_other", digest: pf.artifactDigest };
    expect(() =>
      buildNetworkEvidenceResult(validResultContent(), {
        ...resultContext(),
        request: evidenceRequestContent({ preflight: forged }),
        preflight: pf,
        preflightContext: preflightContext(),
      }),
    ).toThrow(/request.preflight.requestId does not match/);
  });

  it("shared requestIds differ by artifactDigest (observation/context/time differs)", () => {
    const a = preflightBuilt();
    const b = buildPreflightResult(
      validPreflightResultContent({ generatedAt: "2027-02-03T04:05:06.000Z" }),
      preflightContext(),
    );
    expect(a.request.requestId).toBe(b.request.requestId);
    expect(a.artifactDigest).not.toBe(b.artifactDigest);
  });

  it("EvidenceRequest digest changes when the subject/action/policy/preflight-ref changes", () => {
    const pf = preflightBuilt();
    const a = evidenceRequestContent();
    const b = evidenceRequestContent({
      subject: { type: "transaction", networkId: NETWORK, txId: `0x${"22".repeat(32)}` },
    });
    expect(computeEvidenceRequestDigest(a)).not.toBe(computeEvidenceRequestDigest(b));

    const c = evidenceRequestContent({ action: { kind: "erc20.approve", value: "1" } });
    expect(computeEvidenceRequestDigest(a)).not.toBe(computeEvidenceRequestDigest(c));

    const later = buildPreflightResult(
      validPreflightResultContent({ generatedAt: "2027-07-07T07:07:07.000Z" }),
      preflightContext(),
    );
    expect(computeEvidenceRequestDigest(requestWithPreflight(pf))).not.toBe(
      computeEvidenceRequestDigest(requestWithPreflight(later)),
    );
  });

  it("result cannot substitute another EvidenceRequest", () => {
    const ctx = resultContext();

    // Different requestId -> the bound-request/requestId pairing fails closed.
    expect(() =>
      buildNetworkEvidenceResult(validResultContent(), {
        ...ctx,
        request: evidenceRequestContent({ requestId: "req_other" }),
      }),
    ).toThrow(/must equal the result requestId|continuity broken/);

    // Same requestId but different subject -> digest mismatch.
    expect(() =>
      buildNetworkEvidenceResult(validResultContent(), {
        ...ctx,
        request: evidenceRequestContent({
          subject: { type: "transaction", networkId: NETWORK, txId: `0x${"33".repeat(32)}` },
        }),
      }),
    ).toThrow(/continuity broken|subject must equal/);

    // Caller-supplied `request` field inside the content is rejected outright.
    const smuggled = validResultContent() as Record<string, unknown>;
    smuggled.request = { requestId: "req_1", digest: `sha256:${"44".repeat(32)}` };
    expect(() => buildNetworkEvidenceResult(smuggled as never, ctx)).toThrow(
      /self-digest field "request"/,
    );
  });

  it("result cannot attach a stale or unrelated preflight", () => {
    const pf = preflightBuilt();
    const staleSameRequest = buildPreflightResult(
      validPreflightResultContent({ generatedAt: "2028-01-01T00:00:00.000Z" }),
      preflightContext(),
    ); // same requestId, NEW artifactDigest
    const ctx = resultContext();

    // Request cites the NEW digest while the OLD artifact is supplied.
    expect(() =>
      buildNetworkEvidenceResult(validResultContent(), {
        ...ctx,
        request: requestWithPreflight(staleSameRequest),
        preflight: pf,
        preflightContext: preflightContext(),
      }),
    ).toThrow(/stale or substituted preflight/);

    // Referenced preflight missing from context entirely -> fail closed.
    expect(() =>
      buildNetworkEvidenceResult(validResultContent(), {
        ...ctx,
        request: requestWithPreflight(pf),
      }),
    ).toThrow(/complete PreflightResult artifact is required/);

    // A tampered preflight (broken self-digest) is re-verified and rejected.
    expect(() =>
      buildNetworkEvidenceResult(validResultContent(), {
        ...ctx,
        request: requestWithPreflight(pf),
        preflight: { ...pf, generatedAt: "2031-01-01T00:00:00.000Z" },
        preflightContext: preflightContext(),
      }),
    ).toThrow(NecValidationError);
  });

  it("R3 ACTION CONTINUITY: preflight action A + EvidenceRequest action B rejected", () => {
    const pfA = preflightBuilt(); // preflights defaultAction()
    const actionB = { kind: "erc20.approve", target: `0x${"bb".repeat(20)}`, value: "7" };
    const requestB = evidenceRequestContent({
      action: actionB,
      preflight: toPreflightResultRef(pfA),
    });
    // The RESULT carries the expected action too (result.action == request.action);
    // only the preflighted action diverges -> the chain must reject.
    const contentB = validResultContent();
    contentB.action = actionB;
    expect(() =>
      buildNetworkEvidenceResult(contentB, {
        ...resultContext(),
        request: requestB,
        preflight: pfA,
        preflightContext: preflightContext(),
      }),
    ).toThrow(/action continuity broken|preflighted action differs/);

    // R3 REGRESSION PROOF: a VALID preflight B paired with request/result
    // B-refs but an unrelated subject is structurally permitted as an
    // EVIDENCE QUESTION only - it must NOT automatically receive a
    // supported verdict for that subject.
    const pfB = buildPreflightResult(
      validPreflightResultContent({
        request: { ...preflightRequestContent(), action: actionB },
      }),
      preflightContext(),
    );
    const subjectB = { type: "transaction" as const, networkId: NETWORK, txId: `0x${"77".repeat(32)}` };
    const requestB2 = evidenceRequestContent({
      action: actionB,
      subject: subjectB,
      preflight: toPreflightResultRef(pfB),
    });
    const contentB2 = validResultContent();
    contentB2.subject = subjectB;
    contentB2.action = actionB;
    // Empty evidence world for subject B: no dimension may claim support.
    contentB2.networkEvidence = {
      execution: { applicability: "unknown", basis: [], evidence: [] },
      observedEffects: [],
      dataBinding: { applicability: "unknown", basis: [], evidence: [] },
      settlement: { applicability: "unknown", basis: [], evidence: [] },
      finality: { applicability: "unknown", basis: [], evidence: [] },
    };
    const builtB = buildNetworkEvidenceResult(contentB2, {
      ...resultContext(),
      request: requestB2,
      preflight: pfB,
      preflightContext: preflightContext(),
    });
    for (const dim of ["execution", "dataBinding", "settlement", "finality"] as const) {
      expect(builtB.networkEvidence[dim].verdict).toBeUndefined();
      expect(builtB.networkEvidence[dim].applicability).toBe("unknown");
    }
    // The continuity chain proves EXPECTED-ACTION continuity only. Whether
    // observed effects for subject B satisfy action B is an EVIDENCE
    // question for a resolver/protocol adapter - core v0.1 does not pretend
    // action->subject causality is established (documented in README/ADR).
  });

  it("preflighted policy must equal the request policy across the chain", () => {
    const otherPolicyContent: import("../src/index.js").EvidencePolicy = {
      ...fullPolicy(),
      desiredDimensions: ["dataBinding"],
    };
    const otherPolicy = { ...otherPolicyContent, digest: computeEvidencePolicyDigest(otherPolicyContent) };
    const pfOtherContent = validPreflightResultContent({
      request: {
        ...preflightRequestContent(),
        evidencePolicy: otherPolicy,
      },
    });
    pfOtherContent.evidencePolicy = {
      id: otherPolicy.id,
      version: otherPolicy.version,
      digest: otherPolicy.digest,
    };
    const pfOther = buildPreflightResult(pfOtherContent, preflightContext());
    const request = evidenceRequestContent({ preflight: toPreflightResultRef(pfOther) });
    // Everything else is consistent; ONLY the preflighted policy diverges.
    expect(() =>
      buildNetworkEvidenceResult(validResultContent(), {
        ...resultContext(),
        request,
        preflight: pfOther,
        preflightContext: preflightContext(),
      }),
    ).toThrow(/preflighted evidence policy differs/);
  });

  it("complete continuity survives encode -> decode -> replay verification", () => {
    const pf = preflightBuilt();
    const request = requestWithPreflight(pf);
    const ctx = { ...resultContext(), request, preflight: pf, preflightContext: preflightContext() };
    const built = buildNetworkEvidenceResult(validResultContent(), ctx);
    const wire = encodeNecWireJson("network-evidence-result", built);
    const decoded = decodeNecWireJson("network-evidence-result", wire) as NetworkEvidenceResult;
    expect(decoded).toEqual(built);
    // R3: the expected action is a semantic field and round-trips.
    expect(decoded.action).toEqual(request.action);

    // Any link substitution breaks replay verification.
    expect(verifyNetworkEvidenceResultIntegrity({ ...decoded, requestId: "req_other" })).toBe(false);

    // The request itself round-trips on the wire with its requestId binding.
    const requestWire = encodeNecWireJson("evidence-request", request);
    expect(decodeNecWireJson("evidence-request", requestWire)).toEqual(request);
    expect(requestWire).toContain('"requestId":"req_1"');
    expect(validateEvidenceRequest(decodeNecWireJson("evidence-request", requestWire))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 6. Verdict/applicability — ONE state machine, composer == validator
// ---------------------------------------------------------------------------

describe("THE verdict/applicability state machine (composer vs artifact validator)", () => {
  const APPLICABILITIES = ["applicable", "not_applicable", "unknown"] as const;
  const VERDICTS = [undefined, "supported", "contradicted", "insufficient", "ambiguous"] as const;
  const refsTT = [evidenceRef({ id: "ev_receipt_1" })];

  function dimensionFromOutcome(o: ReturnType<typeof composeVerdict>): EvidenceDimension {
    return {
      applicability: o.applicability,
      ...(o.verdict !== undefined ? { verdict: o.verdict } : {}),
      basis: [...o.basis],
      evidence: [...o.evidence],
    };
  }

  it("applicability pairing: applicable requires verdict; not_applicable/unknown forbid it", () => {
    expect(() =>
      validateEvidenceDimension({
        applicability: "applicable",
        basis: ["source_observation"],
        evidence: ["ev_receipt_1"],
      }),
    ).toThrow(/required when applicability is "applicable"/);
    expect(() =>
      validateEvidenceDimension({ applicability: "not_applicable", verdict: "insufficient", basis: [], evidence: [] }),
    ).toThrow(/MUST be absent when applicability is "not_applicable"/);
    expect(() =>
      validateEvidenceDimension({ applicability: "unknown", verdict: "insufficient", basis: [], evidence: [] }),
    ).toThrow(/MUST be absent when applicability is "unknown"/);

    // Composer side: identical pairing (and illegal input shapes fail closed).
    const EXEC = { kind: "dimension", dimension: "execution" } as const;
    expect(composeVerdict([{ scope: EXEC, applicability: "not_applicable", evidence: [] }]).verdict).toBeUndefined();
    const empty = composeVerdict([]);
    expect(empty.applicability).toBe("unknown");
    expect(empty.verdict).toBeUndefined();
    expect(() =>
      composeVerdict([{ scope: EXEC, applicability: "unknown", verdict: "supported", evidence: [] }]),
    ).toThrow(/MUST be absent when applicability is "unknown"/);
    expect(() =>
      composeVerdict([{ scope: EXEC, applicability: "not_applicable", verdict: "insufficient", evidence: [] }]),
    ).toThrow(/MUST be absent when applicability is "not_applicable"/);
  });

  it("supported/contradicted require basis AND evidence at artifact level", () => {
    for (const verdict of ["supported", "contradicted"] as const) {
      const c = validResultContent();
      c.networkEvidence.execution = {
        applicability: "applicable",
        verdict,
        basis: [],
        evidence: ["ev_receipt_1"],
      };
      expect(() => buildNetworkEvidenceResult(c, resultContext())).toThrow(/non-empty basis required/);

      const noEvidence = validResultContent();
      noEvidence.networkEvidence.execution = { applicability: "applicable", verdict, basis: ["source_observation"], evidence: [] };
      expect(() => buildNetworkEvidenceResult(noEvidence, resultContext())).toThrow(/non-empty evidence required/);
    }
  });

  it("ambiguous requires a material conflict affecting the proposition", () => {
    const scopedMaterial = {
      id: "c_x",
      code: "X",
      description: "x",
      scope: { kind: "dimension" as const, dimension: "execution" as const },
      evidence: ["ev_receipt_1"],
      material: true,
    };
    const amb = validResultContent();
    amb.networkEvidence.execution = {
      applicability: "applicable",
      verdict: "ambiguous",
      basis: ["source_observation"],
      evidence: ["ev_receipt_1"],
    };
    expect(() => buildNetworkEvidenceResult(amb, resultContext())).toThrow(
      /"ambiguous" requires at least one explicit material Conflict/,
    );
    expect(() =>
      buildNetworkEvidenceResult({ ...amb, conflicts: [scopedMaterial] }, resultContext()),
    ).not.toThrow();
  });

  it("material conflict + insufficient is REJECTED at artifact level and forces ambiguous in the composer", () => {
    const content = validResultContent();
    content.networkEvidence.execution = {
      applicability: "applicable",
      verdict: "insufficient",
      basis: [],
      evidence: [],
    };
    content.conflicts = [
      {
        id: "c_i",
        code: "X",
        description: "x",
        scope: { kind: "dimension" as const, dimension: "execution" as const },
        evidence: ["ev_receipt_1"],
        material: true,
      },
    ];
    expect(() => buildNetworkEvidenceResult(content, resultContext())).toThrow(
      /prevent "insufficient".*ambiguous required/,
    );

    const out = composeVerdict(
      [
        {
          scope: { kind: "dimension", dimension: "execution" },
          applicability: "applicable",
          verdict: "insufficient",
          basis: ["source_observation"],
          evidence: ["ev_receipt_1"],
        },
      ],
      { conflicts: content.conflicts, evidenceRefs: refsTT },
    );
    expect(out.verdict).toBe("ambiguous");
  });

  it("SINGLE-INPUT TRUTH TABLE (R3) — one contribution x applicability x verdict x conflict scope: composer outputs satisfy the artifact validator; missing-proof branches fail closed. (The ADVERSARIAL MULTI-CONTRIBUTION suite lives in verdict.test.ts: hostile arrays/iterators/getters, duplicate EvidenceRef/Conflict ids, malformed conflicts, unknown-shielding and the cross-product of effective contributions.)", () => {
    const EXEC = { kind: "dimension", dimension: "execution" } as const;
    const conflictSets = {
      none: [] as never[],
      scoped: [
        {
          id: "c_tt",
          code: "TT",
          description: "truth-table conflict",
          scope: { kind: "dimension", dimension: "execution" },
          evidence: ["ev_receipt_1"],
          material: true,
        },
      ] as never[],
      foreign: [
        {
          id: "c_f",
          code: "F",
          description: "foreign",
          scope: { kind: "dimension", dimension: "settlement" },
          evidence: ["ev_receipt_1"],
          material: true,
        },
      ] as never[],
    };

    for (const applicability of APPLICABILITIES) {
      for (const verdict of VERDICTS) {
        for (const setName of ["none", "scoped", "foreign"] as const) {
          const opts = { conflicts: conflictSets[setName], evidenceRefs: refsTT };
          const input = {
            scope: EXEC,
            applicability,
            ...(verdict !== undefined ? { verdict } : {}),
            basis: applicability === "applicable" ? (["source_observation"] as const) : ([] as const),
            evidence:
              applicability === "applicable" && verdict !== undefined
                ? (["ev_receipt_1"] as const)
                : ([] as const),
          };

          if (verdict !== undefined && applicability !== "applicable") {
            expect(() => composeVerdict([input as never], opts)).toThrow(NecValidationError);
            continue;
          }
          if (verdict === "ambiguous" && setName !== "scoped") {
            // ILLEGAL input shape: an ambiguous claim without a justifying
            // material conflict fails closed in composition too.
            expect(() => composeVerdict([input], opts)).toThrow(NecValidationError);
            continue;
          }
          if (
            (verdict === "supported" || verdict === "contradicted") &&
            setName === "scoped"
          ) {
            // Positive contributions + affecting material conflict are
            // FORCED to ambiguous by rule 3 (never laundered through).
            const forced = composeVerdict([input], opts);
            expect(forced.verdict).toBe("ambiguous");
            continue;
          }
          if (verdict === undefined && setName === "scoped" && applicability === "applicable") {
            // insufficient contribution + affecting material conflict ->
            // forced AMBIGUOUS (legal, justified output).
            const forced = composeVerdict([input], opts);
            expect(forced.verdict).toBe("ambiguous");
            continue;
          }

          const outcome = composeVerdict([input], opts);

          // Pairing invariant on the outcome itself.
          expect(outcome.verdict === undefined).toBe(outcome.applicability !== "applicable");

          // The outcome maps onto a legal EvidenceDimension shape.
          expect(() => validateEvidenceDimension(dimensionFromOutcome(outcome))).not.toThrow();

          if (applicability !== "applicable") continue;

          // Conflict coupling agreement between composer and validator.
          if (setName === "scoped") {
            expect(outcome.verdict).toBe("ambiguous");
          } else {
            expect(outcome.verdict).toBeDefined();
            if (outcome.verdict === "ambiguous") {
              throw new Error("composer emitted ambiguous without an affecting material conflict");
            }
          }

          // Artifact-level agreement for the applicable branch.
          const content = validResultContent();
          content.networkEvidence.execution = {
            applicability: "applicable",
            ...(outcome.verdict !== undefined ? { verdict: outcome.verdict } : {}),
            basis: [...outcome.basis],
            evidence: [...outcome.evidence],
          } as EvidenceDimension;
          content.conflicts = [...conflictSets[setName]];
          if (conflictSetBlocks(setName, outcome.verdict)) {
            expect(() => buildNetworkEvidenceResult(content, resultContext())).toThrow(NecValidationError);
          } else {
            expect(() => buildNetworkEvidenceResult(content, resultContext())).not.toThrow();
          }
        }
      }
    }

    function conflictSetBlocks(setName: string, verdict: string | undefined): boolean {
      if (setName !== "scoped") return false;
      return verdict !== "ambiguous";
    }
  });

  it("R3 MISSING-PROOF branches: unproved supported/contradicted inputs fail closed in the truth-table machine", () => {
    const EXEC = { kind: "dimension", dimension: "execution" } as const;
    // supported claim WITHOUT resolvable refs (empty index) -> rejected.
    expect(() =>
      composeVerdict([
        { scope: EXEC, applicability: "applicable", verdict: "supported", basis: ["source_observation"], evidence: ["ev_receipt_1"] },
      ]),
    ).toThrow(/does not resolve against complete validated EvidenceRefs/);
    // contradicted claim WITHOUT any basis -> rejected.
    expect(() =>
      composeVerdict([
        { scope: EXEC, applicability: "applicable", verdict: "contradicted", basis: [], evidence: ["ev_receipt_1"] },
      ], { evidenceRefs: refsTT }),
    ).toThrow(/non-empty basis/);
    // nonsense verdict string -> rejected (never converted to insufficient).
    expect(() =>
      composeVerdict([
        { scope: EXEC, applicability: "applicable", verdict: "nonsense" as never, basis: ["source_observation"], evidence: ["ev_receipt_1"] },
      ], { evidenceRefs: refsTT }),
    ).toThrow(/unknown runtime verdict/);
  });
});

// ---------------------------------------------------------------------------
// 7. NEC-owned identifier grammar
// ---------------------------------------------------------------------------

describe("NEC-owned identifier grammar ([A-Za-z0-9][A-Za-z0-9._:/-]{0,127})", () => {
  it("accepts ordinary NEC-owned identifier forms", () => {
    for (const ok of ["a", "Z", "req_1", "src.rpc.primary", "eip155:8453", "a/b:c-d_e", "X9._:/-"]) {
      expect(isNecIdentifier(ok), JSON.stringify(ok)).toBe(true);
      expect(() => assertNecIdentifier(ok, "p")).not.toThrow();
    }
  });

  it("rejects invalid ASCII/control/space forms without any normalization", () => {
    const bad = [
      "", // empty
      "-abc", // leading separator
      ".abc",
      "/abc",
      "_abc", // leading underscore
      " abc", // leading space
      "abc ", // trailing space
      "a b", // interior space
      "a\tb",
      "a\nb",
      "a\u0000b", // control character
      "café", // non-ASCII
      "ＡＢＣ", // fullwidth
    ];
    for (const value of bad) {
      expect(isNecIdentifier(value), JSON.stringify(value)).toBe(false);
      expect(() => assertNecIdentifier(value, "p")).toThrow(NecValidationError);
    }
  });

  it("boundary lengths: exactly 128 chars accepted, 129 rejected", () => {
    const ok128 = "a" + "b".repeat(127);
    const bad129 = "a" + "b".repeat(128);
    expect(ok128.length).toBe(128);
    expect(bad129.length).toBe(129);
    expect(() => assertNecIdentifier(ok128, "p")).not.toThrow();
    expect(() => assertNecIdentifier(bad129, "p")).toThrow(NecValidationError);
  });

  it("is enforced across NEC-owned surfaces (warning codes, citations, request ids)", () => {
    const badWarning = { code: "bad code!", message: "m" };
    expect(() => validateWarning(badWarning)).toThrow(/NEC identifier grammar/);

    const badCitation = { applicability: "applicable", verdict: "insufficient", basis: [], evidence: ["a b"] };
    expect(() => validateEvidenceDimension(badCitation as never)).toThrow(/NEC identifier grammar/);

    const badRequest = { ...evidenceRequestContent(), requestId: "req 1" };
    expect(() => validateEvidenceRequest(badRequest)).toThrow(/NEC identifier grammar/);

    const badDiscovery = discoveryRequirements({
      requirements: [{ capability: "execution", strength: "required" }],
    });
    expect(() => validateDiscoveryRequirements(badDiscovery)).not.toThrow();
  });

  it("native chain ids / tx ids are NOT constrained by the NEC-owned grammar", () => {
    const natives = [
      "+/=AbCd", // '+' and '=' never occur in the NEC grammar
      "QmYwAPJzv5CZsnA625y3Dgo==",
      "x".repeat(200), // far beyond the 128-char grammar bound
      "a=b",
    ];
    for (const value of natives) {
      expect(() => assertNativeId(value, "p")).not.toThrow();
      expect(isNecIdentifier(value)).toBe(false);
    }
    // They flow through contract validation untouched.
    const weird = evidenceRequestContent({
      subject: { type: "transaction", networkId: NETWORK, txId: "+/=AbCd" },
    });
    expect(() => validateEvidenceRequest(weird)).not.toThrow();
  });

  it("FREEZE-FINAL residuals: sourceRequirements[].sourceType uses the frozen NEC identifier grammar", () => {
    const base = {
      id: "resolver-x",
      version: "1",
      digest: computeResolverManifestDigest({
        id: "resolver-x",
        version: "1",
        networkFamilies: ["eip155"],
        implementation: {},
        supportedCapabilities: ["execution" as const],
        sourceRequirements: [{ sourceType: "rpc.primary", required: true }],
      }),
      networkFamilies: ["eip155"],
      implementation: {},
      supportedCapabilities: ["execution" as const],
      sourceRequirements: [{ sourceType: "rpc.primary", required: true }],
    };
    // Valid dotted NEC-owned source type is accepted...
    expect(() => validateResolverManifest(structuredClone(base))).not.toThrow();
    // ...while whitespace and Unicode spellings fail closed (no
    // normalization, no loose bounded-identifier acceptance).
    for (const bad of ["bad source type", "café", "rpc\u0000primary", " lead", "trail ", "ＲＰＣ"]) {
      expect(() =>
        validateResolverManifest({
          ...structuredClone(base),
          digest: computeResolverManifestDigest({
            ...base,
            sourceRequirements: [{ sourceType: bad, required: true }],
          }),
          sourceRequirements: [{ sourceType: bad, required: true }],
        }),
      ).toThrow(NecValidationError);
    }
  });

  it("FREEZE-FINAL residuals: nested result policy/snapshot references use the specialized ref validators", () => {
    // A malformed NEC-owned policy id inside a NetworkEvidenceResult ref is
    // rejected by the frozen grammar (previously a looser ad-hoc check).
    const content = validResultContent();
    content.policy = { id: "bad policy id", version: fullPolicy().version, digest: fullPolicy().digest };
    expect(() => buildNetworkEvidenceResult(content, resultContext())).toThrow(
      /NEC identifier grammar/,
    );
    const unicodeSnapshot = validResultContent();
    unicodeSnapshot.snapshot = { id: "snap_café", digest: resultContext().snapshot.digest };
    expect(() => buildNetworkEvidenceResult(unicodeSnapshot, resultContext())).toThrow(
      /NEC identifier grammar/,
    );
  });
});
