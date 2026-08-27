import { describe, expect, it } from "vitest";

import {
  buildEvidenceSnapshot,
  buildNetworkEvidenceResult,
  buildPreflightResult,
  canonicalJson,
  computeDiscoverNetworksResultDigest,
  computeEvidencePolicyDigest,
  computeNetworkEvidenceResultSemanticDigest,
  decodeBase64Strict,
  decodeNecWireJson,
  deepFreeze,
  encodeNecWireJson,
  mergeConflicts,
  mergeWarnings,
  NecCanonicalizationError,
  NecValidationError,
  NecWireError,
  parseNecWireJson,
  RESOURCE_LIMITS,
  validateDiscoveryRequirements,
  validateEvidenceSnapshot,
  validateNetworkEvidenceFragment,
  validatePreflightFragment,
  verifyNetworkEvidenceResultSemantics,
} from "../src/index.js";
import type { EvidenceSnapshot, PreflightResult } from "../src/index.js";
import {
  discoveryRequirements,
  evidenceRequestContent,
  evidenceRef,
  fingerprint,
  fullManifest,
  fullPolicy,
  fullSnapshot,
  NETWORK,
  preflightContext,
  snapshotContent,
  validPreflightResultContent,
  validResultContent,
} from "./fixtures.js";

/**
 * R2 / PHASE A remediation regressions. Each block pins one reproduced
 * finding so it cannot silently return:
 *
 *   1. inert arrays (one descriptor-first data model everywhere),
 *   2. defensive cloning / caller ownership,
 *   3. wire magic keys + round-trip stability,
 *   4. resource bounds at every entry point,
 *   5. bigint decimal-digit domain symmetry,
 *   6. snapshot/result EvidenceRef closure,
 *   7. fragment validation hardening,
 *   8. nested set normalization before outer ordering/digests,
 *   9. semantic verification validates the artifact first,
 *  10. warning/conflict citation-permutation identity.
 */

const ctx = () => ({
  policy: fullPolicy(),
  snapshot: fullSnapshot(),
  resolver: fullManifest(),
  request: evidenceRequestContent(),
});

/** Snapshot binding exactly `refs` as its evidence table (closure helper). */
function snapshotWith(refs: unknown[]): EvidenceSnapshot {
  return buildEvidenceSnapshot({
    ...snapshotContent(),
    evidence: refs.map((ref) => structuredClone(ref)) as never,
  });
}

function resultOverSnapshot(
  content: ReturnType<typeof validResultContent>,
  snapshot: EvidenceSnapshot,
) {
  content.snapshot = { id: snapshot.id, digest: snapshot.digest };
  return { content, context: { ...ctx(), snapshot } };
}

// ---------------------------------------------------------------------------
// 1. Inert arrays
// ---------------------------------------------------------------------------

describe("hardening: inert arrays — one consistent data model", () => {
  it("indexed evidence + malicious iterator yielding nothing cannot hash as []", () => {
    // Real Array subclass instance; default iterator intact, entries()
    // overridden to yield nothing — the pre-fix validator saw an empty
    // table while digests still bound the element behind index 0.
    class Evil extends Array {}
    const ghost = evidenceRef({ id: "ev_ghost", retrievedAt: "yesterday" as never });
    const evil = Reflect.construct(Array, [ghost], Evil) as unknown[];
    Object.defineProperty(Evil.prototype, "entries", {
      value: function* () {},
      configurable: true,
      writable: true,
    });
    expect(() =>
      validateEvidenceSnapshot({ ...fullSnapshot(), evidence: evil } as never),
    ).toThrow(NecValidationError);
    // Digest normalization fails closed on non-inert arrays too.
    expect(() =>
      buildEvidenceSnapshot({ ...snapshotContent(), evidence: evil as never }),
    ).toThrow(NecValidationError);
  });

  it("an own Symbol.iterator override on an array fails closed", () => {
    const arr: unknown[] = [evidenceRef()];
    Object.defineProperty(arr, Symbol.iterator, {
      value: function* () {},
      configurable: true,
      enumerable: false,
      writable: true,
    });
    expect(() =>
      validateEvidenceSnapshot({ ...fullSnapshot(), evidence: arr } as never),
    ).toThrow(/symbol-keyed array properties/);
    // Canonicalization rejects it with the CONTROLLED canonicalization
    // error class (never a generic Error).
    expect(() => canonicalJson(arr)).toThrow(NecCanonicalizationError);
  });

  it("extra own array properties never survive into a digest or a builder graph", () => {
    const arr: unknown[] = [structuredClone(validResultContent().evidence[0]!)];
    (arr as unknown as Record<string, unknown>).extra = "smuggled";
    // Builder path.
    const content = validResultContent();
    content.evidence = structuredClone(arr) as never;
    expect(() => buildNetworkEvidenceResult(content, ctx())).toThrow(/extra own properties/);
    // Direct validator path.
    expect(() =>
      validateEvidenceSnapshot({ ...fullSnapshot(), evidence: arr } as never),
    ).toThrow(/extra own properties/);
  });

  it("array index getters are never invoked by validation or digest normalization", () => {
    let invocations = 0;
    const arr: unknown[] = [];
    Object.defineProperty(arr, 0, {
      enumerable: true,
      configurable: true,
      get() {
        invocations += 1;
        return evidenceRef();
      },
    });
    arr.length = 1;
    expect(() =>
      validateEvidenceSnapshot({ ...fullSnapshot(), evidence: arr } as never),
    ).toThrow(NecValidationError);
    expect(invocations).toBe(0);
  });

  it("sparse contract arrays fail closed", () => {
    const arr: unknown[] = [evidenceRef()];
    arr.length = 3;
    expect(() =>
      validateEvidenceSnapshot({ ...fullSnapshot(), evidence: arr } as never),
    ).toThrow(/sparse\/holey/);
  });

  it("Array subclasses fail closed BECAUSE of the subclass prototype (elements are otherwise valid)", () => {
    class Fake extends Array {}
    // Every ELEMENT is a fully valid EvidenceRef and the container key is a
    // legitimate contract field (`evidence`) — the ONLY possible rejection
    // cause is the Array-subclass prototype itself.
    const subclassedEvidence = Fake.from([
      evidenceRef(),
      evidenceRef({ id: "ev_two", sourceId: "src.two" }),
    ]) as unknown[];
    expect(Array.isArray(subclassedEvidence)).toBe(true);
    let message = "";
    try {
      // A COMPLETE valid snapshot whose only deviation is the subclassed
      // evidence container (structure is checked before the self-digest).
      validateEvidenceSnapshot({ ...fullSnapshot(), evidence: subclassedEvidence } as never);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("prototype");
    expect(message).toContain("Array.prototype");
    // Same rejection through canonicalization.
    expect(() => canonicalJson(subclassedEvidence)).toThrow(/prototype/);
  });

  it("public validators reject arrays beyond MAX_CONTAINER_ENTRIES (10_000 / 10_001)", () => {
    expect(RESOURCE_LIMITS.MAX_CONTAINER_ENTRIES).toBe(10_000);
    // R3: CapabilityRequirement has NO constraints field anymore, so
    // requirement entries cannot be individually uniquified beyond the 20
    // closed-vocabulary combinations — but the CONTAINER bound still fires
    // first (inert-array check precedes duplicate detection).
    const reqs = Array.from({ length: 10_001 }, (_, i) => ({
      capability: "execution" as const,
      strength: "required" as const,
    }));
    expect(() => validateDiscoveryRequirements({ requirements: reqs })).toThrow(
      /MAX_CONTAINER_ENTRIES/,
    );
  }, 20_000);

  it("exactly MAX_CONTAINER_ENTRIES set-like entries remain acceptable (flat scalar container)", () => {
    // A single flat container at the exact announced bound stays acceptable
    // through public validation (nested artifacts would hit
    // MAX_TOTAL_NODES first — each entry there costs several nodes).
    const flat = Array.from({ length: RESOURCE_LIMITS.MAX_CONTAINER_ENTRIES }, (_, i) => i);
    expect(() =>
      buildEvidenceSnapshot({
        ...snapshotContent(),
        evidence: [evidenceRef({ id: "ev_flat", metadata: { flat } })],
      }),
    ).not.toThrow();
    const over = Array.from({ length: RESOURCE_LIMITS.MAX_CONTAINER_ENTRIES + 1 }, (_, i) => i);
    expect(() =>
      validateEvidenceSnapshot({
        ...fullSnapshot(),
        evidence: [evidenceRef({ id: "ev_flat", metadata: { over } })],
      } as never),
    ).toThrow(/MAX_CONTAINER_ENTRIES/);
  }, 60_000);

  it("frozen ordinary dense arrays remain acceptable (standard frozen state)", () => {
    expect(canonicalJson(Object.freeze([1, 2, 3]))).toBe("[1,2,3]");
  });
});

// ---------------------------------------------------------------------------
// 2. Defensive clone / caller ownership
// ---------------------------------------------------------------------------

describe("hardening: defensive clone and caller ownership", () => {
  it("a custom-prototype ROOT with getters is rejected BEFORE any getter runs", () => {
    let invocations = 0;
    const inner = validResultContent() as Record<string, unknown>;
    class Root {}
    const root: Record<string, unknown> = Object.create(Root.prototype);
    for (const key of Object.keys(inner)) root[key] = inner[key];
    Object.defineProperty(root, "requestId", {
      enumerable: true,
      configurable: true,
      get() {
        invocations += 1;
        return "req_1";
      },
    });
    expect(() => buildNetworkEvidenceResult(root as never, ctx())).toThrow(
      /root object must be a plain object/,
    );
    expect(invocations).toBe(0);
  });

  it("nested caller-owned objects stay unfrozen; frozen graphs contain only fresh containers", () => {
    const content = validResultContent();
    const myMetadata = { note: "mine" };
    const enriched = evidenceRef({ metadata: structuredClone(myMetadata) });
    const snapshot = snapshotWith([enriched]);
    (content.evidence[0] as { metadata?: Record<string, unknown> }).metadata = myMetadata;
    const { content: prepared, context } = resultOverSnapshot(content, snapshot);

    const built = buildNetworkEvidenceResult(prepared, context);
    expect(
      Object.isFrozen((built.evidence[0] as { metadata?: Record<string, unknown> }).metadata),
    ).toBe(true);
    expect(Object.isFrozen(myMetadata)).toBe(false);
    myMetadata.note = "still mine";
    expect(myMetadata.note).toBe("still mine");
  });

  it('an ordinary own "__proto__" key remains DATA through the clone', () => {
    const meta: Record<string, unknown> = {};
    Object.defineProperty(meta, "__proto__", {
      value: "ordinary-data",
      enumerable: true,
      writable: true,
      configurable: true,
    });
    meta.regular = 1;
    const content = validResultContent();
    const enriched = evidenceRef({ metadata: meta });
    const snapshot = snapshotWith([enriched]);
    content.evidence = [enriched];
    const { content: prepared, context } = resultOverSnapshot(content, snapshot);
    const built = buildNetworkEvidenceResult(prepared, context);
    const clonedMeta = (built.evidence[0] as { metadata?: Record<string, unknown> }).metadata!;
    expect(Object.prototype.hasOwnProperty.call(clonedMeta, "__proto__")).toBe(true);
    expect(clonedMeta["__proto__"]).toBe("ordinary-data");
    expect(
      Object.getPrototypeOf(clonedMeta) === null ||
        Object.getPrototypeOf(clonedMeta) === Object.prototype,
    ).toBe(true);
    // No prototype pollution ever occurred.
    expect(({} as Record<string, unknown>).injected).toBeUndefined();
  });

  it("a 200+ deep input produces a controlled NEC error, not a RangeError", () => {
    let deep: unknown = { leaf: true };
    for (let i = 0; i < 200; i++) deep = { v: deep };
    const content = validResultContent();
    (content.evidence[0] as { metadata?: unknown }).metadata = { deep };
    try {
      buildNetworkEvidenceResult(content, ctx());
      throw new Error("expected rejection");
    } catch (e) {
      expect(e).toBeInstanceOf(NecValidationError);
      expect((e as Error).message).toContain("MAX_DEPTH");
    }
  });

  it("a very deep input NEVER reaches a RangeError through any builder traversal", () => {
    let deep: unknown = { leaf: true };
    for (let i = 0; i < 200_000; i++) deep = { v: deep };
    const content = validResultContent();
    (content.evidence[0] as { metadata?: unknown }).metadata = { deep };
    expect(() => buildNetworkEvidenceResult(content, ctx())).toThrow(NecValidationError);
  }, 30_000);

  it("deepFreeze is bounded: cycles and over-deep graphs fail closed", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => deepFreeze(cyclic)).toThrow(NecValidationError);
    let deep: unknown = 1;
    for (let i = 0; i < 500; i++) deep = { v: deep };
    expect(() => deepFreeze(deep)).toThrow(/MAX_DEPTH/);
  });

  it("documents the boundary: hostile transports hand over PARSED INERT DATA; live Proxy inspection is not claimed", () => {
    // NEC does NOT claim trap-free inspection of arbitrary Proxy objects:
    // exotic roots (including Proxy targets with custom prototypes) are
    // rejected outright, and the wire boundary deals in PARSED INERT DATA.
    class Exotic {}
    const proxiedExotic = new Proxy(new Exotic(), {});
    expect(() => buildNetworkEvidenceResult(proxiedExotic as never, ctx())).toThrow(
      /root object must be a plain object/,
    );
  });

  // -----------------------------------------------------------------------
  // FREEZE-FINAL: NO GETTER READ BEFORE THE DEFENSIVE CLONE.
  // Builders must validate/probe property DESCRIPTORS and clone into fresh
  // NEC-owned containers BEFORE any value is read — root or nested — so a
  // caller getter can never execute during rejection, digestion or
  // freezing, and no caller-owned graph ever becomes frozen.
  // -----------------------------------------------------------------------

  it("snapshot builder: ROOT getter invocation count == 0", () => {
    let invocations = 0;
    const content = snapshotContent() as unknown as Record<string, unknown>;
    const hostile: Record<string, unknown> = {};
    for (const key of Object.keys(content)) {
      const value = content[key];
      Object.defineProperty(hostile, key === "createdAt" ? "createdAtX" : key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    delete hostile.createdAtX;
    Object.defineProperty(hostile, "createdAt", {
      enumerable: true,
      configurable: true,
      get() {
        invocations += 1;
        return "2026-01-01T00:00:00.000Z";
      },
    });
    expect(() => buildEvidenceSnapshot(hostile as never)).toThrow(NecValidationError);
    expect(invocations).toBe(0);
  });

  it("snapshot builder: NESTED getter invocation count == 0; caller nested object stays UNFROZEN", () => {
    let nestedGetterRuns = 0;
    let rootGetterRuns = 0;
    const meta: Record<string, unknown> = {};
    Object.defineProperty(meta, "secret", {
      enumerable: true,
      configurable: true,
      get() {
        nestedGetterRuns += 1;
        return "boom";
      },
    });
    meta.safe = 1;
    const content = snapshotContent();
    content.networkFingerprint = fingerprint({
      metadata: meta,
    }) as typeof content.networkFingerprint;
    // Root-level accessor too: rejection must not read it either.
    const rootHostile = content as unknown as Record<string, unknown>;
    Object.defineProperty(rootHostile, "id", {
      enumerable: true,
      configurable: true,
      get() {
        rootGetterRuns += 1;
        return "snap_1";
      },
    });
    expect(() => buildEvidenceSnapshot(rootHostile as never)).toThrow(NecValidationError);
    expect(nestedGetterRuns).toBe(0);
    expect(rootGetterRuns).toBe(0);
    // The caller-owned metadata was rejected wholesale — nothing frozen.
    expect(Object.isFrozen(meta)).toBe(false);
    meta.safe = 2;
    expect(meta.safe).toBe(2);
  });

  it("preflight builder: a hostile accessor ANYWHERE in content fails CLOSED without executing (count == 0)", () => {
    let invocations = 0;
    const content = validPreflightResultContent() as unknown as Record<string, unknown>;
    const request = { ...(content.request as Record<string, unknown>) };
    Object.defineProperty(request, "networkId", {
      enumerable: true,
      configurable: true,
      get() {
        invocations += 1;
        return NETWORK;
      },
    });
    content.request = request;
    // The descriptor-first clone rejects the accessor BEFORE the status
    // composition (or anything else) reads through it.
    expect(() =>
      buildPreflightResult(content as never, {
        resolver: fullManifest(),
        capabilitySnapshot: preflightContext().capabilitySnapshot,
      }),
    ).toThrow(NecValidationError);
    try {
      buildPreflightResult(content as never, {
        resolver: fullManifest(),
        capabilitySnapshot: preflightContext().capabilitySnapshot,
      });
    } catch (error) {
      // Controlled NEC validation error — never a RangeError/TypeError
      // originating from user-defined behavior.
      expect(error).toBeInstanceOf(NecValidationError);
      expect((error as Error).message).toContain("accessor");
    }
    expect(invocations).toBe(0);
    // The caller-owned request object is not frozen by the builder.
    expect(Object.isFrozen(request)).toBe(false);
  });

  it("preflight builder: clean caller content clones BEFORE any read; caller objects stay UNFROZEN", () => {
    const content = validPreflightResultContent();
    const myBlockers = content.blockers;
    const built = buildPreflightResult(content, {
      resolver: fullManifest(),
      capabilitySnapshot: preflightContext().capabilitySnapshot,
    });
    expect(built.status).toBe("ready");
    expect(Object.isFrozen(myBlockers)).toBe(false);
  });

  it("preflight builder: a HOSTILE accessor in content fails with a CONTROLLED NEC error, count == 0", () => {
    let invocations = 0;
    const content = validPreflightResultContent() as unknown as Record<string, unknown>;
    Object.defineProperty(content, "blockers", {
      enumerable: true,
      configurable: true,
      get() {
        invocations += 1;
        return [];
      },
    });
    expect(() =>
      buildPreflightResult(content as never, {
        resolver: fullManifest(),
        capabilitySnapshot: preflightContext().capabilitySnapshot,
      }),
    ).toThrow(NecValidationError);
    try {
      buildPreflightResult(content as never, {
        resolver: fullManifest(),
        capabilitySnapshot: preflightContext().capabilitySnapshot,
      });
    } catch (error) {
      // Controlled NEC validation error — never a RangeError/TypeError
      // originating from user-defined behavior.
      expect(error).toBeInstanceOf(NecValidationError);
      expect((error as Error).message).toContain("accessor");
    }
    expect(invocations).toBe(0);
  });

  it("custom-prototype roots are rejected WITHOUT executing their getters (both builders)", () => {
    let invocations = 0;
    class Root {}
    const makeHostile = () => {
      const inner = snapshotContent() as unknown as Record<string, unknown>;
      const hostile = Object.create(Root.prototype) as Record<string, unknown>;
      for (const key of Object.keys(inner)) hostile[key] = inner[key];
      Object.defineProperty(hostile, "createdAt", {
        enumerable: true,
        configurable: true,
        get() {
          invocations += 1;
          return "2026-01-01T00:00:00.000Z";
        },
      });
      return hostile;
    };
    expect(() => buildEvidenceSnapshot(makeHostile() as never)).toThrow(/root object must be a plain object/);
    expect(() =>
      buildPreflightResult(makeHostile() as never, {
        resolver: fullManifest(),
        capabilitySnapshot: preflightContext().capabilitySnapshot,
      }),
    ).toThrow(/root object must be a plain object/);
    expect(invocations).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Wire magic keys + round-trip stability
// ---------------------------------------------------------------------------

describe("hardening: wire magic keys", () => {
  it('unknown "constructor" / "prototype" / "__proto__" fields FAIL CLOSED on decode', () => {
    const wire = encodeNecWireJson("evidence-snapshot", fullSnapshot());
    for (const magic of ["constructor", "prototype"]) {
      const parsed = JSON.parse(wire) as Record<string, unknown>;
      parsed[magic] = "evil";
      expect(() => decodeNecWireJson("evidence-snapshot", JSON.stringify(parsed))).toThrow(
        NecWireError,
      );
      expect(() => decodeNecWireJson("evidence-snapshot", JSON.stringify(parsed))).toThrow(
        new RegExp(`unknown field "${magic}"`),
      );
    }
    // An own "__proto__" key must be injected at the RAW TEXT level
    // (assignment would hit the inherited setter and never become data).
    const poisoned = wire.replace("{", '{"__proto__":"evil",');
    expect(JSON.parse(poisoned)).not.toBe(undefined); // syntactically valid JSON
    expect(() => decodeNecWireJson("evidence-snapshot", poisoned)).toThrow(
      /unknown field "__proto__"/,
    );
  });

  it("union discriminators use exact own-property membership (no inherited variant)", () => {
    const built = buildNetworkEvidenceResult(validResultContent(), ctx());
    const wire = encodeNecWireJson("network-evidence-result", built);
    // A conflict scope is a union tagged by "kind"; an INHERITED variant
    // name can never satisfy the lookup, and an unknown kind fails closed.
    const parsed = JSON.parse(wire) as Record<string, unknown>;
    (parsed.conflicts as Array<Record<string, unknown>>).push({
      id: "c_evil",
      code: "EVIL",
      description: "evil",
      evidence: [],
      material: false,
      kind: "toString", // inherited Object.prototype member, not a variant
    });
    expect(() => decodeNecWireJson("network-evidence-result", JSON.stringify(parsed))).toThrow(
      NecWireError,
    );
  });
});

describe("hardening: encode -> decode -> encode byte stability", () => {
  it("valid own __proto__ metadata survives encode/decode/re-encode unchanged", () => {
    const meta: Record<string, unknown> = {};
    Object.defineProperty(meta, "__proto__", {
      value: "ordinary-data",
      enumerable: true,
      writable: true,
      configurable: true,
    });
    meta.regular = 1;
    const content = validResultContent();
    const enriched = evidenceRef({ metadata: meta });
    const snapshot = snapshotWith([enriched]);
    content.evidence = [enriched];
    const { content: prepared, context } = resultOverSnapshot(content, snapshot);
    const built = buildNetworkEvidenceResult(prepared, context);

    const wire1 = encodeNecWireJson("network-evidence-result", built);
    const decoded = decodeNecWireJson("network-evidence-result", wire1);
    const wire2 = encodeNecWireJson("network-evidence-result", decoded);
    expect(wire1).toBe(wire2);
    const decodedMeta = JSON.parse(wire1).evidence[0].metadata;
    expect(decodedMeta["__proto__"]).toBe("ordinary-data");
  });
});

// ---------------------------------------------------------------------------
// 4. Resource bounds
// ---------------------------------------------------------------------------

describe("hardening: resource bounds at every entry point", () => {
  it("wire parse rejects oversized raw documents before parsing", () => {
    const oversized = `["${"x".repeat(RESOURCE_LIMITS.MAX_CANONICAL_BYTES)}"]`;
    expect(() => parseNecWireJson(oversized)).toThrow(NecWireError);
    expect(() => parseNecWireJson(oversized)).toThrow(/MAX_CANONICAL_BYTES/);
  });

  it("generic strings above the string budget are rejected at the wire boundary", () => {
    const snap = fullSnapshot();
    const wire = encodeNecWireJson("evidence-snapshot", snap);
    const parsed = JSON.parse(wire) as Record<string, unknown>;
    (parsed.evidence as Array<Record<string, unknown>>)[0]!.metadata = {
      blob: "x".repeat(2 * 1024 * 1024),
    };
    expect(() => decodeNecWireJson("evidence-snapshot", JSON.stringify(parsed))).toThrow(
      NecWireError,
    );
  });

  it("base64 checks the ENCODED length before allocating decoded bytes", () => {
    // Encoded length that could decode above the documented limit.
    const tooBigEncoded = Buffer.alloc(
      RESOURCE_LIMITS.MAX_NATIVE_SOURCE_PAYLOAD_BYTES + 96,
      7,
    ).toString("base64");
    expect(tooBigEncoded.length).toBeGreaterThan(
      Math.ceil(RESOURCE_LIMITS.MAX_NATIVE_SOURCE_PAYLOAD_BYTES / 3) * 4,
    );
    expect(() => decodeBase64Strict(tooBigEncoded, "p")).toThrow(
      /encoded length bound exceeded before allocation/,
    );

    // The documented DECODED-byte limit itself still holds after decoding.
    const justOver = Buffer.alloc(
      RESOURCE_LIMITS.MAX_NATIVE_SOURCE_PAYLOAD_BYTES + 1,
      7,
    ).toString("base64");
    expect(justOver.length).toBeLessThanOrEqual(
      Math.ceil(RESOURCE_LIMITS.MAX_NATIVE_SOURCE_PAYLOAD_BYTES / 3) * 4,
    );
    expect(() => decodeBase64Strict(justOver, "p")).toThrow(/MAX_NATIVE_SOURCE_PAYLOAD_BYTES/);

    // Exactly at the limit decodes fine.
    const atLimit = Buffer.alloc(RESOURCE_LIMITS.MAX_NATIVE_SOURCE_PAYLOAD_BYTES, 7).toString("base64");
    expect(() => decodeBase64Strict(atLimit, "p")).not.toThrow();
  }, 20_000);
});

// ---------------------------------------------------------------------------
// 5. Bigint domain symmetry
// ---------------------------------------------------------------------------

describe("hardening: bigint decimal-digit domain symmetry (MAX_DECIMAL_INTEGER_DIGITS = 1000)", () => {
  const digits1000 = BigInt("1" + "0".repeat(999)); // exactly 1000 digits
  const digits1001 = BigInt("1" + "0".repeat(1000)); // 1001 digits

  function snapshotFor(fp: ReturnType<typeof fingerprint>) {
    return buildEvidenceSnapshot({
      id: `snap_${fp.networkId.replace(/[^a-z0-9]/gi, "_")}_${fp.observedAt.blockNumber?.toString().slice(0, 6)}`,
      createdAt: "2026-01-01T00:00:00.000Z",
      networkFingerprint: fp,
      anchors: [],
      evidence: [evidenceRef()],
      resolverManifestDigest: fullSnapshot().resolverManifestDigest,
      policyDigest: fullSnapshot().policyDigest,
    });
  }

  it("runtime validation accepts 1000 digits and rejects 1001", () => {
    const okFp = fingerprint({ observedAt: { blockNumber: digits1000 } });
    const okSnap = snapshotFor(okFp);
    const ok = validResultContent();
    ok.network = okFp;
    ok.snapshot = { id: okSnap.id, digest: okSnap.digest };
    expect(() =>
      buildNetworkEvidenceResult(ok, { ...ctx(), snapshot: okSnap }),
    ).not.toThrow();

    const badFp = fingerprint({ observedAt: { blockNumber: digits1001 } });
    const bad = validResultContent();
    bad.network = badFp;
    expect(() => buildNetworkEvidenceResult(bad, ctx())).toThrow(NecValidationError);
    expect(() => buildNetworkEvidenceResult(bad, ctx())).toThrow(
      /MAX_DECIMAL_INTEGER_DIGITS/,
    );
  });

  it("wire ENCODE rejects what wire DECODE rejects (one rule, no asymmetry)", () => {
    const badFp = fingerprint({ observedAt: { blockNumber: digits1001 } });
    const bad = validResultContent();
    bad.network = badFp;
    // Encode validates first: the runtime bound fires with the NEC error.
    expect(() => encodeNecWireJson("network-evidence-result", bad as never)).toThrow(
      NecValidationError,
    );
  });

  it("wire DECODE rejects >1000 digits", () => {
    const wire = encodeNecWireJson("evidence-snapshot", fullSnapshot());
    const parsed = JSON.parse(wire) as Record<string, unknown>;
    (
      (parsed.networkFingerprint as Record<string, unknown>).observedAt as Record<string, unknown>
    ).blockNumber = digits1001.toString();
    expect(() => decodeNecWireJson("evidence-snapshot", JSON.stringify(parsed))).toThrow(NecWireError);
    expect(() => decodeNecWireJson("evidence-snapshot", JSON.stringify(parsed))).toThrow(
      /1000 digits/,
    );
  });

  it("an artifact AT the 1000-digit bound round-trips byte-stably through the wire", () => {
    const okFp = fingerprint({ observedAt: { blockNumber: digits1000 } });
    const okSnap = buildEvidenceSnapshot({
      id: "snap_bound",
      createdAt: "2026-01-01T00:00:00.000Z",
      networkFingerprint: okFp,
      anchors: [],
      evidence: [evidenceRef()],
      resolverManifestDigest: fullSnapshot().resolverManifestDigest,
      policyDigest: fullSnapshot().policyDigest,
    });
    const content = validResultContent();
    content.network = okFp;
    const { content: prepared, context } = resultOverSnapshot(content, okSnap);
    const built = buildNetworkEvidenceResult(prepared, context);
    const wire1 = encodeNecWireJson("network-evidence-result", built);
    const decoded = decodeNecWireJson("network-evidence-result", wire1);
    expect(decoded).toEqual(built);
    expect(encodeNecWireJson("network-evidence-result", decoded)).toBe(wire1);
  });

  it("the digit rule does NOT apply to ordinary decimal strings that are not schema-typed integers", () => {
    const longString = "9".repeat(1001);
    const meta = { amountText: longString };
    expect(() => canonicalJson(meta)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 6. Snapshot/result provenance closure
// ---------------------------------------------------------------------------

describe("hardening: snapshot/result EvidenceRef closure", () => {
  it("a result may NOT replace locator/retrievedAt/contentDigest/networkId under an existing EvidenceId", () => {
    const mutations = [
      { locator: "tampered" },
      { retrievedAt: "2031-01-01T00:00:00.000Z" as const },
      { contentDigest: `sha256:${"99".repeat(32)}` },
      { networkId: "eip155:1" },
      { blockNumber: 424242n },
      { metadata: { replaced: true } },
    ];
    for (const mutation of mutations) {
      const original = evidenceRef();
      const snapshot = snapshotWith([original]);
      const content = validResultContent();
      content.evidence = [evidenceRef(mutation)];
      const { content: prepared, context } = resultOverSnapshot(content, snapshot);
      expect(() => buildNetworkEvidenceResult(prepared, context)).toThrow(
        /differs from the snapshot's EvidenceRef under the same id/,
      );
    }
  });

  it("a result may not cite an EvidenceId that is absent from the snapshot", () => {
    const content = validResultContent();
    content.evidence = [evidenceRef(), evidenceRef({ id: "ev_absent", sourceId: "src.x" })];
    expect(() => buildNetworkEvidenceResult(content, ctx())).toThrow(
      /no EvidenceRef with this id exists in the referenced EvidenceSnapshot/,
    );
  });

  it("snapshot evidence MAY be a superset of result evidence", () => {
    const superset = snapshotWith([
      evidenceRef(),
      evidenceRef({ id: "ev_extra", sourceId: "src.extra" }),
    ]);
    const content = validResultContent();
    const { content: prepared, context } = resultOverSnapshot(content, superset);
    expect(() => buildNetworkEvidenceResult(prepared, context)).not.toThrow();
  });

  it("zkSYS-like multi-network: primary A + foreign B WITH anchor -> valid; WITHOUT anchor -> invalid", () => {
    const FOREIGN = "sys:534352";
    const refs = [
      evidenceRef(),
      evidenceRef({ id: "ev_foreign", sourceId: "src.zksys", networkId: FOREIGN }),
    ];

    // Positive: foreign evidence + explicit foreign anchor in the snapshot.
    const anchored = buildEvidenceSnapshot({
      ...snapshotContent([{ networkId: FOREIGN, blockNumber: 7n, role: "settlement_observation" }]),
      evidence: refs.map((ref) => structuredClone(ref)) as never,
    });
    const positive = validResultContent();
    positive.evidence = refs.map((ref) => structuredClone(ref));
    const pos = resultOverSnapshot(positive, anchored);
    expect(() => buildNetworkEvidenceResult(pos.content, pos.context)).not.toThrow();

    // Negative: identical world WITHOUT the foreign anchor.
    const unanchored = snapshotWith(refs);
    const negative = validResultContent();
    negative.evidence = refs.map((ref) => structuredClone(ref));
    const neg = resultOverSnapshot(negative, unanchored);
    expect(() => buildNetworkEvidenceResult(neg.content, neg.context)).toThrow(
      /no explicit EvidenceAnchor in the snapshot/,
    );
  });

  it("anchors are never inferred atomic: an anchor for B says nothing about C", () => {
    const B = "sys:534352";
    const C = "sys:999999";
    const anchoredB = buildEvidenceSnapshot({
      ...snapshotContent([{ networkId: B, blockNumber: 1n }]),
      evidence: [evidenceRef(), evidenceRef({ id: "ev_c", sourceId: "src.c", networkId: C })] as never,
    });
    const content = validResultContent();
    content.evidence = [evidenceRef(), evidenceRef({ id: "ev_c", sourceId: "src.c", networkId: C })];
    const { content: prepared, context } = resultOverSnapshot(content, anchoredB);
    expect(() => buildNetworkEvidenceResult(prepared, context)).toThrow(
      /no explicit EvidenceAnchor in the snapshot/,
    );
    expect(B).not.toBe(C);
  });
});

// ---------------------------------------------------------------------------
// 7. Fragment validation
// ---------------------------------------------------------------------------

describe("hardening: fragment validation", () => {
  it("preflight fragments reject unknown readiness-table keys (partial records have EXACT key sets)", () => {
    expect(() =>
      validatePreflightFragment({
        network: fingerprint(),
        evidenceReadiness: { execution: { status: "ready" }, bogusKey: { status: "ready" } },
        evidence: [],
        blockers: [],
        warnings: [],
      }),
    ).toThrow(/EXACT allowed key set/);
    // R3: `executionReadiness` is no longer part of the contract at all —
    // it is an UNKNOWN field now (generic execution readiness is not owned
    // by NEC).
    expect(() =>
      validatePreflightFragment({
        network: fingerprint(),
        evidenceReadiness: {},
        executionReadiness: { gas: { status: "unknown" } },
        evidence: [],
        blockers: [],
        warnings: [],
      }),
    ).toThrow(/unknown field/);
  });

  it("network-evidence fragments reject unknown dimension keys", () => {
    expect(() =>
      validateNetworkEvidenceFragment({
        network: fingerprint(),
        subject: { type: "transaction", networkId: "eip155:8453", txId: `0x${"11".repeat(32)}` },
        networkEvidence: {
          execution: { applicability: "unknown", basis: [], evidence: [] },
          bogusDimension: { applicability: "unknown", basis: [], evidence: [] },
        },
        evidence: [],
        conflicts: [],
        warnings: [],
      }),
    ).toThrow(/EXACT allowed key set/);
  });

  it("fragment dimension citations must resolve against the fragment evidence table", () => {
    expect(() =>
      validateNetworkEvidenceFragment({
        network: fingerprint(),
        subject: { type: "transaction", networkId: "eip155:8453", txId: `0x${"11".repeat(32)}` },
        networkEvidence: {
          execution: {
            applicability: "applicable",
            verdict: "supported",
            basis: ["source_observation"],
            evidence: ["ev_ghost"],
          },
        },
        evidence: [evidenceRef()],
        conflicts: [],
        warnings: [],
      }),
    ).toThrow(/dangling provenance/);
  });

  it("subject/network consistency applies where the fragment contains both", () => {
    expect(() =>
      validateNetworkEvidenceFragment({
        network: fingerprint(),
        subject: { type: "transaction", networkId: "eip155:1", txId: `0x${"11".repeat(32)}` },
        networkEvidence: {},
        evidence: [],
        conflicts: [],
        warnings: [],
      }),
    ).toThrow(/must equal the fragment networkId/);
  });
});

// ---------------------------------------------------------------------------
// 8. Nested set normalization
// ---------------------------------------------------------------------------

describe("hardening: nested set normalization before ordering/hashing", () => {
  function evaluationOf(capability: import("../src/index.js").CapabilityName, evidence: string[]) {
    return {
      requirement: { capability, strength: "required" as const },
      status: "satisfied" as const,
      evidence,
    };
  }

  function disc(eA: string[], eB: string[]) {
    return {
      schemaVersion: "0.1" as const,
      requestId: "d",
      generatedAt: "2026-01-01T00:00:00.000Z",
      request: discoveryRequirements({
        requirements: [
          { capability: "execution", strength: "required" as const },
          { capability: "settlement", strength: "required" as const },
        ],
      }),
      matches: [
        {
          network: fingerprint(),
          classification: "eligible" as const,
          evaluations: [evaluationOf("execution", eA), evaluationOf("settlement", eB)],
          capabilitySnapshot: { id: "c", digest: `sha256:${"cc".repeat(32)}` },
          evidence: [
            evidenceRef({ id: "ea", sourceId: "sa" }),
            evidenceRef({ id: "eb", sourceId: "sb" }),
            evidenceRef({ id: "ec", sourceId: "sc" }),
            evidenceRef({ id: "ez", sourceId: "sz" }),
          ],
        },
      ],
    };
  }

  it("discovery evaluation citation permutations produce IDENTICAL artifact digests", () => {
    // Raw forms sort differently than normalized forms here: evaluation "b"
    // cites ["a","c"] vs ["c","a"], which flips its raw comparison against
    // evaluation "a"'s single citation "z"... normalization must happen
    // BEFORE the outer sort so both permutations project identically.
    const d1 = computeDiscoverNetworksResultDigest(disc(["z"], ["a", "c"]) as never);
    const d2 = computeDiscoverNetworksResultDigest(disc(["z"], ["c", "a"]) as never);
    expect(d1).toBe(d2);

    // And a semantically DIFFERENT citation set still changes the digest.
    const d3 = computeDiscoverNetworksResultDigest(disc(["z"], ["a"]) as never);
    expect(d3).not.toBe(d1);
  });

  it("preflight embedded policy dimension permutations produce IDENTICAL artifact digests", () => {
    const dims: import("../src/index.js").PolicyDimension[] = ["execution", "observedEffects"];
    const permuted: import("../src/index.js").PolicyDimension[] = ["observedEffects", "execution"];

    const p1 = validPreflightResultContent();
    p1.request = { ...p1.request, evidencePolicy: { ...fullPolicy(), requiredDimensions: dims } };
    p1.evidencePolicy = {
      id: "payment-basic",
      version: "1",
      digest: computeEvidencePolicyDigest({ ...fullPolicy(), requiredDimensions: dims }),
    };

    const p2 = validPreflightResultContent();
    p2.request = { ...p2.request, evidencePolicy: { ...fullPolicy(), requiredDimensions: permuted } };
    p2.evidencePolicy = {
      id: "payment-basic",
      version: "1",
      digest: computeEvidencePolicyDigest({ ...fullPolicy(), requiredDimensions: permuted }),
    };

    const b1 = buildPreflightResult(p1, preflightContext());
    const b2 = buildPreflightResult(p2, preflightContext());
    expect(b1.artifactDigest).toBe(b2.artifactDigest);
    // Sanity: a genuinely different policy still binds differently.
    const other = validPreflightResultContent();
    const otherPolicy = { ...fullPolicy(), version: "2", requiredDimensions: dims };
    other.request = { ...other.request, evidencePolicy: { ...otherPolicy, digest: computeEvidencePolicyDigest(otherPolicy) } };
    other.evidencePolicy = {
      id: "payment-basic",
      version: "2",
      digest: computeEvidencePolicyDigest(otherPolicy),
    };
    const bOther = buildPreflightResult(other, preflightContext());
    expect(bOther.artifactDigest).not.toBe(b1.artifactDigest);
  });

  it("result-level citation permutations stay digest-stable end to end", () => {
    const a = validResultContent();
    const b = validResultContent();
    const warningsA = [{ code: "W", message: "m", evidence: ["b", "a", "ev_receipt_1"] }];
    const warningsB = [{ code: "W", message: "m", evidence: ["a", "b", "ev_receipt_1"] }];
    a.warnings = warningsA;
    b.warnings = warningsB;
    expect(computeNetworkEvidenceResultSemanticDigest(a)).toBe(
      computeNetworkEvidenceResultSemanticDigest(b),
    );
  });

  it("truly ordered generic metadata arrays are NOT reordered", () => {
    const make = (steps: string[]) => {
      const content = validResultContent();
      const enriched = evidenceRef({ metadata: { steps } });
      const snapshot = snapshotWith([enriched]);
      content.evidence = [enriched];
      const { content: prepared, context } = resultOverSnapshot(content, snapshot);
      return buildNetworkEvidenceResult(prepared, context);
    };
    const first = make(["b", "a"]);
    const second = make(["a", "b"]);
    // Order preserved inside generic metadata -> different semantics/digests.
    expect(first.semanticDigest).not.toBe(second.semanticDigest);
    // Same order -> same semantics.
    expect(make(["b", "a"]).semanticDigest).toBe(first.semanticDigest);
  });
});

// ---------------------------------------------------------------------------
// 9. Semantic verification
// ---------------------------------------------------------------------------

describe("hardening: semantic verification validates before recomputing", () => {
  it("digest-consistent but MALFORMED results do not pass verifyNetworkEvidenceResultSemantics", () => {
    const built = buildNetworkEvidenceResult(validResultContent(), ctx());

    // Break referential integrity (ghost citation), then re-align the stored
    // semanticDigest with the malformed projection — pre-fix this verified.
    const broken = structuredClone(built) as typeof built;
    broken.networkEvidence.execution.verdict = "insufficient";
    broken.networkEvidence.execution.evidence = ["ev_ghost"];
    (broken as { semanticDigest: string }).semanticDigest =
      computeNetworkEvidenceResultSemanticDigest(broken);
    expect(verifyNetworkEvidenceResultSemantics(broken)).toBe(false);

    // Missing fields fail closed even when a projection might match.
    const gutted = structuredClone(built) as unknown as Record<string, unknown>;
    delete gutted.conflicts;
    expect(verifyNetworkEvidenceResultSemantics(gutted as never)).toBe(false);
  });

  it("intact results still verify semantically", () => {
    const built = buildNetworkEvidenceResult(validResultContent(), ctx());
    expect(verifyNetworkEvidenceResultSemantics(built)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 10. Warning / conflict normalization
// ---------------------------------------------------------------------------

describe("hardening: warning/conflict citation permutation identity", () => {
  const mkConflictWith = (overrides: Record<string, unknown>) => ({
    id: "c1",
    code: "X",
    description: "d",
    scope: { kind: "dimension", dimension: "execution" },
    evidence: ["a"],
    material: false,
    ...overrides,
  });

  it("mergeConflicts treats citation-only permutations of one conflict ID as THE SAME conflict", () => {
    const merged = mergeConflicts(
      [mkConflictWith({ evidence: ["b", "a"] })] as never,
      [mkConflictWith({ evidence: ["a", "b"] })] as never,
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.evidence).toEqual(["a", "b"]);

    // Genuinely different content under the same ID still fails closed:
    // semantically different conflicts are never silently discarded.
    const different = mkConflictWith({
      description: "OTHER",
      scope: { kind: "result" },
    });
    expect(() =>
      mergeConflicts([mkConflictWith({})] as never, [different] as never),
    ).toThrow(/id collision/);
  });

  it("mergeWarnings does not create a new warning from an EvidenceId permutation", () => {
    const w1 = { code: "W", message: "m", evidence: ["b", "a"] };
    const w2 = { code: "W", message: "m", evidence: ["a", "b"] };
    const merged = mergeWarnings([w1] as never, [w2] as never);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.evidence).toEqual(["a", "b"]);
  });

  it("artifact-level duplicate detection uses normalized warning identity", () => {
    const content = validResultContent();
    content.warnings = [
      { code: "W", message: "m", evidence: ["ev_receipt_1"] },
      { code: "W", message: "m", evidence: ["ev_receipt_1"] },
    ];
    expect(() => buildNetworkEvidenceResult(content, ctx())).toThrow(/duplicate warning/);
  });
});
