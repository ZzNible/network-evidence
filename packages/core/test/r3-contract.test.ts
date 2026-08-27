import { describe, expect, it } from "vitest";

import {
  buildCapabilitySnapshot,
  buildDiscoverNetworksResult,
  buildNetworkEvidenceResult,
  buildPreflightResult,
  canonicalJson,
  composeDiscoveryMatch,
  computeResolverManifestDigest,
  decodeNecWireJson,
  encodeNecWireJson,
  NecCanonicalizationError,
  NecValidationError,
  NecWireError,
  parseNecWireJson,
  RESOURCE_LIMITS,
  validateDiscoveryRequirements,
  verifyCapabilitySnapshot,
  verifyCapabilitySnapshotIntegrity,
  verifyDiscoverNetworksResult,
  verifyDiscoverNetworksResultIntegrity,
  verifyNetworkEvidenceResult,
  verifyPreflightResult,
  verifyPreflightResultIntegrity,
} from "../src/index.js";
import type { CapabilitySnapshot } from "../src/index.js";
import {
  discoveryMatch,
  discoveryRequirements,
  evidenceRef,
  fingerprint,
  fullManifest,
  NETWORK,
  preflightContext,
  validCapabilitySnapshotContent,
  validPreflightResultContent,
  validResultContent,
  resultContext,
} from "./fixtures.js";

/**
 * CONTRACT CLOSURE R3 — required regression proofs.
 *
 * CONTEXT    : claim verification REQUIRES complete context (no optional
 *              context parameters anywhere on a claim-verification path).
 * PROVENANCE : discovery evidence closure + full fingerprint equality +
 *              normalized composer comparison.
 * HARDENING  : constructor-getter inertness, raw-parser resource boundaries,
 *              network allow/deny grammar.
 */
describe("R3 CONTEXT: claim verification requires complete context", () => {
  const SNAP_CTX = () => ({ resolver: fullManifest(), networkId: NETWORK });

  it("CapabilitySnapshot cannot be claim-verified without the requested networkId + complete manifest", () => {
    const snap = buildCapabilitySnapshot(validCapabilitySnapshotContent(), SNAP_CTX());
    // Self-digest integrity passes without context (it makes no claims).
    expect(verifyCapabilitySnapshotIntegrity(snap)).toBe(true);
    // Contextual claim verification FAILS CLOSED against wrong context...
    expect(
      verifyCapabilitySnapshot(snap, { resolver: fullManifest(), networkId: "eip155:1" }),
    ).toBe(false);
    expect(
      verifyCapabilitySnapshot(snap, {
        resolver: { ...fullManifest(), version: "9.9.9", digest: `sha256:${"11".repeat(32)}` },
        networkId: NETWORK,
      }),
    ).toBe(false);
    // ...and succeeds only against the exact complete context.
    expect(verifyCapabilitySnapshot(snap, SNAP_CTX())).toBe(true);
  });

  function usableSnapshot(
    id: string,
    evidenceOverride?: ReturnType<typeof evidenceRef>[],
  ): CapabilitySnapshot {
    return buildCapabilitySnapshot(
      {
        ...validCapabilitySnapshotContent(),
        id,
        evidenceCapabilities: {
          execution: { support: "supported", availability: "available", evidence: ["ev_receipt_1"] },
          observedEffects: { support: "supported", availability: "available", evidence: ["ev_receipt_1"] },
          dataBinding: { support: "unsupported", availability: "unavailable" },
          settlement: { support: "unsupported", availability: "unavailable" },
          finality: { support: "unknown", availability: "unknown" },
        },
        executionCapabilities: {},
        ...(evidenceOverride !== undefined ? { evidence: evidenceOverride } : {}),
      },
      SNAP_CTX(),
    );
  }

  it("Discovery cannot be claim-verified without complete snapshots/manifests", () => {
    const snap = usableSnapshot("capsnap_ctx");
    const content = {
      schemaVersion: "0.1" as const,
      requestId: "disc_r3",
      generatedAt: "2026-01-01T00:00:00.000Z",
      request: discoveryRequirements(),
      matches: [
        discoveryMatch({
          capabilitySnapshot: { id: snap.id, digest: snap.artifactDigest },
        }),
      ],
    };
    const built = buildDiscoverNetworksResult(content, {
      capabilitySnapshots: [snap],
      resolverManifests: [fullManifest()],
    });
    // Integrity (self-digest) alone still verifies...
    expect(verifyDiscoverNetworksResultIntegrity(built)).toBe(true);
    // ...but CLAIM verification fails closed on incomplete context:
    expect(verifyDiscoverNetworksResult(built, { capabilitySnapshots: [], resolverManifests: [] })).toBe(false);
    expect(verifyDiscoverNetworksResult(built, { capabilitySnapshots: [snap], resolverManifests: [] })).toBe(false);
    // With tampered provenance under the same EvidenceId: rejected.
    const forgedSnap = usableSnapshot("capsnap_forged", [
      evidenceRef({ id: "ev_receipt_1", locator: "tampered" }),
    ]);
    expect(
      verifyDiscoverNetworksResult(built, {
        capabilitySnapshots: [forgedSnap],
        resolverManifests: [fullManifest()],
      }),
    ).toBe(false);
    // Complete correct context verifies.
    expect(
      verifyDiscoverNetworksResult(built, {
        capabilitySnapshots: [snap],
        resolverManifests: [fullManifest()],
      }),
    ).toBe(true);
  });

  it("Preflight cannot be claim-verified without its complete verification context", () => {
    const built = buildPreflightResult(validPreflightResultContent(), preflightContext());
    expect(verifyPreflightResultIntegrity(built)).toBe(true);
    // Wrong manifest version (=> different manifest) -> rejected.
    expect(
      verifyPreflightResult(built, {
        resolver: { ...fullManifest(), version: "0.0.1" },
        capabilitySnapshot: preflightContext().capabilitySnapshot,
      }),
    ).toBe(false);
    // A preflight WITHOUT snapshot reference or ready claims verifies with
    // the manifest alone.
    const noRef = validPreflightResultContent();
    delete (noRef as Record<string, unknown>).capabilitySnapshot;
    const refless = buildPreflightResult(
      {
        ...noRef,
        evidenceReadiness: {
          execution: { status: "unknown" },
          observedEffects: { status: "unknown" },
          dataBinding: { status: "unknown" },
          settlement: { status: "unknown" },
          finality: { status: "unknown" },
        },
      },
      { resolver: fullManifest() },
    );
    expect(verifyPreflightResult(refless, { resolver: fullManifest() })).toBe(true);
  });

  it("FREEZE-FINAL TYPES: builders REQUIRE context in the public TS contract", () => {
    // Coherent world: the composer agreement requires a USABLE execution
    // capability behind the fixture match.
    const snap = buildCapabilitySnapshot(
      {
        ...validCapabilitySnapshotContent(),
        id: "capsnap_types",
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
    const content = {
      schemaVersion: "0.1" as const,
      requestId: "disc_types",
      generatedAt: "2026-01-01T00:00:00.000Z",
      request: discoveryRequirements(),
      matches: [
        discoveryMatch({ capabilitySnapshot: { id: snap.id, digest: snap.artifactDigest } }),
      ],
    };
    const fullCtx = {
      capabilitySnapshots: [snap],
      resolverManifests: [fullManifest()],
    };
    expect(() => buildDiscoverNetworksResult(content, fullCtx)).not.toThrow();
    // The optional-context overloads are GONE: omitting the context must
    // not compile through the public contract...
    expect(() =>
      // @ts-expect-error — context is REQUIRED (no optional overload/shim)
      buildDiscoverNetworksResult(content),
    ).toThrow(/requires the COMPLETE verification context/);
    const pfContent = validPreflightResultContent();
    delete (pfContent as Record<string, unknown>).capabilitySnapshot;
    const pfNoClaims: import("../src/index.js").PreflightResultContent = {
      ...pfContent,
      evidenceReadiness: {
        execution: { status: "unknown" },
        observedEffects: { status: "unknown" },
        dataBinding: { status: "unknown" },
        settlement: { status: "unknown" },
        finality: { status: "unknown" },
      },
    };
    expect(() => buildPreflightResult(pfNoClaims, { resolver: fullManifest() })).not.toThrow();
    expect(() =>
      // @ts-expect-error — preflight builder context is REQUIRED too
      buildPreflightResult(pfNoClaims),
    ).toThrow(/requires the COMPLETE verification context/);
  });

  it("FREEZE-FINAL TYPES: PreflightResultContent is the CALLER/BUILD input (no derived fields)", async () => {
    const { buildPreflightResult } = await import("../src/index.js");
    const content = validPreflightResultContent();
    // `status` and `artifactDigest` are DERIVED — they are not part of the
    // builder-input type; forcing `status` in must not compile...
    const smuggled: import("../src/index.js").PreflightResultContent = {
      ...content,
      // @ts-expect-error — "status" is NOT part of PreflightResultContent
      status: "ready",
    };
    expect((smuggled as Record<string, unknown>).status).toBe("ready"); // cast object still has it…
    // …but the RUNTIME exact-schema guard rejects it outright for JS casts:
    expect(() =>
      buildPreflightResult(
        (structuredClone(smuggled) as unknown) as Parameters<typeof buildPreflightResult>[0],
        preflightContext(),
      ),
    ).toThrow(/self-digest field "status"/);
    // And the derived values ARE on the built artifact:
    const built = buildPreflightResult(validPreflightResultContent(), preflightContext());
    expect(built.status).toBe("ready");
    expect(typeof built.artifactDigest).toBe("string");
    // Digest determinism is unaffected by the input-type split.
    const again = buildPreflightResult(validPreflightResultContent(), preflightContext());
    expect(again.artifactDigest).toBe(built.artifactDigest);
  });

  it("a Result with a referenced preflight cannot be claim-verified without the preflight's own complete context", async () => {
    const pf = buildPreflightResult(validPreflightResultContent(), preflightContext());
    const request = resultContext().request;
    const ctx = {
      ...resultContext(),
      request: { ...request, preflight: { requestId: pf.request.requestId, digest: pf.artifactDigest } },
      preflight: pf,
      preflightContext: preflightContext(),
    };
    const built = buildNetworkEvidenceResult(validResultContent(), ctx);
    expect(verifyNetworkEvidenceResult(built, ctx)).toBe(true);
    // Dropping ONLY the preflight's own verification context fails closed.
    const ctxWithoutPfContext: Record<string, unknown> = { ...ctx };
    delete ctxWithoutPfContext.preflightContext;
    expect(verifyNetworkEvidenceResult(built, ctxWithoutPfContext as never)).toBe(false);
  });
});

describe("R3 DISCOVERY: normalized comparison + provenance closure + fingerprint equality", () => {
  function world() {
    const snap = buildCapabilitySnapshot(validCapabilitySnapshotContent(), {
      resolver: fullManifest(),
      networkId: NETWORK,
    });
    return { snap };
  }

  function discoveryContent(snap: ReturnType<typeof world>["snap"], matchOverrides: Record<string, unknown> = {}) {
    return {
      schemaVersion: "0.1" as const,
      requestId: "disc_norm",
      generatedAt: "2026-01-01T00:00:00.000Z",
      request: discoveryRequirements({
        requirements: [{ capability: "execution", strength: "required" }],
      }),
      matches: [
        discoveryMatch({
          capabilitySnapshot: { id: snap.id, digest: snap.artifactDigest },
          ...matchOverrides,
        }),
      ],
    };
  }

  const FULL_CTX = (snap: CapabilitySnapshot) => ({
    capabilitySnapshots: [snap],
    resolverManifests: [fullManifest()],
  });

  it("caller-authored `reason` that disagrees with the recomposed result is rejected", () => {
    const { snap } = world();
    const content = discoveryContent(snap, {
      evaluations: [
        {
          requirement: { capability: "execution", strength: "required" },
          status: "satisfied",
          reason: "trust me bro", // disagrees with deterministic composer reason
          evidence: ["ev_receipt_1"],
        },
      ],
    });
    expect(() => buildDiscoverNetworksResult(content, FULL_CTX(snap))).toThrow(
      /disagrees with the normative composer/,
    );
  });

  it("citation permutations inside evaluations keep digests AND contextual verification stable", () => {
    // Snapshot whose evidence table carries every cited id.
    const snap = buildCapabilitySnapshot(
      {
        ...validCapabilitySnapshotContent(),
        id: "capsnap_perm",
        evidenceCapabilities: {
          execution: { support: "supported", availability: "available", evidence: ["ev_a", "ev_b"] },
          observedEffects: { support: "supported", availability: "available", evidence: ["ev_receipt_1"] },
          dataBinding: { support: "unsupported", availability: "unavailable" },
          settlement: { support: "unsupported", availability: "unavailable" },
          finality: { support: "unknown", availability: "unknown" },
        },
        executionCapabilities: {},
        evidence: [
          evidenceRef(),
          evidenceRef({ id: "ev_a", sourceId: "src.a" }),
          evidenceRef({ id: "ev_b", sourceId: "src.b" }),
        ],
      },
      { resolver: fullManifest(), networkId: NETWORK },
    );
    const multiReq = discoveryRequirements({
      requirements: [
        { capability: "execution", strength: "required" },
        { capability: "observedEffects", strength: "desired" },
      ],
    });
    const MATCH_EVIDENCE = () => [
      evidenceRef(),
      evidenceRef({ id: "ev_a", sourceId: "src.a" }),
      evidenceRef({ id: "ev_b", sourceId: "src.b" }),
    ];
    const mk = (order: string[]) => ({
      schemaVersion: "0.1" as const,
      requestId: "disc_perm",
      generatedAt: "2026-01-01T00:00:00.000Z",
      request: multiReq,
      matches: [
        discoveryMatch({
          capabilitySnapshot: { id: snap.id, digest: snap.artifactDigest },
          evaluations: [
            {
              requirement: { capability: "execution", strength: "required" },
              status: "satisfied",
              reason: "capability is usable",
              evidence: order,
            },
            {
              requirement: { capability: "observedEffects", strength: "desired" },
              status: "satisfied",
              reason: "capability is usable",
              evidence: ["ev_receipt_1"],
            },
          ],
          evidence: MATCH_EVIDENCE(),
        }),
      ],
    });
    const a = mk(["ev_a", "ev_b"]);
    const b = mk(["ev_b", "ev_a"]);
    // Set-like normalization: identical artifact digests...
    const builtA = buildDiscoverNetworksResult(a, FULL_CTX(snap));
    const builtB = buildDiscoverNetworksResult(b, FULL_CTX(snap));
    expect(builtA.artifactDigest).toBe(builtB.artifactDigest);
    // ...and both re-verify against the same normalized projection.
    expect(verifyDiscoverNetworksResult(builtA, FULL_CTX(snap))).toBe(true);
    expect(verifyDiscoverNetworksResult(builtB, FULL_CTX(snap))).toBe(true);
  });

  it("FREEZE-FINAL NORMALIZATION: a PERMUTATION OF EVALUATIONS keeps digest AND verification identical; genuine disagreement still fails", () => {
    const snap = buildCapabilitySnapshot(
      {
        ...validCapabilitySnapshotContent(),
        id: "capsnap_ord",
        evidenceCapabilities: {
          execution: { support: "supported", availability: "available", evidence: ["ev_receipt_1"] },
          observedEffects: { support: "supported", availability: "available", evidence: ["ev_receipt_1"] },
          dataBinding: { support: "unsupported", availability: "unavailable" },
          settlement: { support: "unsupported", availability: "unavailable" },
          finality: { support: "unknown", availability: "unknown" },
        },
        executionCapabilities: {},
        evidence: [evidenceRef()],
      },
      { resolver: fullManifest(), networkId: NETWORK },
    );
    const multiReq = discoveryRequirements({
      requirements: [
        { capability: "execution", strength: "required" },
        { capability: "observedEffects", strength: "desired" },
      ],
    });
    const evalExec: import("../src/index.js").RequirementEvaluation = {
      requirement: { capability: "execution", strength: "required" },
      status: "satisfied",
      reason: "capability is usable",
      evidence: ["ev_receipt_1"],
    };
    const evalObs: import("../src/index.js").RequirementEvaluation = {
      requirement: { capability: "observedEffects", strength: "desired" },
      status: "satisfied",
      reason: "capability is usable",
      evidence: ["ev_receipt_1"],
    };
    const mkOrdered = (evaluations: [typeof evalExec, typeof evalObs]) => ({
      schemaVersion: "0.1" as const,
      requestId: "disc_order",
      generatedAt: "2026-01-01T00:00:00.000Z",
      request: multiReq,
      matches: [
        discoveryMatch({
          capabilitySnapshot: { id: snap.id, digest: snap.artifactDigest },
          evaluations,
          evidence: [evidenceRef()],
        }),
      ],
    });
    const inOrder = mkOrdered([evalExec, evalObs]);
    const permuted = mkOrdered([evalObs, evalExec]);
    // ONE normalized semantic projection: same digest...
    const builtInOrder = buildDiscoverNetworksResult(inOrder, FULL_CTX(snap));
    const builtPermuted = buildDiscoverNetworksResult(permuted, FULL_CTX(snap));
    expect(builtInOrder.artifactDigest).toBe(builtPermuted.artifactDigest);
    // ...and IDENTICAL contextual verification for both orders.
    expect(verifyDiscoverNetworksResult(builtInOrder, FULL_CTX(snap))).toBe(true);
    expect(verifyDiscoverNetworksResult(builtPermuted, FULL_CTX(snap))).toBe(true);

    // A forged `reason` under an otherwise identical projection is
    // REJECTED (reason is normative deterministic composer output).
    const forgedReason = mkOrdered([evalExec, { ...evalObs, reason: "trust me" }]);
    expect(() => buildDiscoverNetworksResult(forgedReason, FULL_CTX(snap))).toThrow(
      /disagree with the normative composer/,
    );
    // An altered status likewise.
    const alteredStatus = mkOrdered([
      evalExec,
      { ...evalObs, status: "unknown" as const, reason: "capability is not provably usable (unsupported-by-evidence or undetermined)" },
    ]);
    expect(() => buildDiscoverNetworksResult(alteredStatus, FULL_CTX(snap))).toThrow(
      /disagree with the normative composer|1:1|duplicate/,
    );

    // A DUPLICATE evaluation identity cannot enter the set-like collection
    // (the per-match validator rejects it before any other comparison).
    const duplicated = {
      schemaVersion: "0.1" as const,
      requestId: "disc_dup",
      generatedAt: "2026-01-01T00:00:00.000Z",
      request: multiReq,
      matches: [
        discoveryMatch({
          capabilitySnapshot: { id: snap.id, digest: snap.artifactDigest },
          evaluations: [evalExec, { ...evalExec }],
          evidence: [evidenceRef()],
        }),
      ],
    };
    expect(() => buildDiscoverNetworksResult(duplicated, FULL_CTX(snap))).toThrow(
      /duplicate evaluation/,
    );
  });

  it("same EvidenceId with replaced locator/contentDigest/sourceId/retrievedAt/metadata is rejected (closure)", () => {
    for (const mutation of [
      { locator: "replaced" },
      { contentDigest: `sha256:${"99".repeat(32)}` },
      { retrievedAt: "2031-01-01T00:00:00.000Z" as const },
      { sourceId: "src.replaced" },
      { metadata: { replaced: true } },
      { independenceGroup: "new-group" },
    ]) {
      const { snap } = world();
      const content = discoveryContent(snap, {
        evidence: [evidenceRef(mutation)],
      });
      expect(() => buildDiscoverNetworksResult(content, FULL_CTX(snap))).toThrow(
        new RegExp('differs from the snapshot'),
      );
    }
  });

  it("match.network must be canonically equal to snapshot.network (full fingerprint equality)", () => {
    const { snap } = world();
    const content = discoveryContent(snap, {
      // same networkId, DIFFERENT fingerprint body
      network: fingerprint({ chainId: 9999 }),
    });
    expect(() => buildDiscoverNetworksResult(content, FULL_CTX(snap))).toThrow(/fingerprint/i);
  });

  it("composer rejects supported/conditional claims absent from manifest.supportedCapabilities", () => {
    // Snapshot legitimately built against an EXTENDED manifest that lists
    // settlement; verifying/composing against the RESTRICTED manifest fails.
    const extendedManifest = {
      ...fullManifest(),
      supportedCapabilities: [...fullManifest().supportedCapabilities, "settlement" as const],
      digest: "",
    };
    extendedManifest.digest = computeResolverManifestDigest(extendedManifest);
    const rogue = buildCapabilitySnapshot(
      {
        ...validCapabilitySnapshotContent(),
        id: "capsnap_extended",
        resolver: {
          id: extendedManifest.id,
          version: extendedManifest.version,
          digest: extendedManifest.digest,
        },
        evidenceCapabilities: {
          execution: { support: "supported", availability: "available", evidence: ["ev_receipt_1"] },
          observedEffects: { support: "supported", availability: "available", evidence: ["ev_receipt_1"] },
          dataBinding: { support: "unsupported", availability: "unavailable" },
          settlement: { support: "supported", availability: "available", evidence: ["ev_receipt_1"] },
          finality: { support: "unknown", availability: "unknown" },
        },
        executionCapabilities: {},
      },
      { resolver: extendedManifest, networkId: NETWORK },
    );
    expect(() =>
      composeDiscoveryMatch(discoveryRequirements(), {
        network: fingerprint(),
        snapshot: rogue,
        resolver: fullManifest(), // RESTRICTED manifest
      }),
    ).toThrow(/does not list it under supportedCapabilities|does not exactly match/);
  });
});

describe("R3 HARDENING", () => {
  it("constructor getter on the prototype is NEVER invoked by canonical rejection", () => {
    let invocations = 0;
    class Hostile {}
    Object.defineProperty(Hostile.prototype, "constructor", {
      get() {
        invocations += 1;
        return function Evil() {};
      },
      configurable: true,
    });
    const hostile = Object.create(Hostile.prototype) as object;
    expect(() => canonicalJson(hostile)).toThrow(NecCanonicalizationError);
    // The rejection message must be generic (no prototype-derived naming).
    let message = "";
    try {
      canonicalJson(hostile);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain("Evil");
    expect(invocations).toBe(0);
  });

  it("parser enforces MAX_CONTAINER_ENTRIES DURING parsing: 10_000 OK, 10_001 rejected while parsing", () => {
    const ok = `{${Array.from({ length: RESOURCE_LIMITS.MAX_CONTAINER_ENTRIES }, (_, i) => `"k${i}":${i}`).join(",")}}`;
    expect(Object.keys(parseNecWireJson(ok) as object)).toHaveLength(
      RESOURCE_LIMITS.MAX_CONTAINER_ENTRIES,
    );
    const over = `{${Array.from({ length: RESOURCE_LIMITS.MAX_CONTAINER_ENTRIES + 1 }, (_, i) => `"k${i}":${i}`).join(",")}}`;
    expect(() => parseNecWireJson(over)).toThrow(NecWireError);
    expect(() => parseNecWireJson(over)).toThrow(/MAX_CONTAINER_ENTRIES/);
  }, 30_000);

  it("parser enforces MAX_DEPTH and MAX_TOTAL_NODES during parsing", () => {
    let deep = "x";
    for (let i = 0; i < RESOURCE_LIMITS.MAX_DEPTH + 2; i++) deep = `[${deep}]`;
    expect(() => parseNecWireJson(deep)).toThrow(NecWireError);
    // Many SMALL containers: each stays far under the per-container bound
    // while the TOTAL node count blows past MAX_TOTAL_NODES during parsing.
    const inner = JSON.stringify([0, 0, 0, 0, 0, 0, 0, 0]); // 9 nodes
    const wide = `[${new Array(6_000).fill(inner).join(",")}]`; // ~54_001 nodes
    expect(() => parseNecWireJson(wide)).toThrow(NecWireError);
    expect(() => parseNecWireJson(wide)).toThrow(/MAX_TOTAL_NODES/);
  }, 30_000);

  it("parser enforces the string UTF-8 byte budget during parsing (exact boundary)", () => {
    const limit = RESOURCE_LIMITS.MAX_STRING_UTF8_BYTES;
    expect(() => parseNecWireJson(`"${"a".repeat(limit)}"`)).not.toThrow();
    expect(() => parseNecWireJson(`"${"a".repeat(limit + 1)}"`)).toThrow(/MAX_STRING_UTF8_BYTES/);
    // UTF-8 bytes, not code units: é costs two bytes.
    expect(() => parseNecWireJson(`"${"é".repeat(limit / 2 + 1)}"`)).toThrow(
      /MAX_STRING_UTF8_BYTES/,
    );
    expect(() => parseNecWireJson(`"${"é".repeat(limit / 2 - 2)}"`)).not.toThrow();
  }, 30_000);

  it("network allow/deny entries are validated as NetworkIds (not loose strings)", () => {
    // Every entry goes through the SPECIALIZED NetworkId validator
    // (`assertNetworkId`: <=128 UTF-8 bytes, well-formed, no leading/
    // trailing whitespace) — not a looser generic string check.
    for (const bad of ["", " lead", "trail ", "\u0007bell", "x".repeat(129), "\ud800"]) {
      expect(() =>
        validateDiscoveryRequirements({
          requirements: [{ capability: "execution", strength: "required" }],
          networkAllowlist: [NETWORK, bad],
        }),
      ).toThrow(NecValidationError);
      expect(() =>
        validateDiscoveryRequirements({
          requirements: [{ capability: "execution", strength: "required" }],
          networkDenylist: [bad],
        }),
      ).toThrow(NecValidationError);
    }
    expect(() =>
      validateDiscoveryRequirements({
        requirements: [{ capability: "execution", strength: "required" }],
        networkAllowlist: [NETWORK],
        networkDenylist: ["eip155:1"],
      }),
    ).not.toThrow();
  });
});
