import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { serializeLensBrowserSafeV01, validateLensBrowserSafeCaseV01 } from "@nec/lens";

import { buildDemoResult } from "../../core-hub-lens/run.js";
import {
  assertHistoricalProjectionPreservedV01,
  buildHistoricalCompatCaseV01,
  checkF2SelectorV01,
  compareHistoricalProjectionV01,
  expectedF1CoreReplayV01,
  expectedF3CoreReplayV01,
  F2_EXACT_SELECTOR,
  F2_REVIEWED_SELECTOR_CHECKS,
  HISTORICAL_CASE_IDS,
  HISTORICAL_COMPAT_AUTHORITY,
  HISTORICAL_EXACT_ACTIONS,
  replayF1CoreV01,
  replayF3CoreV01,
  type HistoricalCaseId,
  type HistoricalCompatViolationCodeV01,
} from "../compat.js";
import { buildHistoricalCompatOutputsV01, checksumFile, loadReviewedProjections } from "../run.js";

const HERE = fileURLToPath(new URL("..", import.meta.url));
const AUTHORITY = join(HERE, "authority");
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const read = (path: string) => readFileSync(join(HERE, path));
const json = (path: string) => JSON.parse(read(path).toString("utf8"));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(relative(AUTHORITY, path));
  }
  return out;
}

function manifest(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.trim().split("\n")) {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    if (!match) throw new Error(`bad manifest line ${line}`);
    map.set(match[2]!, match[1]!);
  }
  return map;
}

const reviewed = loadReviewedProjections().byId;
const prop = (lens: any, id: string) => lens.propositions.find((p: any) => p.propositionId === id);
const assessment = (lens: any, id: string) => prop(lens, id).assessments[0];
const codes = (id: HistoricalCaseId, candidate: unknown) =>
  compareHistoricalProjectionV01(id, reviewed[id], candidate).map((violation) => violation.code);

describe("LOT 3 promoted authority bytes", () => {
  it("are byte-identical to authority 586a81a and pinned by AUTHORITY_SHA256SUMS", () => {
    expect(HISTORICAL_COMPAT_AUTHORITY.commit).toBe("586a81a39c8da4d3a0dc0e879b605aabfd3f8d1d");
    const pinned = manifest(read("AUTHORITY_SHA256SUMS").toString("utf8"));
    expect(pinned.size).toBe(22);
    for (const [path, digest] of pinned) expect(sha256(read(join("authority", path))), path).toBe(digest);
    expect(pinned.get("lib/h1.mjs")).toBe("a9eb3c6e9688267d2dbba56f193cf33fcef92215e75938165f98a03f6678b9a8");
    expect(pinned.get("lib/f1.mjs")).toBe("30dfd899f8cd5d4db0bc4eb8dadb382f577e6616492e2de498386d617b9439ff");
    expect(pinned.get("lib/f2.mjs")).toBe("9773f0d4ca423d189ab09fd1acd1c5d11ee1813490fc1daf2412c4285986411a");
    expect(pinned.get("lib/f3.mjs")).toBe("360352dc646ef3d50a3294129d84ff2d73927fa716cebb0b379219edf6736fbf");

    const declarations = ["lib/f1.d.mts", "lib/f2.d.mts", "lib/f3.d.mts"];
    expect(walk(AUTHORITY).sort()).toEqual([...pinned.keys(), ...declarations].sort());
  });

  it("keep each authority fixture MANIFEST.sha256 verbatim and export only listed entries", () => {
    const notExported: Record<string, string[]> = {
      "F1-x402-1062-partial": [
        "source/network-evidence/README.md",
        "source/network-evidence/case.ts",
        "source/network-evidence/fixtures/MANIFEST.sha256",
      ],
      "F2-erc4337-base-sepolia-v06": [],
      "F3-solana-mainnet-x402-partial": [],
    };
    for (const [dir, omitted] of Object.entries(notExported)) {
      const root = join("authority/fixtures", dir);
      const entries = manifest(read(join(root, "MANIFEST.sha256")).toString("utf8"));
      const exported = walk(join(AUTHORITY, "fixtures", dir)).map((path) => relative(join("fixtures", dir), path)).filter((path) => path !== "MANIFEST.sha256");
      for (const path of exported) expect(sha256(read(join(root, path))), `${dir}/${path}`).toBe(entries.get(path));
      expect([...entries.keys()].filter((path) => !exported.includes(path)).sort()).toEqual([...omitted].sort());
    }
  });

  it("reuse the same reviewed H1/F2 algorithm bytes as the existing public core-hub-lens demo", () => {
    expect(read("authority/lib/h1.mjs").equals(read("../core-hub-lens/hub/h1.mjs"))).toBe(true);
    expect(read("authority/lib/f2.mjs").equals(read("../core-hub-lens/hub/f2.mjs"))).toBe(true);
    expect(read("authority/lib/f2.d.mts").equals(read("../core-hub-lens/hub/f2.d.mts"))).toBe(true);
    expect(read("authority/fixtures/F2-erc4337-base-sepolia-v06/01-frozen-network-evidence-reference.json")
      .equals(read("../core-hub-lens/fixtures/01-frozen-network-evidence-reference.json"))).toBe(true);
  });
});

describe("fresh public Core replay equals reviewed authority semantics", () => {
  it("F1 Base mainnet replay equals the reviewed frozen Network Evidence projection", async () => {
    const core = await replayF1CoreV01();
    expect(core).toStrictEqual(expectedF1CoreReplayV01());
    expect(core.networkEvidence.execution.verdict).toBe("supported");
    expect(core.networkEvidence.finality.verdict).toBe("insufficient");
    expect(core.networkEvidence.finality.limitationCode).toBe("OP_ANCESTRY_DEPTH_EXCEEDED");
  });

  it("F2 selector outcomes agree between fresh Core and the reviewed adapter", async () => {
    const expected = json("authority/fixtures/F2-erc4337-base-sepolia-v06/02-expected-lens-semantics.json");
    expect(F2_EXACT_SELECTOR).toEqual(expected.exactSelector);
    const verdicts = [];
    for (const check of F2_REVIEWED_SELECTOR_CHECKS) {
      const result = await checkF2SelectorV01(check.selector);
      expect(result.core).toBe(check.verdict);
      expect(result.lens).toBe(check.verdict);
      verdicts.push({ label: check.label, verdict: result.lens });
    }
    expect(verdicts.map((v) => v.verdict)).toEqual([
      expected.expectedVerdict,
      expected.negativeCases.unknownUserOpHash,
      expected.negativeCases.exactHashWrongSender,
      expected.negativeCases.senderOnlyRepeatedSender,
    ]);
    const maps = JSON.parse(readFileSync(join(HERE, "../ne-maps/data/cases.json"), "utf8"));
    expect(maps.cases.find((c: any) => c.id === "f2").reviewedSelectorOutcomes).toEqual(verdicts);
    expect((await checkF2SelectorV01({ sender: F2_EXACT_SELECTOR.sender! })).lens).toBe(expected.senderOnlyUniqueTarget);
  });

  it("F3 Solana mainnet replay equals the reviewed frozen Core runtime", async () => {
    const core = await replayF3CoreV01();
    expect(core).toStrictEqual(expectedF3CoreReplayV01());
    expect(core.payment.settlementInferred).toBe(false);
  });
});

describe("new public path equals the reviewed 586a81a projections", () => {
  it.each(HISTORICAL_CASE_IDS)("%s is semantically and byte-identical and passes the public Lens browser contract", async (id) => {
    const compat = await buildHistoricalCompatCaseV01(id);
    expect(() => validateLensBrowserSafeCaseV01(compat.lens)).not.toThrow();
    expect(compat.lens).toStrictEqual(reviewed[id]);
    expect(JSON.stringify(compat.lens)).toBe(JSON.stringify(reviewed[id]));
    expect(compat.browserBytes).toBe(serializeLensBrowserSafeV01(reviewed[id] as any));
    expect(compareHistoricalProjectionV01(id, reviewed[id], compat.lens)).toEqual([]);
    expect(compat.lens.revisionDigest).toBeNull();
    expect(compat.lens.revisionDigestVisibility).toBe("withheld_by_browser_policy");
    expect(compat.lens.TARGET_CORE_MUTATIONS).toBe(0);
    expect(compat.coreReplay.reviewedEquality).toBe("passed");
  });

  it("F1 keeps supported execution/data binding, insufficient finality and correlation, unavailable settlement", async () => {
    const lens: any = (await buildHistoricalCompatCaseV01("f1")).lens;
    const expected = json("authority/fixtures/F1-x402-1062-partial/03-expected-lens-semantics.json");
    for (const item of expected.expectedPropositions) {
      const p = lens.propositions.find((candidate: any) => candidate.statement === item.statementKey);
      expect(p, item.statementKey).toBeTruthy();
      if (item.kind === "source_claim") {
        expect(p.assessments).toEqual([]);
        expect(lens.sourceClaims[0].factClass).toBe(item.factClass);
        expect(lens.sourceClaims[0].value).toBe(item.value);
      } else if (item.verdict === "unavailable") {
        expect(p.availability).toBe("unavailable");
        expect(p.assessments).toEqual([]);
      } else if (item.verdict) {
        expect(p.assessments[0].value).toBe(item.verdict);
        expect(p.assessments[0].basis).toEqual(item.basis);
        if (item.limitationCode) expect(p.assessments[0].limitationCode).toBe(item.limitationCode);
      } else if (item.value) {
        expect(p.assessments[0].value).toBe(item.value);
        expect(p.assessments[0].missingRequiredPublicFields).toEqual(item.missingRequiredPublicFields);
        expect(p.assessments[0].networkEvidenceAuthority).toBe("none");
      } else {
        expect(p.assessments).toEqual([]);
        expect(p.assessmentPolicy).toBe("observed_effect_carries_no_network_evidence_verdict");
      }
    }
    expect(prop(lens, "p-service-delivery").assessments).toEqual([]);
    expect(lens.openQuestions.map((q: any) => [q.questionId, q.status])).toEqual([
      ["q-x402-correlation", "unresolved"], ["q-finality", "unresolved"], ["q-settlement", "unresolved"], ["q-service-delivery", "unresolved"],
    ]);
    expect(lens.relations.map((r: any) => [r.relationType, r.basis])).toEqual([
      ["candidate_same_transaction", "source_declared_binding"],
      ["transcription_source_pinned_by", "deterministic_binding"],
      ["pins_exact_frozen_bytes", "deterministic_binding"],
    ]);
    expect(assessment(lens, "p-execution").evaluator.localRecomputation).toBe("not_performed");
    expect(lens.networkEvidence.unavailableDimensions).toEqual(["settlement"]);
  });

  it("F2 keeps supported exact UserOperation with finality and bundler provenance unavailable", async () => {
    const lens: any = (await buildHistoricalCompatCaseV01("f2")).lens;
    const expected = json("authority/fixtures/F2-erc4337-base-sepolia-v06/02-expected-lens-semantics.json");
    const a = assessment(lens, "p-userop-execution");
    expect(a.value).toBe(expected.expectedVerdict);
    expect(a.supportedLabel).toBe(expected.supportedLabel);
    expect(a.basis).toEqual(["source_observation", "deterministic_derivation"]);
    expect(a.evaluator.provenanceClass).toBe("operator_imported");
    expect(a.evaluator.localRecomputation).toBe("not_performed");
    for (const id of ["p-finality", "p-bundler-provenance"]) {
      expect(prop(lens, id).availability).toBe("unavailable");
      expect(prop(lens, id).assessments).toEqual([]);
    }
    expect(lens.exactReviewedSemantics.finalityEstablished).toBe(false);
    expect(lens.exactReviewedSemantics.bundlerIdentityEstablished).toBe(false);
    expect(lens.exactReviewedSemantics.crossSourceIndependenceEstablished).toBe(false);
    expect(lens.openQuestions.map((q: any) => q.questionId)).toEqual(["q-finality", "q-bundler"]);
    expect(JSON.stringify(lens.exactReviewedSemantics)).not.toMatch(/Rundler|Alchemy/i);
  });

  it("F3 keeps the split supported/insufficient/unavailable result without Network Evidence authority for correlation", async () => {
    const lens: any = (await buildHistoricalCompatCaseV01("f3")).lens;
    const expected = json("authority/fixtures/F3-solana-mainnet-x402-partial/02-expected-lens-semantics.json").expected;
    expect(assessment(lens, "p-network-execution").value).toBe(expected.transactionExecution);
    expect(assessment(lens, "p-x402-svm-payment").value).toBe(expected.paymentOutcome);
    expect(assessment(lens, "p-network-finality").value).toBe(expected.networkFinality);
    const correlation = assessment(lens, "p-historical-x402-correlation");
    expect(correlation.value).toBe(expected.historicalX402Correlation);
    expect(correlation.evaluator.type).toBe(expected.historicalCorrelationEvaluator);
    expect(correlation.reviewClass).toBe(expected.historicalCorrelationReviewClass);
    expect(correlation.networkEvidenceAuthority).toBe("none");
    expect(correlation.absenceStatementScope).toBe("public_documentation_states_not_public_not_nonexistence");
    expect(prop(lens, "p-settlement").availability).toBe(expected.settlementAvailability);
    expect(prop(lens, "p-settlement").assessments).toEqual([]);
    expect(lens.exactReviewedSemantics.networkFinality.economicIrreversibilityEstablished).toBe(expected.economicIrreversibilityEstablished);
    expect(lens.artifacts[0].artifactDigest).toBeNull();
    expect(lens.artifacts[0].artifactDigestVisibility).toBe("withheld_by_browser_policy");
  });

  it("matches the exact-action identities exported to Maps", () => {
    const maps = JSON.parse(readFileSync(join(HERE, "../ne-maps/data/cases.json"), "utf8"));
    for (const id of HISTORICAL_CASE_IDS) {
      expect(maps.cases.find((c: any) => c.id === id).exactAction).toEqual(HISTORICAL_EXACT_ACTIONS[id]);
    }
  });
});

describe("authority demo outputs are reproduced through the public path", () => {
  it("F3 authority Core -> Hub -> Lens demo output digest is reproduced byte-for-byte", async () => {
    const core = await replayF3CoreV01();
    const lens = (await buildHistoricalCompatCaseV01("f3", { namespace: "ne-suite-f3-demo", createdAt: "2026-10-07T00:00:00.000Z" })).lens;
    const output = {
      schemaVersion: "ne-suite-f3-demo/v0.1",
      demoId: "f3-solana-mainnet-x402-core-hub-lens",
      networkEvidence: {
        repository: "ZzNible/network-evidence",
        commit: "e536ca1c63465ebb2de46c855a01bac71e4dc768",
        mode: "offline_replay_public_code",
      },
      integration: {
        path: "Core -> Hub -> Lens",
        targetCoreMutations: 0,
        fetchPoisonedDuringReplay: true,
        exactFrozenRuntimeProjectionMatch: true,
      },
      core,
      lens,
    };
    const pinned = read("authority/fixtures/F3-solana-mainnet-x402-partial/03-expected-demo-output.sha256").toString("utf8").trim();
    expect(pinned).toBe("4881790d6d496533cae41527aefb6d01e941c4c52a294775593eda4de8d64833");
    expect(sha256(JSON.stringify(output, null, 2) + "\n")).toBe(pinned);
  });

  it("F2 public core-hub-lens demo emits the same reviewed projection as the compatibility path", async () => {
    const demo = await buildDemoResult();
    const compat = await buildHistoricalCompatCaseV01("f2", { namespace: "network-evidence-public-demo", createdAt: "2026-10-06T20:30:00.000Z" });
    expect(demo.lens.browserSafeCase).toStrictEqual(compat.lens);
  });
});

describe("deterministic materialized outputs", () => {
  it("reproduce data/ byte-for-byte twice", async () => {
    const first = await buildHistoricalCompatOutputsV01();
    const second = await buildHistoricalCompatOutputsV01();
    expect(second).toEqual(first);
    for (const [name, text] of Object.entries(first)) expect(read(join("data", name)).toString("utf8"), name).toBe(text);
    expect(read("data/SHA256SUMS").toString("utf8")).toBe(checksumFile(first));
  });
});

describe("regression guard", () => {
  type Mutation = [HistoricalCaseId, string, (lens: any) => void, HistoricalCompatViolationCodeV01];
  const mutations: Mutation[] = [
    ["f1", "correlation insufficient -> supported", (l) => { assessment(l, "p-x402-correlation").value = "supported"; }, "verdict_strengthened"],
    ["f1", "finality insufficient -> supported", (l) => { assessment(l, "p-finality").value = "supported"; }, "verdict_strengthened"],
    ["f1", "preserved finality verdict upgraded", (l) => { l.networkEvidence.preservedResult.finality.verdict = "supported"; }, "verdict_strengthened"],
    ["f1", "settlement unavailable -> available", (l) => { prop(l, "p-settlement").availability = "available"; }, "verdict_strengthened"],
    ["f1", "service delivery gains a verdict", (l) => { prop(l, "p-service-delivery").assessments.push(clone(assessment(l, "p-execution"))); }, "verdict_strengthened"],
    ["f2", "finality gains a verdict", (l) => { prop(l, "p-finality").assessments.push(clone(assessment(l, "p-userop-execution"))); }, "verdict_strengthened"],
    ["f2", "finality flag flipped", (l) => { l.exactReviewedSemantics.finalityEstablished = true; }, "verdict_strengthened"],
    ["f3", "historical correlation insufficient -> supported", (l) => { assessment(l, "p-historical-x402-correlation").value = "supported"; }, "verdict_strengthened"],
    ["f3", "economic irreversibility asserted", (l) => { l.exactReviewedSemantics.networkFinality.economicIrreversibilityEstablished = true; }, "verdict_strengthened"],
    ["f3", "payment supported -> insufficient", (l) => { assessment(l, "p-x402-svm-payment").value = "insufficient"; }, "verdict_changed"],
    ["f2", "basis widened", (l) => { assessment(l, "p-userop-execution").basis.push("cryptographic_verification"); }, "basis_changed"],
    ["f1", "case limitation dropped", (l) => { l.limitations.pop(); }, "limitation_lost"],
    ["f1", "finality limitation code dropped", (l) => { delete assessment(l, "p-finality").limitationCode; }, "limitation_lost"],
    ["f1", "missing x402 field forgotten", (l) => { assessment(l, "p-x402-correlation").missingRequiredPublicFields.pop(); }, "limitation_lost"],
    ["f2", "proposition limitation dropped", (l) => { prop(l, "p-bundler-provenance").limitations = []; }, "limitation_lost"],
    ["f3", "missing historical artifact forgotten", (l) => { assessment(l, "p-historical-x402-correlation").missingHistoricalPublicArtifacts.pop(); }, "limitation_lost"],
    ["f1", "evaluator provenance class dropped", (l) => { delete assessment(l, "p-execution").evaluator.provenanceClass; }, "provenance_lost"],
    ["f1", "frozen source index dropped", (l) => { delete l.frozenSourceIndex; }, "provenance_lost"],
    ["f2", "imported evaluator relabelled as recomputed", (l) => { assessment(l, "p-userop-execution").evaluator.localRecomputation = "performed"; }, "provenance_changed"],
    ["f3", "correlation borrows Network Evidence authority", (l) => { assessment(l, "p-historical-x402-correlation").networkEvidenceAuthority = "network_evidence"; }, "provenance_changed"],
    ["f3", "public source index dropped", (l) => { delete l.publicSourceIndex; }, "provenance_lost"],
    ["f1", "open question resolved", (l) => { l.openQuestions[0].status = "not_applicable"; }, "open_question_changed"],
    ["f2", "relation basis upgraded", (l) => { l.relations[1].basis = "cryptographic_verification"; }, "relation_changed"],
    ["f1", "global confidence added", (l) => { l.confidence = 0.9; }, "unauthorized_browser_field"],
    ["f2", "raw payload added to assessment", (l) => { assessment(l, "p-userop-execution").rawPayload = "0x00"; }, "unauthorized_browser_field"],
    ["f3", "revision digest exposed", (l) => { l.revisionDigest = { algorithm: "sha256", value: "0".repeat(64), digestOf: "hub_owned_case_revision" }; }, "unauthorized_browser_field"],
    ["f3", "withheld artifact digest exposed", (l) => { l.artifacts[0].artifactDigest = { algorithm: "sha256", digestOf: "raw_bytes", value: "0".repeat(64) }; }, "unauthorized_browser_field"],
    ["f1", "withheld documentary digest visibility changed", (l) => { l.artifacts[0].artifactDigestVisibility = "public_network_reference"; }, "unauthorized_browser_field"],
    ["f1", "exact transaction changed", (l) => { l.networkEvidence.subject.txId = `0x${"11".repeat(32)}`; }, "exact_action_identity_changed"],
    ["f2", "exact UserOperation changed", (l) => { l.exactReviewedSemantics.selectedUserOperation.userOpHash = `0x${"22".repeat(32)}`; }, "exact_action_identity_changed"],
    ["f2", "bundle transaction changed", (l) => { prop(l, "p-bundle-context").context.transactionHash = `0x${"33".repeat(32)}`; }, "exact_action_identity_changed"],
    ["f3", "exact signature changed", (l) => { l.exactReviewedSemantics.transaction.signature = "1".repeat(88); }, "exact_action_identity_changed"],
    ["f2", "uncategorized text drift", (l) => { prop(l, "p-bundle-context").statement = "bundle_context_rewritten"; }, "semantic_drift"],
  ];

  it.each(mutations)("%s: %s -> %s", (id, _name, mutate, expected) => {
    const candidate = clone(reviewed[id]);
    mutate(candidate);
    expect(codes(id, candidate)).toContain(expected);
    expect(() => assertHistoricalProjectionPreservedV01(id, reviewed[id], candidate)).toThrow(expected);
  });

  it("accepts the reviewed projections and construction-metadata-only differences", () => {
    for (const id of HISTORICAL_CASE_IDS) {
      expect(codes(id, clone(reviewed[id]))).toEqual([]);
      const rebuilt = clone(reviewed[id]) as any;
      rebuilt.namespace = "another-namespace";
      rebuilt.createdAt = "2026-10-08T00:00:00.000Z";
      expect(codes(id, rebuilt)).toEqual([]);
    }
  });
});
