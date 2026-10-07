import { hash } from "node:crypto";
import { H1Error } from "./h1.mjs";

export const TARGET_CORE_MUTATIONS = 0;
export const F2_ADAPTER_VERSION = "hub-f2-erc4337-lens/v0.1";
export const F2_POLICY_VERSION = "hub-f2-browser/v0.1";
export const F2_CASE_ID = "f2-case-erc4337-base-sepolia-v06";
export const F2_REFERENCE = "01-frozen-network-evidence-reference.json";
export const F2_REFERENCE_SHA256 = "33cb0a2e85e0380a898364e7c4d02e072f7d13fe0e5818643b98d40bf9f2a39d";
export const F2_SUPPORTED_LABEL = "OBSERVED_ENTRYPOINT_EVIDENCE_SUPPORTS_SUCCESSFUL_SELECTED_USEROPERATION_IN_EXACT_BUNDLE";

const EXPECTED = Object.freeze({
  network: "eip155:84532",
  bundleTransactionHash: "0xde8916c81ef6a7b36ddf9f7b44d1ca096e4db4818eddfd5e16eda8a7c292ed45",
  userOpHash: "0x5f1e12031272034de5460796bd5cabe903a8ee6845fcab5fde18c4de632acfcf",
  sender: "0xfef5b40ab4c543137262253dbaf7843bd9b3e5b6",
  entryPoint: "0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789",
  paymaster: "0x8817340e0a3435e06254f2ed411e6418cd070d6f",
  blockNumber: "12168926",
  blockHash: "0x18cb57a710d328ea6304fc3be9ec47a34fbc54480cc42af59195d5a8e4763cbc",
  actualGasCost: "10026199539816",
  actualGasUsed: "186726"
});

const references = new WeakSet();
const cases = new WeakSet();
function fail(code, details) { throw new H1Error(code, "F2 bounded exact-fixture adapter rejected input", details); }
function plainObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function deepFreezeNull(value) {
  if (value === null || typeof value !== "object") return value;
  const out = Array.isArray(value) ? [] : Object.create(null);
  for (const key of Object.keys(value)) out[key] = deepFreezeNull(value[key]);
  if (Array.isArray(out)) Object.setPrototypeOf(out, null);
  return Object.freeze(out);
}
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) { let out = "["; for (let i = 0; i < value.length; i++) out += (i ? "," : "") + canonical(value[i]); return out + "]"; }
  return "{" + Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
}
function validateReference(value) {
  if (!plainObject(value)) fail("schema_validation_failed");
  if (value.schemaVersion !== "hub.frozen-network-evidence-reference/v0.1") fail("unsupported_schema_version");
  if (value.fixtureClass !== "real_public_partial") fail("schema_validation_failed");
  if (value.repository !== "ZzNible/network-evidence-core") fail("schema_validation_failed");
  if (value.branchCheckpoint !== "9781af576c60800346580e8413f23bc0bf7bafb8") fail("schema_validation_failed");
  if (value.technicalReviewCheckpoint !== "0c45bcab8a51beba05b7be979b10ff659669978a") fail("schema_validation_failed");
  if (value.path !== "packages/adapter-erc4337/test/fixtures/base-sepolia-external-v06-userop.json") fail("schema_validation_failed");
  if (value.sha256 !== "37f7da5719220a16a2841a08360eff4738aab9bbc4873dcbf79307847f4131a3") fail("schema_validation_failed");
  if (value.sourceAdapter !== "@nec/adapter-erc4337" || value.network !== EXPECTED.network) fail("schema_validation_failed");
  if (!plainObject(value.subject) || value.subject.bundleTransactionHash !== EXPECTED.bundleTransactionHash ||
      value.subject.userOpHash !== EXPECTED.userOpHash || value.subject.sender !== EXPECTED.sender ||
      value.subject.entryPoint !== EXPECTED.entryPoint) fail("schema_validation_failed");
  if (!plainObject(value.provenance) || value.provenance.rawChainCaptureReacquiredIndependently !== true ||
      value.provenance.captureIndependenceGroup !== "base-sepolia-rpc-a" ||
      value.provenance.crossSourceIndependenceEstablished !== false ||
      value.provenance.rundlerProvenanceEstablished !== false ||
      value.provenance.bundlerIdentityEstablished !== false) fail("schema_validation_failed");
  if (!plainObject(value.authorityBoundaries) || value.authorityBoundaries.finalityEstablished !== false ||
      value.authorityBoundaries.causalAttributionEstablished !== false ||
      value.authorityBoundaries.settlementClaimed !== false ||
      value.authorityBoundaries.serviceCompletionClaimed !== false ||
      value.authorityBoundaries.targetCoreMutations !== 0) fail("schema_validation_failed");
}
export function parseF2Reference({ artifactName, bytes, expectedSha256 } = {}) {
  if (artifactName !== F2_REFERENCE || !(bytes instanceof Uint8Array)) fail("invalid_identifier");
  const actual = hash("sha256", bytes, "hex");
  if (expectedSha256 !== F2_REFERENCE_SHA256 || actual !== F2_REFERENCE_SHA256) fail("artifact_digest_mismatch", { expectedSha256: F2_REFERENCE_SHA256, actualSha256: actual });
  let parsed;
  try { parsed = JSON.parse(Buffer.from(bytes).toString("utf8")); } catch { fail("artifact_parse_error"); }
  validateReference(parsed);
  const record = deepFreezeNull({ artifactName, digest: { algorithm: "sha256", digestOf: "raw_bytes", value: actual }, value: parsed });
  references.add(record);
  return record;
}
function assessment(value, selector, reference) {
  return deepFreezeNull({
    assessmentId: "a-userop-execution", propositionId: "p-userop-execution",
    evaluator: { type: "network_evidence", version: null, buildRef: reference.value.technicalReviewCheckpoint,
      immutableSourceRef: { repository: reference.value.repository, commit: reference.value.branchCheckpoint, path: reference.value.path, sha256: reference.value.sha256 },
      verificationMode: "operator_imported_reviewed_exact_fixture_semantics", provenanceClass: "operator_imported",
      localRecomputation: "not_performed", replayCapability: "available_in_source_adapter" },
    vocabulary: "network_evidence_verdict/v0.1", value, basis: ["source_observation", "deterministic_derivation"],
    evidenceRefs: [reference.value.fixtureArtifactId],
    inputRefs: [{ networkId: EXPECTED.network, bundleTransactionHash: EXPECTED.bundleTransactionHash,
      userOpHash: selector.userOpHash ?? null, sender: selector.sender ?? null }],
    supportedLabel: value === "supported" ? F2_SUPPORTED_LABEL : null,
    limitations: ["Exact reviewed F2 fixture only; no generic ERC-4337 claim.", "No finality, bundler identity, causal attribution, settlement, or service-completion conclusion."]
  });
}
export function buildF2Case(reference, metadata = {}, selector = {}) {
  if (!references.has(reference) || !plainObject(reference.value) || reference.digest?.value !== F2_REFERENCE_SHA256) fail("schema_validation_failed");
  validateReference(reference.value);
  if (typeof metadata.namespace !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(metadata.namespace)) fail("invalid_identifier");
  if (typeof metadata.createdAt !== "string" || Number.isNaN(Date.parse(metadata.createdAt))) fail("invalid_identifier");
  if (!plainObject(selector)) fail("schema_validation_failed");
  const hasHash = typeof selector.userOpHash === "string", hasSender = typeof selector.sender === "string";
  let verdict;
  if (hasHash && selector.userOpHash !== EXPECTED.userOpHash) verdict = "insufficient";
  else if (hasHash && hasSender && selector.sender !== EXPECTED.sender) verdict = "contradicted";
  else if (!hasHash && hasSender && selector.sender === EXPECTED.sender) verdict = "supported";
  else if (!hasHash && hasSender && selector.sender === "0x9272f8c4b4f26a79701dd2272f7e0c82fb3cded2") verdict = "ambiguous";
  else if (hasHash && selector.userOpHash === EXPECTED.userOpHash && (!hasSender || selector.sender === EXPECTED.sender)) verdict = "supported";
  else verdict = "insufficient";
  const refId = reference.value.fixtureArtifactId;
  const body = {
    schemaVersion: "lens-case/v0.1", caseId: F2_CASE_ID, namespace: metadata.namespace, createdAt: metadata.createdAt,
    fixture: true, fixtureClass: "real_public_partial", realityClass: "real_public_partial",
    artifacts: [{ artifactId: refId, artifactType: "frozen_network_evidence_reference", mediaType: "application/json",
      artifactDigest: reference.digest, locatorClass: "private_ref", locatorRef: null, availability: "available" }],
    sourceClaims: [],
    propositions: [
      { propositionId: "p-userop-execution", domain: "network", statement: "selected_useroperation_execution_in_exact_bundle",
        kind: "exact_frozen_network_evidence_projection", subjectRefs: [refId], assessments: [assessment(verdict, selector, reference)],
        limitations: ["Operation result is bounded to the exact reviewed bundle and selector."] },
      { propositionId: "p-bundle-context", domain: "network", statement: "exact_bundle_execution_context", kind: "context",
        subjectRefs: [refId], assessments: [], context: { network: EXPECTED.network, transactionHash: EXPECTED.bundleTransactionHash,
          blockNumber: EXPECTED.blockNumber, blockHash: EXPECTED.blockHash, entryPoint: EXPECTED.entryPoint },
        limitations: ["Bundle context is distinct from selected UserOperation semantics."] },
      { propositionId: "p-finality", domain: "network/finality", statement: "finality", kind: "unresolved", subjectRefs: [refId],
        assessments: [], availability: "unavailable", limitations: ["Finality is not established by the F2 source."] },
      { propositionId: "p-bundler-provenance", domain: "network", statement: "bundler_software_or_operator_identity", kind: "unresolved",
        subjectRefs: [refId], assessments: [], availability: "unavailable",
        limitations: ["Bundle transaction sender is not bundler software/operator attribution."] }
    ],
    relations: [
      { relationId: "r-f2-pin", fromRef: refId, toRef: reference.value.path, relationType: "pins_exact_frozen_bytes",
        basis: "deterministic_binding", evidenceRefs: [refId], limitations: ["Byte identity pin only; not a fresh network observation."] },
      { relationId: "r-userop-bundle", fromRef: EXPECTED.userOpHash, toRef: EXPECTED.bundleTransactionHash,
        relationType: "selected_useroperation_belongs_to_exact_bundle", basis: "deterministic_derivation", evidenceRefs: [refId],
        limitations: ["Exact userOpHash + sender selection basis; no causal edge beyond source semantics."] }
    ],
    openQuestions: [
      { questionId: "q-finality", domain: "network/finality", status: "unresolved", reason: "F2 does not establish finality.", relatedPropositionRefs: ["p-finality"] },
      { questionId: "q-bundler", domain: "network", status: "unresolved", reason: "No Rundler, Alchemy, bundler software, or operator identity is established.", relatedPropositionRefs: ["p-bundler-provenance"] }
    ],
    exactReviewedSemantics: { selectedUserOperation: { userOpHash: EXPECTED.userOpHash, sender: EXPECTED.sender, paymaster: EXPECTED.paymaster,
      success: true, actualGasCost: EXPECTED.actualGasCost, actualGasUsed: EXPECTED.actualGasUsed, selectionBasis: "exact_userOpHash_plus_sender" },
      finalityEstablished: false, bundlerIdentityEstablished: false, crossSourceIndependenceEstablished: false },
    limitations: ["Exact-fixture support only; no generic ERC-4337 verifier is implemented in Hub/Lens.",
      "No Rundler/Alchemy attribution is derived from the bundle sender.",
      "No finality, causal attribution, settlement, service completion, policy, or economic consequence is inferred."],
    TARGET_CORE_MUTATIONS
  };
  const result = deepFreezeNull({ ...body, revisionDigest: { algorithm: "sha256", value: hash("sha256", canonical(body), "hex"),
    digestOf: "hub_owned_case_revision", canonicalization: "hub-json-sorted-keys/v0.1" } });
  cases.add(result);
  return result;
}
export function projectF2BrowserSafe(revision, policyVersion = F2_POLICY_VERSION) {
  if (policyVersion !== F2_POLICY_VERSION || !cases.has(revision)) fail("privacy_projection_violation");
  const projected = JSON.parse(JSON.stringify(revision));
  projected.revisionDigest = null; projected.revisionDigestVisibility = "withheld_by_browser_policy";
  projected.artifacts[0].locatorRef = null; projected.artifacts[0].artifactDigestVisibility = "public_network_reference";
  return deepFreezeNull(projected);
}
export function serializeF2CaseRevision(revision) {
  if (!cases.has(revision)) fail("schema_validation_failed");
  return canonical(revision);
}
