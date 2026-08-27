import { describe, expect, it } from "vitest";

import * as opstack from "../src/index.js";

describe("public API surface (@nec/resolver-opstack v0.1 entrypoint)", () => {
  it("exposes exactly the conceptual acquisition/evaluation/replay surfaces", () => {
    expect(typeof opstack.acquireOpStackFinalityObservation).toBe("function");
    expect(typeof opstack.evaluateOpStackFinality).toBe("function");
    expect(typeof opstack.replayOpStackFinalityObservation).toBe("function");
    expect(typeof opstack.buildOpStackFinalityFixture).toBe("function");
    expect(typeof opstack.validateOpStackFinalityConfig).toBe("function");
    expect(typeof opstack.validateOpStackFinalityFixture).toBe("function");
    expect(typeof opstack.runOpStackFinalityPipeline).toBe("function");
  });

  it("pins the versioned profiles and ruleset identifiers", () => {
    expect(opstack.OPSTACK_ACQUISITION_PROFILE).toBe("nec-resolver-opstack-acquisition-v1");
    expect(opstack.OPSTACK_EVALUATION_PROFILE).toBe("nec-resolver-opstack-evaluation-v1");
    expect(opstack.OPSTACK_FIXTURE_PROFILE).toBe("nec-resolver-opstack-fixture-v1");
    expect(opstack.OPSTACK_FINALITY_RULESET).toBe("opstack.rpc-finalized-head-v1");
    expect(opstack.OPSTACK_FINALITY_RULESET_VERSION).toBe("1");
  });

  it("keeps evaluation internals out of the public namespace", async () => {
    const ns = opstack as unknown as Record<string, unknown>;
    for (const name of [
      "buildFinalityEvidenceRefs",
      "citationIndex",
      "STANDING_LIMITATION_WARNINGS",
      "FINALITY_SCOPE",
      "checkOfCode",
      "genericCheckOfCode",
      "buildOpStackConflict",
      "assemble",
    ]) {
      expect(ns[name], name).toBeUndefined();
    }
  });

  it("depends only on @nec/core and @nec/resolver-evm public packages", async () => {
    const { readFileSync } = await import("node:fs");
    const pkg = JSON.parse(
      readFileSync(fileUrl("../package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["@nec/core", "@nec/resolver-evm"]);
  });
});

import { fileURLToPath } from "node:url";
function fileUrl(relative: string): string {
  return fileURLToPath(new URL(relative, import.meta.url));
}
