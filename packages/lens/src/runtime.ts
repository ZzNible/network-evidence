import {
  EVIDENCE_BASES,
  EVIDENCE_VERDICTS,
  deepFreeze,
  isDigest,
  validateNetworkEvidenceResult,
} from "@nec/core";
import type {
  EvidenceDimension,
  EvidenceRef,
  NetworkEvidenceResult,
  SubjectRef,
} from "@nec/core";
import type { HubNetworkEvidenceRecordV01 } from "@nec/hub";

import { canonicalHubJsonV01, hubRevisionDigestV01 } from "./canonical.js";
import {
  LENS_BROWSER_PROJECTION_VERSION,
  LENS_CANONICALIZATION_PROFILE,
  LENS_CASE_SCHEMA_VERSION,
  TARGET_CORE_MUTATIONS,
  type BuildLensCaseFromHubInputV01,
  type LensArtifactRefV01,
  type LensAssessmentV01,
  type LensBrowserSafeCaseV01,
  type LensCaseV01,
  type LensDigestV01,
  type LensPropositionV01,
  type LensSubjectRefV01,
} from "./types.js";

const TOP_LEVEL_FIELDS = new Set([
  "schemaVersion", "caseId", "namespace", "createdAt", "constructionTimeMeaning",
  "fixture", "fixtureClass", "realityClass", "syntheticArtifactCount", "artifacts",
  "sourceClaims", "propositions", "relations", "openQuestions", "limitations",
  "coreResultPreservation", "revisionDigest", "TARGET_CORE_MUTATIONS", "extensions",
  "networkEvidence", "frozenSourceIndex", "publicSourceIndex", "exactReviewedSemantics",
  "browserDigestPolicy", "rendering", "projectionPolicy",
]);
const BROWSER_TOP_LEVEL_FIELDS = new Set([...TOP_LEVEL_FIELDS, "revisionDigestVisibility"]);
const FORBIDDEN_LENS_AUTHORITY_FIELDS = new Set([
  "caseVerdict", "confidence", "trustScore", "score", "policyDecision",
]);
const AVAILABILITIES = new Set(["available", "unavailable", "redacted", "unknown"]);
const PROP_AVAILABILITIES = new Set([...AVAILABILITIES, "not_applicable"]);
const QUESTION_STATUSES = new Set(["unresolved", "not_applicable", "awaiting_evidence", "conflicting_evidence"]);
const CORE_BASES = new Set<string>(EVIDENCE_BASES);
const CORE_VERDICTS = new Set<string>(EVIDENCE_VERDICTS);

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`@nec/lens: ${path} must be a plain object`);
  return value;
}

function string(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new TypeError(`@nec/lens: ${path} must be ${allowEmpty ? "a" : "a non-empty"} string`);
  }
  return value;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`@nec/lens: ${path} must be an array`);
  return value;
}

function strings(value: unknown, path: string): string[] {
  return array(value, path).map((item, index) => string(item, `${path}[${index}]`, true));
}

function assertIso(value: unknown, path: string): void {
  const text = string(value, path);
  const time = Date.parse(text);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== text) {
    throw new TypeError(`@nec/lens: ${path} must be canonical UTC ISO-8601`);
  }
}

function assertAllowedTopLevel(value: Record<string, unknown>, browser: boolean): void {
  const allowed = browser ? BROWSER_TOP_LEVEL_FIELDS : TOP_LEVEL_FIELDS;
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_LENS_AUTHORITY_FIELDS.has(key)) throw new TypeError(`@nec/lens: forbidden authority field ${key}`);
    if (!allowed.has(key)) throw new TypeError(`@nec/lens: unknown top-level field ${key}`);
  }
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`@nec/lens: unknown ${path} field ${key}`);
  }
}

function optionalString(value: unknown, path: string, allowNull = false): void {
  if (value === undefined || (allowNull && value === null)) return;
  string(value, path, true);
}

const GENERIC_BROWSER_TOP_LEVEL_FIELDS = new Set([
  "schemaVersion", "caseId", "namespace", "createdAt", "constructionTimeMeaning",
  "fixture", "fixtureClass", "realityClass", "syntheticArtifactCount", "artifacts",
  "sourceClaims", "propositions", "relations", "openQuestions", "limitations",
  "coreResultPreservation", "revisionDigest", "revisionDigestVisibility",
  "TARGET_CORE_MUTATIONS", "projectionPolicy",
]);
const BROWSER_ARTIFACT_FIELDS = new Set([
  "artifactId", "artifactType", "sourceSchema", "mediaType", "artifactDigest",
  "artifactDigestVisibility", "locatorClass", "locatorRef", "sourceObservedAt",
  "capturedAt", "fixtureObservedAt", "availability", "redaction", "realityClass",
  "fixture", "fixtureClass", "limitations",
]);
const BROWSER_REDACTION_FIELDS = new Set([
  "state", "derivedFromArtifactId", "derivativeArtifactId", "transformation", "sourceArtifactRef",
]);
const BROWSER_CLAIM_FIELDS = new Set([
  "claimId", "artifactId", "claimType", "vocabulary", "extractionBasis", "basis",
  "evidenceRefs", "limitations",
]);
const BROWSER_PROPOSITION_FIELDS = new Set([
  "propositionId", "domain", "statement", "kind", "subjectRefs", "sourceClaimRefs",
  "assessments", "availability", "limitations",
]);
const BROWSER_ASSESSMENT_FIELDS = new Set([
  "assessmentId", "propositionId", "evaluator", "vocabulary", "value", "basis",
  "evidenceRefs", "evaluatedAt", "limitations",
]);
const BROWSER_EVALUATOR_FIELDS = new Set([
  "type", "version", "buildRef", "verificationMode", "provenanceClass",
]);
const BROWSER_RELATION_FIELDS = new Set([
  "relationId", "fromRef", "toRef", "relationType", "basis", "assertedBy",
  "evidenceRefs", "limitations",
]);
const BROWSER_QUESTION_FIELDS = new Set([
  "questionId", "domain", "statement", "status", "relatedPropositionRefs", "reason",
]);
const BROWSER_CORE_PRESERVATION_FIELDS = new Set([
  "sourceSemanticDigest", "sourceArtifactDigest", "subject", "resolver",
  "observedEffectIds", "warningCodes", "conflictIds",
]);
const BROWSER_RESOLVER_FIELDS = new Set(["id", "version", "digest"]);

function digestToLens(digest: string, digestOf: string): LensDigestV01 {
  if (!isDigest(digest)) throw new TypeError(`@nec/lens: invalid Core digest for ${digestOf}`);
  return { algorithm: "sha256", value: digest.slice("sha256:".length), digestOf };
}

function assertLensDigest(value: unknown, path: string): void {
  const d = record(value, path);
  assertOnlyKeys(d, new Set(["algorithm", "value", "digestOf", "canonicalization", "schemaVersion", "byteLength"]), path);
  if (d.algorithm !== "sha256") throw new TypeError(`@nec/lens: ${path}.algorithm must be sha256`);
  if (typeof d.value !== "string" || !/^[0-9a-f]{64}$/.test(d.value)) throw new TypeError(`@nec/lens: ${path}.value must be 64 lowercase hex`);
  string(d.digestOf, `${path}.digestOf`);
  if (d.canonicalization !== undefined) string(d.canonicalization, `${path}.canonicalization`);
  if (d.schemaVersion !== undefined) string(d.schemaVersion, `${path}.schemaVersion`);
  if (d.byteLength !== undefined && (!Number.isSafeInteger(d.byteLength) || (d.byteLength as number) < 0)) {
    throw new TypeError(`@nec/lens: ${path}.byteLength must be a non-negative safe integer`);
  }
}

function toLensSubject(subject: SubjectRef): LensSubjectRefV01 {
  switch (subject.type) {
    case "transaction":
      return { type: subject.type, networkId: subject.networkId, txId: subject.txId };
    case "block":
      return {
        type: subject.type,
        networkId: subject.networkId,
        ...(subject.blockNumber === undefined ? {} : { blockNumber: subject.blockNumber.toString(10) }),
        ...(subject.blockId === undefined ? {} : { blockId: subject.blockId }),
      };
    case "batch":
      return { type: subject.type, networkId: subject.networkId, batchId: subject.batchId };
    case "custom":
      return { type: subject.type, networkId: subject.networkId, namespace: subject.namespace, value: subject.value };
  }
}

function assertLensSubject(value: unknown, path: string): void {
  const s = record(value, path);
  const type = string(s.type, `${path}.type`);
  string(s.networkId, `${path}.networkId`);
  if (type === "transaction") {
    assertOnlyKeys(s, new Set(["type", "networkId", "txId"]), path);
    string(s.txId, `${path}.txId`);
  } else if (type === "block") {
    assertOnlyKeys(s, new Set(["type", "networkId", "blockNumber", "blockId"]), path);
    if (s.blockNumber !== undefined && (typeof s.blockNumber !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(s.blockNumber))) {
      throw new TypeError(`@nec/lens: ${path}.blockNumber must be a canonical decimal string`);
    }
    if (s.blockId !== undefined) string(s.blockId, `${path}.blockId`);
  } else if (type === "batch") {
    assertOnlyKeys(s, new Set(["type", "networkId", "batchId"]), path);
    string(s.batchId, `${path}.batchId`);
  } else if (type === "custom") {
    assertOnlyKeys(s, new Set(["type", "networkId", "namespace", "value"]), path);
    string(s.namespace, `${path}.namespace`);
    string(s.value, `${path}.value`, true);
  } else throw new TypeError(`@nec/lens: ${path}.type is unsupported`);
}

function copyLensSubject(value: LensSubjectRefV01): LensSubjectRefV01 {
  switch (value.type) {
    case "transaction":
      return { type: value.type, networkId: value.networkId, txId: value.txId };
    case "block":
      return {
        type: value.type,
        networkId: value.networkId,
        ...(value.blockNumber === undefined ? {} : { blockNumber: value.blockNumber }),
        ...(value.blockId === undefined ? {} : { blockId: value.blockId }),
      };
    case "batch":
      return { type: value.type, networkId: value.networkId, batchId: value.batchId };
    case "custom":
      return { type: value.type, networkId: value.networkId, namespace: value.namespace, value: value.value };
  }
}

function evidenceArtifactId(id: string): string {
  return `core-evidence:${id}`;
}

function evidenceArtifact(ref: EvidenceRef): LensArtifactRefV01 {
  return {
    artifactId: evidenceArtifactId(ref.id),
    artifactType: "network_evidence_source_ref",
    sourceSchema: "@nec/core/evidence-ref/v0.1",
    ...(ref.nativeSource?.mediaType === undefined ? {} : { mediaType: ref.nativeSource.mediaType }),
    artifactDigest: ref.contentDigest ? digestToLens(ref.contentDigest, "core_evidence_content") : null,
    locatorClass: ref.locator ? "core_evidence_locator" : "none",
    locatorRef: ref.locator ?? null,
    availability: "unknown",
    limitations: [],
  };
}

function dimensionProposition(
  result: NetworkEvidenceResult,
  key: "execution" | "dataBinding" | "settlement" | "finality",
  label: string,
  dimension: EvidenceDimension,
): LensPropositionV01 {
  const propositionId = `network.${key}`;
  const assessments: LensAssessmentV01[] = [];
  if (dimension.verdict !== undefined) {
    assessments.push({
      assessmentId: `assessment.${propositionId}`,
      propositionId,
      evaluator: {
        type: "network_evidence",
        version: result.schemaVersion,
        buildRef: result.resolver.digest,
        verificationMode: "preserved_core_result",
        provenanceClass: "validated_network_evidence_result",
      },
      vocabulary: "network_evidence_verdict/v0.1",
      value: dimension.verdict,
      basis: [...dimension.basis],
      evidenceRefs: dimension.evidence.map(evidenceArtifactId),
      evaluatedAt: result.generatedAt,
      limitations: dimension.reason ? [dimension.reason] : [],
    });
  }

  const availability = dimension.verdict !== undefined
    ? "available"
    : dimension.applicability === "not_applicable"
      ? "not_applicable"
      : "unknown";

  return {
    propositionId,
    domain: "network",
    kind: `network_evidence.${key}`,
    statement: `Network Evidence ${label} assessment for the exact action.`,
    subjectRefs: ["network-evidence-result"],
    assessments,
    availability,
    limitations: dimension.reason ? [dimension.reason] : [],
  };
}

function validateHubRecord(recordValue: HubNetworkEvidenceRecordV01): NetworkEvidenceResult {
  const r = record(recordValue, "hubRecord");
  if (r.schemaVersion !== "hub-network-evidence-record/v0.1") throw new TypeError("@nec/lens: unsupported Hub schema");
  if (r.sourceType !== "network_evidence_result" || r.sourceSchemaVersion !== "0.1") {
    throw new TypeError("@nec/lens: incompatible Hub source record");
  }
  const result = r.result;
  validateNetworkEvidenceResult(result);
  return result as NetworkEvidenceResult;
}

function validateArtifacts(value: unknown, browser: boolean): void {
  const seen = new Set<string>();
  for (const [index, item] of array(value, "artifacts").entries()) {
    const a = record(item, `artifacts[${index}]`);
    const id = string(a.artifactId, `artifacts[${index}].artifactId`);
    if (seen.has(id)) throw new TypeError(`@nec/lens: duplicate artifactId ${id}`);
    seen.add(id);
    string(a.artifactType, `artifacts[${index}].artifactType`);
    optionalString(a.sourceSchema, `artifacts[${index}].sourceSchema`, true);
    optionalString(a.mediaType, `artifacts[${index}].mediaType`);
    optionalString(a.locatorClass, `artifacts[${index}].locatorClass`);
    optionalString(a.locatorRef, `artifacts[${index}].locatorRef`, true);
    optionalString(a.sourceObservedAt, `artifacts[${index}].sourceObservedAt`, true);
    optionalString(a.capturedAt, `artifacts[${index}].capturedAt`, true);
    optionalString(a.fixtureObservedAt, `artifacts[${index}].fixtureObservedAt`, true);
    optionalString(a.realityClass, `artifacts[${index}].realityClass`);
    optionalString(a.fixtureClass, `artifacts[${index}].fixtureClass`);
    if (a.fixture !== undefined && typeof a.fixture !== "boolean") throw new TypeError(`@nec/lens: artifacts[${index}].fixture must be boolean`);
    if (a.limitations !== undefined) strings(a.limitations, `artifacts[${index}].limitations`);
    if (a.redaction !== undefined) {
      const redaction = record(a.redaction, `artifacts[${index}].redaction`);
      string(redaction.state, `artifacts[${index}].redaction.state`);
      if (redaction.derivedFromArtifactId !== null) {
        string(redaction.derivedFromArtifactId, `artifacts[${index}].redaction.derivedFromArtifactId`);
      }
      optionalString(redaction.derivativeArtifactId, `artifacts[${index}].redaction.derivativeArtifactId`, true);
      optionalString(redaction.transformation, `artifacts[${index}].redaction.transformation`, true);
      optionalString(redaction.sourceArtifactRef, `artifacts[${index}].redaction.sourceArtifactRef`, true);
    }
    if (!AVAILABILITIES.has(string(a.availability, `artifacts[${index}].availability`))) throw new TypeError("@nec/lens: invalid artifact availability");
    if (a.artifactDigest !== undefined && a.artifactDigest !== null) assertLensDigest(a.artifactDigest, `artifacts[${index}].artifactDigest`);
    if (browser && a.locatorRef !== null) throw new TypeError("@nec/lens: browser artifact locatorRef must be null");
  }
}

function validateSourceClaims(value: unknown): void {
  for (const [index, item] of array(value, "sourceClaims").entries()) {
    const c = record(item, `sourceClaims[${index}]`);
    string(c.claimId, `sourceClaims[${index}].claimId`);
    string(c.artifactId, `sourceClaims[${index}].artifactId`);
    string(c.claimType, `sourceClaims[${index}].claimType`);
    string(c.vocabulary, `sourceClaims[${index}].vocabulary`);
    string(c.extractionBasis, `sourceClaims[${index}].extractionBasis`);
    if (c.basis !== undefined) strings(c.basis, `sourceClaims[${index}].basis`);
    if (c.evidenceRefs !== undefined) strings(c.evidenceRefs, `sourceClaims[${index}].evidenceRefs`);
    if (c.limitations !== undefined) strings(c.limitations, `sourceClaims[${index}].limitations`);
  }
}

function validatePropositions(value: unknown): void {
  const seen = new Set<string>();
  for (const [index, item] of array(value, "propositions").entries()) {
    const p = record(item, `propositions[${index}]`);
    const propositionId = string(p.propositionId, `propositions[${index}].propositionId`);
    if (seen.has(propositionId)) throw new TypeError(`@nec/lens: duplicate propositionId ${propositionId}`);
    seen.add(propositionId);
    string(p.domain, `propositions[${index}].domain`);
    string(p.statement, `propositions[${index}].statement`);
    optionalString(p.kind, `propositions[${index}].kind`);
    strings(p.subjectRefs, `propositions[${index}].subjectRefs`);
    if (p.sourceClaimRefs !== undefined) strings(p.sourceClaimRefs, `propositions[${index}].sourceClaimRefs`);
    strings(p.limitations, `propositions[${index}].limitations`);
    if (p.availability !== undefined && !PROP_AVAILABILITIES.has(string(p.availability, `propositions[${index}].availability`))) {
      throw new TypeError("@nec/lens: invalid proposition availability");
    }
    for (const [aIndex, aItem] of array(p.assessments, `propositions[${index}].assessments`).entries()) {
      const a = record(aItem, `propositions[${index}].assessments[${aIndex}]`);
      string(a.assessmentId, `assessment.assessmentId`);
      if (a.propositionId !== propositionId) throw new TypeError("@nec/lens: assessment propositionId mismatch");
      const evaluator = record(a.evaluator, "assessment.evaluator");
      const evaluatorType = string(evaluator.type, "assessment.evaluator.type");
      optionalString(evaluator.version, "assessment.evaluator.version", true);
      optionalString(evaluator.buildRef, "assessment.evaluator.buildRef", true);
      optionalString(evaluator.verificationMode, "assessment.evaluator.verificationMode");
      optionalString(evaluator.provenanceClass, "assessment.evaluator.provenanceClass");
      const vocabulary = string(a.vocabulary, "assessment.vocabulary");
      const assessmentValue = string(a.value, "assessment.value");
      const basis = strings(a.basis, "assessment.basis");
      strings(a.evidenceRefs, "assessment.evidenceRefs");
      optionalString(a.evaluatedAt, "assessment.evaluatedAt", true);
      strings(a.limitations, "assessment.limitations");
      if (evaluatorType === "network_evidence" || vocabulary === "network_evidence_verdict/v0.1") {
        if (vocabulary !== "network_evidence_verdict/v0.1") throw new TypeError("@nec/lens: Network Evidence vocabulary mismatch");
        if (!CORE_VERDICTS.has(assessmentValue)) throw new TypeError("@nec/lens: invalid Network Evidence verdict");
        for (const itemBasis of basis) if (!CORE_BASES.has(itemBasis)) throw new TypeError("@nec/lens: invalid Network Evidence basis");
      }
    }
  }
}

function validateRelations(value: unknown): void {
  for (const [index, item] of array(value, "relations").entries()) {
    const r = record(item, `relations[${index}]`);
    for (const key of ["relationId", "fromRef", "toRef", "relationType", "basis"] as const) string(r[key], `relations[${index}].${key}`);
    optionalString(r.assertedBy, `relations[${index}].assertedBy`);
    if (r.evidenceRefs !== undefined) strings(r.evidenceRefs, `relations[${index}].evidenceRefs`);
    strings(r.limitations, `relations[${index}].limitations`);
  }
}

function validateQuestions(value: unknown): void {
  for (const [index, item] of array(value, "openQuestions").entries()) {
    const q = record(item, `openQuestions[${index}]`);
    string(q.questionId, `openQuestions[${index}].questionId`);
    string(q.domain, `openQuestions[${index}].domain`);
    optionalString(q.statement, `openQuestions[${index}].statement`);
    const status = string(q.status, `openQuestions[${index}].status`);
    if (!QUESTION_STATUSES.has(status)) throw new TypeError("@nec/lens: invalid open-question status");
    strings(q.relatedPropositionRefs, `openQuestions[${index}].relatedPropositionRefs`);
    string(q.reason, `openQuestions[${index}].reason`);
  }
}

function validateCorePreservation(value: unknown, browser: boolean): void {
  if (value === undefined) return;
  const p = record(value, "coreResultPreservation");
  if (!isDigest(p.sourceSemanticDigest) || !isDigest(p.sourceArtifactDigest)) throw new TypeError("@nec/lens: invalid preserved Core digest");
  assertLensSubject(p.subject, "coreResultPreservation.subject");
  const resolver = record(p.resolver, "coreResultPreservation.resolver");
  assertOnlyKeys(resolver, new Set(["id", "version", "digest"]), "coreResultPreservation.resolver");
  string(resolver.id, "coreResultPreservation.resolver.id");
  string(resolver.version, "coreResultPreservation.resolver.version");
  if (!isDigest(resolver.digest)) throw new TypeError("@nec/lens: invalid resolver digest");
  if (browser) {
    strings(p.observedEffectIds, "coreResultPreservation.observedEffectIds");
    strings(p.warningCodes, "coreResultPreservation.warningCodes");
    strings(p.conflictIds, "coreResultPreservation.conflictIds");
  } else {
    for (const [index, item] of array(p.observedEffects, "coreResultPreservation.observedEffects").entries()) {
      string(record(item, `coreResultPreservation.observedEffects[${index}]`).id, `coreResultPreservation.observedEffects[${index}].id`);
    }
    for (const [index, item] of array(p.warnings, "coreResultPreservation.warnings").entries()) {
      string(record(item, `coreResultPreservation.warnings[${index}]`).code, `coreResultPreservation.warnings[${index}].code`);
    }
    for (const [index, item] of array(p.conflicts, "coreResultPreservation.conflicts").entries()) {
      string(record(item, `coreResultPreservation.conflicts[${index}]`).id, `coreResultPreservation.conflicts[${index}].id`);
    }
  }
}

function validateGenericBrowserAllowlist(value: Record<string, unknown>): void {
  assertOnlyKeys(value, GENERIC_BROWSER_TOP_LEVEL_FIELDS, "browserCase");
  for (const [index, item] of array(value.artifacts, "artifacts").entries()) {
    const artifact = record(item, `artifacts[${index}]`);
    assertOnlyKeys(artifact, BROWSER_ARTIFACT_FIELDS, `artifacts[${index}]`);
    if (artifact.artifactDigest !== null) throw new TypeError(`@nec/lens: artifacts[${index}].artifactDigest must be null in lens-browser/v0.1`);
    if (artifact.artifactDigestVisibility !== "withheld_by_browser_policy" && artifact.artifactDigestVisibility !== "not_available") {
      throw new TypeError(`@nec/lens: artifacts[${index}].artifactDigestVisibility is invalid`);
    }
    if (artifact.redaction !== undefined) {
      assertOnlyKeys(record(artifact.redaction, `artifacts[${index}].redaction`), BROWSER_REDACTION_FIELDS, `artifacts[${index}].redaction`);
    }
  }
  for (const [index, item] of array(value.sourceClaims, "sourceClaims").entries()) {
    assertOnlyKeys(record(item, `sourceClaims[${index}]`), BROWSER_CLAIM_FIELDS, `sourceClaims[${index}]`);
  }
  for (const [pIndex, item] of array(value.propositions, "propositions").entries()) {
    const proposition = record(item, `propositions[${pIndex}]`);
    assertOnlyKeys(proposition, BROWSER_PROPOSITION_FIELDS, `propositions[${pIndex}]`);
    for (const [aIndex, aItem] of array(proposition.assessments, `propositions[${pIndex}].assessments`).entries()) {
      const assessment = record(aItem, `propositions[${pIndex}].assessments[${aIndex}]`);
      assertOnlyKeys(assessment, BROWSER_ASSESSMENT_FIELDS, `propositions[${pIndex}].assessments[${aIndex}]`);
      assertOnlyKeys(record(assessment.evaluator, `propositions[${pIndex}].assessments[${aIndex}].evaluator`), BROWSER_EVALUATOR_FIELDS, `propositions[${pIndex}].assessments[${aIndex}].evaluator`);
    }
  }
  for (const [index, item] of array(value.relations, "relations").entries()) {
    assertOnlyKeys(record(item, `relations[${index}]`), BROWSER_RELATION_FIELDS, `relations[${index}]`);
  }
  for (const [index, item] of array(value.openQuestions, "openQuestions").entries()) {
    assertOnlyKeys(record(item, `openQuestions[${index}]`), BROWSER_QUESTION_FIELDS, `openQuestions[${index}]`);
  }
  if (value.coreResultPreservation !== undefined) {
    const preserved = record(value.coreResultPreservation, "coreResultPreservation");
    assertOnlyKeys(preserved, BROWSER_CORE_PRESERVATION_FIELDS, "coreResultPreservation");
    assertOnlyKeys(record(preserved.resolver, "coreResultPreservation.resolver"), BROWSER_RESOLVER_FIELDS, "coreResultPreservation.resolver");
    assertLensSubject(preserved.subject, "coreResultPreservation.subject");
  }
}

function validateCommon(value: unknown, browser: boolean): Record<string, unknown> {
  const c = record(value, browser ? "browserCase" : "case");
  assertAllowedTopLevel(c, browser);
  if (c.schemaVersion !== LENS_CASE_SCHEMA_VERSION) throw new TypeError("@nec/lens: unsupported Lens schemaVersion");
  string(c.caseId, "caseId");
  string(c.namespace, "namespace");
  assertIso(c.createdAt, "createdAt");
  optionalString(c.constructionTimeMeaning, "constructionTimeMeaning");
  if (c.fixture !== undefined && typeof c.fixture !== "boolean") throw new TypeError("@nec/lens: fixture must be boolean");
  optionalString(c.fixtureClass, "fixtureClass");
  optionalString(c.realityClass, "realityClass");
  if (c.syntheticArtifactCount !== undefined && (!Number.isSafeInteger(c.syntheticArtifactCount) || (c.syntheticArtifactCount as number) < 0)) {
    throw new TypeError("@nec/lens: syntheticArtifactCount must be a non-negative safe integer");
  }
  if (c.TARGET_CORE_MUTATIONS !== 0) throw new TypeError("@nec/lens: TARGET_CORE_MUTATIONS must be 0");
  validateArtifacts(c.artifacts, browser);
  validateSourceClaims(c.sourceClaims);
  validatePropositions(c.propositions);
  validateRelations(c.relations);
  validateQuestions(c.openQuestions);
  strings(c.limitations, "limitations");
  validateCorePreservation(c.coreResultPreservation, browser);
  if (c.projectionPolicy !== undefined) string(c.projectionPolicy, "projectionPolicy");
  return c;
}

export function validateLensCaseV01(value: unknown): asserts value is LensCaseV01 {
  const c = validateCommon(value, false);
  assertLensDigest(c.revisionDigest, "revisionDigest");
  const digest = c.revisionDigest as LensDigestV01;
  if (digest.canonicalization !== LENS_CANONICALIZATION_PROFILE || digest.schemaVersion !== LENS_CASE_SCHEMA_VERSION) {
    throw new TypeError("@nec/lens: unsupported revision digest profile");
  }
  const { revisionDigest: _omitted, ...body } = c;
  const expected = hubRevisionDigestV01(body);
  if (digest.value !== expected.value || digest.byteLength !== expected.byteLength || digest.digestOf !== expected.digestOf) {
    throw new TypeError("@nec/lens: revision digest mismatch");
  }
  canonicalHubJsonV01(c);
}

export function validateLensBrowserSafeCaseV01(value: unknown): asserts value is LensBrowserSafeCaseV01 {
  const c = validateCommon(value, true);
  if (c.revisionDigest !== null || c.revisionDigestVisibility !== "withheld_by_browser_policy") {
    throw new TypeError("@nec/lens: browser revision digest must be withheld");
  }
  if (c.projectionPolicy === LENS_BROWSER_PROJECTION_VERSION) validateGenericBrowserAllowlist(c);
  canonicalHubJsonV01(c);
}

export function buildLensCaseFromHubV01(input: BuildLensCaseFromHubInputV01): LensCaseV01 {
  const i = record(input, "input");
  const caseId = string(i.caseId, "input.caseId");
  const namespace = string(i.namespace, "input.namespace");
  assertIso(i.createdAt, "input.createdAt");
  const createdAt = i.createdAt as string;
  const extraLimitations = i.limitations === undefined ? [] : strings(i.limitations, "input.limitations");
  const result = validateHubRecord(i.hubRecord as HubNetworkEvidenceRecordV01);

  const artifacts: LensArtifactRefV01[] = [
    {
      artifactId: "network-evidence-result",
      artifactType: "network_evidence",
      sourceSchema: "network-evidence-result/v0.1",
      mediaType: "application/json",
      artifactDigest: digestToLens(result.artifactDigest, "core_network_evidence_result_artifact"),
      locatorClass: "embedded_validated_result",
      locatorRef: null,
      availability: "available",
      limitations: [],
    },
    ...result.evidence.map(evidenceArtifact),
  ];

  const propositions: LensPropositionV01[] = [
    dimensionProposition(result, "execution", "execution", result.networkEvidence.execution),
    dimensionProposition(result, "dataBinding", "data-binding", result.networkEvidence.dataBinding),
    dimensionProposition(result, "settlement", "settlement", result.networkEvidence.settlement),
    dimensionProposition(result, "finality", "finality", result.networkEvidence.finality),
    ...result.networkEvidence.observedEffects.map((effect) => ({
      propositionId: `network.observed_effect:${effect.id}`,
      domain: "network",
      kind: "network_evidence.observed_effect",
      statement: `Network Evidence reported observed effect ${JSON.stringify(effect.type)} for the exact action subject.`,
      subjectRefs: ["network-evidence-result"],
      assessments: [],
      availability: "available" as const,
      limitations: ["Observed effect is preserved from Core without an added Lens verdict or causal inference."],
    })),
  ];

  const body = {
    schemaVersion: LENS_CASE_SCHEMA_VERSION,
    caseId,
    namespace,
    createdAt,
    constructionTimeMeaning: "Lens case construction time only; not source-event time.",
    artifacts,
    sourceClaims: [],
    propositions,
    relations: [],
    openQuestions: [],
    limitations: [
      "Generic Lens projection only: Network Evidence semantics are preserved without a global case verdict.",
      "Execution or observed effects do not imply settlement, finality, service delivery, physical-world truth, or policy/economic consequence.",
      ...extraLimitations,
    ],
    coreResultPreservation: {
      sourceSemanticDigest: result.semanticDigest,
      sourceArtifactDigest: result.artifactDigest,
      subject: toLensSubject(result.subject),
      resolver: { ...result.resolver },
      observedEffects: result.networkEvidence.observedEffects.map((effect) => ({ ...effect, fields: { ...effect.fields } })),
      conflicts: result.conflicts.map((conflict) => ({ ...conflict, evidence: [...conflict.evidence] })),
      warnings: result.warnings.map((warning) => ({ ...warning, ...(warning.evidence ? { evidence: [...warning.evidence] } : {}) })),
    },
    TARGET_CORE_MUTATIONS,
  } as const;

  const revision = {
    ...body,
    revisionDigest: hubRevisionDigestV01(body),
  } satisfies LensCaseV01;
  validateLensCaseV01(revision);
  return deepFreeze(revision) as LensCaseV01;
}

export function projectLensBrowserSafeV01(value: LensCaseV01): LensBrowserSafeCaseV01 {
  validateLensCaseV01(value);
  const browser: LensBrowserSafeCaseV01 = {
    schemaVersion: value.schemaVersion,
    caseId: value.caseId,
    namespace: value.namespace,
    createdAt: value.createdAt,
    ...(value.constructionTimeMeaning === undefined ? {} : { constructionTimeMeaning: value.constructionTimeMeaning }),
    ...(value.fixture === undefined ? {} : { fixture: value.fixture }),
    ...(value.fixtureClass === undefined ? {} : { fixtureClass: value.fixtureClass }),
    ...(value.realityClass === undefined ? {} : { realityClass: value.realityClass }),
    ...(value.syntheticArtifactCount === undefined ? {} : { syntheticArtifactCount: value.syntheticArtifactCount }),
    artifacts: value.artifacts.map((artifact) => ({
      artifactId: artifact.artifactId,
      artifactType: artifact.artifactType,
      ...(artifact.sourceSchema === undefined ? {} : { sourceSchema: artifact.sourceSchema }),
      ...(artifact.mediaType === undefined ? {} : { mediaType: artifact.mediaType }),
      artifactDigest: null,
      artifactDigestVisibility: artifact.artifactDigest ? "withheld_by_browser_policy" : "not_available",
      ...(artifact.locatorClass === undefined ? {} : { locatorClass: artifact.locatorClass }),
      locatorRef: null,
      ...(artifact.sourceObservedAt === undefined ? {} : { sourceObservedAt: artifact.sourceObservedAt }),
      ...(artifact.capturedAt === undefined ? {} : { capturedAt: artifact.capturedAt }),
      ...(artifact.fixtureObservedAt === undefined ? {} : { fixtureObservedAt: artifact.fixtureObservedAt }),
      availability: artifact.availability,
      ...(artifact.redaction === undefined ? {} : {
        redaction: {
          state: artifact.redaction.state,
          derivedFromArtifactId: artifact.redaction.derivedFromArtifactId,
          ...(artifact.redaction.derivativeArtifactId === undefined ? {} : { derivativeArtifactId: artifact.redaction.derivativeArtifactId }),
          ...(artifact.redaction.transformation === undefined ? {} : { transformation: artifact.redaction.transformation }),
          ...(artifact.redaction.sourceArtifactRef === undefined ? {} : { sourceArtifactRef: artifact.redaction.sourceArtifactRef }),
        },
      }),
      ...(artifact.realityClass === undefined ? {} : { realityClass: artifact.realityClass }),
      ...(artifact.fixture === undefined ? {} : { fixture: artifact.fixture }),
      ...(artifact.fixtureClass === undefined ? {} : { fixtureClass: artifact.fixtureClass }),
      ...(artifact.limitations === undefined ? {} : { limitations: [...artifact.limitations] }),
    })),
    sourceClaims: value.sourceClaims.map((claim) => ({
      claimId: claim.claimId,
      artifactId: claim.artifactId,
      claimType: claim.claimType,
      vocabulary: claim.vocabulary,
      extractionBasis: claim.extractionBasis,
      ...(claim.basis === undefined ? {} : { basis: [...claim.basis] }),
      ...(claim.evidenceRefs === undefined ? {} : { evidenceRefs: [...claim.evidenceRefs] }),
      ...(claim.limitations === undefined ? {} : { limitations: [...claim.limitations] }),
    })),
    propositions: value.propositions.map((proposition) => ({
      propositionId: proposition.propositionId,
      domain: proposition.domain,
      statement: proposition.statement,
      ...(proposition.kind === undefined ? {} : { kind: proposition.kind }),
      subjectRefs: [...proposition.subjectRefs],
      ...(proposition.sourceClaimRefs === undefined ? {} : { sourceClaimRefs: [...proposition.sourceClaimRefs] }),
      assessments: proposition.assessments.map((assessment) => ({
        assessmentId: assessment.assessmentId,
        propositionId: assessment.propositionId,
        evaluator: {
          type: assessment.evaluator.type,
          ...(assessment.evaluator.version === undefined ? {} : { version: assessment.evaluator.version }),
          ...(assessment.evaluator.buildRef === undefined ? {} : { buildRef: assessment.evaluator.buildRef }),
          ...(assessment.evaluator.verificationMode === undefined ? {} : { verificationMode: assessment.evaluator.verificationMode }),
          ...(assessment.evaluator.provenanceClass === undefined ? {} : { provenanceClass: assessment.evaluator.provenanceClass }),
        },
        vocabulary: assessment.vocabulary,
        value: assessment.value,
        basis: [...assessment.basis],
        evidenceRefs: [...assessment.evidenceRefs],
        ...(assessment.evaluatedAt === undefined ? {} : { evaluatedAt: assessment.evaluatedAt }),
        limitations: [...assessment.limitations],
      })),
      ...(proposition.availability === undefined ? {} : { availability: proposition.availability }),
      limitations: [...proposition.limitations],
    })),
    relations: value.relations.map((relation) => ({
      relationId: relation.relationId,
      fromRef: relation.fromRef,
      toRef: relation.toRef,
      relationType: relation.relationType,
      basis: relation.basis,
      ...(relation.assertedBy === undefined ? {} : { assertedBy: relation.assertedBy }),
      ...(relation.evidenceRefs === undefined ? {} : { evidenceRefs: [...relation.evidenceRefs] }),
      limitations: [...relation.limitations],
    })),
    openQuestions: value.openQuestions.map((question) => ({
      questionId: question.questionId,
      domain: question.domain,
      ...(question.statement === undefined ? {} : { statement: question.statement }),
      status: question.status,
      relatedPropositionRefs: [...question.relatedPropositionRefs],
      reason: question.reason,
    })),
    limitations: [...value.limitations],
    ...(value.coreResultPreservation === undefined ? {} : {
      coreResultPreservation: {
        sourceSemanticDigest: value.coreResultPreservation.sourceSemanticDigest,
        sourceArtifactDigest: value.coreResultPreservation.sourceArtifactDigest,
        subject: copyLensSubject(value.coreResultPreservation.subject),
        resolver: {
          id: value.coreResultPreservation.resolver.id,
          version: value.coreResultPreservation.resolver.version,
          digest: value.coreResultPreservation.resolver.digest,
        },
        observedEffectIds: value.coreResultPreservation.observedEffects.map((effect) => effect.id),
        warningCodes: value.coreResultPreservation.warnings.map((warning) => warning.code),
        conflictIds: value.coreResultPreservation.conflicts.map((conflict) => conflict.id),
      },
    }),
    revisionDigest: null,
    revisionDigestVisibility: "withheld_by_browser_policy",
    TARGET_CORE_MUTATIONS,
    projectionPolicy: LENS_BROWSER_PROJECTION_VERSION,
  };
  validateLensBrowserSafeCaseV01(browser);
  return deepFreeze(browser) as LensBrowserSafeCaseV01;
}

export function serializeLensCaseV01(value: LensCaseV01): string {
  validateLensCaseV01(value);
  return canonicalHubJsonV01(value);
}

export function serializeLensBrowserSafeV01(value: LensBrowserSafeCaseV01): string {
  validateLensBrowserSafeCaseV01(value);
  return canonicalHubJsonV01(value);
}
