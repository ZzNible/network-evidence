import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { normalizeNetworkEvidenceV01 } from "@nec/hub";
import {
  buildLensCaseFromHubV01,
  projectLensBrowserSafeV01,
  serializeLensBrowserSafeV01,
  serializeLensCaseV01,
  validateLensBrowserSafeCaseV01,
  validateLensCaseV01,
} from "../src/index.js";
import { hubRevisionDigestV01 } from "../src/canonical.js";
import {
  buildSyntheticCoreResult,
  buildSyntheticCoreWire,
  SYNTHETIC_ARTIFACT_DIGEST,
  SYNTHETIC_SEMANTIC_DIGEST,
} from "../../../examples/integrability-fixture/golden-core.js";

const META = {
  caseId: "synthetic-core-golden-v0.1",
  namespace: "nec.integrability",
  createdAt: "2026-10-07T00:00:00.000Z",
} as const;

function fromObject() {
  return buildLensCaseFromHubV01({
    hubRecord: normalizeNetworkEvidenceV01({ kind: "network_evidence_result", result: buildSyntheticCoreResult() }),
    ...META,
  });
}

function fromWire() {
  return buildLensCaseFromHubV01({
    hubRecord: normalizeNetworkEvidenceV01({
      kind: "nec_wire_json_v1",
      wireType: "network-evidence-result",
      wire: buildSyntheticCoreWire(),
    }),
    ...META,
  });
}

describe("@nec/lens v0.1 generic runtime", () => {
  it("builds and validates a generic Lens case without inventing verdicts", () => {
    const lens = fromObject();
    expect(() => validateLensCaseV01(lens)).not.toThrow();
    expect(lens.schemaVersion).toBe("lens-case/v0.1");
    expect(lens.TARGET_CORE_MUTATIONS).toBe(0);
    expect(lens.coreResultPreservation?.sourceSemanticDigest).toBe(SYNTHETIC_SEMANTIC_DIGEST);
    expect(lens.coreResultPreservation?.sourceArtifactDigest).toBe(SYNTHETIC_ARTIFACT_DIGEST);

    const execution = lens.propositions.find((p) => p.propositionId === "network.execution");
    expect(execution?.assessments).toHaveLength(1);
    expect(execution?.assessments[0]?.value).toBe("supported");
    expect(execution?.assessments[0]?.basis).toEqual(["source_observation"]);

    const dataBinding = lens.propositions.find((p) => p.propositionId === "network.dataBinding");
    const settlement = lens.propositions.find((p) => p.propositionId === "network.settlement");
    const finality = lens.propositions.find((p) => p.propositionId === "network.finality");
    expect(dataBinding?.availability).toBe("not_applicable");
    expect(dataBinding?.assessments).toEqual([]);
    expect(settlement?.availability).toBe("unknown");
    expect(settlement?.assessments).toEqual([]);
    expect(finality?.availability).toBe("unknown");
    expect(finality?.assessments).toEqual([]);

    const effect = lens.propositions.find((p) => p.propositionId === "network.observed_effect:effect_1");
    expect(effect?.assessments).toEqual([]);
    expect(effect?.limitations.join(" ")).toMatch(/without an added Lens verdict/i);
  });

  it("produces identical Lens bytes from Core object and public wire", () => {
    const objectBytes = serializeLensCaseV01(fromObject());
    const wireBytes = serializeLensCaseV01(fromWire());
    expect(wireBytes).toBe(objectBytes);
    expect(serializeLensCaseV01(fromObject())).toBe(objectBytes);
  });

  it("fails closed on malformed Lens authority fields and invalid NE vocabulary", () => {
    const tampered = structuredClone(fromObject()) as unknown as Record<string, unknown>;
    tampered.caseVerdict = "supported";
    expect(() => validateLensCaseV01(tampered)).toThrow(/forbidden authority field/);

    const invalidVerdict = structuredClone(fromObject()) as any;
    invalidVerdict.propositions.find((p: any) => p.propositionId === "network.execution")
      .assessments[0].value = "completed";
    expect(() => validateLensCaseV01(invalidVerdict)).toThrow(/invalid Network Evidence verdict/);

    const vocabularyAbuse = structuredClone(fromObject()) as any;
    const assessment = vocabularyAbuse.propositions.find((p: any) => p.propositionId === "network.execution")
      .assessments[0];
    assessment.evaluator.type = "other_evaluator";
    assessment.value = "finalized";
    const { revisionDigest: _oldDigest, ...body } = vocabularyAbuse;
    vocabularyAbuse.revisionDigest = hubRevisionDigestV01(body);
    expect(() => validateLensCaseV01(vocabularyAbuse)).toThrow(/invalid Network Evidence verdict/);
  });

  it("projects a deterministic browser-safe allowlist", () => {
    const browser = projectLensBrowserSafeV01(fromObject());
    expect(() => validateLensBrowserSafeCaseV01(browser)).not.toThrow();
    expect(browser.projectionPolicy).toBe("lens-browser/v0.1");
    expect(browser.revisionDigest).toBeNull();
    expect(browser.revisionDigestVisibility).toBe("withheld_by_browser_policy");
    expect(browser.artifacts.every((artifact) => artifact.locatorRef === null)).toBe(true);
    expect(browser.artifacts.every((artifact) => artifact.artifactDigest === null)).toBe(true);
    expect(browser.coreResultPreservation?.observedEffectIds).toEqual(["effect_1"]);
    expect("observedEffects" in (browser.coreResultPreservation ?? {})).toBe(false);

    const bytes = serializeLensBrowserSafeV01(browser);
    expect(serializeLensBrowserSafeV01(projectLensBrowserSafeV01(fromObject()))).toBe(bytes);
    expect(bytes).not.toContain("eth_getTransactionReceipt");
    expect(bytes).not.toContain("10000000");

    const nested = structuredClone(fromObject()) as any;
    const nestedAssessment = nested.propositions.find((p: any) => p.propositionId === "network.execution")
      .assessments[0];
    nestedAssessment.inputRefs = [{ locatorRef: "https://rpc.example/?key=SECRET", payload: "<raw>" }];
    nestedAssessment.confidence = 0.99;
    const { revisionDigest: _oldDigest, ...body } = nested;
    nested.revisionDigest = hubRevisionDigestV01(body);
    const projected = projectLensBrowserSafeV01(nested);
    const projectedBytes = serializeLensBrowserSafeV01(projected);
    expect(projectedBytes).not.toContain("SECRET");
    expect(projectedBytes).not.toContain("<raw>");
    expect(projectedBytes).not.toContain("confidence");
    expect("inputRefs" in projected.propositions[0]!.assessments[0]!).toBe(false);
  });

  it("enforces the browser serialization byte budget before unbounded accumulation", () => {
    const browser = structuredClone(projectLensBrowserSafeV01(fromObject())) as any;
    const repeated = "a".repeat(1_000_000);
    browser.limitations = Array(9).fill(repeated);
    expect(() => validateLensBrowserSafeCaseV01(browser)).toThrow(/canonical output exceeds byte limit/);
  });

  it("accepts the three historical browser-safe F1/F2/F3 projections unchanged", () => {
    const path = fileURLToPath(new URL("../../../examples/ne-maps/data/cases.json", import.meta.url));
    const data = JSON.parse(readFileSync(path, "utf8")) as { cases: Array<{ id: string; lens: unknown }> };
    expect(data.cases.map((item) => item.id)).toEqual(["f1", "f2", "f3"]);
    for (const item of data.cases) {
      expect(() => validateLensBrowserSafeCaseV01(item.lens)).not.toThrow();
    }
  });
});
