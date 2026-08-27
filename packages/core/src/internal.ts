/**
 * Internal helpers shared across modules. Not public API.
 */

import { NecValidationError } from "./errors.js";
import { RESOURCE_LIMITS } from "./limits.js";

/** Deterministic UTF-16 code-unit comparison; identical ordering to canonical key sort. */
export function compareUtf16(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Exact UTF-8 byte length of a JS string (surrogate-aware, no allocation). */
export function utf8ByteLength(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) {
      bytes += 1;
    } else if (c < 0x800) {
      bytes += 2;
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        bytes += 4;
        i++;
      } else {
        bytes += 3; // unpaired high surrogate (U+FFFD-encoded on transport)
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/** True iff the string contains no unpaired UTF-16 surrogate code unit. */
export function isWellFormedString(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      if (i + 1 >= s.length) return false;
      const d = s.charCodeAt(i + 1);
      if (d < 0xdc00 || d > 0xdfff) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// ONE inert-array model (`nec-resource-limits-v0.1` accepted array domain)
// ---------------------------------------------------------------------------

const ARRAY_INDEX_KEY_PATTERN = /^(0|[1-9][0-9]*)$/;

/**
 * THE single descriptor-first acceptance model for NEC arrays, shared by
 * validation, canonicalization, defensive cloning, ordering and digest
 * normalization.
 *
 * An accepted ("inert") array is an ordinary dense array:
 *   - prototype EXACTLY `Array.prototype` (subclasses / overridden
 *     prototypes fail closed);
 *   - dense indexes 0..length-1, each an OWN enumerable DATA property;
 *   - NO accessor indexes (getters/setters are never invoked — checks read
 *     property DESCRIPTORS only);
 *   - no sparse holes;
 *   - no extra own string properties;
 *   - no own symbol properties (an own `Symbol.iterator` override is a
 *     symbol-keyed property and fails closed);
 *   - the `length` own property is an ORDINARY array length binding: a
 *     non-enumerable, NON-CONFIGURABLE data property holding a safe
 *     non-negative integer — never an accessor or a reconfigured exotic
 *     descriptor. (`writable: false` occurs only in the standard frozen
 *     state produced by `Object.freeze`; anything else fails closed.)
 *
 * The returned string describes the FIRST deviation, or null when the array
 * is inert. Callers turn it into their own profile-specific controlled
 * error. Traversal itself must be done with plain index loops afterwards —
 * never through `map`/`forEach`/iterators/`entries()` of the input, which
 * remain caller-controlled until this predicate has passed.
 */
export function firstArrayDeviation(value: unknown): string | null {
  if (!Array.isArray(value)) return "must be an array";
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Array.prototype) {
    return "array prototype is not exactly Array.prototype (subclasses and overridden prototypes are not allowed)";
  }
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
  let indexCount = 0;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key === "symbol") {
      return `symbol-keyed array properties (including own Symbol.iterator overrides) are not allowed (${String(key)})`;
    }
    if (key === "length") continue;
    const d = descriptors[key]!;
    if (!d.enumerable || d.get !== undefined || d.set !== undefined) {
      return `array property "${key}" must be a plain enumerable data property`;
    }
    if (!ARRAY_INDEX_KEY_PATTERN.test(key)) {
      return `arrays with extra own properties (${JSON.stringify(key)}) are not allowed`;
    }
    indexCount += 1;
  }
  const lengthDescriptor = descriptors["length"];
  if (
    lengthDescriptor === undefined ||
    lengthDescriptor.get !== undefined ||
    lengthDescriptor.set !== undefined ||
    lengthDescriptor.enumerable ||
    lengthDescriptor.configurable ||
    typeof lengthDescriptor.value !== "number" ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0
  ) {
    return 'array "length" is not the ordinary array length binding (non-enumerable, non-configurable data property)';
  }
  if (indexCount !== lengthDescriptor.value) {
    return "sparse/holey arrays are not allowed";
  }
  if (lengthDescriptor.value > RESOURCE_LIMITS.MAX_CONTAINER_ENTRIES) {
    return `array exceeds MAX_CONTAINER_ENTRIES (${RESOURCE_LIMITS.MAX_CONTAINER_ENTRIES} entries)`;
  }
  return null;
}

/** `firstArrayDeviation` as a controlled `NecValidationError` (fail closed). */
export function assertInertArray(value: unknown, path: string): asserts value is unknown[] {
  const deviation = firstArrayDeviation(value);
  if (deviation !== null) {
    throw new NecValidationError("NEC_VALIDATION_FAILED", `${path}: ${deviation}`);
  }
}

/**
 * Descriptor/index based element access for INERT arrays: returns the entry
 * values WITHOUT touching `Symbol.iterator`, `entries()`, `map()` or any
 * other caller-overridable traversal surface.
 */
export function inertArrayElements(value: readonly unknown[]): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i < value.length; i++) {
    out.push(Object.getOwnPropertyDescriptor(value, i)?.value);
  }
  return out;
}
