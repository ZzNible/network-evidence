/**
 * `get_reviewed_evidence_case`: exact-id reads of the ALREADY-SHIPPED NE Maps
 * collection `examples/ne-maps/data/collection.json`.
 *
 * The file path is fixed (never caller-supplied). At startup the bytes are
 * checked against the SHA-256 pinned here AND in `data/COLLECTION.sha256`,
 * strictly parsed by @nec/core (duplicate keys fail closed), and validated by
 * the shipped Maps collection validator with the public @nec/lens
 * browser-safe validator for every nested Lens. Any mismatch is fatal: the
 * server refuses to start rather than serve unverified data.
 *
 * Each case envelope is returned VERBATIM (browser-safe Lens projection,
 * limitations, open questions, unavailable/unknown states, extensions,
 * provenance), together with the collection-level nonClaims and an explicit
 * historical vs synthetic label. Nothing here is a live observation.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { deepFreeze, parseNecWireJson } from "@nec/core";
import { validateLensBrowserSafeCaseV01 } from "@nec/lens";

import { validateNeMapsCollectionV01 } from "../../../examples/ne-maps/collection.js";
import { NeMcpError } from "./errors.js";

export const REVIEWED_CASE_SCHEMA = "ne-mcp-reviewed-case/v0.1";

/** Repository-relative path of the shipped collection (fixed; never caller-supplied). */
export const REVIEWED_COLLECTION_PATH = "examples/ne-maps/data/collection.json";
export const REVIEWED_COLLECTION_PIN_PATH = "examples/ne-maps/data/COLLECTION.sha256";
/** SHA-256 of the shipped collection bytes this server version was reviewed against. */
export const REVIEWED_COLLECTION_SHA256 = "e10250b3f4714883f54c96003f1cdb5f1c2ed36cb7bd18dcf3f94b194139fa49";

const REPO_ROOT = new URL("../../../", import.meta.url);

export type EvidenceClass = "historical-reviewed-public-network-fixture" | "synthetic-local-fixture";

interface ClassLabel {
  readonly evidenceClass: EvidenceClass;
  readonly label: string;
}

/** Closed mapping from the envelope's own provenance.realityClass. Anything else fails closed. */
const CLASS_BY_REALITY: ReadonlyMap<string, ClassLabel> = new Map([
  [
    "reviewed public network fixture",
    {
      evidenceClass: "historical-reviewed-public-network-fixture",
      label:
        "HISTORICAL — frozen reviewed export of PAST public-network observations at pinned commits. Not a live observation; the current network state and current availability are unknown. Partial: read limitations and openQuestions.",
    },
  ],
  [
    "synthetic/local",
    {
      evidenceClass: "synthetic-local-fixture",
      label:
        "SYNTHETIC / LOCAL FIXTURE — not a network observation. Identifiers are fixture literals that were never observed on any network.",
    },
  ],
]);

export const CASE_SERVER_NON_CLAIMS: readonly string[] = Object.freeze([
  "This server read a fixed, checksum-pinned local file. It performed no network lookup and did not re-resolve or re-verify any network evidence.",
  "No case is live evidence. Historical cases describe past observations only; synthetic cases are not network observations.",
  "No global case verdict, confidence, trust score, ranking, policy decision, settlement or finality upgrade is produced.",
]);

export interface ReviewedCaseOutput {
  readonly schema: typeof REVIEWED_CASE_SCHEMA;
  readonly caseId: string;
  readonly evidenceClass: EvidenceClass;
  readonly label: string;
  readonly liveObservation: false;
  readonly currentAvailability: "unknown";
  readonly source: {
    readonly path: string;
    readonly sha256: string;
    readonly pinnedBy: readonly string[];
    readonly collectionSchemaVersion: string;
    readonly validatedBy: readonly string[];
  };
  readonly caseProvenance: Record<string, unknown>;
  readonly collectionNonClaims: readonly string[];
  readonly serverNonClaims: readonly string[];
  /** THE shipped ne-maps-case/v0.1 envelope, verbatim. */
  readonly envelope: Record<string, unknown>;
}

export interface ReviewedCaseStore {
  readonly caseIds: readonly string[];
  get(caseId: string): ReviewedCaseOutput;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fatal(message: string): never {
  throw new Error(`reviewed case store: ${message}`);
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fatal(`${what} is not an object`);
  return value as Record<string, unknown>;
}

/** Load, pin-check and validate the shipped collection. Throws (fatal) on any mismatch. */
export function loadReviewedCaseStore(): ReviewedCaseStore {
  const bytes = readFileSync(fileURLToPath(new URL(REVIEWED_COLLECTION_PATH, REPO_ROOT)));
  const actual = sha256Hex(bytes);
  if (actual !== REVIEWED_COLLECTION_SHA256) {
    fatal(`${REVIEWED_COLLECTION_PATH} sha256 ${actual} does not match the pinned ${REVIEWED_COLLECTION_SHA256}`);
  }
  const pinLine = readFileSync(fileURLToPath(new URL(REVIEWED_COLLECTION_PIN_PATH, REPO_ROOT)), "utf8").trim();
  if (pinLine !== `${REVIEWED_COLLECTION_SHA256}  collection.json`) {
    fatal(`${REVIEWED_COLLECTION_PIN_PATH} does not pin ${REVIEWED_COLLECTION_SHA256}`);
  }
  const parsed = parseNecWireJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  const collection = validateNeMapsCollectionV01(parsed, {
    validateLens: (lens) => validateLensBrowserSafeCaseV01(lens),
  }) as unknown as Record<string, unknown>;

  const nonClaims = collection.nonClaims;
  if (!Array.isArray(nonClaims) || nonClaims.length === 0 || !nonClaims.every((claim) => typeof claim === "string")) {
    fatal("collection nonClaims must be a non-empty string list");
  }
  const schemaVersion = collection.schemaVersion;
  if (typeof schemaVersion !== "string") fatal("collection schemaVersion is missing");
  if (!Array.isArray(collection.cases)) fatal("collection cases is not a list");

  const cases = new Map<string, ReviewedCaseOutput>();
  for (const raw of collection.cases) {
    const envelope = record(raw, "case envelope");
    const caseId = envelope.id;
    if (typeof caseId !== "string") fatal("case envelope id is not a string");
    const extensions = record(envelope.extensions, `case ${caseId} extensions`);
    const provenance = record(extensions.provenance, `case ${caseId} extensions.provenance`);
    const reality = provenance.realityClass;
    const cls = typeof reality === "string" ? CLASS_BY_REALITY.get(reality) : undefined;
    if (cls === undefined) fatal(`case ${caseId} has an unmapped provenance.realityClass`);
    cases.set(
      caseId,
      deepFreeze({
        schema: REVIEWED_CASE_SCHEMA,
        caseId,
        evidenceClass: cls.evidenceClass,
        label: cls.label,
        liveObservation: false,
        currentAvailability: "unknown",
        source: {
          path: REVIEWED_COLLECTION_PATH,
          sha256: actual,
          pinnedBy: [REVIEWED_COLLECTION_PIN_PATH, "@nec/mcp REVIEWED_COLLECTION_SHA256"],
          collectionSchemaVersion: schemaVersion,
          validatedBy: [
            "examples/ne-maps/collection.js validateNeMapsCollectionV01",
            "@nec/lens validateLensBrowserSafeCaseV01",
          ],
        },
        caseProvenance: provenance,
        collectionNonClaims: nonClaims as string[],
        serverNonClaims: CASE_SERVER_NON_CLAIMS,
        envelope,
      }) as ReviewedCaseOutput,
    );
  }
  if (cases.size === 0) fatal("collection has no cases");
  const caseIds = Object.freeze([...cases.keys()]);
  return Object.freeze({
    caseIds,
    get(caseId: string): ReviewedCaseOutput {
      const found = cases.get(caseId);
      if (found === undefined) {
        throw new NeMcpError(
          "MCP_CASE_UNKNOWN",
          `unknown caseId (exact match required); known ids: ${caseIds.join(", ")}`,
        );
      }
      return found;
    },
  });
}
