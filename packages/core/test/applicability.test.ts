import { describe, expect, it } from "vitest";

import {
  APPLICABILITIES,
  EVIDENCE_BASES,
  EVIDENCE_DIMENSION_NAMES,
  EVIDENCE_VERDICTS,
  combineApplicability,
  isApplicability,
  isEvidenceBasis,
  isEvidenceDimensionName,
  isEvidenceVerdict,
} from "../src/index.js";

describe("applicability semantics", () => {
  it("exposes exactly the contract enum values", () => {
    expect([...APPLICABILITIES]).toEqual(["applicable", "not_applicable", "unknown"]);
    expect([...EVIDENCE_DIMENSION_NAMES]).toEqual(["execution", "dataBinding", "settlement", "finality"]);
    expect([...EVIDENCE_VERDICTS]).toEqual([
      "supported",
      "contradicted",
      "insufficient",
      "ambiguous",
    ]);
    expect([...EVIDENCE_BASES]).toEqual([
      "source_observation",
      "deterministic_derivation",
      "local_content_verification",
      "local_consensus_engine",
      "cryptographic_verification",
    ]);
  });

  it("guards fail closed on unknown or malformed vocabulary", () => {
    for (const guard of [isApplicability, isEvidenceVerdict]) {
      expect(guard("supported")).toBe(guard === isEvidenceVerdict);
      expect(guard("SUPPORTED")).toBe(false); // case-sensitive
      expect(guard("verified")).toBe(false);
      expect(guard(true)).toBe(false);
      expect(guard(undefined)).toBe(false);
    }
    expect(isEvidenceBasis("local_content_verification")).toBe(true);
    expect(isEvidenceBasis("trust_score")).toBe(false);
    expect(isEvidenceDimensionName("execution")).toBe(true);
    expect(isEvidenceDimensionName("observedEffects")).toBe(false); // effects are not a fixed dimension
  });

  it("combines applicability without conflating not_applicable and unknown", () => {
    expect(combineApplicability("not_applicable", "not_applicable")).toBe("not_applicable");
    expect(combineApplicability("applicable", "applicable")).toBe("applicable");
    expect(combineApplicability("unknown", "unknown")).toBe("unknown");
    // Any unknown part forces unknown — never a verdict.
    expect(combineApplicability("applicable", "unknown")).toBe("unknown");
    expect(combineApplicability("not_applicable", "unknown")).toBe("unknown");
    // A genuinely applicable part makes the whole applicable; the
    // inapplicable part does not degrade it to insufficient/unknown.
    expect(combineApplicability("not_applicable", "applicable")).toBe("applicable");
    expect(combineApplicability("applicable", "not_applicable")).toBe("applicable");
  });
});
