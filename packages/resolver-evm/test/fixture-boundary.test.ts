import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import {
  buildEvidenceRefs,
  NecResolverEvmError,
  replayTransactionAcquisition,
  validateEvmAcquisitionFixture,
  validateFixtureCaptureShape,
} from "../src/index.js";
import { NOW, TX } from "./helpers.js";

function committedFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as Record<string, unknown>;
}

function structuredCloneFixture(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

// ---------------------------------------------------------------------------
// Hostile-fixture builders
// ---------------------------------------------------------------------------

function minimalValidFixture(): Record<string, unknown> {
  return {
    schemaVersion: "nec-resolver-evm-fixture-v1",
    acquiredAt: NOW,
    source: {
      sourceId: "src.sepolia.primary",
      sourceType: "evm_rpc",
      networkId: "eip155:11155111",
      chainId: 11155111,
    },
    subject: { txHash: TX },
    captures: [
      { rpcMethod: "eth_chainId", rpcParams: [], httpStatus: 200, resultJson: '"0xaa36a7"' },
    ],
  };
}

function fixtureWithCaptures(captures: unknown): Record<string, unknown> {
  const f = minimalValidFixture();
  f.captures = captures;
  return f;
}

function captureWithParams(rpcParams: unknown): Record<string, unknown> {
  return { rpcMethod: "eth_chainId", rpcParams, httpStatus: 200, resultJson: '"0xaa36a7"' };
}

function captureWithError(error: unknown): Record<string, unknown> {
  return { rpcMethod: "eth_getTransactionReceipt", rpcParams: [TX], httpStatus: 200, error };
}

/** Counting + throwing trap recorder for proxies. */
function trapCounter(): { counts: Record<string, number>; handler: ProxyHandler<object> } {
  const counts = { get: 0, getPrototypeOf: 0, ownKeys: 0, getOwnPropertyDescriptor: 0, has: 0 };
  const handler: ProxyHandler<object> = {
    get() {
      counts.get += 1;
      return undefined;
    },
    getPrototypeOf() {
      counts.getPrototypeOf += 1;
      return null;
    },
    ownKeys() {
      counts.ownKeys += 1;
      return [];
    },
    getOwnPropertyDescriptor() {
      counts.getOwnPropertyDescriptor += 1;
      return undefined;
    },
    has() {
      counts.has += 1;
      return false;
    },
  };
  return { counts, handler };
}

/** Define an enumerable accessor that counts reads and can throw. */
function defineGetter(
  target: object,
  key: string | symbol,
  behavior: "count" | "throw",
  counter: { reads: number },
): void {
  Object.defineProperty(target, key, {
    enumerable: true,
    configurable: true,
    get(): never | string {
      counter.reads += 1;
      if (behavior === "throw") throw new RangeError("raw getter escape");
      return typeof key === "string" ? `value:${key}` : "value:symbol";
    },
  });
}

const CONTROLLED_ERROR_MATCHER = {
  asymmetricMatch(actual: unknown) {
    return actual instanceof NecResolverEvmError && !(actual instanceof RangeError);
  },
};

function expectControlledRejection(run: () => unknown): void {
  let error: unknown;
  try {
    run();
    error = undefined;
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(NecResolverEvmError);
  expect((error as Error).name).toBe("NecResolverEvmError");
  expect(error).not.toBeInstanceOf(RangeError);
  expect((error as Error).message.startsWith("[")).toBe(true);
}

// ---------------------------------------------------------------------------
// PROXY POLICY — rejected before a single trap dispatches
// ---------------------------------------------------------------------------

describe("proxy policy: rejection precedes every trap", () => {
  function totalTraps(counts: Record<string, number>): number {
    return Object.values(counts).reduce((sum, n) => sum + n, 0);
  }

  it("A: proxy over the fixture ROOT is rejected before any trap executes", () => {
    const target = minimalValidFixture();
    const { counts, handler } = trapCounter();
    const proxy = new Proxy(target, handler);
    expectControlledRejection(() => validateEvmAcquisitionFixture(proxy));
    expect(totalTraps(counts)).toBe(0);
  });

  it("A: proxy root through the public replay surface is also rejected trap-free", async () => {
    const target = structuredCloneFixture(committedFixture("sepolia-success.json")) as Record<string, unknown>;
    const { counts, handler } = trapCounter();
    await expect(replayTransactionAcquisition(new Proxy(target, handler))).rejects.toThrowError(
      NecResolverEvmError,
    );
    expect(totalTraps(counts)).toBe(0);
  });

  it("B: proxy over the CAPTURES ARRAY is rejected before any trap executes", () => {
    const fixture = minimalValidFixture();
    const { counts, handler } = trapCounter();
    fixture.captures = new Proxy(
      [{ rpcMethod: "eth_chainId", rpcParams: [], httpStatus: 200, resultJson: '"0xaa36a7"' }],
      handler,
    );
    expectControlledRejection(() => validateEvmAcquisitionFixture(fixture));
    expect(totalTraps(counts)).toBe(0);
  });

  it("C: proxy over a CAPTURE ENTRY is rejected before any trap executes", () => {
    const fixture = minimalValidFixture();
    const { counts, handler } = trapCounter();
    fixture.captures = [
      new Proxy({ rpcMethod: "eth_chainId", rpcParams: [], httpStatus: 200, resultJson: '"0xaa36a7"' }, handler),
    ];
    expectControlledRejection(() => validateEvmAcquisitionFixture(fixture));
    expect(totalTraps(counts)).toBe(0);

    // Direct surface must behave identically.
    const directCounts = trapCounter();
    expectControlledRejection(() =>
      validateFixtureCaptureShape(new Proxy(captureWithParams([]), directCounts.handler)),
    );
    expect(totalTraps(directCounts.counts)).toBe(0);
  });

  it("D: proxy over NESTED rpcParams object and array is rejected before any trap executes", () => {
    const nestedObjectProxyCounts = trapCounter();
    const fixtureObjectProxy = fixtureWithCaptures([
      captureWithParams([{ deep: new Proxy({ x: 1 }, nestedObjectProxyCounts.handler) }]),
    ]);
    expectControlledRejection(() => validateEvmAcquisitionFixture(fixtureObjectProxy));
    expect(totalTraps(nestedObjectProxyCounts.counts)).toBe(0);

    const nestedArrayProxyCounts = trapCounter();
    const fixtureArrayProxy = fixtureWithCaptures([
      captureWithParams([new Proxy(["param"], nestedArrayProxyCounts.handler)]),
    ]);
    expectControlledRejection(() => validateEvmAcquisitionFixture(fixtureArrayProxy));
    expect(totalTraps(nestedArrayProxyCounts.counts)).toBe(0);
  });

  it("revoked proxies are still detected without dispatching traps — at every boundary position", () => {
    // Root
    const root = Proxy.revocable(minimalValidFixture(), {});
    root.revoke();
    expectControlledRejection(() => validateEvmAcquisitionFixture(root.proxy));

    // Captures array (revoked proxies even break Array.isArray itself).
    const captures = Proxy.revocable([captureWithParams([])], {});
    captures.revoke();
    expectControlledRejection(() =>
      validateEvmAcquisitionFixture(fixtureWithCaptures(captures.proxy)),
    );

    // Capture entry.
    const entry = Proxy.revocable(captureWithParams([]), {});
    entry.revoke();
    expectControlledRejection(() =>
      validateEvmAcquisitionFixture(fixtureWithCaptures([entry.proxy])),
    );
    expectControlledRejection(() => validateFixtureCaptureShape(entry.proxy));

    // Nested rpcParams object + array.
    const nestedObject = Proxy.revocable({ x: 1 }, {});
    nestedObject.revoke();
    expectControlledRejection(() =>
      validateEvmAcquisitionFixture(fixtureWithCaptures([captureWithParams([{ deep: nestedObject.proxy }])])),
    );
    const nestedArray = Proxy.revocable(["param"], {});
    nestedArray.revoke();
    expectControlledRejection(() =>
      validateEvmAcquisitionFixture(fixtureWithCaptures([captureWithParams([nestedArray.proxy])])),
    );
    expectControlledRejection(() => validateFixtureCaptureShape(captureWithParams([nestedArray.proxy])));
  });

  it("a stateful proxy cannot mediate later reads: no validated fixture is ever produced from one", async () => {
    // The Gate C substitution attack: a stateful proxy whose captures read
    // returns different evidence per access. It must never reach replay.
    const worlds = [
      [{ rpcMethod: "eth_chainId", rpcParams: [], httpStatus: 200, resultJson: '"0x1"' }],
      [{ rpcMethod: "eth_chainId", rpcParams: [], httpStatus: 200, resultJson: '"0x2"' }],
    ];
    let accesses = 0;
    const stateful = new Proxy(minimalValidFixture(), {
      get(target, prop) {
        if (prop === "captures") {
          accesses += 1;
          return worlds[accesses % 2];
        }
        return (target as Record<string | symbol, unknown>)[prop];
      },
    });
    await expect(replayTransactionAcquisition(stateful)).rejects.toThrowError(NecResolverEvmError);
    expect(accesses).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// GETTER MATRIX — zero getter executions; throwing getters cannot escape
// ---------------------------------------------------------------------------

describe("getter matrix: hostile accessors are never executed", () => {
  interface GetterCase {
    readonly fixture: unknown;
    readonly direct?: unknown;
    readonly counters: Array<{ reads: number }>;
  }

  function getterOn(
    target: Record<string, unknown>,
    field: string,
    behavior: "count" | "throw",
    counters: Array<{ reads: number }>,
  ): Record<string, unknown> {
    const counter = { reads: 0 };
    defineGetter(target, field, behavior, counter);
    counters.push(counter);
    return target;
  }

  /** Array index accessor whose trap honors `behavior`; counter tracked. */
  function arrayWithHostileIndex(behavior: "count" | "throw", value: () => unknown): {
    arr: unknown[];
    counters: Array<{ reads: number }>;
  } {
    const counter = { reads: 0 };
    const arr: unknown[] = [];
    Object.defineProperty(arr, "0", {
      enumerable: true,
      configurable: true,
      get(): never | unknown {
        counter.reads += 1;
        if (behavior === "throw") throw new RangeError("raw getter escape");
        return value();
      },
    });
    return { arr, counters: [counter] };
  }

  const cases: Array<{ readonly name: string; readonly build: (behavior: "count" | "throw") => GetterCase }> = [
    {
      name: "fixture root field",
      build: (b) => {
        const counters: Array<{ reads: number }> = [];
        const fixture = minimalValidFixture();
        getterOn(fixture, "schemaVersion", b, counters);
        // A root-level `captures` ACCESSOR must equally never execute.
        getterOn(fixture, "captures", b, counters);
        return { fixture, counters };
      },
    },
    {
      name: "fixture.source field",
      build: (b) => {
        const counters: Array<{ reads: number }> = [];
        const fixture = minimalValidFixture();
        getterOn(fixture.source as Record<string, unknown>, "sourceId", b, counters);
        return { fixture, counters };
      },
    },
    {
      name: "fixture.subject field",
      build: (b) => {
        const counters: Array<{ reads: number }> = [];
        const fixture = minimalValidFixture();
        getterOn(fixture.subject as Record<string, unknown>, "txHash", b, counters);
        return { fixture, counters };
      },
    },
    {
      name: "fixture.captures[0]",
      build: (b) => {
        const { arr, counters } = arrayWithHostileIndex(b, () => captureWithParams([]));
        return { fixture: fixtureWithCaptures(arr), counters };
      },
    },
    ...(["rpcMethod", "rpcParams", "httpStatus", "resultJson"] as const).map((field) => ({
      name: `capture.${field}`,
      build: (b: "count" | "throw"): GetterCase => {
        const counters: Array<{ reads: number }> = [];
        const entry = captureWithParams([]);
        getterOn(entry, field, b, counters);
        return { fixture: fixtureWithCaptures([entry]), direct: entry, counters };
      },
    })),
    {
      name: "capture.error presence",
      build: (b): GetterCase => {
        const counters: Array<{ reads: number }> = [];
        const entry = captureWithParams([]);
        getterOn(entry, "error", b, counters);
        return { fixture: fixtureWithCaptures([entry]), direct: entry, counters };
      },
    },
    ...(["code", "message"] as const).map((field) => ({
      name: `capture.error.${field}`,
      build: (b: "count" | "throw"): GetterCase => {
        const counters: Array<{ reads: number }> = [];
        const errorObj = getterOn({ code: -32000, message: "boom" }, field, b, counters);
        const entry = captureWithError(errorObj);
        return { fixture: fixtureWithCaptures([entry]), direct: entry, counters };
      },
    })),
    {
      name: "rpcParams[0]",
      build: (b): GetterCase => {
        const { arr, counters } = arrayWithHostileIndex(b, () => '"param"');
        const entry = captureWithParams(arr);
        return { fixture: fixtureWithCaptures([entry]), direct: entry, counters };
      },
    },
    {
      name: "nested rpcParams object field",
      build: (b): GetterCase => {
        const counters: Array<{ reads: number }> = [];
        const nested = getterOn({ v: 1 } as Record<string, unknown>, "v", b, counters);
        const entry = captureWithParams([{ deep: nested }]);
        return { fixture: fixtureWithCaptures([entry]), direct: entry, counters };
      },
    },
    {
      name: "nested rpcParams array index",
      build: (b): GetterCase => {
        const { arr, counters } = arrayWithHostileIndex(b, () => "x");
        const entry = captureWithParams([arr]);
        return { fixture: fixtureWithCaptures([entry]), direct: entry, counters };
      },
    },
  ];

  for (const { name, build } of cases) {
    it(`COUNTING getter at ${name}: reads stay 0 through both surfaces`, () => {
      const built = build("count");
      expectControlledRejection(() => validateEvmAcquisitionFixture(built.fixture));
      for (const counter of built.counters) expect(counter.reads).toBe(0);
      if (built.direct !== undefined) {
        expectControlledRejection(() => validateFixtureCaptureShape(built.direct));
        for (const counter of built.counters) expect(counter.reads).toBe(0);
      }
    });

    it(`THROWING getter at ${name}: RangeError never escapes, controlled error raised`, () => {
      const built = build("throw");
      expectControlledRejection(() => validateEvmAcquisitionFixture(built.fixture));
      for (const counter of built.counters) expect(counter.reads).toBe(0);
      if (built.direct !== undefined) {
        expectControlledRejection(() => validateFixtureCaptureShape(built.direct));
        for (const counter of built.counters) expect(counter.reads).toBe(0);
      }
    });
  }

  it("direct validateFixtureCaptureShape rejects an all-accessor capture without reading any value", () => {
    const counter = { reads: 0 };
    const capture: Record<string, unknown> = {};
    for (const field of ["rpcMethod", "rpcParams", "httpStatus", "resultJson"]) {
      defineGetter(capture, field, "count", counter);
    }
    expectControlledRejection(() => validateFixtureCaptureShape(capture));
    expect(counter.reads).toBe(0);
  });

  it("non-enumerable hidden props on a capture are rejected without value reads", () => {
    const counter = { reads: 0 };
    const entry = captureWithParams([]);
    Object.defineProperty(entry, "smuggled", { value: "hidden", enumerable: false, writable: true, configurable: true });
    expectControlledRejection(() => validateFixtureCaptureShape(entry));
    expect(counter.reads).toBe(0);
    expectControlledRejection(() => validateEvmAcquisitionFixture(fixtureWithCaptures([entry])));
  });
});
// ---------------------------------------------------------------------------
// SYMBOL / ARRAY MATRIX on the captures container (and rpcParams)
// ---------------------------------------------------------------------------

describe("captures-array container matrix: everything fails closed, controlled", () => {
  const PAYLOAD = Symbol("payload");

  function rejectCase(name: string, makeCaptures: () => unknown): void {
    it(`${name} -> NecResolverEvmError`, () => {
      expectControlledRejection(() => validateEvmAcquisitionFixture(fixtureWithCaptures(makeCaptures())));
    });
  }

  rejectCase("symbol DATA property", () => {
    const arr: unknown[] = [captureWithParams([])];
    Object.defineProperty(arr, PAYLOAD, { value: "smuggled", enumerable: true, configurable: true, writable: true });
    return arr;
  });

  rejectCase("symbol GETTER property", () => {
    const arr: unknown[] = [captureWithParams([])];
    Object.defineProperty(arr, PAYLOAD, {
      enumerable: true,
      configurable: true,
      get() {
        throw new RangeError("symbol getter escape");
      },
    });
    return arr;
  });

  rejectCase("Symbol.iterator override", () => {
    const arr: unknown[] = [captureWithParams([])];
    Object.defineProperty(arr, Symbol.iterator, {
      value: function* (): Generator<unknown> {
        yield captureWithParams([]);
      },
      enumerable: false,
      configurable: true,
      writable: true,
    });
    return arr;
  });

  rejectCase("extra string property", () => {
    const arr: unknown[] = [captureWithParams([])];
    (arr as unknown as Record<string, unknown>).extra = "smuggled";
    return arr;
  });

  rejectCase("sparse array (hole at index)", () => {
    const arr: unknown[] = new Array(2);
    arr[1] = captureWithParams([]);
    return arr;
  });

  rejectCase("accessor at capture index", () => {
    const counter = { reads: 0 };
    const arr: unknown[] = [];
    defineGetter(arr, "0", "count", counter);
    return arr;
  });

  class CapturesSubclass extends Array {}
  rejectCase("array subclass", () => {
    const sub = new CapturesSubclass();
    sub.push(captureWithParams([]));
    return sub;
  });

  rejectCase("custom prototype container", () => {
    const hostile = Object.create({ length: 1 }) as unknown;
    return hostile;
  });
});

describe("rpcParams container matrix: same classes fail closed", () => {
  const PAYLOAD = Symbol("params-payload");

  function rejectParamsCase(name: string, makeParams: () => unknown): void {
    it(`${name} -> NecResolverEvmError`, () => {
      const capture = captureWithParams(makeParams());
      expectControlledRejection(() => validateFixtureCaptureShape(capture));
      expectControlledRejection(() => validateEvmAcquisitionFixture(fixtureWithCaptures([capture])));
    });
  }

  rejectParamsCase("symbol data property", () => {
    const arr: unknown[] = [];
    Object.defineProperty(arr, PAYLOAD, { value: "smuggled", enumerable: true, configurable: true, writable: true });
    return arr;
  });

  rejectParamsCase("Symbol.iterator override", () => {
    const arr: unknown[] = [];
    Object.defineProperty(arr, Symbol.iterator, {
      value: function* (): Generator<unknown> {
        yield 1;
      },
      enumerable: false,
      configurable: true,
      writable: true,
    });
    return arr;
  });

  rejectParamsCase("extra string property", () => {
    const arr: unknown[] = [];
    (arr as unknown as Record<string, unknown>).extra = "smuggled";
    return arr;
  });

  rejectParamsCase("sparse array", () => {
    const arr: unknown[] = new Array(2);
    arr[1] = "x";
    return arr;
  });

  rejectParamsCase("index accessor", () => {
    const counter = { reads: 0 };
    const arr: unknown[] = [];
    defineGetter(arr, "0", "count", counter);
    return arr;
  });

  class ParamsSubclass extends Array {}
  rejectParamsCase("array subclass", () => {
    const sub = new ParamsSubclass();
    sub.push("x");
    return sub;
  });
});

// ---------------------------------------------------------------------------
// CALLER-OWNERSHIP POLICY — NEC-owned inert snapshots only
// ---------------------------------------------------------------------------

describe("ownership: validated fixtures retain no caller-owned references", () => {
  it("validated captures graph is fully rebuilt, not aliased", () => {
    const input = minimalValidFixture();
    const validated = validateEvmAcquisitionFixture(input);
    const inCaptures = input.captures as Array<Record<string, unknown>>;
    const outCaptures = validated.captures as unknown as Array<Record<string, unknown>>;
    expect(outCaptures).not.toBe(inCaptures);
    expect(outCaptures[0]).not.toBe(inCaptures[0]);
    expect(outCaptures[0]?.rpcParams).not.toBe(inCaptures[0]?.rpcParams);
  });

  it("mutating the ORIGINAL caller graph after validation alters nothing downstream", async () => {
    const input = structuredCloneFixture(committedFixture("sepolia-success.json")) as Record<string, unknown>;
    const validated = validateEvmAcquisitionFixture(input);

    // Baseline replay BEFORE mutation.
    const baselineCanon = canonOf(await replayTransactionAcquisition(structuredCloneFixture(input)));

    // Mutate EVERY level of the original caller graph.
    const inCaptures = input.captures as Array<Record<string, unknown>>;
    inCaptures.length = 0;
    inCaptures.push({ rpcMethod: "eth_chainId", rpcParams: ["TAMPERED"], httpStatus: 500, resultJson: '"0xdead"' });
    (input.subject as Record<string, unknown>).txHash = `0x${"ff".repeat(32)}`;
    (input.source as Record<string, unknown>).chainId = 1;

    // Validated fixture unchanged.
    expect(JSON.stringify(validated)).toBe(
      JSON.stringify(validateEvmAcquisitionFixture(structuredCloneFixture(committedFixture("sepolia-success.json")))),
    );
    // Replay acquisition, normalized observations and digests unchanged.
    const afterCanon = canonOf(await replayTransactionAcquisition(validated));
    expect(afterCanon).toBe(baselineCanon);
  });

  it("deeply nested rpcParams composites are snapshots, not aliases", () => {
    const nested = { blockNumber: "0x186a0", tags: ["a", { b: 1 }] };
    const input = fixtureWithCaptures([
      { rpcMethod: "eth_getLogs", rpcParams: [nested], httpStatus: 200, resultJson: "[]" },
    ]);
    const validated = validateEvmAcquisitionFixture(input);
    const outParams = ((validated.captures as unknown as Array<Record<string, unknown>>)[0]?.rpcParams ?? null) as
      | Array<Record<string, unknown>>
      | null;
    expect(outParams).not.toBeNull();
    expect(outParams![0]).not.toBe(nested);
    expect((outParams![0] as Record<string, unknown>).tags).not.toBe(nested.tags);
    expect((outParams![0] as Record<string, unknown>).tags).toEqual(nested.tags);

    nested.tags.push("MUTATED");
    nested.blockNumber = "0xdeadbeef";
    expect((outParams![0] as Record<string, unknown>).blockNumber).toBe("0x186a0");
    expect(((outParams![0] as Record<string, unknown>).tags as unknown[])).toEqual(["a", { b: 1 }]);
  });

  it("only the NEC-owned snapshot is frozen; caller input stays unfrozen", () => {
    const input = minimalValidFixture();
    const validated = validateEvmAcquisitionFixture(input);
    expect(Object.isFrozen(validated)).toBe(true);
    expect(Object.isFrozen(validated.captures)).toBe(true);
    expect(Object.isFrozen((validated.captures as unknown[])[0])).toBe(true);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(input.captures)).toBe(false);
    expect(Object.isFrozen((input.captures as unknown[])[0])).toBe(false);
  });

  it("own '__proto__' DATA keys survive snapshotting inertly (no setter routing, no pollution)", () => {
    const param: Record<string, unknown> = { kind: "filter" };
    Object.defineProperty(param, "__proto__", {
      value: "smuggled-as-data",
      enumerable: true,
      configurable: true,
      writable: true,
    });
    const input = fixtureWithCaptures([
      { rpcMethod: "eth_getLogs", rpcParams: [param], httpStatus: 200, resultJson: "[]" },
    ]);
    const validated = validateEvmAcquisitionFixture(input);
    const outParam = (((validated.captures as unknown as Array<Record<string, unknown>>)[0]
      ?.rpcParams ?? null) as Array<Record<string, unknown>> | null)![0];
    const d = Object.getOwnPropertyDescriptor(outParam, "__proto__");
    expect(d).toBeDefined();
    expect(d!.get).toBeUndefined();
    expect(d!.value).toBe("smuggled-as-data");
    // No prototype pollution: the object's actual prototype is untouched.
    expect(Object.getPrototypeOf(outParam)).toBe(Object.prototype);
    // And the caller object was left alone.
    expect(Object.getOwnPropertyDescriptor(param, "__proto__")?.value).toBe("smuggled-as-data");
  });
});

// ---------------------------------------------------------------------------
// REPLAY REGRESSION — determinism preserved end to end
// ---------------------------------------------------------------------------

describe("replay regression after the boundary fix", () => {
  it("same fixture twice -> byte-identical acquisition, digests and EvidenceRefs", async () => {
    const raw = structuredCloneFixture(committedFixture("sepolia-success.json"));
    const a = await replayTransactionAcquisition(structuredCloneFixture(raw));
    const b = await replayTransactionAcquisition(structuredCloneFixture(raw));
    expect(canonOf(a)).toBe(canonOf(b));
    expect(a.captures.map((c) => c.contentDigest)).toEqual(b.captures.map((c) => c.contentDigest));
    expect(buildEvidenceRefs(a)).toEqual(buildEvidenceRefs(b));

    // A single validated fixture instance replays identically twice too.
    const fixture = validateEvmAcquisitionFixture(raw);
    expect(canonOf(await replayTransactionAcquisition(fixture))).toBe(canonOf(a));
  });

  it.each([
    ["sepolia-reverted.json"],
    ["sepolia-missing-receipt.json"],
  ])("%s remains coherent (reverted receipt / null receipt)", async (name) => {
    const a = await replayTransactionAcquisition(structuredCloneFixture(committedFixture(name)));
    const b = await replayTransactionAcquisition(structuredCloneFixture(committedFixture(name)));
    expect(canonOf(a)).toBe(canonOf(b));
    if (name === "sepolia-reverted.json") expect(a.receipt?.status).toBe("reverted");
    if (name === "sepolia-missing-receipt.json") expect(a.receipt).toBeNull();
    expect(a.consistent).toBe(true);
  });

  it("duplicate captures still fail closed", () => {
    const fixture = structuredCloneFixture(committedFixture("sepolia-missing-receipt.json")) as Record<string, unknown>;
    (fixture.captures as unknown[]).push((fixture.captures as unknown[])[0]);
    expectControlledRejection(() => validateEvmAcquisitionFixture(fixture));
  });

  it("missing capture still fails closed at replay", async () => {
    const fixture = structuredCloneFixture(committedFixture("sepolia-success.json")) as Record<string, unknown>;
    fixture.captures = (fixture.captures as unknown[]).slice(0, 2);
    await expect(replayTransactionAcquisition(fixture)).rejects.toThrowError(/no fixture capture matches/);
  });

  it("unused capture still fails closed at replay", async () => {
    const fixture = structuredCloneFixture(committedFixture("sepolia-missing-receipt.json")) as Record<string, unknown>;
    (fixture.captures as unknown[]).push({
      rpcMethod: "eth_getBlockByNumber",
      rpcParams: ["latest"],
      httpStatus: 200,
      resultJson: "null",
    });
    await expect(replayTransactionAcquisition(fixture)).rejects.toThrowError(/never requested/);
  });
});

function canonOf(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? `${v}n` : v));
}
