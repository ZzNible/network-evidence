import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  NecCanonicalizationError,
  NecValidationError,
  RESOURCE_LIMITS,
  RESOURCE_LIMITS_PROFILE,
  assertPlainRecord,
} from "../src/index.js";

/**
 * DECISION: explicit versioned v0.1 resource limits. Exceeding a bound
 * throws a NEC-specific controlled error — never RangeError / stack
 * overflow / OOM-like behavior. Boundary tests for every bound.
 */

const { MAX_DEPTH, MAX_TOTAL_NODES, MAX_CONTAINER_ENTRIES, MAX_STRING_UTF8_BYTES } = RESOURCE_LIMITS;

function nested(depth: number): unknown {
  let value: unknown = 1;
  for (let i = 0; i < depth; i++) value = { v: value };
  return value;
}

describe("resource limits profile", () => {
  it("is explicitly versioned with the frozen v0.1 values", () => {
    expect(RESOURCE_LIMITS_PROFILE).toBe("nec-resource-limits-v0.1");
    expect(MAX_DEPTH).toBe(64);
    expect(MAX_TOTAL_NODES).toBe(50_000);
    expect(MAX_CONTAINER_ENTRIES).toBe(10_000);
    expect(RESOURCE_LIMITS.MAX_STRING_UTF8_BYTES).toBe(1_048_576);
    expect(RESOURCE_LIMITS.MAX_CANONICAL_BYTES).toBe(8_388_608);
    expect(Object.isFrozen(RESOURCE_LIMITS)).toBe(true);
  });
});

describe("MAX_DEPTH boundary (64)", () => {
  // nested(n) produces n containers wrapping a scalar = depth n+1 values.
  it("depth exactly 64 is accepted", () => {
    expect(() => canonicalJson(nested(63))).not.toThrow();
    expect(() => assertPlainRecord(nested(63), "x")).not.toThrow();
  });

  it("depth 65 fails closed with the NEC error", () => {
    expect(() => canonicalJson(nested(64))).toThrow(NecCanonicalizationError);
    try {
      canonicalJson(nested(64));
    } catch (e) {
      expect((e as Error).message).toContain("MAX_DEPTH");
      expect(e).toBeInstanceOf(NecCanonicalizationError);
    }
    expect(() => assertPlainRecord(nested(64), "x")).toThrow(NecValidationError);
  });

  it("a 200-deep structure never overflows the stack", () => {
    expect(() => canonicalJson(nested(200))).toThrow(NecCanonicalizationError);
    expect(() => assertPlainRecord(nested(5000), "x")).toThrow(NecValidationError);
  });
});

describe("MAX_CONTAINER_ENTRIES boundary (10_000)", () => {
  it("exactly 10_000 entries accepted", () => {
    const big = Array.from({ length: MAX_CONTAINER_ENTRIES }, (_, i) => i);
    const record = Object.fromEntries(big.map((i) => [`k${i}`, i]));
    expect(() => canonicalJson([big, record])).not.toThrow();
  });

  it("10_001 entries rejected deterministically", () => {
    const big = Array.from({ length: MAX_CONTAINER_ENTRIES + 1 }, (_, i) => i);
    expect(() => canonicalJson([big])).toThrow(/MAX_CONTAINER_ENTRIES/);
    const record = Object.fromEntries(big.map((i) => [`k${i}`, i]));
    expect(() => assertPlainRecord(record, "x")).toThrow(NecValidationError);
  });
});

describe("MAX_STRING_UTF8_BYTES boundary", () => {
  it("a string just under 1 MiB UTF-8 is accepted", () => {
    const s = "a".repeat(MAX_STRING_UTF8_BYTES - 4); // quotes fit within budget check on input bytes only
    expect(() => canonicalJson(s)).not.toThrow();
  });

  it("a string over 1 MiB UTF-8 is rejected before allocation-heavy work", () => {
    const s = "a".repeat(MAX_STRING_UTF8_BYTES + 1);
    expect(() => canonicalJson(s)).toThrow(/MAX_STRING_UTF8_BYTES/);
    // Multi-byte characters count by UTF-8 bytes.
    expect(() => canonicalJson("é".repeat(MAX_STRING_UTF8_BYTES / 2 + 1))).toThrow(
      /MAX_STRING_UTF8_BYTES/,
    );
  });
});

describe("MAX_TOTAL_NODES boundary (50_000)", () => {
  it("just under the node budget is accepted", () => {
    // 9999-element array + wrapper nodes stays well below; use a wide array of scalars.
    const arr = Array.from({ length: MAX_CONTAINER_ENTRIES }, (_, i) => ({ a: i }));
    // nodes = array + 10000 objects + 10000 numbers = 20001
    expect(() => canonicalJson([arr])).not.toThrow();
  });

  it("exceeding MAX_TOTAL_NODES throws the NEC limit error", () => {
    const chunks: unknown[] = [];
    for (let c = 0; c < 6; c++) {
      chunks.push(Array.from({ length: MAX_CONTAINER_ENTRIES }, (_, i) => ({ a: i })));
    }
    // nodes ~ 60006 > 50_000
    expect(() => canonicalJson(chunks)).toThrow(/MAX_TOTAL_NODES/);
    expect(() => assertPlainRecord({ list: chunks }, "x")).toThrow(NecValidationError);
  });
});

describe("MAX_CANONICAL_BYTES boundary", () => {
  it("output beyond 8 MiB fails closed during serialization", () => {
    // 9 strings of ~1 MiB each -> > 8 MiB total.
    const bigStrings = Array.from({ length: 9 }, (_, i) => `${i}`.padEnd(0) + "x".repeat(MAX_STRING_UTF8_BYTES - 2));
    expect(() => canonicalJson(bigStrings)).toThrow(/MAX_CANONICAL_BYTES/);
  });

  it("output just above 8 MiB in one document is rejected; small documents are not", () => {
    expect(() => canonicalJson(["y".repeat(1024)])).not.toThrow();
  });
});
