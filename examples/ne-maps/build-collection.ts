// Deterministic builder/verifier for data/collection.json (ne-maps-case-collection/v0.1).
//
// Inputs, all pinned and byte-checked:
// - data/cases.json: frozen reviewed F1/F2/F3 export (legacy ne-maps/v0.1, unchanged);
// - examples/historical-compat/data/f*.lens-browser.json: LOT3 public-path outputs;
// - examples/integrability-fixture/data/lens-browser.json: synthetic/local Core -> Hub -> Lens output.
//
// Nested Lens objects are carried unchanged. This script only adds ne-maps-case/v0.1
// presentation envelopes; it computes no verdict or evidence.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { normalizeNetworkEvidenceV01 } from "@nec/hub";
import {
  buildLensCaseFromHubV01,
  projectLensBrowserSafeV01,
  serializeLensBrowserSafeV01,
  validateLensBrowserSafeCaseV01,
} from "@nec/lens";

import { buildSyntheticCoreResult } from "../integrability-fixture/golden-core.js";
import { validateNeMapsCollectionV01 } from "./collection.js";
import type { NeMapsCaseCollectionV01, NeMapsCaseEnvelopeV01 } from "./contracts/case-envelope.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const DATA = resolve(HERE, "data");
const LEGACY_EXPORT_SHA256 = "eef096d0e774bef6ce2b9c111218b52be19d00613c75eb538ce8f936ccf580e1";
const LEGACY_CASE_FIELDS = new Set(["id", "display", "exactAction", "trailContextNote", "reviewedSelectorOutcomes", "trailPropositionOrder", "lens"]);
const SYNTHETIC_META = { caseId: "synthetic-core-golden-v0.1", namespace: "nec.integrability", createdAt: "2026-10-07T00:00:00.000Z" } as const;

export const COLLECTION_FILE = "collection.json";
export const COLLECTION_SHA_FILE = "COLLECTION.sha256";

function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readPinned(dir: string, name: string): string {
  const bytes = readFileSync(resolve(dir, name), "utf8");
  const line = readFileSync(resolve(dir, "SHA256SUMS"), "utf8").split("\n").find((entry) => entry.endsWith(`  ${name}`));
  if (line !== `${sha256(bytes)}  ${name}`) throw new Error(`${name} does not match its SHA256SUMS pin`);
  return bytes;
}

/** Envelope-only migration of one legacy reviewed case; the nested Lens is carried unchanged. */
function migrateLegacyCase(legacy: Record<string, any>, provenance: Record<string, string>): NeMapsCaseEnvelopeV01 {
  for (const key of Object.keys(legacy)) if (!LEGACY_CASE_FIELDS.has(key)) throw new Error(`legacy ${legacy.id} has unmigrated field ${key}`);
  const extensions: Record<string, unknown> = {};
  if (legacy.trailContextNote !== undefined) extensions.trailContextNote = legacy.trailContextNote;
  if (legacy.reviewedSelectorOutcomes !== undefined) extensions.reviewedSelectorOutcomes = legacy.reviewedSelectorOutcomes;
  extensions.provenance = provenance;
  return {
    schemaVersion: "ne-maps-case/v0.1",
    id: legacy.id,
    display: legacy.display,
    exactAction: legacy.exactAction,
    trailPropositionOrder: legacy.trailPropositionOrder,
    lens: legacy.lens,
    extensions,
  };
}

function syntheticCase(): NeMapsCaseEnvelopeV01 {
  const dir = resolve(REPO, "examples/integrability-fixture/data");
  const pinned = readPinned(dir, "lens-browser.json");
  // Re-run the public synthetic path and require the checked-in bytes exactly.
  const hubRecord = normalizeNetworkEvidenceV01({ kind: "network_evidence_result", result: buildSyntheticCoreResult() });
  const live = serializeLensBrowserSafeV01(projectLensBrowserSafeV01(buildLensCaseFromHubV01({ hubRecord, ...SYNTHETIC_META })));
  if (`${live}\n` !== pinned) throw new Error("synthetic Core -> Hub -> Lens bytes differ from the integrability fixture");
  const lens = JSON.parse(pinned);
  const subject = lens.coreResultPreservation?.subject;
  if (subject?.type !== "transaction") throw new Error("synthetic fixture subject is not a transaction");
  return {
    schemaVersion: "ne-maps-case/v0.1",
    id: "synthetic-local-core-golden",
    display: {
      networkLabel: "Synthetic / local fixture — not a network observation",
      title: "Synthetic Core golden — integrability fixture",
      shape: "Synthetic/local · Core → Hub → Lens · EVM-shaped literals",
    },
    exactAction: {
      kind: subject.type,
      networkId: subject.networkId,
      id: subject.txId,
      realityClass: "synthetic/local fixture literal — not observed on any network",
    },
    trailPropositionOrder: [
      "network.execution",
      "network.dataBinding",
      "network.observed_effect:effect_1",
      "network.finality",
      "network.settlement",
    ],
    lens,
    extensions: {
      provenance: {
        fixture: "examples/integrability-fixture/data/lens-browser.json",
        fixtureSha256: sha256(pinned),
        path: "Core NetworkEvidenceResult -> @nec/hub -> @nec/lens -> lens-browser/v0.1",
        realityClass: "synthetic/local",
      },
    },
  };
}

function fifthHistoricalCase(): NeMapsCaseEnvelopeV01 {
  const bytes = readFileSync(resolve(DATA, "f4-reviewed.json"));
  if (readFileSync(resolve(DATA, "F4_REVIEWED.sha256"), "utf8") !== sha256(bytes) + "  f4-reviewed.json\n") throw new Error("F4 pin mismatch");
  const f4 = JSON.parse(bytes.toString("utf8")) as NeMapsCaseEnvelopeV01;
  if (f4.id !== "zksys-genesis-20261118" || f4.exactAction.networkId !== "eip155:57057") throw new Error("F4 identity mismatch");
  if (f4.extensions?.provenance?.realityClass !== "reviewed historical source-bound public testnet fixture") throw new Error("F4 reality mismatch");
  if (f4.extensions.provenance.originalCaptureSha256 !== "a223831d3a304737e0f9e5004b25ebc1e8f18a754679b13a4770e506462384d8") throw new Error("F4 capture pin mismatch");
  if (f4.lens.coreResultPreservation?.sourceSemanticDigest !== "sha256:4292b9d4d975183628a5ca1fc210e8089447a499579896c78fc0cd089df67188") throw new Error("F4 Core digest mismatch");
  if (f4.trailPropositionOrder.length !== 5) throw new Error("F4 Trail must show five steps");
  const items = f4.lens.propositions.filter((p) => p.propositionId.startsWith("f4:"));
  if (items.length !== 11) throw new Error("F4 source inventory mismatch");
  if (items.some((p) => p.assessments.length !== 1 ||
      p.assessments[0]?.vocabulary !== "f4_external_source_join/v0.1" ||
      p.assessments[0]?.evaluator.type !== "f4_external_offline_source_join")) throw new Error("F4 cannot impersonate Core");
  const byId = (id: string) => items.find((p) => p.propositionId === id);
  if (byId("f4:zk.real_cryptographic_proof_verified")?.assessments[0]?.value !== "insufficient" ||
      byId("f4:core.chainlock_finality")?.assessments[0]?.value !== "insufficient" ||
      byId("f4:nevm.batch_mock_proof_acceptance")?.assessments[0]?.value !== "supported" ||
      !byId("f4:nevm.batch_mock_proof_acceptance")?.statement.includes("MOCK")) throw new Error("F4 proof/finality mismatch");
  validateLensBrowserSafeCaseV01(f4.lens);
  return f4;
}

export function buildNeMapsCollectionV01(): NeMapsCaseCollectionV01 {
  const legacyBytes = readFileSync(resolve(DATA, "cases.json"));
  if (sha256(legacyBytes) !== LEGACY_EXPORT_SHA256) throw new Error("reviewed legacy export digest mismatch");
  const legacy = JSON.parse(legacyBytes.toString("utf8"));
  if (legacy.schemaVersion !== "ne-maps/v0.1" || legacy.TARGET_CORE_MUTATIONS !== 0) throw new Error("unexpected legacy export");

  const historicalDir = resolve(REPO, "examples/historical-compat/data");
  const historical = legacy.cases.map((item: Record<string, any>) => {
    // Nested reviewed Lens must equal the LOT3 public-path output byte-for-byte.
    if (`${serializeLensBrowserSafeV01(item.lens)}\n` !== readPinned(historicalDir, `${item.id}.lens-browser.json`)) {
      throw new Error(`${item.id} reviewed Lens differs from the LOT3 public-path output`);
    }
    return migrateLegacyCase(item, {
      sourceAuthority: `${legacy.sourceAuthority.repository}@${legacy.sourceAuthority.branch}#${legacy.sourceAuthority.commit}`,
      publicSuite: `${legacy.publicSuite.repository}#${legacy.publicSuite.commit}`,
      reviewedExport: "examples/ne-maps/data/cases.json",
      reviewedExportSha256: LEGACY_EXPORT_SHA256,
      realityClass: "reviewed public network fixture",
    });
  });

  const collection: NeMapsCaseCollectionV01 = {
    schemaVersion: "ne-maps-case-collection/v0.1",
    TARGET_CORE_MUTATIONS: 0,
    nonClaims: [
      ...legacy.nonClaims,
      "Synthetic/local cases are fixtures for integrability, not network observations.",
    ],
    cases: [...historical, syntheticCase(), fifthHistoricalCase()],
  };
  validateNeMapsCollectionV01(collection, { validateLens: (lens) => validateLensBrowserSafeCaseV01(lens) });
  return collection;
}

export function serializeNeMapsCollectionV01(collection: NeMapsCaseCollectionV01): string {
  return `${JSON.stringify(collection, null, 2)}\n`;
}

function main(mode: string): void {
  const bytes = serializeNeMapsCollectionV01(buildNeMapsCollectionV01());
  const digestLine = `${sha256(bytes)}  ${COLLECTION_FILE}\n`;
  if (mode === "--write") {
    writeFileSync(resolve(DATA, COLLECTION_FILE), bytes, "utf8");
    writeFileSync(resolve(DATA, COLLECTION_SHA_FILE), digestLine, "utf8");
    console.log(`MATERIALIZED ${COLLECTION_FILE} ${digestLine.trim()}`);
    return;
  }
  if (mode !== "--verify") throw new Error(`unknown mode ${mode}`);
  if (readFileSync(resolve(DATA, COLLECTION_FILE), "utf8") !== bytes) throw new Error("collection.json differs from rebuilt bytes");
  if (readFileSync(resolve(DATA, COLLECTION_SHA_FILE), "utf8") !== digestLine) throw new Error("COLLECTION.sha256 mismatch");
  const parsed = validateNeMapsCollectionV01(JSON.parse(bytes), { validateLens: (lens) => validateLensBrowserSafeCaseV01(lens) });
  console.log(`NE_MAPS_COLLECTION_PASS cases=${parsed.cases.length} ${digestLine.trim()}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv[2] ?? "--verify");
