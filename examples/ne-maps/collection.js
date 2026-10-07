// NE Maps collection/case runtime validator (Maps-only, browser + Node ES module).
//
// Validates the versioned ne-maps-case-collection/v0.1 -> ne-maps-case/v0.1 envelope
// before anything is rendered. It fails closed on unsupported or unexpected structure.
// It never computes, ranks or strengthens evidence. Nested Lens semantics are owned by
// @nec/lens: Node callers additionally inject the public validateLensBrowserSafeCaseV01
// through `options.validateLens`; the always-on Maps check covers only the
// browser-withheld markers and the fields Maps reads.

export const NE_MAPS_CASE_SCHEMA_VERSION = "ne-maps-case/v0.1";
export const NE_MAPS_COLLECTION_SCHEMA_VERSION = "ne-maps-case-collection/v0.1";
export const NE_MAPS_LIMITS = Object.freeze({ maxCases: 64, maxStringLength: 8192, maxDepth: 64 });

const CASE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const COLLECTION_FIELDS = new Set(["schemaVersion", "TARGET_CORE_MUTATIONS", "sourceAuthority", "publicSuite", "nonClaims", "cases"]);
const SOURCE_AUTHORITY_FIELDS = new Set(["repository", "branch", "commit", "export"]);
const PUBLIC_SUITE_FIELDS = new Set(["repository", "commit"]);
const CASE_FIELDS = new Set(["schemaVersion", "id", "display", "exactAction", "trailPropositionOrder", "lens", "extensions"]);
const DISPLAY_FIELDS = new Set(["networkLabel", "title", "shape"]);
const SELECTOR_OUTCOME_FIELDS = new Set(["label", "verdict"]);
const SELECTOR_VERDICTS = new Set(["supported", "contradicted", "insufficient", "ambiguous"]);
// Same authority names @nec/lens forbids, plus ranking keys Maps must never carry.
const FORBIDDEN_KEYS = new Set(["caseVerdict", "confidence", "trustScore", "score", "policyDecision", "rank", "ranking", "__proto__"]);

export class NeMapsValidationError extends TypeError {
  constructor(path, message) {
    super(`ne-maps: ${path} ${message}`);
    this.name = "NeMapsValidationError";
    this.path = path;
  }
}

function fail(path, message) {
  throw new NeMapsValidationError(path, message);
}

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function record(value, path) {
  if (!isRecord(value)) fail(path, "must be a plain object");
  return value;
}

function onlyKeys(value, allowed, path) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(path, `has unsupported field ${key}`);
}

function text(value, path) {
  if (typeof value !== "string" || value.length === 0) fail(path, "must be a non-empty string");
  if (value.length > NE_MAPS_LIMITS.maxStringLength) fail(path, "exceeds the string bound");
  return value;
}

function list(value, path) {
  if (!Array.isArray(value)) fail(path, "must be an array");
  return value;
}

function texts(value, path) {
  return list(value, path).map((item, index) => text(item, `${path}[${index}]`));
}

function scanForbidden(value, path, depth) {
  if (depth > NE_MAPS_LIMITS.maxDepth) fail(path, "exceeds the nesting bound");
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForbidden(item, `${path}[${index}]`, depth + 1));
  } else if (value !== null && typeof value === "object") {
    if (!isRecord(value)) fail(path, "must be plain JSON data");
    for (const [key, nested] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key)) fail(`${path}.${key}`, "is a forbidden authority/ranking field");
      scanForbidden(nested, `${path}.${key}`, depth + 1);
    }
  } else if (!["string", "number", "boolean"].includes(typeof value) && value !== null) {
    fail(path, "must be plain JSON data");
  }
}

/**
 * Browser default: checks only what Maps relies on to render a browser-safe Lens
 * projection. Full lens-case/v0.1 semantics stay with @nec/lens (injected in Node).
 */
export function assertLensRenderableV01(lens, path = "lens") {
  const c = record(lens, path);
  if (c.schemaVersion !== "lens-case/v0.1") fail(`${path}.schemaVersion`, "must be lens-case/v0.1");
  if (c.TARGET_CORE_MUTATIONS !== 0) fail(`${path}.TARGET_CORE_MUTATIONS`, "must be 0");
  if (c.revisionDigest !== null || c.revisionDigestVisibility !== "withheld_by_browser_policy") {
    fail(`${path}.revisionDigest`, "must be withheld by browser policy");
  }
  text(c.caseId, `${path}.caseId`);
  texts(c.limitations, `${path}.limitations`);
  for (const [index, item] of list(c.artifacts, `${path}.artifacts`).entries()) {
    if (record(item, `${path}.artifacts[${index}]`).locatorRef !== null) fail(`${path}.artifacts[${index}].locatorRef`, "must be null in a browser projection");
  }
  const seen = new Set();
  for (const [index, item] of list(c.propositions, `${path}.propositions`).entries()) {
    const at = `${path}.propositions[${index}]`;
    const proposition = record(item, at);
    const id = text(proposition.propositionId, `${at}.propositionId`);
    if (seen.has(id)) fail(`${at}.propositionId`, `duplicates ${id}`);
    seen.add(id);
    for (const [aIndex, assessment] of list(proposition.assessments, `${at}.assessments`).entries()) {
      text(record(assessment, `${at}.assessments[${aIndex}]`).value, `${at}.assessments[${aIndex}].value`);
    }
  }
  for (const [index, item] of list(c.relations, `${path}.relations`).entries()) {
    const relation = record(item, `${path}.relations[${index}]`);
    text(relation.relationType, `${path}.relations[${index}].relationType`);
    text(relation.fromRef, `${path}.relations[${index}].fromRef`);
    text(relation.toRef, `${path}.relations[${index}].toRef`);
  }
}

function validateExtensions(value, path) {
  const extensions = record(value, path);
  if (extensions.trailContextNote !== undefined) text(extensions.trailContextNote, `${path}.trailContextNote`);
  if (extensions.reviewedSelectorOutcomes !== undefined) {
    for (const [index, item] of list(extensions.reviewedSelectorOutcomes, `${path}.reviewedSelectorOutcomes`).entries()) {
      const at = `${path}.reviewedSelectorOutcomes[${index}]`;
      const outcome = record(item, at);
      onlyKeys(outcome, SELECTOR_OUTCOME_FIELDS, at);
      text(outcome.label, `${at}.label`);
      if (!SELECTOR_VERDICTS.has(outcome.verdict)) fail(`${at}.verdict`, "is not a reviewed selector verdict");
    }
  }
  if (extensions.provenance !== undefined) {
    for (const [key, item] of Object.entries(record(extensions.provenance, `${path}.provenance`))) text(item, `${path}.provenance.${key}`);
  }
  // Other extension keys are tolerated per contract but never rendered by Maps.
}

function validateCase(value, path, validateLens) {
  const item = record(value, path);
  if (item.schemaVersion !== NE_MAPS_CASE_SCHEMA_VERSION) fail(`${path}.schemaVersion`, `must be ${NE_MAPS_CASE_SCHEMA_VERSION}`);
  onlyKeys(item, CASE_FIELDS, path);
  if (typeof item.id !== "string" || !CASE_ID.test(item.id)) fail(`${path}.id`, "must be a lowercase URL-safe case id");

  const display = record(item.display, `${path}.display`);
  onlyKeys(display, DISPLAY_FIELDS, `${path}.display`);
  for (const key of DISPLAY_FIELDS) text(display[key], `${path}.display.${key}`);

  const exactAction = record(item.exactAction, `${path}.exactAction`);
  text(exactAction.networkId, `${path}.exactAction.networkId`);
  text(exactAction.id, `${path}.exactAction.id`);
  for (const [key, entry] of Object.entries(exactAction)) text(entry, `${path}.exactAction.${key}`);

  assertLensRenderableV01(item.lens, `${path}.lens`);
  if (validateLens) validateLens(item.lens, `${path}.lens`);
  const propositionIds = new Set(item.lens.propositions.map(proposition => proposition.propositionId));
  const order = texts(item.trailPropositionOrder, `${path}.trailPropositionOrder`);
  const ordered = new Set();
  for (const [index, id] of order.entries()) {
    if (!propositionIds.has(id)) fail(`${path}.trailPropositionOrder[${index}]`, `references unknown proposition ${id}`);
    if (ordered.has(id)) fail(`${path}.trailPropositionOrder[${index}]`, `duplicates ${id}`);
    ordered.add(id);
  }
  if (item.extensions !== undefined) validateExtensions(item.extensions, `${path}.extensions`);
}

/**
 * Validates an ne-maps-case-collection/v0.1 value and every nested ne-maps-case/v0.1.
 * Returns the same value on success; throws NeMapsValidationError otherwise.
 * `options.validateLens(lens, path)` runs in addition to the Maps render check.
 */
export function validateNeMapsCollectionV01(value, options = {}) {
  const validateLens = options.validateLens;
  const collection = record(value, "collection");
  if (collection.schemaVersion !== NE_MAPS_COLLECTION_SCHEMA_VERSION) fail("collection.schemaVersion", `must be ${NE_MAPS_COLLECTION_SCHEMA_VERSION}`);
  onlyKeys(collection, COLLECTION_FIELDS, "collection");
  if (collection.TARGET_CORE_MUTATIONS !== 0) fail("collection.TARGET_CORE_MUTATIONS", "must be 0");
  scanForbidden(collection, "collection", 0);
  if (collection.sourceAuthority !== undefined) {
    const authority = record(collection.sourceAuthority, "collection.sourceAuthority");
    onlyKeys(authority, SOURCE_AUTHORITY_FIELDS, "collection.sourceAuthority");
    text(authority.repository, "collection.sourceAuthority.repository");
    text(authority.commit, "collection.sourceAuthority.commit");
    for (const key of ["branch", "export"]) if (authority[key] !== undefined) text(authority[key], `collection.sourceAuthority.${key}`);
  }
  if (collection.publicSuite !== undefined) {
    const suite = record(collection.publicSuite, "collection.publicSuite");
    onlyKeys(suite, PUBLIC_SUITE_FIELDS, "collection.publicSuite");
    text(suite.repository, "collection.publicSuite.repository");
    text(suite.commit, "collection.publicSuite.commit");
  }
  if (texts(collection.nonClaims, "collection.nonClaims").length === 0) fail("collection.nonClaims", "must not be empty");

  const cases = list(collection.cases, "collection.cases");
  if (cases.length === 0) fail("collection.cases", "must contain at least one case");
  if (cases.length > NE_MAPS_LIMITS.maxCases) fail("collection.cases", "exceeds the case bound");
  const ids = new Set();
  for (const [index, item] of cases.entries()) {
    validateCase(item, `collection.cases[${index}]`, validateLens);
    if (ids.has(item.id)) fail(`collection.cases[${index}].id`, `duplicates ${item.id}`);
    ids.add(item.id);
  }
  return collection;
}
