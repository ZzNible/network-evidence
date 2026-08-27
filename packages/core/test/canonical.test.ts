import { describe, expect, it } from "vitest";

import {
  CANONICAL_JSON_PROFILE,
  NecCanonicalizationError,
  assertCanonicalizable,
  canonicalJson,
  canonicalJsonBytes,
} from "../src/index.js";

function expectRejected(value: unknown): void {
  expect(() => canonicalJson(value)).toThrow(NecCanonicalizationError);
}

describe("nec-canonical-json-v1", () => {
  it("has an explicit profile identity", () => {
    expect(CANONICAL_JSON_PROFILE).toBe("nec-canonical-json-v1");
  });

  it("sorts object keys by UTF-16 code-unit order regardless of insertion order", () => {
    const a = { b: 1, a: 2, C: 3, "0": 4, _: 5 };
    const b = { _: 5, "0": 4, C: 3, a: 2, b: 1 };
    expect(canonicalJson(a)).toBe('{"0":4,"C":3,"_":5,"a":2,"b":1}');
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it("preserves array element order", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalJson([{ z: 1 }, { a: [true, null] }])).toBe('[{"z":1},{"a":[true,null]}]');
  });

  it("escapes strings deterministically and performs no Unicode normalization", () => {
    // NFC vs NFD forms of é must stay distinct (no normalization).
    expect(canonicalJson("\u00e9")).not.toBe(canonicalJson("e\u0301"));
    expect(canonicalJson('q"uote\nnewline\ttab\u0000')).toBe(
      '"q\\"uote\\nnewline\\ttab\\u0000"',
    );
  });

  it("REJECTS unpaired Unicode surrogates (lossy UTF-8 otherwise)", () => {
    expectRejected("lone\ud800surrogate");
    expectRejected("lone\udfffsurrogate");
    expectRejected({ k: "\ud800" });
    // Paired surrogates remain fine (emitted as the literal pair).
    expect(canonicalJson("😀")).toBe('"😀"');
    expect(canonicalJson("\ud800\udc00")).toBe('"𐀀"');
  });

  it("serializes safe integers as integer tokens", () => {
    expect(canonicalJson(0)).toBe("0");
    expect(canonicalJson(-5)).toBe("-5");
    expect(canonicalJson(Number.MAX_SAFE_INTEGER)).toBe(String(Number.MAX_SAFE_INTEGER));
  });

  it("treats bigint as decimal integer token of equal numeric value to the same number", () => {
    expect(canonicalJson(123n)).toBe("123");
    expect(canonicalJson(123n)).toBe(canonicalJson(123));
    expect(canonicalJson({ blockNumber: 123n })).toBe('{"blockNumber":123}');
    // Beyond uint64 / far past Number.MAX_SAFE_INTEGER.
    expect(canonicalJson(2n ** 256n - 1n)).toBe(
      "115792089237316195423570985008687907853269984665640564039457584007913129639935",
    );
  });

  it("rejects unsafe, non-integer, non-finite numbers and -0", () => {
    expectRejected(2 ** 53); // Number.MAX_SAFE_INTEGER + 1
    expectRejected(1.5);
    expectRejected(-0);
    expectRejected(Number.NaN);
    expectRejected(Number.POSITIVE_INFINITY);
    expectRejected(Number.NEGATIVE_INFINITY);
  });

  it("rejects undefined anywhere", () => {
    expectRejected(undefined);
    expectRejected({ a: undefined });
  });

  it("rejects functions, class instances and exotic objects", () => {
    expectRejected(() => 1);
    expectRejected(new Date(0));
    expectRejected(new Map());
    expectRejected(new Set());
    expectRejected(new Error("x"));
    class Foo {
      x = 1;
    }
    expectRejected(new Foo());
    expectRejected(Object.create({ inherited: true }));
  });

  it("rejects symbol-keyed properties and accessor properties", () => {
    const sym = Symbol("s");
    const withSymbol: Record<PropertyKey, unknown> = { a: 1 };
    withSymbol[sym] = 1;
    expectRejected(withSymbol);

    const withGetter = { get a() { return 1; } };
    expectRejected(withGetter);
  });

  it("rejects non-enumerable own properties on objects (invisible to digests)", () => {
    const obj: Record<string, unknown> = { a: 1 };
    Object.defineProperty(obj, "hidden", { value: "x", enumerable: false, configurable: true });
    expectRejected(obj);
  });

  it("preserves an ordinary own __proto__ key as DATA (no prototype mutation)", () => {
    const viaDefine: Record<string, unknown> = {};
    Object.defineProperty(viaDefine, "__proto__", {
      value: { injected: true },
      enumerable: true,
      writable: true,
      configurable: true,
    });
    viaDefine.b = 2;
    const text = canonicalJson(viaDefine);
    expect(text).toBe('{"__proto__":{"injected":true},"b":2}');
    // No prototype pollution ever happened.
    expect(({} as Record<string, unknown>).injected).toBeUndefined();
  });

  it("rejects cycles deterministically", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expectRejected(cyclic);

    const arrCycle: unknown[] = [1];
    arrCycle.push(arrCycle);
    expectRejected(arrCycle);
  });

  describe("dense-array enforcement", () => {
    it("rejects sparse/holey arrays", () => {
      const holes = new Array(3);
      expectRejected(holes);
      const mixed: unknown[] = [1, , 3]; // eslint-disable-line no-sparse-arrays
      expectRejected(mixed);
    });

    it("rejects extra own properties on arrays", () => {
      const arr: unknown[] = [1, 2];
      (arr as unknown as Record<string, unknown>).extra = "x";
      expectRejected(arr);
    });

    it("rejects accessor array indexes without invoking them", () => {
      let invocations = 0;
      const arr: unknown[] = [];
      Object.defineProperty(arr, 0, {
        enumerable: true,
        configurable: true,
        get: () => {
          invocations += 1;
          return 42;
        },
      });
      arr.length = 1; // dense shape with an accessor at index 0
      expectRejected(arr);
      expect(invocations).toBe(0);
    });

    it("rejects arrays with overridden/inherited traversal behavior", () => {
      class FakeList extends Array {}
      expectRejected(Object.create(FakeList.prototype, { length: { value: 0 } }));
      const subclassed = FakeList.from([1, 2]);
      expect(() => canonicalJson(subclassed as unknown)).toThrow(/prototype/);
    });

    it("accepts ordinary dense frozen arrays", () => {
      expect(canonicalJson(Object.freeze([1, 2, 3]))).toBe("[1,2,3]");
    });
  });

  it("produces UTF-8 bytes identical to the encoded text", () => {
    expect(canonicalJsonBytes({ a: "\u00e9" })).toEqual(
      new TextEncoder().encode('{"a":"\u00e9"}'),
    );
  });

  it("assertCanonicalizable accepts valid data without producing output", () => {
    expect(() =>
      assertCanonicalizable({ ok: [1, true, null, "x"], big: 42n }),
    ).not.toThrow();
    expect(() => assertCanonicalizable({ bad: undefined })).toThrow(NecCanonicalizationError);
  });

  it("is stable under repeated evaluation (no hidden state)", () => {
    const value = { k: [1n, "s", false], nested: { z: null, a: 1 } };
    const first = canonicalJson(value);
    for (let i = 0; i < 10; i++) {
      expect(canonicalJson(value)).toBe(first);
    }
  });
});
