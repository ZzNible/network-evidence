import { createHash } from "node:crypto";

import { LENS_CANONICALIZATION_PROFILE } from "./types.js";

const MAX_DEPTH = 64;
const MAX_NODES = 100_000;
const MAX_STRING_BYTES = 1_048_576;
const MAX_OUTPUT_BYTES = 8_388_608;

interface WalkState {
  nodes: number;
  bytes: number;
  ancestors: Set<object>;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function addBytes(state: WalkState, text: string): void {
  state.bytes += byteLength(text);
  if (state.bytes > MAX_OUTPUT_BYTES) {
    throw new TypeError("@nec/lens: canonical output exceeds byte limit");
  }
}

function emit(state: WalkState, text: string): string {
  addBytes(state, text);
  return text;
}

function assertUnicodeScalarString(value: string): void {
  if (byteLength(value) > MAX_STRING_BYTES) throw new TypeError("@nec/lens: string exceeds byte limit");
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError("@nec/lens: unpaired surrogate");
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError("@nec/lens: unpaired surrogate");
    }
  }
}

function serialize(value: unknown, state: WalkState, depth: number): string {
  state.nodes++;
  if (state.nodes > MAX_NODES) throw new TypeError("@nec/lens: value exceeds node limit");
  if (depth > MAX_DEPTH) throw new TypeError("@nec/lens: value exceeds depth limit");

  if (value === null) return emit(state, "null");
  if (typeof value === "string") {
    assertUnicodeScalarString(value);
    return emit(state, JSON.stringify(value));
  }
  if (typeof value === "boolean") return emit(state, value ? "true" : "false");
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new TypeError("@nec/lens: non-canonical number");
    return emit(state, JSON.stringify(value));
  }
  if (typeof value !== "object") throw new TypeError("@nec/lens: value is not JSON-safe");

  const object = value as object;
  if (state.ancestors.has(object)) throw new TypeError("@nec/lens: circular value");
  state.ancestors.add(object);
  try {
    if (Array.isArray(value)) {
      const ownKeys = Reflect.ownKeys(value);
      for (const key of ownKeys) {
        if (key === "length") continue;
        if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(key)) {
          throw new TypeError("@nec/lens: arrays may not have extra properties");
        }
      }
      addBytes(state, "[");
      const parts: string[] = [];
      for (let i = 0; i < value.length; i++) {
        if (!Object.hasOwn(value, i)) throw new TypeError("@nec/lens: sparse arrays are not allowed");
        if (i > 0) addBytes(state, ",");
        parts.push(serialize(value[i], state, depth + 1));
      }
      addBytes(state, "]");
      return `[${parts.join(",")}]`;
    }

    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new TypeError("@nec/lens: only plain objects are allowed");
    const ownKeys = Reflect.ownKeys(value);
    for (const key of ownKeys) {
      if (typeof key !== "string") throw new TypeError("@nec/lens: symbol properties are not allowed");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
        throw new TypeError("@nec/lens: non-enumerable/accessor properties are not allowed");
      }
    }
    const names = (ownKeys as string[]).sort();
    addBytes(state, "{");
    const parts: string[] = [];
    for (let i = 0; i < names.length; i++) {
      const name = names[i]!;
      if (i > 0) addBytes(state, ",");
      assertUnicodeScalarString(name);
      const key = JSON.stringify(name);
      addBytes(state, key);
      addBytes(state, ":");
      const descriptor = Object.getOwnPropertyDescriptor(value, name)!;
      parts.push(`${key}:${serialize(descriptor.value, state, depth + 1)}`);
    }
    addBytes(state, "}");
    return `{${parts.join(",")}}`;
  } finally {
    state.ancestors.delete(object);
  }
}

/** Authority-compatible sorted-key JSON over a bounded, stricter JSON-safe input domain. */
export function canonicalHubJsonV01(value: unknown): string {
  return serialize(value, { nodes: 0, bytes: 0, ancestors: new Set() }, 1);
}

export function hubRevisionDigestV01(value: unknown): {
  algorithm: "sha256";
  value: string;
  digestOf: "hub_owned_case_revision";
  schemaVersion: "lens-case/v0.1";
  canonicalization: typeof LENS_CANONICALIZATION_PROFILE;
  byteLength: number;
} {
  const serialized = canonicalHubJsonV01(value);
  return {
    algorithm: "sha256",
    value: createHash("sha256").update(serialized, "utf8").digest("hex"),
    digestOf: "hub_owned_case_revision",
    schemaVersion: "lens-case/v0.1",
    canonicalization: LENS_CANONICALIZATION_PROFILE,
    byteLength: byteLength(serialized),
  };
}
