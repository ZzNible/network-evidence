import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { canonicalJson } from "@nec/core";

import { loadReviewedCaseStore, REVIEWED_COLLECTION_SHA256 } from "../src/cases.js";
import { NeMcpError } from "../src/errors.js";

const collectionPath = fileURLToPath(new URL("../../../examples/ne-maps/data/collection.json", import.meta.url));
const bytes = readFileSync(collectionPath);
const collection = JSON.parse(bytes.toString("utf8"));
const store = loadReviewedCaseStore();

function propositionAvailabilities(lens: any): string[] {
  return (lens.propositions ?? []).map((p: { availability: string }) => p.availability);
}

describe("get_reviewed_evidence_case store", () => {
  it("serves exactly the shipped case ids, pinned by sha256", () => {
    expect(store.caseIds).toEqual(["f1", "f2", "f3", "synthetic-local-core-golden"]);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(REVIEWED_COLLECTION_SHA256);
    for (const id of store.caseIds) {
      const out = store.get(id);
      expect(out.source.sha256).toBe(REVIEWED_COLLECTION_SHA256);
      expect(out.source.path).toBe("examples/ne-maps/data/collection.json");
    }
  });

  it("returns every envelope verbatim (Lens, limitations, unavailable/unknown states, extensions)", () => {
    for (const [index, id] of store.caseIds.entries()) {
      const out = store.get(id);
      expect(out.envelope).toEqual(collection.cases[index]);
      expect(canonicalJson(out.envelope)).toBe(canonicalJson(collection.cases[index]));
      expect(out.caseProvenance).toEqual(collection.cases[index].extensions.provenance);
      expect(out.collectionNonClaims).toEqual(collection.nonClaims);
    }
    const synthetic = store.get("synthetic-local-core-golden").envelope as any;
    expect(propositionAvailabilities(synthetic.lens)).toEqual(expect.arrayContaining(["unknown", "not_applicable"]));
    expect(store.get("f2").envelope.extensions).toHaveProperty("reviewedSelectorOutcomes");
  });

  it("labels historical vs synthetic explicitly; nothing is live", () => {
    for (const id of ["f1", "f2", "f3"]) {
      const out = store.get(id);
      expect(out.evidenceClass).toBe("historical-reviewed-public-network-fixture");
      expect(out.label).toMatch(/^HISTORICAL/);
      expect(out.label).toMatch(/Not a live observation/);
    }
    const synthetic = store.get("synthetic-local-core-golden");
    expect(synthetic.evidenceClass).toBe("synthetic-local-fixture");
    expect(synthetic.label).toMatch(/^SYNTHETIC \/ LOCAL FIXTURE — not a network observation/);
    for (const id of store.caseIds) {
      const out = store.get(id);
      expect(out.liveObservation).toBe(false);
      expect(out.currentAvailability).toBe("unknown");
      expect(out.serverNonClaims.join(" ")).toMatch(/No case is live evidence/);
    }
    expect(store.get("synthetic-local-core-golden").collectionNonClaims).toContain(
      "Synthetic/local cases are fixtures for integrability, not network observations.",
    );
  });

  it("rejects anything but an exact known id (no paths, no case folding)", () => {
    for (const bad of ["F1", "f1 ", "f4", "", "../data/cases.json", "examples/ne-maps/data/collection.json", "__proto__", "constructor"]) {
      expect(() => store.get(bad)).toThrow(NeMcpError);
      try {
        store.get(bad);
      } catch (error) {
        expect((error as NeMcpError).code).toBe("MCP_CASE_UNKNOWN");
        if (bad.length > 0) expect((error as Error).message).not.toContain(bad);
      }
    }
  });

  it("returns deep-frozen outputs", () => {
    const out = store.get("f1");
    expect(Object.isFrozen(out)).toBe(true);
    expect(Object.isFrozen(out.envelope)).toBe(true);
  });
});
