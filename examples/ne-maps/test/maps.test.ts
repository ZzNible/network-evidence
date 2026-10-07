import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const legacy = JSON.parse(await readFile(join(root, "data/cases.json"), "utf8"));
const data = JSON.parse(await readFile(join(root, "data/collection.json"), "utf8"));
const app = await readFile(join(root, "app.js"), "utf8");
const readme = await readFile(join(root, "README.md"), "utf8");

function keys(value: unknown, out = new Set<string>()): Set<string> {
  if (!value || typeof value !== "object") return out;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    out.add(key);
    keys(nested, out);
  }
  return out;
}

describe("NE Maps minimal export", () => {
  it("pins the frozen reviewed legacy export bytes", async () => {
    const bytes = await readFile(join(root, "data/cases.json"));
    const actual = createHash("sha256").update(bytes).digest("hex");
    const manifest = (await readFile(join(root, "data/CASES.sha256"), "utf8")).trim();
    expect(manifest).toBe(actual + "  cases.json");
    expect(actual).toBe("eef096d0e774bef6ce2b9c111218b52be19d00613c75eb538ce8f936ccf580e1");
  });

  it("keeps the reviewed legacy export pinned to its authority while Maps loads the versioned collection", () => {
    expect(legacy.schemaVersion).toBe("ne-maps/v0.1");
    expect(legacy.sourceAuthority.commit).toBe("586a81a39c8da4d3a0dc0e879b605aabfd3f8d1d");
    expect(legacy.publicSuite.commit).toBe("e536ca1c63465ebb2de46c855a01bac71e4dc768");
    expect(legacy.TARGET_CORE_MUTATIONS).toBe(0);
    expect(legacy.cases.map((item: { id: string }) => item.id)).toEqual(["f1", "f2", "f3"]);
    expect(data.schemaVersion).toBe("ne-maps-case-collection/v0.1");
    expect(data.TARGET_CORE_MUTATIONS).toBe(0);
    expect(app).toContain("./data/collection.json");
    expect(app).not.toContain("cases.json");
  });

  it("keeps exact-action and Trail handoffs internally consistent", () => {
    for (const item of data.cases) {
      expect(item.exactAction.networkId).toBeTruthy();
      expect(item.exactAction.id).toBeTruthy();
      const propositionIds = new Set(item.lens.propositions.map((p: { propositionId: string }) => p.propositionId));
      for (const id of item.trailPropositionOrder) expect(propositionIds.has(id)).toBe(true);
    }
    expect(app).toContain("#/case/${item.id}/lens");
    expect(app).toContain("#/case/${item.id}/trail");
    expect(app).toContain("#/case/${item.id}/action");
  });

  it("preserves all reviewed verdict and unavailable states without scoring", () => {
    const values = new Set<string>();
    for (const item of data.cases) {
      for (const proposition of item.lens.propositions) {
        for (const assessment of proposition.assessments ?? []) values.add(assessment.value);
        if (proposition.availability === "unavailable") values.add("unavailable");
      }
      for (const outcome of item.extensions?.reviewedSelectorOutcomes ?? []) values.add(outcome.verdict);
    }
    expect([...values].sort()).toEqual(["ambiguous", "contradicted", "insufficient", "supported", "unavailable"]);
    const forbiddenKeys = ["caseVerdict", "confidence", "trustScore"];
    const allKeys = keys(data);
    for (const key of forbiddenKeys) expect(allKeys.has(key)).toBe(false);
  });

  it("does not add resolver or Syscoin-specific product logic", () => {
    expect(app).not.toMatch(/@nec\/resolver|eth_get|syscoin|zksys/i);
    expect(readme).not.toMatch(/syscoin|zksys/i);
    expect(data.nonClaims).toContain("Maps does not resolve network evidence.");
  });

  it("keeps F1 Lens-only source context explicitly outside the network-action Trail order", () => {
    const f1 = data.cases.find((item: { id: string }) => item.id === "f1");
    expect(f1.extensions.trailContextNote).toMatch(/Lens-only context/);
    expect(f1.trailPropositionOrder).not.toContain("source-p-f1-public-issue-claim-1062");
  });

  it("keeps F2 case statuses separate from frozen selector-check outcomes", () => {
    const f2 = data.cases.find((item: { id: string }) => item.id === "f2");
    const propositionStates = new Set<string>();
    for (const proposition of f2.lens.propositions) {
      for (const assessment of proposition.assessments ?? []) propositionStates.add(assessment.value);
      if (proposition.availability === "unavailable") propositionStates.add("unavailable");
    }
    expect([...propositionStates].sort()).toEqual(["supported", "unavailable"]);
    expect(f2.extensions.reviewedSelectorOutcomes).toEqual([
      { label: "Exact userOpHash + sender", verdict: "supported" },
      { label: "Unknown userOpHash", verdict: "insufficient" },
      { label: "Exact userOpHash + wrong sender", verdict: "contradicted" },
      { label: "Repeated sender only", verdict: "ambiguous" }
    ]);
  });
});
