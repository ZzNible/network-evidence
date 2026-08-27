import { describe, expect, it } from "vitest";

import {
  buildCapabilitySnapshot,
  buildDiscoverNetworksResult,
  buildEvidenceSnapshot,
  buildPreflightResult,
  composePreflightStatus,
  computeEvidencePolicyDigest,
  decodeNecWireJson,
  encodeNecWireJson,
  NecValidationError,
  verifyCapabilitySnapshotIntegrity,
  verifyDiscoverNetworksResultIntegrity,
  verifyEvidenceSnapshotIntegrity,
  verifyPreflightResultIntegrity,
  validateCapabilitySnapshot,
  validateDiscoverNetworksResult,
  validatePreflightResult,
} from "../src/index.js";
import type { PolicyDimension, PreflightStatus } from "../src/index.js";
import {
  blocker,
  discoveryMatch,
  discoveryRequirements,
  evidenceRef,
  fingerprint,
  fullManifest,
  fullPolicy,
  fullSnapshot,
  NETWORK,
  preflightCapabilitySnapshot,
  preflightContext,
  preflightRequestContent,
  readiness,
  validCapabilitySnapshotContent,
  validPreflightResultContent,
} from "./fixtures.js";

/**
 * DISCOVERY / PREFLIGHT AUDITABILITY (freeze requirements, R3 revision):
 *   - CapabilitySnapshot: evidence ids resolve to its table; resolver ref
 *     digest is meaningful; artifact digest fully specified; construction
 *     REQUIRES the complete manifest + probe target and enforces the
 *     manifest-authority invariant.
 *   - Discovery: binds the request; digest-qualified snapshot refs;
 *     evaluations traceable 1:1 to requirements and resolvable evidence.
 *   - Preflight: binds action/request + policy + resolver/capability
 *     context; readiness evidence resolvable AND derivable from the
 *     supplied capability context; blockers never coexist with "ready";
 *     three-state deterministic status composition (the caller never
 *     authors the overall status — the builder recomputes it).
 */

const SNAP_CTX = () => ({ resolver: fullManifest(), networkId: NETWORK });

describe("CapabilitySnapshot auditability", () => {
  it("builds with a fully specified artifactDigest and verifies", () => {
    const built = buildCapabilitySnapshot(validCapabilitySnapshotContent(), SNAP_CTX());
    expect(built.artifactDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(verifyCapabilitySnapshotIntegrity(built)).toBe(true);
    const tampered = {
      ...built,
      evidenceCapabilities: {
        ...built.evidenceCapabilities,
        execution: { ...built.evidenceCapabilities.execution, availability: "degraded" as const },
      },
    };
    expect(verifyCapabilitySnapshotIntegrity(tampered)).toBe(false);
  });

  it("R3: claim verification REQUIRES the requested networkId AND complete manifest", () => {
    const built = buildCapabilitySnapshot(validCapabilitySnapshotContent(), SNAP_CTX());
    // Correct context verifies.
    expect(
      buildCapabilitySnapshot(validCapabilitySnapshotContent(), SNAP_CTX()).artifactDigest,
    ).toBeTruthy();
    // Wrong probe target fails closed.
    expect(() =>
      buildCapabilitySnapshot(validCapabilitySnapshotContent(), {
        resolver: fullManifest(),
        networkId: "eip155:1",
      }),
    ).toThrow(/does not match the explicitly requested target/);
    expect(built.id).toBe(validCapabilitySnapshotContent().id);
  });

  it("capability evidence ids must resolve to the snapshot evidence table", () => {
    const content = validCapabilitySnapshotContent();
    content.executionCapabilities = {
      executionModel: { support: "supported", availability: "available", evidence: ["ev_ghost"] },
    };
    expect(() => buildCapabilitySnapshot(content, SNAP_CTX())).toThrow(/dangling provenance/);

    const badEvidenceCap = validCapabilitySnapshotContent();
    badEvidenceCap.evidenceCapabilities = {
      ...badEvidenceCap.evidenceCapabilities,
      execution: { support: "supported", availability: "available", evidence: ["ev_ghost"] },
    };
    expect(() => buildCapabilitySnapshot(badEvidenceCap, SNAP_CTX())).toThrow(/dangling provenance/);
  });

  it("resolver ref digest is meaningful: mismatch with provided manifest rejected", () => {
    const content = validCapabilitySnapshotContent();
    content.resolver = { ...content.resolver, digest: `sha256:${"ff".repeat(32)}` };
    expect(() =>
      buildCapabilitySnapshot(content, { resolver: fullManifest(), networkId: NETWORK }),
    ).toThrow(/snapshot resolver reference does not exactly match/);
  });

  it("duplicate evidence ids rejected", () => {
    const content = validCapabilitySnapshotContent();
    content.evidence = [evidenceRef(), evidenceRef()];
    expect(() => buildCapabilitySnapshot(content, SNAP_CTX())).toThrow(/duplicate evidence id/);
  });
});

describe("EvidenceSnapshot auditability", () => {
  it("digest binds createdAt and anchors; verification detects tampering", () => {
    const snapshot = fullSnapshot();
    expect(verifyEvidenceSnapshotIntegrity(snapshot)).toBe(true);
    const later = buildEvidenceSnapshot({
      id: snapshot.id,
      createdAt: "2027-01-01T00:00:00.000Z",
      networkFingerprint: snapshot.networkFingerprint,
      anchors: snapshot.anchors,
      evidence: [...snapshot.evidence],
      resolverManifestDigest: snapshot.resolverManifestDigest,
      policyDigest: snapshot.policyDigest,
    });
    expect(later.digest).not.toBe(snapshot.digest);
    expect(verifyEvidenceSnapshotIntegrity({ ...snapshot, anchors: [] })).toBe(false);
  });

  it("snapshot digest binds the REAL policy and manifest digests", () => {
    const snapshot = fullSnapshot();
    expect(snapshot.policyDigest).toBe(fullPolicy().digest);
    expect(snapshot.resolverManifestDigest).toBe(fullManifest().digest);
    // A snapshot claiming wrong bindings fails validation (self-digest).
    expect(
      verifyEvidenceSnapshotIntegrity({
        ...snapshot,
        policyDigest: `sha256:${"ab".repeat(32)}`,
      }),
    ).toBe(false);
  });
});

describe("Discovery auditability", () => {
  // FREEZE-FINAL: claim-producing builders REQUIRE complete context, so the
  // auditable world supplies the REAL referenced snapshot + manifest.
  function discSnap(): ReturnType<typeof buildCapabilitySnapshot> {
    return buildCapabilitySnapshot(
      {
        ...validCapabilitySnapshotContent(),
        id: "capsnap_disc",
        evidenceCapabilities: {
          execution: { support: "supported", availability: "available", evidence: ["ev_receipt_1"] },
          observedEffects: { support: "supported", availability: "available", evidence: ["ev_receipt_1"] },
          dataBinding: { support: "unsupported", availability: "unavailable" },
          settlement: { support: "unsupported", availability: "unavailable" },
          finality: { support: "unknown", availability: "unknown" },
        },
        executionCapabilities: {},
      },
      { resolver: fullManifest(), networkId: NETWORK },
    );
  }

  function discCtx(snap = discSnap()) {
    return { capabilitySnapshots: [snap], resolverManifests: [fullManifest()] };
  }

  function discoveryContent() {
    const snap = discSnap();
    return {
      schemaVersion: "0.1" as const,
      requestId: "disc_req_1",
      generatedAt: "2026-01-01T00:00:00.000Z",
      request: discoveryRequirements(),
      matches: [
        discoveryMatch({
          capabilitySnapshot: { id: snap.id, digest: snap.artifactDigest },
        }),
      ],
    };
  }

  it("binds the request and digest-qualified snapshot refs; verifies", () => {
    const built = buildDiscoverNetworksResult(discoveryContent(), discCtx());
    expect(built.artifactDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(built.matches[0]!.capabilitySnapshot.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(verifyDiscoverNetworksResultIntegrity(built)).toBe(true);

    const tampered = { ...built, requestId: "other" };
    expect(verifyDiscoverNetworksResultIntegrity(tampered)).toBe(false);
  });

  it("FREEZE-FINAL: building WITHOUT the complete context fails closed at runtime (TS rejects it at compile time)", () => {
    const snap = discSnap();
    const content = {
      schemaVersion: "0.1" as const,
      requestId: "disc_req_nectx",
      generatedAt: "2026-01-01T00:00:00.000Z",
      request: discoveryRequirements(),
      matches: [
        discoveryMatch({
          capabilitySnapshot: { id: snap.id, digest: snap.artifactDigest },
        }),
      ],
    };
    // Runtime JS cast omitting the context entirely:
    expect(() =>
      (buildDiscoverNetworksResult as (c: unknown) => unknown)(content),
    ).toThrow(/requires the COMPLETE verification context/);
    // Integrity-only verification stays intentionally context-free.
    const built = buildDiscoverNetworksResult(content, discCtx(snap));
    expect(verifyDiscoverNetworksResultIntegrity(built)).toBe(true);
  });

  it("evaluations must correspond 1:1 to the bound request requirements", () => {
    const content = discoveryContent();
    content.matches = [
      discoveryMatch({
        capabilitySnapshot: content.matches[0]!.capabilitySnapshot,
        evaluations: [
          discoveryMatch().evaluations[0]!,
          {
            requirement: { capability: "finality", strength: "desired" },
            status: "unknown",
            reason: "capability is not provably usable (unsupported-by-evidence or undetermined)",
          },
        ],
      }),
    ];
    expect(() => buildDiscoverNetworksResult(content, discCtx())).toThrow(/1:1/);
  });

  it("evaluation evidence must resolve within the match evidence table", () => {
    const content = discoveryContent();
    content.matches = [
      discoveryMatch({
        capabilitySnapshot: content.matches[0]!.capabilitySnapshot,
        evaluations: [{ ...discoveryMatch().evaluations[0]!, evidence: ["ev_ghost"] }],
      }),
    ];
    expect(() => buildDiscoverNetworksResult(content, discCtx())).toThrow(/dangling provenance/);
  });

  it("duplicate matches for one network rejected", () => {
    const content = discoveryContent();
    content.matches = [discoveryMatch({
      capabilitySnapshot: content.matches[0]!.capabilitySnapshot,
    }), discoveryMatch({
      capabilitySnapshot: content.matches[0]!.capabilitySnapshot,
    })];
    expect(() => buildDiscoverNetworksResult(content, discCtx())).toThrow(/duplicate match/);
  });

  it("wire round trip", () => {
    const built = buildDiscoverNetworksResult(discoveryContent(), discCtx());
    const wire = encodeNecWireJson("discovery-result", built);
    expect(decodeNecWireJson("discovery-result", wire)).toEqual(built);
  });
});

describe("Preflight auditability", () => {
  it("builds, verifies, and binds policy/request/resolver", () => {
    const built = buildPreflightResult(validPreflightResultContent(), preflightContext());
    expect(verifyPreflightResultIntegrity(built)).toBe(true);
    expect(built.request.action.kind).toBe("erc20.transfer");
    // R3 identity: no top-level requestId — the embedded request carries it.
    expect((built as unknown as Record<string, unknown>).requestId).toBeUndefined();
    expect(built.request.requestId).toBe("pf_req_1");
    expect(built.evidencePolicy.digest).toBe(fullPolicy().digest);
    expect(built.resolver.digest).toBe(fullManifest().digest);
  });

  it("evidencePolicy ref must exactly match the embedded request policy", () => {
    const content = validPreflightResultContent();
    content.evidencePolicy = { ...content.evidencePolicy, version: "9" };
    expect(() => buildPreflightResult(content, preflightContext())).toThrow(
      /does not match the bound preflight request policy/,
    );
  });

  it("readiness evidence must resolve in the result evidence table", () => {
    const content = validPreflightResultContent();
    content.evidenceReadiness = {
      ...content.evidenceReadiness,
      execution: readiness("ready", { evidence: ["ev_ghost"] }),
    };
    expect(() => buildPreflightResult(content, preflightContext())).toThrow(/dangling provenance/);
  });

  describe("FREEZE-FINAL readiness provenance binding (ready citations ⊆ capability-state evidence)", () => {
    // CapabilityState evidence for BOTH required dimensions is exactly
    // [ev_capability] in this world; the result's own evidence table
    // additionally carries ev_unrelated so only the SUBSET rule can reject.
    function subsetWorld() {
      const snap = buildCapabilitySnapshot(
        {
          ...validCapabilitySnapshotContent(),
          id: "capsnap_subset",
          evidenceCapabilities: {
            execution: { support: "supported", availability: "available", evidence: ["ev_capability"] },
            observedEffects: { support: "supported", availability: "available", evidence: ["ev_capability"] },
            dataBinding: { support: "unsupported", availability: "unavailable" },
            settlement: { support: "unsupported", availability: "unavailable" },
            finality: { support: "unknown", availability: "unknown" },
          },
          executionCapabilities: {},
          evidence: [
            evidenceRef({ id: "ev_capability", sourceId: "src.capability" }),
            evidenceRef({ id: "ev_unrelated", sourceId: "src.unrelated" }),
          ],
        },
        { resolver: fullManifest(), networkId: NETWORK },
      );
      const content = validPreflightResultContent({
        capabilitySnapshot: { id: snap.id, digest: snap.artifactDigest },
        evidenceReadiness: {
          execution: readiness("ready", { evidence: ["ev_capability"] }),
          observedEffects: readiness("ready", { evidence: ["ev_capability"] }),
          dataBinding: readiness("not_applicable"),
          settlement: readiness("not_applicable"),
          finality: readiness("not_applicable"),
        },
        evidence: [
          evidenceRef({ id: "ev_capability", sourceId: "src.capability" }),
          evidenceRef({ id: "ev_unrelated", sourceId: "src.unrelated" }),
        ],
      });
      return {
        content,
        context: { resolver: fullManifest(), capabilitySnapshot: snap },
      };
    }

    it("ready citations DISJOINT from the capability evidence => reject", () => {
      const { content, context } = subsetWorld();
      content.evidenceReadiness.execution = readiness("ready", { evidence: ["ev_unrelated"] });
      expect(() => buildPreflightResult(content, context)).toThrow(/NON-EMPTY SUBSET/);
    });

    it("ready citations EQUAL to the capability evidence => accept", () => {
      const { content, context } = subsetWorld();
      content.evidenceReadiness.execution = readiness("ready", { evidence: ["ev_capability"] });
      expect(buildPreflightResult(content, context).status).toBe("ready");
    });

    it("ready citations as a NON-EMPTY SUBSET of larger capability evidence => accept", () => {
      // Grow the capability observation to two refs; citing one is legal.
      const snap = buildCapabilitySnapshot(
        {
          ...validCapabilitySnapshotContent(),
          id: "capsnap_subset2",
          evidenceCapabilities: {
            execution: {
              support: "supported",
              availability: "available",
              evidence: ["ev_a", "ev_b"],
            },
            observedEffects: { support: "supported", availability: "available", evidence: ["ev_a"] },
            dataBinding: { support: "unsupported", availability: "unavailable" },
            settlement: { support: "unsupported", availability: "unavailable" },
            finality: { support: "unknown", availability: "unknown" },
          },
          executionCapabilities: {},
          evidence: [
            evidenceRef({ id: "ev_a", sourceId: "src.a" }),
            evidenceRef({ id: "ev_b", sourceId: "src.b" }),
          ],
        },
        { resolver: fullManifest(), networkId: NETWORK },
      );
      const content2 = validPreflightResultContent({
        capabilitySnapshot: { id: snap.id, digest: snap.artifactDigest },
        evidenceReadiness: {
          execution: readiness("ready", { evidence: ["ev_b"] }),
          observedEffects: readiness("ready", { evidence: ["ev_a"] }),
          dataBinding: readiness("not_applicable"),
          settlement: readiness("not_applicable"),
          finality: readiness("not_applicable"),
        },
        evidence: [evidenceRef({ id: "ev_a", sourceId: "src.a" }), evidenceRef({ id: "ev_b", sourceId: "src.b" })],
      });
      expect(buildPreflightResult(content2, { resolver: fullManifest(), capabilitySnapshot: snap }).status).toBe("ready");

      // Same world, but the ready check cites capability ev_a PLUS a ghost:
      content2.evidenceReadiness.execution = readiness("ready", { evidence: ["ev_a", "ev_ghost"] });
      expect(() =>
        buildPreflightResult(content2, { resolver: fullManifest(), capabilitySnapshot: snap }),
      ).toThrow();
    });

    it("an EMPTY ready citation set is not enough even when the capability itself is proven", () => {
      const { content, context } = subsetWorld();
      content.evidenceReadiness.execution = readiness("ready");
      expect(() => buildPreflightResult(content, context)).toThrow(/NON-EMPTY SUBSET/);
    });

    it("non-ready states are NOT required to fabricate evidence", () => {
      const { content, context } = subsetWorld();
      content.evidenceReadiness.dataBinding = readiness("unknown");
      content.evidenceReadiness.settlement = readiness("blocked");
      content.evidenceReadiness.finality = readiness("not_applicable");
      const built = buildPreflightResult(content, context);
      expect(built.evidenceReadiness.dataBinding.status).toBe("unknown");
      expect(built.evidenceReadiness.settlement.status).toBe("blocked");
    });
  });

  describe("FREEZE-FINAL explicit preflight truth-table regressions", () => {
    it("ZERO required dimensions + no blocker => ready (intentional vacuous readiness)", () => {
      const emptyPolicyContent = { ...fullPolicy(), requiredDimensions: [] as PolicyDimension[] };
      const emptyPolicy = { ...emptyPolicyContent, digest: computeEvidencePolicyDigest(emptyPolicyContent) };
      const content = validPreflightResultContent({
        request: { ...preflightRequestContent(), evidencePolicy: emptyPolicy },
        evidencePolicy: { id: emptyPolicy.id, version: emptyPolicy.version, digest: emptyPolicy.digest },
        evidenceReadiness: {
          execution: readiness("not_applicable"),
          observedEffects: readiness("not_applicable"),
          dataBinding: readiness("not_applicable"),
          settlement: readiness("not_applicable"),
          finality: readiness("not_applicable"),
        },
      });
      const built = buildPreflightResult(content, preflightContext());
      expect(built.status).toBe("ready");
    });

    it("DESIRED blocked + all REQUIRED ready => ready (desired never gates)", () => {
      const desiredBlockedPolicyContent = {
        ...fullPolicy(),
        desiredDimensions: ["settlement" as const],
      };
      const desiredBlockedPolicy = {
        ...desiredBlockedPolicyContent,
        digest: computeEvidencePolicyDigest(desiredBlockedPolicyContent),
      };
      const content = validPreflightResultContent({
        request: { ...preflightRequestContent(), evidencePolicy: desiredBlockedPolicy },
        evidencePolicy: {
          id: desiredBlockedPolicy.id,
          version: desiredBlockedPolicy.version,
          digest: desiredBlockedPolicy.digest,
        },
        evidenceReadiness: {
          execution: readiness("ready", { evidence: ["ev_receipt_1"] }),
          observedEffects: readiness("ready", { evidence: ["ev_receipt_1"] }),
          dataBinding: readiness("not_applicable"),
          settlement: readiness("blocked"), // DESIRED dimension, blocked
          finality: readiness("not_applicable"),
        },
      });
      const built = buildPreflightResult(content, preflightContext());
      expect(built.status).toBe("ready");
      expect(built.evidenceReadiness.settlement.status).toBe("blocked");
    });
  });

  it("blockers can never coexist with an overall ready status; the builder recomputes the status", () => {
    // Caller-supplied `status` is rejected outright (never caller-authored).
    const smuggling = validPreflightResultContent() as Record<string, unknown>;
    smuggling.status = "ready";
    expect(() => buildPreflightResult(smuggling as never, preflightContext())).toThrow(
      /self-digest field "status"/,
    );

    // Adding a blocker flips the recomputed status to blocked.
    const blocked = validPreflightResultContent({ blockers: [blocker()] });
    const built = buildPreflightResult(blocked, preflightContext());
    expect(built.status).toBe("blocked");
  });

  it("status composition is deterministic (three states)", () => {
    const required: PolicyDimension[] = fullPolicy().requiredDimensions;
    const checksFor = (execution: PreflightStatus | "not_applicable") => ({
      execution: readiness(execution as never),
      observedEffects: readiness(execution as never),
      dataBinding: readiness("not_applicable" as const),
      settlement: readiness("not_applicable" as const),
      finality: readiness("not_applicable" as const),
    });

    expect(
      composePreflightStatus({
        evidenceReadiness: checksFor("ready"),
        blockers: [],
        requiredDimensions: required,
      }),
    ).toBe("ready");

    // required unknown => UNKNOWN (no more "partial")
    expect(
      composePreflightStatus({
        evidenceReadiness: checksFor("unknown"),
        blockers: [],
        requiredDimensions: required,
      }),
    ).toBe("unknown");
    const unknownBuilt = buildPreflightResult(
      validPreflightResultContent({
        evidenceReadiness: checksFor("unknown"),
      }),
      preflightContext(),
    );
    expect(unknownBuilt.status).toBe("unknown");
    expect(verifyPreflightResultIntegrity(unknownBuilt)).toBe(true);

    expect(
      composePreflightStatus({
        evidenceReadiness: checksFor("blocked"),
        blockers: [],
        requiredDimensions: required,
      }),
    ).toBe("blocked");

    // any blocker => blocked
    expect(
      composePreflightStatus({
        evidenceReadiness: checksFor("ready"),
        blockers: [blocker()],
        requiredDimensions: required,
      }),
    ).toBe("blocked");
  });

  it("wire round trip", () => {
    const built = buildPreflightResult(validPreflightResultContent(), preflightContext());
    const wire = encodeNecWireJson("preflight-result", built);
    expect(decodeNecWireJson("preflight-result", wire)).toEqual(built);
  });

  it("validators accept unknown input and fail closed", () => {
    expect(() => validatePreflightResult(undefined)).toThrow(NecValidationError);
    expect(() => validatePreflightResult(null)).toThrow(NecValidationError);
    expect(() => validatePreflightResult(42)).toThrow(NecValidationError);
    expect(() => validateDiscoverNetworksResult("x")).toThrow(NecValidationError);
    expect(() => validateCapabilitySnapshot([])).toThrow(NecValidationError);

    const built = buildPreflightResult(validPreflightResultContent(), preflightContext());
    expect(() => validatePreflightResult(built)).not.toThrow();

    expect(() =>
      validateCapabilitySnapshot(buildCapabilitySnapshot(validCapabilitySnapshotContent(), SNAP_CTX())),
    ).not.toThrow();
  });
});
