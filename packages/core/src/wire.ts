import { NecValidationError } from "./errors.js";
import { NecWireError } from "./errors.js";
import { isWellFormedString, utf8ByteLength } from "./internal.js";
import { MAX_DECIMAL_INTEGER_DIGITS, RESOURCE_LIMITS } from "./limits.js";
import {
  validateCapabilitySnapshot,
  validateDiscoverNetworksResult,
  validateDiscoveryRequirements,
  validateEvidencePolicy,
  validateEvidenceRequest,
  validateEvidenceSnapshot,
  validateNetworkEvidenceFragment,
  validateNetworkEvidenceResult,
  validatePreflightFragment,
  validatePreflightRequest,
  validatePreflightResult,
  validateResolverManifest,
} from "./validate.js";
import type {
  CapabilitySnapshot,
  DiscoverNetworksResult,
  EvidencePolicy,
  EvidenceRequest,
  EvidenceSnapshot,
  NetworkEvidenceFragment,
  NetworkEvidenceResult,
  PreflightFragment,
  PreflightRequest,
  PreflightResult,
  ResolverManifest,
} from "./types.js";

/**
 * `nec-wire-json-v1` — the NEC WIRE profile. This is NOT
 * `nec-canonical-json-v1`: the canonical profile is the internal digest
 * input domain; the wire profile is the transport representation.
 *
 * Rules:
 *   - Schema-declared unbounded integer quantities (currently every
 *     `blockNumber`) are `bigint` at runtime and MUST be CANONICAL DECIMAL
 *     STRINGS on the wire ("5318"), never JSON numbers. ONE decimal-digit
 *     bound (`MAX_DECIMAL_INTEGER_DIGITS`) applies symmetrically to runtime
 *     validation, encode AND decode.
 *   - Decimal-string constraints: ASCII decimal digits only; no "+"; no
 *     whitespace; no exponent; no leading zeros except "0"; unsigned in
 *     v0.1 (no schema-declared signed quantities exist yet).
 *   - Generic metadata / generic ObservedEffect.fields are JSON-safe NEC
 *     values and NEVER contain bigint (rejected by validation in both
 *     representations).
 *   - Encoding/decoding is SCHEMA-AWARE: conversion happens exactly at
 *     schema-declared positions while walking the declared structure. There
 *     is deliberately NO global JSON replacer/reviver heuristic.
 *   - Schema membership uses OWN-PROPERTY checks only
 *     (`Object.prototype.hasOwnProperty.call`). A key named "constructor",
 *     "prototype" or "__proto__" can never satisfy a schema lookup through
 *     prototype-chain inheritance: unknown fields FAIL CLOSED, and valid
 *     own "__proto__" DATA round-trips byte-stably.
 *   - Inbound pipeline: JSON bytes -> strict wire parse (duplicate-key
 *     rejecting parser, resource bounds) -> wire validation -> schema-aware
 *     decimal string -> bigint conversion -> core validation.
 *   - Outbound pipeline: validated core artifact -> core validation ->
 *     schema-aware bigint -> decimal string -> standard JSON serialization.
 *     The ENCODER enforces the same `MAX_CANONICAL_BYTES` UTF-8 document
 *     budget as the raw parser, so encode -> decode symmetry can never be
 *     broken by an oversized emission.
 *   - Duplicate JSON-key rejection happens IN the strict parser below;
 *     standard `JSON.parse` silently keeps the last duplicate and cannot
 *     enforce this. Transports that parse JSON themselves MUST preserve
 *     this guarantee before handing documents to this profile. The hostile
 *     transport boundary is PARSED INERT DATA — this profile never inspects
 *     live caller Proxy objects trap-free, and callers must hand over plain
 *     parsed data.
 */

export const WIRE_PROFILE = "nec-wire-json-v1";

/** Maximum digits of a wire decimal integer (DoS bound; >= 2^3000). */
export const MAX_WIRE_DECIMAL_DIGITS = MAX_DECIMAL_INTEGER_DIGITS;

const DECIMAL_STRING_PATTERN = /^(0|[1-9][0-9]*)$/;

// ---------------------------------------------------------------------------
// Strict JSON parsing (RFC 8259 subset; duplicate keys fail closed)
// ---------------------------------------------------------------------------

interface ParseState {
  readonly source: string;
  pos: number;
  depth: number;
  nodes: number;
}

function parseFail(reason: string): never {
  throw new NecWireError("NEC_WIRE_MALFORMED_JSON", reason);
}

function skipWhitespace(state: ParseState): void {
  while (state.pos < state.source.length) {
    const c = state.source.charCodeAt(state.pos);
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) state.pos += 1;
    else break;
  }
}

function expect(state: ParseState, ch: string): void {
  if (state.pos >= state.source.length || state.source[state.pos] !== ch) {
    parseFail(`expected "${ch}" at offset ${state.pos}`);
  }
  state.pos += 1;
}

function parseString(state: ParseState): string {
  // assumes current char is '"'
  state.pos += 1;
  let out = "";
  for (;;) {
    if (state.pos >= state.source.length) parseFail("unterminated string");
    const c = state.source[state.pos];
    if (c === '"') {
      state.pos += 1;
      break;
    }
    // R3: enforce the announced string budget DURING parsing. UTF-8 bytes
    // are always >= UTF-16 code units, so exceeding the limit in code units
    // implies exceeding it in bytes; the exact UTF-8 length is verified at
    // string close. A hostile document can never accumulate an unbounded
    // string before rejection.
    if (out.length > RESOURCE_LIMITS.MAX_STRING_UTF8_BYTES) {
      parseFail(`string exceeds MAX_STRING_UTF8_BYTES (${RESOURCE_LIMITS.MAX_STRING_UTF8_BYTES})`);
    }
    if (c === "\\") {
      state.pos += 1;
      if (state.pos >= state.source.length) parseFail("unterminated escape");
      const esc = state.source[state.pos];
      switch (esc) {
        case '"':
          out += '"';
          break;
        case "\\":
          out += "\\";
          break;
        case "/":
          out += "/";
          break;
        case "b":
          out += "\b";
          break;
        case "f":
          out += "\f";
          break;
        case "n":
          out += "\n";
          break;
        case "r":
          out += "\r";
          break;
        case "t":
          out += "\t";
          break;
        case "u": {
          const hex = state.source.slice(state.pos + 1, state.pos + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) parseFail(`invalid \\u escape at offset ${state.pos}`);
          out += String.fromCharCode(parseInt(hex, 16));
          state.pos += 4;
          break;
        }
        default:
          parseFail(`invalid escape \\${esc} at offset ${state.pos}`);
      }
      state.pos += 1;
      continue;
    }
    if (c === undefined) parseFail("unterminated string");
    const code = c.charCodeAt(0);
    if (code < 0x20) parseFail(`raw control character in string at offset ${state.pos}`);
    out += c;
    state.pos += 1;
  }
  if (!isWellFormedString(out)) {
    parseFail("string contains an unpaired UTF-16 surrogate");
  }
  // Exact announced bound at string close.
  if (utf8ByteLength(out) > RESOURCE_LIMITS.MAX_STRING_UTF8_BYTES) {
    parseFail(`string exceeds MAX_STRING_UTF8_BYTES (${RESOURCE_LIMITS.MAX_STRING_UTF8_BYTES})`);
  }
  return out;
}

function parseNumber(state: ParseState): number {
  const start = state.pos;
  if (state.source[state.pos] === "-") state.pos += 1;
  const intStart = state.pos;
  if (state.source[state.pos] === "0") {
    state.pos += 1;
  } else if (/[1-9]/.test(state.source[state.pos] ?? "")) {
    while (/[0-9]/.test(state.source[state.pos] ?? "")) state.pos += 1;
  } else {
    parseFail(`invalid number at offset ${start}`);
  }
  if (state.source[intStart] === "-" && state.pos === intStart) {
    parseFail(`invalid number at offset ${start}`);
  }
  if (state.source[state.pos] === ".") {
    state.pos += 1;
    if (!/[0-9]/.test(state.source[state.pos] ?? "")) parseFail(`invalid fraction at offset ${state.pos}`);
    while (/[0-9]/.test(state.source[state.pos] ?? "")) state.pos += 1;
  }
  if (state.source[state.pos] === "e" || state.source[state.pos] === "E") {
    state.pos += 1;
    if (state.source[state.pos] === "+" || state.source[state.pos] === "-") state.pos += 1;
    if (!/[0-9]/.test(state.source[state.pos] ?? "")) parseFail(`invalid exponent at offset ${state.pos}`);
    while (/[0-9]/.test(state.source[state.pos] ?? "")) state.pos += 1;
  }
  const token = state.source.slice(start, state.pos);
  const value = Number(token);
  if (!Number.isFinite(value)) parseFail(`non-finite number "${token}"`);
  return value;
}

function enterValue(state: ParseState): void {
  state.nodes += 1;
  if (state.nodes > RESOURCE_LIMITS.MAX_TOTAL_NODES) {
    parseFail(`document exceeds MAX_TOTAL_NODES (${RESOURCE_LIMITS.MAX_TOTAL_NODES})`);
  }
}

function parseValue(state: ParseState): unknown {
  enterValue(state);
  state.depth += 1;
  if (state.depth > RESOURCE_LIMITS.MAX_DEPTH) {
    parseFail(`document exceeds MAX_DEPTH (${RESOURCE_LIMITS.MAX_DEPTH})`);
  }
  try {
    skipWhitespace(state);
    const c = state.source[state.pos];
    switch (c) {
      case '"':
        return parseString(state);
      case "{":
        return parseObject(state);
      case "[":
        return parseArray(state);
      case "t":
        expectWord(state, "true");
        return true;
      case "f":
        expectWord(state, "false");
        return false;
      case "n":
        expectWord(state, "null");
        return null;
      default:
        if (c === "-" || /[0-9]/.test(c ?? "")) return parseNumber(state);
        parseFail(`unexpected character ${JSON.stringify(c ?? "<eof>")} at offset ${state.pos}`);
    }
  } finally {
    state.depth -= 1;
  }
}

function expectWord(state: ParseState, word: string): void {
  if (state.source.slice(state.pos, state.pos + word.length) !== word) {
    parseFail(`invalid literal at offset ${state.pos}`);
  }
  state.pos += word.length;
}

function parseObject(state: ParseState): Record<string, unknown> {
  expect(state, "{");
  // Null prototype + explicit definition: an own key "__proto__" stays
  // ordinary DATA, exactly like JSON.parse semantics.
  const obj: Record<string, unknown> = Object.create(null);
  let entries = 0;
  skipWhitespace(state);
  if (state.source[state.pos] === "}") {
    state.pos += 1;
    return obj;
  }
  for (;;) {
    skipWhitespace(state);
    if (state.source[state.pos] !== '"') parseFail(`expected object key at offset ${state.pos}`);
    const key = parseString(state);
    skipWhitespace(state);
    expect(state, ":");
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      parseFail(`duplicate JSON key ${JSON.stringify(key)}; failing closed`);
    }
    const value = parseValue(state);
    Object.defineProperty(obj, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    // R3: enforce MAX_CONTAINER_ENTRIES DURING parsing — a hostile document
    // can never accumulate 10_001 members only to be rejected later in
    // typed decode.
    entries += 1;
    if (entries > RESOURCE_LIMITS.MAX_CONTAINER_ENTRIES) {
      parseFail(
        `object exceeds MAX_CONTAINER_ENTRIES (${RESOURCE_LIMITS.MAX_CONTAINER_ENTRIES})`,
      );
    }
    skipWhitespace(state);
    if (state.source[state.pos] === ",") {
      state.pos += 1;
      continue;
    }
    expect(state, "}");
    return obj;
  }
}

function parseArray(state: ParseState): unknown[] {
  expect(state, "[");
  const arr: unknown[] = [];
  skipWhitespace(state);
  if (state.source[state.pos] === "]") {
    state.pos += 1;
    return arr;
  }
  for (;;) {
    arr.push(parseValue(state));
    if (arr.length > RESOURCE_LIMITS.MAX_CONTAINER_ENTRIES) {
      parseFail(`array exceeds MAX_CONTAINER_ENTRIES (${RESOURCE_LIMITS.MAX_CONTAINER_ENTRIES})`);
    }
    skipWhitespace(state);
    if (state.source[state.pos] === ",") {
      state.pos += 1;
      continue;
    }
    expect(state, "]");
    return arr;
  }
}

/**
 * Strict wire JSON parse: RFC 8259 syntax, duplicate keys rejected,
 * unpaired surrogates rejected, resource bounds enforced. Standard
 * `JSON.parse` cannot enforce duplicate-key rejection — transports that
 * parse independently must match these guarantees.
 */
export function parseNecWireJson(text: string): unknown {
  if (typeof text !== "string") parseFail("wire document must be a string");
  if (utf8ByteLength(text) > RESOURCE_LIMITS.MAX_CANONICAL_BYTES) {
    parseFail(`document exceeds MAX_CANONICAL_BYTES (${RESOURCE_LIMITS.MAX_CANONICAL_BYTES})`);
  }
  const state: ParseState = { source: text, pos: 0, depth: 0, nodes: 0 };
  const value = parseValue(state);
  skipWhitespace(state);
  if (state.pos !== text.length) {
    parseFail(`trailing content at offset ${state.pos}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Declarative wire schemas (schema-aware conversion — no global replacer)
// ---------------------------------------------------------------------------

type FieldSchema =
  | { readonly kind: "bigint" }
  | { readonly kind: "string" }
  | { readonly kind: "boolean" }
  | { readonly kind: "number" }
  | { readonly kind: "json" }
  | { readonly kind: "array"; readonly items: FieldSchema }
  | {
      readonly kind: "object";
      readonly fields: Readonly<Record<string, FieldSchema>>;
      readonly optional: ReadonlySet<string>;
    }
  | {
      readonly kind: "union";
      readonly tag: string;
      readonly variants: Readonly<Record<string, FieldSchema>>;
    };

const STR: FieldSchema = { kind: "string" };
const BOOL: FieldSchema = { kind: "boolean" };
const NUM: FieldSchema = { kind: "number" };
const BIG: FieldSchema = { kind: "bigint" };
const JSON_SAFE: FieldSchema = { kind: "json" };
const arr = (items: FieldSchema): FieldSchema => ({ kind: "array", items });
const obj = (
  fields: Record<string, FieldSchema>,
  optional: readonly string[] = [],
): FieldSchema => ({ kind: "object", fields, optional: new Set(optional) });
const union = (tag: string, variants: Record<string, FieldSchema>): FieldSchema => ({
  kind: "union",
  tag,
  variants,
});

const NETWORK_ANCHOR = obj({ blockNumber: BIG, blockId: STR, timestamp: STR }, [
  "blockNumber",
  "blockId",
  "timestamp",
]);
const NATIVE_SOURCE = obj(
  {
    namespace: STR,
    mediaType: STR,
    encoding: STR,
    payload: STR,
    contentDigest: STR,
    schema: STR,
  },
  ["schema"],
);
const EVIDENCE_REF = obj(
  {
    id: STR,
    sourceId: STR,
    sourceType: STR,
    independenceGroup: STR,
    locator: STR,
    retrievedAt: STR,
    contentDigest: STR,
    networkId: STR,
    blockNumber: BIG,
    blockId: STR,
    metadata: JSON_SAFE,
    nativeSource: NATIVE_SOURCE,
  },
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
const EVIDENCE_DIMENSION = obj(
  {
    applicability: STR,
    verdict: STR,
    basis: arr(STR),
    evidence: arr(STR),
    reason: STR,
    metadata: JSON_SAFE,
  },
  ["verdict", "reason", "metadata"],
);
const OBSERVED_EFFECT = obj(
  {
    id: STR,
    type: STR,
    fields: JSON_SAFE,
    basis: arr(STR),
    evidence: arr(STR),
    metadata: JSON_SAFE,
  },
  ["metadata"],
);
const CONFLICT_SCOPE = union("kind", {
  result: obj({ kind: STR }),
  dimension: obj({ kind: STR, dimension: STR }),
  observed_effect: obj({ kind: STR, effectId: STR }),
  custom: obj({ kind: STR, namespace: STR, id: STR }),
});
const CONFLICT = obj(
  {
    id: STR,
    code: STR,
    description: STR,
    scope: CONFLICT_SCOPE,
    evidence: arr(STR),
    material: BOOL,
    metadata: JSON_SAFE,
  },
  ["metadata"],
);
const WARNING = obj(
  { code: STR, message: STR, evidence: arr(STR), metadata: JSON_SAFE },
  ["evidence", "metadata"],
);
const SUBJECT_REF = union("type", {
  transaction: obj({ type: STR, networkId: STR, txId: STR }),
  block: obj({ type: STR, networkId: STR, blockNumber: BIG, blockId: STR }, ["blockNumber", "blockId"]),
  batch: obj({ type: STR, networkId: STR, batchId: STR }),
  custom: obj({ type: STR, networkId: STR, namespace: STR, value: STR }),
});
const NETWORK_FINGERPRINT = obj(
  {
    networkId: STR,
    chainId: NUM,
    genesisId: STR,
    protocolVersion: STR,
    deploymentDigest: STR,
    observedAt: NETWORK_ANCHOR,
    metadata: JSON_SAFE,
  },
  ["chainId", "genesisId", "protocolVersion", "deploymentDigest", "metadata"],
);
const RESOLVER_MANIFEST_REF = obj({ id: STR, version: STR, digest: STR });
const ID_DIGEST_REF = obj({ id: STR, digest: STR });
const REQUEST_ID_DIGEST_REF = obj({ requestId: STR, digest: STR });
const CAPABILITY_STATE = obj(
  { support: STR, availability: STR, reason: STR, evidence: arr(STR), metadata: JSON_SAFE },
  ["reason", "evidence", "metadata"],
);
const RESOLVER_MANIFEST = obj(
  {
    id: STR,
    version: STR,
    digest: STR,
    networkFamilies: arr(STR),
    implementation: obj({ package: STR, commit: STR }, ["package", "commit"]),
    supportedCapabilities: arr(STR),
    sourceRequirements: arr(obj({ sourceType: STR, required: BOOL })),
    metadata: JSON_SAFE,
  },
  ["metadata"],
);

const EVIDENCE_POLICY = obj(
  {
    id: STR,
    version: STR,
    requiredDimensions: arr(STR),
    desiredDimensions: arr(STR),
    rules: JSON_SAFE,
    digest: STR,
  },
  ["desiredDimensions", "rules"],
);

const CAPABILITY_SNAPSHOT = obj({
  schemaVersion: STR,
  id: STR,
  generatedAt: STR,
  network: NETWORK_FINGERPRINT,
  evidenceCapabilities: obj({
    execution: CAPABILITY_STATE,
    observedEffects: CAPABILITY_STATE,
    dataBinding: CAPABILITY_STATE,
    settlement: CAPABILITY_STATE,
    finality: CAPABILITY_STATE,
  }),
  executionCapabilities: obj(
    {
      executionModel: CAPABILITY_STATE,
      accountModel: CAPABILITY_STATE,
      gasModel: CAPABILITY_STATE,
      simulation: CAPABILITY_STATE,
      batching: CAPABILITY_STATE,
    },
    ["executionModel", "accountModel", "gasModel", "simulation", "batching"],
  ),
  evidence: arr(EVIDENCE_REF),
  resolver: RESOLVER_MANIFEST_REF,
  artifactDigest: STR,
});

const CAPABILITY_REQUIREMENT = obj({ capability: STR, strength: STR });
const REQUIREMENT_EVALUATION = obj(
  { requirement: CAPABILITY_REQUIREMENT, status: STR, reason: STR, evidence: arr(STR) },
  ["reason", "evidence"],
);
const DISCOVERY_REQUIREMENTS = obj(
  {
    requirements: arr(CAPABILITY_REQUIREMENT),
    networkAllowlist: arr(STR),
    networkDenylist: arr(STR),
    metadata: JSON_SAFE,
  },
  ["networkAllowlist", "networkDenylist", "metadata"],
);
const DISCOVERY_RESULT = obj({
  schemaVersion: STR,
  requestId: STR,
  generatedAt: STR,
  request: DISCOVERY_REQUIREMENTS,
  matches: arr(
    obj({
      network: NETWORK_FINGERPRINT,
      classification: STR,
      evaluations: arr(REQUIREMENT_EVALUATION),
      capabilitySnapshot: ID_DIGEST_REF,
      evidence: arr(EVIDENCE_REF),
    }),
  ),
  artifactDigest: STR,
});

const READINESS_CHECK = obj(
  { status: STR, reason: STR, evidence: arr(STR), metadata: JSON_SAFE },
  ["reason", "evidence", "metadata"],
);
const ACTION_DESCRIPTOR = obj(
  { kind: STR, target: STR, value: STR, fields: JSON_SAFE },
  ["target", "value", "fields"],
);
const PREFLIGHT_REQUEST = obj(
  {
    schemaVersion: STR,
    requestId: STR,
    networkId: STR,
    account: STR,
    action: ACTION_DESCRIPTOR,
    evidencePolicy: EVIDENCE_POLICY,
    metadata: JSON_SAFE,
  },
  ["account", "metadata"],
);
const PREFLIGHT_RESULT = obj(
  {
    schemaVersion: STR,
    generatedAt: STR,
    status: STR,
    network: NETWORK_FINGERPRINT,
    request: PREFLIGHT_REQUEST,
    evidenceReadiness: obj({
      execution: READINESS_CHECK,
      observedEffects: READINESS_CHECK,
      dataBinding: READINESS_CHECK,
      settlement: READINESS_CHECK,
      finality: READINESS_CHECK,
    }),
    blockers: arr(obj({ code: STR, reason: STR })),
    warnings: arr(WARNING),
    evidence: arr(EVIDENCE_REF),
    evidencePolicy: RESOLVER_MANIFEST_REF,
    resolver: RESOLVER_MANIFEST_REF,
    capabilitySnapshot: ID_DIGEST_REF,
    artifactDigest: STR,
  },
  ["capabilitySnapshot"],
);

const EVIDENCE_SNAPSHOT = obj({
  id: STR,
  digest: STR,
  createdAt: STR,
  networkFingerprint: NETWORK_FINGERPRINT,
  anchors: arr(
    obj({ networkId: STR, blockNumber: BIG, blockId: STR, timestamp: STR, role: STR }, [
      "blockNumber",
      "blockId",
      "timestamp",
      "role",
    ]),
  ),
  evidence: arr(EVIDENCE_REF),
  resolverManifestDigest: STR,
  policyDigest: STR,
});

const NETWORK_EVIDENCE_RESULT = obj({
  schemaVersion: STR,
  requestId: STR,
  generatedAt: STR,
  request: REQUEST_ID_DIGEST_REF,
  action: ACTION_DESCRIPTOR,
  network: NETWORK_FINGERPRINT,
  subject: SUBJECT_REF,
  policy: RESOLVER_MANIFEST_REF,
  snapshot: ID_DIGEST_REF,
  networkEvidence: obj({
    execution: EVIDENCE_DIMENSION,
    observedEffects: arr(OBSERVED_EFFECT),
    dataBinding: EVIDENCE_DIMENSION,
    settlement: EVIDENCE_DIMENSION,
    finality: EVIDENCE_DIMENSION,
  }),
  evidence: arr(EVIDENCE_REF),
  conflicts: arr(CONFLICT),
  warnings: arr(WARNING),
  resolver: RESOLVER_MANIFEST_REF,
  semanticDigest: STR,
  artifactDigest: STR,
});

const EVIDENCE_REQUEST = obj(
  {
    schemaVersion: STR,
    requestId: STR,
    networkId: STR,
    subject: SUBJECT_REF,
    action: ACTION_DESCRIPTOR,
    evidencePolicy: EVIDENCE_POLICY,
    preflight: REQUEST_ID_DIGEST_REF,
    metadata: JSON_SAFE,
  },
  ["preflight", "metadata"],
);

const PREFLIGHT_FRAGMENT = obj({
  network: NETWORK_FINGERPRINT,
  evidenceReadiness: obj(
    {
      execution: READINESS_CHECK,
      observedEffects: READINESS_CHECK,
      dataBinding: READINESS_CHECK,
      settlement: READINESS_CHECK,
      finality: READINESS_CHECK,
    },
    ["execution", "observedEffects", "dataBinding", "settlement", "finality"],
  ),
  evidence: arr(EVIDENCE_REF),
  blockers: arr(obj({ code: STR, reason: STR })),
  warnings: arr(WARNING),
});

const NETWORK_EVIDENCE_FRAGMENT = obj({
  network: NETWORK_FINGERPRINT,
  subject: SUBJECT_REF,
  networkEvidence: obj(
    {
      execution: EVIDENCE_DIMENSION,
      observedEffects: arr(OBSERVED_EFFECT),
      dataBinding: EVIDENCE_DIMENSION,
      settlement: EVIDENCE_DIMENSION,
      finality: EVIDENCE_DIMENSION,
    },
    ["execution", "observedEffects", "dataBinding", "settlement", "finality"],
  ),
  evidence: arr(EVIDENCE_REF),
  conflicts: arr(CONFLICT),
  warnings: arr(WARNING),
});

// ---------------------------------------------------------------------------
// Encode / decode walkers
// ---------------------------------------------------------------------------

function encodeFail(path: string, reason: string): never {
  throw new NecWireError("NEC_WIRE_ENCODE_FAILED", `${path}: ${reason}`);
}

function decodeFail(path: string, reason: string): never {
  throw new NecWireError("NEC_WIRE_DECODE_FAILED", `${path}: ${reason}`);
}

/** Exact own-property schema membership (prototype-chain keys can never match). */
function schemaHasOwn(fields: Readonly<Record<string, FieldSchema>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(fields, key);
}

function encodeNode(schema: FieldSchema, value: unknown, path: string): unknown {
  switch (schema.kind) {
    case "bigint":
      if (typeof value !== "bigint") encodeFail(path, "must be bigint at runtime");
      if (value < 0n) encodeFail(path, "must be >= 0");
      // Symmetric with decode: a runtime integer the wire would reject on
      // the way in must be equally unencodable.
      if (value.toString().length > MAX_WIRE_DECIMAL_DIGITS) {
        encodeFail(path, `decimal integer exceeds ${MAX_WIRE_DECIMAL_DIGITS} digits`);
      }
      return value.toString();
    case "string":
      if (typeof value !== "string") encodeFail(path, "must be a string");
      return value;
    case "boolean":
      if (typeof value !== "boolean") encodeFail(path, "must be a boolean");
      return value;
    case "number":
      if (typeof value !== "number" || !Number.isSafeInteger(value) || Object.is(value, -0)) {
        encodeFail(path, "must be a safe integer");
      }
      return value;
    case "json":
      return encodeJsonSafe(value, path);
    case "array": {
      if (!Array.isArray(value)) encodeFail(path, "must be an array");
      if (value.length > RESOURCE_LIMITS.MAX_CONTAINER_ENTRIES) {
        encodeFail(path, `array exceeds ${RESOURCE_LIMITS.MAX_CONTAINER_ENTRIES} entries`);
      }
      return value.map((item, i) => encodeNode(schema.items, item, `${path}[${i}]`));
    }
    case "object": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        encodeFail(path, "must be an object");
      }
      const source = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      const declaredKeys = [...Object.keys(schema.fields)].sort();
      for (const key of declaredKeys) {
        const has = Object.prototype.hasOwnProperty.call(source, key);
        if (!has) continue;
        const fieldValue = source[key];
        if (fieldValue === undefined) {
          if (schema.optional.has(key)) {
            encodeFail(
              path,
              `optional field "${key}" explicitly undefined; remove the property instead`,
            );
          }
          encodeFail(path, `required field "${key}" is undefined`);
        }
        out[key] = encodeNode(schema.fields[key]!, fieldValue, `${path}.${key}`);
      }
      for (const key of Object.keys(source)) {
        if (!schemaHasOwn(schema.fields, key)) {
          encodeFail(path, `unknown field "${key}"`);
        }
      }
      return out;
    }
    case "union": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        encodeFail(path, "must be an object");
      }
      const tag = (value as Record<string, unknown>)[schema.tag];
      if (
        typeof tag !== "string" ||
        !Object.prototype.hasOwnProperty.call(schema.variants, tag)
      ) {
        encodeFail(path, `unknown ${JSON.stringify(schema.tag)} discriminator ${JSON.stringify(String(tag))}`);
      }
      return encodeNode(schema.variants[tag]!, value, path);
    }
  }
}

function encodeJsonSafe(value: unknown, path: string): unknown {
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
        encodeFail(path, "generic values carry safe integers only (use decimal strings)");
      }
      return value;
    case "bigint":
      encodeFail(path, "generic NEC values must be JSON-safe: bigint is not allowed outside schema-declared integer fields");
      return null; // unreachable
    case "object": {
      if (value === null) return null;
      if (Array.isArray(value)) {
        if (value.length > RESOURCE_LIMITS.MAX_CONTAINER_ENTRIES) {
          encodeFail(path, `array exceeds ${RESOURCE_LIMITS.MAX_CONTAINER_ENTRIES} entries`);
        }
        return value.map((item, i) => encodeJsonSafe(item, `${path}[${i}]`));
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        encodeFail(path, "must be a plain object");
      }
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length > RESOURCE_LIMITS.MAX_CONTAINER_ENTRIES) {
        encodeFail(path, `object exceeds ${RESOURCE_LIMITS.MAX_CONTAINER_ENTRIES} entries`);
      }
      // Null prototype + explicit definition: an externally controlled key
      // named "__proto__" stays ordinary DATA on the wire value instead of
      // triggering the inherited setter (which would silently drop or
      // repurpose it and break round-trip stability).
      const out: Record<string, unknown> = Object.create(null);
      for (const [key, item] of entries) {
        if (item === undefined) encodeFail(`${path}.${key}`, "undefined is not wire-representable");
        Object.defineProperty(out, key, {
          value: encodeJsonSafe(item, `${path}.${key}`),
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
      return out;
    }
    default:
      encodeFail(path, `unsupported value of type ${typeof value}`);
  }
}

function decodeNode(schema: FieldSchema, value: unknown, path: string): unknown {
  switch (schema.kind) {
    case "bigint": {
      if (typeof value !== "string" || !DECIMAL_STRING_PATTERN.test(value)) {
        decodeFail(
          path,
          'must be a canonical decimal STRING on the wire (ASCII digits, no "+"/whitespace/exponent/leading zeros)',
        );
      }
      if (value.length > MAX_WIRE_DECIMAL_DIGITS) {
        decodeFail(path, `decimal string exceeds ${MAX_WIRE_DECIMAL_DIGITS} digits`);
      }
      return BigInt(value);
    }
    case "string": {
      if (typeof value !== "string") decodeFail(path, "must be a string");
      if (!isWellFormedString(value)) decodeFail(path, "contains an unpaired surrogate");
      if (utf8ByteLength(value) > RESOURCE_LIMITS.MAX_STRING_UTF8_BYTES) {
        decodeFail(path, "string exceeds MAX_STRING_UTF8_BYTES");
      }
      return value;
    }
    case "boolean":
      if (typeof value !== "boolean") decodeFail(path, "must be a boolean");
      return value;
    case "number": {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || Object.is(value, -0)) {
        decodeFail(path, "must be a safe integer JSON number");
      }
      return value;
    }
    case "json":
      return decodeJsonSafe(value, path);
    case "array": {
      if (!Array.isArray(value)) decodeFail(path, "must be an array");
      if (value.length > RESOURCE_LIMITS.MAX_CONTAINER_ENTRIES) {
        decodeFail(path, `array exceeds ${RESOURCE_LIMITS.MAX_CONTAINER_ENTRIES} entries`);
      }
      return value.map((item, i) => decodeNode(schema.items, item, `${path}[${i}]`));
    }
    case "object": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        decodeFail(path, "must be an object");
      }
      const source = value as Record<string, unknown>;
      // Exact OWN-property membership: inherited names such as
      // "constructor"/"prototype"/"__proto__" can never satisfy a schema
      // lookup, so unknown magic keys FAIL CLOSED instead of disappearing.
      for (const key of Object.keys(source)) {
        if (!schemaHasOwn(schema.fields, key)) decodeFail(path, `unknown field "${key}"`);
      }
      // Rebuild into a null-prototype runtime record so converted values
      // (decimal strings -> bigint) replace wire strings positionally.
      const out: Record<string, unknown> = Object.create(null);
      for (const [key, fieldSchema] of Object.entries(schema.fields)) {
        if (!Object.prototype.hasOwnProperty.call(source, key)) {
          if (!schema.optional.has(key)) decodeFail(path, `missing required field "${key}"`);
          continue;
        }
        out[key] = decodeNode(fieldSchema, source[key], `${path}.${key}`);
      }
      return out;
    }
    case "union": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        decodeFail(path, "must be an object");
      }
      const tag = (value as Record<string, unknown>)[schema.tag];
      if (
        typeof tag !== "string" ||
        !Object.prototype.hasOwnProperty.call(schema.variants, tag)
      ) {
        decodeFail(path, `unknown ${JSON.stringify(schema.tag)} discriminator`);
      }
      return decodeNode(schema.variants[tag]!, value, path);
    }
  }
}

function decodeJsonSafe(value: unknown, path: string): unknown {
  switch (typeof value) {
    case "string":
      // The generic-value string budget applies at the wire boundary too,
      // before anything downstream allocates around the value.
      if (utf8ByteLength(value) > RESOURCE_LIMITS.MAX_STRING_UTF8_BYTES) {
        decodeFail(path, "string exceeds MAX_STRING_UTF8_BYTES");
      }
      return value;
    case "boolean":
      return value;
    case "number":
      if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
        decodeFail(path, "generic values carry safe integers only");
      }
      return value;
    case "bigint":
      decodeFail(path, "bigint cannot appear in generic wire values");
      return null; // unreachable
    case "object": {
      if (value === null) return null;
      if (Array.isArray(value)) {
        if (value.length > RESOURCE_LIMITS.MAX_CONTAINER_ENTRIES) {
          decodeFail(path, `array exceeds ${RESOURCE_LIMITS.MAX_CONTAINER_ENTRIES} entries`);
        }
        return value.map((item, i) => decodeJsonSafe(item, `${path}[${i}]`));
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        decodeFail(path, "must be a plain object");
      }
      const out: Record<string, unknown> = Object.create(null);
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        if (item === undefined) decodeFail(`${path}.${key}`, "undefined is not representable on the wire");
        out[key] = decodeJsonSafe(item, `${path}.${key}`);
      }
      return out;
    }
    default:
      decodeFail(path, `unsupported value of type ${typeof value}`);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type NecWireType =
  | "network-evidence-result"
  | "evidence-snapshot"
  | "capability-snapshot"
  | "discovery-result"
  | "preflight-result"
  | "evidence-request"
  | "preflight-request"
  | "discovery-requirements"
  | "preflight-fragment"
  | "network-evidence-fragment"
  | "resolver-manifest"
  | "evidence-policy";

interface WireSchemaEntry {
  readonly schema: FieldSchema;
  readonly validate: (value: unknown) => void;
}

const WIRE_SCHEMAS: Readonly<Record<NecWireType, WireSchemaEntry>> = Object.freeze({
  "network-evidence-result": { schema: NETWORK_EVIDENCE_RESULT, validate: validateNetworkEvidenceResult },
  "evidence-snapshot": { schema: EVIDENCE_SNAPSHOT, validate: validateEvidenceSnapshot },
  "capability-snapshot": { schema: CAPABILITY_SNAPSHOT, validate: validateCapabilitySnapshot },
  "discovery-result": { schema: DISCOVERY_RESULT, validate: validateDiscoverNetworksResult },
  "preflight-result": { schema: PREFLIGHT_RESULT, validate: validatePreflightResult },
  "evidence-request": { schema: EVIDENCE_REQUEST, validate: validateEvidenceRequest },
  "preflight-request": { schema: PREFLIGHT_REQUEST, validate: validatePreflightRequest },
  "discovery-requirements": { schema: DISCOVERY_REQUIREMENTS, validate: validateDiscoveryRequirements },
  "preflight-fragment": { schema: PREFLIGHT_FRAGMENT, validate: validatePreflightFragment },
  "network-evidence-fragment": {
    schema: NETWORK_EVIDENCE_FRAGMENT,
    validate: validateNetworkEvidenceFragment,
  },
  "resolver-manifest": { schema: RESOLVER_MANIFEST, validate: validateResolverManifest },
  "evidence-policy": { schema: EVIDENCE_POLICY, validate: validateEvidencePolicy },
});

export interface NecWireDecoded {
  "network-evidence-result": NetworkEvidenceResult;
  "evidence-snapshot": EvidenceSnapshot;
  "capability-snapshot": CapabilitySnapshot;
  "discovery-result": DiscoverNetworksResult;
  "preflight-result": PreflightResult;
  "evidence-request": EvidenceRequest;
  "preflight-request": PreflightRequest;
  "discovery-requirements": import("./types.js").DiscoveryRequirements;
  "preflight-fragment": PreflightFragment;
  "network-evidence-fragment": NetworkEvidenceFragment;
  "resolver-manifest": ResolverManifest;
  "evidence-policy": EvidencePolicy;
}

/**
 * Encode a VALIDATED core artifact to `nec-wire-json-v1` JSON text:
 * validates first (fail closed), converts schema-declared bigints to
 * decimal strings, then serializes with standard JSON.
 *
 * OUTPUT RESOURCE SYMMETRY (freeze-final): the emitted wire document must
 * never exceed `MAX_CANONICAL_BYTES` UTF-8 bytes — the same budget the raw
 * parser enforces on input — so `decodeNecWireJson(type,
 * encodeNecWireJson(type, x))` can never fail solely because an
 * successfully encoded artifact outgrew the public byte budget. The bound
 * is measured in exact UTF-8 BYTES (not JavaScript string length).
 */
export function encodeNecWireJson(type: NecWireType, value: unknown): string {
  const entry = WIRE_SCHEMAS[type];
  entry.validate(value);
  const wireValue = encodeNode(entry.schema, value, type);
  const text = JSON.stringify(wireValue);
  const bytes = utf8ByteLength(text);
  if (bytes > RESOURCE_LIMITS.MAX_CANONICAL_BYTES) {
    throw new NecWireError(
      "NEC_WIRE_ENCODE_FAILED",
      `${type}: encoded wire document exceeds MAX_CANONICAL_BYTES (${RESOURCE_LIMITS.MAX_CANONICAL_BYTES} UTF-8 bytes; got ${bytes}); decode symmetry requires the encoder to enforce the parser's byte budget`,
    );
  }
  return text;
}

/**
 * Decode `nec-wire-json-v1` JSON text into a validated runtime artifact:
 * strict wire parse -> schema-aware decimal-string -> bigint conversion ->
 * full core validation. Throws `NecWireError` / `NecValidationError`.
 */
export function decodeNecWireJson<T extends NecWireType>(type: T, text: string): NecWireDecoded[T] {
  const entry = WIRE_SCHEMAS[type];
  const parsed = parseNecWireJson(text);
  try {
    const runtime = decodeNode(entry.schema, parsed, type);
    entry.validate(runtime);
    return runtime as NecWireDecoded[T];
  } catch (error) {
    if (error instanceof NecWireError) throw error;
    if (error instanceof RangeError || error instanceof SyntaxError) {
      throw new NecWireError("NEC_WIRE_DECODE_FAILED", `${type}: ${(error as Error).message}`);
    }
    throw error;
  }
}
