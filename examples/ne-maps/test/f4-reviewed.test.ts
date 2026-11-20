import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { validateLensBrowserSafeCaseV01 } from "@nec/lens";
import { buildNeMapsCollectionV01 } from "../build-collection.js";
import { validateNeMapsCollectionV01 } from "../collection.js";
import { loadReviewedCaseStore } from "../../../packages/mcp/src/cases.js";

const folder = dirname(dirname(fileURLToPath(import.meta.url)));
const frozen = readFileSync(join(folder, "data/f4-reviewed.json"));
const pin = readFileSync(join(folder, "data/F4_REVIEWED.sha256"), "utf8");
const collection = buildNeMapsCollectionV01();
const f4 = collection.cases.find((item) => item.id === "zksys-genesis-20261118")!;

describe("F4 source-bound zkSYS Genesis fifth case", () => {
  it("has exact frozen byte pin and retains the four older cases, without a chain-specific Maps UI", () => {
    expect(pin).toBe(createHash("sha256").update(frozen).digest("hex") + "  f4-reviewed.json\n");
    expect(collection.cases.map((item) => item.id)).toEqual([
      "f1", "f2", "f3", "synthetic-local-core-golden", "zksys-genesis-20261118",
    ]);
    expect(f4.exactAction.networkId).toBe("eip155:57057");
    expect(f4.exactAction.id).toBe("0xa018d61db50752eeda10c6d52b51fd1741cc8eb41db46d9b972677539d5fef0b");
    expect(f4.extensions?.provenance?.originalCaptureSha256).toBe(
      "a223831d3a304737e0f9e5004b25ebc1e8f18a754679b13a4770e506462384d8",
    );
    expect(() => validateNeMapsCollectionV01(collection, { validateLens: validateLensBrowserSafeCaseV01 })).not.toThrow();
  });

  it("presents five source steps, mock proof, insufficient PoDA/ChainLock and no upgraded Core finality", () => {
    const propositions = f4.lens.propositions.filter((p) => p.propositionId.startsWith("f4:"));
    expect(propositions).toHaveLength(11);
    expect(propositions.filter((p) => p.assessments[0]?.value === "supported")).toHaveLength(6);
    expect(propositions.filter((p) => p.assessments[0]?.value === "insufficient")).toHaveLength(5);
    expect(propositions.every((p) => p.assessments[0]?.vocabulary === "f4_external_source_join/v0.1")).toBe(true);
    expect(f4.trailPropositionOrder).toHaveLength(5);
    expect(f4.lens.openQuestions).toHaveLength(5);
    expect(f4.lens.propositions.find((p) => p.propositionId === "network.finality")?.assessments).toEqual([]);
    expect(f4.lens.propositions.find((p) => p.propositionId === "network.settlement")?.assessments).toEqual([]);
    expect(propositions.find((p) => p.propositionId === "f4:zk.real_cryptographic_proof_verified")?.assessments[0]?.value).toBe("insufficient");
    expect(propositions.find((p) => p.propositionId === "f4:core.chainlock_finality")?.assessments[0]?.value).toBe("insufficient");
    expect(propositions.find((p) => p.propositionId === "f4:nevm.batch_mock_proof_acceptance")?.statement).toMatch(/MOCK/);
    expect(f4.extensions?.trailContextNote).toMatch(/MOCK TYPE 3/);
    expect(f4.extensions?.trailContextNote).toMatch(/NOT established/);
    expect(f4.lens.coreResultPreservation?.subject.networkId).toBe("eip155:57057");
  });

  it("serves the exact same pinned envelope over the local MCP store without live claims", () => {
    const output = loadReviewedCaseStore().get("zksys-genesis-20261118");
    expect(output.envelope).toEqual(f4);
    expect(output.evidenceClass).toBe("historical-source-bound-public-testnet-fixture");
    expect(output.liveObservation).toBe(false);
    expect(output.currentAvailability).toBe("unknown");
    expect(output.label).toMatch(/NOT a real cryptographically verified ZK proof/);
  });

  it("assesses the five positive missing claims as insufficient instead of assessing their negation", () => {
    const missing = f4.lens.propositions.filter((p) => p.assessments[0]?.value === "insufficient");
    expect(missing).toHaveLength(5);
    for (const item of missing) {
      expect(item.statement).not.toMatch(/\bNOT\b|unverified|not been|remains unverified/i);
      expect(item.assessments[0]?.limitations?.join(" ")).toMatch(/No independently sufficient evidence/);
      expect(item.availability).toBe("unknown");
    }
    expect(f4.lens.openQuestions.every((q) => q.statement?.startsWith("What independent evidence would establish this claim?"))).toBe(true);
  });

  it("exposes all five exact records and bundles the independently replayable original archive", () => {
    expect([f4.exactAction.networkId, f4.exactAction.gatewayNetworkId, f4.exactAction.nevmNetworkId]).toEqual([
      "eip155:57057", "eip155:57001", "eip155:5700",
    ]);
    expect(f4.exactAction.gatewayTransaction).toBe("0x321f5184dea2ff8026bc84b01df304c8936b139e64b25774ffd326853b2391d9");
    expect(f4.exactAction.nevmCommitTransaction).toBe("0x4661a9f890147e1ceb4dc8647eeba801ec206d4a318b299083c291b89f9820f3");
    expect(f4.exactAction.nevmMockProofTransaction).toBe("0xc82091801f6b0947db4bed5fb2400e07313e2730b0c37d389d2b3c5dba9fdde0");
    expect(f4.exactAction.nevmExecutionTransaction).toBe("0x6498e1f4bd29000890343b377d9790b2a63db10e03d3d25fcd5ea1f9ed4f29e6");
    const archive = readFileSync(join(folder, "../zksys-genesis-f4/ORIGINAL_PUBLIC_CAPTURE.zip"));
    expect(createHash("sha256").update(archive).digest("hex")).toBe(f4.extensions?.provenance?.originalCaptureSha256);
    expect(f4.extensions?.provenance?.sourceVerdictsSha256).toBe("c32b4fedb97d5e8366afc75604b4fae996129415c8f4f38612feef0929fad1fb");
    expect(readFileSync(join(folder, "../../packages/mcp/README.md"), "utf8")).toContain(
      createHash("sha256").update(readFileSync(join(folder, "data/collection.json"))).digest("hex"),
    );
  });

  it("fails closed on authority field injection, unknown networks and raw locator leakage", () => {
    const extra = structuredClone(collection) as any;
    extra.cases[4].caseVerdict = "supported";
    expect(() => validateNeMapsCollectionV01(extra)).toThrow(/forbidden/);
    const bad = structuredClone(f4) as any;
    bad.lens.artifacts[0].locatorRef = "https://private.invalid/rpc";
    expect(() => validateLensBrowserSafeCaseV01(bad.lens)).toThrow(/locatorRef/);
    const wrong = structuredClone(f4) as any;
    wrong.exactAction.networkId = { id: "eip155:1" };
    expect(() => validateNeMapsCollectionV01({ ...structuredClone(collection), cases: [...collection.cases.slice(0,4), wrong] })).toThrow(/exactAction.networkId/);
  });
});
