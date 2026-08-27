/**
 * Descriptor-first inertness gates for hostile object input:
 *
 *   - `assertNotProxy` rejects any Proxy BEFORE a single reflective
 *     operation runs on it (`node:util` types.isProxy inspects internal
 *     state without dispatching a single trap), so no caller-owned trap
 *     can execute or observe NEC's validation behavior;
 *   - `assertInertDataObject` rejects accessor, function-valued,
 *     non-enumerable and SYMBOL-KEYED own properties BEFORE any value is
 *     read, so no getter is ever executed merely to reject the input;
 *   - `assertInertDataArray` proves an array container is a genuine dense
 *     Array.prototype array with data-only canonical index descriptors —
 *     all before `.length`, indexing or iteration;
 *   - `assertInertJsonTree` validates a complete JSON-safe tree the same
 *     descriptor-first way (plain prototypes, dense arrays, enumerable
 *     data properties only, safe integers, bounded depth/nodes/strings);
 *   - `snapshotInertJsonTree` produces an NEC-owned deep copy of an
 *     already-validated inert tree (own "__proto__" DATA keys preserved
 *     via defineProperty, never routed through prototype setters).
 *
 * Shared by fixture validation and rpcParams validation paths. Values are
 * always read from DATA DESCRIPTORS, never through caller-owned accessors.
 */

import { types as utilTypes } from "node:util";

import { NecResolverEvmError } from "./errors.js";
import type { NecResolverEvmErrorCode } from "./errors.js";

/**
 * Reject Proxy values BEFORE any operation that could dispatch a proxy
 * trap. `utilTypes.isProxy` reads V8-internal state only: it never fires
 * get/getPrototypeOf/ownKeys/getOwnPropertyDescriptor traps and detects
 * even revoked proxies.
 */
export function assertNotProxy(
  value: unknown,
  path: string,
  code: NecResolverEvmErrorCode = "EVM_FIXTURE_INVALID",
): void {
  if (typeof value === "object" && value !== null && utilTypes.isProxy(value)) {
    throw new NecResolverEvmError(code, `${path}: proxy values rejected`);
  }
}

export function assertInertDataObject(value: object, path: string, code: "EVM_FIXTURE_INVALID" = "EVM_FIXTURE_INVALID"): void {
  assertNotProxy(value, path, code);
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key === "symbol") {
      throw new NecResolverEvmError(code, `${path}.${String(key)}: symbol-keyed property rejected`);
    }
    const d = descriptors[key as string] as PropertyDescriptor | undefined;
    if (d === undefined) continue;
    if (!d.enumerable || typeof d.get === "function" || typeof d.set === "function") {
      throw new NecResolverEvmError(code, `${path}.${String(key)}: accessor/non-enumerable property rejected`);
    }
    if (typeof d.value === "function") {
      throw new NecResolverEvmError(code, `${path}.${String(key)}: function property rejected`);
    }
  }
}

export interface InertTreeWalkState {
  nodes: number;
}

const MAX_TREE_DEPTH = 64;
const MAX_TREE_NODES = 50_000;
const MAX_TREE_STRING_LENGTH = 1_048_576 / 8;

/**
 * Descriptor-first gate for a HOSTILE ARRAY CONTAINER: proves the value is
 * a genuine, dense `Array.prototype` array whose only own properties are
 * enumerable data descriptors for canonical indexes (plus the intrinsic
 * non-accessor `length`). Rejects Proxies BEFORE any reflective read,
 * subclasses/exotic prototypes, symbol keys (including Symbol.iterator
 * overrides), accessors on any index, sparse holes and extra props — all
 * before `.length` is trusted or a single element is indexed.
 *
 * Returns the validated element count read from the `length` DESCRIPTOR.
 */
export function assertInertDataArray(
  value: unknown,
  path: string,
  code: NecResolverEvmErrorCode = "EVM_FIXTURE_INVALID",
): number {
  // Proxy rejection BEFORE anything else: even spec-level IsArray
  // (Array.isArray) THROWS a raw TypeError on a revoked proxy.
  if (value === null || typeof value !== "object") {
    throw new NecResolverEvmError(code, `${path}: must be an array`);
  }
  assertNotProxy(value, path, code);
  if (!Array.isArray(value)) {
    throw new NecResolverEvmError(code, `${path}: must be an array`);
  }
  const proto = Object.getPrototypeOf(value) as object | null;
  if (proto !== Array.prototype) {
    throw new NecResolverEvmError(code, `${path}: exotic prototype rejected`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
  const lengthDescriptor = descriptors["length"] as PropertyDescriptor | undefined;
  if (
    lengthDescriptor === undefined ||
    typeof lengthDescriptor.get === "function" ||
    typeof lengthDescriptor.set === "function" ||
    typeof lengthDescriptor.value !== "number"
  ) {
    throw new NecResolverEvmError(code, `${path}: invalid array length`);
  }
  const len = lengthDescriptor.value;
  if (!Number.isSafeInteger(len) || len < 0) {
    throw new NecResolverEvmError(code, `${path}: invalid array length`);
  }
  const seenIndexes = new Set<number>();
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key === "symbol") {
      throw new NecResolverEvmError(code, `${path}.${String(key)}: symbol-keyed property rejected`);
    }
    if (key === "length") continue; // intrinsic, already descriptor-checked
    const d = descriptors[key] as PropertyDescriptor | undefined;
    if (
      d === undefined ||
      !d.enumerable ||
      typeof d.get === "function" ||
      typeof d.set === "function" ||
      typeof d.value === "function"
    ) {
      throw new NecResolverEvmError(code, `${path}.${key}: accessor/non-enumerable/function property rejected`);
    }
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index < 0 || String(index) !== key) {
      throw new NecResolverEvmError(code, `${path}.${key}: extra own property on array`);
    }
    seenIndexes.add(index);
  }
  for (let i = 0; i < len; i++) {
    if (!seenIndexes.has(i)) {
      throw new NecResolverEvmError(code, `${path}[${i}]: sparse arrays rejected`);
    }
  }
  if (seenIndexes.size !== len) {
    throw new NecResolverEvmError(code, `${path}: extra own index beyond array length`);
  }
  return len;
}

/**
 * NEC-owned deep copy of an ALREADY-VALIDATED inert JSON-safe tree. Every
 * node is rebuilt from scratch (arrays as fresh arrays, objects as fresh
 * `{}` populated via `Object.defineProperty`, which cannot route an own
 * "__proto__" DATA key through the Object.prototype setter), so no
 * caller-owned object, array or nested composite survives by reference.
 * Pre-condition: the tree passed `assertInertJsonTree`.
 */
export function snapshotInertJsonTree(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value as readonly unknown[]) out.push(snapshotInertJsonTree(item));
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>)) {
    Object.defineProperty(out, key, {
      value: snapshotInertJsonTree((value as Record<string, unknown>)[key]),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

/**
 * Bounded JSON-safe walker for hostile data trees: plain prototypes only,
 * safe integers only, bounded depth/nodes/strings, no accessor read
 * (descriptor-first), no bigints, NO symbol-keyed own properties.
 */
export function assertInertJsonTree(
  value: unknown,
  path: string,
  state: InertTreeWalkState,
  depth: number,
  code: NecResolverEvmErrorCode,
): void {
  if (depth > MAX_TREE_DEPTH) {
    throw new NecResolverEvmError(code, `${path}: exceeds maximum depth of ${MAX_TREE_DEPTH}`);
  }
  state.nodes += 1;
  if (state.nodes > MAX_TREE_NODES) {
    throw new NecResolverEvmError(code, `${path}: exceeds ${MAX_TREE_NODES} values`);
  }
  switch (typeof value) {
    case "string":
      if (value.length > MAX_TREE_STRING_LENGTH) {
        throw new NecResolverEvmError(code, `${path}: string too large`);
      }
      return;
    case "boolean":
      return;
    case "number":
      if (!Number.isSafeInteger(value)) {
        throw new NecResolverEvmError(code, `${path}: non-safe-integer number rejected`);
      }
      return;
    case "object": {
      if (value === null) return;
      // Proxy rejection BEFORE getPrototypeOf/getOwnPropertyDescriptors:
      // both would dispatch caller-owned traps.
      assertNotProxy(value, path, code);
      const proto = Object.getPrototypeOf(value) as object | null;
      const isPlainObject = !Array.isArray(value) && (proto === Object.prototype || proto === null);
      const isArray = Array.isArray(value) && proto === Array.prototype;
      if (!isPlainObject && !isArray) {
        throw new NecResolverEvmError(code, `${path}: non-plain composite value`);
      }
      // Descriptor-first inert-array/plain-object model (mirrors core):
      // dense arrays with prototype Array.prototype and no extra own
      // properties; objects with enumerable plain data properties only.
      // Values are read from DATA DESCRIPTORS so getters never execute.
      const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
      const seenIndexes = new Set<number>();
      for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key === "symbol") {
          throw new NecResolverEvmError(code, `${path}.${String(key)}: symbol-keyed property rejected`);
        }
        const k = key as string;
        if (isArray && k === "length") continue; // intrinsic array length
        const d = descriptors[k];
        if (
          d === undefined ||
          !d.enumerable ||
          typeof d.get === "function" ||
          typeof d.set === "function" ||
          typeof d.value === "function"
        ) {
          throw new NecResolverEvmError(
            code,
            `${path}.${k}: accessor/non-enumerable/function property rejected`,
          );
        }
        if (isArray) {
          const index = Number(k);
          if (!Number.isSafeInteger(index) || index < 0 || String(index) !== k) {
            throw new NecResolverEvmError(code, `${path}.${k}: extra own property on array`);
          }
          seenIndexes.add(index);
        }
      }
      const children: Array<{ key: string; value: unknown }> = [];
      if (isArray) {
        const len = (descriptors["length"] as PropertyDescriptor | undefined)?.value;
        if (typeof len !== "number" || !Number.isSafeInteger(len) || len < 0) {
          throw new NecResolverEvmError(code, `${path}: invalid array length`);
        }
        for (let i = 0; i < len; i++) {
          if (!seenIndexes.has(i)) {
            throw new NecResolverEvmError(code, `${path}[${i}]: sparse arrays rejected`);
          }
          children.push({ key: String(i), value: (descriptors[String(i)] as PropertyDescriptor).value });
        }
        if (seenIndexes.size !== len) {
          throw new NecResolverEvmError(code, `${path}: extra own index beyond array length`);
        }
      } else {
        for (const key of Object.keys(descriptors)) {
          children.push({ key, value: (descriptors[key] as PropertyDescriptor).value });
        }
      }
      for (const child of children) {
        assertInertJsonTree(child.value, `${path}.${child.key}`, state, depth + 1, code);
      }
      return;
    }
    default:
      throw new NecResolverEvmError(code, `${path}: unsupported value type ${typeof value}`);
  }
}
