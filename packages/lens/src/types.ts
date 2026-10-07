import type {
  Conflict,
  EvidenceBasis,
  NetworkEvidenceResult,
  ObservedEffect,
  ResolverManifestRef,
  Warning,
} from "@nec/core";
import type { HubNetworkEvidenceRecordV01 } from "@nec/hub";

export const TARGET_CORE_MUTATIONS = 0 as const;
export const LENS_CASE_SCHEMA_VERSION = "lens-case/v0.1" as const;
export const LENS_BROWSER_PROJECTION_VERSION = "lens-browser/v0.1" as const;
export const LENS_CANONICALIZATION_PROFILE = "hub-json-sorted-keys/v0.1" as const;

export interface LensDigestV01 {
  algorithm: "sha256";
  value: string;
  digestOf: string;
  canonicalization?: string;
  schemaVersion?: string;
  byteLength?: number;
}

export type LensArtifactAvailabilityV01 = "available" | "unavailable" | "redacted" | "unknown";
export type LensPropositionAvailabilityV01 = LensArtifactAvailabilityV01 | "not_applicable";

export interface LensRedactionV01 {
  state: string;
  derivedFromArtifactId: string | null;
  derivativeArtifactId?: string | null;
  transformation?: string | null;
  sourceArtifactRef?: string | null;
}

export interface LensArtifactRefV01 {
  artifactId: string;
  artifactType: string;
  sourceSchema?: string | null;
  mediaType?: string;
  artifactDigest?: LensDigestV01 | null;
  locatorClass?: string;
  locatorRef?: string | null;
  sourceObservedAt?: string | null;
  capturedAt?: string | null;
  fixtureObservedAt?: string | null;
  availability: LensArtifactAvailabilityV01;
  redaction?: LensRedactionV01;
  realityClass?: string;
  fixture?: boolean;
  fixtureClass?: string;
  limitations?: readonly string[];
}

export interface LensSourceClaimV01 {
  claimId: string;
  artifactId: string;
  claimType: string;
  vocabulary: string;
  value?: unknown;
  extractionBasis: string;
  basis?: readonly EvidenceBasis[];
  evidenceRefs?: readonly string[];
  limitations?: readonly string[];
}

export interface LensEvaluatorV01 {
  type: string;
  version?: string | null;
  buildRef?: string | null;
  verificationMode?: string;
  provenanceClass?: string;
}

/**
 * Runtime validation applies the conditional Network Evidence rule:
 * evaluator.type === "network_evidence" requires vocabulary
 * network_evidence_verdict/v0.1, one of the four Core verdicts, and only Core
 * EvidenceBasis values. Other vocabularies are never coerced into it.
 */
export interface LensAssessmentV01 {
  assessmentId: string;
  propositionId: string;
  evaluator: LensEvaluatorV01;
  vocabulary: string;
  value: string;
  basis: readonly string[];
  evidenceRefs: readonly string[];
  inputRefs?: readonly unknown[];
  evaluatedAt?: string | null;
  limitations: readonly string[];
}

export interface LensPropositionV01 {
  propositionId: string;
  domain: string;
  statement: string;
  kind?: string;
  subjectRefs: readonly string[];
  sourceClaimRefs?: readonly string[];
  assessments: readonly LensAssessmentV01[];
  availability?: LensPropositionAvailabilityV01;
  limitations: readonly string[];
}

export interface LensRelationV01 {
  relationId: string;
  fromRef: string;
  toRef: string;
  relationType: string;
  basis: string;
  assertedBy?: string;
  evidenceRefs?: readonly string[];
  limitations: readonly string[];
}

export type LensOpenQuestionStatusV01 =
  | "unresolved"
  | "not_applicable"
  | "awaiting_evidence"
  | "conflicting_evidence";

export interface LensOpenQuestionV01 {
  questionId: string;
  domain: string;
  statement?: string;
  status: LensOpenQuestionStatusV01;
  relatedPropositionRefs: readonly string[];
  reason: string;
}

/** JSON/wire-safe subject projection. Core blockNumber bigint is decimal text here. */
export type LensSubjectRefV01 =
  | { type: "transaction"; networkId: string; txId: string }
  | { type: "block"; networkId: string; blockNumber?: string; blockId?: string }
  | { type: "batch"; networkId: string; batchId: string }
  | { type: "custom"; networkId: string; namespace: string; value: string };

/** Exact Core semantics retained internally by the NEW generic builder. */
export interface LensCoreResultPreservationV01 {
  sourceSemanticDigest: NetworkEvidenceResult["semanticDigest"];
  sourceArtifactDigest: NetworkEvidenceResult["artifactDigest"];
  subject: LensSubjectRefV01;
  resolver: ResolverManifestRef;
  observedEffects: readonly ObservedEffect[];
  conflicts: readonly Conflict[];
  warnings: readonly Warning[];
}

/**
 * Public lens-case/v0.1 contract. Known historical optional fields are kept
 * because the reviewed F1/F2/F3 projections must remain valid unchanged.
 * New generic code uses `coreResultPreservation` and `extensions`; it never
 * repurposes the historical F1 `networkEvidence` field.
 */
export interface LensCaseV01 {
  schemaVersion: typeof LENS_CASE_SCHEMA_VERSION;
  caseId: string;
  namespace: string;
  createdAt: string;
  constructionTimeMeaning?: string;
  fixture?: boolean;
  fixtureClass?: string;
  realityClass?: string;
  syntheticArtifactCount?: number;
  artifacts: readonly LensArtifactRefV01[];
  sourceClaims: readonly LensSourceClaimV01[];
  propositions: readonly LensPropositionV01[];
  relations: readonly LensRelationV01[];
  openQuestions: readonly LensOpenQuestionV01[];
  limitations: readonly string[];
  coreResultPreservation?: LensCoreResultPreservationV01;
  revisionDigest: LensDigestV01;
  TARGET_CORE_MUTATIONS: 0;
  extensions?: Readonly<Record<string, unknown>>;
  // Known legacy F0/F1/F2/F3 fields accepted unchanged by the runtime validator.
  networkEvidence?: unknown;
  frozenSourceIndex?: unknown;
  publicSourceIndex?: unknown;
  exactReviewedSemantics?: unknown;
  browserDigestPolicy?: unknown;
  rendering?: string;
  projectionPolicy?: string;
}

export interface LensBrowserArtifactRefV01 extends Omit<LensArtifactRefV01, "locatorRef"> {
  locatorRef: null;
  artifactDigestVisibility?: string;
}

/** Generic browser projection deliberately omits source-native `value`. */
export type LensBrowserSourceClaimV01 = Omit<LensSourceClaimV01, "value">;
/** Generic browser assessments deliberately omit potentially opaque/untrusted inputRefs. */
export type LensBrowserAssessmentV01 = Omit<LensAssessmentV01, "inputRefs">;
export interface LensBrowserPropositionV01 extends Omit<LensPropositionV01, "assessments"> {
  assessments: readonly LensBrowserAssessmentV01[];
}

export interface LensBrowserCoreResultPreservationV01 {
  sourceSemanticDigest: NetworkEvidenceResult["semanticDigest"];
  sourceArtifactDigest: NetworkEvidenceResult["artifactDigest"];
  subject: LensSubjectRefV01;
  resolver: ResolverManifestRef;
  observedEffectIds: readonly string[];
  warningCodes: readonly string[];
  conflictIds: readonly string[];
}

export interface LensBrowserSafeCaseV01
  extends Omit<
    LensCaseV01,
    "artifacts" | "sourceClaims" | "propositions" | "coreResultPreservation" | "revisionDigest" | "extensions"
  > {
  artifacts: readonly LensBrowserArtifactRefV01[];
  sourceClaims: readonly LensBrowserSourceClaimV01[];
  propositions: readonly LensBrowserPropositionV01[];
  coreResultPreservation?: LensBrowserCoreResultPreservationV01;
  revisionDigest: null;
  revisionDigestVisibility: "withheld_by_browser_policy";
  /** Generic output is lens-browser/v0.1; historical reviewed projections may carry another value or none. */
  projectionPolicy?: string;
}

export interface BuildLensCaseFromHubInputV01 {
  hubRecord: HubNetworkEvidenceRecordV01;
  caseId: string;
  namespace: string;
  createdAt: string;
  limitations?: readonly string[];
}

export type BuildLensCaseFromHubV01 = (input: BuildLensCaseFromHubInputV01) => LensCaseV01;
export type ValidateLensCaseV01 = (value: unknown) => asserts value is LensCaseV01;
export type ValidateLensBrowserSafeCaseV01 = (value: unknown) => asserts value is LensBrowserSafeCaseV01;
export type ProjectLensBrowserSafeV01 = (value: LensCaseV01) => LensBrowserSafeCaseV01;
export type SerializeLensCaseV01 = (value: LensCaseV01) => string;
export type SerializeLensBrowserSafeV01 = (value: LensBrowserSafeCaseV01) => string;
