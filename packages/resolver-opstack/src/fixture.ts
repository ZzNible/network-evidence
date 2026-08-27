/**
 * FIXTURE model — the offline replay representation of ONE OP Stack
 * finality observation.
 *
 * Same philosophy as the generic EVM resolver: fixtures preserve exactly
 * what replay needs to reproduce normalization byte-for-byte — source
 * PROVENANCE (never its endpoint URL or any credential), the subject
 * containing-block anchor, the acquisition time and the RAW CAPTURES
 * (exact `result` text). Integer precision can never be lost because raw
 * results travel as text and block heights as decimal strings.
 *
 * Captures are ORDERED: one acquisition burst may read the same
 * (method, params) exchange more than once (e.g. the finalized-head
 * stability re-read that closes an ancestry burst), so replay consumes
 * same-key captures first-in-first-out. Every captured exchange must be
 * consumed by a replay exactly once; leftovers fail closed.
 *
 * Capture entries reuse the generic EVM fixture capture shape and are
 * validated through that package's public hostile-input gate; everything
 * else is validated here and fails closed on ANY deviation.
 */

import { types as utilTypes } from "node:util";

import {
  assertIso8601,
  assertNetworkId,
  assertNecIdentifier,
  assertSafePositiveInteger,
  deepFreeze,
} from "@nec/core";

import {
  maxCapturesPerAcquisition,
  parseHexHash,
  validateFixtureCaptureShape,
} from "@nec/resolver-evm";
import type { EvmFixtureCapture } from "@nec/resolver-evm";
import { NecResolverEvmError } from "@nec/resolver-evm";

import { NecResolverOpStackError } from "./errors.js";
import { OPSTACK_MAX_ANCESTRY_DEPTH } from "./config.js";
import { OPSTACK_ACQUISITION_PROFILE } from "./acquire.js";
import type { OpStackFinalityObservation } from "./acquire.js";

export const OPSTACK_FIXTURE_PROFILE = "nec-resolver-opstack-fixture-v1";

/** Provenance-only source projection stored in fixtures (NO endpoint URL). */
export interface OpStackFixtureSource {
  readonly sourceId: string;
  readonly sourceType: string;
  readonly networkId: string;
  readonly chainId: number;
  readonly independenceGroup?: string;
}

export interface OpStackFinalityFixture {
  readonly schemaVersion: typeof OPSTACK_FIXTURE_PROFILE;
  readonly acquiredAt: string;
  readonly source: OpStackFixtureSource;
  /** Subject containing-block anchor; height stored as an exact decimal STRING. */
  readonly subjectBlock: { readonly number: string; readonly hash: string };
  /**
   * Explicit maximum ancestry depth in force during acquisition; replay
   * re-runs the walk gate with the SAME bound so the burst is reproduced
   * decision-for-decision. Absent means the ruleset default ceiling.
   */
  readonly maxAncestryDepth?: number;
  readonly captures: readonly EvmFixtureCapture[];
}

const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DECIMAL_PATTERN = /^\d+$/;

function fail(message: string): never {
  throw new NecResolverOpStackError("OPSTACK_FIXTURE_INVALID", message);
}

function assertPlainObject(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${path}: must be a plain object`);
  }
  // Proxy rejection BEFORE any reflective operation on the value.
  if (value !== null && typeof value === "object" && utilTypes.isProxy(value)) {
    fail(`${path}: proxy rejected`);
  }
  const proto = Object.getPrototypeOf(value) as object | null;
  if (proto !== Object.prototype && proto !== null) {
    fail(`${path}: exotic prototype rejected`);
  }
}

function assertExactKeys(record: Record<string, unknown>, keys: readonly string[], path: string): void {
  const allowed = new Set<string>(keys);
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key === "symbol") fail(`${path}.${String(key)}: symbol-keyed property rejected`);
    if (!allowed.has(key as string)) {
      fail(`${path}: unknown key ${JSON.stringify(key)}`);
    }
  }
}

/**
 * Validate a hostile fixture value completely; returns a frozen, typed
 * fixture on success. Invalid fixtures fail closed.
 */
export function validateOpStackFinalityFixture(value: unknown): OpStackFinalityFixture {
  assertPlainObject(value, "fixture");
  assertExactKeys(
    value,
    ["schemaVersion", "acquiredAt", "source", "subjectBlock", "maxAncestryDepth", "captures"],
    "fixture",
  );
  const f = value as Record<string, unknown>;
  if (f.schemaVersion !== OPSTACK_FIXTURE_PROFILE) {
    fail(`fixture.schemaVersion must be "${OPSTACK_FIXTURE_PROFILE}"`);
  }
  let maxAncestryDepth: number | undefined;
  if (Object.prototype.hasOwnProperty.call(f, "maxAncestryDepth")) {
    if (
      !Number.isSafeInteger(f.maxAncestryDepth) ||
      (f.maxAncestryDepth as number) < 1 ||
      (f.maxAncestryDepth as number) > OPSTACK_MAX_ANCESTRY_DEPTH
    ) {
      fail(`fixture.maxAncestryDepth must be an integer in [1, ${OPSTACK_MAX_ANCESTRY_DEPTH}]`);
    }
    maxAncestryDepth = f.maxAncestryDepth as number;
  }
  if (typeof f.acquiredAt !== "string" || !ISO_PATTERN.test(f.acquiredAt)) {
    fail("fixture.acquiredAt must be YYYY-MM-DDTHH:mm:ss.sssZ");
  }
  try {
    assertIso8601(f.acquiredAt, "fixture.acquiredAt");
  } catch (error) {
    fail(`fixture.acquiredAt invalid calendar date (${(error as Error).message})`);
  }

  assertPlainObject(f.source, "fixture.source");
  assertExactKeys(
    f.source,
    ["sourceId", "sourceType", "networkId", "chainId", "independenceGroup"],
    "fixture.source",
  );
  const source = f.source as Record<string, unknown>;
  let independenceGroup: string | undefined;
  if (Object.prototype.hasOwnProperty.call(source, "independenceGroup")) {
    if (typeof source.independenceGroup !== "string") {
      fail("fixture.source.independenceGroup must be a string when present");
    }
    try {
      assertNecIdentifier(source.independenceGroup, "fixture.source.independenceGroup");
    } catch (error) {
      fail((error as Error).message);
    }
    independenceGroup = source.independenceGroup;
  }
  if (
    typeof source.sourceId !== "string" ||
    typeof source.sourceType !== "string" ||
    typeof source.networkId !== "string" ||
    typeof source.chainId !== "number"
  ) {
    fail("fixture.source fields must have the documented primitive types");
  }
  try {
    assertNecIdentifier(source.sourceId, "fixture.source.sourceId");
    assertNecIdentifier(source.sourceType, "fixture.source.sourceType");
    assertNetworkId(source.networkId, "fixture.source.networkId");
    assertSafePositiveInteger(source.chainId, "fixture.source.chainId");
  } catch (error) {
    fail((error as Error).message);
  }

  assertPlainObject(f.subjectBlock, "fixture.subjectBlock");
  assertExactKeys(f.subjectBlock, ["number", "hash"], "fixture.subjectBlock");
  const subjectBlock = f.subjectBlock as Record<string, unknown>;
  if (typeof subjectBlock.number !== "string" || !DECIMAL_PATTERN.test(subjectBlock.number)) {
    fail("fixture.subjectBlock.number must be a non-negative decimal string");
  }
  let subjectHash: string;
  try {
    subjectHash = parseHexHash(subjectBlock.hash, "fixture.subjectBlock.hash");
  } catch (error) {
    fail((error as Error).message);
  }

  if (!Array.isArray(f.captures)) fail("fixture.captures must be an array");
  const captureCount = f.captures.length as number;
  if (captureCount === 0 || captureCount > maxCapturesPerAcquisition()) {
    fail(`fixture.captures must contain 1..${maxCapturesPerAcquisition()} entries`);
  }

  const capturedSnapshots: EvmFixtureCapture[] = [];
  for (let i = 0; i < captureCount; i++) {
    const path = `fixture.captures[${i}]`;
    const entry = f.captures[i];
    assertPlainObject(entry, path);
    assertExactKeys(entry, ["rpcMethod", "rpcParams", "httpStatus", "resultJson", "error"], path);
    // Delegate to THE battle-tested hostile capture gate from the frozen
    // generic resolver (descriptor-first inertness, envelope re-scan,
    // bounded params trees); re-typed into this package's error surface.
    try {
      validateFixtureCaptureShape(entry);
    } catch (error) {
      if (error instanceof NecResolverEvmError) fail(`${path}: ${error.message}`);
      throw error;
    }
    const entryRecord = entry as Record<string, unknown>;
    capturedSnapshots.push(snapshotFixtureCapture(entryRecord));
  }

  return deepFreeze({
    schemaVersion: OPSTACK_FIXTURE_PROFILE,
    acquiredAt: f.acquiredAt as string,
    source: {
      sourceId: source.sourceId as string,
      sourceType: source.sourceType as string,
      networkId: source.networkId as string,
      chainId: source.chainId as number,
      ...(independenceGroup === undefined ? {} : { independenceGroup }),
    },
    subjectBlock: { number: subjectBlock.number as string, hash: subjectHash },
    ...(maxAncestryDepth === undefined ? {} : { maxAncestryDepth }),
    captures: capturedSnapshots,
  });
}

/** Rebuild one already-validated capture entry into a fresh owned graph. */
function snapshotFixtureCapture(entry: Record<string, unknown>): EvmFixtureCapture {
  const snapshot: Record<string, unknown> = {};
  const define = (key: string, value: unknown): void => {
    Object.defineProperty(snapshot, key, { value, enumerable: true, writable: true, configurable: true });
  };
  define("rpcMethod", entry.rpcMethod);
  define("rpcParams", JSON.parse(JSON.stringify(entry.rpcParams)) as unknown[]);
  define("httpStatus", entry.httpStatus);
  if (Object.prototype.hasOwnProperty.call(entry, "resultJson")) {
    define("resultJson", entry.resultJson);
  } else {
    const rawError = entry.error as Record<string, unknown>;
    define("error", { code: rawError.code, message: rawError.message });
  }
  return snapshot as unknown as EvmFixtureCapture;
}

/**
 * Build a replayable fixture from a completed observation. Captures carry
 * no secrets by construction, so this projection is always artifact-safe.
 */
export function buildOpStackFinalityFixture(
  observation: OpStackFinalityObservation,
): OpStackFinalityFixture {
  if (observation.profile !== OPSTACK_ACQUISITION_PROFILE) {
    throw new NecResolverOpStackError(
      "OPSTACK_FIXTURE_INVALID",
      "not an OP Stack finality observation of this resolver version",
    );
  }
  return deepFreeze({
    schemaVersion: OPSTACK_FIXTURE_PROFILE,
    acquiredAt: observation.acquiredAt,
    source: {
      sourceId: observation.source.sourceId,
      sourceType: observation.source.sourceType,
      networkId: observation.source.networkId,
      chainId: observation.source.chainId,
      ...(observation.source.independenceGroup === undefined
        ? {}
        : { independenceGroup: observation.source.independenceGroup }),
    },
    subjectBlock: {
      number: observation.subjectBlock.number.toString(10),
      hash: observation.subjectBlock.hash,
    },
    maxAncestryDepth: observation.maxAncestryDepth,
    captures: observation.captures.map((capture) => ({
      rpcMethod: capture.rpcMethod,
      rpcParams: [...capture.rpcParams],
      httpStatus: capture.httpStatus,
      resultJson: capture.resultText,
    })),
  });
}
