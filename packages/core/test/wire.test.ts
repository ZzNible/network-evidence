import { describe, expect, it } from "vitest";

import {
  decodeNecWireJson,
  encodeNecWireJson,
  buildNetworkEvidenceResult,
  buildEvidenceSnapshot,
  buildPreflightResult,
  buildCapabilitySnapshot,
  NecValidationError,
  NecWireError,
  parseNecWireJson,
  RESOURCE_LIMITS,
  WIRE_PROFILE,
} from "../src/index.js";
import type { EvidenceSnapshot } from "../src/index.js";
import {
  evidenceRef,
  fingerprint,
  fullPolicy,
  fullSnapshot,
  fullManifest,
  preflightContext,
  evidenceRequestContent,
  resultContext,
  snapshotContent,
  validCapabilitySnapshotContent,
  validPreflightResultContent,
  validResultContent,
} from "./fixtures.js";

/**
 * DECISION: `nec-wire-json-v1`. Schema-declared integer quantities travel as
 * canonical decimal STRINGS; conversion is schema-aware (no global
 * replacer/reviver); generic values are JSON-safe with no bigint.
 */

function builtResult() {
  return buildNetworkEvidenceResult(validResultContent(), {
    policy: fullPolicy(),
    snapshot: fullSnapshot(),
    resolver: fullManifest(),
    request: evidenceRequestContent(),
  });
}

describe("wire profile identity", () => {
  it("is an explicitly versioned profile distinct from the canonical profile", () => {
    expect(WIRE_PROFILE).toBe("nec-wire-json-v1");
  });
});

describe("schema-aware bigint <-> decimal-string round trips", () => {
  it("round-trips a full NetworkEvidenceResult including far-beyond-2^53 integers", () => {
    const fp = fingerprint({
      observedAt: { blockNumber: 2n ** 256n - 1n, blockId: `0x${"ab".repeat(32)}` },
    });
    const enrichedRef = evidenceRef({ id: "ev_receipt_1", blockNumber: 2n ** 200n + 123n });
    // Snapshot/result closure: the snapshot binds the same enriched ref.
    const snapshot = buildEvidenceSnapshot({
      ...snapshotContent(),
      networkFingerprint: fp,
      evidence: [structuredClone(enrichedRef)],
    });

    const content = validResultContent();
    content.network = fp;
    content.snapshot = { id: snapshot.id, digest: snapshot.digest };
    content.evidence = [enrichedRef];
    content.networkEvidence.execution.evidence = ["ev_receipt_1"];
    content.networkEvidence.observedEffects = [];

    const built = buildNetworkEvidenceResult(content, {
      policy: fullPolicy(),
      snapshot,
      resolver: fullManifest(),
      request: evidenceRequestContent(),
    });

    const wire = encodeNecWireJson("network-evidence-result", built);
    // On the wire the huge integer is a QUOTED decimal string.
    expect(wire).toContain(`"blockNumber":"${2n ** 256n - 1n}"`);
    const decoded = decodeNecWireJson("network-evidence-result", wire);
    expect(decoded).toEqual(built);
    // Exact runtime bigint survives the round trip.
    expect(decoded.network.observedAt.blockNumber).toBe(2n ** 256n - 1n);    // Re-encoding is byte-stable.
    expect(encodeNecWireJson("network-evidence-result", decoded)).toBe(wire);
  });

  it("round-trips snapshots and preflight results", () => {
    const { digest: _omit, ...snapshotContent } = fullSnapshot();
    const snapshot = buildEvidenceSnapshot({
      ...snapshotContent,
      anchors: [
        ...snapshotContent.anchors,
        { networkId: "eip155:42161", blockNumber: 5n ** 40n, role: "settlement" },
      ],
    });
    const snapWire = encodeNecWireJson("evidence-snapshot", snapshot);
    expect(decodeNecWireJson("evidence-snapshot", snapWire)).toEqual(snapshot);

    const preflight = buildPreflightResult(validPreflightResultContent(), preflightContext());
    const pfWire = encodeNecWireJson("preflight-result", preflight);
    expect(decodeNecWireJson("preflight-result", pfWire)).toEqual(preflight);
  });

  it("capability snapshots round-trip", () => {
    const capsnap = buildCapabilitySnapshot(validCapabilitySnapshotContent(), {
      resolver: fullManifest(),
      networkId: fingerprint().networkId,
    });
    const wire = encodeNecWireJson("capability-snapshot", capsnap);
    expect(decodeNecWireJson("capability-snapshot", wire)).toEqual(capsnap);
  });
});

describe("malformed wire forms fail closed", () => {
  const baseSnapshot = fullSnapshot();
  const { digest: _strip, ...snapshotContent } = baseSnapshot;
  const base = JSON.parse(
    encodeNecWireJson("evidence-snapshot", buildEvidenceSnapshot(snapshotContent)),
  );

  function reserialize(value: unknown): string {
    return JSON.stringify(value);
  }

  it("blockNumber as JSON NUMBER is rejected (must be a decimal string)", () => {
    const bad = structuredClone(base);
    bad.networkFingerprint.observedAt.blockNumber = 1000;
    expect(() => decodeNecWireJson("evidence-snapshot", reserialize(bad))).toThrow(NecWireError);
  });

  it('rejects "+5", leading zeros, whitespace, exponent, negative', () => {
    for (const malformed of ["+1000", "01000", " 1000", "1000 ", "1e3", "-1000", "", "0x10", "1_000"]) {
      const bad = structuredClone(base);
      bad.networkFingerprint.observedAt.blockNumber = malformed;
      expect(() => decodeNecWireJson("evidence-snapshot", reserialize(bad)), `"${malformed}"`).toThrow(
        NecWireError,
      );
    }
  });

  it('"0" is a valid canonical decimal string', () => {
    const { digest: _strip, ...zeroContent } = fullSnapshot();
    zeroContent.networkFingerprint = fingerprint({ observedAt: { blockNumber: 0n } });
    const zeroSnapshot = buildEvidenceSnapshot(zeroContent);
    const wire = encodeNecWireJson("evidence-snapshot", zeroSnapshot);
    expect(wire).toContain('"blockNumber":"0"');
    const decoded = decodeNecWireJson("evidence-snapshot", wire);
    expect(decoded.networkFingerprint.observedAt.blockNumber).toBe(0n);
  });

  it("unknown fields fail closed on the wire too", () => {
    const bad = structuredClone(base);
    bad.rogue = true;
    expect(() => decodeNecWireJson("evidence-snapshot", reserialize(bad))).toThrow(NecWireError);
  });
});

describe("strict wire parsing", () => {
  it("rejects duplicate JSON keys (standard JSON.parse cannot)", () => {
    const doc = '{"a":1,"a":2}';
    expect(() => parseNecWireJson(doc)).toThrow(/duplicate JSON key/);
    expect(JSON.parse(doc)).toEqual({ a: 2 }); // standard parser keeps last
  });

  it("rejects trailing content and empty input", () => {
    expect(() => parseNecWireJson('{"a":1}garbage')).toThrow(NecWireError);
    expect(() => parseNecWireJson("")).toThrow(NecWireError);
    expect(() => parseNecWireJson("{")).toThrow(NecWireError);
    expect(() => parseNecWireJson('{"a":1,}')).toThrow(NecWireError);
  });

  it("rejects unpaired surrogates in parsed strings", () => {
    expect(() => parseNecWireJson('"\\ud800"')).toThrow(NecWireError);
    expect(() => parseNecWireJson('{"\\udc00x":1}')).toThrow(NecWireError);
    // Paired surrogates are fine.
    expect(parseNecWireJson('"😀"')).toBe("😀");
  });

  it('treats own "__proto__" as ordinary data, exactly like JSON.parse', () => {
    // Injected at the RAW TEXT level: assignment would hit the inherited
    // setter and never become data. The strict parser must keep an own
    // "__proto__" key as ORDINARY DATA on a null-prototype record.
    const value = parseNecWireJson(
      '{"__proto__":{"x":1},"b":2}',
    ) as Record<string, unknown>;
    expect(Object.getPrototypeOf(value)).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(value, "__proto__")).toBe(true);
    expect(value["__proto__"]).toEqual({ x: 1 });
    expect(value["b"]).toBe(2);
    // No prototype pollution occurred.
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it('retains coverage for "constructor"/"prototype"/"__proto__" as ordinary parsed keys', () => {
    for (const magic of ["constructor", "prototype", "__proto__"]) {
      const value = parseNecWireJson(
        `{"${magic}":1,"b":2}`,
      ) as Record<string, unknown>;
      expect(Object.prototype.hasOwnProperty.call(value, magic)).toBe(true);
      expect(value[magic]).toBe(1);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("generic values stay JSON-safe (no bigint anywhere else)", () => {
  it("encode rejects bigint smuggled into metadata or effect fields", () => {
    const content = validResultContent();
    content.evidence = [evidenceRef({ id: "ev_receipt_1", metadata: { n: 5n } })];
    expect(() =>
      encodeNecWireJson(
        "network-evidence-result",
        buildNetworkEvidenceResult(content, {
          policy: fullPolicy(),
          snapshot: fullSnapshot(),
          resolver: fullManifest(),
          request: evidenceRequestContent(),
        }),
      ),
    ).toThrow(); // core validation already rejects bigint metadata

    const rawContent = validResultContent();
    rawContent.networkEvidence.observedEffects = [
      {
        id: "effect_1",
        type: "erc20.transfer",
        fields: { amount: 10n },
        basis: ["source_observation"],
        evidence: ["ev_receipt_1"],
      },
    ];
    // Even before validation, encoding must not silently stringify bigints.
    expect(() =>
      encodeNecWireJson("network-evidence-result", rawContent),
    ).toThrow(NecValidationError);
  });
});

// ---------------------------------------------------------------------------
// FREEZE-FINAL OUTPUT RESOURCE SYMMETRY: the encoder enforces the SAME
// MAX_CANONICAL_BYTES budget (in exact UTF-8 bytes) the raw parser enforces
// on input, so decode(encode(x)) can never fail on size alone.
// ---------------------------------------------------------------------------

describe("wire encoder output byte budget (MAX_CANONICAL_BYTES)", () => {
  const LIMIT = RESOURCE_LIMITS.MAX_CANONICAL_BYTES;
  // Eight full pad strings plus one adjustable TAIL string keeps every
  // single string far under MAX_STRING_UTF8_BYTES while the DOCUMENT
  // approaches MAX_CANONICAL_BYTES.
  const FULL = 1_000_000;

  /** Tail of JS length `a`; `m` of its characters are 2-byte "é" (+m UTF-8 bytes, identical JS length). */
  function padded(a: number, m = 0) {
    const pad = [
      ...Array.from({ length: 8 }, () => "x".repeat(FULL)),
      "x".repeat(Math.max(a - m, 0)) + "é".repeat(Math.max(m, 0)),
    ];
    return buildEvidenceSnapshot({
      ...snapshotContent(),
      networkFingerprint: fingerprint({ metadata: { pad } }),
    });
  }

  function byteLength(text: string): number {
    return new TextEncoder().encode(text).length;
  }

  // Solve ONCE for the ASCII tail length whose encoded document lands
  // EXACTLY on the announced byte budget.
  let solvedA: number | undefined;
  function solveA(): number {
    if (solvedA === undefined) {
      let a = 300_000;
      const probe = encodeNecWireJson("evidence-snapshot", padded(a));
      a += LIMIT - byteLength(probe);
      solvedA = a;
    }
    return solvedA;
  }

  it("accepts output EXACTLY AT the boundary; decode(encode(...)) still holds there", () => {
    const a = solveA();
    const text = encodeNecWireJson("evidence-snapshot", padded(a));
    expect(byteLength(text)).toBe(LIMIT);
    expect(() => parseNecWireJson(text)).not.toThrow();
    expect(decodeNecWireJson("evidence-snapshot", text)).toEqual(padded(a));
  }, 120_000);

  it("rejects output ONE BYTE over the boundary with a controlled NecWireError", () => {
    const a = solveA();
    expect(() => encodeNecWireJson("evidence-snapshot", padded(a + 1))).toThrow(NecWireError);
    try {
      encodeNecWireJson("evidence-snapshot", padded(a + 1));
    } catch (error) {
      expect(error).toBeInstanceOf(NecWireError);
      expect((error as Error).message).toContain(
        `exceeds MAX_CANONICAL_BYTES (${LIMIT}`,
      );
    }
  }, 120_000);

  it("just-under the boundary still encodes AND decodes", () => {
    const a = solveA();
    const text = encodeNecWireJson("evidence-snapshot", padded(a - 8));
    expect(byteLength(text)).toBeLessThan(LIMIT);
    expect(decodeNecWireJson("evidence-snapshot", text)).toEqual(padded(a - 8));
  }, 120_000);

  it("measures UTF-8 BYTES, not JavaScript string length (multibyte boundary)", () => {
    const a = solveA();
    const fits = padded(a);
    const overBySeven = padded(a, 7);
    const tailOf = (snap: EvidenceSnapshot) =>
      ((snap.networkFingerprint.metadata as { pad: string[] }).pad[8] as string);
    // Identical JS length; strictly more UTF-8 bytes.
    expect(tailOf(overBySeven).length).toBe(tailOf(fits).length);
    expect(byteLength(tailOf(overBySeven))).toBe(byteLength(tailOf(fits)) + 7);
    // The ASCII document fits EXACTLY; the same-length multibyte document
    // is over the byte budget and must be rejected.
    expect(byteLength(encodeNecWireJson("evidence-snapshot", fits))).toBe(LIMIT);
    expect(() => encodeNecWireJson("evidence-snapshot", overBySeven)).toThrow(
      /MAX_CANONICAL_BYTES/,
    );
  }, 120_000);
});
