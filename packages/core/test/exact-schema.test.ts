import { describe, expect, it } from "vitest";

import {
  buildCapabilitySnapshot,
  buildDiscoverNetworksResult,
  buildEvidenceSnapshot,
  buildNetworkEvidenceResult,
  buildPreflightResult,
  NecValidationError,
  validateCapabilityRequirement,
  validateCapabilitySnapshot,
  validateCapabilityState,
  validateConflict,
  validateDiscoveryRequirements,
  validateEvidenceAnchor,
  validateEvidenceDimension,
  validateEvidencePolicy,
  validateEvidenceRef,
  validateEvidenceRequest,
  validateEvidenceSnapshot,
  validateNativeSourcePayload,
  validateNetworkAnchor,
  validateNetworkDiscoveryMatch,
  validateNetworkEvidenceFragment,
  validateNetworkEvidenceResult,
  validateNetworkFingerprint,
  validateObservedEffect,
  validatePreflightFragment,
  validatePreflightRequest,
  validatePreflightResult,
  validateReadinessCheck,
  validateRequirementEvaluation,
  validateResolverContext,
  validateResolverManifest,
  validateResolverManifestRef,
  validateSubjectRef,
  validateWarning,
} from "../src/index.js";
import type { EvidenceRef, NetworkFingerprint, ResolverManifest, SubjectRef } from "../src/index.js";
import {
  conflict as mkConflict,
  dimension,
  evidenceRequestContent,
  discoveryMatch,
  discoveryRequirements,
  effect,
  evidenceRef,
  fingerprint,
  fullManifest,
  fullPolicy,
  fullSnapshot,
  preflightContext,
  preflightRequestContent,
  resultContext,
  snapshotContent,
  subject,
  validCapabilitySnapshotContent,
  validPreflightResultContent,
  validResultContent,
  warn,
} from "./fixtures.js";

/**
 * DECISION: complete public runtime validation. Every public v0.1 data
 * contract has a validator that accepts `unknown`, enforces the exact field
 * set (required + optional + no unknown), canonical values and bounded
 * resources. TypeScript types are never the only assurance.
 */

function withExtra<T extends object>(obj: T, key: string, value: unknown = 1): T {
  return Object.assign({ ...(obj as Record<string, unknown>) }, { [key]: value }) as unknown as T;
}

function defineGetter(obj: object, key: string, onRead: () => unknown): void {
  Object.defineProperty(obj, key, {
    enumerable: true,
    configurable: true,
    get: onRead,
  });
}

const manifest: ResolverManifest = fullManifest();

describe("every public contract validator accepts unknown and validates", () => {
  it("positive controls pass for clean fixtures", async () => {
    expect(() => validateNetworkFingerprint(fingerprint())).not.toThrow();
    expect(() => validateNetworkAnchor({ blockNumber: 1n }, "anchor")).not.toThrow();
    expect(() => validateEvidenceRef(evidenceRef())).not.toThrow();
    expect(() => validateEvidenceDimension(dimension({ applicability: "unknown" }))).not.toThrow();
    expect(() =>
      validateEvidenceDimension({
        applicability: "applicable",
        verdict: "supported",
        basis: ["source_observation"],
        evidence: ["ev_receipt_1"],
      }),
    ).not.toThrow();
    expect(() => validateObservedEffect(effect())).not.toThrow();
    expect(() => validateSubjectRef(subject())).not.toThrow();
    expect(() => validateSubjectRef({ type: "block", networkId: "n" })).not.toThrow();
    expect(() => validateSubjectRef({ type: "batch", networkId: "n", batchId: "b" })).not.toThrow();
    expect(() =>
      validateSubjectRef({ type: "custom", networkId: "n", namespace: "ns", value: "v" }),
    ).not.toThrow();
    expect(() =>
      validateResolverManifestRef({ id: "r", version: "1", digest: manifest.digest }),
    ).not.toThrow();
    expect(() => validateResolverManifest(manifest)).not.toThrow();
    expect(() =>
      validateCapabilityState({ support: "supported", availability: "available" }, "cap"),
    ).not.toThrow();
    expect(() => validateConflict(mkConflict())).not.toThrow();
    expect(() => validateWarning(warn())).not.toThrow();
    expect(() => validateEvidenceAnchor(fullSnapshot().anchors[0]!, "anchor")).not.toThrow();
    expect(() => validateEvidenceSnapshot(fullSnapshot())).not.toThrow();
    expect(() => validateEvidencePolicy(fullPolicy())).not.toThrow();
    expect(() => validateCapabilityRequirement({ capability: "execution", strength: "required" })).not.toThrow();
    expect(() => validateDiscoveryRequirements(discoveryRequirements())).not.toThrow();
    expect(() => validateNetworkDiscoveryMatch(discoveryMatch())).not.toThrow();
    expect(() =>
      validateRequirementEvaluation({
        requirement: { capability: "execution", strength: "required" },
        status: "satisfied",
      }),
    ).not.toThrow();
    // Coherent discovery world: builders REQUIRE complete context and
    // re-verify every claim against it, so the control binds the REAL
    // snapshot whose execution state is usable (composer agreement).
    const discSnap = buildCapabilitySnapshot(
      {
        ...validCapabilitySnapshotContent(),
        id: "capsnap_exact",
        evidenceCapabilities: {
          execution: { support: "supported", availability: "available", evidence: ["ev_receipt_1"] },
          observedEffects: { support: "supported", availability: "available", evidence: ["ev_receipt_1"] },
          dataBinding: { support: "unsupported", availability: "unavailable" },
          settlement: { support: "unsupported", availability: "unavailable" },
          finality: { support: "unknown", availability: "unknown" },
        },
        executionCapabilities: {},
      },
      { resolver: fullManifest(), networkId: fingerprint().networkId },
    );
    expect(() => buildDiscoverNetworksResult({
      schemaVersion: "0.1",
      requestId: "r1",
      generatedAt: "2026-01-01T00:00:00.000Z",
      request: discoveryRequirements(),
      matches: [
        discoveryMatch({
          capabilitySnapshot: { id: discSnap.id, digest: discSnap.artifactDigest },
        }),
      ],
    }, {
      capabilitySnapshots: [discSnap],
      resolverManifests: [fullManifest()],
    })).not.toThrow();
    expect(() => validatePreflightRequest(preflightRequestContent())).not.toThrow();
    expect(() => validateReadinessCheck({ status: "ready" }, "check")).not.toThrow();
    expect(() => validatePreflightResult(buildPreflightResult(validPreflightResultContent(), preflightContext()))).not.toThrow();
    expect(() => validateCapabilitySnapshot(buildCapabilitySnapshot(validCapabilitySnapshotContent(), { resolver: manifest, networkId: fingerprint().networkId }))).not.toThrow();
    expect(() => validateResolverContext({ now: "2026-01-01T00:00:00.000Z", sourceConfig: {} })).not.toThrow();
    const { nativeSourceContentDigest } = await import("../src/index.js");
    expect(() =>
      validateNativeSourcePayload({
        namespace: "a.b",
        mediaType: "application/json",
        encoding: "base64",
        payload: "",
        contentDigest: nativeSourceContentDigest(new Uint8Array(0)),
      }),
    ).not.toThrow();
  });

  it("rejects primitives/null outright", () => {
    for (const validator of [
      validateNetworkFingerprint,
      validateEvidenceRef,
      validateEvidenceDimension,
      validateObservedEffect,
      validateSubjectRef,
      validateResolverManifestRef,
      validateResolverManifest,
      validateConflict,
      validateWarning,
      validateEvidenceSnapshot,
      validateEvidencePolicy,
      validatePreflightRequest,
      validatePreflightResult,
      validateCapabilitySnapshot,
      validateDiscoveryRequirements,
      validateNetworkDiscoveryMatch,
      validateEvidenceRequest,
      validateResolverContext,
      validatePreflightFragment,
      validateNetworkEvidenceFragment,
    ]) {
      for (const bad of [undefined, null, 42, "x", true, [], Symbol("s")]) {
        let threw = false;
        try {
          validator(bad as never);
        } catch (e) {
          threw = e instanceof NecValidationError;
        }
        expect(threw, `${validator.name} accepted ${String(bad)}`).toBe(true);
      }
    }
  });

  it("rejects unknown fields on every audited contract structure", () => {
    expect(() => validateNetworkFingerprint(withExtra(fingerprint(), "rogue"))).toThrow(/unknown field/);
    expect(() =>
      validateNetworkAnchor(withExtra({ blockNumber: 1n }, "rogue"), "anchor"),
    ).toThrow(/unknown field/);
    expect(() => validateEvidenceRef(withExtra(evidenceRef(), "rogue"))).toThrow(/unknown field/);
    expect(() =>
      validateEvidenceDimension(withExtra(dimension({ applicability: "unknown" }), "rogue")),
    ).toThrow(/unknown field/);
    expect(() => validateObservedEffect(withExtra(effect(), "rogue"))).toThrow(/unknown field/);
    expect(() => validateSubjectRef(withExtra(subject(), "rogue"))).toThrow(/unknown field/);
    expect(() =>
      validateSubjectRef(withExtra({ type: "block", networkId: "n" } as SubjectRef, "rogue")),
    ).toThrow(/unknown field/);
    expect(() =>
      validateResolverManifestRef(withExtra({ id: "r", version: "1", digest: manifest.digest }, "rogue")),
    ).toThrow(/unknown field/);
    expect(() => validateResolverManifest(withExtra(manifest, "rogue"))).toThrow(/unknown field/);
    expect(() =>
      validateCapabilityState(
        withExtra({ support: "supported", availability: "available" }, "rogue"),
        "cap",
      ),
    ).toThrow(/unknown field/);
    expect(() => validateConflict(withExtra(mkConflict(), "rogue"))).toThrow(/unknown field/);
    expect(() => validateWarning(withExtra(warn(), "rogue"))).toThrow(/unknown field/);
    expect(() => validateEvidenceAnchor(withExtra(fullSnapshot().anchors[0]!, "rogue"), "anchor")).toThrow(
      /unknown field/,
    );
    expect(() =>
      validateEvidencePolicy(withExtra({ ...fullPolicy(), digest: fullPolicy().digest }, "rogue")),
    ).toThrow(/unknown field/);
    expect(() => validateCapabilitySnapshot(buildCapabilitySnapshot(validCapabilitySnapshotContent(), { resolver: manifest, networkId: fingerprint().networkId }) as never)).not.toThrow();
    const capsnapWithRogue = validCapabilitySnapshotContent() as Record<string, unknown>;
    capsnapWithRogue.rogue = 1;
    expect(() =>
      buildCapabilitySnapshot(capsnapWithRogue as never, {
        resolver: manifest,
        networkId: fingerprint().networkId,
      }),
    ).toThrow(NecValidationError);
    expect(() =>
      validateDiscoveryRequirements(withExtra(discoveryRequirements(), "rogue")),
    ).toThrow(/unknown field/);
    expect(() => validateNetworkDiscoveryMatch(withExtra(discoveryMatch(), "rogue"))).toThrow(/unknown field/);
    expect(() =>
      validatePreflightRequest(withExtra(preflightRequestContent(), "rogue")),
    ).toThrow(/unknown field/);
    expect(() => validateReadinessCheck(withExtra({ status: "ready" }, "rogue"), "check")).toThrow(
      /unknown field/,
    );
    expect(() =>
      validatePreflightResult(
        withExtra(buildPreflightResult(validPreflightResultContent(), preflightContext()), "rogue") as never,
      ),
    ).toThrow(/unknown field/);
    const built = buildNetworkEvidenceResult(validResultContent(), resultContext());
    expect(() => validateNetworkEvidenceResult(withExtra(built, "rogue"))).toThrow(/unknown field/);
  });

  it("rejects explicitly-undefined optional fields everywhere", async () => {
    const { validateWarning } = await import("../src/index.js");
    expect(() => validateWarning({ code: "W", message: "m", evidence: undefined }, "w")).toThrow(
      /explicitly-undefined/,
    );
    const content = validResultContent();
    (content.evidence[0] as unknown as Record<string, unknown>).independenceGroup = undefined;
    expect(() =>
      buildNetworkEvidenceResult(content, resultContext()),
    ).toThrow(/independenceGroup: explicitly-undefined field/);
  });

  it("rejects missing required fields with precise paths", () => {
    const noBasis = { applicability: "applicable" } as never;
    expect(() => validateEvidenceDimension(noBasis)).toThrow(/missing required field "basis"/);

    const noObservedAt = { networkId: "eip155:1" } as never;
    expect(() => validateNetworkFingerprint(noObservedAt)).toThrow(
      /missing required field "observedAt"/,
    );
  });

  it("rejects accessors, symbols and hidden properties without executing getters", () => {
    let invocations = 0;
    const ref = evidenceRef() as object;
    defineGetter(ref, "smuggled", () => {
      invocations += 1;
      return 0.99;
    });
    expect(() => validateEvidenceRef(ref as EvidenceRef)).toThrow(/accessor/);
    expect(invocations).toBe(0);

    const symRef = evidenceRef() as unknown as Record<PropertyKey, unknown>;
    symRef[Symbol("s")] = "payload";
    expect(() => validateEvidenceRef(symRef as never)).toThrow(/symbol-keyed/);

    const hidden = evidenceRef();
    Object.defineProperty(hidden, "hidden", { value: "x", enumerable: false, configurable: true });
    expect(() => validateEvidenceRef(hidden)).toThrow(/non-enumerable/);
  });

  it("metadata remains the explicit extension point", async () => {
    const content = { ...validResultContent() };
    const enrichedRef = evidenceRef({ metadata: { vendorExtension: { any: ["shape", 1] } } });
    content.evidence = [enrichedRef];
    // Snapshot/result closure: snapshot binds the same enriched ref.
    const snapshot = buildEvidenceSnapshot({
      ...snapshotContent(),
      evidence: [structuredClone(enrichedRef)],
    });
    content.snapshot = { id: snapshot.id, digest: snapshot.digest };
    expect(() =>
      buildNetworkEvidenceResult(content, {
        policy: fullPolicy(),
        snapshot,
        resolver: fullManifest(),
        request: evidenceRequestContent(),
      }),
    ).not.toThrow();

  });

  it("EvidenceRequest binds subject+policy deterministically; preflight ref is digest-qualified", async () => {
    const { validateEvidenceRequest } = await import("../src/index.js");
    const ok = {
      schemaVersion: "0.1",
      requestId: "req_1",
      networkId: "eip155:8453",
      subject: subject(),
      action: { kind: "erc20.transfer", target: `0x${"aa".repeat(20)}`, value: "0" },
      evidencePolicy: fullPolicy(),
      preflight: { requestId: "pf_req_1", digest: `sha256:${"aa".repeat(32)}` },
    };
    expect(() => validateEvidenceRequest(ok)).not.toThrow();

    const wrongNetwork = { ...ok, subject: { ...subject(), networkId: "eip155:1" } };
    expect(() => validateEvidenceRequest(wrongNetwork)).toThrow(/deterministic binding/);

    const bareDigest = { ...ok, preflight: `sha256:${"aa".repeat(32)}` };
    expect(() => validateEvidenceRequest(bareDigest as never)).toThrow(NecValidationError);

    const noRequestId = { ...ok } as Record<string, unknown>;
    delete noRequestId.requestId;
    expect(() => validateEvidenceRequest(noRequestId)).toThrow(/missing required field "requestId"/);
  });

  it("class instances posing as contract objects fail validation, not canonicalization", () => {
    class FakeFingerprint {
      networkId = "eip155:8453";
      observedAt = {};
    }
    const content = validResultContent();
    content.network = new FakeFingerprint() as unknown as NetworkFingerprint;
    expect(() =>
      buildNetworkEvidenceResult(content, resultContext()),
    ).toThrow(/must be a plain object/);
  });
});
