import { describe, expect, it } from "vitest";

import {
  decodeBase64Strict,
  nativeSourceContentDigest,
  NecValidationError,
  validateEvidenceRef,
  validateNativeSourcePayload,
  verifyNativeSourceDigest,
} from "../src/index.js";
import type { NativeSourcePayload } from "../src/index.js";
import { evidenceRef } from "./fixtures.js";

/**
 * DECISION: source-native payload boundary. NEC metadata must never create
 * or interpret confidence/trustScore/securityScore/probability as NEC
 * scores; exact source-native content may contain such names and travels as
 * opaque base64 bytes whose digest binds the DECODED bytes.
 */

function nativePayload(json: unknown): NativeSourcePayload {
  const bytes = new TextEncoder().encode(JSON.stringify(json));
  return {
    namespace: "vendor.receipt",
    mediaType: "application/json",
    encoding: "base64",
    payload: Buffer.from(bytes).toString("base64"),
    contentDigest: nativeSourceContentDigest(bytes),
  };
}

describe("opaque native source payload", () => {
  it("source bytes containing the literal word 'confidence' round-trip and stay digest-bound", () => {
    const payload = nativePayload({
      confidence: 0.87,
      trustScore: "high",
      probability: { nested: [1, 2] },
      note: "the word confidence appears here",
    });
    // NEC validates the wrapper, never the inner semantic fields.
    expect(() => validateNativeSourcePayload(payload)).not.toThrow();

    const ref = evidenceRef({ nativeSource: payload });
    expect(() => validateEvidenceRef(ref)).not.toThrow();

    // Exact bytes survive: base64 -> decode -> identical JSON.
    const decoded = JSON.parse(Buffer.from(payload.payload, "base64").toString("utf8"));
    expect(decoded).toEqual({
      confidence: 0.87,
      trustScore: "high",
      probability: { nested: [1, 2] },
      note: "the word confidence appears here",
    });
  });

  it("contentDigest binds the DECODED exact bytes; tampering fails closed", () => {
    const payload = nativePayload({ confidence: 0.9 });
    const tampered: NativeSourcePayload = {
      ...payload,
      payload: Buffer.from(JSON.stringify({ confidence: 0.99 })).toString("base64"),
    };
    expect(() => validateNativeSourcePayload(tampered)).toThrow(/does not bind the decoded/);

    // Even a single trailing byte changes the digest.
    const extended = Buffer.from(payload.payload, "base64");
    const bigger = new Uint8Array(extended.length + 1);
    bigger.set(extended, 0);
    bigger[extended.length] = 0x0a;
    expect(nativeSourceContentDigest(bigger)).not.toBe(payload.contentDigest);
  });

  it("strict canonical base64 only", () => {
    const ok = Buffer.from("hello").toString("base64"); // aGVsbG8=
    expect(() => decodeBase64Strict(ok, "p")).not.toThrow();
    expect(() => decodeBase64Strict("aGVsbG8", "p")).toThrow(/canonical base64/); // missing padding
    expect(() => decodeBase64Strict("aGVs bG8=", "p")).toThrow(/canonical base64/); // whitespace
    expect(() => decodeBase64Strict("aGVs-bG8=", "p")).toThrow(/canonical base64/); // url-safe char
    expect(() => decodeBase64Strict("ab==", "p")).toThrow(); // invalid length
    // Non-zero trailing padding bits are rejected.
    expect(() => decodeBase64Strict("Zh==", "p")).toThrow(/trailing padding bits/);
    expect(() => decodeBase64Strict(42, "p")).toThrow(NecValidationError);
  });

  it("decoded size is bounded (MAX_NATIVE_SOURCE_PAYLOAD_BYTES)", () => {
    const big = Buffer.alloc(262_145, 7); // one byte over the bound
    const encoded = big.toString("base64");
    expect(() => decodeBase64Strict(encoded, "p")).toThrow(/MAX_NATIVE_SOURCE_PAYLOAD_BYTES/);
  });

  it("wrapper fields are validated; ordinary NEC metadata still rejects reserved score keys", () => {
    const payload = nativePayload({ ok: true });
    expect(() =>
      validateNativeSourcePayload({ ...payload, namespace: "BAD NAMESPACE" }),
    ).toThrow(/namespace/);
    expect(() => validateNativeSourcePayload({ ...payload, mediaType: "noslash" })).toThrow(/mediaType/);
    expect(() =>
      validateNativeSourcePayload({ ...payload, encoding: "hex" as never }),
    ).toThrow(/encoding/);

    // Reserved keys remain rejected in ordinary metadata.
    const ref = evidenceRef({ metadata: { confidence: 0.5 } });
    expect(() => validateEvidenceRef(ref)).toThrow(/reserved key "confidence"/);
  });

  it("verifyNativeSourceDigest is a standalone integrity check", () => {
    const payload = nativePayload({ x: 1 });
    expect(() => verifyNativeSourceDigest(payload, "p")).not.toThrow();
    expect(() =>
      verifyNativeSourceDigest({ ...payload, contentDigest: `sha256:${"00".repeat(32)}` }, "p"),
    ).toThrow(/does not bind/);
  });
});
