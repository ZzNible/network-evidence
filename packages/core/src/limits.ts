/**
 * Explicit, versioned v0.1 resource bounds (`nec-resource-limits-v0.1`).
 *
 * No NEC input may be unbounded in depth, width, or size: every bound below
 * is enforced BEFORE uncontrolled recursion or allocation happens (in the
 * canonicalizer, the defensive cloner and the validation walk). Exceeding a
 * bound throws a NEC-specific controlled error
 * (`NecCanonicalizationError` / `NecValidationError` / `NecWireError`) —
 * never a RangeError, stack overflow, or OOM condition.
 *
 * Changing any limit is a profile version bump, never a silent change.
 */
export const RESOURCE_LIMITS_PROFILE = "nec-resource-limits-v0.1";export const RESOURCE_LIMITS: Readonly<{
  /** Maximum nesting depth of values (root value counts as depth 1). */
  readonly MAX_DEPTH: 64;
  /** Maximum total number of values (nodes) in one input tree. */
  readonly MAX_TOTAL_NODES: 50_000;
  /** Maximum entries (array elements / object keys) per container. */
  readonly MAX_CONTAINER_ENTRIES: 10_000;
  /** Maximum UTF-8 byte length of a single string value. */
  readonly MAX_STRING_UTF8_BYTES: 1_048_576;
  /** Maximum UTF-8 byte length of one canonical serialization / wire document. */
  readonly MAX_CANONICAL_BYTES: 8_388_608;
  /** Maximum UTF-8 byte length of generic identifier-ish strings. */
  readonly MAX_ID_UTF8_BYTES: 256;
  /** Maximum UTF-8 byte length of network identifiers. */
  readonly MAX_NETWORK_ID_UTF8_BYTES: 128;
  /** Maximum UTF-8 byte length of opaque network-native identifiers. */
  readonly MAX_NATIVE_ID_UTF8_BYTES: 512;
  /** Maximum DECODED byte size of one native source payload. */
  readonly MAX_NATIVE_SOURCE_PAYLOAD_BYTES: 262_144;
}> = Object.freeze({
  MAX_DEPTH: 64,
  MAX_TOTAL_NODES: 50_000,
  MAX_CONTAINER_ENTRIES: 10_000,
  MAX_STRING_UTF8_BYTES: 1_048_576,
  MAX_CANONICAL_BYTES: 8_388_608,
  MAX_ID_UTF8_BYTES: 256,
  MAX_NETWORK_ID_UTF8_BYTES: 128,
  MAX_NATIVE_ID_UTF8_BYTES: 512,
  MAX_NATIVE_SOURCE_PAYLOAD_BYTES: 262_144,
});

/**
 * Maximum DECIMAL DIGITS of one schema-typed integer quantity (currently
 * every `blockNumber`). ONE rule, applied symmetrically at every boundary:
 *
 *   - runtime bigint validation (`assertBlockNumber`),
 *   - wire encode (bigint -> decimal string),
 *   - wire decode (decimal string -> bigint).
 *
 * The bound exists so no runtime can accept an integer that the wire
 * profile would reject (or vice versa). It is deliberately NOT applied to
 * arbitrary ordinary decimal strings or to generic canonical JSON values:
 * only schema-declared integer quantities carry it. Changing the value is a
 * profile version bump, never a silent change.
 */
export const MAX_DECIMAL_INTEGER_DIGITS: 1000 = 1000;
