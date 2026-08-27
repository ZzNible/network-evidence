import { canonicalJson } from "./canonical-json.js";
import { compareUtf16 } from "./internal.js";
import type { Conflict, EvidenceId, PropositionScope, Warning } from "./types.js";

/**
 * Pure conflict and warning handling.
 *
 * NEC has first-class, explicit conflicts. A `Conflict` carries no
 * "resolved" flag: any conflict present in a result is by definition
 * unresolved. Resolution happens only when a resolver applies an explicit
 * deterministic rule and stops emitting the conflict — it is never silent.
 *
 * SEMANTIC SCOPE (v0.1 freeze): every conflict carries an explicit
 * `PropositionScope`. EvidenceId overlap is PROVENANCE ONLY and never
 * defines scope:
 *
 *   - a material conflict scoped to proposition P prevents
 *     supported/contradicted for P and requires ambiguous;
 *   - a material conflict scoped to a different proposition does not affect P;
 *   - a result-scoped material conflict affects EVERY proposition;
 *   - missing/invalid scope fails closed.
 *
 * Source independence note (v0.1): equal `independenceGroup` labels mean
 * known dependence; an absent group means independence is UNKNOWN; two
 * DIFFERENT labels are NOT proof of independence. There is no majority vote.
 *
 * All merge helpers are deterministic: stable order (UTF-16 code-unit sort),
 * structural dedupe of identical entries, fail-closed on identity collisions
 * with differing content.
 */

export function isMaterialConflict(conflict: Conflict): boolean {
  return conflict.material;
}

/** Conflicts that block deterministic conclusions (material ones). */
export function blockingConflicts(conflicts: readonly Conflict[]): Conflict[] {
  return conflicts.filter((conflict) => conflict.material);
}

export function hasBlockingMaterialConflict(conflicts: readonly Conflict[]): boolean {
  return conflicts.some((conflict) => conflict.material);
}

// ---------------------------------------------------------------------------
// Proposition scope semantics
// ---------------------------------------------------------------------------

const EVIDENCE_DIMENSION_NAMES = ["execution", "dataBinding", "settlement", "finality"] as const;

function ownKeysExactly(value: object, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  let count = 0;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key === "symbol") return false;
    if (!expected.has(key)) return false;
    count += 1;
  }
  return count === expected.size;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Structural guard for `PropositionScope`: exact field set per variant,
 * no accessors/symbols/non-enumerable properties, plain prototype.
 */
export function isPropositionScope(value: unknown): value is PropositionScope {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key === "symbol") return false;
    const d = descriptors[key]!;
    if (!d.enumerable || d.get !== undefined || d.set !== undefined) return false;
  }
  const record = value as Record<string, unknown>;
  switch (record.kind) {
    case "result":
      return ownKeysExactly(value, ["kind"]);
    case "dimension":
      return (
        ownKeysExactly(value, ["kind", "dimension"]) &&
        typeof record.dimension === "string" &&
        (EVIDENCE_DIMENSION_NAMES as readonly string[]).includes(record.dimension)
      );
    case "observed_effect":
      return ownKeysExactly(value, ["kind", "effectId"]) && isNonEmptyString(record.effectId);
    case "custom":
      return (
        ownKeysExactly(value, ["kind", "namespace", "id"]) &&
        isNonEmptyString(record.namespace) &&
        isNonEmptyString(record.id)
      );
    default:
      return false;
  }
}

/** True iff two scopes denote the SAME proposition. */
export function samePropositionScope(a: PropositionScope, b: PropositionScope): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "result":
      return true;
    case "dimension":
      return b.kind === "dimension" && a.dimension === b.dimension;
    case "observed_effect":
      return b.kind === "observed_effect" && a.effectId === b.effectId;
    case "custom":
      return b.kind === "custom" && a.namespace === b.namespace && a.id === b.id;
  }
}

/**
 * True iff a material conflict with `conflictScope` affects a proposition
 * scoped `inputScope`: same proposition, or the conflict is result-scoped
 * (a global blocker).
 */
export function conflictAffectsProposition(
  conflictScope: PropositionScope,
  inputScope: PropositionScope,
): boolean {
  return conflictScope.kind === "result" || samePropositionScope(conflictScope, inputScope);
}

function canonicalOf<T>(value: T): string {
  return canonicalJson(value);
}

// ---------------------------------------------------------------------------
// Citation normalization (identity/dedupe/merge/canonical equality)
// ---------------------------------------------------------------------------

/**
 * Identity projection of a Conflict: its set-like citation list is sorted
 * BEFORE any identity comparison, duplicate detection, merge, canonical
 * equality or digest. The same Conflict ID with only citation ordering
 * changed IS the same conflict.
 */
export function normalizedConflictIdentity(conflict: Conflict): Conflict {
  return { ...conflict, evidence: [...conflict.evidence].sort(compareUtf16) };
}

/**
 * Identity projection of a Warning: EvidenceId permutation-invariant.
 * The same Warning with only an EvidenceId permutation must not become a
 * new warning.
 */
export function normalizedWarningIdentity(warning: Warning): Warning {
  return warning.evidence === undefined
    ? warning
    : { ...warning, evidence: [...warning.evidence].sort(compareUtf16) };
}

/**
 * Merge two conflict lists deterministically:
 *   - identities are compared over NORMALIZED projections (citation order
 *     is not content), so the same id with only permuted citations merges;
 *   - exact duplicates (identical structure) are deduplicated,
 *   - same id with genuinely different content throws (identity collision;
 *     fail closed — semantically different conflicts are never discarded),
 *   - result sorted by id (UTF-16 code-unit order).
 *
 * The returned conflicts are the normalized representatives, so output is
 * deterministic regardless of input citation ordering.
 */
export function mergeConflicts(a: readonly Conflict[], b: readonly Conflict[]): Conflict[] {
  const byId = new Map<string, Conflict>();
  for (const conflict of [...a, ...b]) {
    const normalized = normalizedConflictIdentity(conflict);
    const existing = byId.get(normalized.id);
    if (existing === undefined) {
      byId.set(normalized.id, normalized);
      continue;
    }
    if (canonicalJson(existing) !== canonicalJson(normalized)) {
      throw new Error(
        `conflict id collision with different content: ${JSON.stringify(normalized.id)}`,
      );
    }
  }
  return [...byId.values()].sort((x, y) => compareUtf16(x.id, y.id));
}

/**
 * Merge two warning lists deterministically:
 *   - identity is computed over NORMALIZED projections (an EvidenceId
 *     permutation of one warning collapses into the same warning),
 *   - structurally identical warnings are deduplicated (identical content
 *     carries zero additional information; artifact validators reject
 *     duplicates outright so nothing silently enters an artifact),
 *   - distinct warnings are never dropped,
 *   - result sorted by canonical form of the normalized projection.
 */
export function mergeWarnings(a: readonly Warning[], b: readonly Warning[]): Warning[] {
  const seen = new Map<string, Warning>();
  for (const item of [...a, ...b]) {
    const normalized = normalizedWarningIdentity(item);
    seen.set(canonicalOf(normalized), normalized);
  }
  return [...seen.values()].sort((x, y) => compareUtf16(canonicalOf(x), canonicalOf(y)));
}
