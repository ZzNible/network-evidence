import { NecValidationError } from "./errors.js";
import { assertInertArray } from "./internal.js";
import { validateCapabilityState, validateEvidenceRef } from "./validate.js";
import type { CapabilityState, EvidenceRef } from "./types.js";

/**
 * Capability claim authority (v0.1 freeze, R3 revision + freeze-final
 * hardening).
 *
 * SUPPORT and AVAILABILITY are different concepts (NEC invariant):
 *   - support      = the resolver knows how to evaluate this capability
 *                    for this network/deployment;
 *   - availability = the required live sources are usable right now.
 *
 * A CapabilitySnapshot is an OBSERVED/EVALUATED artifact, not a declaration
 * that becomes true merely because a resolver returned it. A capability is
 * usable ONLY when ALL of the following hold:
 *
 *   1. support      == "supported"   (unconditional; `conditional` support
 *                                     carries an unproven activation
 *                                     condition and fails closed),
 *   2. availability == "available"   (manifest support alone never proves
 *                                     current network availability),
 *   3. the usable claim cites NON-EMPTY evidence AND every cited EvidenceId
 *      RESOLVES against a COMPLETE VALIDATED EvidenceRef table supplied by
 *      the caller — typically the snapshot's own evidence table.
 *
 * FREEZE-FINAL HARDENING: both inputs are inert-read BEFORE any use.
 *
 *   - The `state` is fully validated (`validateCapabilityState`) first, so
 *     accessors/symbol keys/exotic prototypes fail closed without any
 *     getter executing and unknown runtime enum values never silently
 *     compare unequal.
 *   - The evidence table must be an ORDINARY DENSE INERT array (THE shared
 *     descriptor-first model): custom iterators, accessor indexes, array
 *     subclasses, extra own properties and sparse layouts are rejected
 *     before any element is read; every entry must be a COMPLETE VALIDATED
 *     EvidenceRef (never a bare `{id}` stub); DUPLICATE EvidenceIds are
 *     REJECTED — never last-write-wins.
 *
 * v0.1 accepts exactly ONE index shape (a plain `EvidenceRef[]`). Map
 * support was REMOVED for auditability: it added caller-overridable
 * traversal surfaces (`entries`/`forEach`/`Symbol.iterator`) for no
 * semantic gain. This is helper hardening, not a contract redesign.
 */

/** The one accepted evidence-index shape: an inert array of COMPLETE refs. */
export type EvidenceIndexInput = readonly EvidenceRef[];

function toIndex(table: EvidenceIndexInput): ReadonlyMap<string, EvidenceRef> {
  // Inert-array acceptance BEFORE any element is touched: no getter,
  // iterator or entries() override of the caller-owned array can run.
  assertInertArray(table, "capabilityIsUsable.evidenceTable");
  const map = new Map<string, EvidenceRef>();
  for (let i = 0; i < table.length; i++) {
    const ref = table[i] as EvidenceRef;
    // Complete validation BEFORE the id is read (never through a getter).
    validateEvidenceRef(ref, "capabilityIsUsable.evidenceTable");
    if (map.has(ref.id)) {
      throw new NecValidationError(
        "NEC_VALIDATION_FAILED",
        `duplicate EvidenceId ${JSON.stringify(ref.id)} in the supplied evidence table; failing closed`,
      );
    }
    map.set(ref.id, ref);
  }
  return map;
}

/**
 * True iff a capability is usable NOW with no unproven preconditions:
 * unconditional support, currently-available live sources, AND every cited
 * EvidenceId resolving against the COMPLETE VALIDATED evidence table
 * supplied by the caller. `conditional` support is never "usable";
 * supported+available with missing/empty/unresolvable citations is NOT
 * usable. Throws `NecValidationError` if the state itself is malformed or
 * the supplied table is not inert/complete/duplicate-free.
 */
export function capabilityIsUsable(
  state: CapabilityState,
  evidenceTable: EvidenceIndexInput,
): boolean {
  // Inert validation of the state BEFORE any field read: accessors,
  // symbol-keyed properties, exotic prototypes and unknown enum values all
  // fail closed with a controlled NEC error instead of influencing the
  // comparison through caller-controlled surfaces.
  validateCapabilityState(state, "capabilityIsUsable.state");
  if (state.support !== "supported" || state.availability !== "available") {
    return false;
  }
  if (state.evidence === undefined || state.evidence.length === 0) {
    return false;
  }
  const index = toIndex(evidenceTable);
  for (const id of state.evidence) {
    if (!index.has(id)) {
      return false;
    }
  }
  return true;
}

/**
 * True iff a capability state deterministically expresses INCAPABILITY:
 * the resolver knows it cannot evaluate the capability, or the live sources
 * are known to be unusable/degraded right now. Used by discovery
 * classification to separate definite negatives (`unsatisfied`) from
 * undetermined states (`unknown`).
 */
export function capabilityIsDeterministicallyUnavailable(state: CapabilityState): boolean {
  return (
    state.support === "unsupported" ||
    state.availability === "unavailable" ||
    state.availability === "degraded"
  );
}
