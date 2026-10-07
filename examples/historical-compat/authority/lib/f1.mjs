import { hash } from 'node:crypto';
import { H1Error, H1_LIMITS, parseVerifiedJson } from './h1.mjs';

// Bounded, zero-network F1 -> Lens case adapter. F1 is the real_public_partial
// x402 #1062 fixture. This module supports ONLY the exact pinned F1 bytes; it is
// not generic x402 support, not a connector, and creates no Network Evidence
// authority. It never reads the filesystem or the network: callers supply bytes.

// Captured intrinsics and null-prototype output avoid ambient prototype authority.
const create = Object.create, freeze = Object.freeze, keys = Object.keys, define = Object.defineProperty;
const descriptor = Object.getOwnPropertyDescriptor, hasOwn = Object.hasOwn, ownKeys = Reflect.ownKeys;
const isArray = Array.isArray, setPrototype = Object.setPrototypeOf, getPrototype = Object.getPrototypeOf;
const stringify = JSON.stringify, jsonParse = JSON.parse, apply = Reflect.apply, sort = Array.prototype.sort;
const regexpExec = RegExp.prototype.exec, numberIsFinite = Number.isFinite, isSafeInteger = Number.isSafeInteger;
const IntrinsicDate = Date, dateParse = Date.parse, dateToISOString = Date.prototype.toISOString;
const byteLength = Buffer.byteLength, isBuffer = Buffer.isBuffer;
const IntrinsicUint8Array = Uint8Array, uint8Prototype = Uint8Array.prototype;
const typedArrayByteLength = descriptor(getPrototype(uint8Prototype), 'byteLength').get;
const IntrinsicTextDecoder = TextDecoder, textDecode = TextDecoder.prototype.decode;
const utf8 = new IntrinsicTextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const weakHas = WeakSet.prototype.has, weakAdd = WeakSet.prototype.add;
const records = new WeakSet(), cases = new WeakSet(), ownErrors = new WeakSet();

export const TARGET_CORE_MUTATIONS = 0;
export const F1_ADAPTER_VERSION = 'hub-f1-lens/v0.1';
export const F1_POLICY_VERSION = 'hub-f1-browser/v0.1';
export const F1_CASE_ID = 'f1-case-x402-1062-partial-v0.1';
const ISSUE = '01-public-issue-claim.json';
const REFERENCE = '02-frozen-network-evidence-reference.json';
const NE = '05-network-evidence-result.json';
export const F1_REQUIRED_ARTIFACTS = freeze([ISSUE, REFERENCE, NE]);
// Exact F1 authority bytes. Any other bytes fail closed before semantic use.
const PINNED = create(null);
PINNED[ISSUE] = '1fe2ccda2beeec6763a0bc8ee931a88d2df835555b6f013fa056dd20f254a590';
PINNED[REFERENCE] = 'cc965df544794ee3723a98a17bd65d8bc9b3c738b6b7f8fbb91d82586ad7b548';
PINNED[NE] = '724493778e217047a00b6ee18fc20177b3ab115f902ed773659336701be44e45';
freeze(PINNED);
export const F1_PINNED_SHA256 = PINNED;
// Fields a complete x402 `exact` claim would need and which the public issue does not state.
export const F1_X402_EXACT_CLAIM_FIELDS = freeze(['payTo', 'payer', 'assetContractAddress', 'amountAtomic', 'x402Version']);
const NOT_ASSERTED = freeze(['network_execution', 'observed_transfer', 'x402_exact_claim_correlation', 'finality', 'settlement', 'service_delivery', 'economic_policy']);
const SOURCE_COPIES = freeze(['readme', 'case', 'fixtureManifest', 'transferFixture', 'finalityFixture']);

const fail = (code, details) => {
  const error = new H1Error(code, 'F1 bounded exact-fixture adapter rejected input', details);
  apply(weakAdd, ownErrors, [error]);
  throw error;
};
// Public boundary: only errors raised by this module (or by H1 over owned bytes)
// propagate; anything thrown by caller-controlled traps is normalized.
const boundary = (fn, code) => {
  try { return fn(); } catch (error) {
    if (apply(weakHas, ownErrors, [error])) throw error;
    fail(code);
  }
};
const safeArray = () => setPrototype([], null);
const appendOwn = (array, value) => {
  const d = create(null);
  d.value = value; d.writable = true; d.enumerable = true; d.configurable = true;
  define(array, array.length, d);
};
const own = (object, key) => {
  let d;
  try { d = descriptor(object, key); } catch { fail('schema_validation_failed'); }
  if (!d || !hasOwn(d, 'value')) fail('schema_validation_failed');
  return d.value;
};
const optional = (object, key) => {
  let d;
  try { d = descriptor(object, key); } catch { fail('schema_validation_failed'); }
  if (!d) return undefined;
  if (!hasOwn(d, 'value')) fail('schema_validation_failed');
  return d.value;
};
const matches = (pattern, value) => typeof value === 'string' && apply(regexpExec, pattern, [value]) !== null;
const validIso = (value, withMillis) => {
  const pattern = withMillis ? /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/ : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
  if (!matches(pattern, value)) return false;
  const parsed = dateParse(value);
  if (!numberIsFinite(parsed)) return false;
  const normalized = apply(dateToISOString, new IntrinsicDate(parsed), []);
  return withMillis ? normalized === value : normalized.replace('.000Z', 'Z') === value;
};
function copy(value) {
  if (value === null || typeof value !== 'object') return value;
  const out = isArray(value) ? safeArray() : create(null);
  const names = keys(value);
  for (let i = 0; i < names.length; i++) {
    const copied = copy(own(value, names[i]));
    if (isArray(out)) appendOwn(out, copied); else out[names[i]] = copied;
  }
  return freeze(out);
}
// Only used on owned, bounded JSON records. Not a source canonicalization.
function canonical(value) {
  if (value === null || typeof value !== 'object') return stringify(value);
  if (isArray(value)) {
    let text = '[';
    for (let i = 0; i < value.length; i++) text += (i ? ',' : '') + canonical(value[i]);
    return text + ']';
  }
  const names = keys(value);
  apply(sort, names, []);
  let text = '{';
  for (let i = 0; i < names.length; i++) text += (i ? ',' : '') + stringify(names[i]) + ':' + canonical(value[names[i]]);
  return text + '}';
}
const objectValue = (value) => {
  if (value === null || typeof value !== 'object' || isArray(value)) fail('schema_validation_failed');
  return value;
};
const stringValue = (object, field, limit = 1024, pattern = null) => {
  const value = own(objectValue(object), field);
  if (typeof value !== 'string' || value.length === 0 || value.length > limit) fail('schema_validation_failed', { field });
  if (pattern && !matches(pattern, value)) fail('invalid_identifier', { field });
  return value;
};
const arrayValue = (object, field) => {
  const value = own(objectValue(object), field);
  if (!isArray(value)) fail('schema_validation_failed', { field });
  return value;
};
const contains = (array, target) => {
  for (let i = 0; i < array.length; i++) if (own(array, i) === target) return true;
  return false;
};
const ID = /^[A-Za-z0-9._:-]{1,128}$/, HEX64 = /^[0-9a-f]{64}$/, HEX40 = /^[0-9a-f]{40}$/;
const TX = /^0x[0-9a-f]{64}$/, REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const RELATIVE_PATH = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/, DECIMAL = /^(?:0|[1-9][0-9]{0,19})$/;
function rejectAuthorityKeys(value, path = '$') {
  if (value === null || typeof value !== 'object') return;
  const names = ownKeys(value);
  for (let i = 0; i < names.length; i++) {
    const key = names[i];
    if (typeof key !== 'string') fail('schema_validation_failed', { path });
    if (key === 'authorizationClaim' || key === 'caseVerdict' || key === 'confidence' || key === 'trustScore' || key === 'policyDecision') {
      fail('schema_validation_failed', { path: path + '.' + key });
    }
    rejectAuthorityKeys(own(value, key), path + '.' + key);
  }
}

function copyBytes(bytes) {
  let accepted = false;
  try { accepted = isBuffer(bytes) || (bytes !== null && typeof bytes === 'object' && getPrototype(bytes) === uint8Prototype); } catch { accepted = false; }
  if (!accepted) fail('schema_validation_failed');
  let length;
  try { length = apply(typedArrayByteLength, bytes, []); } catch { fail('schema_validation_failed'); }
  if (typeof length !== 'number' || length > H1_LIMITS.maxRawBytes) fail('artifact_too_large', { max: H1_LIMITS.maxRawBytes });
  const owned = new IntrinsicUint8Array(length);
  for (let i = 0; i < length; i++) owned[i] = bytes[i];
  return owned;
}

function validateIssue(value) {
  rejectAuthorityKeys(value);
  if (own(value, 'fixtureClass') !== 'real_public_partial') fail('schema_validation_failed', { field: 'fixtureClass' });
  if (own(value, 'realityClass') !== 'hub_documentary_transcription') fail('schema_validation_failed', { field: 'realityClass' });
  if (own(value, 'sourceSchema') !== 'hub.documentary-transcription/public-issue-constants/v0.1') fail('unsupported_schema_version');
  if (own(value, 'sourceConformanceClaim') !== 'none') fail('schema_validation_failed', { field: 'sourceConformanceClaim' });
  stringValue(value, 'fixtureArtifactId', 128, ID);
  const transcription = objectValue(own(value, 'documentaryTranscription'));
  if (own(transcription, 'notAnIndependentlyCapturedSourceResponse') !== true || own(transcription, 'notADirectGithubIssueResponse') !== true) {
    fail('schema_validation_failed', { field: 'documentaryTranscription' });
  }
  const reference = objectValue(own(objectValue(own(value, 'provenance')), 'frozenNetworkEvidenceReference'));
  stringValue(reference, 'repository', 256, REPO); stringValue(reference, 'commit', 40, HEX40);
  stringValue(reference, 'path', 256, RELATIVE_PATH); stringValue(reference, 'blob', 40, HEX40); stringValue(reference, 'sha256', 64, HEX64);
  const claim = objectValue(own(value, 'issueReportedClaim'));
  if (own(claim, 'factClass') !== 'ISSUE_REPORTED_FACT') fail('schema_validation_failed', { field: 'factClass' });
  if (own(claim, 'assertionScope') !== 'source_claim_only') fail('schema_validation_failed', { field: 'assertionScope' });
  stringValue(claim, 'vocabulary', 64, ID); stringValue(claim, 'repository', 256, REPO);
  const issueNumber = own(claim, 'issueNumber');
  if (!isSafeInteger(issueNumber) || issueNumber <= 0) fail('schema_validation_failed', { field: 'issueNumber' });
  stringValue(claim, 'title', 512); stringValue(claim, 'url', 512); stringValue(claim, 'reportedOutcome', 1024);
  stringValue(claim, 'reportedTransaction', 66, TX); stringValue(claim, 'reportedBlockNumber', 20, DECIMAL);
  const notAsserted = arrayValue(value, 'notAssertedByThisArtifact');
  for (let i = 0; i < NOT_ASSERTED.length; i++) if (!contains(notAsserted, NOT_ASSERTED[i])) fail('schema_validation_failed', { field: 'notAssertedByThisArtifact' });
}
function validateReference(value) {
  rejectAuthorityKeys(value);
  if (own(value, 'fixtureClass') !== 'real_public_partial') fail('schema_validation_failed', { field: 'fixtureClass' });
  if (own(value, 'realityClass') !== 'hub_documentary_provenance_index') fail('schema_validation_failed', { field: 'realityClass' });
  if (own(value, 'sourceConformanceClaim') !== 'none') fail('schema_validation_failed', { field: 'sourceConformanceClaim' });
  stringValue(value, 'fixtureArtifactId', 128, ID);
  const provenance = objectValue(own(value, 'provenance'));
  stringValue(provenance, 'sourceRepository', 256, REPO); stringValue(provenance, 'sourceCommit', 40, HEX40);
  stringValue(provenance, 'caseProfile', 128, ID);
  const copies = objectValue(own(provenance, 'exactFrozenSourceCopies'));
  for (let i = 0; i < SOURCE_COPIES.length; i++) {
    const entry = objectValue(own(copies, SOURCE_COPIES[i]));
    stringValue(entry, 'path', 256, RELATIVE_PATH); stringValue(entry, 'localCopy', 256, RELATIVE_PATH);
    stringValue(entry, 'blob', 40, HEX40); stringValue(entry, 'sha256', 64, HEX64);
  }
  const projection = objectValue(own(provenance, 'exactHubFrozenNetworkEvidenceProjection'));
  stringValue(projection, 'sourcePath', 256, RELATIVE_PATH); stringValue(projection, 'localCopy', 256, RELATIVE_PATH);
  stringValue(projection, 'sha256', 64, HEX64);
}
function validateNetworkEvidence(value) {
  // H1 already validated schema, subject, provenance, limitations and the three
  // dimensions. F1 additionally requires the exact observed-effect and
  // unavailable-dimension shape it projects.
  const evidence = objectValue(own(value, 'networkEvidence'));
  const effects = arrayValue(evidence, 'observedEffects');
  if (effects.length === 0) fail('schema_validation_failed', { field: 'observedEffects' });
  for (let i = 0; i < effects.length; i++) {
    const effect = objectValue(own(effects, i));
    if (hasOwn(effect, 'verdict') || hasOwn(effect, 'value') || hasOwn(effect, 'basis')) fail('schema_validation_failed', { field: 'observedEffects' });
    stringValue(effect, 'type', 64, ID); stringValue(effect, 'effectId', 128, ID);
    stringValue(effect, 'transactionHash', 66, TX); stringValue(effect, 'blockNumber', 20, DECIMAL);
  }
  if (hasOwn(evidence, 'settlement')) fail('schema_validation_failed', { field: 'settlement' });
  if (!contains(arrayValue(value, 'unavailableDimensions'), 'settlement')) fail('schema_validation_failed', { field: 'unavailableDimensions' });
}

function parseInternal(input) {
  const artifactName = optional(input, 'artifactName');
  if (typeof artifactName !== 'string' || !hasOwn(PINNED, artifactName)) fail('invalid_identifier');
  const owned = copyBytes(optional(input, 'bytes'));
  const actualSha256 = hash('sha256', owned, 'hex');
  const expectedSha256 = optional(input, 'expectedSha256');
  if (!matches(HEX64, expectedSha256)) fail('schema_validation_failed', { artifactName });
  if (actualSha256 !== expectedSha256) fail('artifact_digest_mismatch', { artifactName, expectedSha256, actualSha256 });
  if (actualSha256 !== PINNED[artifactName]) fail('artifact_digest_mismatch', { artifactName, expectedSha256: PINNED[artifactName], actualSha256 });
  let record;
  if (artifactName === NE) {
    // Owned, pin-verified bytes only: H1 errors here are genuine H1 outcomes.
    try { record = parseVerifiedJson({ bytes: owned, expectedSha256: actualSha256, artifactName }); }
    catch (error) {
      if (error instanceof H1Error) { apply(weakAdd, ownErrors, [error]); throw error; }
      fail('schema_validation_failed', { artifactName });
    }
    validateNetworkEvidence(record.value);
  } else {
    let text;
    try { text = apply(textDecode, utf8, [owned]); } catch { fail('artifact_invalid_utf8', { artifactName }); }
    let parsed;
    try { parsed = jsonParse(text); } catch { fail('artifact_parse_error', { artifactName }); }
    const value = copy(objectValue(parsed));
    if (artifactName === ISSUE) validateIssue(value); else validateReference(value);
    const digest = copy({ algorithm: 'sha256', digestOf: 'raw_bytes', value: actualSha256 });
    const normalized = copy({ artifactId: value.fixtureArtifactId, artifactName, realityClass: value.realityClass,
      kind: artifactName === ISSUE ? 'public_issue_claim_transcription' : 'frozen_source_provenance_index', digest });
    const out = create(null);
    out.artifactName = artifactName; out.digest = digest; out.value = value; out.normalized = normalized;
    record = freeze(out);
  }
  apply(weakAdd, records, [record]);
  return record;
}

function snapshot(input) {
  const out = create(null);
  for (let i = 0; i < F1_REQUIRED_ARTIFACTS.length; i++) {
    const name = F1_REQUIRED_ARTIFACTS[i];
    let d;
    try { d = descriptor(input, name); } catch { fail('schema_validation_failed'); }
    if (!d) fail('required_fixture_artifact_missing', { artifactName: name });
    const record = own(input, name);
    if (!apply(weakHas, records, [record]) || record.artifactName !== name) fail('correlation_insufficient', { artifactName: name });
    out[name] = record;
  }
  return out;
}
const RELATION_RULES = create(null);
RELATION_RULES.candidate_same_transaction = 'source_declared_binding';
RELATION_RULES.transcription_source_pinned_by = 'deterministic_binding';
RELATION_RULES.pins_exact_frozen_bytes = 'deterministic_binding';
freeze(RELATION_RULES);
const txLimit = 'Exact public transaction-identifier equality only; not full x402 claim correlation, authorization, execution proof, settlement, finality, or service delivery evidence.';
const pinLimit = 'Byte-identity pin of frozen source copies; not a re-verification or extension of Network Evidence conclusions.';
function correlate(group) {
  const issue = group[ISSUE].value, reference = group[REFERENCE].value, ne = group[NE];
  const claim = issue.issueReportedClaim, frozen = issue.provenance.frozenNetworkEvidenceReference;
  const copies = reference.provenance.exactFrozenSourceCopies, projection = reference.provenance.exactHubFrozenNetworkEvidenceProjection;
  const effect = ne.value.networkEvidence.observedEffects[0];
  const sameTransaction = claim.reportedTransaction === ne.value.subject.txId &&
    claim.reportedBlockNumber === effect.blockNumber && effect.transactionHash === ne.value.subject.txId;
  const transcriptionPinned = frozen.repository === reference.provenance.sourceRepository &&
    frozen.commit === reference.provenance.sourceCommit && frozen.path === copies.case.path &&
    frozen.blob === copies.case.blob && frozen.sha256 === copies.case.sha256;
  const projectionPinned = projection.sha256 === ne.digest.value &&
    reference.provenance.sourceRepository === ne.value.provenance.sourceRepository &&
    reference.provenance.sourceCommit === ne.value.provenance.sourceCommit &&
    copies.transferFixture.path === ne.value.provenance.sourceFixtures.transfer.path &&
    copies.transferFixture.sha256 === ne.value.provenance.sourceFixtures.transfer.sha256 &&
    copies.finalityFixture.path === ne.value.provenance.sourceFixtures.finality.path &&
    copies.finalityFixture.sha256 === ne.value.provenance.sourceFixtures.finality.sha256;
  if (!(sameTransaction && transcriptionPinned && projectionPinned)) {
    fail('correlation_insufficient', { sameTransaction, transcriptionPinned, projectionPinned });
  }
  const ids = [issue.fixtureArtifactId, reference.fixtureArtifactId, ne.value.fixtureArtifactId];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) if (ids[i] === ids[j]) fail('correlation_ambiguous');
  const relations = safeArray();
  const relation = (from, to, relationType, limitation) => {
    appendOwn(relations, { relationId: 'r-' + (relations.length + 1), fromRef: from, toRef: to, relationType,
      basis: RELATION_RULES[relationType], assertedBy: 'hub-f1-correlation/v0.1', evidenceRefs: [from, to], limitations: [limitation] });
  };
  relation(issue.fixtureArtifactId, ne.value.fixtureArtifactId, 'candidate_same_transaction', txLimit);
  relation(issue.fixtureArtifactId, reference.fixtureArtifactId, 'transcription_source_pinned_by', pinLimit);
  relation(reference.fixtureArtifactId, ne.value.fixtureArtifactId, 'pins_exact_frozen_bytes', pinLimit);
  return relations;
}
function extraction(record, path) {
  return { sourceArtifactId: record.value.fixtureArtifactId, sourceDigest: record.digest,
    adapterType: 'hub-f1-lens', adapterVersion: F1_ADAPTER_VERSION, sourcePath: path, transformation: 'exact_json_value' };
}
function networkInputBindings(ne) {
  const value = ne.value, subject = value.subject, provenance = value.provenance, sourceFixtures = provenance.sourceFixtures;
  const inputRefs = safeArray(), inputDigests = safeArray();
  appendOwn(inputRefs, { type: 'network_subject', networkId: subject.networkId, txId: subject.txId });
  const names = ['transfer', 'finality'];
  for (let i = 0; i < names.length; i++) {
    const fixture = objectValue(own(sourceFixtures, names[i]));
    const path = stringValue(fixture, 'path', 1024), sha256 = stringValue(fixture, 'sha256', 64, HEX64);
    appendOwn(inputRefs, { type: 'immutable_source_fixture', sourceRepository: provenance.sourceRepository, sourceCommit: provenance.sourceCommit, path });
    appendOwn(inputDigests, { algorithm: 'sha256', digestOf: 'source_fixture_bytes', sourceFixture: names[i], value: sha256, digestClass: 'public_network_reference' });
  }
  return { inputRefs, inputDigests, immutableSourceRef: { sourceRepository: provenance.sourceRepository,
    sourceCommit: provenance.sourceCommit, sourceFreezeTag: provenance.sourceFreezeTag } };
}
function importedAssessment(ne, dimension, binding) {
  const imported = ne.value.networkEvidence[dimension];
  return { assessmentId: 'a-' + dimension, propositionId: 'p-' + dimension,
    evaluator: { type: 'network_evidence', version: null, buildRef: null, immutableSourceRef: binding.immutableSourceRef,
      verificationMode: 'operator_imported_frozen_result', provenanceClass: 'operator_imported',
      localRecomputation: 'not_performed', replayCapability: 'unavailable' },
    verifierType: 'network_evidence', verifierVersion: null, verifierVersionAvailability: 'unavailable_in_frozen_artifact',
    verifierBuildRef: null, verifierImmutableSourceRef: binding.immutableSourceRef,
    verificationMode: 'operator_imported_frozen_result', inputRefs: binding.inputRefs, inputDigests: binding.inputDigests,
    resultDigest: ne.digest, resultVocabulary: 'network_evidence_verdict/v0.1', producedAt: null,
    producedAtAvailability: 'unavailable_in_frozen_artifact', provenance: ne.value.provenance,
    provenanceClass: 'operator_imported', localRecomputation: 'not_performed', replayCapability: 'unavailable',
    vocabulary: 'network_evidence_verdict/v0.1', value: imported.verdict, basis: imported.basis,
    evidenceRefs: imported.evidence, evaluatedAt: null,
    limitationCode: hasOwn(imported, 'limitationCode') ? imported.limitationCode : null,
    importedDimension: imported, extractionProvenance: extraction(ne, '$.networkEvidence.' + dimension),
    limitations: ne.value.limitations };
}
function assertUniquePropositionIds(propositions) {
  for (let i = 0; i < propositions.length; i++) {
    const id = propositions[i].propositionId;
    if (!matches(/^[A-Za-z0-9._:-]{1,160}$/, id)) fail('schema_validation_failed');
    for (let j = 0; j < i; j++) if (id === propositions[j].propositionId) fail('schema_validation_failed');
  }
}
const claimLimit = 'Public issue statement transcribed by the Hub; a source claim only, not network observation, execution proof, settlement, finality, service delivery, or policy evidence.';
const effectLimit = 'Exact observed on-chain effect preserved from the frozen projection; transfer parties are not attested x402 authorization terms; it carries no Network Evidence verdict and implies no settlement, service delivery, or economic consequence.';
const settlementLimit = 'The imported Network Evidence result declares settlement unavailable; unavailable is an availability state, not a verdict.';
function build(input, metadata) {
  const group = snapshot(input);
  const bound = correlate(group);
  const namespace = own(metadata, 'namespace'), createdAt = own(metadata, 'createdAt');
  if (!matches(/^[A-Za-z0-9._-]{1,64}$/, namespace)) fail('invalid_identifier');
  if (!validIso(createdAt, true)) fail('invalid_identifier');
  const issue = group[ISSUE], reference = group[REFERENCE], ne = group[NE];
  const issueId = issue.value.fixtureArtifactId, neId = ne.value.fixtureArtifactId;
  const artifacts = safeArray(), sourceClaims = safeArray(), propositions = safeArray(), openQuestions = safeArray();
  const artifactTypes = [issue.normalized.kind, reference.normalized.kind, ne.normalized.kind];
  const artifactRecords = [issue, reference, ne];
  for (let i = 0; i < artifactRecords.length; i++) {
    const record = artifactRecords[i], v = record.value;
    appendOwn(artifacts, { artifactId: v.fixtureArtifactId, artifactType: artifactTypes[i],
      sourceSchema: hasOwn(v, 'sourceSchema') ? v.sourceSchema : null, artifactDigest: record.digest,
      mediaType: 'application/json', fixture: true, fixtureClass: 'real_public_partial', realityClass: v.realityClass,
      sourceObservedAt: null, fixtureObservedAt: null, capturedAt: null,
      locatorClass: 'private_ref', locatorRef: null, availability: 'available',
      redaction: { state: 'none', derivedFromArtifactId: null, derivativeArtifactId: null, derivativeDigest: null,
        transformation: null, sourceArtifactRef: null, producedAt: null, producedAtAvailability: null } });
  }
  // Source claim: the issue-reported timeout stays a claim; there is no assessment.
  const claim = issue.value.issueReportedClaim;
  appendOwn(sourceClaims, { claimId: 'claim-' + issueId, artifactId: issueId, claimType: 'issue_reported_fact',
    factClass: claim.factClass, assertionScope: claim.assertionScope, vocabulary: claim.vocabulary,
    value: 'reported_timeout', reported: claim, extractionBasis: 'local_content_verification',
    provenance: extraction(issue, '$.issueReportedClaim'), limitations: [claimLimit] });
  appendOwn(propositions, { propositionId: 'source-p-' + issueId, domain: 'service_response/payment_context',
    statement: 'application_facilitator_timeout_reported', kind: 'source_claim',
    subjectRefs: [issueId], sourceClaimRefs: ['claim-' + issueId], assessments: [], limitations: [claimLimit] });
  // Imported Network Evidence dimensions: exact verdict, basis and limitations.
  const binding = networkInputBindings(ne);
  const dimensions = ['execution', 'dataBinding', 'finality'];
  const statements = ['base_transaction_execution', 'base_transaction_data_binding', 'historical_opstack_finality_under_pinned_ruleset'];
  const domains = ['network', 'network', 'network/finality'];
  for (let i = 0; i < dimensions.length; i++) {
    appendOwn(propositions, { propositionId: 'p-' + dimensions[i], domain: domains[i], statement: statements[i],
      kind: 'exact_frozen_network_evidence_projection', subjectRefs: [neId], sourceClaimRefs: [],
      assessments: [importedAssessment(ne, dimensions[i], binding)], limitations: ne.value.limitations });
  }
  // Observed effect: preserved exactly, never given an invented verdict.
  appendOwn(propositions, { propositionId: 'p-observed-transfer', domain: 'network', statement: 'exact_observed_erc20_transfer',
    kind: 'exact_observed_effect', subjectRefs: [neId], sourceClaimRefs: [], assessments: [],
    assessmentPolicy: 'observed_effect_carries_no_network_evidence_verdict',
    observedEffects: ne.value.networkEvidence.observedEffects,
    extractionProvenance: extraction(ne, '$.networkEvidence.observedEffects'), limitations: [effectLimit] });
  // Full exact x402 correlation: Hub deterministic field-presence check over the pinned artifacts.
  const missing = safeArray();
  for (let i = 0; i < F1_X402_EXACT_CLAIM_FIELDS.length; i++) {
    const field = F1_X402_EXACT_CLAIM_FIELDS[i];
    if (!hasOwn(claim, field)) appendOwn(missing, field);
  }
  if (missing.length !== F1_X402_EXACT_CLAIM_FIELDS.length) fail('schema_validation_failed', { field: 'issueReportedClaim' });
  const x402Reason = 'Public issue material lacks independently present exact fields required for a complete x402 claim correlation; observed transfer parties are not attested terms.';
  appendOwn(propositions, { propositionId: 'p-x402-correlation', domain: 'payment',
    statement: 'full_exact_x402_claim_to_transaction_correlation', kind: 'correlation_limit',
    subjectRefs: [issueId, neId], sourceClaimRefs: ['claim-' + issueId],
    assessments: [{ assessmentId: 'a-x402-correlation', propositionId: 'p-x402-correlation',
      evaluator: { type: 'hub_correlation', version: F1_ADAPTER_VERSION, buildRef: null, immutableSourceRef: null,
        verificationMode: 'local_deterministic_field_presence_check', provenanceClass: 'hub_local_derivation',
        localRecomputation: 'performed', replayCapability: 'deterministic_from_pinned_bytes' },
      verifierType: 'hub_correlation', verifierVersion: F1_ADAPTER_VERSION, verifierVersionAvailability: 'available',
      verifierBuildRef: null, verifierImmutableSourceRef: null, verificationMode: 'local_deterministic_field_presence_check',
      inputRefs: [{ type: 'artifact', artifactId: issueId }, { type: 'artifact', artifactId: neId }],
      inputDigests: [{ algorithm: 'sha256', digestOf: 'raw_bytes', artifactId: issueId, value: issue.digest.value, digestClass: 'hub_documentary_artifact' },
        { algorithm: 'sha256', digestOf: 'raw_bytes', artifactId: neId, value: ne.digest.value, digestClass: 'public_network_reference' }],
      resultDigest: null, resultVocabulary: 'network_evidence_verdict/v0.1', producedAt: null,
      producedAtAvailability: 'hub_construction_only', provenance: null, provenanceClass: 'hub_local_derivation',
      localRecomputation: 'performed', replayCapability: 'deterministic_from_pinned_bytes',
      vocabulary: 'network_evidence_verdict/v0.1', value: 'insufficient', basis: ['deterministic_derivation'],
      evidenceRefs: [issueId, neId], evaluatedAt: null, networkEvidenceAuthority: 'none',
      missingRequiredPublicFields: missing, limitations: [x402Reason] }],
    limitations: [x402Reason] });
  // Settlement: unavailable in the imported result. Not a verdict.
  appendOwn(propositions, { propositionId: 'p-settlement', domain: 'settlement', statement: 'settlement',
    kind: 'exact_frozen_network_evidence_projection', subjectRefs: [neId], sourceClaimRefs: [], assessments: [],
    availability: 'unavailable', unavailableDimensionRef: 'settlement', limitations: [settlementLimit] });
  const deliveryReason = 'No independent service delivery evidence; an observed transfer does not establish delivery.';
  appendOwn(propositions, { propositionId: 'p-service-delivery', domain: 'service_response', statement: 'external_service_delivered',
    kind: 'unresolved', subjectRefs: [], sourceClaimRefs: [], assessments: [], limitations: [deliveryReason] });
  assertUniquePropositionIds(propositions);
  const finality = ne.value.networkEvidence.finality;
  const finalityCode = hasOwn(finality, 'limitationCode') && matches(/^[A-Z0-9_]{1,64}$/, finality.limitationCode) ? finality.limitationCode : 'none_recorded';
  const questions = [
    ['x402-correlation', 'payment', 'Is the full exact x402 claim correlated to the transaction?', x402Reason, 'p-x402-correlation'],
    ['finality', 'network/finality', 'Is historical OP Stack finality established under the pinned ruleset?',
      'Imported finality verdict is ' + finality.verdict + '; limitation code ' + finalityCode + '.', 'p-finality'],
    ['settlement', 'settlement', 'Was settlement established?', settlementLimit, 'p-settlement'],
    ['service-delivery', 'service_response', 'Was the external service delivered?', deliveryReason, 'p-service-delivery']
  ];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const question = { questionId: 'q-' + q[0], domain: q[1], statement: q[2], status: 'unresolved', relatedPropositionRefs: [q[4]], reason: q[3] };
    if (q[0] === 'x402-correlation') question.missingRequiredPublicFields = missing;
    appendOwn(openQuestions, question);
  }
  const caseLimitations = safeArray();
  appendOwn(caseLimitations, 'Exact-fixture support only: the adapter accepts the pinned F1 bytes and makes no generic x402 claim.');
  appendOwn(caseLimitations, claimLimit);
  for (let i = 0; i < ne.value.limitations.length; i++) appendOwn(caseLimitations, ne.value.limitations[i]);
  appendOwn(caseLimitations, 'Application timeout and later network execution are separate facts; neither is reconciled into a global success or failure verdict.');
  appendOwn(caseLimitations, 'No authorization, refund, retry, compensation, withdrawal-finalization, or economic-policy consequence is inferred.');
  appendOwn(caseLimitations, 'No Trail route is supplied by F1; drill-down retains the exact imported subject and immutable source references.');
  const body = copy({ schemaVersion: 'lens-case/v0.1', caseId: F1_CASE_ID, namespace, createdAt,
    constructionTimeMeaning: 'Lens construction only; not source event time.',
    fixture: true, fixtureClass: 'real_public_partial', realityClass: 'real_public_partial',
    syntheticArtifactCount: 0, artifacts, sourceClaims, propositions, relations: bound, openQuestions,
    networkEvidence: { artifactRef: neId, subject: ne.value.subject, provenance: ne.value.provenance,
      importProvenanceClass: 'operator_imported', preservedResult: ne.value.networkEvidence,
      unavailableDimensions: ne.value.unavailableDimensions,
      extractionProvenance: ne.normalized.preservedNetworkEvidence.provenance, limitations: ne.value.limitations },
    frozenSourceIndex: { artifactRef: reference.value.fixtureArtifactId, sourceRepository: reference.value.provenance.sourceRepository,
      sourceCommit: reference.value.provenance.sourceCommit, caseProfile: reference.value.provenance.caseProfile,
      exactFrozenSourceCopies: reference.value.provenance.exactFrozenSourceCopies,
      exactHubFrozenNetworkEvidenceProjection: reference.value.provenance.exactHubFrozenNetworkEvidenceProjection },
    limitations: caseLimitations, TARGET_CORE_MUTATIONS });
  const serialized = canonical(body);
  const revision = copy({ ...body, revisionDigest: { algorithm: 'sha256', value: hash('sha256', serialized, 'hex'),
    digestOf: 'hub_owned_case_revision', schemaVersion: 'lens-case/v0.1', canonicalization: 'hub-json-sorted-keys/v0.1',
    byteLength: byteLength(serialized, 'utf8') } });
  apply(weakAdd, cases, [revision]);
  return revision;
}

function projectInternal(revision, policyVersion) {
  if (policyVersion !== F1_POLICY_VERSION || !apply(weakHas, cases, [revision])) fail('privacy_projection_violation');
  // Browser policy mirrors H2: raw artifact digests are withheld except the public
  // network reference; the revision digest is withheld; free source text and the
  // issue URL never enter this record. Only pattern-bound identifiers are exposed.
  const out = create(null);
  const fields = ['schemaVersion', 'caseId', 'namespace', 'createdAt', 'constructionTimeMeaning', 'fixture', 'fixtureClass',
    'realityClass', 'syntheticArtifactCount', 'relations', 'openQuestions', 'limitations', 'TARGET_CORE_MUTATIONS'];
  for (let i = 0; i < fields.length; i++) out[fields[i]] = revision[fields[i]];
  const artifacts = safeArray();
  for (let i = 0; i < revision.artifacts.length; i++) {
    const artifact = revision.artifacts[i], redaction = artifact.redaction;
    const browserArtifact = { artifactId: artifact.artifactId, artifactType: artifact.artifactType, sourceSchema: artifact.sourceSchema,
      mediaType: artifact.mediaType, fixture: artifact.fixture, fixtureClass: artifact.fixtureClass, realityClass: artifact.realityClass,
      sourceObservedAt: artifact.sourceObservedAt, fixtureObservedAt: artifact.fixtureObservedAt, capturedAt: artifact.capturedAt,
      locatorClass: artifact.locatorClass, locatorRef: null, availability: artifact.availability,
      redaction: { state: redaction.state, derivedFromArtifactId: redaction.derivedFromArtifactId, derivativeArtifactId: redaction.derivativeArtifactId,
        transformation: redaction.transformation, sourceArtifactRef: redaction.sourceArtifactRef, producedAt: redaction.producedAt,
        producedAtAvailability: redaction.producedAtAvailability, derivativeDigest: null,
        derivativeDigestVisibility: redaction.derivativeDigest === null ? 'not_applicable' : 'withheld_by_browser_policy' },
      artifactDigest: null, artifactDigestVisibility: 'withheld_by_browser_policy' };
    if (artifact.artifactType === 'network_evidence' && artifact.realityClass === 'real_frozen_evidence_projection') {
      browserArtifact.artifactDigest = artifact.artifactDigest;
      browserArtifact.artifactDigestVisibility = 'public_network_reference';
    }
    appendOwn(artifacts, browserArtifact);
  }
  out.artifacts = artifacts;
  const claims = safeArray();
  for (let i = 0; i < revision.sourceClaims.length; i++) {
    const c = revision.sourceClaims[i], reported = c.reported;
    appendOwn(claims, { claimId: c.claimId, artifactId: c.artifactId, claimType: c.claimType, factClass: c.factClass,
      assertionScope: c.assertionScope, vocabulary: c.vocabulary, extractionBasis: c.extractionBasis,
      provenance: { sourceArtifactId: c.provenance.sourceArtifactId, adapterType: c.provenance.adapterType,
        adapterVersion: c.provenance.adapterVersion, sourcePath: c.provenance.sourcePath,
        transformation: c.provenance.transformation, sourceDigest: null, sourceDigestVisibility: 'withheld_by_browser_policy' },
      value: c.value === 'reported_timeout' ? c.value : null, valueVisibility: c.value === 'reported_timeout' ? 'visible' : 'withheld',
      reportedIdentifiers: { repository: matches(REPO, reported.repository) ? reported.repository : null,
        issueNumber: isSafeInteger(reported.issueNumber) ? reported.issueNumber : null,
        reportedTransaction: matches(TX, reported.reportedTransaction) ? reported.reportedTransaction : null,
        reportedBlockNumber: matches(DECIMAL, reported.reportedBlockNumber) ? reported.reportedBlockNumber : null },
      withheldReportedFields: ['title', 'url', 'reportedOutcome', 'reportedAmountHuman', 'reportedFacilitator'],
      limitations: c.limitations });
  }
  out.sourceClaims = claims;
  const propositions = safeArray();
  for (let i = 0; i < revision.propositions.length; i++) {
    const proposition = revision.propositions[i], assessments = safeArray();
    for (let j = 0; j < proposition.assessments.length; j++) {
      const a = proposition.assessments[j], inputDigests = safeArray();
      let withheld = 0;
      for (let k = 0; k < a.inputDigests.length; k++) {
        const d = a.inputDigests[k];
        if (d.digestClass === 'public_network_reference') appendOwn(inputDigests, d); else withheld += 1;
      }
      const browserAssessment = { assessmentId: a.assessmentId, propositionId: a.propositionId, evaluator: a.evaluator,
        verifierType: a.verifierType, verifierVersion: a.verifierVersion, verifierVersionAvailability: a.verifierVersionAvailability,
        verifierBuildRef: a.verifierBuildRef, verifierImmutableSourceRef: a.verifierImmutableSourceRef, verificationMode: a.verificationMode,
        inputRefs: a.inputRefs, inputDigests, withheldInputDigestCount: withheld, resultDigest: a.resultDigest,
        resultVocabulary: a.resultVocabulary, producedAt: a.producedAt, producedAtAvailability: a.producedAtAvailability,
        provenance: a.provenance, provenanceClass: a.provenanceClass, localRecomputation: a.localRecomputation,
        replayCapability: a.replayCapability, vocabulary: a.vocabulary, value: a.value, basis: a.basis,
        evidenceRefs: a.evidenceRefs, evaluatedAt: a.evaluatedAt, limitations: a.limitations };
      if (hasOwn(a, 'limitationCode')) browserAssessment.limitationCode = a.limitationCode;
      if (hasOwn(a, 'importedDimension')) browserAssessment.importedDimension = a.importedDimension;
      if (hasOwn(a, 'networkEvidenceAuthority')) browserAssessment.networkEvidenceAuthority = a.networkEvidenceAuthority;
      if (hasOwn(a, 'missingRequiredPublicFields')) browserAssessment.missingRequiredPublicFields = a.missingRequiredPublicFields;
      appendOwn(assessments, browserAssessment);
    }
    const browserProposition = { propositionId: proposition.propositionId, domain: proposition.domain, statement: proposition.statement,
      kind: proposition.kind, subjectRefs: proposition.subjectRefs, sourceClaimRefs: proposition.sourceClaimRefs,
      assessments, limitations: proposition.limitations };
    if (hasOwn(proposition, 'assessmentPolicy')) browserProposition.assessmentPolicy = proposition.assessmentPolicy;
    if (hasOwn(proposition, 'observedEffects')) browserProposition.observedEffects = proposition.observedEffects;
    if (hasOwn(proposition, 'availability')) browserProposition.availability = proposition.availability;
    if (hasOwn(proposition, 'unavailableDimensionRef')) browserProposition.unavailableDimensionRef = proposition.unavailableDimensionRef;
    appendOwn(propositions, browserProposition);
  }
  out.propositions = propositions;
  out.networkEvidence = { artifactRef: revision.networkEvidence.artifactRef, subject: revision.networkEvidence.subject,
    provenance: revision.networkEvidence.provenance, importProvenanceClass: revision.networkEvidence.importProvenanceClass,
    preservedResult: revision.networkEvidence.preservedResult, unavailableDimensions: revision.networkEvidence.unavailableDimensions,
    limitations: revision.networkEvidence.limitations };
  out.frozenSourceIndex = revision.frozenSourceIndex;
  out.projectionPolicy = F1_POLICY_VERSION;
  out.revisionDigest = null;
  out.revisionDigestVisibility = 'withheld_by_browser_policy';
  out.browserDigestPolicy = { rawArtifactDigests: 'withhold_hub_documentary_by_default',
    hubOwnedRevisionDigest: 'withheld_when_revision_commits_low_entropy_source_content',
    allowedDigestClasses: ['public_network_reference'] };
  out.rendering = 'JSON data only. Render strings with textContent; never interpret as HTML, Markdown, or executable URLs.';
  return copy(out);
}

export function parseF1Artifact(input) {
  return boundary(() => parseInternal(input), 'schema_validation_failed');
}
export function buildF1Case(recordsByName, metadata) {
  return boundary(() => build(recordsByName, metadata), 'schema_validation_failed');
}
export function projectF1BrowserSafe(revision, policyVersion = F1_POLICY_VERSION) {
  return boundary(() => projectInternal(revision, policyVersion), 'privacy_projection_violation');
}
export function serializeF1CaseRevision(revision) {
  if (!apply(weakHas, cases, [revision])) fail('schema_validation_failed');
  return canonical(revision);
}
