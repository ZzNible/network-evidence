/**
 * GT-02 step-9 tooling (examples-only; closes no gate row; GT-02 stays OPEN).
 *
 * Offline, fail-closed builder from ONE verified resolve action capture
 * (`ne-hosted-action-capture/v0.1`, mode resolve) plus the caller's own
 * evidenceContext file to ONE generic single-case NE Maps collection
 * (`ne-maps-case-collection/v0.1`).
 *
 * Gate: the unchanged verify-CLI decision (`evaluateEvidenceResultCapture`).
 * Only exitReason `composed_result_verified` builds; every other exitReason is
 * returned unchanged with exit 1 and nothing is written.
 *
 * Path after the gate, generic and family-agnostic:
 *   served result wire -> Core decodeNecWireJson("network-evidence-result")
 *   -> @nec/hub normalizeNetworkEvidenceV01 (nec_wire_json_v1)
 *   -> @nec/lens buildLensCaseFromHubV01 -> projectLensBrowserSafeV01
 *   -> validateLensBrowserSafeCaseV01 -> validateNeMapsCollectionV01.
 *
 * The builder computes no verdict, evidence or edge. Every proposition,
 * assessment and availability is Lens's, from the Core result. The labels and
 * provenance strings below are copied from the verify-CLI report or are fixed
 * statements; none of them strengthens a dimension, and none of them claims
 * precedence. `fixedBeforeExecution` is the CLI report's value, as a string.
 *
 * No network, no clock (the only Lens createdAt is --created-at) and no
 * randomness. The output is private by default; publishing any produced case
 * is a separate HUMAN GATE.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { decodeNecWireJson } from "@nec/core";
import { normalizeNetworkEvidenceV01 } from "@nec/hub";
import {
  buildLensCaseFromHubV01, projectLensBrowserSafeV01, serializeLensBrowserSafeV01, validateLensBrowserSafeCaseV01,
} from "@nec/lens";

import { validateNeMapsCollectionV01 } from "../ne-maps/collection.js";
import { EVIDENCE_RESULT_NON_CLAIMS, evaluateEvidenceResultCapture } from "./verify-evidence-result.js";
import type { EvidenceResultCliExitReason, EvidenceResultCliReport } from "./verify-evidence-result.js";

export const ACTION_CASE_BUILD_SCHEMA = "ne-hosted-action-case-build-report/v0.1";
export const ACTION_CASE_LENS_NAMESPACE = "nec.hosted-reproduction.action-case";

/** Same hostname list as the capture clients' target rule; re-derived here, never imported. */
const LOOPBACK_HOSTNAMES: readonly string[] = ["127.0.0.1", "localhost", "[::1]"];
/** NE Maps case id rule (examples/ne-maps/collection.js); checked early so a bad id is refused before any verification. */
const CASE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Canonical UTC ISO-8601 shape; Lens re-checks it. No Date is read here. */
const CREATED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const LOOPBACK_LABEL = "loopback replay (SIMULATED host), not a hosted observation";
export const HOSTED_LABEL =
  "operator-declared hosted capture; acquiringExecutable declaredBy operator, verifiedByThisClient false; a non-loopback URL is not evidence of an authentic hosted server";
export const CONTINUITY_LIMITATION = "Core preflight continuity is not precedence and not policy satisfaction";
export const GATE_ROW = "GT-02 stays OPEN; closure is an owner decision";
export const ANCHOR_ACCEPTANCE = "owner decision (anchor (c))";
export const COMPOSITION_RULE = "as implemented by the serving composer; owner ratification is not asserted by this tool";

export const ACTION_CASE_NON_CLAIMS: readonly string[] = Object.freeze([
  "Maps does not resolve network evidence. This collection was built offline from one verified resolve action capture; the builder computes no verdict, evidence or edge.",
  `${CONTINUITY_LIMITATION}.`,
  "A dimension the Core result does not evaluate stays unknown with no assessment; missing is never zero. Execution or observed effects do not imply settlement or finality.",
  `${GATE_ROW}. The builder closes no gate row.`,
  "Private by default: publishing any produced case is a separate HUMAN GATE.",
]);

export type ActionCaseBuildExitReason = EvidenceResultCliExitReason | "loopback_label_mismatch";

export interface ActionCaseBuildReport {
  readonly schema: typeof ACTION_CASE_BUILD_SCHEMA;
  /** The verify-CLI decision over the same inputs, verbatim. */
  readonly verification: EvidenceResultCliReport;
  /** "loopback" | "operator_declared_hosted" once the gate passed and the label held; null otherwise. */
  readonly hosted: "loopback" | "operator_declared_hosted" | null;
  readonly exitCode: 0 | 1;
  readonly exitReason: ActionCaseBuildExitReason;
}

export interface ActionCaseBuildInput {
  readonly capture: unknown;
  readonly context: unknown;
  readonly loadPreflightCapture?: () => unknown;
  readonly requireAnchored: boolean;
  readonly caseId: string;
  readonly createdAt: string;
}

export type NeMapsCollection = ReturnType<typeof validateNeMapsCollectionV01>;

export interface ActionCaseBuildOutcome {
  readonly report: ActionCaseBuildReport;
  /** Present only when exitCode is 0. */
  readonly collection: NeMapsCollection | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function refuse(message: string): never {
  throw new Error(`build-action-case: ${message}`);
}

/** Loopback re-derived from capture.target by hostname; null when it does not match capture.loopback. */
function hostedClass(capture: Record<string, unknown>): "loopback" | "operator_declared_hosted" | null {
  const target = capture.target;
  const declared = capture.loopback;
  if (typeof target !== "string" || typeof declared !== "boolean") return null;
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return null;
  }
  const derived = LOOPBACK_HOSTNAMES.includes(url.hostname);
  if (derived !== declared) return null;
  return derived ? "loopback" : "operator_declared_hosted";
}

/** The served Core result as wire text, exactly as the gate decoded it. */
function servedResultWire(capture: Record<string, unknown>): string {
  const call = capture.call;
  const envelope = isRecord(call) ? call.structuredContent : undefined;
  const served = isRecord(envelope) ? envelope.evidenceResult : undefined;
  if (!isRecord(served) || served.status !== "composed" || !isRecord(served.result)) refuse("verified capture carries no composed result");
  return JSON.stringify(served.result);
}

export async function buildActionCase(input: ActionCaseBuildInput): Promise<ActionCaseBuildOutcome> {
  const verification = await evaluateEvidenceResultCapture({
    capture: input.capture,
    context: input.context,
    ...(input.loadPreflightCapture === undefined ? {} : { loadPreflightCapture: input.loadPreflightCapture }),
    requireAnchored: input.requireAnchored,
  });
  const done = (
    hosted: ActionCaseBuildReport["hosted"], exitReason: ActionCaseBuildExitReason, collection: NeMapsCollection | null,
  ): ActionCaseBuildOutcome => ({
    report: {
      schema: ACTION_CASE_BUILD_SCHEMA, verification, hosted, exitCode: exitReason === "composed_result_verified" ? 0 : 1, exitReason,
    },
    collection,
  });
  // Gate parity: any non-zero verify-CLI decision is returned unchanged; no Core decode, Hub, Lens or Maps call.
  if (verification.exitCode !== 0 || verification.exitReason !== "composed_result_verified") {
    return done(null, verification.exitReason, null);
  }
  const report = verification.report;
  if (report === null || report.status !== "verified" || report.resultArtifactDigest === null || report.anchor === null
      || verification.contextSha256.recomputed === null || !verification.contextSha256.match) {
    refuse("verify-CLI report is inconsistent with composed_result_verified");
  }
  const capture = input.capture;
  if (!isRecord(capture)) refuse("capture is not an object");
  const hosted = hostedClass(capture);
  if (hosted === null) return done(null, "loopback_label_mismatch", null);
  const label = hosted === "loopback" ? LOOPBACK_LABEL : HOSTED_LABEL;

  // Core decode of the served wire; it must be the result the gate verified.
  const wire = servedResultWire(capture);
  const result = decodeNecWireJson("network-evidence-result", wire);
  if (result.artifactDigest !== report.resultArtifactDigest) refuse("served result is not the verified result");

  const hubRecord = normalizeNetworkEvidenceV01({ kind: "nec_wire_json_v1", wireType: "network-evidence-result", wire });
  if (hubRecord.result.artifactDigest !== result.artifactDigest || hubRecord.result.semanticDigest !== result.semanticDigest) {
    refuse("Hub record does not preserve the Core digests");
  }
  const lensCase = buildLensCaseFromHubV01({
    hubRecord,
    caseId: input.caseId,
    namespace: ACTION_CASE_LENS_NAMESPACE,
    createdAt: input.createdAt,
    limitations: [CONTINUITY_LIMITATION, label, GATE_ROW],
  });
  const browser = projectLensBrowserSafeV01(lensCase);
  validateLensBrowserSafeCaseV01(browser);
  const lens = JSON.parse(serializeLensBrowserSafeV01(browser)) as Record<string, unknown>;
  const subject = browser.coreResultPreservation?.subject;
  if (subject === undefined || subject.type !== "transaction") refuse("Lens case carries no transaction subject");

  const collection = {
    schemaVersion: "ne-maps-case-collection/v0.1",
    TARGET_CORE_MUTATIONS: 0,
    nonClaims: [...ACTION_CASE_NON_CLAIMS, label, ...EVIDENCE_RESULT_NON_CLAIMS],
    cases: [{
      schemaVersion: "ne-maps-case/v0.1",
      id: input.caseId,
      display: {
        networkLabel: `${subject.networkId} — ${label}`,
        title: "Action case — served evidenceResult → Core → Hub → Lens",
        shape: "Resolve action capture · verify-CLI gate · generic Core → Hub → Lens path",
      },
      exactAction: {
        kind: subject.type,
        networkId: subject.networkId,
        id: subject.txId,
        realityClass: label,
      },
      trailPropositionOrder: browser.propositions.map((p) => p.propositionId),
      lens,
      extensions: {
        provenance: {
          path: "resolve action capture -> verify-CLI composed_result_verified -> Core decodeNecWireJson -> @nec/hub nec_wire_json_v1 -> @nec/lens -> lens-browser/v0.1",
          hosted: label,
          /** JSON text of the capture's acquiringExecutable, verbatim (operator-declared, never verified). */
          acquiringExecutable: JSON.stringify(verification.acquiringExecutable),
          contextSha256: verification.contextSha256.recomputed,
          resultArtifactDigest: report.resultArtifactDigest,
          /** JSON text of {status, reason} of the context-bound anchor report. */
          anchor: JSON.stringify({ status: report.anchor.status, reason: report.anchor.reason }),
          preflightCapture: verification.preflightAnchor === null ? "not given" : `bound; anchor ${verification.preflightAnchor.status}`,
          requireAnchored: String(verification.requireAnchored),
          fixedBeforeExecution: String(report.fixedBeforeExecution),
          anchorAcceptance: ANCHOR_ACCEPTANCE,
          compositionRule: COMPOSITION_RULE,
          gateRow: GATE_ROW,
        },
      },
    }],
  };
  const validated = validateNeMapsCollectionV01(collection, { validateLens: (value) => validateLensBrowserSafeCaseV01(value) });
  return done(hosted, "composed_result_verified", validated);
}

export function serializeActionCaseCollection(collection: NeMapsCollection): string {
  return `${JSON.stringify(collection, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// CLI
//
//   tsx examples/hosted-reproduction/build-action-case.ts --capture resolve-capture.json \
//     --context evidence-context.json [--preflight-capture preflight-capture.json] [--require-anchored] \
//     --case-id <id> --created-at <ISO> --out case-collection.json
//
// An existing --out is refused before any file is read or verified; the write uses flag "wx".
// ---------------------------------------------------------------------------

const VALUE_FLAGS: readonly string[] = ["--capture", "--context", "--preflight-capture", "--case-id", "--created-at", "--out"];

export interface ActionCaseArgs {
  readonly capture: string;
  readonly context: string;
  readonly preflightCapture: string | undefined;
  readonly requireAnchored: boolean;
  readonly caseId: string;
  readonly createdAt: string;
  readonly out: string;
}

export function parseActionCaseArgs(argv: readonly string[]): ActionCaseArgs {
  const values = new Map<string, string>();
  let requireAnchored = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] as string;
    if (flag === "--require-anchored") {
      if (requireAnchored) throw new Error("--require-anchored given more than once");
      requireAnchored = true;
      continue;
    }
    if (!VALUE_FLAGS.includes(flag)) throw new Error(`unknown argument ${JSON.stringify(flag)}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    if (values.has(flag)) throw new Error(`${flag} given more than once`);
    values.set(flag, value);
    i += 1;
  }
  const required = (flag: string, what: string): string => {
    const value = values.get(flag);
    if (value === undefined) throw new Error(`${flag} <${what}> is required`);
    return value;
  };
  const capture = required("--capture", "resolve action capture");
  const context = required("--context", "evidenceContext file");
  const caseId = required("--case-id", "id");
  const createdAt = required("--created-at", "ISO");
  const out = required("--out", "file");
  if (!CASE_ID.test(caseId)) throw new Error("--case-id must be a lowercase URL-safe id ([a-z0-9][a-z0-9-]{0,63})");
  if (!CREATED_AT.test(createdAt)) throw new Error("--created-at must be canonical UTC ISO-8601 (YYYY-MM-DDTHH:MM:SS.sssZ)");
  return { capture, context, preflightCapture: values.get("--preflight-capture"), requireAnchored, caseId, createdAt, out };
}

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseActionCaseArgs(argv);
  // Before any read or verification.
  if (existsSync(args.out)) throw new Error(`--out ${JSON.stringify(args.out)} already exists; refusing to overwrite`);
  const preflightPath = args.preflightCapture;
  const { report, collection } = await buildActionCase({
    capture: readJsonFile(args.capture),
    context: readJsonFile(args.context),
    ...(preflightPath === undefined ? {} : { loadPreflightCapture: () => readJsonFile(preflightPath) }),
    requireAnchored: args.requireAnchored,
    caseId: args.caseId,
    createdAt: args.createdAt,
  });
  if (report.exitCode === 0) {
    if (collection === null) throw new Error("build-action-case: no collection for a zero exit");
    writeFileSync(args.out, serializeActionCaseCollection(collection), { encoding: "utf8", flag: "wx" });
  }
  process.stdout.write(`${JSON.stringify({ ...report, written: report.exitCode === 0 }, null, 2)}\n`);
  return report.exitCode;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`build-action-case: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}
