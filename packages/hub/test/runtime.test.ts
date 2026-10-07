import { encodeNecWireJson } from "@nec/core";
import type { NetworkEvidenceResult } from "@nec/core";
import { describe, expect, it } from "vitest";

import {
  HUB_RECORD_SCHEMA_VERSION,
  normalizeNetworkEvidenceV01,
} from "../src/index.js";
import {
  buildSyntheticCoreResult,
  buildSyntheticCoreWire,
  SYNTHETIC_ARTIFACT_DIGEST,
  SYNTHETIC_SEMANTIC_DIGEST,
} from "../../../examples/integrability-fixture/golden-core.js";

describe("@nec/hub v0.1 runtime", () => {
  it("admits a valid Core object through Core validation and detaches caller mutation", () => {
    const mutable = structuredClone(buildSyntheticCoreResult()) as NetworkEvidenceResult;
    const hub = normalizeNetworkEvidenceV01({ kind: "network_evidence_result", result: mutable });

    expect(hub.schemaVersion).toBe(HUB_RECORD_SCHEMA_VERSION);
    expect(hub.validation).toEqual({
      validator: "@nec/core",
      method: "validateNetworkEvidenceResult",
      wireProfile: null,
    });
    expect(hub.result.semanticDigest).toBe(SYNTHETIC_SEMANTIC_DIGEST);
    expect(hub.result.artifactDigest).toBe(SYNTHETIC_ARTIFACT_DIGEST);
    expect(hub.result.networkEvidence.execution.verdict).toBe("supported");
    expect(hub.result.networkEvidence.execution.basis).toEqual(["source_observation"]);
    expect(hub.result.networkEvidence.observedEffects).toHaveLength(1);
    expect(Object.isFrozen(hub)).toBe(true);
    expect(Object.isFrozen(hub.result)).toBe(true);

    mutable.requestId = "req_mutated_after_admission";
    expect(hub.result.requestId).toBe("req_1");
  });

  it("admits the public Core wire through Core decoding", () => {
    const wire = buildSyntheticCoreWire();
    const hub = normalizeNetworkEvidenceV01({
      kind: "nec_wire_json_v1",
      wireType: "network-evidence-result",
      wire,
    });

    expect(hub.validation).toEqual({
      validator: "@nec/core",
      method: "decodeNecWireJson",
      wireProfile: "nec-wire-json-v1",
    });
    expect(encodeNecWireJson("network-evidence-result", hub.result)).toBe(wire);
  });

  it("fails closed on invalid, incompatible, or extra input", () => {
    const tampered = structuredClone(buildSyntheticCoreResult()) as NetworkEvidenceResult;
    tampered.semanticDigest = `sha256:${"00".repeat(32)}`;
    expect(() => normalizeNetworkEvidenceV01({ kind: "network_evidence_result", result: tampered })).toThrow();

    expect(() => normalizeNetworkEvidenceV01({
      kind: "nec_wire_json_v1",
      wireType: "network-evidence-result",
      wire: "{}",
    })).toThrow();

    expect(() => normalizeNetworkEvidenceV01({ kind: "unknown" } as never)).toThrow(/unsupported input kind/);
    expect(() => normalizeNetworkEvidenceV01({
      kind: "network_evidence_result",
      result: buildSyntheticCoreResult(),
      confidence: 0.99,
    } as never)).toThrow(/unsupported/);
  });
});
