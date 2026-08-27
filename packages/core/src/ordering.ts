import { canonicalJson } from "./canonical-json.js";
import { assertInertArray, compareUtf16 } from "./internal.js";

/**
 * Canonical ordering for SET-LIKE collections (v0.1 freeze decision).
 *
 * Every NEC collection is declared either an ORDERED LIST or a SET-LIKE
 * COLLECTION. Set-like collections have unique entries and a defined
 * canonical order; arbitrary input order never changes semantic digests.
 * Duplicates are REJECTED by validation — never silently discarded.
 *
 * All copies are made with plain index loops after the ONE shared
 * inert-array model (`assertInertArray`) has accepted the layout: the
 * caller-controlled `Symbol.iterator`/`map`/`entries` surfaces of untrusted
 * arrays are never invoked.
 */

/** Index-loop copy of an inert array (no iterator protocol involved). */
function inertCopy<T>(items: readonly T[], path: string): T[] {
  assertInertArray(items, path);
  const copy: T[] = [];
  for (let i = 0; i < items.length; i++) {
    copy.push(items[i]!);
  }
  return copy;
}

/** Sort set-like `{ id: string }` entries canonically by id (UTF-16 order). */
export function sortedById<T extends { id: string }>(items: readonly T[]): T[] {
  return inertCopy(items, "sortedById").sort((a, b) => compareUtf16(a.id, b.id));
}

/** Sort entries canonically by a derived string key (UTF-16 order). */
export function sortedByKey<T>(items: readonly T[], key: (item: T) => string): T[] {
  return inertCopy(items, "sortedByKey").sort((a, b) => compareUtf16(key(a), key(b)));
}

/** Sort entries canonically by their canonical JSON form (UTF-16 order). */
export function sortedByCanonical<T>(items: readonly T[]): T[] {
  return inertCopy(items, "sortedByCanonical").sort((a, b) =>
    compareUtf16(canonicalJson(a), canonicalJson(b)),
  );
}

/** Sort string collections canonically (UTF-16 code-unit order). */
export function sortedStrings(items: readonly string[]): string[] {
  return inertCopy(items, "sortedStrings").sort(compareUtf16);
}
