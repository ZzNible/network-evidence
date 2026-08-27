/**
 * FIXTURE model — the offline replay representation of one acquisition.
 *
 * Fixtures preserve exactly what replay needs to reproduce normalization
 * byte-for-byte: the source PROVENANCE (never its endpoint URL or any
 * credential), the subject, the acquisition time and the raw captures
 * (exact `result` text). Integer precision can never be lost because raw
 * results are stored as text, never as parsed JSON numbers.
 *
 * Fixture input is HOSTILE: validated descriptor-first (no getter is ever
 * invoked merely to reject), with exact key sets, bounded size/depth and
 * strict envelope re-scanning. Invalid fixtures fail closed.
 */

import {
  assertIso8601,
  assertNetworkId,
  assertNecIdentifier,
  assertSafePositiveInteger,
  deepFreeze,
} from "@nec/core";

import { maxCapturesPerAcquisition, exchangeIdentityKey, validateFixtureCaptureShape } from "./capture.js";
import { NecResolverEvmError } from "./errors.js";
import {
  assertInertDataArray,
  assertInertDataObject,
  assertInertJsonTree,
  assertNotProxy,
  snapshotInertJsonTree,
} from "./inert.js";
import { parseTransactionHashInput } from "./hex.js";
import type { EvmTransactionAcquisition } from "./acquire.js";
import { ACQUISITION_PROFILE } from "./acquire.js";

export const FIXTURE_PROFILE = "nec-resolver-evm-fixture-v1";

/** Provenance-only source projection stored in fixtures (NO endpoint URL). */
export interface EvmFixtureSource {
  readonly sourceId: string;
  readonly sourceType: string;
  readonly networkId: string;
  readonly chainId: number;
  readonly independenceGroup?: string;
}

export interface EvmFixtureCaptureResult {
  readonly rpcMethod: string;
  readonly rpcParams: readonly unknown[];
  readonly httpStatus: number;
  /** Byte-exact raw text of the JSON-RPC envelope's `result` value. */
  readonly resultJson: string;
}

export interface EvmFixtureCaptureError {
  readonly rpcMethod: string;
  readonly rpcParams: readonly unknown[];
  readonly httpStatus: number;
  readonly error: { readonly code: number; readonly message: string };
}

export type EvmFixtureCapture = EvmFixtureCaptureResult | EvmFixtureCaptureError;

export interface EvmAcquisitionFixture {
  readonly schemaVersion: typeof FIXTURE_PROFILE;
  readonly acquiredAt: string;
  readonly source: EvmFixtureSource;
  readonly subject: { readonly txHash: string };
  readonly captures: readonly EvmFixtureCapture[];
}

const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function assertPlainObject(value: unknown, path: string): asserts value is Record<string, unknown> {
  // Proxy rejection BEFORE Array.isArray: even spec-level IsArray THROWS a
  // raw TypeError on a revoked proxy, so no proxy may survive to that read.
  if (value === null || typeof value !== "object") {
    throw new NecResolverEvmError("EVM_FIXTURE_INVALID", `${path}: must be a plain object`);
  }
  assertNotProxy(value, path);
  if (Array.isArray(value)) {
    throw new NecResolverEvmError("EVM_FIXTURE_INVALID", `${path}: must be a plain object`);
  }
  const proto = Object.getPrototypeOf(value) as object | null;
  if (proto !== Object.prototype && proto !== null) {
    throw new NecResolverEvmError("EVM_FIXTURE_INVALID", `${path}: exotic prototype rejected`);
  }
}

function assertExactKeys(value: object, keys: readonly string[], path: string): void {
  const allowed = new Set<string>(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new NecResolverEvmError("EVM_FIXTURE_INVALID", `${path}: unknown key ${JSON.stringify(key)}`);
    }
  }
}

/**
 * Bounded JSON-safe walker for rpcParams (hostile domain): delegates to
 * the shared descriptor-first inert-tree gate — plain prototypes only,
 * safe integers only, bounded depth/nodes/strings, no accessor read, no
 * symbol-keyed properties. Values are read from DATA DESCRIPTORS so
 * getters never execute during validation.
 */
function assertJsonSafe(value: unknown, path: string, state: { nodes: number }, depth: number): void {
  assertInertJsonTree(value, path, state, depth, "EVM_FIXTURE_INVALID");
}

/**
 * Validate a hostile fixture value completely; returns a frozen, typed
 * fixture on success. Fails closed on ANY deviation.
 *
 * The captures ARRAY BOUNDARY is proven inert descriptor-first (Proxies
 * rejected before any trap can dispatch; no accessor/sparse/extra/
 * symbol-keyed index; length read from its data descriptor) BEFORE
 * `.length`, indexing or iteration, and the returned fixture contains
 * ONLY NEC-owned inert snapshots — no caller-owned array, capture entry,
 * rpcParams composite or error object is retained by reference.
 */
export function validateEvmAcquisitionFixture(value: unknown): EvmAcquisitionFixture {
  assertPlainObject(value, "fixture");
  assertInertDataObject(value, "fixture");
  assertExactKeys(value, ["schemaVersion", "acquiredAt", "source", "subject", "captures"], "fixture");
  const f = value as Record<string, unknown>;
  if (f.schemaVersion !== FIXTURE_PROFILE) {
    throw new NecResolverEvmError("EVM_FIXTURE_INVALID", `fixture.schemaVersion must be "${FIXTURE_PROFILE}"`);
  }
  if (typeof f.acquiredAt !== "string" || !ISO_PATTERN.test(f.acquiredAt)) {
    throw new NecResolverEvmError("EVM_FIXTURE_INVALID", "fixture.acquiredAt must be YYYY-MM-DDTHH:mm:ss.sssZ");
  }
  try {
    assertIso8601(f.acquiredAt, "fixture.acquiredAt");
  } catch (error) {
    throw new NecResolverEvmError("EVM_FIXTURE_INVALID", `fixture.acquiredAt invalid calendar date (${(error as Error).message})`);
  }

  assertPlainObject(f.source, "fixture.source");
  assertInertDataObject(f.source, "fixture.source");
  assertExactKeys(f.source, ["sourceId", "sourceType", "networkId", "chainId", "independenceGroup"], "fixture.source");
  const source = f.source as Record<string, unknown>;
  let independenceGroup: string | undefined;
  if (Object.prototype.hasOwnProperty.call(source, "independenceGroup")) {
    const group = source.independenceGroup;
    if (typeof group !== "string") {
      throw new NecResolverEvmError(
        "EVM_FIXTURE_INVALID",
        "fixture.source.independenceGroup must be a string when present",
      );
    }
    try {
      assertNecIdentifier(group, "fixture.source.independenceGroup");
    } catch (error) {
      throw new NecResolverEvmError("EVM_FIXTURE_INVALID", (error as Error).message);
    }
    independenceGroup = group;
  }
  if (typeof source.chainId !== "number") {
    throw new NecResolverEvmError("EVM_FIXTURE_INVALID", "fixture.source.chainId must be a number");
  }
  try {
    assertNecIdentifier(source.sourceId, "fixture.source.sourceId");
    assertNecIdentifier(source.sourceType, "fixture.source.sourceType");
    assertNetworkId(source.networkId, "fixture.source.networkId");
    assertSafePositiveInteger(source.chainId, "fixture.source.chainId");
  } catch (error) {
    throw new NecResolverEvmError("EVM_FIXTURE_INVALID", (error as Error).message);
  }

  assertPlainObject(f.subject, "fixture.subject");
  assertInertDataObject(f.subject, "fixture.subject");
  assertExactKeys(f.subject, ["txHash"], "fixture.subject");
  const txHash = parseTransactionHashInput((f.subject as Record<string, unknown>).txHash);

  // HOSTILE CAPTURES-ARRAY BOUNDARY (F1): the entire captures container is
  // proven inert descriptor-first BEFORE any semantic read — before
  // `.length`, indexing or iteration, and before even Array.isArray (a
  // revoked proxy would throw a raw TypeError there). `assertInertDataArray`
  // rejects Proxies FIRST (no trap can execute), subclasses/exotic
  // prototypes, symbol keys (data, getters and Symbol.iterator overrides),
  // accessors on any index, sparse holes and extra string props. The
  // element count comes from the `length` DATA DESCRIPTOR.
  const captureCount = assertInertDataArray(f.captures, "fixture.captures");
  if (captureCount === 0 || captureCount > maxCapturesPerAcquisition()) {
    throw new NecResolverEvmError(
      "EVM_FIXTURE_INVALID",
      `fixture.captures must contain 1..${maxCapturesPerAcquisition()} entries`,
    );
  }

  const seenKeys = new Set<string>();
  const capturedSnapshots: EvmFixtureCapture[] = [];
  // Safe: the container was just proven inert (dense, data-only indexes),
  // so direct indexing can no longer execute caller-owned code.
  const capturesList = f.captures as unknown[];
  for (let i = 0; i < captureCount; i++) {
    const entry = capturesList[i];
    const path = `fixture.captures[${i}]`;
    assertPlainObject(entry, path);
    assertInertDataObject(entry, path);
    assertExactKeys(entry, ["rpcMethod", "rpcParams", "httpStatus", "resultJson", "error"], path);
    validateFixtureCaptureShape(entry);
    const entryRecord = entry as Record<string, unknown>;
    const paramsState = { nodes: 0 };
    try {
      assertJsonSafe(entryRecord.rpcParams, `${path}.rpcParams`, paramsState, 1);
    } catch (error) {
      if ((error as Error).message.startsWith("[EVM_FIXTURE_INVALID]")) throw error;
      throw new NecResolverEvmError("EVM_FIXTURE_INVALID", `${path}.rpcParams: ${(error as Error).message}`);
    }
    const key = exchangeIdentityKey(entryRecord.rpcMethod as string, entryRecord.rpcParams as unknown[]);
    if (seenKeys.has(key)) {
      throw new NecResolverEvmError("EVM_FIXTURE_INVALID", `${path}: duplicate capture for ${key}`);
    }
    seenKeys.add(key);
    // NEC-OWNED INERT SNAPSHOT (F1): the validated fixture never retains
    // the caller-owned captures array, capture entry objects, rpcParams
    // arrays/objects or error objects. Every composite is rebuilt; own
    // "__proto__" DATA keys survive via defineProperty (no setter routing).
    capturedSnapshots.push(snapshotFixtureCapture(entry));
  }

  return deepFreeze({
    schemaVersion: FIXTURE_PROFILE,
    acquiredAt: f.acquiredAt as string,
    source: {
      sourceId: source.sourceId as string,
      sourceType: source.sourceType as string,
      networkId: source.networkId as string,
      chainId: source.chainId as number,
      ...(independenceGroup === undefined ? {} : { independenceGroup }),
    } satisfies EvmFixtureSource,
    subject: { txHash },
    captures: capturedSnapshots,
  });
}

/**
 * Rebuild one already-validated fixture capture into an NEC-owned inert
 * object graph. Only primitives are copied by value; every composite
 * (`rpcParams` tree, `error` object) is freshly allocated.
 */
function snapshotFixtureCapture(entry: Record<string, unknown>): EvmFixtureCapture {
  const snapshot: Record<string, unknown> = {};
  const define = (key: string, value: unknown): void => {
    Object.defineProperty(snapshot, key, { value, enumerable: true, writable: true, configurable: true });
  };
  define("rpcMethod", entry.rpcMethod);
  define("rpcParams", snapshotInertJsonTree(entry.rpcParams));
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
 * Build a replayable fixture from a completed acquisition. Captures carry
 * no secrets by construction, so this projection is always artifact-safe.
 */
export function buildEvmAcquisitionFixture(acquisition: EvmTransactionAcquisition): EvmAcquisitionFixture {
  if (acquisition.profile !== ACQUISITION_PROFILE) {
    throw new NecResolverEvmError("EVM_FIXTURE_INVALID", "not an acquisition of this resolver version");
  }
  return deepFreeze({
    schemaVersion: FIXTURE_PROFILE,
    acquiredAt: acquisition.acquiredAt,
    source: {
      sourceId: acquisition.source.sourceId,
      sourceType: acquisition.source.sourceType,
      networkId: acquisition.source.networkId,
      chainId: acquisition.source.chainId,
      ...(acquisition.source.independenceGroup === undefined
        ? {}
        : { independenceGroup: acquisition.source.independenceGroup }),
    },
    subject: { txHash: acquisition.subject.txHash },
    captures: acquisition.captures.map((capture) => ({
      rpcMethod: capture.rpcMethod,
      rpcParams: [...capture.rpcParams],
      httpStatus: capture.httpStatus,
      resultJson: capture.resultText,
    })),
  });
}
