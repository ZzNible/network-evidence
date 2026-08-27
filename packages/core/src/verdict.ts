import { conflictAffectsProposition, isPropositionScope } from "./conflict.js";
import { isEvidenceBasis, isEvidenceVerdict } from "./applicability.js";
import { assertInertArray, compareUtf16, inertArrayElements } from "./internal.js";
import { NecValidationError } from "./errors.js";
import {
  assertNecIdentifier,
  assertPlainDataContractObject,
  validateConflict,
  validateEvidenceRef,
} from "./validate.js";
import type {
  Applicability,
  Conflict,
  EvidenceBasis,
  EvidenceId,
  EvidenceVerdict,
  EvidenceRef,
  PropositionScope,
  Warning,
} from "./types.js";

/**
 * Pure, deterministic verdict composition — THE one normative
 * applicability/verdict state machine shared by public composition helpers,
 * fragment validation and full-result validation.
 *
 * Every composition input identifies the proposition it evaluates via an
 * explicit `scope`; a missing or invalid scope fails closed.
 *
 * The outcome is COMPLETE and EvidenceDimension-compatible: it carries an
 * applicability, an optional verdict (present iff applicability is
 * "applicable"), basis and evidence citations, plus explicit warnings.
 * Nothing is silently normalized away.
 *
 * FINAL FREEZE CLOSURE (fail closed end to end):
 *
 *   - INERT INPUTS: the caller-owned input array and every contribution's
 *     basis/evidence arrays are accepted only under THE shared inert-array
 *     model (descriptor-first; no getter is ever invoked, custom iterators
 *     /entries/map overrides cannot influence composition) BEFORE any value
 *     is read.
 *   - COMPLETE SNAPSHOT BEFORE AGGREGATION: every contribution is fully
 *     validated before any ladder decision — an unknown contribution never
 *     shields a malformed positive one (`[valid unknown, malformed
 *     supported]` THROWS; nothing early-returns past an invalid input).
 *   - EVIDENCEREF CLOSURE: the supplied index/table is fully validated
 *     first (complete refs only, keys matching ref.id, DUPLICATE EvidenceIds
 *     rejected — never last-write-wins) and every positive contribution's
 *     citations must resolve against it.
 *   - CONFLICT CLOSURE: EVERY supplied Conflict is completely validated
 *     before use (exact schema, explicit scope with NEC identifier grammar,
 *     boolean material flag, unique conflict ids, all cited EvidenceIds
 *     resolving against the validated index). A malformed conflict can
 *     never force `ambiguous`. (An `observed_effect` scope referencing a
 *     real effect is enforced by artifact validation, which owns the
 *     effect table.)
 *   - SINGLE NORMATIVE GATE: every output branch — unknown,
 *     not_applicable, insufficient, supported, contradicted AND the
 *     ambiguous/conflict branch — passes through ONE final
 *     `assertNormativePropositionState` gate before returning. No branch
 *     returns before this gate.
 *
 * PER-CONTRIBUTION VALIDATION (R3, before any aggregation). Each input is
 * validated INDEPENDENTLY; an invalid contribution is REJECTED — never
 * silently converted into another verdict:
 *
 *   - unknown runtime verdict strings fail closed ("nonsense" never becomes
 *     insufficient);
 *   - a `supported` / `contradicted` contribution requires
 *       applicability == "applicable",
 *       non-empty basis,
 *       non-empty evidence citations,
 *       every cited EvidenceId resolving against COMPLETE VALIDATED
 *       EvidenceRefs supplied via `options.evidenceRefs`;
 *   - an `ambiguous` contribution must be justified by at least one
 *     affecting material Conflict;
 *   - verdicts may only ride on applicable propositions.
 *
 * PROOF NON-LAUNDERING (R3): the composed outcome's provenance is drawn
 * ONLY from contributions that AGREE with the outcome verdict. Evidence
 * backing a SUPPORTED contribution can never become the provenance of a
 * CONTRADICTED conclusion (or vice versa); the inputs are never globally
 * unioned before choosing a verdict.
 *
 * NORMATIVE COMPOSITION LADDER (evaluated in order, first match wins):
 *
 *   0. No inputs at all
 *        -> applicability "unknown", NO verdict (+ warning).
 *   1. All inputs "not_applicable"
 *        -> applicability "not_applicable", NO verdict.
 *   2. Any considered input "unknown"
 *        -> applicability "unknown", NO verdict (never laundered).
 *   3. Any considered proposition affected by a material conflict
 *        -> "applicable" + "ambiguous" (+ warning; the ambiguous outcome's
 *           basis/evidence MAY include the validated conflicting
 *           observations of every considered contribution).
 *   4. Aggregate the independently-validated contributions:
 *        - supported AND contradicted both present with NO affecting
 *          material conflict -> FAIL CLOSED: the disagreement must be
 *          represented explicitly as a Conflict by the caller/resolver;
 *        - any contradicted   -> "contradicted" (provenance from the
 *                                contradicted contributions only);
 *        - all supported      -> "supported" (provenance from the
 *                                supported contributions only);
 *        - otherwise          -> "insufficient" (provenance from the
 *                                insufficient contributions only);
 *      A missing verdict on an applicable input is an insufficient
 *      contribution (absence of proof, not invalidity).
 *
 * The FINAL outcome is re-checked against the same normative state-machine
 * helper used by full-artifact validation (`assertNormativePropositionState`)
 * — there is no separate shadow truth table. These functions are pure: no
 * filesystem, network, clock, or hidden mutable state.
 */

/** Warning codes emitted by composition. Stable identifiers, not prose. */
export const COMPOSITION_WARNING_CODES = {
  noDimensionsEvaluated: "NO_DIMENSIONS_EVALUATED",
  materialConflictBlocksConclusion: "MATERIAL_CONFLICT_BLOCKS_CONCLUSION",
} as const;

export interface VerdictInput {
  /** Explicit proposition this input evaluates (required, validated). */
  readonly scope: PropositionScope;
  readonly applicability: Applicability;
  readonly verdict?: EvidenceVerdict;
  /** Required (non-empty) for supported/contradicted contributions. */
  readonly basis?: readonly string[];
  readonly evidence: readonly EvidenceId[];
}

export interface ComposeOptions {
  /** Conflicts are treated as UNRESOLVED by definition (NEC has no resolved flag). */
  readonly conflicts?: readonly Conflict[];
  /**
   * Known EvidenceRefs used to prove SUPPORTED/CONTRADICTED backing: either
   * a plain array or an id-keyed Map. Every entry is FULLY VALIDATED before
   * use (complete provenance required — never bare `{id}` stubs); map keys
   * must equal `ref.id`.
   */
  readonly evidenceRefs?: readonly EvidenceRef[] | ReadonlyMap<string, EvidenceRef>;
}

/**
 * Complete, EvidenceDimension-compatible composition outcome. It always
 * satisfies the normative applicability/verdict state machine: verdict
 * present iff applicability is "applicable"; a material conflict affecting
 * the proposition forces "ambiguous".
 */
export interface ComposedProposition {
  readonly applicability: Applicability;
  readonly verdict?: EvidenceVerdict;
  /** Sorted unique union of the agreeing contributions' bases. */
  readonly basis: readonly EvidenceBasis[];
  /** Sorted unique union of agreeing contributions' (+ conflict) citations. */
  readonly evidence: readonly EvidenceId[];
  readonly warnings: readonly Warning[];
}

function toEvidenceIndex(
  refs: ComposeOptions["evidenceRefs"],
): ReadonlyMap<EvidenceId, EvidenceRef> {
  const map = new Map<EvidenceId, EvidenceRef>();
  if (refs === undefined) {
    return map;
  }
  // Collect entries WITHOUT trusting caller-owned traversal surfaces:
  // array paths go through the inert-array model first; the Map path is
  // read through the BUILT-IN intrinsic `Map.prototype.entries`, so an
  // overridden `entries`/`forEach`/`Symbol.iterator` cannot alter what
  // composition observes.
  const entries: Array<[string | undefined, EvidenceRef]> = [];
  if (Array.isArray(refs)) {
    assertInertArray(refs, "composeOptions.evidenceRefs");
    for (let i = 0; i < refs.length; i++) {
      entries.push([undefined, refs[i] as EvidenceRef]);
    }
  } else if (typeof refs === "object" && refs !== null) {
    let step: IteratorResult<[string, EvidenceRef]>;
    try {
      const intrinsic = (
        Map.prototype.entries as (
          this: ReadonlyMap<string, EvidenceRef>,
        ) => IterableIterator<[string, EvidenceRef]>
      ).call(refs as ReadonlyMap<string, EvidenceRef>);
      step = intrinsic.next();
      while (!step.done) {
        entries.push([step.value[0], step.value[1]]);
        step = intrinsic.next();
      }
    } catch {
      throw new NecValidationError(
        "NEC_VALIDATION_FAILED",
        "composeOptions.evidenceRefs: Map-shaped input could not be read through the built-in Map intrinsics",
      );
    }
  } else {
    throw new NecValidationError(
      "NEC_VALIDATION_FAILED",
      "composeOptions.evidenceRefs must be a plain array of EvidenceRefs or an id-keyed Map",
    );
  }
  for (const [key, ref] of entries) {
    // Fail closed: only VALIDATED evidence refs may back conclusions. The
    // complete validation runs BEFORE the id is read (never through a
    // caller-controlled getter).
    validateEvidenceRef(ref, "composeOptions.evidenceRefs");
    const id = key ?? ref.id;
    if (id !== ref.id) {
      throw new NecValidationError(
        "NEC_VALIDATION_FAILED",
        `evidence index key ${JSON.stringify(id)} does not match ref.id ${JSON.stringify(ref.id)}`,
      );
    }
    // Duplicate EvidenceIds are REJECTED — never last-write-wins.
    if (map.has(id)) {
      throw new NecValidationError(
        "NEC_VALIDATION_FAILED",
        `duplicate EvidenceId ${JSON.stringify(id)} in the supplied EvidenceRef index; failing closed`,
      );
    }
    map.set(id, ref);
  }
  return map;
}

/**
 * Complete conflict validation BEFORE any use in composition: exact schema,
 * explicit scope (NEC identifier grammar for custom namespaces/ids),
 * boolean material flag, unique conflict ids, and every cited EvidenceId
 * resolving against the validated EvidenceRef index.
 */
function validateCompositionConflicts(
  conflicts: readonly Conflict[],
  index: ReadonlyMap<EvidenceId, EvidenceRef>,
): void {
  assertInertArray(conflicts, "composeOptions.conflicts");
  const seen = new Set<string>();
  for (let i = 0; i < conflicts.length; i++) {
    const conflict = conflicts[i] as Conflict;
    validateConflict(conflict, `composeOptions.conflicts[${i}]`);
    if (seen.has(conflict.id)) {
      compositionFail(
        `duplicate Conflict id ${JSON.stringify(conflict.id)} in composeOptions.conflicts; failing closed`,
      );
    }
    seen.add(conflict.id);
    for (const id of conflict.evidence) {
      if (!index.has(id)) {
        compositionFail(
          `composeOptions.conflicts[${i}] cites EvidenceId ${JSON.stringify(id)} which does not resolve against complete validated EvidenceRefs; failing closed`,
        );
      }
    }
  }
}

function warning(
  code: string,
  message: string,
  evidence?: readonly EvidenceId[],
): Warning {
  return evidence !== undefined && evidence.length > 0
    ? { code, message, evidence: [...evidence].sort(compareUtf16) }
    : { code, message };
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareUtf16);
}

function compositionFail(reason: string): never {
  throw new NecValidationError("NEC_VALIDATION_FAILED", reason);
}

// ---------------------------------------------------------------------------
// DESCRIPTOR-FIRST SNAPSHOT (the live-object boundary)
// ---------------------------------------------------------------------------
//
// Caller-owned contributions and options are accepted ONLY after a
// descriptor-first snapshot. We inspect property descriptors and reject
// accessors / symbols / non-enumerable / custom-prototype / unknown-field
// inputs WITHOUT ever invoking a getter; then we copy the allowed own data
// values exactly ONCE into fresh NEC-owned inert structures. Every
// downstream stage validates and uses ONLY the snapshot — the original
// caller object is never re-read, so a hostile getter that mutates shared
// state on a second `.scope` / `.evidence` / `.applicability` / `.verdict`
// / `.basis` read can no longer launder provenance after validation.

/** NEC-owned, inert projection of one caller `VerdictInput` (internal). */
interface SnapshotVerdictInput {
  readonly scope: PropositionScope;
  readonly applicability: Applicability;
  readonly verdict: EvidenceVerdict | undefined;
  readonly basis: readonly EvidenceBasis[] | undefined;
  readonly evidence: readonly EvidenceId[];
}

const VERDICT_INPUT_ALLOWED_FIELDS = new Set([
  "scope",
  "applicability",
  "verdict",
  "basis",
  "evidence",
]);
const VERDICT_INPUT_REQUIRED_FIELDS = ["scope", "applicability", "evidence"] as const;

const COMPOSE_OPTIONS_ALLOWED_FIELDS = new Set(["conflicts", "evidenceRefs"]);

/**
 * Defensive, descriptor-only copy of a string array into a fresh NEC-owned
 * array. Elements are read ONLY through property descriptors (never via
 * `.map`/`forEach`/iterators/`entries`), so a hostile traversal surface or
 * index getter cannot run.
 */
function snapshotInertStringArray<T extends string>(raw: unknown, path: string): T[] {
  assertInertArray(raw, path);
  return inertArrayElements(raw as readonly unknown[]) as T[];
}

/**
 * Defensive copy of a `PropositionScope` into a fresh NEC-owned object.
 * `isPropositionScope` already rejected accessors / symbols / custom
 * prototypes / non-exact field sets WITHOUT invoking any getter, so the
 * copy below only ever reads validated data values.
 */
function snapshotPropositionScope(raw: unknown, path: string): PropositionScope {
  if (!isPropositionScope(raw)) {
    throw new NecValidationError(
      "NEC_VALIDATION_FAILED",
      `${path}.scope: must be an explicit PropositionScope (kind: result|dimension|observed_effect|custom)`,
    );
  }
  const scope = raw as Record<string, unknown>;
  const descriptors = Object.getOwnPropertyDescriptors(scope) as Record<string, PropertyDescriptor>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(descriptors)) {
    out[key] = descriptors[key]!.value;
  }
  return out as PropositionScope;
}

/** Exact-field-set enforcement for a caller `VerdictInput` (descriptor-only). */
function assertExactVerdictInputFieldSet(obj: object, path: string): void {
  const descriptors = Object.getOwnPropertyDescriptors(obj) as Record<string, PropertyDescriptor>;
  for (const required of VERDICT_INPUT_REQUIRED_FIELDS) {
    if (descriptors[required] === undefined) {
      throw new NecValidationError(
        "NEC_VALIDATION_FAILED",
        `composition input: missing required field "${required}"`,
      );
    }
  }
  for (const key of Object.keys(descriptors)) {
    if (!VERDICT_INPUT_ALLOWED_FIELDS.has(key)) {
      throw new NecValidationError(
        "NEC_VALIDATION_FAILED",
        `composition input: unknown field "${key}" is not part of the VerdictInput contract; failing closed`,
      );
    }
  }
}

/**
 * Snapshot ONE caller-owned `VerdictInput`. Rejects hostile shapes purely via
 * descriptors (no getter is invoked), then captures the allowed own data
 * values exactly once into a fresh NEC-owned object.
 */
function snapshotVerdictInput(raw: unknown, index: number): SnapshotVerdictInput {
  const path = `composition input[${index}]`;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new NecValidationError(
      "NEC_VALIDATION_FAILED",
      `${path}: must be a plain contribution object`,
    );
  }
  const input = raw as object;
  // Descriptor-only contract checks: no accessors, no symbols, no
  // non-enumerable own props, plain prototype. This throws on any accessor
  // property WITHOUT invoking it.
  assertPlainDataContractObject(input, path);
  assertExactVerdictInputFieldSet(input, path);

  // Copy the allowed OWN data values via descriptors into a fresh object,
  // so a hostile prototype/Proxy can never execute on a read and exactly
  // one representation is captured for validation + use.
  const descriptors = Object.getOwnPropertyDescriptors(input) as Record<string, PropertyDescriptor>;
  const readValue = (key: string): unknown =>
    descriptors[key] === undefined ? undefined : descriptors[key]!.value;

  return {
    scope: snapshotPropositionScope(readValue("scope"), path),
    applicability: readValue("applicability") as Applicability,
    verdict: readValue("verdict") as EvidenceVerdict | undefined,
    basis:
      descriptors["basis"] === undefined
        ? undefined
        : snapshotInertStringArray<EvidenceBasis>(readValue("basis"), `${path}.basis`),
    evidence: snapshotInertStringArray<EvidenceId>(readValue("evidence"), `${path}.evidence`),
  };
}

/** Exact-field-set enforcement for caller `ComposeOptions` (descriptor-only). */
function assertExactComposeOptionsFieldSet(obj: object, path: string): void {
  const descriptors = Object.getOwnPropertyDescriptors(obj) as Record<string, PropertyDescriptor>;
  for (const key of Object.keys(descriptors)) {
    if (!COMPOSE_OPTIONS_ALLOWED_FIELDS.has(key)) {
      throw new NecValidationError(
        "NEC_VALIDATION_FAILED",
        `${path}: unknown field "${key}" is not part of the ComposeOptions contract; failing closed`,
      );
    }
  }
}

/** NEC-owned, inert projection of caller `ComposeOptions`. */
interface SnapshotComposeOptions {
  readonly evidenceRefs: readonly EvidenceRef[] | ReadonlyMap<string, EvidenceRef> | undefined;
  readonly conflicts: readonly Conflict[] | undefined;
}

/**
 * Snapshot caller `ComposeOptions`. Rejects accessor properties (e.g. a
 * `get evidenceRefs()` / `get conflicts()`) WITHOUT invocation, then bounds
 * every supplied array through THE shared inert-array predicate
 * (`assertInertArray`: exact Array prototype, dense own data indexes,
 * MAX_CONTAINER_ENTRIES, no array-likes) BEFORE copying it into a fresh
 * NEC-owned inert array via `inertArrayElements`, so no hostile
 * `{length: N}` container can trigger unbounded descriptor-copy work.
 * The Map form of `evidenceRefs` keeps its intrinsic shape — `toEvidenceIndex`
 * reads it only through built-in Map intrinsics.
 */
function snapshotComposeOptions(raw: unknown): SnapshotComposeOptions {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new NecValidationError(
      "NEC_VALIDATION_FAILED",
      "composeOptions: must be a plain options object",
    );
  }
  const options = raw as object;
  assertPlainDataContractObject(options, "composeOptions");
  assertExactComposeOptionsFieldSet(options, "composeOptions");

  const descriptors = Object.getOwnPropertyDescriptors(options) as Record<string, PropertyDescriptor>;
  const readValue = (key: string): unknown =>
    descriptors[key] === undefined ? undefined : descriptors[key]!.value;

  const evidenceRefsRaw = readValue("evidenceRefs");
  const conflictsRaw = readValue("conflicts");

  // Fail closed BEFORE copying: non-arrays (pseudo-array objects) and
  // over-limit arrays are rejected by the shared inert-array predicate, so
  // `inertArrayElements` only ever runs on an already-bounded inert array
  // (no hostile `{length: N}` copy loop, no array-like acceptance).
  let evidenceRefs: readonly EvidenceRef[] | ReadonlyMap<string, EvidenceRef> | undefined;
  if (evidenceRefsRaw === undefined || evidenceRefsRaw instanceof Map) {
    evidenceRefs = evidenceRefsRaw as readonly EvidenceRef[] | ReadonlyMap<string, EvidenceRef>;
  } else {
    assertInertArray(evidenceRefsRaw, "composeOptions.evidenceRefs");
    evidenceRefs = inertArrayElements(evidenceRefsRaw) as readonly EvidenceRef[];
  }
  let conflicts: readonly Conflict[] | undefined;
  if (conflictsRaw === undefined) {
    conflicts = undefined;
  } else {
    assertInertArray(conflictsRaw, "composeOptions.conflicts");
    conflicts = inertArrayElements(conflictsRaw) as readonly Conflict[];
  }

  return { evidenceRefs, conflicts };
}

function assertValidInput(input: SnapshotVerdictInput, index: number): void {
  // `input` is ALREADY a NEC-owned snapshot (see `snapshotVerdictInput`):
  // its scope, applicability, verdict, basis and evidence are fresh inert
  // values captured exactly ONCE during snapshotting — no caller-owned
  // object is ever re-read below.
  if (!isPropositionScope(input.scope)) {
    throw new NecValidationError(
      "NEC_VALIDATION_FAILED",
      `composition input[${index}]: missing or invalid proposition scope; failing closed`,
    );
  }
  if (
    input.applicability !== "applicable" &&
    input.applicability !== "not_applicable" &&
    input.applicability !== "unknown"
  ) {
    throw new NecValidationError(
      "NEC_VALIDATION_FAILED",
      `composition input[${index}]: unknown applicability ${JSON.stringify(String(input.applicability))}`,
    );
  }
  // ONE state machine everywhere: a verdict may only ride on an applicable
  // proposition (the artifact validator enforces the same pairing).
  if (input.verdict !== undefined && input.applicability !== "applicable") {
    throw new NecValidationError(
      "NEC_VALIDATION_FAILED",
      `composition input[${index}]: verdict ${JSON.stringify(input.verdict)} MUST be absent when applicability is "${input.applicability}"`,
    );
  }
  // R3: reject UNKNOWN RUNTIME VERDICT strings outright — never silently
  // convert "nonsense" into an insufficient contribution.
  if (input.verdict !== undefined && !isEvidenceVerdict(input.verdict)) {
    throw new NecValidationError(
      "NEC_VALIDATION_FAILED",
      `composition input[${index}]: unknown runtime verdict ${JSON.stringify(String(input.verdict))}; failing closed`,
    );
  }
  // Inert-data model: basis/evidence are inert arrays accepted under THE
  // shared descriptor-first predicate BEFORE any element is read, so
  // caller-controlled getters/iterators/entries overrides can never run.
  if (input.basis !== undefined) {
    assertInertArray(input.basis, `composition input[${index}].basis`);
    for (let i = 0; i < input.basis.length; i++) {
      const b = input.basis[i];
      if (!isEvidenceBasis(b)) {
        throw new NecValidationError(
          "NEC_VALIDATION_FAILED",
          `composition input[${index}]: unknown evidence basis ${JSON.stringify(String(b))}`,
        );
      }
    }
  }
  assertInertArray(input.evidence, `composition input[${index}].evidence`);
  for (let i = 0; i < input.evidence.length; i++) {
    assertNecIdentifier(input.evidence[i], `composition input[${index}].evidence[${i}]`);
  }
}

/**
 * PROOF validation of ONE applicable contribution — run for EVERY
 * applicable input BEFORE aggregation and BEFORE any ladder early-return,
 * so an unknown contribution can never shield a malformed positive one.
 */
function assertProvenInput(
  input: SnapshotVerdictInput,
  index: number,
  refs: ReadonlyMap<EvidenceId, EvidenceRef>,
): void {
  // `input` is the NEC-owned snapshot; the same inert evidence/basis that
  // was validated is the only thing later aggregation will ever observe.
  const claimed = input.verdict;
  if (claimed === undefined || claimed === "insufficient" || claimed === "ambiguous") {
    return;
  }
  const basis = input.basis ?? [];
  if (basis.length === 0) {
    compositionFail(
      `composition input[${index}]: "${claimed}" contribution requires a non-empty basis; failing closed`,
    );
  }
  if (input.evidence.length === 0) {
    compositionFail(
      `composition input[${index}]: "${claimed}" contribution requires non-empty evidence citations; failing closed`,
    );
  }
  for (const id of input.evidence) {
    if (!refs.has(id)) {
      compositionFail(
        `composition input[${index}]: "${claimed}" contribution cites EvidenceId ${JSON.stringify(id)} which does not resolve against complete validated EvidenceRefs; failing closed`,
      );
    }
  }
}

/**
 * THE shared normative proposition state machine — used by THIS module to
 * validate final composer outputs AND by artifact/fragment validation for
 * every stored dimension. There is no second truth table.
 *
 *   applicable      -> verdict REQUIRED
 *   not_applicable  -> verdict absent; unknown -> verdict absent
 *   supported / contradicted -> non-empty basis + non-empty evidence AND no
 *                               affecting material conflict
 *   ambiguous       -> non-empty basis + non-empty evidence AND >= 1
 *                      affecting material conflict
 *   insufficient    -> NO affecting material conflict
 */
export function assertNormativePropositionState(
  proposition: {
    readonly applicability: Applicability;
    readonly verdict?: EvidenceVerdict;
    readonly basis: readonly unknown[];
    readonly evidence: readonly unknown[];
  },
  affectingConflicts: readonly Conflict[],
  path: string,
): void {
  const { applicability, verdict, basis, evidence } = proposition;
  if (applicability === "applicable") {
    if (verdict === undefined) {
      compositionFail(`${path}: verdict required when applicability is "applicable"`);
    }
  } else if (verdict !== undefined) {
    compositionFail(
      `${path}: verdict MUST be absent when applicability is "${applicability}"`,
    );
  }
  if (verdict === undefined) return;
  const blocking = affectingConflicts.length;
  if (verdict === "supported" || verdict === "contradicted") {
    if (blocking > 0) {
      compositionFail(
        `${path}: material conflict(s) ${affectingConflicts
          .map((c) => c.id)
          .sort()
          .join(",")} scoped to this proposition prevent "${verdict}" (ambiguous required)`,
      );
    }
    if (basis.length === 0) {
      compositionFail(`${path}: non-empty basis required for "${verdict}"`);
    }
    if (evidence.length === 0) {
      compositionFail(`${path}: non-empty evidence required for "${verdict}"`);
    }
  } else if (verdict === "ambiguous") {
    if (basis.length === 0) {
      compositionFail(`${path}: non-empty basis required for "ambiguous"`);
    }
    if (evidence.length === 0) {
      compositionFail(`${path}: non-empty evidence required for "ambiguous"`);
    }
    if (blocking === 0) {
      compositionFail(
        `${path}: "ambiguous" requires at least one explicit material Conflict scoped to this proposition (result-scoped counts)`,
      );
    }
  } else if (verdict === "insufficient") {
    // A material unresolved conflict affecting the proposition forces
    // AMBIGUOUS; it can never coexist with insufficient.
    if (blocking > 0) {
      compositionFail(
        `${path}: material conflict(s) ${affectingConflicts
          .map((c) => c.id)
          .sort()
          .join(",")} scoped to this proposition prevent "insufficient" (ambiguous required)`,
      );
    }
  }
}

function materialAffectingAny(
  conflicts: readonly Conflict[],
  scopes: readonly PropositionScope[],
): Conflict[] {
  return conflicts.filter(
    (conflict) =>
      conflict.material && scopes.some((scope) => conflictAffectsProposition(conflict.scope, scope)),
  );
}

/**
 * Compose ONE proposition from dimension-like inputs under THE normative
 * state machine. The full closure order is:
 *
 *   1. inert-array acceptance of the input array and every contribution's
 *      arrays (no getter/iterator/entries override can run),
 *   2. structural validation of EVERY contribution,
 *   3. complete validation of the EvidenceRef index (duplicates rejected)
 *      and of EVERY supplied Conflict (schema/scope/material/citations),
 *   4. PROOF validation of every APPLICABLE contribution — before any
 *      ladder decision, so unknown contributions never shield malformed
 *      positive ones,
 *   5. the composition ladder (unknown/not_applicable dominance; explicit
 *      conflict scope forces ambiguous; supported-vs-contradicted without
 *      a conflict fails closed; provenance only from agreeing
 *      contributions),
 *   6. ONE shared final gate (`assertNormativePropositionState`) that EVERY
 *      output branch must pass before returning.
 */
export function composeVerdict(
  inputs: readonly VerdictInput[],
  options: ComposeOptions = {},
): ComposedProposition {
  // (1) Inert acceptance BEFORE anything else — never read a caller-owned
  // length/member through a hostile container.
  assertInertArray(inputs, "composition inputs");

  // (1b) DESCRIPTOR-FIRST SNAPSHOT of EVERY contribution. This is the live
  // object boundary: caller-owned data is inspected purely through property
  // DESCRIPTORS (no getter is ever invoked to reject it), copied exactly
  // once into a fresh NEC-owned inert structure, and EVERY later stage
  // (validation, proof closure, conflict matching, aggregation, provenance
  // emission) operates ONLY on the snapshot. A caller-owned accessor that
  // mutates shared state on a second read can no longer influence the
  // result, because there is no second read.
  const snapshots: SnapshotVerdictInput[] = [];
  for (let i = 0; i < inputs.length; i++) {
    snapshots.push(snapshotVerdictInput(inputs[i] as unknown, i));
  }

  // (2) Structural validation of EVERY contribution: an invalid LATER
  // contribution still fails even if an earlier one would already decide.
  for (let i = 0; i < snapshots.length; i++) {
    assertValidInput(snapshots[i]!, i);
  }

  // (3) EvidenceRef closure index + complete Conflict validation BEFORE any
  // aggregation or early return. Conflicts are validated even when no
  // positive contribution exists: a malformed conflict can never force
  // `ambiguous`. Both options fields are snapshotted descriptor-first
  // (caller getters are rejected without invocation) into NEC-owned inert
  // arrays before use.
  const opts = snapshotComposeOptions(options);
  const index = toEvidenceIndex(opts.evidenceRefs);
  const conflicts = opts.conflicts;
  if (conflicts !== undefined) {
    validateCompositionConflicts(conflicts, index);
  }

  // (4) Per-contribution PROOF validation for EVERY applicable input —
  // before aggregation and before ANY ladder early-return.
  for (let i = 0; i < snapshots.length; i++) {
    const input = snapshots[i]!;
    if (input.applicability === "applicable") {
      assertProvenInput(input, i, index);
    }
  }

  const considered = snapshots.filter((input) => input.applicability !== "not_applicable");
  const consideredScopes = considered.map((input) => input.scope);
  // Conflicts block by EXPLICIT scope match only — never EvidenceId overlap.
  const affecting = materialAffectingAny(conflicts ?? [], consideredScopes);

  let candidate: ComposedProposition;

  if (snapshots.length === 0) {
    // Rule 0: nothing established.
    candidate = outcome("unknown", undefined, [], [], [
      warning(
        COMPOSITION_WARNING_CODES.noDimensionsEvaluated,
        "No dimension inputs were evaluated; nothing is established.",
      ),
    ]);
  } else if (considered.length === 0) {
    // Rule 1: all not_applicable.
    candidate = outcome("not_applicable", undefined, [], [], []);
  } else if (considered.some((input) => input.applicability === "unknown")) {
    // Rule 2 of the ladder: an undecidable part keeps the WHOLE proposition
    // unknown — uncertainty is never laundered into a verdict.
    candidate = outcome("unknown", undefined, [], [], []);
  } else if (affecting.length > 0) {
    // Rule 3: unresolved material conflicts force ambiguous for the
    // propositions they affect (explicit scope match, or result scope). The
    // ambiguous basis/evidence include the validated conflicting
    // observations of every considered contribution plus the conflicts'.
    const conflictEvidence = affecting.flatMap((conflict) => conflict.evidence);
    candidate = outcome(
      "applicable",
      "ambiguous",
      considered.flatMap((input) => input.basis ?? []),
      [...considered.flatMap((input) => input.evidence), ...conflictEvidence],
      [
        warning(
          COMPOSITION_WARNING_CODES.materialConflictBlocksConclusion,
          `Unresolved material conflict(s) ${affecting.map((c) => c.id).sort().join(",")} block a deterministic conclusion.`,
          conflictEvidence,
        ),
      ],
    );
  } else {
    // Rule 5: an ambiguous input reaching here has NO justifying affecting
    // conflict -> fail closed.
    if (considered.some((input) => input.verdict === "ambiguous")) {
      compositionFail(
        'composition input: verdict "ambiguous" requires at least one material Conflict scoped to the proposition (or result-scoped); failing closed',
      );
    }

    const hasSupported = considered.some((input) => input.verdict === "supported");
    const hasContradicted = considered.some((input) => input.verdict === "contradicted");

    // FAIL CLOSED: valid contributions claiming BOTH supported and
    // contradicted for the same proposition, without an explicit material
    // Conflict, represent an unrepresented disagreement. The caller/resolver
    // must model it explicitly as a Conflict (=> ambiguous).
    if (hasSupported && hasContradicted) {
      compositionFail(
        'composition inputs contain both "supported" and "contradicted" contributions without an affecting material Conflict; represent the disagreement explicitly as a Conflict (fail closed)',
      );
    }

    let verdict: EvidenceVerdict;
    let agreeing: EvidenceVerdict;
    if (hasContradicted) {
      verdict = "contradicted";
      agreeing = "contradicted";
    } else if (hasSupported && considered.every((c) => c.verdict === "supported")) {
      verdict = "supported";
      agreeing = "supported";
    } else {
      verdict = "insufficient";
      agreeing = "insufficient";
    }

    // PROOF NON-LAUNDERING: provenance comes ONLY from contributions that
    // agree with the outcome verdict — never a global union. A missing
    // verdict on an applicable input is an insufficient contribution
    // (absence of proof, not invalidity).
    const agreeingContributions = considered.filter(
      (c) => (c.verdict ?? "insufficient") === agreeing,
    );

    candidate = outcome(
      "applicable",
      verdict,
      agreeingContributions.flatMap((c) => c.basis ?? []),
      agreeingContributions.flatMap((c) => c.evidence),
      [],
    );
  }

  // (6) FINAL NORMATIVE GATE: EVERY output branch — unknown, not_applicable,
  // insufficient, supported, contradicted AND ambiguous — passes THE state
  // machine used by artifact validation before returning. There is no
  // branch that returns before this gate and no shadow truth table.
  assertNormativePropositionState(
    {
      applicability: candidate.applicability,
      verdict: candidate.verdict,
      basis: candidate.basis,
      evidence: candidate.evidence,
    },
    affecting,
    "composed proposition",
  );
  return candidate;
}

function outcome(
  applicability: Applicability,
  verdict: EvidenceVerdict | undefined,
  basis: readonly string[],
  evidence: readonly string[],
  warnings: readonly Warning[],
): ComposedProposition {
  return {
    applicability,
    ...(verdict !== undefined ? { verdict } : {}),
    basis: uniqueSorted(basis) as EvidenceBasis[],
    evidence: uniqueSorted(evidence),
    warnings,
  };
}

/**
 * Convenience wrapper composing a single proposition from one dimension-like
 * input.
 */
export function composeProposition(
  input: VerdictInput,
  options: ComposeOptions = {},
): ComposedProposition {
  return composeVerdict([input], options);
}
