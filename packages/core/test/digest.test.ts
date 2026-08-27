import { describe, expect, it } from "vitest";

import {
  DIGEST_DOMAINS,
  DIGEST_PROFILE,
  NecDigestError,
  canonicalJson,
  digestBytes,
  digestCanonicalJson,
  isDigest,
} from "../src/index.js";

const VALID = `sha256:${"a".repeat(64)}`;

describe("nec-digest-v1", () => {
  it("has an explicit profile identity and sha256 output format", () => {
    expect(DIGEST_PROFILE).toBe("nec-digest-v1");
    const d = digestCanonicalJson(DIGEST_DOMAINS.networkEvidenceResultSemantic, { x: 1 });
    expect(d).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("is deterministic for equivalent inputs", () => {
    const a = digestCanonicalJson(DIGEST_DOMAINS.evidencePolicy, { b: 2, a: 1 });
    const b = digestCanonicalJson(DIGEST_DOMAINS.evidencePolicy, { a: 1, b: 2 });
    expect(a).toBe(b);
  });

  it("differs for semantically different inputs", () => {
    const a = digestCanonicalJson(DIGEST_DOMAINS.evidencePolicy, { amount: "10000000" });
    const b = digestCanonicalJson(DIGEST_DOMAINS.evidencePolicy, { amount: "9000000" });
    const c = digestCanonicalJson(DIGEST_DOMAINS.evidencePolicy, {
      amount: "10000000",
      extra: true,
    });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it("distinguishes numeric value from decimal string (bigint vs string)", () => {
    // Integer tokens are unquoted; strings are quoted. Different bytes, different digests.
    expect(canonicalJson(123n)).not.toBe(canonicalJson("123"));
    expect(
      digestCanonicalJson(DIGEST_DOMAINS.evidenceRef, { blockNumber: 5n }),
    ).not.toBe(digestCanonicalJson(DIGEST_DOMAINS.evidenceRef, { blockNumber: "5" }));
  });

  it("enforces domain separation", () => {
    const payload = { same: "payload" };
    const digests = Object.values(DIGEST_DOMAINS).map((domain) =>
      digestCanonicalJson(domain, payload),
    );
    expect(new Set(digests).size).toBe(digests.length);
    // Unknown domains are allowed but must be well-formed identifiers.
    expect(digestCanonicalJson("custom.domain_1", payload)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(() => digestCanonicalJson("Bad Domain", payload)).toThrow(NecDigestError);
    expect(() => digestCanonicalJson("", payload)).toThrow(NecDigestError);
  });

  it("length-paints the preimage to prevent concatenation ambiguity", () => {
    // {"a":"x"} vs {"a":"x"} split differently can never collide because
    // byte length is part of the preimage; verify distinct payloads differ
    // even when one is a prefix of the other.
    const short = digestBytes("test", new TextEncoder().encode("abc"));
    const long = digestBytes("test", new TextEncoder().encode("abcdef"));
    expect(short).not.toBe(long);
    // Same payload in different domains differs (header participates).
    expect(digestBytes("test", new TextEncoder().encode("abc"))).not.toBe(
      digestBytes("test2", new TextEncoder().encode("abc")),
    );
  });

  it("rejects non-canonicalizable payloads", () => {
    expect(() => digestCanonicalJson(DIGEST_DOMAINS.evidenceRef, { x: undefined })).toThrow();
    expect(() => digestCanonicalJson(DIGEST_DOMAINS.evidenceRef, { x: Number.NaN })).toThrow();
  });

  it("isDigest accepts only exact NEC digest shape and fails closed otherwise", () => {
    expect(isDigest(VALID)).toBe(true);
    expect(isDigest(`sha256:${"A".repeat(64)}`)).toBe(false); // uppercase rejected
    expect(isDigest(`md5:${"a".repeat(32)}`)).toBe(false);
    expect(isDigest(`sha256:${"g".repeat(64)}`)).toBe(false);
    expect(isDigest(`sha256:${"a".repeat(63)}`)).toBe(false);
    expect(isDigest("sha256:")).toBe(false);
    expect(isDigest(undefined)).toBe(false);
  });
});
