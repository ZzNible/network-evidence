/** Descriptor-first ownership boundary for all zkSYS caller input. */

import { types as utilTypes } from "node:util";

import { RESOURCE_LIMITS, validateEvidenceRef } from "@nec/core";
import type { EvidenceRef } from "@nec/core";

import { zksysFail } from "./errors.js";

const ARRAY_INDEX = /^(0|[1-9][0-9]*)$/;

function rejectProxy(value: unknown, path: string): void {
  if (typeof value === "object" && value !== null && utilTypes.isProxy(value)) {
    zksysFail("ZKSYS_INPUT_INVALID", `${path}: proxy values are not allowed`);
  }
}

/**
 * Inspect one object entirely through own property descriptors. No semantic
 * value is read until accessors, symbols, exotic prototypes and field-set
 * deviations have all been rejected.
 */
export function readExactObject(
  value: unknown,
  path: string,
  allowed: readonly string[],
  required: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    zksysFail("ZKSYS_INPUT_INVALID", `${path} must be a plain object`);
  }
  rejectProxy(value, path);
  if (Array.isArray(value)) {
    zksysFail("ZKSYS_INPUT_INVALID", `${path} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    zksysFail("ZKSYS_INPUT_INVALID", `${path} has an exotic prototype`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length > RESOURCE_LIMITS.MAX_CONTAINER_ENTRIES) {
    zksysFail("ZKSYS_INPUT_INVALID", `${path} has too many properties`);
  }
  const captured: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key === "symbol") {
      zksysFail("ZKSYS_INPUT_INVALID", `${path} has a symbol-keyed property`);
    }
    if (!allowed.includes(key)) {
      zksysFail("ZKSYS_INPUT_INVALID", `${path} has unknown key ${JSON.stringify(key)}`);
    }
    const descriptor = descriptors[key]!;
    if (
      !descriptor.enumerable ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      !("value" in descriptor) ||
      typeof descriptor.value === "function"
    ) {
      zksysFail("ZKSYS_INPUT_INVALID", `${path}.${key} must be an enumerable data property`);
    }
    if (descriptor.value === undefined) {
      zksysFail("ZKSYS_INPUT_INVALID", `${path}.${key} must not be explicit undefined`);
    }
    captured[key] = descriptor.value;
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(captured, key)) {
      zksysFail("ZKSYS_INPUT_INVALID", `${path} is missing ${JSON.stringify(key)}`);
    }
  }
  return captured;
}

/** Validate and snapshot an ordinary dense caller array without iteration. */
export function readInertArray(value: unknown, path: string): unknown[] {
  if (value === null || typeof value !== "object") {
    zksysFail("ZKSYS_INPUT_INVALID", `${path} must be an array`);
  }
  rejectProxy(value, path);
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    zksysFail("ZKSYS_INPUT_INVALID", `${path} must be an ordinary array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
  const lengthDescriptor = descriptors.length;
  if (
    lengthDescriptor === undefined ||
    lengthDescriptor.get !== undefined ||
    lengthDescriptor.set !== undefined ||
    lengthDescriptor.enumerable ||
    lengthDescriptor.configurable ||
    typeof lengthDescriptor.value !== "number" ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    lengthDescriptor.value > RESOURCE_LIMITS.MAX_CONTAINER_ENTRIES
  ) {
    zksysFail("ZKSYS_INPUT_INVALID", `${path} has an invalid length descriptor`);
  }
  const length = lengthDescriptor.value;
  const captured = new Array<unknown>(length);
  let indexes = 0;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key === "symbol") {
      zksysFail("ZKSYS_INPUT_INVALID", `${path} has a symbol-keyed property`);
    }
    if (key === "length") continue;
    if (!ARRAY_INDEX.test(key)) {
      zksysFail("ZKSYS_INPUT_INVALID", `${path} has an augmented property ${JSON.stringify(key)}`);
    }
    const index = Number(key);
    const descriptor = descriptors[key]!;
    if (
      index >= length ||
      !descriptor.enumerable ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      !("value" in descriptor) ||
      typeof descriptor.value === "function"
    ) {
      zksysFail("ZKSYS_INPUT_INVALID", `${path}[${key}] must be an enumerable data property`);
    }
    captured[index] = descriptor.value;
    indexes += 1;
  }
  if (indexes !== length) {
    zksysFail("ZKSYS_INPUT_INVALID", `${path} must be dense (sparse arrays are rejected)`);
  }
  return captured;
}

interface CloneState {
  nodes: number;
  readonly ancestors: Set<object>;
}

function cloneMetadataValue(value: unknown, path: string, state: CloneState, depth: number): unknown {
  if (depth > RESOURCE_LIMITS.MAX_DEPTH) {
    zksysFail("ZKSYS_INPUT_INVALID", `${path} exceeds the maximum nesting depth`);
  }
  state.nodes += 1;
  if (state.nodes > RESOURCE_LIMITS.MAX_TOTAL_NODES) {
    zksysFail("ZKSYS_INPUT_INVALID", `${path} exceeds the maximum value count`);
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > RESOURCE_LIMITS.MAX_STRING_UTF8_BYTES) {
      zksysFail("ZKSYS_INPUT_INVALID", `${path} string is too large`);
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      zksysFail("ZKSYS_INPUT_INVALID", `${path} must be a safe integer`);
    }
    return value;
  }
  if (typeof value !== "object") {
    zksysFail("ZKSYS_INPUT_INVALID", `${path} is not inert JSON data`);
  }
  rejectProxy(value, path);
  if (state.ancestors.has(value)) {
    zksysFail("ZKSYS_INPUT_INVALID", `${path} contains a cycle`);
  }
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items = readInertArray(value, path);
      const owned: unknown[] = [];
      for (let i = 0; i < items.length; i++) {
        owned.push(cloneMetadataValue(items[i], `${path}[${i}]`, state, depth + 1));
      }
      return owned;
    }
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      zksysFail("ZKSYS_INPUT_INVALID", `${path} has an exotic prototype`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length > RESOURCE_LIMITS.MAX_CONTAINER_ENTRIES) {
      zksysFail("ZKSYS_INPUT_INVALID", `${path} has too many properties`);
    }
    const owned: Record<string, unknown> = {};
    for (const key of keys) {
      if (typeof key === "symbol") {
        zksysFail("ZKSYS_INPUT_INVALID", `${path} has a symbol-keyed property`);
      }
      const descriptor = descriptors[key]!;
      if (
        !descriptor.enumerable ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        !("value" in descriptor) ||
        descriptor.value === undefined ||
        typeof descriptor.value === "function"
      ) {
        zksysFail("ZKSYS_INPUT_INVALID", `${path}.${key} must be an enumerable defined data property`);
      }
      Object.defineProperty(owned, key, {
        value: cloneMetadataValue(descriptor.value, `${path}.${key}`, state, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return owned;
  } finally {
    state.ancestors.delete(value);
  }
}

function ownedEvidenceRef(value: unknown, path: string): EvidenceRef {
  const fields = readExactObject(
    value,
    path,
    [
      "id", "sourceId", "sourceType", "independenceGroup", "locator", "retrievedAt",
      "contentDigest", "networkId", "blockNumber", "blockId", "metadata", "nativeSource",
    ],
    ["id", "sourceId", "sourceType", "retrievedAt"],
  );
  const owned: Record<string, unknown> = {};
  for (const key of [
    "id", "sourceId", "sourceType", "independenceGroup", "locator", "retrievedAt",
    "contentDigest", "networkId", "blockNumber", "blockId",
  ]) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) owned[key] = fields[key];
  }
  if (Object.prototype.hasOwnProperty.call(fields, "metadata")) {
    owned.metadata = cloneMetadataValue(fields.metadata, `${path}.metadata`, { nodes: 0, ancestors: new Set() }, 1);
  }
  if (Object.prototype.hasOwnProperty.call(fields, "nativeSource")) {
    const native = readExactObject(
      fields.nativeSource,
      `${path}.nativeSource`,
      ["namespace", "mediaType", "encoding", "payload", "contentDigest", "schema"],
      ["namespace", "mediaType", "encoding", "payload", "contentDigest"],
    );
    owned.nativeSource = { ...native };
  }
  try {
    validateEvidenceRef(owned, path);
  } catch (error) {
    zksysFail("ZKSYS_INPUT_INVALID", (error as Error).message);
  }
  return owned as unknown as EvidenceRef;
}

export function ownedEvidenceArray(value: unknown, path: string): EvidenceRef[] {
  const items = readInertArray(value, path);
  const owned: EvidenceRef[] = [];
  const ids = new Set<string>();
  for (let i = 0; i < items.length; i++) {
    const ref = ownedEvidenceRef(items[i], `${path}[${i}]`);
    if (ids.has(ref.id)) {
      zksysFail("ZKSYS_INPUT_INVALID", `${path} contains duplicate EvidenceId ${JSON.stringify(ref.id)}`);
    }
    ids.add(ref.id);
    owned.push(ref);
  }
  return owned;
}
