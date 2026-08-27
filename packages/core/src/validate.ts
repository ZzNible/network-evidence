import { assertCanonicalizable, canonicalJson } from "./canonical-json.js";
import { isDigest } from "./digest.js";
import {
  computeCapabilitySnapshotDigest,
  computeDiscoverNetworksResultDigest,
  computeEvidencePolicyDigest,
  computeEvidenceSnapshotDigest,
  computeNetworkEvidenceResultArtifactDigest,
  computeNetworkEvidenceResultSemanticDigest,
  computePreflightResultDigest,
  computeResolverManifestDigest,
  normalizedEvaluationIdentity,
} from "./digests.js";
import { NecValidationError } from "./errors.js";
import {
  assertInertArray,
  firstArrayDeviation,
  isWellFormedString,
  utf8ByteLength,
} from "./internal.js";
import { decodeBase64Strict, nativeSourceContentDigest } from "./native.js";
import { MAX_DECIMAL_INTEGER_DIGITS, RESOURCE_LIMITS } from "./limits.js";
import { composePreflightStatus } from "./preflight.js";
import { assertNormativePropositionState } from "./verdict.js";
import { conflictAffectsProposition, isPropositionScope as isPropositionScopeValue, normalizedWarningIdentity } from "./conflict.js";
import {
  APPLICABILITIES,
  CAPABILITY_AVAILABILITIES,
  CAPABILITY_NAMES,
  CAPABILITY_SUPPORTS,
  EVIDENCE_BASES,
  EVIDENCE_DIMENSION_NAMES,
  EVIDENCE_VERDICTS,
  POLICY_DIMENSIONS,
  isApplicability,
  isCapabilityAvailability,
  isCapabilityName,
  isCapabilitySupport,
  isEvidenceBasis,
  isEvidenceDimensionName,
  isEvidenceVerdict,
  isPolicyDimension,
} from "./applicability.js";
import type {
  CapabilityRequirement,
  Conflict,
  EvidenceAnchor,
  EvidenceDimension,
  EvidenceRef,
  EvidenceSnapshot,
  EvidenceVerdict,
  Hex,
  Iso8601,
  NativeId,
  NativeSourcePayload,
  NetworkAnchor,
  NetworkEvidenceResult,
  NetworkFingerprint,
  NetworkId,
  ObservedEffect,
  PolicyDimension,
  PreflightRequest,
  PreflightResult,
  PropositionScope,
  ReadinessCheck,
  ResolverManifest,
  ResolverManifestRef,
  SubjectRef,
  Warning,
} from "./types.js";

/**
 * Defensive, fail-closed validation utilities for EVERY public NEC v0.1
 * data contract.
 *
 * All validators accept `unknown` and throw `NecValidationError` on any
 * deviation. Validation never "repairs" input. Enforced rules:
 *
 *   - exact field sets, recursively: unknown fields fail closed; optional
 *     fields explicitly present with `undefined` are INVALID (absent only);
 *   - contract objects are plain data end to end: prototypes limited to
 *     `Object.prototype`/null (arrays: `Array.prototype`, dense, no extra
 *     own properties), no symbol-keyed / non-enumerable / accessor
 *     properties anywhere. Only property DESCRIPTORS are inspected before
 *     values are read, so no getter is ever executed merely to reject it;
 *   - generic NEC values (metadata/fields/rules/constraints/sourceConfig)
 *     are JSON-safe: no bigint (wire profile carries those as decimal
 *     strings), no unpaired surrogates, bounded depth/width/size;
 *   - timestamps are exactly `YYYY-MM-DDTHH:mm:ss.sssZ` with a valid
 *     calendar date — no timezone aliases;
 *   - every EvidenceId cited anywhere resolves in the artifact's evidence
 *     table; duplicate ids fail closed;
 *   - the normative applicability/verdict state machine (see below);
 *   - conflicts carry an explicit non-empty `PropositionScope`;
 *   - self-digesting artifacts (policy, manifest, snapshot, capability
 *     snapshot, discovery result, preflight result, network evidence
 *     result) must carry digests that match their recomputed values.
 */

/** Metadata keys that must never appear in NEC data (no confidence/trust scores in NEC). */
export const RESERVED_METADATA_KEYS: readonly string[] = [
  "confidence",
  "trustScore",
  "securityScore",
  "probability",
] as const;

const HEX_PATTERN = /^0x([0-9a-f]{2})*$/;
const ISO8601_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MEDIA_TYPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/;
const NATIVE_NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * NEC-OWNED IDENTIFIER GRAMMAR (v0.1 freeze) — intentionally boring ASCII,
 * chosen over any Unicode-normalization-dependent form. No silent
 * normalization exists anywhere: a rejected spelling stays rejected.
 *
 *     [A-Za-z0-9][A-Za-z0-9._:/-]{0,127}
 *
 * i.e. 1..128 characters, starting with an ASCII alphanumeric, then only
 * ASCII alphanumerics, dot, underscore, colon, slash, hyphen. Control
 * characters, whitespace (including interior spaces), non-ASCII and
 * leading separators all fail closed.
 *
 * Applied to NEC-owned identifiers: request ids, evidence ids, source ids/
 * types, resolver/policy/snapshot ids, conflict/warning/blocker codes,
 * effect ids and types, action kinds, scope effect ids, anchor roles, etc.
 * It is deliberately NOT applied to opaque NETWORK-NATIVE values
 * (`NativeId`: transaction ids, block ids, addresses, batch ids, chain
 * -specific identifiers) — those stay separately bounded native strings
 * and receive stricter family-specific validation inside network
 * resolvers.
 */
const NEC_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export function isNecIdentifier(value: unknown): value is string {
  return typeof value === "string" && NEC_IDENTIFIER_PATTERN.test(value);
}

/** NEC-owned identifier grammar assertion (see `isNecIdentifier`). */
export function assertNecIdentifier(value: unknown, path: string): asserts value is string {
  if (!isNecIdentifier(value)) {
    fail(
      path,
      'must match the NEC identifier grammar ^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$ (ASCII; no whitespace/control characters)',
    );
  }
}

// ---------------------------------------------------------------------------
// Generic utilities
// ---------------------------------------------------------------------------

/**
 * Recursively freeze a plain-data object. Frozen structures stay immutable.
 *
 * Bounded like every other traversal: cycles fail closed and the frozen
 * graph may not exceed the v0.1 depth/node budgets, so a hostile input can
 * never reach a RangeError (stack overflow) through this function.
 */
export function deepFreeze<T>(value: T): Readonly<T> {
  deepFreezeWalk(value as unknown, { ancestors: new Set(), nodes: 0 }, 1);
  return value as Readonly<T>;
}

function deepFreezeWalk(
  value: unknown,
  state: { readonly ancestors: Set<object>; nodes: number },
  depth: number,
): void {
  if (value === null || typeof value !== "object") return;
  if (state.ancestors.has(value)) {
    throw new NecValidationError("NEC_VALIDATION_FAILED", "deepFreeze: circular reference");
  }
  state.nodes += 1;
  if (state.nodes > RESOURCE_LIMITS.MAX_TOTAL_NODES) {
    limitFail("deepFreeze", "MAX_TOTAL_NODES", `exceeds ${RESOURCE_LIMITS.MAX_TOTAL_NODES} values`);
  }
  if (depth > RESOURCE_LIMITS.MAX_DEPTH) {
    limitFail("deepFreeze", "MAX_DEPTH", `exceeds maximum depth of ${RESOURCE_LIMITS.MAX_DEPTH}`);
  }
  const deviation = firstArrayDeviation(value);
  if (deviation === null) {
    // Inert array: freeze without touching element iteration surfaces.
    for (let i = 0; i < (value as unknown[]).length; i++) {
      deepFreezeWalk((value as unknown[])[i], state, depth + 1);
    }
    Object.freeze(value);
    return;
  }
  if (Array.isArray(value)) {
    // Non-inert arrays cannot enter a frozen NEC graph.
    fail("deepFreeze", deviation);
  }
  state.ancestors.add(value);
  try {
    for (const key of Object.keys(value as object)) {
      deepFreezeWalk((value as Record<string, unknown>)[key], state, depth + 1);
    }
  } finally {
    state.ancestors.delete(value);
  }
  Object.freeze(value);
}

function fail(path: string, reason: string): never {
  throw new NecValidationError("NEC_VALIDATION_FAILED", `${path}: ${reason}`);
}

function limitFail(path: string, limit: string, reason: string): never {
  throw new NecValidationError("NEC_VALIDATION_FAILED", `${path}: ${limit}: ${reason}`);
}

interface WalkState {
  readonly ancestors: Set<object>;
  nodes: number;
}

// ---------------------------------------------------------------------------
// Primitive assertions
// ---------------------------------------------------------------------------

/** Free-text string: non-empty, well-formed Unicode, <= MAX_STRING_UTF8_BYTES. */
export function assertNonEmptyString(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    fail(path, "must be a non-empty string");
  }
  if (!isWellFormedString(value)) {
    fail(path, "contains an unpaired UTF-16 surrogate");
  }
  const bytes = utf8ByteLength(value);
  if (bytes > RESOURCE_LIMITS.MAX_STRING_UTF8_BYTES) {
    limitFail(path, "MAX_STRING_UTF8_BYTES", `exceeds ${RESOURCE_LIMITS.MAX_STRING_UTF8_BYTES} UTF-8 bytes`);
  }
}

/** Identifier-ish string: bounded, well-formed, no leading/trailing whitespace. */
export function assertBoundedIdentifier(
  value: unknown,
  path: string,
  maxBytes: number = RESOURCE_LIMITS.MAX_ID_UTF8_BYTES,
): asserts value is string {
  assertNonEmptyString(value, path);
  if (utf8ByteLength(value) > maxBytes) {
    limitFail(path, "MAX_ID_UTF8_BYTES", `identifier exceeds ${maxBytes} UTF-8 bytes`);
  }
  const first = value.charCodeAt(0);
  const last = value.charCodeAt(value.length - 1);
  if (first <= 0x20 || last <= 0x20) {
    fail(path, "must not have leading or trailing whitespace");
  }
}

/** Network identifier (e.g. "eip155:8453"). */
export function assertNetworkId(value: unknown, path: string): asserts value is NetworkId {
  assertBoundedIdentifier(value, path, RESOURCE_LIMITS.MAX_NETWORK_ID_UTF8_BYTES);
}

/**
 * Opaque network-native identifier (txId/blockId/genesisId/account/target).
 * Core validates bounds and well-formedness ONLY; the network-family
 * resolver owns the detailed format.
 */
export function assertNativeId(value: unknown, path: string): asserts value is NativeId {
  assertBoundedIdentifier(value, path, RESOURCE_LIMITS.MAX_NATIVE_ID_UTF8_BYTES);
}

/** Generic hex byte-string primitive: lowercase, 0x prefix, even digit count. */
export function assertHex(value: unknown, path: string): asserts value is Hex {
  if (typeof value !== "string" || !HEX_PATTERN.test(value)) {
    fail(path, 'must be a lowercase 0x-prefixed hex string with an even number of digits');
  }
}

function isLeapGregorianYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInGregorianMonth(year: number, month: number): number {
  switch (month) {
    case 1:
    case 3:
    case 5:
    case 7:
    case 8:
    case 10:
    case 12:
      return 31;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    case 2:
      return isLeapGregorianYear(year) ? 29 : 28;
    default:
      return 0;
  }
}

/**
 * Canonical UTC timestamp: EXACTLY `YYYY-MM-DDTHH:mm:ss.sssZ` with a real
 * calendar date. Timezone aliases (`+01:00`), lowercase variants, other
 * fractional-digit counts and impossible dates all fail closed.
 */
export function assertIso8601(value: unknown, path: string): asserts value is Iso8601 {
  if (typeof value !== "string") fail(path, "must be an ISO-8601 UTC timestamp");
  if (!isWellFormedString(value)) fail(path, "contains an unpaired surrogate");
  if (!ISO8601_PATTERN.test(value)) {
    fail(path, 'must be exactly YYYY-MM-DDTHH:mm:ss.sssZ (canonical UTC)');
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const hour = Number(value.slice(11, 13));
  const minute = Number(value.slice(14, 16));
  const second = Number(value.slice(17, 19));
  const maxDay = daysInGregorianMonth(year, month);
  if (maxDay === 0 || day < 1 || day > maxDay) {
    fail(path, "month/day is not a real calendar date");
  }
  if (hour > 23 || minute > 59 || second > 59) {
    fail(path, "time-of-day out of range");
  }
}

export function assertDigestShape(value: unknown, path: string): void {
  if (!isDigest(value)) {
    fail(path, 'must be a digest of form "sha256:<64 lowercase hex chars>"');
  }
}

export function assertSchemaVersion(value: unknown, path: string): asserts value is "0.1" {
  if (value !== "0.1") {
    fail(path, 'schemaVersion must be "0.1"');
  }
}

export function assertSafePositiveInteger(
  value: unknown,
  path: string,
): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    fail(path, "must be a positive safe integer");
  }
}

function assertBlockNumber(value: unknown, path: string): asserts value is bigint {
  if (typeof value !== "bigint") fail(path, "must be bigint");
  if (value < 0n) fail(path, "must be >= 0");
  // ONE domain rule shared with the wire profile: a schema-typed integer
  // that wire decode would reject must be equally unacceptable at runtime
  // and at encode time.
  if (value.toString().length > MAX_DECIMAL_INTEGER_DIGITS) {
    limitFail(
      path,
      "MAX_DECIMAL_INTEGER_DIGITS",
      `schema-typed integer exceeds ${MAX_DECIMAL_INTEGER_DIGITS} decimal digits`,
    );
  }
}

function assertBoolean(value: unknown, path: string): asserts value is boolean {
  if (typeof value !== "boolean") fail(path, "must be boolean");
}

// ---------------------------------------------------------------------------
// Generic NEC values (metadata / fields / records) — JSON-safe domain
// ---------------------------------------------------------------------------

/**
 * Assert that a value is a plain record whose entire tree contains only
 * JSON-safe NEC data: no bigint (schema-declared integer quantities use
 * bigint at runtime and decimal strings on the wire; GENERIC records never
 * carry them), safe integers only, no accessors/symbols/non-enumerable
 * properties, dense arrays, plain prototypes, no reserved score keys, no
 * undefined, no unpaired surrogates, within resource limits.
 *
 * The acceptance domain is kept exactly aligned with
 * `nec-canonical-json-v1` (minus bigint); the `assertCanonicalizable` net
 * re-checks agreement so any future divergence fails here.
 */
export function assertPlainRecord(
  value: unknown,
  path: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "must be a plain object");
  }
  walkCanonical(value, path, { ancestors: new Set(), nodes: 0 }, 1);
  // Drift-proof safety net: throws iff canonicalJson would throw, so any
  // future divergence fails here instead of surfacing during digest binding.
  try {
    assertCanonicalizable(value);
  } catch (error) {
    fail(path, `value is outside nec-canonical-json-v1 (${(error as Error).message})`);
  }
}

function checkReservedKeys(record: Record<string, unknown>, path: string): void {
  for (const reserved of RESERVED_METADATA_KEYS) {
    if (Object.prototype.hasOwnProperty.call(record, reserved)) {
      fail(path, `reserved key "${reserved}" must not appear in NEC data (no scores exist in NEC)`);
    }
  }
}

/**
 * Structural walk over generic NEC values mirroring
 * `nec-canonical-json-v1` exactly, plus NEC-only rules (reserved keys,
 * explicit undefined rejection, bigint rejection for generic data).
 */
function walkCanonical(value: unknown, path: string, state: WalkState, depth: number): void {
  if (depth > RESOURCE_LIMITS.MAX_DEPTH) {
    limitFail(path, "MAX_DEPTH", `exceeds maximum depth of ${RESOURCE_LIMITS.MAX_DEPTH}`);
  }
  state.nodes += 1;
  if (state.nodes > RESOURCE_LIMITS.MAX_TOTAL_NODES) {
    limitFail(path, "MAX_TOTAL_NODES", `exceeds ${RESOURCE_LIMITS.MAX_TOTAL_NODES} values`);
  }
  switch (typeof value) {
    case "boolean":
    case "string":
      if (typeof value === "string") {
        if (!isWellFormedString(value)) fail(path, "contains an unpaired UTF-16 surrogate");
        if (utf8ByteLength(value) > RESOURCE_LIMITS.MAX_STRING_UTF8_BYTES) {
          limitFail(path, "MAX_STRING_UTF8_BYTES", "string too large");
        }
      }
      return;
    case "number":
      // Same rules as serializeNumber in nec-canonical-json-v1.
      if (!Number.isSafeInteger(value)) {
        fail(path, "number must be a safe integer; use a decimal string instead");
      }
      if (Object.is(value, -0)) {
        fail(path, "number -0 is not deterministic; use 0");
      }
      return;
    case "bigint":
      fail(
        path,
        "generic NEC data must be JSON-safe: schema-declared integer quantities use bigint at runtime, everything else uses numbers/decimal strings",
      );
      return;
    case "object": {
      if (value === null) return;
      if (state.ancestors.has(value)) fail(path, "circular reference");
      state.ancestors.add(value);
      try {
        if (Array.isArray(value)) {
          walkArray(value, path, state, depth);
          return;
        }
        const proto = Object.getPrototypeOf(value);
        if (proto !== Object.prototype && proto !== null) {
          fail(path, "must be a plain object");
        }
        const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
          string,
          PropertyDescriptor
        >;
        let entryCount = 0;
        for (const key of Reflect.ownKeys(descriptors)) {
          if (typeof key === "symbol") {
            fail(`${path}.<symbol>`, "symbol-keyed properties are not allowed");
          }
          const d = descriptors[key]!;
          if (d.get !== undefined || d.set !== undefined) {
            fail(`${path}.${key}`, "accessor properties are not allowed");
          }
          if (!d.enumerable) {
            fail(`${path}.${key}`, "non-enumerable properties are not allowed");
          }
          entryCount += 1;
        }
        if (entryCount > RESOURCE_LIMITS.MAX_CONTAINER_ENTRIES) {
          limitFail(path, "MAX_CONTAINER_ENTRIES", `object has ${entryCount} entries`);
        }
        checkReservedKeys(value as Record<string, unknown>, path);
        for (const key of Object.keys(descriptors)) {
          if (descriptors[key]!.value === undefined) {
            fail(`${path}.${key}`, "undefined values are not allowed");
          }
          walkCanonical(descriptors[key]!.value, `${path}.${key}`, state, depth + 1);
        }
        return;
      } finally {
        state.ancestors.delete(value);
      }
    }
    default:
      fail(path, `unsupported value of type ${typeof value}`);
  }
}

function walkArray(value: readonly unknown[], path: string, state: WalkState, depth: number): void {
  // THE shared inert-array model: one descriptor-first acceptance predicate
  // (prototype, density, data-only indexes, no symbols/extra props, length
  // binding, MAX_CONTAINER_ENTRIES) before any element value is read.
  const deviation = firstArrayDeviation(value);
  if (deviation !== null) fail(path, deviation);
  for (let i = 0; i < value.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, i);
    if (d === undefined) fail(`${path}[${i}]`, "holey array entry");
    walkCanonical(d.value, `${path}[${i}]`, state, depth + 1);
  }
}

// ---------------------------------------------------------------------------
// Exact contract field sets (v0.1) — recursive, fail closed
// ---------------------------------------------------------------------------

/** Declared v0.1 fields of one contract structure, split by requiredness. */
interface ExactFieldSet {
  readonly required: readonly string[];
  readonly optional: readonly string[];
}

/**
 * Exact v0.1 field sets. Every public NEC structure accepts ONLY its
 * declared keys: contract fields are exact and extensions belong explicitly
 * in `metadata`. Unknown fields are rejected — never silently stripped,
 * never frozen into artifacts, never bound into digests without validation.
 * Optional fields present with value `undefined` are INVALID.
 */
const F = (required: readonly string[], optional: readonly string[] = []): ExactFieldSet => ({
  required,
  optional,
});

const NETWORK_ANCHOR_FIELDS = F([], ["blockNumber", "blockId", "timestamp"]);
const NETWORK_FINGERPRINT_FIELDS = F(
  ["networkId", "observedAt"],
  ["chainId", "genesisId", "protocolVersion", "deploymentDigest", "metadata"],
);
const EVIDENCE_REF_FIELDS = F(
  ["id", "sourceId", "sourceType", "retrievedAt"],
  [
    "independenceGroup",
    "locator",
    "contentDigest",
    "networkId",
    "blockNumber",
    "blockId",
    "metadata",
    "nativeSource",
  ],
);
const NATIVE_SOURCE_PAYLOAD_FIELDS = F(
  ["namespace", "mediaType", "encoding", "payload", "contentDigest"],
  ["schema"],
);
const EVIDENCE_DIMENSION_FIELDS = F(
  ["applicability", "basis", "evidence"],
  ["verdict", "reason", "metadata"],
);
const OBSERVED_EFFECT_FIELDS = F(
  ["id", "type", "fields", "basis", "evidence"],
  ["metadata"],
);
const SUBJECT_TRANSACTION_FIELDS = F(["type", "networkId", "txId"]);
const SUBJECT_BLOCK_FIELDS = F(["type", "networkId"], ["blockNumber", "blockId"]);
const SUBJECT_BATCH_FIELDS = F(["type", "networkId", "batchId"]);
const SUBJECT_CUSTOM_FIELDS = F(["type", "networkId", "namespace", "value"]);
const ID_VERSION_DIGEST_FIELDS = F(["id", "version", "digest"]);
const ID_DIGEST_FIELDS = F(["id", "digest"]);
const REQUEST_ID_DIGEST_FIELDS = F(["requestId", "digest"]);
const RESOLVER_MANIFEST_FIELDS = F([
  "id",
  "version",
  "digest",
  "networkFamilies",
  "implementation",
  "supportedCapabilities",
  "sourceRequirements"], ["metadata"]);
const IMPLEMENTATION_FIELDS = F([], ["package", "commit"]);
const SOURCE_REQUIREMENT_FIELDS = F(["sourceType", "required"]);
const CAPABILITY_STATE_FIELDS = F(["support", "availability"], ["reason", "evidence", "metadata"]);
const EVIDENCE_CAPABILITY_SET_FIELDS = F([
  "execution",
  "observedEffects",
  "dataBinding",
  "settlement",
  "finality",
]);
const EXECUTION_CAPABILITY_SET_FIELDS = F([], [
  "executionModel",
  "accountModel",
  "gasModel",
  "simulation",
  "batching",
]);
const CAPABILITY_SNAPSHOT_FIELDS = F([
  "schemaVersion",
  "id",
  "generatedAt",
  "network",
  "evidenceCapabilities",
  "executionCapabilities",
  "evidence",
  "resolver",
  "artifactDigest",
]);
const CAPABILITY_REQUIREMENT_FIELDS = F(["capability", "strength"]);
const DISCOVERY_REQUIREMENTS_FIELDS = F(["requirements"], ["networkAllowlist", "networkDenylist", "metadata"]);
const REQUIREMENT_EVALUATION_FIELDS = F(["requirement", "status"], ["reason", "evidence"]);
const NETWORK_DISCOVERY_MATCH_FIELDS = F([
  "network",
  "classification",
  "evaluations",
  "capabilitySnapshot",
  "evidence",
]);
const DISCOVER_NETWORKS_RESULT_FIELDS = F([
  "schemaVersion",
  "requestId",
  "generatedAt",
  "request",
  "matches",
  "artifactDigest",
]);
const EVIDENCE_POLICY_FIELDS = F(
  ["id", "version", "requiredDimensions", "digest"],
  ["desiredDimensions", "rules"],
);
const ACTION_DESCRIPTOR_FIELDS = F(["kind"], ["target", "value", "fields"]);
const PREFLIGHT_REQUEST_FIELDS = F(
  ["schemaVersion", "requestId", "networkId", "action", "evidencePolicy"],
  ["account", "metadata"],
);
const READINESS_CHECK_FIELDS = F(["status"], ["reason", "evidence", "metadata"]);
const PREFLIGHT_BLOCKER_FIELDS = F(["code", "reason"]);
const PREFLIGHT_RESULT_FIELDS = F(
  [
    "schemaVersion",
    "generatedAt",
    "status",
    "network",
    "request",
    "evidenceReadiness",
    "blockers",
    "warnings",
    "evidence",
    "evidencePolicy",
    "resolver",
    "artifactDigest",
  ],
  ["capabilitySnapshot"],
);
const EVIDENCE_ANCHOR_FIELDS_CONTRACT = F(["networkId"], ["blockNumber", "blockId", "timestamp", "role"]);
const CONFLICT_FIELDS = F(
  ["id", "code", "description", "scope", "evidence", "material"],
  ["metadata"],
);
const WARNING_FIELDS = F(["code", "message"], ["evidence", "metadata"]);
const NETWORK_EVIDENCE_RESULT_FIELDS = F([
  "schemaVersion",
  "requestId",
  "generatedAt",
  "request",
  "action",
  "network",
  "subject",
  "policy",
  "snapshot",
  "networkEvidence",
  "evidence",
  "conflicts",
  "warnings",
  "resolver",
  "semanticDigest",
  "artifactDigest",
]);
const EVIDENCE_SNAPSHOT_FIELDS = F([
  "id",
  "digest",
  "createdAt",
  "networkFingerprint",
  "anchors",
  "evidence",
  "resolverManifestDigest",
  "policyDigest",
]);
const NETWORK_EVIDENCE_CONTAINER_FIELDS = F([
  "execution",
  "observedEffects",
  "dataBinding",
  "settlement",
  "finality",
]);
const EVIDENCE_REQUEST_FIELDS = F(
  ["schemaVersion", "requestId", "networkId", "subject", "action", "evidencePolicy"],
  ["preflight", "metadata"],
);
const RESOLVER_CONTEXT_FIELDS = F(["now", "sourceConfig"]);
const PREFLIGHT_FRAGMENT_FIELDS = F([
  "network",
  "evidenceReadiness",
  "evidence",
  "blockers",
  "warnings",
]);
const NETWORK_EVIDENCE_FRAGMENT_FIELDS = F([
  "network",
  "subject",
  "networkEvidence",
  "evidence",
  "conflicts",
  "warnings",
]);

/**
 * Fail closed on any deviation from the declared field set: missing required
 * fields, unknown fields, and optional fields explicitly present with
 * `undefined` (absent is the only way to omit a field).
 */
function assertExactFieldSet(value: object, expected: ExactFieldSet, path: string): void {
  const allowed = new Set([...expected.required, ...expected.optional]);
  for (const key of expected.required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      fail(path, `missing required field "${key}"`);
    }
  }
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
    string,
    PropertyDescriptor
  >;
  const extras: string[] = [];
  for (const key of Object.keys(descriptors)) {
    if (!allowed.has(key)) {
      extras.push(key);
      continue;
    }
    if (descriptors[key]!.value === undefined) {
      fail(
        `${path}.${key}`,
        'explicitly-undefined field: absent (property removed) is the only valid way to omit an optional field',
      );
    }
  }
  if (extras.length > 0) {
    fail(
      path,
      `unknown field(s) ${extras.map((k) => JSON.stringify(k)).join(", ")} are not part of schemaVersion "0.1"; failing closed`,
    );
  }
}

/**
 * Plain-data contract-object checks that NEVER read property values:
 * object-shaped, no accessor properties, no symbol-keyed or non-enumerable
 * own properties, prototype exactly `Object.prototype` or null. Only
 * property DESCRIPTORS are inspected before any value is touched, so this
 * can never execute a getter merely in order to reject the input.
 *
 * Symbol-keyed and non-enumerable properties are invisible to `Object.keys`
 * (and therefore to the canonicalizer, the defensive cloner and
 * `JSON.stringify`); accepting them would create data that is present on
 * the frozen artifact but absent from every digest — they fail closed.
 * Array `length` is exempt (a structural non-enumerable of real arrays).
 *
 * Exported for the context verifier (`result.ts`), which must guard every
 * caller-supplied sub-object BEFORE reading fields off it.
 */
export function assertPlainDataContractObject(value: unknown, path: string): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "must be an object");
  }
  const obj = value as object;
  const descriptors = Object.getOwnPropertyDescriptors(obj);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key === "symbol") {
      fail(path, `symbol-keyed properties are not allowed (${String(key)})`);
    }
    const descriptor = descriptors[key as string]!;
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      fail(`${path}.${String(key)}`, "accessor properties are not allowed in NEC contract data");
    }
    if (!descriptor.enumerable && !(Array.isArray(obj) && key === "length")) {
      fail(`${path}.${String(key)}`, "non-enumerable properties are not allowed in NEC contract data");
    }
  }
  const proto: unknown = Object.getPrototypeOf(obj);
  if (proto !== Object.prototype && proto !== null) {
    fail(path, "must be a plain object");
  }
}

/** `assertPlainDataContractObject` + exact field set (missing/unknown fields fail closed). */
function assertExactContractObject(
  value: unknown,
  expectedFields: ExactFieldSet,
  path: string,
): void {
  assertPlainDataContractObject(value, path);
  assertExactFieldSet(value as object, expectedFields, path);
}

/** Shared value checks for anchor-like objects (NetworkAnchor / EvidenceAnchor fields). */
function assertAnchorValueFields(anchor: NetworkAnchor | EvidenceAnchor, path: string): void {
  if (anchor.blockNumber !== undefined) assertBlockNumber(anchor.blockNumber, `${path}.blockNumber`);
  if (anchor.blockId !== undefined) assertNativeId(anchor.blockId, `${path}.blockId`);
  if (anchor.timestamp !== undefined) assertIso8601(anchor.timestamp, `${path}.timestamp`);
}

function assertEnum<T extends string>(
  guard: (v: unknown) => v is T,
  value: unknown,
  path: string,
  vocabulary: readonly T[],
): void {
  if (!guard(value)) {
    fail(path, `unknown enum value ${JSON.stringify(String(value))}; expected one of ${vocabulary.join(", ")}`);
  }
}

function assertEnumArrayUnique<T extends string>(
  guard: (v: unknown) => v is T,
  vocabulary: readonly T[],
  value: unknown,
  path: string,
): asserts value is T[] {
  assertInertArray(value, path);
  const seen = new Set<string>();
  for (let i = 0; i < value.length; i++) {
    assertEnum(guard, value[i], `${path}[${i}]`, vocabulary);
    if (seen.has(value[i] as string)) {
      fail(`${path}[${i}]`, `duplicate entry ${JSON.stringify(value[i])} in set-like collection`);
    }
    seen.add(value[i] as string);
  }
}

function assertEvidenceIdArray(value: unknown, path: string): asserts value is string[] {
  assertInertArray(value, path);
  const seen = new Set<string>();
  for (let i = 0; i < value.length; i++) {
    assertNecIdentifier(value[i], `${path}[${i}]`);
    if (seen.has(value[i] as string)) {
      fail(`${path}[${i}]`, `duplicate evidence id ${JSON.stringify(value[i])} in set-like citation list`);
    }
    seen.add(value[i] as string);
  }
}

function assertStringArrayUnique(value: unknown, path: string): asserts value is string[] {
  assertInertArray(value, path);
  const seen = new Set<string>();
  for (let i = 0; i < value.length; i++) {
    assertBoundedIdentifier(value[i], `${path}[${i}]`);
    if (seen.has(value[i] as string)) {
      fail(`${path}[${i}]`, `duplicate entry ${JSON.stringify(value[i])} in set-like collection`);
    }
    seen.add(value[i] as string);
  }
}

/** Set-like array of NetworkIds (exact NetworkId validation, unique). */
function assertNetworkIdArrayUnique(value: unknown, path: string): asserts value is string[] {
  assertInertArray(value, path);
  const seen = new Set<string>();
  for (let i = 0; i < value.length; i++) {
    assertNetworkId(value[i], `${path}[${i}]`);
    if (seen.has(value[i] as string)) {
      fail(`${path}[${i}]`, `duplicate entry ${JSON.stringify(value[i])} in set-like collection`);
    }
    seen.add(value[i] as string);
  }
}

function optionalRecord(value: unknown, path: string): void {
  if (value === undefined) return;
  assertPlainRecord(value, path);
}

function optionalFreeText(value: unknown, path: string): void {
  if (value === undefined) return;
  assertNonEmptyString(value, path);
}

function optionalIdentifier(value: unknown, path: string): void {
  if (value === undefined) return;
  assertBoundedIdentifier(value, path);
}

// ---------------------------------------------------------------------------
// Contract-type validators (every public v0.1 data contract)
// ---------------------------------------------------------------------------

export function validateNetworkAnchor(anchor: unknown, path = "anchor"): void {
  assertExactContractObject(anchor, NETWORK_ANCHOR_FIELDS, path);
  assertAnchorValueFields(anchor as NetworkAnchor, path);
}

export function validateNetworkFingerprint(fp: unknown, path = "network"): void {
  assertExactContractObject(fp, NETWORK_FINGERPRINT_FIELDS, path);
  const fingerprint = fp as NetworkFingerprint;
  assertNetworkId(fingerprint.networkId, `${path}.networkId`);
  if (fingerprint.chainId !== undefined) assertSafePositiveInteger(fingerprint.chainId, `${path}.chainId`);
  if (fingerprint.genesisId !== undefined) assertNativeId(fingerprint.genesisId, `${path}.genesisId`);
  optionalIdentifier(fingerprint.protocolVersion, `${path}.protocolVersion`);
  if (fingerprint.deploymentDigest !== undefined) {
    assertDigestShape(fingerprint.deploymentDigest, `${path}.deploymentDigest`);
  }
  validateNetworkAnchor(fingerprint.observedAt, `${path}.observedAt`);
  optionalRecord(fingerprint.metadata, `${path}.metadata`);
}

export function validateNativeSourcePayload(payload: unknown, path = "nativeSource"): void {
  assertExactContractObject(payload, NATIVE_SOURCE_PAYLOAD_FIELDS, path);
  const p = payload as NativeSourcePayload;
  if (
    typeof p.namespace !== "string" ||
    !NATIVE_NAMESPACE_PATTERN.test(p.namespace)
  ) {
    fail(`${path}.namespace`, 'must match ^[a-z0-9][a-z0-9._-]{0,63}$');
  }
  if (typeof p.mediaType !== "string" || !MEDIA_TYPE_PATTERN.test(p.mediaType)) {
    fail(`${path}.mediaType`, 'must be a "type/subtype" media type');
  }
  if (p.encoding !== "base64") {
    fail(`${path}.encoding`, 'must be "base64"');
  }
  if (typeof p.payload !== "string") {
    fail(`${path}.payload`, "payload must be a base64 string");
  }
  const decoded = decodeBase64Strict(p.payload, `${path}.payload`);
  assertDigestShape(p.contentDigest, `${path}.contentDigest`);
  const expected = nativeSourceContentDigest(decoded);
  if (p.contentDigest !== expected) {
    fail(
      `${path}.contentDigest`,
      "does not bind the decoded native payload bytes (tampered or mis-declared content)",
    );
  }
  if (p.schema !== undefined) optionalIdentifier(p.schema, `${path}.schema`);
}

export function validateEvidenceRef(ref: unknown, path = "evidenceRef"): void {
  assertExactContractObject(ref, EVIDENCE_REF_FIELDS, path);
  const r = ref as EvidenceRef;
  assertNecIdentifier(r.id, `${path}.id`);
  assertNecIdentifier(r.sourceId, `${path}.sourceId`);
  assertNecIdentifier(r.sourceType, `${path}.sourceType`);
  if (r.independenceGroup !== undefined) assertNecIdentifier(r.independenceGroup, `${path}.independenceGroup`);
  optionalFreeText(r.locator, `${path}.locator`);
  assertIso8601(r.retrievedAt, `${path}.retrievedAt`);
  if (r.contentDigest !== undefined) assertDigestShape(r.contentDigest, `${path}.contentDigest`);
  if (r.networkId !== undefined) assertNetworkId(r.networkId, `${path}.networkId`);
  if (r.blockNumber !== undefined) assertBlockNumber(r.blockNumber, `${path}.blockNumber`);
  if (r.blockId !== undefined) assertNativeId(r.blockId, `${path}.blockId`);
  optionalRecord(r.metadata, `${path}.metadata`);
  if (r.nativeSource !== undefined) {
    validateNativeSourcePayload(r.nativeSource, `${path}.nativeSource`);
  }
}

/**
 * Structural dimension validation INCLUDING the applicability/verdict state
 * machine (conflict-scope interactions are enforced at artifact level):
 *
 *   applicability "applicable"      -> verdict REQUIRED
 *   applicability "not_applicable"  -> verdict MUST be absent
 *   applicability "unknown"         -> verdict MUST be absent
 *   supported/contradicted/ambiguous -> non-empty basis AND evidence
 */
export function validateEvidenceDimension(dim: unknown, path = "dimension"): void {
  assertExactContractObject(dim, EVIDENCE_DIMENSION_FIELDS, path);
  const d = dim as EvidenceDimension;
  assertEnum(isApplicability, d.applicability, `${path}.applicability`, APPLICABILITIES);
  assertEnumArrayUnique(isEvidenceBasis, EVIDENCE_BASES, d.basis, `${path}.basis`);
  assertEvidenceIdArray(d.evidence, `${path}.evidence`);
  optionalFreeText(d.reason, `${path}.reason`);
  optionalRecord(d.metadata, `${path}.metadata`);
  if (d.applicability === "applicable") {
    if (d.verdict === undefined) {
      fail(`${path}.verdict`, "required when applicability is \"applicable\"");
    }
  } else if (d.verdict !== undefined) {
    fail(`${path}.verdict`, `MUST be absent when applicability is "${d.applicability}"`);
  }
  if (d.verdict !== undefined) {
    assertEnum(isEvidenceVerdict, d.verdict, `${path}.verdict`, EVIDENCE_VERDICTS);
    if (d.verdict !== "insufficient") {
      if (d.basis.length === 0) {
        fail(`${path}.basis`, `non-empty basis required for "${d.verdict}"`);
      }
      if (d.evidence.length === 0) {
        fail(`${path}.evidence`, `non-empty evidence required for "${d.verdict}"`);
      }
    }
  }
}

export function validateObservedEffect(effect: unknown, path = "observedEffect"): void {
  assertExactContractObject(effect, OBSERVED_EFFECT_FIELDS, path);
  const e = effect as ObservedEffect;
  assertNecIdentifier(e.id, `${path}.id`);
  assertNecIdentifier(e.type, `${path}.type`);
  assertPlainRecord(e.fields, `${path}.fields`);
  assertEnumArrayUnique(isEvidenceBasis, EVIDENCE_BASES, e.basis, `${path}.basis`);
  assertEvidenceIdArray(e.evidence, `${path}.evidence`);
  if (e.basis.length === 0) fail(`${path}.basis`, "an observed effect must have a non-empty basis");
  if (e.evidence.length === 0) {
    fail(`${path}.evidence`, "an observed effect must cite at least one EvidenceRef");
  }
  optionalRecord(e.metadata, `${path}.metadata`);
}

export function validatePropositionScope(scope: unknown, path = "scope"): void {
  // isPropositionScope performs descriptor-first shape checks without
  // reading values through potential getters.
  const ok = isPropositionScopeValue(scope);
  if (!ok) fail(path, "must be an explicit PropositionScope (kind: result|dimension|observed_effect|custom)");
  const s = scope as PropositionScope;
  if (s.kind === "dimension") assertEnum(isEvidenceDimensionName, s.dimension, `${path}.dimension`, EVIDENCE_DIMENSION_NAMES);
  if (s.kind === "observed_effect") assertNecIdentifier(s.effectId, `${path}.effectId`);
  if (s.kind === "custom") {
    if (typeof s.namespace !== "string" || !NATIVE_NAMESPACE_PATTERN.test(s.namespace)) {
      fail(`${path}.namespace`, 'must match ^[a-z0-9][a-z0-9._-]{0,63}$');
    }
    assertNecIdentifier(s.id, `${path}.id`);
  }
}

export function validateConflict(conflict: unknown, path = "conflict"): void {
  assertExactContractObject(conflict, CONFLICT_FIELDS, path);
  const c = conflict as Conflict;
  assertNecIdentifier(c.id, `${path}.id`);
  assertNecIdentifier(c.code, `${path}.code`);
  assertNonEmptyString(c.description, `${path}.description`);
  validatePropositionScope(c.scope, `${path}.scope`);
  assertEvidenceIdArray(c.evidence, `${path}.evidence`);
  assertBoolean(c.material, `${path}.material`);
  if (c.material && c.evidence.length === 0) {
    fail(
      `${path}.evidence`,
      "a material conflict must scope at least one EvidenceRef; unproven conflicts cannot be audited",
    );
  }
  optionalRecord(c.metadata, `${path}.metadata`);
}

export function validateWarning(item: unknown, path = "warning"): void {
  assertExactContractObject(item, WARNING_FIELDS, path);
  const w = item as Warning;
  assertNecIdentifier(w.code, `${path}.code`);
  assertNonEmptyString(w.message, `${path}.message`);
  if (w.evidence !== undefined) assertEvidenceIdArray(w.evidence, `${path}.evidence`);
  optionalRecord(w.metadata, `${path}.metadata`);
}

export function validateSubjectRef(subject: unknown, path = "subject"): void {
  // Descriptor-only checks first: never execute accessors while sniffing
  // the discriminator, then enforce the exact per-variant field set.
  assertPlainDataContractObject(subject, path);
  const record = subject as Record<string, unknown>;
  let variantFields: ExactFieldSet;
  switch (record.type) {
    case "transaction":
      variantFields = SUBJECT_TRANSACTION_FIELDS;
      break;
    case "block":
      variantFields = SUBJECT_BLOCK_FIELDS;
      break;
    case "batch":
      variantFields = SUBJECT_BATCH_FIELDS;
      break;
    case "custom":
      variantFields = SUBJECT_CUSTOM_FIELDS;
      break;
    default:
      fail(`${path}.type`, "unknown subject type; failing closed");
  }
  assertExactFieldSet(subject as object, variantFields, path);
  const s = subject as SubjectRef;
  assertNetworkId(s.networkId, `${path}.networkId`);
  switch (s.type) {
    case "transaction":
      assertNativeId(s.txId, `${path}.txId`);
      return;
    case "block":
      if (s.blockNumber !== undefined) assertBlockNumber(s.blockNumber, `${path}.blockNumber`);
      if (s.blockId !== undefined) assertNativeId(s.blockId, `${path}.blockId`);
      return;
    case "batch":
      // Family-native identifier: the specialized NativeId validator, not a
      // looser ad-hoc string check.
      assertNativeId(s.batchId, `${path}.batchId`);
      return;
    case "custom":
      if (typeof s.namespace !== "string" || !NATIVE_NAMESPACE_PATTERN.test(s.namespace)) {
        fail(`${path}.namespace`, 'must match ^[a-z0-9][a-z0-9._-]{0,63}$');
      }
      assertNativeId(s.value, `${path}.value`);
      return;
    default:
      fail(`${path}.type`, "unknown subject type; failing closed");
  }
}

export function validateResolverManifestRef(ref: unknown, path = "resolver"): void {
  assertExactContractObject(ref, ID_VERSION_DIGEST_FIELDS, path);
  const r = ref as ResolverManifestRef;
  assertNecIdentifier(r.id, `${path}.id`);
  assertNecIdentifier(r.version, `${path}.version`);
  assertDigestShape(r.digest, `${path}.digest`);
}

export function validateResolverManifest(manifest: unknown, path = "manifest"): void {
  assertExactContractObject(manifest, RESOLVER_MANIFEST_FIELDS, path);
  const m = manifest as ResolverManifest;
  assertNecIdentifier(m.id, `${path}.id`);
  assertNecIdentifier(m.version, `${path}.version`);
  assertDigestShape(m.digest, `${path}.digest`);
  assertStringArrayUnique(m.networkFamilies, `${path}.networkFamilies`);
  assertExactContractObject(m.implementation, IMPLEMENTATION_FIELDS, `${path}.implementation`);
  optionalIdentifier(m.implementation.package, `${path}.implementation.package`);
  optionalIdentifier(m.implementation.commit, `${path}.implementation.commit`);
  assertEnumArrayUnique(isCapabilityName, CAPABILITY_NAMES, m.supportedCapabilities, `${path}.supportedCapabilities`);
  assertInertArray(m.sourceRequirements, `${path}.sourceRequirements`);
  const seenSourceTypes = new Set<string>();
  for (let i = 0; i < m.sourceRequirements.length; i++) {
    const req = m.sourceRequirements[i]!;
    const reqPath = `${path}.sourceRequirements[${i}]`;
    assertExactContractObject(req, SOURCE_REQUIREMENT_FIELDS, reqPath);
    // NEC-owned source-type identifier: the SPECIALIZED frozen-grammar
    // validator (`[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}`), never a looser
    // ad-hoc string check. Network-NATIVE identifiers stay on NativeId.
    assertNecIdentifier(req.sourceType, `${reqPath}.sourceType`);
    assertBoolean(req.required, `${reqPath}.required`);
    if (seenSourceTypes.has(req.sourceType)) {
      fail(reqPath, `duplicate sourceType ${JSON.stringify(req.sourceType)} in set-like collection`);
    }
    seenSourceTypes.add(req.sourceType);
  }
  optionalRecord(m.metadata, `${path}.metadata`);
  // Self-digest enforcement: manifest.digest must bind its own content.
  const computed = computeResolverManifestDigest(m);
  if (m.digest !== computed) {
    fail(`${path}.digest`, "self-digest mismatch: recomputed resolver-manifest digest differs");
  }
}

export function validateCapabilityState(state: unknown, path = "capabilityState"): void {
  assertExactContractObject(state, CAPABILITY_STATE_FIELDS, path);
  const s = state as Record<string, unknown>;
  assertEnum(isCapabilitySupport, s.support, `${path}.support`, CAPABILITY_SUPPORTS);
  assertEnum(
    isCapabilityAvailability,
    s.availability,
    `${path}.availability`,
    CAPABILITY_AVAILABILITIES,
  );
  optionalFreeText(s.reason, `${path}.reason`);
  if (s.evidence !== undefined) assertEvidenceIdArray(s.evidence, `${path}.evidence`);
  optionalRecord(s.metadata, `${path}.metadata`);
}

export function validateEvidenceCapabilitySet(set: unknown, path = "evidenceCapabilities"): void {
  assertExactContractObject(set, EVIDENCE_CAPABILITY_SET_FIELDS, path);
  for (const key of ["execution", "observedEffects", "dataBinding", "settlement", "finality"]) {
    validateCapabilityState((set as Record<string, unknown>)[key], `${path}.${key}`);
  }
}

export function validateExecutionCapabilitySet(set: unknown, path = "executionCapabilities"): void {
  assertExactContractObject(set, EXECUTION_CAPABILITY_SET_FIELDS, path);
  for (const key of ["executionModel", "accountModel", "gasModel", "simulation", "batching"]) {
    const state = (set as Record<string, unknown>)[key];
    if (state !== undefined) validateCapabilityState(state, `${path}.${key}`);
  }
}

export function validateCapabilitySnapshotRef(ref: unknown, path = "capabilitySnapshot"): void {
  assertExactContractObject(ref, ID_DIGEST_FIELDS, path);
  const r = ref as { id: string; digest: string };
  assertNecIdentifier(r.id, `${path}.id`);
  assertDigestShape(r.digest, `${path}.digest`);
}

export function validateCapabilitySnapshot(snapshot: unknown, path = "snapshot"): void {
  assertExactContractObject(snapshot, CAPABILITY_SNAPSHOT_FIELDS, path);
  const s = snapshot as Record<string, unknown>;
  assertSchemaVersion(s.schemaVersion, `${path}.schemaVersion`);
  assertNecIdentifier(s.id, `${path}.id`);
  assertIso8601(s.generatedAt, `${path}.generatedAt`);
  validateNetworkFingerprint(s.network, `${path}.network`);
  validateEvidenceCapabilitySet(s.evidenceCapabilities, `${path}.evidenceCapabilities`);
  validateExecutionCapabilitySet(s.executionCapabilities, `${path}.executionCapabilities`);
  const known = assertEvidenceTable(s.evidence, `${path}.evidence`);
  for (const key of ["execution", "observedEffects", "dataBinding", "settlement", "finality"]) {
    const state = (s.evidenceCapabilities as Record<string, { evidence?: string[] }>)[key]!;
    assertResolvable(state.evidence, `${path}.evidenceCapabilities.${key}.evidence`, known);
  }
  for (const key of ["executionModel", "accountModel", "gasModel", "simulation", "batching"]) {
    const state = (s.executionCapabilities as Record<string, { evidence?: string[] } | undefined>)[key];
    if (state?.evidence !== undefined) {
      assertResolvable(state.evidence, `${path}.executionCapabilities.${key}.evidence`, known);
    }
  }
  validateResolverManifestRef(s.resolver, `${path}.resolver`);
  assertDigestShape(s.artifactDigest, `${path}.artifactDigest`);
  const computed = computeCapabilitySnapshotDigest(snapshot as never);
  if (s.artifactDigest !== computed) {
    fail(`${path}.artifactDigest`, "self-digest mismatch: recomputed capability-snapshot digest differs");
  }
}

export function validateCapabilityRequirement(requirement: unknown, path = "requirement"): void {
  assertExactContractObject(requirement, CAPABILITY_REQUIREMENT_FIELDS, path);
  const r = requirement as CapabilityRequirement;
  // CLOSED capability vocabulary: arbitrary capability strings fail closed.
  assertEnum(isCapabilityName, r.capability, `${path}.capability`, CAPABILITY_NAMES);
  if (r.strength !== "required" && r.strength !== "desired") {
    fail(`${path}.strength`, 'must be "required" or "desired"');
  }
  // R3: `constraints` is not part of the v0.1 contract; the exact field set
  // above rejects it as an UNKNOWN field (fail closed, never inert).
}

export function validateDiscoveryRequirements(requirements: unknown, path = "request"): void {
  assertExactContractObject(requirements, DISCOVERY_REQUIREMENTS_FIELDS, path);
  const r = requirements as Record<string, unknown>;
  assertInertArray(r.requirements, `${path}.requirements`);
  const canonicalForms = new Set<string>();
  for (let i = 0; i < r.requirements.length; i++) {
    const requirement = r.requirements[i];
    validateCapabilityRequirement(requirement, `${path}.requirements[${i}]`);
    const form = canonicalJson(requirement);
    if (canonicalForms.has(form)) {
      fail(`${path}.requirements[${i}]`, "duplicate requirement in set-like collection");
    }
    canonicalForms.add(form);
  }
  if (r.networkAllowlist !== undefined) assertNetworkIdArrayUnique(r.networkAllowlist, `${path}.networkAllowlist`);
  if (r.networkDenylist !== undefined) assertNetworkIdArrayUnique(r.networkDenylist, `${path}.networkDenylist`);
  optionalRecord(r.metadata, `${path}.metadata`);
}

export function validateRequirementEvaluation(evaluation: unknown, path = "evaluation"): void {
  assertExactContractObject(evaluation, REQUIREMENT_EVALUATION_FIELDS, path);
  const e = evaluation as Record<string, unknown>;
  validateCapabilityRequirement(e.requirement, `${path}.requirement`);
  if (e.status !== "satisfied" && e.status !== "unsatisfied" && e.status !== "unknown") {
    fail(`${path}.status`, 'must be "satisfied", "unsatisfied" or "unknown"');
  }
  optionalFreeText(e.reason, `${path}.reason`);
  if (e.evidence !== undefined) assertEvidenceIdArray(e.evidence, `${path}.evidence`);
}

function assertEvidenceTable(value: unknown, path: string): ReadonlySet<string> {
  assertInertArray(value, path);
  const ids = new Set<string>();
  for (let i = 0; i < value.length; i++) {
    validateEvidenceRef(value[i], `${path}[${i}]`);
    const id = (value[i] as EvidenceRef).id;
    if (ids.has(id)) fail(`${path}[${i}].id`, `duplicate evidence id ${JSON.stringify(id)}`);
    ids.add(id);
  }
  return ids;
}

function assertResolvable(ids: readonly string[] | undefined, path: string, known: ReadonlySet<string>): void {
  if (ids === undefined) return;
  for (const id of ids) {
    if (!known.has(id)) {
      fail(path, `dangling provenance: evidence id ${JSON.stringify(id)} has no EvidenceRef in the evidence table`);
    }
  }
}

export function validateNetworkDiscoveryMatch(match: unknown, path = "match"): void {
  assertExactContractObject(match, NETWORK_DISCOVERY_MATCH_FIELDS, path);
  const m = match as Record<string, unknown>;
  validateNetworkFingerprint(m.network, `${path}.network`);
  const classification = m.classification;
  if (classification !== "eligible" && classification !== "conditional" && classification !== "ineligible") {
    fail(`${path}.classification`, 'must be "eligible", "conditional" or "ineligible"');
  }
  assertInertArray(m.evaluations, `${path}.evaluations`);
  const evaluationForms = new Set<string>();
  for (let i = 0; i < m.evaluations.length; i++) {
    const evaluation = m.evaluations[i];
    validateRequirementEvaluation(evaluation, `${path}.evaluations[${i}]`);
    // Set-like identity is computed over the NORMALIZED projection so a
    // citation permutation of one evaluation cannot create a second
    // "distinct" evaluation.
    const form = canonicalJson(normalizedEvaluationIdentity(evaluation));
    if (evaluationForms.has(form)) {
      fail(`${path}.evaluations[${i}]`, "duplicate evaluation in set-like collection");
    }
    evaluationForms.add(form);
  }
  validateCapabilitySnapshotRef(m.capabilitySnapshot, `${path}.capabilitySnapshot`);
  const known = assertEvidenceTable(m.evidence, `${path}.evidence`);
  for (let i = 0; i < m.evaluations.length; i++) {
    assertResolvable(
      (m.evaluations[i] as { evidence?: string[] }).evidence,
      `${path}.evaluations[${i}].evidence`,
      known,
    );
  }
}

export function validateDiscoverNetworksResult(result: unknown, path = "discoveryResult"): void {
  assertExactContractObject(result, DISCOVER_NETWORKS_RESULT_FIELDS, path);
  const r = result as Record<string, unknown>;
  assertSchemaVersion(r.schemaVersion, `${path}.schemaVersion`);
  assertNecIdentifier(r.requestId, `${path}.requestId`);
  assertIso8601(r.generatedAt, `${path}.generatedAt`);
  validateDiscoveryRequirements(r.request, `${path}.request`);
  assertInertArray(r.matches, `${path}.matches`);
  const seenNetworks = new Set<string>();
  for (let i = 0; i < r.matches.length; i++) {
    const match = r.matches[i];
    validateNetworkDiscoveryMatch(match, `${path}.matches[${i}]`);
    const networkId = (match as { network: NetworkFingerprint }).network.networkId;
    if (seenNetworks.has(networkId)) {
      fail(`${path}.matches[${i}]`, `duplicate match for network ${JSON.stringify(networkId)}`);
    }
    seenNetworks.add(networkId);
    // Traceability: evaluations correspond 1:1 to the bound request's
    // requirements (same multiset, compared by canonical form).
    const requestRequirements = (r.request as { requirements: unknown[] }).requirements;
    const matchEvaluations = (match as { evaluations: Array<{ requirement: unknown }> }).evaluations;
    const a = requestRequirements.map((req) => canonicalJson(req)).sort();
    const b = matchEvaluations.map((evaluation) => canonicalJson(evaluation.requirement)).sort();
    if (a.length !== b.length || a.some((form, j) => form !== b[j])) {
      fail(`${path}.matches[${i}].evaluations`, "evaluations do not correspond 1:1 to the bound request requirements");
    }
  }
  assertDigestShape(r.artifactDigest, `${path}.artifactDigest`);
  const computed = computeDiscoverNetworksResultDigest(result as never);
  if (r.artifactDigest !== computed) {
    fail(`${path}.artifactDigest`, "self-digest mismatch: recomputed discovery-result digest differs");
  }
}

export function validateEvidencePolicy(policy: unknown, path = "policy"): void {
  assertExactContractObject(policy, EVIDENCE_POLICY_FIELDS, path);
  const p = policy as Record<string, unknown>;
  assertNecIdentifier(p.id, `${path}.id`);
  assertNecIdentifier(p.version, `${path}.version`);
  // CLOSED policy-dimension vocabulary: arbitrary dimensions fail closed.
  assertEnumArrayUnique(isPolicyDimension, POLICY_DIMENSIONS, p.requiredDimensions, `${path}.requiredDimensions`);
  if (p.desiredDimensions !== undefined) {
    assertEnumArrayUnique(isPolicyDimension, POLICY_DIMENSIONS, p.desiredDimensions, `${path}.desiredDimensions`);
  }
  optionalRecord(p.rules, `${path}.rules`);
  assertDigestShape(p.digest, `${path}.digest`);
  const computed = computeEvidencePolicyDigest(policy as never);
  if (p.digest !== computed) {
    fail(`${path}.digest`, "self-digest mismatch: recomputed evidence-policy digest differs");
  }
}

export function validateEvidencePolicyRef(ref: unknown, path = "policyRef"): void {
  assertExactContractObject(ref, ID_VERSION_DIGEST_FIELDS, path);
  const r = ref as Record<string, unknown>;
  assertNecIdentifier(r.id, `${path}.id`);
  assertNecIdentifier(r.version, `${path}.version`);
  assertDigestShape(r.digest, `${path}.digest`);
}

export function validateEvidenceSnapshotRef(ref: unknown, path = "snapshotRef"): void {
  assertExactContractObject(ref, ID_DIGEST_FIELDS, path);
  const r = ref as Record<string, unknown>;
  assertNecIdentifier(r.id, `${path}.id`);
  assertDigestShape(r.digest, `${path}.digest`);
}

export function validateActionDescriptor(action: unknown, path = "action"): void {
  assertExactContractObject(action, ACTION_DESCRIPTOR_FIELDS, path);
  const a = action as Record<string, unknown>;
  assertNecIdentifier(a.kind, `${path}.kind`);
  if (a.target !== undefined) assertNativeId(a.target, `${path}.target`);
  if (a.value !== undefined) assertNonEmptyString(a.value, `${path}.value`);
  if (a.fields !== undefined) assertPlainRecord(a.fields, `${path}.fields`);
}

export function validatePreflightRequest(request: unknown, path = "request"): void {
  assertExactContractObject(request, PREFLIGHT_REQUEST_FIELDS, path);
  const r = request as Record<string, unknown>;
  assertSchemaVersion(r.schemaVersion, `${path}.schemaVersion`);
  // THE preflight-request identity (NEC identifier grammar).
  assertNecIdentifier(r.requestId, `${path}.requestId`);
  assertNetworkId(r.networkId, `${path}.networkId`);
  if (r.account !== undefined) assertNativeId(r.account, `${path}.account`);
  validateActionDescriptor(r.action, `${path}.action`);
  validateEvidencePolicy(r.evidencePolicy, `${path}.evidencePolicy`);
  optionalRecord(r.metadata, `${path}.metadata`);
}

export function validateReadinessCheck(check: unknown, path = "readinessCheck"): void {
  assertExactContractObject(check, READINESS_CHECK_FIELDS, path);
  const c = check as ReadinessCheck & Record<string, unknown>;
  if (c.status !== "ready" && c.status !== "blocked" && c.status !== "unknown" && c.status !== "not_applicable") {
    fail(`${path}.status`, 'must be "ready", "blocked", "unknown" or "not_applicable"');
  }
  optionalFreeText(c.reason, `${path}.reason`);
  if (c.evidence !== undefined) assertEvidenceIdArray(c.evidence, `${path}.evidence`);
  optionalRecord(c.metadata, `${path}.metadata`);
}

function assertReadinessTable(table: unknown, path: string, keys: readonly string[]): Record<string, ReadinessCheck> {
  assertExactContractObject(table, F(keys), path);
  const out: Record<string, ReadinessCheck> = {};
  const record = table as Record<string, unknown>;
  for (const key of keys) {
    validateReadinessCheck(record[key], `${path}.${key}`);
    out[key] = record[key] as ReadinessCheck;
  }
  return out;
}

export function validatePreflightResult(result: unknown, path = "preflightResult"): void {
  assertExactContractObject(result, PREFLIGHT_RESULT_FIELDS, path);
  const r = result as Record<string, unknown>;
  assertSchemaVersion(r.schemaVersion, `${path}.schemaVersion`);
  assertIso8601(r.generatedAt, `${path}.generatedAt`);
  // FROZEN three-state status (R3): "partial" no longer exists.
  const status = r.status;
  if (status !== "ready" && status !== "blocked" && status !== "unknown") {
    fail(`${path}.status`, 'must be "ready", "blocked" or "unknown"');
  }
  validateNetworkFingerprint(r.network, `${path}.network`);
  validatePreflightRequest(r.request, `${path}.request`);
  // Surface continuity: the result answers exactly the bound request.
  if (
    (r.network as NetworkFingerprint).networkId !==
    (r.request as PreflightRequest).networkId
  ) {
    fail(
      `${path}.network.networkId`,
      "does not equal the preflight request networkId (deterministic binding)",
    );
  }

  const evidenceChecks = assertReadinessTable(
    r.evidenceReadiness,
    `${path}.evidenceReadiness`,
    ["execution", "observedEffects", "dataBinding", "settlement", "finality"],
  ) as PreflightResult["evidenceReadiness"];

  assertInertArray(r.blockers, `${path}.blockers`);
  const blockerForms = new Set<string>();
  for (let i = 0; i < r.blockers.length; i++) {
    const blocker = r.blockers[i];
    assertExactContractObject(blocker, PREFLIGHT_BLOCKER_FIELDS, `${path}.blockers[${i}]`);
    assertNecIdentifier((blocker as { code: string }).code, `${path}.blockers[${i}].code`);
    assertNonEmptyString((blocker as { reason: string }).reason, `${path}.blockers[${i}].reason`);
    const form = canonicalJson(blocker);
    if (blockerForms.has(form)) fail(`${path}.blockers[${i}]`, "duplicate blocker in set-like collection");
    blockerForms.add(form);
  }

  assertInertArray(r.warnings, `${path}.warnings`);
  const warningForms = new Set<string>();
  for (let i = 0; i < r.warnings.length; i++) {
    const item = r.warnings[i];
    validateWarning(item, `${path}.warnings[${i}]`);
    // Identity over the NORMALIZED projection: a citation permutation of the
    // same warning is the same set-like entry (duplicate), not a new warning.
    const form = canonicalJson(normalizedWarningIdentity(item as Warning));
    if (warningForms.has(form)) fail(`${path}.warnings[${i}]`, "duplicate warning in set-like collection");
    warningForms.add(form);
  }

  const known = assertEvidenceTable(r.evidence, `${path}.evidence`);
  for (const [key, check] of Object.entries(evidenceChecks)) {
    assertResolvable(check.evidence, `${path}.evidenceReadiness.${key}.evidence`, known);
  }
  for (let i = 0; i < (r.warnings as Warning[]).length; i++) {
    assertResolvable((r.warnings as Warning[])[i]!.evidence, `${path}.warnings[${i}].evidence`, known);
  }

  // Policy binding: the embedded ref must exactly match the embedded request policy.
  const requestPolicy = (r.request as { evidencePolicy: Record<string, unknown> }).evidencePolicy;
  const policyRef = r.evidencePolicy as Record<string, unknown>;
  assertExactContractObject(policyRef, ID_VERSION_DIGEST_FIELDS, `${path}.evidencePolicy`);
  for (const key of ["id", "version", "digest"] as const) {
    if (policyRef[key] !== requestPolicy[key]) {
      fail(`${path}.evidencePolicy.${key}`, "does not match the bound preflight request policy");
    }
  }
  validateResolverManifestRef(r.resolver, `${path}.resolver`);
  if (r.capabilitySnapshot !== undefined) {
    validateCapabilitySnapshotRef(r.capabilitySnapshot, `${path}.capabilitySnapshot`);
  }

  // Deterministic POLICY-AWARE three-state composition; the stored status
  // is NEVER caller-authored truth.
  const composed = composePreflightStatus({
    evidenceReadiness: evidenceChecks,
    blockers: r.blockers as PreflightResult["blockers"],
    requiredDimensions: requestPolicy.requiredDimensions as PolicyDimension[],
  });
  if (status !== composed) {
    fail(
      `${path}.status`,
      `non-deterministic status ${JSON.stringify(status)}; composition requires ${JSON.stringify(composed)}`,
    );
  }

  assertDigestShape(r.artifactDigest, `${path}.artifactDigest`);
  const computed = computePreflightResultDigest(result as never);
  if (r.artifactDigest !== computed) {
    fail(`${path}.artifactDigest`, "self-digest mismatch: recomputed preflight-result digest differs");
  }
}

export function validateEvidenceAnchor(anchor: unknown, path = "anchor"): void {
  assertExactContractObject(anchor, EVIDENCE_ANCHOR_FIELDS_CONTRACT, path);
  assertNetworkId((anchor as EvidenceAnchor).networkId, `${path}.networkId`);
  assertAnchorValueFields(anchor as EvidenceAnchor, path);
  // Anchor roles are NEC-owned identifiers (frozen grammar).
  if ((anchor as EvidenceAnchor).role !== undefined) {
    assertNecIdentifier((anchor as EvidenceAnchor).role, `${path}.role`);
  }
}

export function validateEvidenceSnapshot(snapshot: unknown, path = "snapshot"): void {
  assertExactContractObject(snapshot, EVIDENCE_SNAPSHOT_FIELDS, path);
  const s = snapshot as EvidenceSnapshot;
  assertNecIdentifier(s.id, `${path}.id`);
  assertDigestShape(s.digest, `${path}.digest`);
  assertIso8601(s.createdAt, `${path}.createdAt`);
  validateNetworkFingerprint(s.networkFingerprint, `${path}.networkFingerprint`);
  assertInertArray(s.anchors, `${path}.anchors`);
  const anchorForms = new Set<string>();
  for (let i = 0; i < s.anchors.length; i++) {
    const anchor = s.anchors[i];
    validateEvidenceAnchor(anchor, `${path}.anchors[${i}]`);
    const form = canonicalJson(anchor);
    if (anchorForms.has(form)) fail(`${path}.anchors[${i}]`, "duplicate anchor in set-like collection");
    anchorForms.add(form);
  }
  assertEvidenceTable(s.evidence, `${path}.evidence`);
  assertDigestShape(s.resolverManifestDigest, `${path}.resolverManifestDigest`);
  assertDigestShape(s.policyDigest, `${path}.policyDigest`);
  const computed = computeEvidenceSnapshotDigest(s);
  if (s.digest !== computed) {
    fail(`${path}.digest`, "self-digest mismatch: recomputed evidence-snapshot digest differs");
  }
}

// ---------------------------------------------------------------------------
// NetworkEvidenceResult — normative state machine + referential integrity
// ---------------------------------------------------------------------------

/**
 * Validate a full `NetworkEvidenceResult` (fail closed):
 *
 *   I0. Exact v0.1 field sets recursively, plain data everywhere.
 *   I1. Normative state machine per applicable proposition:
 *       applicable -> verdict required; not_applicable/unknown -> verdict
 *       absent; supported/contradicted -> non-empty basis/evidence AND NO
 *       material conflict scoped to the proposition (result-scoped included);
 *       ambiguous -> non-empty basis/evidence AND >= 1 material conflict
 *       scoped to the proposition (result-scoped counts); insufficient ->
 *       NO material conflict affecting the proposition either (a material
 *       unresolved conflict forces AMBIGUOUS and can coexist with no other
 *       verdict).
 *   I2. Explicit conflict scopes: observed_effect scopes must reference an
 *       existing observed effect; dimension scopes must name a real
 *       dimension. Scope is NEVER inferred from EvidenceIds.
 *   I3. No dangling provenance: every cited EvidenceId resolves in
 *       result.evidence; duplicate ids rejected everywhere.
 *   I4. Bound request reference consistent with requestId; both digests
 *       verify against their recomputed values.
 */
export function validateNetworkEvidenceResult(result: unknown): void {
  validateNetworkEvidenceResultStructureInternal(result);
  // Digest verification over fully validated structure.
  const r = result as NetworkEvidenceResult & Record<string, unknown>;
  const semanticComputed = computeNetworkEvidenceResultSemanticDigest(r);
  if (r.semanticDigest !== semanticComputed) {
    fail("semanticDigest", "self-digest mismatch: recomputed semantic digest differs");
  }
  const artifactComputed = computeNetworkEvidenceResultArtifactDigest(r);
  if (r.artifactDigest !== artifactComputed) {
    fail("artifactDigest", "self-digest mismatch: recomputed artifact digest differs");
  }
}

/**
 * Structural pass WITHOUT self-digest verification: used by builders, which
 * must be able to validate a placeholder-draft before they can compute the
 * real digests.
 */
export function validateNetworkEvidenceResultStructureInternal(result: unknown): void {
  assertExactContractObject(result, NETWORK_EVIDENCE_RESULT_FIELDS, "result");
  const r = result as NetworkEvidenceResult & Record<string, unknown>;
  assertSchemaVersion(r.schemaVersion, "schemaVersion");
  assertNecIdentifier(r.requestId, "requestId");
  assertIso8601(r.generatedAt, "generatedAt");
  // Bound-request reference: digest-qualified and consistent with the
  // top-level requestId (request substitution fails closed).
  assertExactContractObject(r.request, REQUEST_ID_DIGEST_FIELDS, "request");
  assertNecIdentifier(r.request.requestId, "request.requestId");
  assertDigestShape(r.request.digest, "request.digest");
  if (r.request.requestId !== r.requestId) {
    fail(
      "request.requestId",
      "must equal the result requestId (the bound EvidenceRequest is this result's request)",
    );
  }
  // R3: the COMPLETE expected ActionDescriptor is a semantic result field.
  validateActionDescriptor(r.action, "action");
  validateNetworkFingerprint(r.network, "network");
  validateSubjectRef(r.subject, "subject");

  assertExactContractObject(r.policy, ID_VERSION_DIGEST_FIELDS, "policy");
  // Nested refs inside NetworkEvidenceResult use the SPECIALIZED ref
  // validators (NEC identifier grammar on id/version + digest shape) —
  // never duplicated ad-hoc checks.
  validateEvidencePolicyRef(r.policy, "policy");
  assertExactContractObject(r.snapshot, ID_DIGEST_FIELDS, "snapshot");
  validateEvidenceSnapshotRef(r.snapshot, "snapshot");

  assertExactContractObject(r.networkEvidence, NETWORK_EVIDENCE_CONTAINER_FIELDS, "networkEvidence");
  const dimensions: Array<[string, EvidenceDimension]> = [
    ["execution", r.networkEvidence.execution],
    ["dataBinding", r.networkEvidence.dataBinding],
    ["settlement", r.networkEvidence.settlement],
    ["finality", r.networkEvidence.finality],
  ];
  for (const [name, dim] of dimensions) {
    if (dim === null || typeof dim !== "object") fail(`networkEvidence.${name}`, "must be an object");
    validateEvidenceDimension(dim, `networkEvidence.${name}`);
  }
  assertInertArray(r.networkEvidence.observedEffects, "networkEvidence.observedEffects");
  const effectIds = new Set<string>();
  for (let i = 0; i < r.networkEvidence.observedEffects.length; i++) {
    const effect = r.networkEvidence.observedEffects[i]!;
    validateObservedEffect(effect, `networkEvidence.observedEffects[${i}]`);
    if (effectIds.has(effect.id)) {
      fail(`networkEvidence.observedEffects[${i}].id`, `duplicate observed-effect id ${JSON.stringify(effect.id)}`);
    }
    effectIds.add(effect.id);
  }

  const knownEvidence = assertEvidenceTable(r.evidence, "evidence");

  // Dimension citations are provenance and must resolve too.
  for (const [name, dim] of dimensions) {
    assertResolvable(dim.evidence, `networkEvidence.${name}.evidence`, knownEvidence);
  }

  assertInertArray(r.conflicts, "conflicts");
  const conflictIds = new Set<string>();
  for (let i = 0; i < r.conflicts.length; i++) {
    const conflict = r.conflicts[i]!;
    validateConflict(conflict, `conflicts[${i}]`);
    if (conflictIds.has(conflict.id)) {
      fail(`conflicts[${i}].id`, `duplicate conflict id ${JSON.stringify(conflict.id)}`);
    }
    conflictIds.add(conflict.id);
    assertResolvable(conflict.evidence, `conflicts[${i}].evidence`, knownEvidence);
    // Explicit scope referential integrity.
    if (conflict.scope.kind === "observed_effect" && !effectIds.has(conflict.scope.effectId)) {
      fail(
        `conflicts[${i}].scope.effectId`,
        `scoped observed effect ${JSON.stringify(conflict.scope.effectId)} does not exist in networkEvidence.observedEffects`,
      );
    }
  }
  assertInertArray(r.warnings, "warnings");
  const warningForms = new Set<string>();
  for (let i = 0; i < r.warnings.length; i++) {
    const item = r.warnings[i]!;
    validateWarning(item, `warnings[${i}]`);
    // Identity over the NORMALIZED projection: a citation permutation of the
    // same warning is the same set-like entry (duplicate), not a new warning.
    const form = canonicalJson(normalizedWarningIdentity(item));
    if (warningForms.has(form)) fail(`warnings[${i}]`, "duplicate warning in set-like collection");
    warningForms.add(form);
    assertResolvable(item.evidence, `warnings[${i}].evidence`, knownEvidence);
  }

  for (let i = 0; i < r.networkEvidence.observedEffects.length; i++) {
    assertResolvable(
      r.networkEvidence.observedEffects[i]!.evidence,
      `networkEvidence.observedEffects[${i}].evidence`,
      knownEvidence,
    );
  }

  validateResolverManifestRef(r.resolver, "resolver");
  assertDigestShape(r.semanticDigest, "semanticDigest");
  assertDigestShape(r.artifactDigest, "artifactDigest");

  enforceVerdictStateMachine(r, dimensions);
}

function materialConflictsAffecting(
  conflicts: readonly Conflict[],
  scope: PropositionScope,
): Conflict[] {
  return conflicts.filter(
    (conflict) => conflict.material && conflictAffectsProposition(conflict.scope, scope),
  );
}

/**
 * THE normative verdict state machine for full artifacts — delegated to the
 * SAME shared helper used by the composer (`assertNormativePropositionState`);
 * there is no separate shadow truth table.
 */
function enforceVerdictStateMachine(
  result: NetworkEvidenceResult,
  dimensions: Array<[string, EvidenceDimension]>,
): void {
  for (const [name, dim] of dimensions) {
    const scope: PropositionScope = { kind: "dimension", dimension: name as never };
    const affecting = materialConflictsAffecting(result.conflicts, scope);
    assertNormativePropositionState(dim, affecting, `networkEvidence.${name}`);
  }
}

// ---------------------------------------------------------------------------
// Resolve request / resolver context / fragments
// ---------------------------------------------------------------------------

export function validateEvidenceRequest(request: unknown, path = "request"): void {
  assertExactContractObject(request, EVIDENCE_REQUEST_FIELDS, path);
  const r = request as Record<string, unknown>;
  assertSchemaVersion(r.schemaVersion, `${path}.schemaVersion`);
  assertNecIdentifier(r.requestId, `${path}.requestId`);
  assertNetworkId(r.networkId, `${path}.networkId`);
  validateSubjectRef(r.subject, `${path}.subject`);
  if ((r.subject as SubjectRef).networkId !== r.networkId) {
    fail(`${path}.subject.networkId`, "must equal the request networkId (deterministic binding)");
  }
  // R3 action continuity input: the COMPLETE expected ActionDescriptor.
  validateActionDescriptor(r.action, `${path}.action`);
  validateEvidencePolicy(r.evidencePolicy, `${path}.evidencePolicy`);
  if (r.preflight !== undefined) {
    // Preflight references are REQUEST-id + artifact-digest qualified.
    assertExactContractObject(r.preflight, REQUEST_ID_DIGEST_FIELDS, `${path}.preflight`);
    assertNecIdentifier((r.preflight as { requestId: string }).requestId, `${path}.preflight.requestId`);
    assertDigestShape((r.preflight as { digest: string }).digest, `${path}.preflight.digest`);
  }
  optionalRecord(r.metadata, `${path}.metadata`);
}

export function validateResolverContext(context: unknown, path = "context"): void {
  assertExactContractObject(context, RESOLVER_CONTEXT_FIELDS, path);
  const c = context as Record<string, unknown>;
  assertIso8601(c.now, `${path}.now`);
  assertPlainRecord(c.sourceConfig, `${path}.sourceConfig`);
}

/** Exact allowed keys of a PARTIAL readiness table (fragments). */
function assertPartialRecordKeys(
  value: object,
  allowed: readonly string[],
  path: string,
): void {
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
  const extras: string[] = [];
  for (const key of Object.keys(descriptors)) {
    if (!allowed.includes(key)) extras.push(key);
  }
  if (extras.length > 0) {
    fail(
      path,
      `unknown key(s) ${extras.map((k) => JSON.stringify(k)).join(", ")}; partial records still have an EXACT allowed key set`,
    );
  }
}

export function validatePreflightFragment(fragment: unknown, path = "fragment"): void {
  assertExactContractObject(fragment, PREFLIGHT_FRAGMENT_FIELDS, path);
  const f = fragment as Record<string, unknown>;
  validateNetworkFingerprint(f.network, `${path}.network`);
  // Partial records still have an EXACT allowed key set: unknown keys fail
  // closed instead of silently bypassing validation.
  const EVIDENCE_READINESS_KEYS = ["execution", "observedEffects", "dataBinding", "settlement", "finality"];
  const evidenceChecks = f.evidenceReadiness as Record<string, unknown>;
  assertPlainDataContractObject(evidenceChecks, `${path}.evidenceReadiness`);
  assertPartialRecordKeys(evidenceChecks, EVIDENCE_READINESS_KEYS, `${path}.evidenceReadiness`);
  for (const key of EVIDENCE_READINESS_KEYS) {
    if (Object.prototype.hasOwnProperty.call(evidenceChecks, key)) {
      validateReadinessCheck(evidenceChecks[key], `${path}.evidenceReadiness.${key}`);
    }
  }
  assertInertArray(f.blockers, `${path}.blockers`);
  const blockerForms = new Set<string>();
  for (let i = 0; i < f.blockers.length; i++) {
    const blocker = f.blockers[i];
    assertExactContractObject(blocker, PREFLIGHT_BLOCKER_FIELDS, `${path}.blockers[${i}]`);
    assertNecIdentifier((blocker as { code: string }).code, `${path}.blockers[${i}].code`);
    assertNonEmptyString((blocker as { reason: string }).reason, `${path}.blockers[${i}].reason`);
    const form = canonicalJson(blocker);
    if (blockerForms.has(form)) fail(`${path}.blockers[${i}]`, "duplicate blocker in set-like collection");
    blockerForms.add(form);
  }
  assertInertArray(f.warnings, `${path}.warnings`);
  const warningForms = new Set<string>();
  for (let i = 0; i < (f.warnings as Warning[]).length; i++) {
    const item = (f.warnings as Warning[])[i]!;
    validateWarning(item, `${path}.warnings[${i}]`);
    const form = canonicalJson(normalizedWarningIdentity(item));
    if (warningForms.has(form)) fail(`${path}.warnings[${i}]`, "duplicate warning in set-like collection");
    warningForms.add(form);
  }
  const known = assertEvidenceTable(f.evidence, `${path}.evidence`);
  for (const [key, check] of Object.entries(evidenceChecks)) {
    assertResolvable((check as { evidence?: string[] }).evidence, `${path}.${key}.evidence`, known);
  }
  for (let i = 0; i < (f.warnings as Warning[]).length; i++) {
    assertResolvable((f.warnings as Warning[])[i]!.evidence, `${path}.warnings[${i}].evidence`, known);
  }
}

export function validateNetworkEvidenceFragment(fragment: unknown, path = "fragment"): void {
  assertExactContractObject(fragment, NETWORK_EVIDENCE_FRAGMENT_FIELDS, path);
  const f = fragment as Record<string, unknown>;
  validateNetworkFingerprint(f.network, `${path}.network`);
  validateSubjectRef(f.subject, `${path}.subject`);
  // Subject/network consistency wherever the fragment carries both.
  if ((f.subject as SubjectRef).networkId !== (f.network as NetworkFingerprint).networkId) {
    fail(`${path}.subject.networkId`, "must equal the fragment networkId");
  }

  const ne = f.networkEvidence;
  assertPlainDataContractObject(ne, `${path}.networkEvidence`);
  const container = ne as Partial<NetworkEvidenceResult["networkEvidence"]> & Record<string, unknown>;
  assertPartialRecordKeys(
    ne as object,
    ["execution", "observedEffects", "dataBinding", "settlement", "finality"],
    `${path}.networkEvidence`,
  );
  const dimensions: Array<[string, EvidenceDimension]> = [];
  for (const name of ["execution", "dataBinding", "settlement", "finality"]) {
    if (Object.prototype.hasOwnProperty.call(container, name)) {
      validateEvidenceDimension(container[name], `${path}.networkEvidence.${name}`);
      dimensions.push([name, container[name] as EvidenceDimension]);
    }
  }
  const effectIds = new Set<string>();
  if (container.observedEffects !== undefined) {
    assertInertArray(container.observedEffects, `${path}.networkEvidence.observedEffects`);
    for (let i = 0; i < container.observedEffects.length; i++) {
      const effect = container.observedEffects[i]!;
      validateObservedEffect(effect, `${path}.networkEvidence.observedEffects[${i}]`);
      if (effectIds.has(effect.id)) {
        fail(`${path}.networkEvidence.observedEffects[${i}].id`, "duplicate observed-effect id");
      }
      effectIds.add(effect.id);
    }
  }

  const known = assertEvidenceTable(f.evidence, `${path}.evidence`);
  // Present dimension citations resolve against the fragment evidence table.
  for (const [name, dim] of dimensions) {
    assertResolvable(dim.evidence, `${path}.networkEvidence.${name}.evidence`, known);
  }
  if (container.observedEffects !== undefined) {
    for (let i = 0; i < container.observedEffects.length; i++) {
      assertResolvable(
        container.observedEffects[i]!.evidence,
        `${path}.networkEvidence.observedEffects[${i}].evidence`,
        known,
      );
    }
  }

  assertInertArray(f.conflicts, `${path}.conflicts`);
  const conflictIds = new Set<string>();
  for (let i = 0; i < (f.conflicts as Conflict[]).length; i++) {
    const conflict = (f.conflicts as Conflict[])[i]!;
    validateConflict(conflict, `${path}.conflicts[${i}]`);
    if (conflictIds.has(conflict.id)) fail(`${path}.conflicts[${i}].id`, "duplicate conflict id");
    conflictIds.add(conflict.id);
    assertResolvable(conflict.evidence, `${path}.conflicts[${i}].evidence`, known);
    if (conflict.scope.kind === "observed_effect" && !effectIds.has(conflict.scope.effectId)) {
      fail(
        `${path}.conflicts[${i}].scope.effectId`,
        "scoped observed effect does not exist in this fragment",
      );
    }
  }
  assertInertArray(f.warnings, `${path}.warnings`);
  const warningForms2 = new Set<string>();
  for (let i = 0; i < (f.warnings as Warning[]).length; i++) {
    const item = (f.warnings as Warning[])[i]!;
    validateWarning(item, `${path}.warnings[${i}]`);
    const form = canonicalJson(normalizedWarningIdentity(item));
    if (warningForms2.has(form)) fail(`${path}.warnings[${i}]`, "duplicate warning in set-like collection");
    warningForms2.add(form);
    assertResolvable(item.evidence, `${path}.warnings[${i}].evidence`, known);
  }

  // Same normative state machine inside fragments (fail closed) — the SAME
  // shared helper the composer and full-artifact validation use.
  for (const [name, dim] of dimensions) {
    if (dim.applicability !== "applicable") continue;
    const scope: PropositionScope = { kind: "dimension", dimension: name as never };
    const affecting = materialConflictsAffecting(f.conflicts as Conflict[], scope);
    assertNormativePropositionState(dim, affecting, `${path}.networkEvidence.${name}`);
  }
}
