import { deepFreeze } from "@nec/core";
import { types as utilTypes } from "node:util";

import { ACQUISITION_PROFILE } from "./acquire.js";
import type { SolanaTransactionAcquisition } from "./acquire.js";
import { parseSignature } from "./base58.js";
import { NecResolverSolanaError, solanaFail } from "./errors.js";
import { exchangeIdentityKey } from "./rpc.js";

export const FIXTURE_PROFILE = "nec-resolver-solana-fixture-v1";

export interface SolanaFixtureSource {
  readonly sourceId: string;
  readonly sourceType: "svm_rpc";
  readonly networkId: string;
  readonly independenceGroup?: string;
}

export type SolanaFixtureCapture =
  | { readonly rpcMethod: string; readonly rpcParams: readonly unknown[]; readonly httpStatus: number; readonly resultJson: string }
  | { readonly rpcMethod: string; readonly rpcParams: readonly unknown[]; readonly httpStatus: number; readonly error: { readonly code: number; readonly message: string } };

export interface SolanaAcquisitionFixture {
  readonly schemaVersion: typeof FIXTURE_PROFILE;
  readonly acquiredAt: string;
  readonly source: SolanaFixtureSource;
  readonly networkId: string;
  readonly subject: { readonly signature: string };
  readonly captures: readonly SolanaFixtureCapture[];
}

function assertInert(value: unknown, path: string, state: { nodes: number }, depth = 0): void {
  state.nodes += 1;
  if (state.nodes > 20_000 || depth > 64) solanaFail("SOLANA_FIXTURE_INVALID", `${path}: fixture limits exceeded`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) solanaFail("SOLANA_FIXTURE_INVALID", `${path}: numbers must be safe integers`);
    return;
  }
  if (typeof value !== "object" || utilTypes.isProxy(value)) solanaFail("SOLANA_FIXTURE_INVALID", `${path}: non-inert value rejected`);
  const proto = Object.getPrototypeOf(value);
  const isArray = Array.isArray(value);
  if (isArray) {
    if (proto !== Array.prototype) solanaFail("SOLANA_FIXTURE_INVALID", `${path}: exotic array rejected`);
    for (let i = 0; i < value.length; i++) if (!Object.prototype.hasOwnProperty.call(value, i)) solanaFail("SOLANA_FIXTURE_INVALID", `${path}: sparse array rejected`);
  } else if (proto !== Object.prototype && proto !== null) {
    solanaFail("SOLANA_FIXTURE_INVALID", `${path}: exotic object rejected`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (isArray && key === "length") continue;
    if (typeof key !== "string") solanaFail("SOLANA_FIXTURE_INVALID", `${path}: symbol property rejected`);
    if (isArray && !/^(0|[1-9][0-9]*)$/.test(key)) solanaFail("SOLANA_FIXTURE_INVALID", `${path}: extra array property rejected`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) solanaFail("SOLANA_FIXTURE_INVALID", `${path}.${key}: accessor/hidden property rejected`);
    assertInert(descriptor.value, `${path}.${key}`, state, depth + 1);
  }
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) solanaFail("SOLANA_FIXTURE_INVALID", `${path}: unknown key ${key}`);
}

function privacyScan(value: unknown, path = "fixture"): void {
  if (typeof value === "string") {
    if (/https?:\/\//i.test(value) || /(^|[\\/])(?:home|Users)[\\/]/.test(value) || /(?:api[_-]?key|access[_-]?token|authorization|credential|secret|private[_-]?key)\s*[:=]/i.test(value)) {
      solanaFail("SOLANA_FIXTURE_INVALID", `${path}: endpoint, credential, private path, or secret-like text rejected`);
    }
    return;
  }
  if (Array.isArray(value)) value.forEach((entry, i) => privacyScan(entry, `${path}[${i}]`));
  else if (value && typeof value === "object") for (const [key, entry] of Object.entries(value)) {
    if (/(?:api[_-]?key|access[_-]?token|authorization|credential|secret|private[_-]?key)/i.test(key)) solanaFail("SOLANA_FIXTURE_INVALID", `${path}.${key}: credential-like key rejected`);
    privacyScan(entry, `${path}.${key}`);
  }
}

export function validateSolanaAcquisitionFixture(value: unknown): SolanaAcquisitionFixture {
  assertInert(value, "fixture", { nodes: 0 });
  if (value === null || typeof value !== "object" || Array.isArray(value)) solanaFail("SOLANA_FIXTURE_INVALID", "fixture must be an object");
  const f = value as Record<string, unknown>;
  exactKeys(f, ["schemaVersion", "acquiredAt", "source", "networkId", "subject", "captures"], "fixture");
  if (f.schemaVersion !== FIXTURE_PROFILE || typeof f.acquiredAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(f.acquiredAt)) solanaFail("SOLANA_FIXTURE_INVALID", "invalid fixture schemaVersion/acquiredAt");
  if (f.source === null || typeof f.source !== "object" || Array.isArray(f.source)) solanaFail("SOLANA_FIXTURE_INVALID", "fixture.source must be an object");
  const source = f.source as Record<string, unknown>;
  exactKeys(source, ["sourceId", "sourceType", "networkId", "independenceGroup"], "fixture.source");
  if (typeof source.sourceId !== "string" || source.sourceType !== "svm_rpc" || typeof source.networkId !== "string" || source.networkId !== f.networkId) solanaFail("SOLANA_FIXTURE_INVALID", "invalid fixture source identity/network binding");
  if (source.independenceGroup !== undefined && typeof source.independenceGroup !== "string") solanaFail("SOLANA_FIXTURE_INVALID", "invalid independenceGroup");
  if (f.subject === null || typeof f.subject !== "object" || Array.isArray(f.subject)) solanaFail("SOLANA_FIXTURE_INVALID", "fixture.subject must be an object");
  const subject = f.subject as Record<string, unknown>;
  exactKeys(subject, ["signature"], "fixture.subject");
  const signature = parseSignature(subject.signature, "fixture.subject.signature");
  if (!Array.isArray(f.captures) || f.captures.length < 3 || f.captures.length > 4) solanaFail("SOLANA_FIXTURE_INVALID", "fixture.captures must contain 3 or 4 ordered captures");
  const captures = f.captures as unknown[];
  const keys = new Set<string>();
  for (let i = 0; i < captures.length; i++) {
    const capture = captures[i];
    if (capture === null || typeof capture !== "object" || Array.isArray(capture)) solanaFail("SOLANA_FIXTURE_INVALID", `captures[${i}] must be an object`);
    const c = capture as Record<string, unknown>;
    exactKeys(c, ["rpcMethod", "rpcParams", "httpStatus", "resultJson", "error"], `captures[${i}]`);
    if (typeof c.rpcMethod !== "string" || !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(c.rpcMethod) || !Array.isArray(c.rpcParams) || typeof c.httpStatus !== "number" || !Number.isInteger(c.httpStatus)) solanaFail("SOLANA_FIXTURE_INVALID", `captures[${i}] has invalid request/status shape`);
    if ((typeof c.resultJson === "string") === (c.error !== undefined)) solanaFail("SOLANA_FIXTURE_INVALID", `captures[${i}] must carry exactly one resultJson or error`);
    if (typeof c.resultJson === "string") {
      if (Buffer.byteLength(c.resultJson) > 2_000_000) solanaFail("SOLANA_FIXTURE_INVALID", `captures[${i}].resultJson too large`);
      try { JSON.parse(c.resultJson); } catch { solanaFail("SOLANA_FIXTURE_INVALID", `captures[${i}].resultJson malformed`); }
    } else {
      if (c.error === null || typeof c.error !== "object" || Array.isArray(c.error)) solanaFail("SOLANA_FIXTURE_INVALID", `captures[${i}].error malformed`);
      const e = c.error as Record<string, unknown>;
      exactKeys(e, ["code", "message"], `captures[${i}].error`);
      if (!Number.isSafeInteger(e.code) || typeof e.message !== "string") solanaFail("SOLANA_FIXTURE_INVALID", `captures[${i}].error malformed`);
    }
    const key = exchangeIdentityKey(c.rpcMethod, c.rpcParams as unknown[]);
    if (keys.has(key)) solanaFail("SOLANA_FIXTURE_INVALID", `captures[${i}] duplicates a request`);
    keys.add(key);
  }
  privacyScan(value);
  const snapshot = JSON.parse(JSON.stringify(value)) as SolanaAcquisitionFixture;
  return deepFreeze(snapshot);
}

export function buildSolanaAcquisitionFixture(acquisition: SolanaTransactionAcquisition): SolanaAcquisitionFixture {
  if (acquisition.profile !== ACQUISITION_PROFILE) throw new NecResolverSolanaError("SOLANA_FIXTURE_INVALID", "not a resolver-solana acquisition");
  return deepFreeze({
    schemaVersion: FIXTURE_PROFILE,
    acquiredAt: acquisition.acquiredAt,
    source: { ...acquisition.source },
    networkId: acquisition.source.networkId,
    subject: { signature: acquisition.subject.signature },
    captures: acquisition.captures.map((capture) => ({ rpcMethod: capture.rpcMethod, rpcParams: [...capture.rpcParams], httpStatus: capture.httpStatus, resultJson: capture.resultText })),
  });
}
