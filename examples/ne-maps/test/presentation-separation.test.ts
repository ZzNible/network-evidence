import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCaseHash } from "../ui-navigation.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const app = await readFile(join(root, "app.js"), "utf8");
const styles = await readFile(join(root, "styles.css"), "utf8");
const examples = JSON.parse(await readFile(join(root, "data/collection.json"), "utf8"));

describe("NE Maps presentation: cases, Lens and Trail", () => {
  it("opens an empty app collection by default, not a fixture atlas", () => {
    expect(parseCaseHash("")).toEqual({ kind: "atlas", scope: "mine" });
    expect(parseCaseHash("#/")).toEqual({ kind: "atlas", scope: "mine" });
    expect(parseCaseHash("#/mine")).toEqual({ kind: "atlas", scope: "mine" });
    expect(parseCaseHash("#/examples")).toEqual({ kind: "atlas", scope: "examples" });
    expect(app).toContain('const MY_COLLECTION_URL = "./data/my-collection.json"');
    expect(app).toContain("No application cases loaded");
    expect(app).toContain("Built-in example fixtures do not appear here.");
    expect(app).toContain("mineError");
  });

  it("keeps case identities namespaced and preserves legacy /case links", () => {
    expect(parseCaseHash("#/case/f2/lens")).toEqual({
      kind: "detail", scope: "examples", caseId: "f2", view: "lens"
    });
    expect(parseCaseHash("#/examples/f2/trail")).toEqual({
      kind: "detail", scope: "examples", caseId: "f2", view: "trail"
    });
    expect(parseCaseHash("#/mine/f2/action")).toEqual({
      kind: "detail", scope: "mine", caseId: "f2", view: "action"
    });
    for (const input of ["#/mine/../../f2/lens", "#/mine/f2/finality", "#/mine/f2", "#/other/f2/lens", "#/mine/%2f/action"]) {
      expect(parseCaseHash(input)).toEqual({ kind: "atlas", scope: "mine" });
    }
    expect(app).toContain('source?.cases.find(candidate => candidate.id === state.caseId)');
  });

  it("leaves reviewed example cases unchanged", () => {
    expect(examples.cases).toHaveLength(5);
    expect(examples.cases.some((entry: { id: string }) => entry.id === "synthetic-local-core-golden")).toBe(true);
    expect(app).toContain("validateNeMapsCollectionV01(await response.json())");
    expect(app).toContain("validateNeMapsCollectionV01(await own.json())");
    expect(app).not.toContain("localStorage");
    expect(app).not.toContain("sessionStorage");
  });

  it("renders Lens edges only from provided relation objects, never inferred connections", () => {
    expect(app).toContain("for (const relation of relations)");
    expect(app).toContain("relation.fromRef");
    expect(app).toContain("relation.toRef");
    expect(app).toContain("relation.relationType");
    expect(app).toContain("relation.basis");
    expect(app).toContain("not a claim of chronology, causation, settlement or finality");
    expect(styles).toContain(".relation-edge");
    expect(app).not.toContain("caseVerdict");
    expect(app).not.toContain("trustScore");
  });

  it("renders Trail from existing proposition ids, with visible omitted Lens context", () => {
    expect(app).toContain("for (const id of item.trailPropositionOrder)");
    expect(app).toContain("const proposition = byId.get(id)");
    expect(app).toContain("additional Lens-only proposition(s)");
    expect(app).toContain("propositionEvidence(proposition)");
    expect(app).toContain("renderedIds.has(id)");
    expect(app).toContain("not a verified chronological sequence or causal route");
    expect(styles).toContain(".trail-steps");
    expect(styles).toContain(".relation-graph");
  });
});
