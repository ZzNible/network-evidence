import { describe, expect, it } from "vitest";

import {
  capabilityIsUsable,
  deepFreeze,
  NecValidationError,
  buildEvidenceSnapshot,
  buildNetworkEvidenceResult,
  validateNetworkEvidenceResult,
} from "../src/index.js";
import {
  conflict as mkConflict,
  evidenceRef,
  fingerprint,
  fullSnapshot,
  resultContext,
  validResultContent,
} from "./fixtures.js";

// R3: usability is CONTEXTUAL — every cited EvidenceId must resolve against
// a complete validated EvidenceRef table.
const TABLE = () => [
  evidenceRef({ id: "ev_receipt_1" }),
  evidenceRef({ id: "ev_other", sourceId: "src.other" }),
];

describe("capability claim authority (support x availability x resolvable provenance)", () => {
  it("usable ONLY as supported + available + non-empty RESOLVABLE citations", () => {
    const table = TABLE();
    expect(
      capabilityIsUsable({ support: "supported", availability: "unavailable" }, table),
    ).toBe(false);
    expect(capabilityIsUsable({ support: "supported", availability: "degraded" }, table)).toBe(false);
    expect(capabilityIsUsable({ support: "supported", availability: "unknown" }, table)).toBe(false);
    expect(
      capabilityIsUsable({ support: "unsupported", availability: "available" }, table),
    ).toBe(false);
    // supported+available WITHOUT cited evidence is not usable.
    expect(capabilityIsUsable({ support: "supported", availability: "available" }, table)).toBe(false);
    expect(
      capabilityIsUsable({ support: "supported", availability: "available", evidence: [] }, table),
    ).toBe(false);
    // With resolvable citations it is usable.
    expect(
      capabilityIsUsable(
        { support: "supported", availability: "available", evidence: ["ev_receipt_1"] },
        table,
      ),
    ).toBe(true);
  });

  it("R3: a ghost EvidenceId makes supported+available NOT usable (no context-free claims)", () => {
    const table = TABLE();
    expect(
      capabilityIsUsable(
        { support: "supported", availability: "available", evidence: ["ev_ghost"] },
        table,
      ),
    ).toBe(false);
    // And without ANY table there is no usable claim at all.
    expect(
      capabilityIsUsable(
        { support: "supported", availability: "available", evidence: ["ev_receipt_1"] },
        [],
      ),
    ).toBe(false);
  });

  it("the supplied table itself must contain complete VALIDATED refs", () => {
    // A bare stub cannot serve as an index entry.
    expect(() =>
      capabilityIsUsable(
        { support: "supported", availability: "available", evidence: ["x"] },
        [{ id: "x", fake: true } as never],
      ),
    ).toThrow(NecValidationError);
  });

  it("FREEZE-FINAL: table index getters are NEVER invoked (invocation count == 0)", () => {
    let invocations = 0;
    const hostileTable: unknown[] = [];
    Object.defineProperty(hostileTable, 0, {
      enumerable: true,
      configurable: true,
      get() {
        invocations += 1;
        return evidenceRef({ id: "ev_receipt_1" });
      },
    });
    hostileTable.length = 1;
    expect(() =>
      capabilityIsUsable(
        { support: "supported", availability: "available", evidence: ["ev_receipt_1"] },
        hostileTable as never,
      ),
    ).toThrow(NecValidationError);
    expect(invocations).toBe(0);
  });

  it("FREEZE-FINAL: a custom Symbol.iterator on the table cannot swap IDs", () => {
    let iteratorRuns = 0;
    const lyingTable = [evidenceRef({ id: "ev_real" })];
    Object.defineProperty(lyingTable, Symbol.iterator, {
      value: function* () {
        iteratorRuns += 1;
        yield evidenceRef({ id: "ev_ghost", sourceId: "ghost" });
      },
      configurable: true,
    });
    // The override is rejected under the inert-array model BEFORE any
    // element is read — the lying iterator never runs, and the real
    // contents are the only thing that could ever resolve.
    expect(() =>
      capabilityIsUsable(
        { support: "supported", availability: "available", evidence: ["ev_ghost"] },
        lyingTable as never,
      ),
    ).toThrow(/symbol-keyed array properties/);
    expect(iteratorRuns).toBe(0);
  });

  it("FREEZE-FINAL: duplicate EvidenceIds in the supplied table are rejected (no last-write-wins)", () => {
    expect(() =>
      capabilityIsUsable(
        { support: "supported", availability: "available", evidence: ["ev_receipt_1"] },
        [evidenceRef(), evidenceRef({ id: "ev_receipt_1", sourceId: "duplicate" })],
      ),
    ).toThrow(/duplicate EvidenceId/);
  });

  it("FREEZE-FINAL: a getter on the CapabilityState itself is rejected without executing", () => {
    let invocations = 0;
    const hostileState: Record<string, unknown> = {};
    Object.defineProperty(hostileState, "support", {
      enumerable: true,
      configurable: true,
      get() {
        invocations += 1;
        return "supported";
      },
    });
    hostileState.availability = "available";
    expect(() =>
      capabilityIsUsable(hostileState as never, TABLE()),
    ).toThrow(NecValidationError);
    expect(invocations).toBe(0);
  });

  it("conditional support is never 'usable'", () => {
    for (const availability of ["available", "degraded", "unavailable", "unknown"] as const) {
      expect(
        capabilityIsUsable(
          { support: "conditional", availability, evidence: ["ev_receipt_1"] },
          TABLE(),
        ),
      ).toBe(false);
    }
  });
});

describe("fail-closed validation", () => {
  it("rejects unknown enum values anywhere in a result", () => {
    const content = validResultContent();
    (content.networkEvidence.execution as { verdict: string }).verdict = "verified";
    expect(() =>
      buildNetworkEvidenceResult(content, resultContext()),
    ).toThrow(NecValidationError);
  });

  it("rejects malformed identifiers, ISO-8601 and digest shapes", () => {
    const badHash = validResultContent();
    (badHash.subject as { txId?: string }).txId = "";
    expect(() => buildNetworkEvidenceResult(badHash, resultContext())).toThrow();

    const badTime = validResultContent();
    badTime.evidence[0] = evidenceRef({ id: "ev_receipt_1", retrievedAt: "yesterday" });
    expect(() => buildNetworkEvidenceResult(badTime, resultContext())).toThrow();

    // Timezone aliases are NOT canonical UTC.
    const offsetTime = validResultContent();
    offsetTime.generatedAt = "2026-01-02T13:30:00.000+01:00";
    expect(() => buildNetworkEvidenceResult(offsetTime, resultContext())).toThrow(
      /canonical UTC/,
    );

    const noMillis = validResultContent();
    noMillis.generatedAt = "2026-01-02T12:30:00Z";
    expect(() => buildNetworkEvidenceResult(noMillis, resultContext())).toThrow(/canonical UTC/);

    // Impossible calendar date (2026-02-30).
    const impossible = validResultContent();
    impossible.evidence[0] = evidenceRef({ id: "ev_receipt_1", retrievedAt: "2026-02-30T00:00:00.000Z" });
    expect(() => buildNetworkEvidenceResult(impossible, resultContext())).toThrow(/calendar/);

    const badDigest = validResultContent();
    badDigest.policy = { ...badDigest.policy, digest: "sha256:tooshort" };
    expect(() => buildNetworkEvidenceResult(badDigest, resultContext())).toThrow();
  });

  it("invariant: SUPPORTED without EvidenceRef support cannot be built", () => {
    const content = validResultContent();
    content.networkEvidence.execution = {
      applicability: "applicable",
      verdict: "supported",
      basis: ["source_observation"],
      evidence: [],
    };
    expect(() => buildNetworkEvidenceResult(content, resultContext())).toThrow(
      /non-empty evidence required/,
    );

    const dangling = validResultContent();
    dangling.networkEvidence.execution.evidence = ["ev_ghost"];
    expect(() => buildNetworkEvidenceResult(dangling, resultContext())).toThrow(/no EvidenceRef/);

    const raw = { ...validResultContent(), semanticDigest: `sha256:${"0".repeat(64)}`, artifactDigest: `sha256:${"0".repeat(64)}` };
    raw.networkEvidence.execution.evidence = [];
    expect(() => validateNetworkEvidenceResult(raw)).toThrow();
  });

  it("material conflicts scoped to the proposition block supported verdicts at artifact level", () => {
    const content = validResultContent();
    content.conflicts = [
      mkConflict({
        id: "c1",
        material: true,
        scope: { kind: "dimension", dimension: "execution" },
        evidence: ["ev_receipt_1"],
      }),
    ];
    expect(() => buildNetworkEvidenceResult(content, resultContext())).toThrow(
      /prevent "supported"/,
    );

    const soft = validResultContent();
    soft.conflicts = [
      mkConflict({
        id: "c1",
        material: false,
        scope: { kind: "dimension", dimension: "execution" },
        evidence: ["ev_receipt_1"],
      }),
    ];
    expect(() => buildNetworkEvidenceResult(soft, resultContext())).not.toThrow();
  });

  it("rejects reserved score keys (no confidence/trust scores exist in NEC)", () => {
    for (const key of ["confidence", "trustScore", "securityScore", "probability"]) {
      const content = validResultContent();
      content.warnings = [{ code: "W", message: "m", metadata: { [key]: 0.9 } }];
      expect(() => buildNetworkEvidenceResult(content, resultContext())).toThrow(/reserved key/);
    }
  });

  it("rejects non-plain metadata values (class instances, undefined)", () => {
    const content = validResultContent();
    (content.evidence[0] as { metadata?: Record<string, unknown> }).metadata = {
      when: new Date(0),
    };
    expect(() => buildNetworkEvidenceResult(content, resultContext())).toThrow();

    const withUndefined = validResultContent();
    (withUndefined.evidence[0] as { metadata?: Record<string, unknown> }).metadata = { x: undefined };
    expect(() => buildNetworkEvidenceResult(withUndefined, resultContext())).toThrow();

    // Generic metadata must not carry bigint either (wire profile boundary).
    const withBigint = validResultContent();
    (withBigint.evidence[0] as { metadata?: Record<string, unknown> }).metadata = { n: 5n };
    expect(() => buildNetworkEvidenceResult(withBigint, resultContext())).toThrow(/JSON-safe/);
  });

  it("rejects duplicate evidence ids and wrong schemaVersion", () => {
    const dupes = validResultContent();
    dupes.evidence = [evidenceRef(), evidenceRef()];
    expect(() => buildNetworkEvidenceResult(dupes, resultContext())).toThrow();

    const version = validResultContent();
    (version as { schemaVersion: string }).schemaVersion = "1.0";
    expect(() => buildNetworkEvidenceResult(version, resultContext())).toThrow();
  });

  it("deepFreeze produces deeply immutable structures", () => {
    const snapshot = fullSnapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.anchors)).toBe(true);
    expect(Object.isFrozen(snapshot.networkFingerprint.observedAt)).toBe(true);
    expect(() => {
      "use strict";
      (snapshot as { id: string }).id = "tampered";
    }).toThrow();
  });

  it("empty observed anchors claim nothing — permitted, never upgraded to a claim", () => {
    const snapshot = buildEvidenceSnapshot({
      id: "snap_empty_anchor",
      createdAt: "2026-01-01T00:00:00.000Z",
      networkFingerprint: fingerprint({ observedAt: {} }),
      anchors: [],
      evidence: [evidenceRef()],
      resolverManifestDigest: fullSnapshot().resolverManifestDigest,
      policyDigest: fullSnapshot().policyDigest,
    });
    expect(snapshot.networkFingerprint.observedAt).toEqual({});
  });

  it("optional fields explicitly set to undefined are INVALID (absent only)", async () => {
    const { validateNetworkAnchor } = await import("../src/index.js");
    const anchor: Record<string, unknown> = { blockNumber: undefined };
    expect(() => validateNetworkAnchor(anchor, "anchor")).toThrow(
      /explicitly-undefined field/,
    );
    // Absent is fine.
    expect(() => validateNetworkAnchor({}, "anchor")).not.toThrow();
  });
});
