import { createHash } from "node:crypto";

import { DIGEST_DOMAINS } from "./digest.js";
import { NecValidationError } from "./errors.js";
import { RESOURCE_LIMITS } from "./limits.js";
import type { Digest, NativeSourcePayload } from "./types.js";

/**
 * Source-native payload boundary (`NativeSourcePayload`).
 *
 * NEC metadata must never create or interpret confidence / trustScore /
 * securityScore / probability as NEC scores. Exact source-native content may
 * legitimately contain such names — it travels as OPAQUE base64 bytes here:
 *   - NEC does not parse the inner semantic fields;
 *   - `contentDigest` binds the DECODED exact bytes under the explicit
 *     `native-source-payload` domain;
 *   - the wrapper itself is an ordinary validated contract field and is
 *     therefore part of artifact/digest binding;
 *   - decoded size is bounded by MAX_NATIVE_SOURCE_PAYLOAD_BYTES.
 */

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * THE one documented decoded-byte limit for native payloads:
 * `RESOURCE_LIMITS.MAX_NATIVE_SOURCE_PAYLOAD_BYTES`. The ENCODED length is
 * checked BEFORE any decoded bytes are allocated (every 4 base64 chars
 * decode to at most 3 bytes); the exact DECODED length is verified after
 * allocation. Oversized input therefore never triggers a large allocation
 * just to be rejected.
 */
function fail(path: string, reason: string): never {
  throw new NecValidationError("NEC_VALIDATION_FAILED", `${path}: ${reason}`);
}

/** Upper bound on the encoded length that could still decode within budget. */
const MAX_ENCODED_BASE64_LENGTH = Math.ceil(RESOURCE_LIMITS.MAX_NATIVE_SOURCE_PAYLOAD_BYTES / 3) * 4;

/**
 * Strict canonical base64 decode: standard alphabet only, correct padding,
 * no whitespace, no url-safe characters, zero trailing bits. Returns the
 * decoded bytes.
 */
export function decodeBase64Strict(value: unknown, path: string): Uint8Array {
  if (typeof value !== "string") {
    fail(path, "payload must be a base64 string");
  }
  // Pre-allocation bound: reject oversized ENCODED input before any decoded
  // buffer is allocated.
  if (value.length > MAX_ENCODED_BASE64_LENGTH) {
    fail(
      path,
      `payload exceeds MAX_NATIVE_SOURCE_PAYLOAD_BYTES (${RESOURCE_LIMITS.MAX_NATIVE_SOURCE_PAYLOAD_BYTES} decoded bytes); encoded length bound exceeded before allocation`,
    );
  }
  if (!BASE64_PATTERN.test(value)) {
    fail(path, "payload is not canonical base64 (standard alphabet, correct padding)");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) {
    fail(path, "payload has non-zero trailing padding bits; canonical base64 required");
  }
  // Authoritative post-decode verification of the documented byte limit.
  if (bytes.length > RESOURCE_LIMITS.MAX_NATIVE_SOURCE_PAYLOAD_BYTES) {
    fail(
      path,
      `decoded payload exceeds MAX_NATIVE_SOURCE_PAYLOAD_BYTES (${RESOURCE_LIMITS.MAX_NATIVE_SOURCE_PAYLOAD_BYTES} bytes)`,
    );
  }
  return new Uint8Array(bytes);
}

/** Digest of exact decoded native-payload bytes under the dedicated domain. */
export function nativeSourceContentDigest(bytes: Uint8Array): Digest {
  const header = `nec-digest-v1\n${DIGEST_DOMAINS.nativeSourcePayload}\n${bytes.length}\n`;
  const hash = createHash("sha256");
  hash.update(header, "utf8");
  hash.update(bytes);
  return `sha256:${hash.digest("hex")}`;
}

/**
 * Verify that a native payload's declared `contentDigest` matches the exact
 * decoded bytes. Throws `NecValidationError` on any mismatch.
 */
export function verifyNativeSourceDigest(payload: NativeSourcePayload, path: string): void {
  const bytes = decodeBase64Strict(payload.payload, `${path}.payload`);
  const expected = nativeSourceContentDigest(bytes);
  if (payload.contentDigest !== expected) {
    fail(
      `${path}.contentDigest`,
      "does not bind the decoded native payload bytes (tampered or mis-declared content)",
    );
  }
}
