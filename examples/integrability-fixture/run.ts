import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeNetworkEvidenceV01 } from "@nec/hub";
import {
  buildLensCaseFromHubV01,
  projectLensBrowserSafeV01,
  serializeLensBrowserSafeV01,
  serializeLensCaseV01,
} from "@nec/lens";

import {
  buildSyntheticCoreResult,
  buildSyntheticCoreWire,
  SYNTHETIC_ARTIFACT_DIGEST,
  SYNTHETIC_SEMANTIC_DIGEST,
} from "./golden-core.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(HERE, "data");
const META = {
  caseId: "synthetic-core-golden-v0.1",
  namespace: "nec.integrability",
  createdAt: "2026-10-07T00:00:00.000Z",
} as const;

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function buildOutputs(): Record<string, string> {
  const coreResult = buildSyntheticCoreResult();
  const coreWire = buildSyntheticCoreWire();
  const hubObject = normalizeNetworkEvidenceV01({ kind: "network_evidence_result", result: coreResult });
  const hubWire = normalizeNetworkEvidenceV01({
    kind: "nec_wire_json_v1",
    wireType: "network-evidence-result",
    wire: coreWire,
  });

  const lensObject = buildLensCaseFromHubV01({ hubRecord: hubObject, ...META });
  const lensWire = buildLensCaseFromHubV01({ hubRecord: hubWire, ...META });
  const lensBytes = serializeLensCaseV01(lensObject);
  if (serializeLensCaseV01(lensWire) !== lensBytes) {
    throw new Error("object and wire Hub paths produced different Lens bytes");
  }

  const browserObject = projectLensBrowserSafeV01(lensObject);
  const browserWire = projectLensBrowserSafeV01(lensWire);
  const browserBytes = serializeLensBrowserSafeV01(browserObject);
  if (serializeLensBrowserSafeV01(browserWire) !== browserBytes) {
    throw new Error("object and wire Hub paths produced different browser bytes");
  }

  const summary = {
    schemaVersion: "ne-integrability-proof/v0.1",
    core: {
      semanticDigest: SYNTHETIC_SEMANTIC_DIGEST,
      artifactDigest: SYNTHETIC_ARTIFACT_DIGEST,
      wireSha256: sha256(`${coreWire}\n`),
    },
    hub: {
      objectAdmission: hubObject.validation.method,
      wireAdmission: hubWire.validation.method,
      schemaVersion: hubObject.schemaVersion,
    },
    lens: {
      schemaVersion: lensObject.schemaVersion,
      revisionDigest: lensObject.revisionDigest,
      bytesSha256: sha256(`${lensBytes}\n`),
    },
    browser: {
      projectionPolicy: browserObject.projectionPolicy,
      bytesSha256: sha256(`${browserBytes}\n`),
    },
    TARGET_CORE_MUTATIONS: 0,
  };

  return {
    "core-result.wire.json": `${coreWire}\n`,
    "lens-case.json": `${lensBytes}\n`,
    "lens-browser.json": `${browserBytes}\n`,
    "proof-summary.json": `${JSON.stringify(summary, null, 2)}\n`,
  };
}

function checksumFile(outputs: Record<string, string>): string {
  return Object.keys(outputs)
    .sort()
    .map((name) => `${sha256(outputs[name]!)}  ${name}`)
    .join("\n") + "\n";
}

function write(): void {
  const outputs = buildOutputs();
  for (const [name, text] of Object.entries(outputs)) writeFileSync(resolve(DATA, name), text, "utf8");
  writeFileSync(resolve(DATA, "SHA256SUMS"), checksumFile(outputs), "utf8");
  console.log(`MATERIALIZED ${Object.keys(outputs).length} artifacts`);
}

function verify(): void {
  const outputs = buildOutputs();
  for (const [name, expected] of Object.entries(outputs)) {
    const actual = readFileSync(resolve(DATA, name), "utf8");
    if (actual !== expected) throw new Error(`${name} is not byte-reproducible`);
  }
  const sums = readFileSync(resolve(DATA, "SHA256SUMS"), "utf8");
  if (sums !== checksumFile(outputs)) throw new Error("SHA256SUMS does not match reproduced artifacts");
  console.log(`INTEGRABILITY_FIXTURE_PASS ${SYNTHETIC_SEMANTIC_DIGEST}`);
}

const mode = process.argv[2] ?? "--verify";
if (mode === "--write") write();
else if (mode === "--verify") verify();
else throw new Error(`unsupported mode ${mode}`);
