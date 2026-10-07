import { hash } from "node:crypto";
import { H1Error } from "./h1.mjs";

export const TARGET_CORE_MUTATIONS = 0;
export const F3_ADAPTER_VERSION = "hub-f3-solana-x402-lens/v0.1";
export const F3_POLICY_VERSION = "hub-f3-browser/v0.1";
export const F3_CASE_ID = "f3-case-solana-mainnet-x402-partial";
export const F3_REFERENCE = "01-frozen-network-evidence-reference.json";
export const F3_REFERENCE_SHA256 = "ddb7ea558b383e2d02634fe79aa0e241e8055815b5dcf0c852fe592d3d8eb047";
export const F3_PAYMENT_LABEL = "ONE_OBSERVED_TRANSFER_CHECKED_MATCHES_EXPECTED_X402_SVM_PAYMENT_OUTCOME";

const EXPECTED = Object.freeze({
  repository: "ZzNible/network-evidence",
  commit: "e536ca1c63465ebb2de46c855a01bac71e4dc768",
  path: "packages/resolver-solana/test/fixtures/solana-mainnet-x402-real.json",
  fixtureSha256: "62b5191f62b61e9514f4be785d480828c496c199ef88ca763db51caf667d720a",
  requirementContextPath: "packages/adapter-x402-svm/test/adapter.test.ts",
  requirementContextSha256: "5e95d96f0df32b47631a46f814e7c4b371bfd8bed52f4545486b6492a81a932c",
  publicDocumentationPath: "packages/adapter-x402-svm/README.md",
  publicDocumentationSha256: "add79be23de53b21ce8f80fa24a3e6e66c51c44554bc280688dc93d4ea2a4b1d",
  frozenCoreProjectionPath: "source/04-frozen-core-runtime.json",
  frozenCoreProjectionSha256: "ce2f4eb570df3f2ebb264127e5a570746cb677cb68165c76dbbcf5ef1e9d21ff",
  network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  signature: "4DYWUMExSrMNxYLjUuH9G8feN4fmYXm4ToCx7gGaAEjJRf2QNrE8LsvoFSGhXwQJrchhgrnGpUFwjxrci9PRLF71",
  slot: "418897974",
  asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  payTo: "CNkB2jCHvnjF6zzmK2QeL9qEWBcq2oSq5t1DBnD59yJj",
  amount: "5000",
  feePayer: "BENrLoUbndxoNMUS5JXApGMtNykLjFXXixMtpDwDR9SP",
  effectId: "solana-transfer-checked-ce276d84a060fd3e",
  tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  source: "DMJ2By4ZCnStePpyt82gYMNYbsur1iE1YmVG2GmEdU6x",
  destination: "3pkdujCUZ9GWXe8V3cG2wWygBMB57xCHt6nFmWw5zzdz",
  authority: "5Quv32NFLRPvZGtuGrT9AGasz6U8x29jF6kxLCeFznrz"
});

const references = new WeakSet();
const cases = new WeakSet();

function fail(code, details) {
  throw new H1Error(code, "F3 bounded Solana exact-fixture adapter rejected input", details);
}
function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function deepFreezeNull(value) {
  if (value === null || typeof value !== "object") return value;
  const out = Array.isArray(value) ? [] : Object.create(null);
  for (const key of Object.keys(value)) out[key] = deepFreezeNull(value[key]);
  if (Array.isArray(out)) Object.setPrototypeOf(out, null);
  return Object.freeze(out);
}
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    let out = "[";
    for (let i = 0; i < value.length; i++) out += (i ? "," : "") + canonical(value[i]);
    return out + "]";
  }
  const names = Object.keys(value).sort();
  let out = "{";
  for (let i = 0; i < names.length; i++) out += (i ? "," : "") + JSON.stringify(names[i]) + ":" + canonical(value[names[i]]);
  return out + "}";
}
function validateReference(value) {
  if (!plainObject(value)) fail("schema_validation_failed");
  if (value.schemaVersion !== "hub.frozen-network-evidence-reference/v0.1" ||
      value.fixtureClass !== "real_public_partial" ||
      value.fixtureArtifactId !== "f3-nec-solana-mainnet-x402-reference" ||
      value.repository !== EXPECTED.repository ||
      value.branchCheckpoint !== EXPECTED.commit ||
      value.path !== EXPECTED.path ||
      value.sha256 !== EXPECTED.fixtureSha256 ||
      value.sourceResolver !== "@nec/resolver-solana" ||
      value.sourceAdapter !== "@nec/adapter-x402-svm" ||
      value.network !== EXPECTED.network) fail("schema_validation_failed");
  const subject = value.subject;
  const requirementSource = value.requirementContextSource;
  const publicDocumentation = value.publicDocumentation;
  const requirement = value.reviewedRequirementContext;
  const transfer = value.observedTransfer;
  const historical = value.historicalCorrelation;
  const finality = value.finalityBoundary;
  const frozenCoreProjection = value.frozenCoreProjection;
  const boundaries = value.authorityBoundaries;
  if (!plainObject(subject) || subject.signature !== EXPECTED.signature || subject.slot !== EXPECTED.slot) fail("schema_validation_failed");
  if (!plainObject(requirementSource) || requirementSource.path !== EXPECTED.requirementContextPath ||
      requirementSource.sha256 !== EXPECTED.requirementContextSha256) fail("schema_validation_failed");
  if (!plainObject(publicDocumentation) || publicDocumentation.path !== EXPECTED.publicDocumentationPath ||
      publicDocumentation.sha256 !== EXPECTED.publicDocumentationSha256) fail("schema_validation_failed");
  if (!plainObject(requirement) ||
      requirement.contextClass !== "reviewed_fixture_requirement_not_historical_artifact" ||
      requirement.x402Version !== "2" || requirement.scheme !== "exact" ||
      requirement.asset !== EXPECTED.asset || requirement.payTo !== EXPECTED.payTo ||
      requirement.amount !== EXPECTED.amount || requirement.maxTimeoutSeconds !== 300 ||
      requirement.feePayer !== EXPECTED.feePayer) fail("schema_validation_failed");
  if (!plainObject(transfer) || transfer.effectId !== EXPECTED.effectId ||
      transfer.tokenProgram !== EXPECTED.tokenProgram || transfer.mint !== EXPECTED.asset ||
      transfer.source !== EXPECTED.source || transfer.destination !== EXPECTED.destination ||
      transfer.authority !== EXPECTED.authority || transfer.amount !== EXPECTED.amount ||
      transfer.decimals !== 6) fail("schema_validation_failed");
  if (!plainObject(historical) ||
      historical.reviewClass !== "operator_reviewed_public_documentation_limit" ||
      historical.adapterContextLabel !== "STRONG_BUT_ONE_FIELD_MISSING" ||
      JSON.stringify(historical.missingHistoricalPublicArtifacts) !== JSON.stringify(["PaymentRequirements", "PaymentPayload", "VerifyResponse", "SettlementResponse"]) ||
      historical.absenceStatementScope !== "public_documentation_states_not_public_not_nonexistence") fail("schema_validation_failed");
  if (!plainObject(finality) || finality.rpcCommitment !== "finalized" ||
      finality.networkEvidenceVerdict !== "supported" ||
      JSON.stringify(finality.basis) !== JSON.stringify(["source_observation"]) ||
      finality.economicIrreversibilityEstablished !== false) fail("schema_validation_failed");
  if (!plainObject(frozenCoreProjection) ||
      frozenCoreProjection.path !== EXPECTED.frozenCoreProjectionPath ||
      frozenCoreProjection.sha256 !== EXPECTED.frozenCoreProjectionSha256) fail("schema_validation_failed");
  if (!plainObject(boundaries) || boundaries.settlementClaimed !== false ||
      boundaries.facilitatorVerifyOutcomeEstablished !== false ||
      boundaries.facilitatorSettleOutcomeEstablished !== false ||
      boundaries.historicalExactX402CorrelationEstablished !== false ||
      boundaries.targetCoreMutations !== 0) fail("schema_validation_failed");
}

export function parseF3Reference({ artifactName, bytes, expectedSha256 } = {}) {
  if (artifactName !== F3_REFERENCE || !(bytes instanceof Uint8Array)) fail("invalid_identifier");
  const actual = hash("sha256", bytes, "hex");
  if (expectedSha256 !== F3_REFERENCE_SHA256 || actual !== F3_REFERENCE_SHA256) {
    fail("artifact_digest_mismatch", { expectedSha256: F3_REFERENCE_SHA256, actualSha256: actual });
  }
  let parsed;
  try { parsed = JSON.parse(Buffer.from(bytes).toString("utf8")); }
  catch { fail("artifact_parse_error"); }
  validateReference(parsed);
  const record = deepFreezeNull({
    artifactName,
    digest: { algorithm: "sha256", digestOf: "raw_bytes", value: actual },
    value: parsed
  });
  references.add(record);
  return record;
}

function networkAssessment({ id, propositionId, value, basis, reference, label = null, limitations = [] }) {
  return deepFreezeNull({
    assessmentId: id,
    propositionId,
    evaluator: {
      type: "network_evidence",
      version: null,
      buildRef: reference.value.branchCheckpoint,
      immutableSourceRef: {
        repository: reference.value.repository,
        commit: reference.value.branchCheckpoint,
        path: reference.value.path,
        sha256: reference.value.sha256
      },
      verificationMode: "operator_imported_reviewed_exact_fixture_semantics",
      provenanceClass: "operator_imported",
      localRecomputation: "not_performed",
      replayCapability: "available_in_source_resolver_adapter"
    },
    vocabulary: "network_evidence_verdict/v0.1",
    value,
    basis,
    evidenceRefs: [reference.value.fixtureArtifactId],
    supportedLabel: label,
    limitations
  });
}

export function buildF3Case(reference, metadata = {}) {
  if (!references.has(reference) || !plainObject(reference.value) || reference.digest?.value !== F3_REFERENCE_SHA256) {
    fail("schema_validation_failed");
  }
  validateReference(reference.value);
  if (typeof metadata.namespace !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(metadata.namespace)) fail("invalid_identifier");
  if (typeof metadata.createdAt !== "string" || Number.isNaN(Date.parse(metadata.createdAt))) fail("invalid_identifier");

  const refId = reference.value.fixtureArtifactId;
  const missingHistorical = ["PaymentRequirements", "PaymentPayload", "VerifyResponse", "SettlementResponse"];
  const correlationReason = "Pinned public x402-SVM documentation states that contemporaneous historical PaymentRequirements, PaymentPayload, VerifyResponse, and SettlementResponse are not public; this is an operator-reviewed public-documentation limit, not proof that such artifacts never existed.";
  const finalityLimit = "Solana RPC finalized is preserved as source-observed Network Evidence finality only; independent cryptographic verification and generic economic irreversibility are not established.";
  const settlementLimit = "The source adapter explicitly sets settlementInferred=false; network payment/finality do not establish facilitator settlement.";

  const body = {
    schemaVersion: "lens-case/v0.1",
    caseId: F3_CASE_ID,
    namespace: metadata.namespace,
    createdAt: metadata.createdAt,
    constructionTimeMeaning: "Lens construction only; not source event time.",
    fixture: true,
    fixtureClass: "real_public_partial",
    realityClass: "real_public_partial",
    artifacts: [{
      artifactId: refId,
      artifactType: "frozen_network_evidence_reference",
      mediaType: "application/json",
      artifactDigest: reference.digest,
      locatorClass: "private_ref",
      locatorRef: null,
      availability: "available"
    }],
    sourceClaims: [],
    propositions: [
      {
        propositionId: "p-network-execution",
        domain: "network",
        statement: "solana_transaction_execution",
        kind: "exact_frozen_network_evidence_projection",
        subjectRefs: [refId],
        assessments: [networkAssessment({
          id: "a-network-execution",
          propositionId: "p-network-execution",
          value: "supported",
          basis: ["source_observation"],
          reference,
          limitations: ["Exact reviewed Solana fixture only."]
        })],
        limitations: ["Execution support does not establish settlement or service delivery."]
      },
      {
        propositionId: "p-x402-svm-payment",
        domain: "payment",
        statement: "exact_observed_transfer_checked_matches_reviewed_x402_svm_requirement_context",
        kind: "exact_frozen_network_evidence_projection",
        subjectRefs: [refId],
        assessments: [networkAssessment({
          id: "a-x402-svm-payment",
          propositionId: "p-x402-svm-payment",
          value: "supported",
          basis: ["deterministic_derivation", "source_observation"],
          reference,
          label: F3_PAYMENT_LABEL,
          limitations: ["The requirement is reviewed fixture context, not recovered historical PaymentRequirements bytes."]
        })],
        limitations: ["Observed payment outcome is distinct from facilitator verify/settle outcome."]
      },
      {
        propositionId: "p-network-finality",
        domain: "network/finality",
        statement: "solana_finalized_rpc_observation",
        kind: "exact_frozen_network_evidence_projection",
        subjectRefs: [refId],
        assessments: [networkAssessment({
          id: "a-network-finality",
          propositionId: "p-network-finality",
          value: "supported",
          basis: ["source_observation"],
          reference,
          limitations: [finalityLimit]
        })],
        limitations: [finalityLimit]
      },
      {
        propositionId: "p-historical-x402-correlation",
        domain: "payment",
        statement: "historical_exact_x402_artifact_to_transaction_correlation",
        kind: "correlation_limit",
        subjectRefs: [refId],
        assessments: [{
          assessmentId: "a-historical-x402-correlation",
          propositionId: "p-historical-x402-correlation",
          evaluator: {
            type: "hub_correlation",
            version: F3_ADAPTER_VERSION,
            buildRef: null,
            immutableSourceRef: {
              repository: reference.value.repository,
              commit: reference.value.branchCheckpoint,
              path: reference.value.publicDocumentation.path,
              sha256: reference.value.publicDocumentation.sha256
            },
            verificationMode: "operator_reviewed_public_documentation_limit",
            provenanceClass: "operator_reviewed",
            localRecomputation: "not_performed",
            replayCapability: "pinned_public_documentation_reference"
          },
          verifierType: "hub_correlation",
          vocabulary: "network_evidence_verdict/v0.1",
          value: "insufficient",
          basis: ["source_observation"],
          evidenceRefs: [refId],
          networkEvidenceAuthority: "none",
          reviewClass: "operator_reviewed_public_documentation_limit",
          absenceStatementScope: "public_documentation_states_not_public_not_nonexistence",
          missingHistoricalPublicArtifacts: missingHistorical,
          limitations: [correlationReason]
        }],
        limitations: [correlationReason]
      },
      {
        propositionId: "p-settlement",
        domain: "settlement",
        statement: "x402_facilitator_settlement",
        kind: "unresolved",
        subjectRefs: [refId],
        assessments: [],
        availability: "unavailable",
        limitations: [settlementLimit]
      }
    ],
    relations: [{
      relationId: "r-transfer-in-transaction",
      fromRef: EXPECTED.effectId,
      toRef: EXPECTED.signature,
      relationType: "observed_transfer_in_exact_transaction",
      basis: "deterministic_derivation",
      evidenceRefs: [refId],
      limitations: ["This relation does not establish historical x402 request/settlement artifacts."]
    }],
    openQuestions: [
      {
        questionId: "q-historical-x402-correlation",
        domain: "payment",
        status: "unresolved",
        reason: correlationReason,
        relatedPropositionRefs: ["p-historical-x402-correlation"],
        missingHistoricalPublicArtifacts: missingHistorical
      },
      {
        questionId: "q-settlement",
        domain: "settlement",
        status: "unresolved",
        reason: settlementLimit,
        relatedPropositionRefs: ["p-settlement"]
      },
      {
        questionId: "q-economic-irreversibility",
        domain: "network/finality",
        status: "unresolved",
        reason: finalityLimit,
        relatedPropositionRefs: ["p-network-finality"]
      }
    ],
    exactReviewedSemantics: {
      transaction: {
        network: EXPECTED.network,
        signature: EXPECTED.signature,
        slot: EXPECTED.slot,
        executionVerdict: "supported"
      },
      payment: {
        verdict: "supported",
        supportedLabel: F3_PAYMENT_LABEL,
        basis: ["deterministic_derivation", "source_observation"],
        requirementContextClass: "reviewed_fixture_requirement_not_historical_artifact",
        asset: EXPECTED.asset,
        payTo: EXPECTED.payTo,
        amount: EXPECTED.amount,
        feePayer: EXPECTED.feePayer,
        effectId: EXPECTED.effectId,
        tokenProgram: EXPECTED.tokenProgram,
        source: EXPECTED.source,
        destination: EXPECTED.destination,
        authority: EXPECTED.authority,
        settlementInferred: false
      },
      networkFinality: {
        verdict: "supported",
        basis: ["source_observation"],
        rpcCommitment: "finalized",
        economicIrreversibilityEstablished: false
      },
      historicalCorrelation: {
        verdict: "insufficient",
        reviewClass: "operator_reviewed_public_documentation_limit",
        absenceStatementScope: "public_documentation_states_not_public_not_nonexistence",
        missingHistoricalPublicArtifacts: missingHistorical,
        adapterContextLabel: "STRONG_BUT_ONE_FIELD_MISSING",
        adapterContextLabelMeaning: "public adapter documentation label only; not a confidence value or verdict strength"
      }
    },
    publicSourceIndex: {
      networkFixture: { repository: reference.value.repository, commit: reference.value.branchCheckpoint, path: reference.value.path, sha256: reference.value.sha256 },
      requirementContext: { repository: reference.value.repository, commit: reference.value.branchCheckpoint, path: reference.value.requirementContextSource.path, sha256: reference.value.requirementContextSource.sha256 },
      documentation: { repository: reference.value.repository, commit: reference.value.branchCheckpoint, path: reference.value.publicDocumentation.path, sha256: reference.value.publicDocumentation.sha256 },
      frozenCoreProjection: { path: reference.value.frozenCoreProjection.path, sha256: reference.value.frozenCoreProjection.sha256 }
    },
    limitations: [
      "Exact-fixture support only; no generic Solana/x402 Hub ingestion is implemented.",
      "Reviewed requirement context is not a recovered historical x402 request artifact.",
      finalityLimit,
      settlementLimit,
      "No facilitator outcome, service delivery, confidence score, policy consequence, or global case verdict is inferred."
    ],
    TARGET_CORE_MUTATIONS
  };

  const result = deepFreezeNull({
    ...body,
    revisionDigest: {
      algorithm: "sha256",
      value: hash("sha256", canonical(body), "hex"),
      digestOf: "hub_owned_case_revision",
      canonicalization: "hub-json-sorted-keys/v0.1"
    }
  });
  cases.add(result);
  return result;
}

export function projectF3BrowserSafe(revision, policyVersion = F3_POLICY_VERSION) {
  if (policyVersion !== F3_POLICY_VERSION || !cases.has(revision)) fail("privacy_projection_violation");
  const projected = JSON.parse(JSON.stringify(revision));
  projected.revisionDigest = null;
  projected.revisionDigestVisibility = "withheld_by_browser_policy";
  projected.artifacts[0].locatorRef = null;
  projected.artifacts[0].artifactDigest = null;
  projected.artifacts[0].artifactDigestVisibility = "withheld_by_browser_policy";
  return deepFreezeNull(projected);
}

export function serializeF3CaseRevision(revision) {
  if (!cases.has(revision)) fail("schema_validation_failed");
  return canonical(revision);
}
