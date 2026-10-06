import { hash as cryptoHash } from "node:crypto";

export const H1_LIMITS = Object.freeze({
  maxRawBytes: 262144,
  maxDepth: 32,
  maxObjectKeys: 256,
  maxArrayItems: 1024,
  maxTotalNodes: 10000,
  maxStringTokenBytes: 65536,
  maxNumberTokenChars: 128
});

const SOURCE_SCHEMAS = Object.freeze([
  "fixture.a2a-like/v0.1",
  "fixture.mcp-like/v0.1",
  "hub.action-boundary-fixture/v0.1",
  "hub.network-evidence-frozen-projection/v0.1"
]);
const TOP_SCHEMAS = Object.freeze(["lens-case-expected-fixture/v0.1"]);
const REQUIRED = Object.freeze([
  "01-a2a-task.json", "02-mcp-call.json", "03-mcp-result.json",
  "04-action-boundary.json", "05-network-evidence-result.json",
  "06-case-expected.json"
]);
const IntrinsicWeakSet = WeakSet;
const IntrinsicString = String;
const VERIFIED_RECORDS = new IntrinsicWeakSet();
const ARTIFACT_REALITY = Object.freeze({
  "01-a2a-task.json": "synthetic",
  "02-mcp-call.json": "synthetic",
  "03-mcp-result.json": "synthetic",
  "04-action-boundary.json": "synthetic_binding_context",
  "05-network-evidence-result.json": "real_frozen_evidence_projection",
  "06-case-expected.json": "mixed_synthetic_context_real_network_evidence"
});
const PINNED_ARTIFACT_SHA256 = Object.freeze({
  "05-network-evidence-result.json": "724493778e217047a00b6ee18fc20177b3ab115f902ed773659336701be44e45",
  "06-case-expected.json": "a3f402f7030452f10226345f81e44cb569bf38d7843d0399b03745aa8f7563a9"
});
const ARTIFACT_SCHEMA = Object.freeze({
  "01-a2a-task.json": "fixture.a2a-like/v0.1",
  "02-mcp-call.json": "fixture.mcp-like/v0.1",
  "03-mcp-result.json": "fixture.mcp-like/v0.1",
  "04-action-boundary.json": "hub.action-boundary-fixture/v0.1",
  "05-network-evidence-result.json": "hub.network-evidence-frozen-projection/v0.1",
  "06-case-expected.json": "lens-case-expected-fixture/v0.1"
});

export class H1Error extends Error {
  constructor(code, message, details = {}) {
    super(message);
    const own = (key, value) => {
      const descriptor = intrinsicObjectCreate(null);
      descriptor.value = value;
      descriptor.writable = true;
      descriptor.enumerable = true;
      descriptor.configurable = true;
      intrinsicDefineProperty(this, key, descriptor);
    };
    own("name", "H1Error");
    own("code", code);
    own("details", sanitizeDiagnosticDetails(details));
    own("toJSON", () => {
      const out = intrinsicObjectCreate(null);
      defineDiagnosticOwn(out, "name", "H1Error");
      defineDiagnosticOwn(out, "message", this.message);
      defineDiagnosticOwn(out, "code", this.code);
      defineDiagnosticOwn(out, "details", this.details);
      return intrinsicObjectFreeze(out);
    });
  }
}
let ACTIVE_H1_ERRORS = null;
const fail = (code, message, details) => {
  const error = new H1Error(code, message, details);
  if (ACTIVE_H1_ERRORS) intrinsicApply(intrinsicWeakSetAdd, ACTIVE_H1_ERRORS, [error]);
  throw error;
};
const intrinsicApply = Reflect.apply;
const intrinsicOwnKeys = Reflect.ownKeys;
const intrinsicArrayIsArray = Array.isArray;
const intrinsicDefineProperty = Object.defineProperty;
const intrinsicObjectCreate = Object.create;
const intrinsicObjectFreeze = Object.freeze;
const intrinsicObjectIsFrozen = Object.isFrozen;
const intrinsicObjectValues = Object.values;
const intrinsicObjectEntries = Object.entries;
const intrinsicGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const intrinsicGetPrototypeOf = Object.getPrototypeOf;
const intrinsicSetPrototypeOf = Object.setPrototypeOf;
const intrinsicHasOwn = Object.hasOwn;
const intrinsicWeakSetHas = WeakSet.prototype.has;
const intrinsicWeakSetAdd = WeakSet.prototype.add;
const runBoundary = (fn, code, message, details = {}) => {
  const previousErrors = ACTIVE_H1_ERRORS;
  const invocationErrors = new IntrinsicWeakSet();
  ACTIVE_H1_ERRORS = invocationErrors;
  try { return fn(); }
  catch (error) {
    if (intrinsicApply(intrinsicWeakSetHas, invocationErrors, [error])) throw error;
    fail(code, message, details);
  } finally {
    ACTIVE_H1_ERRORS = previousErrors;
  }
};
const intrinsicBufferIsBuffer = Buffer.isBuffer;
const IntrinsicUint8Array = Uint8Array;
const intrinsicUint8ArrayPrototype = Uint8Array.prototype;
const typedArrayProto = intrinsicGetPrototypeOf(intrinsicUint8ArrayPrototype);
const intrinsicTypedArrayByteLength = intrinsicGetOwnPropertyDescriptor(typedArrayProto, "byteLength").get;
const intrinsicByteLength = (value) => intrinsicApply(intrinsicTypedArrayByteLength, value, []);
const IntrinsicTextDecoder = TextDecoder;
const IntrinsicTextEncoder = TextEncoder;
const intrinsicTextDecoderDecode = TextDecoder.prototype.decode;
const intrinsicTextEncoderEncode = TextEncoder.prototype.encode;
const utf8Decoder = new IntrinsicTextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const utf8Encoder = new IntrinsicTextEncoder();
const intrinsicJsonParse = JSON.parse;
const intrinsicStringSlice = String.prototype.slice;
const intrinsicRegExpExec = RegExp.prototype.exec;
const arrayContainsExact = (values, target) => {
  for (let index = 0; index < values.length; index += 1) {
    const descriptor = intrinsicGetOwnPropertyDescriptor(values, index);
    if (descriptor && intrinsicHasOwn(descriptor, "value") && descriptor.value === target) return true;
  }
  return false;
};
const createSafeArray = () => { const array = []; intrinsicSetPrototypeOf(array, null); return array; };
const appendOwn = (array, value) => {
  const descriptor = intrinsicObjectCreate(null);
  descriptor.value = value; descriptor.writable = true; descriptor.enumerable = true; descriptor.configurable = true;
  intrinsicDefineProperty(array, array.length, descriptor);
};
const intrinsicNumber = Number;
const intrinsicNumberIsFinite = Number.isFinite;
const intrinsicMathAbs = Math.abs;
const intrinsicBigInt = BigInt;
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const MIN_SAFE_INTEGER = Number.MIN_SAFE_INTEGER;
const intrinsicCryptoHash = cryptoHash;

const encodeUtf8 = (text) => intrinsicApply(intrinsicTextEncoderEncode, utf8Encoder, [text]);
const decodeUtf8 = (bytes) => {
  try { return intrinsicApply(intrinsicTextDecoderDecode, utf8Decoder, [bytes]); }
  catch { fail("artifact_invalid_utf8", "artifact is not valid UTF-8"); }
};
const sha256 = (bytes) => intrinsicCryptoHash("sha256", bytes, "hex");
const copyInputBytes = (bytes, artifactName) => {
  let isBuffer;
  let isUint8;
  try {
    isBuffer = intrinsicBufferIsBuffer(bytes);
    isUint8 = !isBuffer && bytes && typeof bytes === "object" && intrinsicGetPrototypeOf(bytes) === intrinsicUint8ArrayPrototype;
  } catch {
    fail("schema_validation_failed", "H1 bytes input must be a Buffer or Uint8Array", { artifactName });
  }
  if (!isBuffer && !isUint8) fail("schema_validation_failed", "H1 bytes input must be a Buffer or Uint8Array", { artifactName });
  let length;
  try { length = intrinsicByteLength(bytes); }
  catch { fail("schema_validation_failed", "H1 bytes input must be a Buffer or Uint8Array", { artifactName }); }
  if (length > H1_LIMITS.maxRawBytes) fail("artifact_too_large", "raw artifact exceeds H1 byte limit", { actual: length, max: H1_LIMITS.maxRawBytes });
  const owned = new IntrinsicUint8Array(length);
  try { for (let index = 0; index < length; index += 1) owned[index] = bytes[index]; }
  catch { fail("schema_validation_failed", "H1 bytes input must be a Buffer or Uint8Array", { artifactName }); }
  return owned;
};

function scanJson(bytes) {
  const length = intrinsicByteLength(bytes);
  if (length > H1_LIMITS.maxRawBytes) {
    fail("artifact_too_large", "raw artifact exceeds H1 byte limit", { actual: length, max: H1_LIMITS.maxRawBytes });
  }
  const text = decodeUtf8(bytes);
  let i = 0;
  let totalNodes = 0;
  const isWhitespace = (c) => c === " " || c === "\t" || c === "\r" || c === "\n";
  const isDigit = (c) => c >= "0" && c <= "9";
  const ws = () => { while (i < text.length && isWhitespace(text[i])) i += 1; };
  const bump = () => {
    totalNodes += 1;
    if (totalNodes > H1_LIMITS.maxTotalNodes) {
      fail("resource_limit_exceeded", "JSON node limit exceeded", { max: H1_LIMITS.maxTotalNodes });
    }
  };
  const parseString = () => {
    if (text[i] !== '"') fail("artifact_parse_error", "expected string token", { offset: i });
    const start = i++;
    let escaped = false;
    while (i < text.length) {
      const c = text[i++];
      if (escaped) { escaped = false; continue; }
      if (c === "\\") { escaped = true; continue; }
      if (c === '"') {
        const raw = intrinsicApply(intrinsicStringSlice, text, [start, i]);
        if (intrinsicByteLength(encodeUtf8(raw)) > H1_LIMITS.maxStringTokenBytes) {
          fail("resource_limit_exceeded", "JSON string token limit exceeded", { max: H1_LIMITS.maxStringTokenBytes });
        }
        try { return intrinsicJsonParse(raw); }
        catch { fail("artifact_parse_error", "invalid JSON string", { offset: start }); }
      }
      if (c < " ") fail("artifact_parse_error", "unescaped control character", { offset: i - 1 });
    }
    fail("artifact_parse_error", "unterminated JSON string", { offset: start });
  };
  const parseNumber = () => {
    const start = i;
    if (text[i] === "-") i += 1;
    if (text[i] === "0") i += 1;
    else if (text[i] >= "1" && text[i] <= "9") { while (isDigit(text[i])) i += 1; }
    else fail("artifact_parse_error", "invalid JSON number", { offset: start });
    let exactInteger = true;
    if (text[i] === ".") {
      exactInteger = false; i += 1;
      if (!isDigit(text[i])) fail("artifact_parse_error", "invalid JSON number", { offset: i });
      while (isDigit(text[i])) i += 1;
    }
    if (text[i] === "e" || text[i] === "E") {
      exactInteger = false; i += 1;
      if (text[i] === "+" || text[i] === "-") i += 1;
      if (!isDigit(text[i])) fail("artifact_parse_error", "invalid JSON number", { offset: i });
      while (isDigit(text[i])) i += 1;
    }
    const token = intrinsicApply(intrinsicStringSlice, text, [start, i]);
    if (token.length > H1_LIMITS.maxNumberTokenChars) {
      fail("resource_limit_exceeded", "JSON number token limit exceeded", { max: H1_LIMITS.maxNumberTokenChars });
    }
    if (!exactInteger) fail("unsafe_numeric_coercion", "non-integer numeric token must be encoded as an exact string", { token });
    const numericValue = intrinsicNumber(token);
    if (!intrinsicNumberIsFinite(numericValue) || intrinsicMathAbs(numericValue) > MAX_SAFE_INTEGER) {
      fail("unsafe_numeric_coercion", "numeric token exceeds exact JavaScript integer range", { token });
    }
    let n;
    try { n = intrinsicBigInt(token); }
    catch { fail("artifact_parse_error", "invalid integer token", { token }); }
    if (n > intrinsicBigInt(MAX_SAFE_INTEGER) || n < intrinsicBigInt(MIN_SAFE_INTEGER)) {
      fail("unsafe_numeric_coercion", "unsafe integer must be encoded as a string", { token });
    }
  };
  const startsLiteral = (literal) => {
    if (i + literal.length > text.length) return false;
    for (let j = 0; j < literal.length; j += 1) if (text[i + j] !== literal[j]) return false;
    return true;
  };
  const parseValue = (depth) => {
    if (depth > H1_LIMITS.maxDepth) fail("resource_limit_exceeded", "JSON nesting depth exceeded", { max: H1_LIMITS.maxDepth });
    ws(); bump();
    const c = text[i];
    if (c === "{") return parseObject(depth + 1);
    if (c === "[") return parseArray(depth + 1);
    if (c === '"') { parseString(); return; }
    if (c === "-" || isDigit(c)) { parseNumber(); return; }
    const literals = ["true", "false", "null"];
    for (let index = 0; index < literals.length; index += 1) {
      const literal = literals[index];
      if (startsLiteral(literal)) { i += literal.length; return; }
    }
    fail("artifact_parse_error", "unexpected JSON token", { offset: i });
  };
  const parseObject = (depth) => {
    i += 1; ws();
    const keys = intrinsicObjectCreate(null);
    let keyCount = 0;
    if (text[i] === "}") { i += 1; return; }
    while (i < text.length) {
      ws();
      const key = parseString();
      if (intrinsicHasOwn(keys, key)) fail("artifact_duplicate_json_key", "duplicate JSON object key", { key });
      keys[key] = true; keyCount += 1;
      if (keyCount > H1_LIMITS.maxObjectKeys) fail("resource_limit_exceeded", "object key limit exceeded", { max: H1_LIMITS.maxObjectKeys });
      ws();
      if (text[i++] !== ":") fail("artifact_parse_error", "expected colon", { offset: i - 1 });
      parseValue(depth); ws();
      if (text[i] === "}") { i += 1; return; }
      if (text[i++] !== ",") fail("artifact_parse_error", "expected comma", { offset: i - 1 });
    }
    fail("artifact_parse_error", "unterminated object");
  };
  const parseArray = (depth) => {
    i += 1; ws();
    let count = 0;
    if (text[i] === "]") { i += 1; return; }
    while (i < text.length) {
      count += 1;
      if (count > H1_LIMITS.maxArrayItems) fail("resource_limit_exceeded", "array item limit exceeded", { max: H1_LIMITS.maxArrayItems });
      parseValue(depth); ws();
      if (text[i] === "]") { i += 1; return; }
      if (text[i++] !== ",") fail("artifact_parse_error", "expected comma", { offset: i - 1 });
    }
    fail("artifact_parse_error", "unterminated array");
  };
  parseValue(0); ws();
  if (i !== text.length) fail("artifact_parse_error", "trailing bytes after JSON value", { offset: i });
  return text;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || intrinsicObjectIsFrozen(value)) return value;
  const children = intrinsicObjectValues(value);
  for (let index = 0; index < children.length; index += 1) deepFreeze(children[index]);
  return intrinsicObjectFreeze(value);
}

function safeCopy(value) {
  if (intrinsicArrayIsArray(value)) {
    const out = createSafeArray();
    for (let index = 0; index < value.length; index += 1) appendOwn(out, safeCopy(value[index]));
    return out;
  }
  if (value && typeof value === "object") {
    const out = intrinsicObjectCreate(null);
    const entries = intrinsicObjectEntries(value);
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      out[entry[0]] = safeCopy(entry[1]);
    }
    return out;
  }
  return value;
}

const DIAGNOSTIC_MAX_FIELDS = 32;
function sanitizeDiagnosticScalar(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return intrinsicNumberIsFinite(value) ? value : "[non-finite-number]";
  if (typeof value === "bigint") return IntrinsicString(value);
  if (typeof value === "undefined") return "[undefined]";
  if (typeof value === "symbol") return "[symbol]";
  if (typeof value === "function") return "[function]";
  try { return intrinsicArrayIsArray(value) ? "[array]" : "[object]"; }
  catch { return "[uninspectable]"; }
}

function defineDiagnosticOwn(target, key, value) {
  const descriptor = intrinsicObjectCreate(null);
  descriptor.value = value;
  descriptor.writable = false;
  descriptor.enumerable = true;
  descriptor.configurable = false;
  intrinsicDefineProperty(target, key, descriptor);
}

function sanitizeDiagnosticDetails(details) {
  const out = intrinsicObjectCreate(null);
  if (!details || typeof details !== "object") {
    defineDiagnosticOwn(out, "value", sanitizeDiagnosticScalar(details));
    return intrinsicObjectFreeze(out);
  }
  let keys;
  try { keys = intrinsicOwnKeys(details); }
  catch {
    defineDiagnosticOwn(out, "value", "[uninspectable]");
    return intrinsicObjectFreeze(out);
  }
  let copied = 0;
  for (let index = 0; index < keys.length && copied < DIAGNOSTIC_MAX_FIELDS; index += 1) {
    const key = keys[index];
    if (typeof key !== "string") continue;
    if (key === "__truncated__") continue;
    let descriptor;
    try { descriptor = intrinsicGetOwnPropertyDescriptor(details, key); }
    catch { defineDiagnosticOwn(out, key, "[uninspectable]"); copied += 1; continue; }
    const value = descriptor && intrinsicHasOwn(descriptor, "value") ? sanitizeDiagnosticScalar(descriptor.value) : "[accessor]";
    defineDiagnosticOwn(out, key, value);
    copied += 1;
  }
  if (keys.length > copied) defineDiagnosticOwn(out, "__truncated__", true);
  return intrinsicObjectFreeze(out);
}

const requireString = (value, path, pattern = null) => {
  if (typeof value !== "string" || value.length === 0 || (pattern && intrinsicApply(intrinsicRegExpExec, pattern, [value]) === null)) {
    fail(pattern ? "invalid_identifier" : "schema_validation_failed", `invalid ${path}`, { path });
  }
};
const fixtureId = (value, path) => requireString(value, path, /^[A-Za-z0-9._:-]{1,128}$/);
const networkId = (value, path) => requireString(value, path, /^eip155:[1-9][0-9]*$/);
const txId = (value, path) => requireString(value, path, /^0x[0-9a-f]{64}$/);
const verdicts = Object.freeze(["supported", "contradicted", "insufficient", "ambiguous"]);
const bases = Object.freeze(["source_observation", "deterministic_derivation", "local_content_verification", "local_consensus_engine", "cryptographic_verification"]);
function rejectNestedSyntheticAuthority(value, artifactName, path = "$", isRoot = true) {
  if (!value || typeof value !== "object") return;
  const keys = intrinsicOwnKeys(value);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (typeof key !== "string") continue;
    if (!isRoot && (key === "authorizationClaim" || key === "sourceConformanceClaim")) {
      fail("schema_validation_failed", "synthetic fixture cannot embed authority or external-conformance claims", { artifactName, path: `${path}.${key}` });
    }
    const descriptor = intrinsicGetOwnPropertyDescriptor(value, key);
    if (descriptor && intrinsicHasOwn(descriptor, "value")) rejectNestedSyntheticAuthority(descriptor.value, artifactName, `${path}.${key}`, false);
  }
}

function validateDimension(d, path) {
  if (!d || typeof d !== "object" || !arrayContainsExact(verdicts, d.verdict) || !intrinsicArrayIsArray(d.basis)) fail("schema_validation_failed", `invalid ${path}`, { path });
  for (let index = 0; index < d.basis.length; index += 1) { const basis = d.basis[index]; if (!arrayContainsExact(bases, basis)) fail("schema_validation_failed", `invalid basis in ${path}`, { path, basis }); }
}
function assertLocalSchema(value, artifactName) {
  if (value?.sourceSchema !== undefined && value?.schemaVersion !== undefined && value.sourceSchema !== value.schemaVersion) {
    fail("schema_validation_failed", "conflicting schema discriminators rejected", { artifactName, sourceSchema: value.sourceSchema, schemaVersion: value.schemaVersion });
  }
  const schema = value?.sourceSchema ?? value?.schemaVersion;
  if (!(arrayContainsExact(SOURCE_SCHEMAS, schema) || arrayContainsExact(TOP_SCHEMAS, schema))) fail("unsupported_schema_version", "schema is not in the local H1 registry", { artifactName, schema });
  if (ARTIFACT_SCHEMA[artifactName] !== schema) fail("schema_validation_failed", "schema is not valid for this artifact role", { artifactName, schema, expected: ARTIFACT_SCHEMA[artifactName] });
  if (value.realityClass !== ARTIFACT_REALITY[artifactName]) fail("schema_validation_failed", "reality class is not valid for this artifact role", { artifactName, realityClass: value.realityClass, expected: ARTIFACT_REALITY[artifactName] });
  fixtureId(value.fixtureArtifactId, `${artifactName}.fixtureArtifactId`);
  if (schema === "fixture.a2a-like/v0.1" || schema === "fixture.mcp-like/v0.1") {
    if (value.sourceConformanceClaim !== "none") fail("schema_validation_failed", "synthetic fixture cannot claim external source conformance", { artifactName });
    if (intrinsicHasOwn(value, "authorizationClaim")) fail("schema_validation_failed", "synthetic source fixture cannot carry Hub authorization claims", { artifactName });
    rejectNestedSyntheticAuthority(value, artifactName);
    fixtureId(value.fixtureCorrelation?.actionBoundaryId, `${artifactName}.fixtureCorrelation.actionBoundaryId`);
    requireString(value.fixtureCorrelation?.actionTokenSha256, `${artifactName}.fixtureCorrelation.actionTokenSha256`, /^[0-9a-f]{64}$/);
  }
  if (schema === "fixture.mcp-like/v0.1") {
    fixtureId(value.payload?.callId, `${artifactName}.payload.callId`);
    if (artifactName === "02-mcp-call.json") {
      requireString(value.payload?.tool, `${artifactName}.payload.tool`, /^[A-Za-z0-9._:-]{1,160}$/);
      requireString(value.payload?.argumentsDigest, `${artifactName}.payload.argumentsDigest`, /^[0-9a-f]{64}$/);
      if (intrinsicHasOwn(value.payload, "resultCode") || intrinsicHasOwn(value.payload, "resultRef")) fail("schema_validation_failed", "MCP call payload cannot carry result-role fields", { artifactName });
    } else if (artifactName === "03-mcp-result.json") {
      requireString(value.payload?.resultCode, `${artifactName}.payload.resultCode`, /^[A-Za-z0-9._:-]{1,128}$/);
      fixtureId(value.payload?.resultRef, `${artifactName}.payload.resultRef`);
      if (intrinsicHasOwn(value.payload, "tool") || intrinsicHasOwn(value.payload, "argumentsDigest")) fail("schema_validation_failed", "MCP result payload cannot carry call-role fields", { artifactName });
    }
  }
  if (schema === "hub.action-boundary-fixture/v0.1") {
    if (value.sourceConformanceClaim !== "hub-owned-fixture-only") fail("schema_validation_failed", "action boundary must remain Hub-owned fixture-only", { artifactName });
    rejectNestedSyntheticAuthority(value, artifactName);
    fixtureId(value.actionBoundaryId, `${artifactName}.actionBoundaryId`);
    networkId(value.networkIdentity?.networkId, `${artifactName}.networkIdentity.networkId`);
    txId(value.networkIdentity?.txId, `${artifactName}.networkIdentity.txId`);
    if (value.authorizationClaim !== "none") fail("schema_validation_failed", "fixture boundary must remain non-authorizing", { artifactName });
  }
  if (schema === "hub.network-evidence-frozen-projection/v0.1") {
    if (value.sourceConformanceClaim !== "hub-owned-projection-only") fail("schema_validation_failed", "Network Evidence projection conformance claim must remain Hub-owned only", { artifactName });
    networkId(value.subject?.networkId, `${artifactName}.subject.networkId`);
    txId(value.subject?.txId, `${artifactName}.subject.txId`);
    requireString(value.provenance?.sourceRepository, `${artifactName}.provenance.sourceRepository`, /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/);
    requireString(value.provenance?.sourceCommit, `${artifactName}.provenance.sourceCommit`, /^[0-9a-f]{40}$/);
    requireString(value.provenance?.sourceFreezeTag, `${artifactName}.provenance.sourceFreezeTag`, /^[A-Za-z0-9._-]{1,160}$/);
    if (!intrinsicArrayIsArray(value.limitations) || value.limitations.length === 0) fail("schema_validation_failed", "Network Evidence limitations must be preserved explicitly", { artifactName });
    for (let index = 0; index < value.limitations.length; index += 1) { const limitation = value.limitations[index]; if (typeof limitation !== "string" || limitation.length === 0) fail("schema_validation_failed", "Network Evidence limitations must be preserved explicitly", { artifactName }); }
    if (!intrinsicArrayIsArray(value.unavailableDimensions)) fail("schema_validation_failed", "Network Evidence unavailable dimensions must be explicit", { artifactName });
    validateDimension(value.networkEvidence?.execution, "execution");
    validateDimension(value.networkEvidence?.dataBinding, "dataBinding");
    validateDimension(value.networkEvidence?.finality, "finality");
  }
  if (schema === "lens-case-expected-fixture/v0.1") fixtureId(value.caseId, `${artifactName}.caseId`);
}
function field(value, artifactId, digest, adapterType, sourcePath, transformation = "exact_string") {
  return { value: safeCopy(value), provenance: { sourceArtifactId: artifactId, sourceDigest: { algorithm: "sha256", digestOf: "raw_bytes", value: digest }, adapterType, adapterVersion: "h1-local/v0.1", sourcePath, transformation } };
}
function normalizeArtifact(value, artifactName, digest) {
  const schema = value.sourceSchema ?? value.schemaVersion;
  const base = { artifactId: value.fixtureArtifactId, artifactName, sourceSchema: schema, realityClass: value.realityClass ?? null, digest: { algorithm: "sha256", digestOf: "raw_bytes", value: digest } };
  if (schema === "fixture.a2a-like/v0.1") return { ...base, kind: "a2a_like_task", actionBoundaryId: field(value.fixtureCorrelation.actionBoundaryId, value.fixtureArtifactId, digest, "fixture.a2a-like", "$.fixtureCorrelation.actionBoundaryId"), actionTokenSha256: field(value.fixtureCorrelation.actionTokenSha256, value.fixtureArtifactId, digest, "fixture.a2a-like", "$.fixtureCorrelation.actionTokenSha256") };
  if (schema === "fixture.mcp-like/v0.1") return { ...base, kind: "mcp_like", actionBoundaryId: field(value.fixtureCorrelation.actionBoundaryId, value.fixtureArtifactId, digest, "fixture.mcp-like", "$.fixtureCorrelation.actionBoundaryId"), actionTokenSha256: field(value.fixtureCorrelation.actionTokenSha256, value.fixtureArtifactId, digest, "fixture.mcp-like", "$.fixtureCorrelation.actionTokenSha256"), callId: field(value.payload.callId, value.fixtureArtifactId, digest, "fixture.mcp-like", "$.payload.callId") };
  if (schema === "hub.action-boundary-fixture/v0.1") return { ...base, kind: "action_boundary", actionBoundaryId: field(value.actionBoundaryId, value.fixtureArtifactId, digest, "hub.action-boundary-fixture", "$.actionBoundaryId"), networkId: field(value.networkIdentity.networkId, value.fixtureArtifactId, digest, "hub.action-boundary-fixture", "$.networkIdentity.networkId"), txId: field(value.networkIdentity.txId, value.fixtureArtifactId, digest, "hub.action-boundary-fixture", "$.networkIdentity.txId") };
  if (schema === "hub.network-evidence-frozen-projection/v0.1") return { ...base, kind: "network_evidence", importProvenanceClass: "operator_imported", networkId: field(value.subject.networkId, value.fixtureArtifactId, digest, "network-evidence-frozen-projection", "$.subject.networkId"), txId: field(value.subject.txId, value.fixtureArtifactId, digest, "network-evidence-frozen-projection", "$.subject.txId"), sourceProvenance: field(value.provenance, value.fixtureArtifactId, digest, "network-evidence-frozen-projection", "$.provenance", "exact_json_value"), preservedNetworkEvidence: field(value.networkEvidence, value.fixtureArtifactId, digest, "network-evidence-frozen-projection", "$.networkEvidence", "exact_json_value"), limitations: field(value.limitations, value.fixtureArtifactId, digest, "network-evidence-frozen-projection", "$.limitations", "exact_json_value"), unavailableDimensions: field(value.unavailableDimensions, value.fixtureArtifactId, digest, "network-evidence-frozen-projection", "$.unavailableDimensions", "exact_json_value") };
  return { ...base, kind: "lens_expected", caseId: value.caseId };
}

function parseVerifiedJsonInternal({ bytes, expectedSha256, artifactName }) {
  if (!artifactName || !arrayContainsExact(REQUIRED, artifactName)) {
    fail("invalid_identifier", "artifact name is not registered", { artifactName });
  }
  const ownedBytes = copyInputBytes(bytes, artifactName);
  const actualSha256 = sha256(ownedBytes);
  if (typeof expectedSha256 !== "string" || intrinsicApply(intrinsicRegExpExec, /^[0-9a-f]{64}$/, [expectedSha256]) === null) {
    fail("schema_validation_failed", "exact expected SHA-256 is required before H1 semantic use", { artifactName });
  }
  if (actualSha256 !== expectedSha256) {
    fail("artifact_digest_mismatch", "artifact digest mismatch", { artifactName, expectedSha256, actualSha256 });
  }
  const pinnedSha256 = PINNED_ARTIFACT_SHA256[artifactName];
  if (pinnedSha256 !== undefined && actualSha256 !== pinnedSha256) {
    fail("artifact_digest_mismatch", "artifact bytes do not match the frozen H0 authority artifact", { artifactName, expectedSha256: pinnedSha256, actualSha256 });
  }
  const text = scanJson(ownedBytes);
  let parsed;
  try { parsed = intrinsicJsonParse(text); }
  catch { fail("artifact_parse_error", "JSON.parse rejected verified bytes", { artifactName }); }
  const value = safeCopy(parsed);
  assertLocalSchema(value, artifactName);
  const normalized = safeCopy(normalizeArtifact(value, artifactName, actualSha256));
  const record = deepFreeze(safeCopy({ artifactName, digest: { algorithm: "sha256", digestOf: "raw_bytes", value: actualSha256 }, value, normalized }));
  intrinsicApply(intrinsicWeakSetAdd, VERIFIED_RECORDS, [record]);
  return record;
}

const RELATION_RULES = Object.freeze({
  candidate_same_action: Object.freeze(["deterministic_binding"]),
  source_declared_result_for: Object.freeze(["source_declared_binding"])
});
function validateRelationsInternal(relations, artifactIds) {
  if (!intrinsicArrayIsArray(relations)) fail("relation_invalid", "relations must be an array");
  if (!intrinsicArrayIsArray(artifactIds)) fail("relation_invalid", "artifactIds must be an array");
  const refs = artifactIds;
  const closed = createSafeArray();
  for (let relationIndex = 0; relationIndex < relations.length; relationIndex += 1) {
    const relationDescriptor = intrinsicGetOwnPropertyDescriptor(relations, relationIndex);
    if (!relationDescriptor || !intrinsicHasOwn(relationDescriptor, "value")) fail("relation_invalid", "relation slots must be own data properties", { relationIndex });
    const relation = relationDescriptor.value;
    if (!relation || typeof relation !== "object") fail("relation_invalid", "relation must be an object");
    const ownKeys = intrinsicOwnKeys(relation);
    let validKeyShape = ownKeys.length === 4;
    const printableKeys = createSafeArray();
    for (let index = 0; index < ownKeys.length; index += 1) {
      const key = ownKeys[index];
      if (typeof key === "string") appendOwn(printableKeys, key);
      if (typeof key !== "string" || !(key === "basis" || key === "from" || key === "relationType" || key === "to")) validKeyShape = false;
    }
    if (!validKeyShape) fail("relation_invalid", "relation contains unexpected fields", { keys: printableKeys });
    const values = intrinsicObjectCreate(null);
    const requiredRelationFields = ["from", "to", "relationType", "basis"];
    for (let fieldIndex = 0; fieldIndex < requiredRelationFields.length; fieldIndex += 1) {
      const key = requiredRelationFields[fieldIndex];
      const descriptor = intrinsicGetOwnPropertyDescriptor(relation, key);
      if (!descriptor || !intrinsicHasOwn(descriptor, "value")) fail("relation_invalid", "relation fields must be own data properties", { key });
      if (typeof descriptor.value !== "string") fail("relation_invalid", "relation fields must be primitive strings", { key });
      values[key] = descriptor.value;
    }
    const { from, to, relationType, basis } = values;
    if (!intrinsicHasOwn(RELATION_RULES, relationType)) fail("relation_invalid", "unknown relation type/basis pair", { relationType, basis });
    const allowed = RELATION_RULES[relationType];
    if (!arrayContainsExact(allowed, basis)) fail("relation_invalid", "unknown relation type/basis pair", { relationType, basis });
    if (!arrayContainsExact(refs, from) || !arrayContainsExact(refs, to) || from === to) fail("relation_invalid", "relation references invalid artifacts", { from, to });
    appendOwn(closed, safeCopy({ from, to, relationType, basis }));
  }
  return deepFreeze(closed);
}

function correlateF0Internal(parsedByName) {
  if (!parsedByName || typeof parsedByName !== "object") fail("correlation_insufficient", "correlation input must be an object");
  const records = intrinsicObjectCreate(null);
  for (let requiredIndex = 0; requiredIndex < REQUIRED.length; requiredIndex += 1) {
    const name = REQUIRED[requiredIndex];
    const descriptor = intrinsicGetOwnPropertyDescriptor(parsedByName, name);
    if (!descriptor) fail("required_fixture_artifact_missing", "required artifact missing", { artifactName: name });
    if (!intrinsicHasOwn(descriptor, "value")) fail("correlation_insufficient", "correlation slots must be own data properties", { artifactName: name });
    const record = descriptor.value;
    if (!record) fail("required_fixture_artifact_missing", "required artifact missing", { artifactName: name });
    if (!intrinsicApply(intrinsicWeakSetHas, VERIFIED_RECORDS, [record]) || record.artifactName !== name) fail("correlation_insufficient", "correlation requires parser-authenticated records in exact artifact slots", { artifactName: name });
    records[name] = record;
  }
  const task = records["01-a2a-task.json"].value;
  const call = records["02-mcp-call.json"].value;
  const result = records["03-mcp-result.json"].value;
  const boundary = records["04-action-boundary.json"].value;
  const ne = records["05-network-evidence-result.json"].value;
  const token = boundary.fixtureBinding?.actionToken;
  const tokenDigest = typeof token === "string" ? sha256(encodeUtf8(token)) : null;
  const expectedToken = `hub-f0-action-boundary-v0.1|${boundary.networkIdentity?.networkId}|${boundary.networkIdentity?.txId}`;
  const shared =
    task.fixtureCorrelation?.actionBoundaryId === boundary.actionBoundaryId &&
    task.fixtureCorrelation?.actionTokenSha256 === tokenDigest &&
    call.fixtureCorrelation?.actionBoundaryId === boundary.actionBoundaryId &&
    call.fixtureCorrelation?.actionTokenSha256 === tokenDigest &&
    result.fixtureCorrelation?.actionBoundaryId === boundary.actionBoundaryId &&
    result.fixtureCorrelation?.actionTokenSha256 === tokenDigest;
  const callArguments = call.payload?.argumentsDigest === tokenDigest;
  const callResult = result.payload?.callId === call.payload?.callId &&
    result.payload?.resultRef === ne.fixtureArtifactId;
  const network = boundary.networkIdentity?.networkId === ne.subject?.networkId &&
    boundary.networkIdentity?.txId === ne.subject?.txId;
  const tokenSelf = token === expectedToken && boundary.fixtureBinding?.actionTokenSha256 === tokenDigest;
  if (!(shared && callArguments && callResult && network && tokenSelf)) fail("correlation_insufficient", "F0 artifacts fail exact deterministic binding", { shared, callArguments, callResult, network, tokenSelf });
  const relations = [
    { from: task.fixtureArtifactId, to: boundary.fixtureArtifactId, relationType: "candidate_same_action", basis: "deterministic_binding" },
    { from: call.fixtureArtifactId, to: boundary.fixtureArtifactId, relationType: "candidate_same_action", basis: "deterministic_binding" },
    { from: result.fixtureArtifactId, to: call.fixtureArtifactId, relationType: "source_declared_result_for", basis: "source_declared_binding" },
    { from: boundary.fixtureArtifactId, to: ne.fixtureArtifactId, relationType: "candidate_same_action", basis: "deterministic_binding" }
  ];
  const artifactIds = createSafeArray();
  for (let index = 0; index < REQUIRED.length; index += 1) appendOwn(artifactIds, records[REQUIRED[index]].value.fixtureArtifactId);
  for (let left = 0; left < artifactIds.length; left += 1) {
    for (let right = left + 1; right < artifactIds.length; right += 1) {
      if (artifactIds[left] === artifactIds[right]) fail("correlation_ambiguous", "duplicate artifact identifiers make relation endpoints ambiguous");
    }
  }
  return validateRelations(relations, artifactIds);
}

export const H1_REQUIRED_ARTIFACTS = REQUIRED;
export function parseVerifiedJson(input) {
  return runBoundary(
    () => parseVerifiedJsonInternal(input),
    "schema_validation_failed",
    "H1 parser rejected untrusted input access"
  );
}

export function validateRelations(relations, artifactIds) {
  return runBoundary(
    () => validateRelationsInternal(relations, artifactIds),
    "relation_invalid",
    "relation validation rejected untrusted input access"
  );
}

export function correlateF0(parsedByName) {
  return runBoundary(
    () => correlateF0Internal(parsedByName),
    "correlation_insufficient",
    "correlation rejected untrusted input access"
  );
}
