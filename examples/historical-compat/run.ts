import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { serializeLensBrowserSafeV01 } from "@nec/lens";

import {
  assertHistoricalProjectionPreservedV01,
  buildHistoricalCompatCaseV01,
  checkF2SelectorV01,
  F2_REVIEWED_SELECTOR_CHECKS,
  HISTORICAL_CASE_IDS,
  HISTORICAL_COMPAT_AUTHORITY,
  HISTORICAL_COMPAT_VERSION,
  HISTORICAL_EXACT_ACTIONS,
  REVIEWED_EXPORT_METADATA,
  TARGET_CORE_MUTATIONS,
  type HistoricalCaseId,
} from "./compat.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(HERE, "data");
const REVIEWED_EXPORT = resolve(HERE, "../ne-maps/data/cases.json");
const REVIEWED_EXPORT_SHA = resolve(HERE, "../ne-maps/data/CASES.sha256");

function sha256(text: string | Uint8Array): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The reviewed 586a81a browser projections, as pinned by the existing Maps export. */
export function loadReviewedProjections(): { sha256: string; byId: Record<HistoricalCaseId, unknown> } {
  const bytes = readFileSync(REVIEWED_EXPORT);
  const digest = sha256(bytes);
  const pinned = readFileSync(REVIEWED_EXPORT_SHA, "utf8").trim();
  if (pinned !== `${digest}  cases.json`) throw new Error("reviewed Maps export digest mismatch");
  const data = JSON.parse(bytes.toString("utf8")) as {
    sourceAuthority?: { commit?: string };
    cases: Array<{ id: string; exactAction: unknown; lens: unknown }>;
  };
  if (data.sourceAuthority?.commit !== HISTORICAL_COMPAT_AUTHORITY.commit) throw new Error("reviewed export authority mismatch");
  const byId = {} as Record<HistoricalCaseId, unknown>;
  for (const id of HISTORICAL_CASE_IDS) {
    const entry = data.cases.find((item) => item.id === id);
    if (!entry) throw new Error(`reviewed export lacks ${id}`);
    if (JSON.stringify(entry.exactAction) !== JSON.stringify(HISTORICAL_EXACT_ACTIONS[id])) throw new Error(`${id} reviewed exact action mismatch`);
    byId[id] = entry.lens;
  }
  return { sha256: digest, byId };
}

function semantics(lens: any) {
  return {
    caseId: lens.caseId,
    propositions: lens.propositions.map((p: any) => ({
      propositionId: p.propositionId,
      kind: p.kind ?? null,
      availability: p.availability ?? null,
      assessments: p.assessments.map((a: any) => ({
        assessmentId: a.assessmentId,
        evaluatorType: a.evaluator.type,
        provenanceClass: a.evaluator.provenanceClass ?? null,
        verificationMode: a.evaluator.verificationMode ?? null,
        localRecomputation: a.evaluator.localRecomputation ?? null,
        networkEvidenceAuthority: a.networkEvidenceAuthority ?? null,
        vocabulary: a.vocabulary,
        value: a.value,
        basis: a.basis,
      })),
      limitationCount: p.limitations.length,
    })),
    openQuestions: lens.openQuestions.map((q: any) => ({ questionId: q.questionId, status: q.status })),
    relations: lens.relations.map((r: any) => ({ relationId: r.relationId, relationType: r.relationType, basis: r.basis })),
    caseLimitationCount: lens.limitations.length,
  };
}

export async function buildHistoricalCompatOutputsV01(): Promise<Record<string, string>> {
  const reviewed = loadReviewedProjections();
  const outputs: Record<string, string> = {};
  const cases = [];
  for (const id of HISTORICAL_CASE_IDS) {
    const compat = await buildHistoricalCompatCaseV01(id, REVIEWED_EXPORT_METADATA);
    const reviewedLens = reviewed.byId[id];
    assertHistoricalProjectionPreservedV01(id, reviewedLens, compat.lens);
    if (serializeLensBrowserSafeV01(reviewedLens as any) !== compat.browserBytes) throw new Error(`${id} browser bytes differ from reviewed projection`);
    outputs[`${id}.lens-browser.json`] = `${compat.browserBytes}\n`;
    const selectorChecks = [];
    if (id === "f2") {
      for (const check of F2_REVIEWED_SELECTOR_CHECKS) {
        const result = await checkF2SelectorV01(check.selector);
        if (result.core !== check.verdict) throw new Error(`F2 selector ${check.label} drifted to ${result.core}`);
        selectorChecks.push({ label: check.label, coreVerdict: result.core, lensVerdict: result.lens });
      }
    }
    cases.push({
      id,
      exactAction: HISTORICAL_EXACT_ACTIONS[id],
      coreReplay: compat.coreReplay,
      ...(selectorChecks.length === 0 ? {} : { reviewedSelectorChecks: selectorChecks }),
      semantics: semantics(compat.lens),
      browser: {
        projectionPolicy: (compat.lens as any).projectionPolicy ?? null,
        revisionDigest: compat.lens.revisionDigest,
        validator: "@nec/lens validateLensBrowserSafeCaseV01",
        serializer: "@nec/lens serializeLensBrowserSafeV01",
        bytesSha256: sha256(`${compat.browserBytes}\n`),
      },
      reviewedEquality: {
        reviewedProjection: "examples/ne-maps/data/cases.json",
        semanticViolations: 0,
        browserBytes: "identical",
      },
    });
  }
  const summary = {
    schemaVersion: "ne-historical-compat-proof/v0.1",
    compatibilityVersion: HISTORICAL_COMPAT_VERSION,
    authority: HISTORICAL_COMPAT_AUTHORITY,
    reviewedExport: { path: "examples/ne-maps/data/cases.json", sha256: reviewed.sha256 },
    constructionMetadata: REVIEWED_EXPORT_METADATA,
    cases,
    nonClaims: [
      "No verdict is recomputed by Hub/Lens; reviewed verdicts are preserved and fresh Core replay is an equality gate only.",
      "No global case verdict, confidence, trust score, policy decision, settlement, finality upgrade or service-delivery claim.",
      "Exact-fixture compatibility only; not generic x402, ERC-4337 or Solana Hub ingestion.",
    ],
    TARGET_CORE_MUTATIONS,
  };
  outputs["proof-summary.json"] = `${JSON.stringify(summary, null, 2)}\n`;
  return outputs;
}

export function checksumFile(outputs: Record<string, string>): string {
  return Object.keys(outputs)
    .sort()
    .map((name) => `${sha256(outputs[name]!)}  ${name}`)
    .join("\n") + "\n";
}

async function write(): Promise<void> {
  const outputs = await buildHistoricalCompatOutputsV01();
  for (const [name, text] of Object.entries(outputs)) writeFileSync(resolve(DATA, name), text, "utf8");
  writeFileSync(resolve(DATA, "SHA256SUMS"), checksumFile(outputs), "utf8");
  console.log(`MATERIALIZED ${Object.keys(outputs).length} artifacts`);
}

async function verify(): Promise<void> {
  const outputs = await buildHistoricalCompatOutputsV01();
  for (const [name, expected] of Object.entries(outputs)) {
    const actual = readFileSync(resolve(DATA, name), "utf8");
    if (actual !== expected) throw new Error(`${name} is not byte-reproducible`);
  }
  const sums = readFileSync(resolve(DATA, "SHA256SUMS"), "utf8");
  if (sums !== checksumFile(outputs)) throw new Error("SHA256SUMS does not match reproduced artifacts");
  console.log(`HISTORICAL_COMPAT_PASS f1 f2 f3 authority=${HISTORICAL_COMPAT_AUTHORITY.commit}`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2] ?? "--verify";
  if (mode === "--write") await write();
  else if (mode === "--verify") await verify();
  else throw new Error(`unsupported mode ${mode}`);
}
