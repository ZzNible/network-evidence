import { NecCanonicalizationError } from "./errors.js";
import { compareUtf16, firstArrayDeviation, isWellFormedString, utf8ByteLength } from "./internal.js";
import { RESOURCE_LIMITS } from "./limits.js";

/**
 * `nec-canonical-json-v1` — INTERNAL canonicalization profile for NEC digests.
 *
 * This is NOT RFC 8785/JCS and must never be labeled as such. It is a
 * deliberately narrow, explicitly versioned profile whose only goal is that
 * equivalent inputs produce byte-identical output and everything else fails
 * closed.
 *
 * Accepted input domain:
 *   - null
 *   - boolean            -> "true" | "false"
 *   - number             -> accepted ONLY if Number.isSafeInteger and not -0;
 *                           serialized as decimal integer token.
 *                           NaN, ±Infinity, non-integers, unsafe magnitudes
 *                           and -0 are rejected (use bigint or string).
 *   - bigint             -> decimal integer token, arbitrary magnitude.
 *                           A bigint and a number with equal numeric value
 *                           intentionally produce identical tokens. (bigint
 *                           is for schema-declared integer quantities in
 *                           digest binding; GENERIC NEC data such as
 *                           metadata rejects bigint — see `nec-wire-json-v1`.)
 *   - string             -> JSON string escaping exactly as JSON.stringify.
 *                           No Unicode normalization. Strings containing
 *                           unpaired UTF-16 surrogates are REJECTED: their
 *                           UTF-8 encoding would be lossy and runtime
 *                           dependent.
 *   - array              -> DENSE arrays with prototype exactly
 *                           Array.prototype; order preserved; elements
 *                           canonicalized. Holes, extra own properties,
 *                           accessors, symbols and subclasses fail closed.
 *   - plain object       -> prototype Object.prototype or null; keys sorted
 *                           by UTF-16 code-unit order; descriptor-first
 *                           traversal (values are read from property
 *                           descriptors, never through getters). Symbol-keyed,
 *                           accessor and non-enumerable properties rejected.
 *
 * Resource bounds (`nec-resource-limits-v0.1`) are enforced during traversal:
 * depth <= 64, total nodes <= 50_000, container entries <= 10_000, single
 * strings <= 1 MiB UTF-8, total canonical output <= 8 MiB UTF-8.
 *
 * Output: compact JSON text (no whitespace), UTF-8 encoded by
 * `canonicalJsonBytes`.
 */

export const CANONICAL_JSON_PROFILE = "nec-canonical-json-v1";

const {
  MAX_DEPTH,
  MAX_TOTAL_NODES,
  MAX_CONTAINER_ENTRIES,
  MAX_STRING_UTF8_BYTES,
  MAX_CANONICAL_BYTES,
} = RESOURCE_LIMITS;

interface SerializeState {
  readonly ancestors: Set<object>;
  nodes: number;
  bytes: number;
}

function fail(reason: string): never {
  throw new NecCanonicalizationError("NEC_CANONICAL_UNSUPPORTED_VALUE", reason);
}

function limitFail(limit: string, reason: string): never {
  throw new NecCanonicalizationError("NEC_CANONICAL_LIMIT_EXCEEDED", `${limit}: ${reason}`);
}

function addBytes(state: SerializeState, count: number): void {
  state.bytes += count;
  if (state.bytes > MAX_CANONICAL_BYTES) {
    limitFail("MAX_CANONICAL_BYTES", `canonical output exceeds ${MAX_CANONICAL_BYTES} bytes`);
  }
}

function serializeNumber(value: number): string {
  if (!Number.isSafeInteger(value)) {
    if (Number.isNaN(value) || !Number.isFinite(value)) {
      fail(`number ${String(value)} is not a finite value`);
    }
    fail(
      `number ${String(value)} is not a safe integer; use bigint or a decimal string instead`,
    );
  }
  if (Object.is(value, -0)) {
    fail("number -0 is not deterministic; use 0");
  }
  return String(value);
}

function serializeStringToken(value: string, state: SerializeState): string {
  if (!isWellFormedString(value)) {
    fail("string contains an unpaired UTF-16 surrogate; losslessly unrepresentable");
  }
  const inputBytes = utf8ByteLength(value);
  if (inputBytes > MAX_STRING_UTF8_BYTES) {
    limitFail("MAX_STRING_UTF8_BYTES", `string exceeds ${MAX_STRING_UTF8_BYTES} UTF-8 bytes`);
  }
  const token = JSON.stringify(value);
  addBytes(state, utf8ByteLength(token));
  return token;
}

function enter(state: SerializeState, depth: number): void {
  if (depth > MAX_DEPTH) {
    limitFail("MAX_DEPTH", `input exceeds maximum depth of ${MAX_DEPTH}`);
  }
  state.nodes += 1;
  if (state.nodes > MAX_TOTAL_NODES) {
    limitFail("MAX_TOTAL_NODES", `input exceeds ${MAX_TOTAL_NODES} values`);
  }
}

function serializeArray(
  value: readonly unknown[],
  depth: number,
  state: SerializeState,
): string {
  // THE shared inert-array model (see internal.ts): one descriptor-first
  // acceptance predicate for every traversal surface. No element value is
  // read before the layout has passed.
  const deviation = firstArrayDeviation(value);
  if (deviation !== null) {
    fail(deviation);
  }
  state.ancestors.add(value);
  try {
    const parts: string[] = [];
    for (let i = 0; i < value.length; i++) {
      const d = Object.getOwnPropertyDescriptor(value, i);
      if (d === undefined) {
        fail("sparse/holey arrays are not serializable");
      }
      parts.push(serialize(d.value, depth + 1, state));
    }
    addBytes(state, 2); // brackets
    if (parts.length > 1) addBytes(state, parts.length - 1); // commas
    return `[${parts.join(",")}]`;
  } finally {
    state.ancestors.delete(value);
  }
}

function serializeObject(value: object, depth: number, state: SerializeState): string {
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    // R3: prototype validation uses INERT prototype identity only. Reading
    // `value.constructor` (or any other prototype-chain member) to format an
    // error would execute caller-controlled getters; custom prototypes are
    // rejected with a GENERIC NEC validation message instead.
    fail("unsupported object instance; only plain objects are serializable");
  }
  // Descriptor-first traversal: property values are read exclusively from
  // data descriptors, so no getter is ever executed.
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
    string,
    PropertyDescriptor
  >;
  const keys: string[] = [];
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key === "symbol") {
      fail(`symbol-keyed properties are not serializable (${String(key)})`);
    }
    const d = descriptors[key]!;
    if (d.get !== undefined || d.set !== undefined) {
      fail(`property "${key}" is an accessor; refusing to invoke it`);
    }
    if (!d.enumerable) {
      fail(`property "${key}" is non-enumerable`);
    }
    keys.push(key);
  }
  if (keys.length > MAX_CONTAINER_ENTRIES) {
    limitFail("MAX_CONTAINER_ENTRIES", `object has ${keys.length} entries`);
  }
  keys.sort(compareUtf16);
  state.ancestors.add(value);
  try {
    const parts: string[] = [];
    for (const key of keys) {
      const propertyValue: unknown = descriptors[key]!.value;
      if (propertyValue === undefined) {
        fail(`property "${key}" has value undefined`);
      }
      const keyToken = serializeStringToken(key, state);
      addBytes(state, 1); // colon
      parts.push(`${keyToken}:${serialize(propertyValue, depth + 1, state)}`);
    }
    addBytes(state, 2); // braces
    if (parts.length > 1) addBytes(state, parts.length - 1); // commas
    return `{${parts.join(",")}}`;
  } finally {
    state.ancestors.delete(value);
  }
}

function serialize(value: unknown, depth: number, state: SerializeState): string {
  enter(state, depth);
  switch (typeof value) {
    case "boolean":
      addBytes(state, value ? 4 : 5);
      return value ? "true" : "false";
    case "string":
      return serializeStringToken(value, state);
    case "number": {
      const token = serializeNumber(value);
      addBytes(state, token.length);
      return token;
    }
    case "bigint": {
      const token = value.toString();
      addBytes(state, token.length);
      return token;
    }
    case "undefined":
      fail("undefined is not serializable");
      break; // unreachable
    case "function":
      fail("functions are not serializable");
      break; // unreachable
    case "object": {
      if (value === null) {
        addBytes(state, 4);
        return "null";
      }
      if (state.ancestors.has(value)) {
        fail("circular reference detected");
      }
      if (Array.isArray(value)) {
        return serializeArray(value, depth, state);
      }
      return serializeObject(value, depth, state);
    }
    default:
      fail(`unsupported value type: ${typeof value}`);
  }
}

/**
 * Canonicalize a value to deterministic JSON text under
 * `nec-canonical-json-v1`. Throws `NecCanonicalizationError` for anything
 * outside the profile's input domain or beyond the v0.1 resource limits.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, 1, { ancestors: new Set(), nodes: 0, bytes: 0 });
}

/** UTF-8 bytes of `canonicalJson(value)`. */
export function canonicalJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

/**
 * Validation-only walk: throws iff `canonicalJson` would throw. Useful to
 * reject non-deterministic payloads before they enter a result structure.
 */
export function assertCanonicalizable(value: unknown): void {
  canonicalJson(value);
}
