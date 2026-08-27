/**
 * EVALUATION LAYER: ERC-4337 exact expected-UserOperation semantics over
 * frozen-core network evidence.
 *
 * PRIMARY INPUT: a `NetworkEvidenceFragment` (what `NetworkResolver.resolve`
 * returns) plus an `Erc4337Claim` (expected op + optional expected burn).
 * The complete `NetworkEvidenceResult` form remains available through the
 * COMPATIBILITY wrapper `evaluateErc4337Bundle`, which projects the result
 * into the same fragment view and delegates to THE ONE shared internal path
 * below. There is no second semantics.
 *
 * THE PROPOSITION. One explicit NEC proposition per assessment:
 *
 *     "the claimed EntryPoint bundle transaction contains exactly the
 *      expected UserOperation from the expected sender, executed
 *      successfully — and, when an exact ERC-1155 burn is expected, that
 *      exact burn effect (to == zero address) was observed"
 *
 * scoped `{kind:"custom", namespace:"erc4337.adapter", id:<claimDigest>}`.
 *
 * INVARIANT SEPARATIONS (each preserved by construction, proven by tests):
 *   - bundle transaction != UserOperation: receipt-level success plus
 *     absence of a usable UserOperationEvent yields INSUFFICIENT, never
 *     SUPPORTED (presence layer);
 *   - UserOperation success != bundle success alone: a selected event with
 *     success=false CONTRADICTS the proposition even when the bundle
 *     receipt reports success;
 *   - ERC-1155 burn != arbitrary TransferSingle: only `to == zero` counts;
 *     `from == zero` is MINT semantics and never a burn;
 *   - payment/redemption evidence != L2 block finality: finality is never
 *     evaluated here and never asserted (standing warning + non-claims).
 *
 * SELECTION RULES (fail closed):
 *   - with `userOpHash`: exact-match selection; duplicates => AMBIGUOUS
 *     (material conflict); a hash-selected event whose sender differs is a
 *     clean CONTRADICTION;
 *   - without `userOpHash`: sender-match selection; multiple equally
 *     matching candidates => AMBIGUOUS, never first-match.
 *
 * MALFORMED RELEVANT EVIDENCE FAILS CLOSED (APEL lesson): an effect whose
 * topic0 equals a pinned topic — or whose carrier is too broken to classify
 * at all — is never treated as unrelated noise and never as clean absence.
 * It becomes an explicit material Conflict scoped to the proposition,
 * forcing AMBIGUOUS wherever competing interpretations remain. Unrelated
 * logs stay unrelated. Removed (reorg-orphaned) logs follow frozen
 * generic-EVM semantics: excluded from candidacy, never reinterpreted as
 * canonical observations in either direction.
 *
 * EXACT TRANSACTION BINDING: an observation carrying its own
 * transactionHash must carry THE claimed bundle hash; a log from
 * transaction Y never supports a claim about transaction X (recorded as an
 * explicit material Conflict, mirroring the x402 adapter's P1 rule).
 *
 * BURN CORRELATION RULES: an exact burn satisfies contract + from (== the
 * correlated account) + to == zero + tokenId + value simultaneously. A
 * usable burn from the expected account ON the expected contract that
 * differs in tokenId/value REFUTES the exact expectation (clean negative).
 * Wrong-contract, wrong-from, nonzero-to and mint observations are near-
 * miss noise: they can never satisfy the expectation and never refute it
 * (another account's activity does not contradict THIS account's claim).
 *
 * DETERMINISTIC PRECEDENCE before feeding THE frozen core state machine:
 *   a. RELEVANT DISPUTE (any material conflict touching the result, the
 *      required generic execution layer, any inspected effect, or the
 *      proposition itself): full-fidelity inputs; the ladder forces
 *      "ambiguous";
 *   b. CLEAN NEGATIVES (failed/sender-mismatched selected op, refuted
 *      burn, network mismatch, contradicted carried dimension; no
 *      dispute): negatives-only inputs => clean "contradicted"; positives
 *      lose their voice (never laundered);
 *   c. UNBINDABLE SUBJECT without a citable conflict: verdict-less inputs
 *      => "insufficient" (never positive);
 *   d. OTHERWISE positive path: binding + execution + selected-op + exact
 *      burn contributions + presence layers (missing pieces demote to
 *      INSUFFICIENT, never silent success).
 *
 * DETERMINISM. No clock, no randomness, no I/O; identical inputs produce
 * identical outputs. All report values are JSON-safe primitives; amounts
 * travel as canonical decimal strings.
 */

import {
  composeVerdict,
  mergeWarnings,
  samePropositionScope,
  validateNetworkEvidenceFragment,
  validateNetworkEvidenceResult,
} from "@nec/core";
import type {
  Applicability,
  Conflict,
  EvidenceBasis,
  EvidenceDimension,
  EvidenceId,
  EvidenceRef,
  EvidenceVerdict,
  NetworkEvidenceFragment,
  NetworkEvidenceResult,
  ObservedEffect,
  PropositionScope,
  SubjectRef,
  VerdictInput,
  Warning,
} from "@nec/core";

import { parseErc4337Claim, computeErc4337ClaimDigest } from "./claim.js";
import type { Erc4337Claim } from "./claim.js";
import { ENTRY_POINT_PROFILES, ZERO_ADDRESS } from "./events.js";
import type {
  Erc1155BurnObservation,
  TransferBatchMemberObservation,
  TransferBatchObservation,
  TransferSingleObservation,
  UserOperationEventObservation,
} from "./events.js";
import {
  interpretTransferBatchEffect,
  interpretTransferSingleEffect,
  interpretUserOperationEventEffect,
} from "./interpret.js";

export const ERC4337_ADAPTER_PROFILE = "nec-adapter-erc4337-v0.1";
export const PROPOSITION_NAMESPACE = "erc4337.adapter";

/**
 * Adapter-emitted Conflict codes. These represent claim-vs-network
 * disagreements OBSERVED BY THIS ADAPTER between the normalized claim and
 * the artifact content — never protocol success strings.
 */
export const ERC4337_CONFLICT_CODES = Object.freeze({
  subjectNotBundleTransaction: "ERC4337_SUBJECT_NOT_BUNDLE_TRANSACTION",
  observationTransactionHashMismatch: "ERC4337_OBSERVATION_TX_HASH_MISMATCH",
  malformedUserOperationEvent: "ERC4337_MALFORMED_USEROPERATION_EVENT",
  malformedTransferSingle: "ERC4337_MALFORMED_TRANSFER_SINGLE",
  malformedTransferBatch: "ERC4337_MALFORMED_TRANSFER_BATCH",
  duplicateExactUserOperations: "ERC4337_DUPLICATE_EXACT_USEROPERATION_CANDIDATES",
  duplicateExactBurns: "ERC4337_DUPLICATE_EXACT_BURNS",
  entryPointProfileMismatch: "ERC4337_ENTRYPOINT_PROFILE_MISMATCH",
} as const);

/** Adapter warning codes (stable identifiers, deterministic emission). */
export const ERC4337_WARNING_CODES = Object.freeze({
  finalityNotEstablished: "ERC4337_FINALITY_NOT_ESTABLISHED",
  settlementNotEstablished: "ERC4337_SETTLEMENT_DIMENSION_NOT_ESTABLISHED",
  noUserOperationEventObserved: "ERC4337_NO_USEROPERATION_EVENT_OBSERVED",
  removedCandidateExcluded: "ERC4337_REMOVED_LOG_EXCLUDED",
  malformedCandidateExcluded: "ERC4337_MALFORMED_RELEVANT_LOG_EXCLUDED",
  transactionHashMismatch: "ERC4337_TRANSACTION_HASH_MISMATCH",
  subjectDoesNotMatchClaim: "ERC4337_SUBJECT_DOES_NOT_MATCH_CLAIM",
  userOperationFailed: "ERC4337_USEROPERATION_REPORTED_FAILURE",
  userOperationSenderMismatch: "ERC4337_SELECTED_EVENT_SENDER_MISMATCH",
  duplicateExactUserOperations: "ERC4337_DUPLICATE_EXACT_USEROPERATION_CANDIDATES",
  duplicateExactBurns: "ERC4337_DUPLICATE_EXACT_BURNS",
  burnNotObserved: "ERC4337_NO_MATCHING_BURN_OBSERVED",
  burnExpectationViolated: "ERC4337_BURN_EXPECTATION_VIOLATED",
  erc1155MintIsNotBurn: "ERC4337_ERC1155_MINT_IS_NOT_BURN",
  nonEntryEmitterExcluded: "ERC4337_NON_ENTRYPOINT_EMITTER_EXCLUDED",
  entryPointProfileMismatch: "ERC4337_ENTRYPOINT_PROFILE_MISMATCH",
  executionDimensionNotApplicable: "ERC4337_EXECUTION_DIMENSION_NOT_APPLICABLE",
  executionDimensionAbsent: "ERC4337_EXECUTION_DIMENSION_ABSENT",
});

/**
 * Claim labels by composed verdict. The supported label deliberately claims
 * only what the evidence establishes: the claimed bundle independently
 * supports the exact expected (successful) UserOperation and — when
 * expected — the exact burn effect.
 */
export const ERC4337_CLAIM_LABELS: Readonly<Record<EvidenceVerdict, string>> & {
  readonly undetermined: string;
} = Object.freeze({
  supported:
    "OBSERVED_ENTRYPOINT_EVIDENCE_SUPPORTS_SUCCESSFUL_SELECTED_USEROPERATION_AND_EXPECTED_EFFECT_CO_OBSERVED_IN_SAME_BUNDLE_CAUSAL_ATTRIBUTION_NOT_ESTABLISHED",
  contradicted: "BUNDLE_EVIDENCE_CONTRADICTS_EXPECTED_USEROPERATION_OR_EXPECTED_EFFECT",
  ambiguous: "EVIDENCE_CONFLICT_PREVENTS_DETERMINISTIC_ERC4337_CONCLUSION",
  insufficient: "INSUFFICIENT_EVIDENCE_FOR_EXPECTED_USEROPERATION_OR_EFFECT",
  undetermined: "USEROPERATION_CONCLUSION_UNDETERMINED",
});

/**
 * PERMANENT NON-CLAIMS. A supported assessment does NOT establish any of
 * these; they are emitted on EVERY assessment regardless of outcome:
 *
 *   - ENTRYPOINT_EMITTER_HONESTY_NOT_ESTABLISHED:
 *       event-log observation alone proves nothing about contract honesty;
 *   - USEROPERATION_SIGNATURE_VALIDITY_NOT_EVALUATED:
 *       no UserOperation signature/ECDSA validation was performed;
 *   - BUNDLER_BEHAVIOR_NOT_EVALUATED:
 *       nothing is claimed about bundler inclusion policy or behavior;
 *   - PAYMASTER_SPONSORSHIP_POLICY_NOT_EVALUATED:
 *       paymaster policy decisions are out of scope;
 *   - TOKEN_CONTRACT_HONESTY_NOT_ESTABLISHED:
 *       the ERC-1155 contract could emit arbitrary events;
 *   - BALANCE_STATE_CHANGE_NOT_PROVEN_SEPARATELY:
 *       no state-diff/balance proof is consumed here;
 *   - DOUBLE_EXECUTION_RISK_NOT_ADDRESSED:
 *       duplicate exact observations are surfaced, not adjudicated;
 *   - CAUSAL_ATTRIBUTION_NOT_ESTABLISHED:
 *       co-observation of a selected successful UserOperation and a matching
 *       burn-shaped effect in the SAME bundle transaction is NOT evidence
 *       that the UserOperation caused the burn, service completion,
 *       settlement, L2 finality or economic irreversibility;
 *   - ENTRYPOINT_IMPLEMENTATION_VERSION_NOT_VERIFIED:
 *       the declared EntryPoint profile is an expectation only; event-log
 *       observation alone never verifies contract bytecode/version;
 *   - L2_BLOCK_FINALITY_NOT_ESTABLISHED:
 *       ERC-4337 UserOperation success != L2 block finality;
 *   - WITHDRAWAL_FINALIZATION_NOT_ESTABLISHED:
 *       L2->L1 withdrawal finalization is out of scope;
 *   - ECONOMIC_IRREVERSIBILITY_NOT_ESTABLISHED:
 *       irreversibility is never claimed by observation alone;
 *   - PROTECTED_CONTENT_RELEASE_NOT_ESTABLISHED:
 *       content-release decisions live above this package;
 *   - OFF_CHAIN_LEDGER_STATE_NOT_EVALUATED:
 *       ledger/database paths outside the claimed on-chain effect are out
 *       of scope for this profile.
 */
export const ERC4337_NON_CLAIMS: readonly string[] = Object.freeze([
  "ENTRYPOINT_EMITTER_HONESTY_NOT_ESTABLISHED",
  "USEROPERATION_SIGNATURE_VALIDITY_NOT_EVALUATED",
  "BUNDLER_BEHAVIOR_NOT_EVALUATED",
  "PAYMASTER_SPONSORSHIP_POLICY_NOT_EVALUATED",
  "TOKEN_CONTRACT_HONESTY_NOT_ESTABLISHED",
  "BALANCE_STATE_CHANGE_NOT_PROVEN_SEPARATELY",
  "DOUBLE_EXECUTION_RISK_NOT_ADDRESSED",
  "CAUSAL_ATTRIBUTION_NOT_ESTABLISHED",
  "ENTRYPOINT_IMPLEMENTATION_VERSION_NOT_VERIFIED",
  "L2_BLOCK_FINALITY_NOT_ESTABLISHED",
  "WITHDRAWAL_FINALIZATION_NOT_ESTABLISHED",
  "ECONOMIC_IRREVERSIBILITY_NOT_ESTABLISHED",
  "PROTECTED_CONTENT_RELEASE_NOT_ESTABLISHED",
  "OFF_CHAIN_LEDGER_STATE_NOT_EVALUATED",
]);

/** One inspected-but-unusable relevant effect. */
export interface ExcludedCandidate {
  readonly effectId: string;
  /** Which pinned shape claimed the effect ("log" = unusable carrier). */
  readonly kind: "userOperationEvent" | "transferSingle" | "transferBatch" | "log";
  readonly reason: "removed" | "malformed";
  readonly detail: string;
}

/** A relevant observation bound to a DIFFERENT transaction. */
export interface ObservationTxHashMismatch {
  readonly effectId: string;
  readonly kind: "userOperationEvent" | "transferSingle" | "transferBatch";
  /** Lowercase transaction hash carried by the observation. */
  readonly observedTransactionHash: string;
}

/** Why a same-contract/same-from burn fails the exact expectation. */
export interface BurnViolation {
  readonly observation: Erc1155BurnObservation;
  /** Deterministic violation descriptors (`field:observed`). */
  readonly violations: readonly string[];
}

/** Why the exactly selected UserOperation fails its expectation. */
export interface SelectedUserOperationFailure {
  readonly observation: UserOperationEventObservation;
  readonly reason: "userOperationFailed" | "senderMismatch";
}

export interface Erc4337Evaluation {
  readonly adapterProfile: typeof ERC4337_ADAPTER_PROFILE;
  readonly protocol: "erc4337";
  /** Digest of the NORMALIZED claim (`sha256:<hex>`). */
  readonly claimDigest: string;
  /** Normalized claim echo (lowercase addresses, canonical amounts). */
  readonly claim: Erc4337Claim;
  /**
   * Explicit correlation boundary. The strongest supported proposition is a
   * CONJUNCTION of observations over ONE bound bundle transaction. It does
   * NOT establish that the selected UserOperation caused the burn, service
   * completion, settlement, finality or economic irreversibility.
   */
  readonly correlationStrength: "same_bundle_only";
  /**
   * Echo of the claimed bundle transaction hash this assessment was bound
   * to (lowercase).
   */
  readonly bundleTransactionHash: string;
  /**
   * True iff the evidence subject IS the claimed bundle transaction
   * (`type:"transaction"`, matching networkId, txId === bundle hash).
   */
  readonly subjectMatchesClaim: boolean;
  readonly observedNetwork: {
    readonly networkId: string;
    readonly chainId?: number;
    readonly matchedRequirement: boolean;
  };
  /**
   * Composed outcome of THE ERC-4337 proposition from the frozen core state
   * machine (`composeVerdict`): applicability always present; verdict
   * present iff applicable. This is an ADAPTER-LOCAL assessment shape —
   * explicitly NOT a `NetworkEvidenceResult`.
   */
  readonly outcome: {
    readonly applicability: Applicability;
    readonly verdict?: EvidenceVerdict;
    readonly basis: readonly EvidenceBasis[];
    readonly evidence: readonly EvidenceId[];
    /** Ids of material conflicts that affect the composed proposition. */
    readonly materialConflictIds: readonly string[];
  };
  /**
   * SEPARATE generic bundle-execution semantics, composed by the same
   * frozen state machine over the fragment's own execution dimension. Never
   * rewritten because the UserOperation expectation matched or failed.
   */
  readonly execution: {
    readonly providedByFragment: boolean;
    readonly applicability: Applicability;
    readonly verdict?: EvidenceVerdict;
  };
  /** Strongest claim licensed by the outcome (see ERC4337_CLAIM_LABELS). */
  readonly claimLabel: string;
  /** Permanent non-claims; identical on every assessment. */
  readonly nonClaims: readonly string[];
  /** The uniquely selected UserOperationEvent, when one was identified. */
  readonly selectedUserOperation?: UserOperationEventObservation;
  /** Present iff an event was selected yet violates the expectation. */
  readonly selectedUserOperationFailure?: SelectedUserOperationFailure;
  /** Every bound usable UserOperationEvent candidate (selected or not). */
  readonly userOperationCandidates: readonly UserOperationEventObservation[];
  /** Exact usable burn observations satisfying the full expectation. */
  readonly matchingBurns: readonly Erc1155BurnObservation[];
  /** Same-contract/same-from burns violating an exact expected field. */
  readonly conflictingBurns: readonly BurnViolation[];
  readonly excludedCandidates: readonly ExcludedCandidate[];
  readonly transactionHashMismatches: readonly ObservationTxHashMismatch[];
  /** Bound usable UserOperationEvent candidates inspected. */
  readonly candidateCount: number;
  /** Bound usable TransferSingle candidates inspected. */
  readonly transferSingleCandidateCount: number;
  /** Bound usable TransferBatch candidates inspected. */
  readonly transferBatchCandidateCount: number;
  /** Effects that were neither pinned event shape nor a broken carrier. */
  readonly unrelatedEffectCount: number;
  /** UserOperationEvent-shaped logs emitted by a non-claimed emitter. */
  readonly nonEntryEmitterCount: number;
  /** Composition warnings + adapter warnings, deduplicated, sorted. */
  readonly warnings: readonly Warning[];
}

/**
 * Internal, resolver-shape-neutral view of the consumed evidence: exactly
 * the fields a `NetworkEvidenceFragment` carries. A validated
 * `NetworkEvidenceResult` projects onto this for the compatibility wrapper.
 */
interface FragmentView {
  readonly networkId: string;
  readonly chainId?: number;
  readonly subject: SubjectRef;
  readonly execution?: EvidenceDimension;
  readonly settlement?: EvidenceDimension;
  readonly finality?: EvidenceDimension;
  readonly observedEffects: readonly ObservedEffect[];
  readonly evidence: readonly EvidenceRef[];
  readonly conflicts: readonly Conflict[];
}

interface UserOpLayerOutcome {
  readonly status: "matched" | "failed" | "absent" | "duplicate";
  readonly selected?: UserOperationEventObservation;
  readonly failure?: SelectedUserOperationFailure;
  readonly duplicates?: readonly UserOperationEventObservation[];
  readonly matching: readonly UserOperationEventObservation[];
}

interface BurnLayerOutcome {
  readonly status: "matched" | "violated" | "absent" | "duplicate";
  readonly matches: readonly Erc1155BurnObservation[];
  readonly violations: readonly BurnViolation[];
  /** Every burn-shaped observation across both carriers. */
  readonly allBurns: readonly Erc1155BurnObservation[];
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function adapterWarning(code: string, message: string, evidence?: readonly string[]): Warning {
  return evidence !== undefined && evidence.length > 0
    ? { code, message, evidence: [...evidence] }
    : { code, message };
}

function adapterConflict(args: {
  code: string;
  id: string;
  description: string;
  scope: PropositionScope;
  evidenceIds: readonly string[];
  metadata?: Record<string, unknown>;
}): Conflict {
  return {
    id: args.id,
    code: args.code,
    description: args.description,
    scope: args.scope,
    // Structural dedupe keeps conflict identity permutation-invariant.
    evidence: [...new Set(args.evidenceIds)],
    material: true,
    ...(args.metadata === undefined ? {} : { metadata: args.metadata }),
  };
}

/**
 * Presence layer: carries the actual match conclusion so a missing piece
 * yields INSUFFICIENT rather than silent success.
 */
function presenceInput(
  matched: boolean,
  evidence: readonly string[],
  scope: PropositionScope,
): VerdictInput {
  return matched
    ? {
        scope,
        applicability: "applicable",
        verdict: "supported",
        basis: ["source_observation", "deterministic_derivation"],
        evidence: uniqueSorted(evidence),
      }
    : {
        scope,
        applicability: "applicable",
        basis: ["deterministic_derivation"],
        evidence: [],
      };
}

/** Verdict-less projection of any layer (citation reach retained). */
function stripped(
  scope: PropositionScope,
  evidence: readonly string[],
  basis: readonly EvidenceBasis[],
): VerdictInput {
  return { scope, applicability: "applicable", basis: [...basis], evidence: [...evidence] };
}

function contradictedInput(scope: PropositionScope, evidence: readonly string[]): VerdictInput {
  return {
    scope,
    applicability: "applicable",
    verdict: "contradicted",
    basis: ["source_observation", "deterministic_derivation"],
    evidence: uniqueSorted(evidence),
  };
}

function supportedEffectInput(observation: {
  readonly effectId: string;
  readonly evidenceIds: readonly string[];
}): VerdictInput {
  return {
    scope: { kind: "observed_effect", effectId: observation.effectId },
    applicability: "applicable",
    verdict: "supported",
    basis: ["source_observation", "deterministic_derivation"],
    evidence: [...observation.evidenceIds],
  };
}

/** Which exact expected burn field one right-contract/right-from burn violates. */
function burnFieldViolations(
  o: TransferSingleObservation,
  expected: NonNullable<Erc4337Claim["expectedEffect"]>,
): string[] {
  const violations: string[] = [];
  if (o.tokenId !== expected.tokenId) violations.push(`tokenId:${o.tokenId}`);
  if (o.value !== expected.value) violations.push(`value:${o.value}`);
  return violations;
}

/**
 * THE ONE shared internal assessment path. `claim` must already be
 * normalized (see `parseErc4337Claim`); the view must already be validated.
 */
function assessInternal(claim: Erc4337Claim, view: FragmentView): Erc4337Evaluation {
  const claimDigest = computeErc4337ClaimDigest(claim);
  const scope: PropositionScope = {
    kind: "custom",
    namespace: PROPOSITION_NAMESPACE,
    id: claimDigest,
  };
  const bundleHash = claim.bundleTransactionHash;

  // -----------------------------------------------------------------------
  // Layer 1: network + subject correlation.
  // -----------------------------------------------------------------------
  const networkMatched =
    view.networkId === claim.network &&
    (view.chainId === undefined || view.chainId === claim.chainId);

  const subject = view.subject;
  const subjectMatchesClaim =
    subject.type === "transaction" &&
    subject.networkId === claim.network &&
    typeof subject.txId === "string" &&
    subject.txId.toLowerCase() === bundleHash;

  const adapterConflicts: Conflict[] = [];
  const adapterWarnings: Warning[] = [];

  let subjectConflictEmitted = false;
  if (!subjectMatchesClaim && networkMatched && view.evidence.length > 0) {
    const citation = uniqueSorted(view.evidence.map((ref) => ref.id));
    adapterConflicts.push(
      adapterConflict({
        code: ERC4337_CONFLICT_CODES.subjectNotBundleTransaction,
        id: `${PROPOSITION_NAMESPACE}:${ERC4337_CONFLICT_CODES.subjectNotBundleTransaction}`,
        description:
          "the evidence subject is not the claimed EntryPoint bundle transaction; the claim cannot be assessed against this evidence",
        scope,
        evidenceIds: citation,
        metadata: {
          ...(subject.type === "transaction" ? { subjectTxId: subject.txId } : {}),
          claimedBundleTransactionHash: bundleHash,
          subjectType: subject.type,
        },
      }),
    );
    subjectConflictEmitted = true;
    adapterWarnings.push(
      adapterWarning(
        ERC4337_WARNING_CODES.subjectDoesNotMatchClaim,
        `evidence subject (${subject.type}) does not match the claimed bundle transaction`,
        citation,
      ),
    );
  }

  // -----------------------------------------------------------------------
  // EntryPoint profile/version binding (fail closed).
  // The claimed emitter MUST be the canonical address pinned for the
  // declared profile. A declared profile whose address disagrees with the
  // claimed emitter is a profile mismatch and cannot support the
  // proposition. The profile is an EXPECTATION only — never a verified
  // implementation version.
  // -----------------------------------------------------------------------
  const claimedProfileAddress = ENTRY_POINT_PROFILES[claim.entryPointProfile];
  if (claimedProfileAddress === undefined || claim.entryPoint !== claimedProfileAddress) {
    const expected = claimedProfileAddress ?? "<unknown-profile>";
    adapterConflicts.push(
      adapterConflict({
        code: ERC4337_CONFLICT_CODES.entryPointProfileMismatch,
        id: `${PROPOSITION_NAMESPACE}:${ERC4337_CONFLICT_CODES.entryPointProfileMismatch}`,
        description: `claimed entryPoint ${claim.entryPoint} does not match the canonical emitter ${expected} pinned for profile ${claim.entryPointProfile}; the proposition cannot be supported`,
        scope,
        evidenceIds: view.evidence.length > 0 ? uniqueSorted(view.evidence.map((r) => r.id)) : [],
        metadata: {
          claimedEntryPoint: claim.entryPoint,
          claimedProfile: claim.entryPointProfile,
          expectedProfileAddress: expected,
        },
      }),
    );
    adapterWarnings.push(
      adapterWarning(
        ERC4337_WARNING_CODES.entryPointProfileMismatch,
        `EntryPoint profile ${claim.entryPointProfile} does not bind to claimed emitter ${claim.entryPoint}`,
        view.evidence.length > 0 ? uniqueSorted(view.evidence.map((r) => r.id)) : undefined,
      ),
    );
  }

  // -----------------------------------------------------------------------
  // Interpret every observed effect under both pinned shapes; bind each
  // usable observation to THE claimed bundle transaction.
  // -----------------------------------------------------------------------
  const uopCandidates: UserOperationEventObservation[] = [];
  const tsCandidates: TransferSingleObservation[] = [];
  const tbCandidates: TransferBatchObservation[] = [];
  const excludedCandidates: ExcludedCandidate[] = [];
  const txHashMismatches: ObservationTxHashMismatch[] = [];
  let unrelatedEffectCount = 0;
  let nonEntryEmitterCount = 0;
  let unboundNoHashExcludedCount = 0;

  const CARRIER_DETAIL =
    "effect.fields must be a plain record carrying boolean removed and 32-byte-hash topics (generic log observation contract)";

  const pushExclusion = (exclusion: ExcludedCandidate, effect: ObservedEffect): void => {
    excludedCandidates.push(exclusion);
    adapterWarnings.push(
      exclusion.reason === "removed"
        ? adapterWarning(
            ERC4337_WARNING_CODES.removedCandidateExcluded,
            exclusion.detail,
            effect.evidence,
          )
        : adapterWarning(
            ERC4337_WARNING_CODES.malformedCandidateExcluded,
            `relevant effect ${JSON.stringify(effect.id)} excluded: ${exclusion.detail}`,
            effect.evidence,
          ),
    );
    if (exclusion.reason === "malformed") {
      // Malformed RELEVANT evidence is never clean absence: an explicit
      // material conflict scoped to the proposition (fail closed), cited
      // whenever the fragment carries resolvable evidence.
      if (view.evidence.length > 0) {
        const code =
          exclusion.kind === "transferBatch"
            ? ERC4337_CONFLICT_CODES.malformedTransferBatch
            : exclusion.kind === "transferSingle"
              ? ERC4337_CONFLICT_CODES.malformedTransferSingle
              : ERC4337_CONFLICT_CODES.malformedUserOperationEvent;
        adapterConflicts.push(
          adapterConflict({
            code,
            id: `${PROPOSITION_NAMESPACE}:${code}:${exclusion.effectId}`,
            description: `relevant effect ${JSON.stringify(exclusion.effectId)} claims the pinned ${exclusion.kind} shape but failed structural decoding (${exclusion.detail}); competing interpretations remain`,
            scope,
            evidenceIds: effect.evidence,
            metadata: {
              effectId: exclusion.effectId,
              kind: exclusion.kind,
              detail: exclusion.detail,
            },
          }),
        );
      }
    }
  };

  /** Exact transaction binding for one usable observation. */
  function bindsToBundle(
    observation: { effectId: string; transactionHash?: string },
    kind: "userOperationEvent" | "transferSingle" | "transferBatch",
    effect: ObservedEffect,
  ): boolean {
    if (observation.transactionHash !== undefined) {
      if (observation.transactionHash !== bundleHash) {
        txHashMismatches.push({
          effectId: observation.effectId,
          kind,
          observedTransactionHash: observation.transactionHash,
        });
        adapterWarnings.push(
          adapterWarning(
            ERC4337_WARNING_CODES.transactionHashMismatch,
            `${kind} effect ${JSON.stringify(observation.effectId)} belongs to transaction ${observation.transactionHash}, not the claimed bundle transaction ${bundleHash}`,
            effect.evidence,
          ),
        );
        if (networkMatched && view.evidence.length > 0) {
          adapterConflicts.push(
            adapterConflict({
              code: ERC4337_CONFLICT_CODES.observationTransactionHashMismatch,
              id: `${PROPOSITION_NAMESPACE}:${ERC4337_CONFLICT_CODES.observationTransactionHashMismatch}:${observation.effectId}`,
              description: `${kind} effect ${JSON.stringify(observation.effectId)} carries transaction hash ${observation.transactionHash} which differs from the claimed bundle transaction ${bundleHash}; it cannot support the claim`,
              scope,
              evidenceIds: effect.evidence,
              metadata: {
                effectId: observation.effectId,
                kind,
                observedTransactionHash: observation.transactionHash,
                claimedBundleTransactionHash: bundleHash,
              },
            }),
          );
        }
        return false;
      }
      return true;
    }
    // No log-level hash: candidacy requires the exact subject binding.
    if (!subjectMatchesClaim) {
      unboundNoHashExcludedCount += 1;
      return false;
    }
    return true;
  }

  for (let i = 0; i < view.observedEffects.length; i++) {
    const effect = view.observedEffects[i]!;
    const uopInterpretation = interpretUserOperationEventEffect(effect);
    if (uopInterpretation.status !== "unrelated") {
      if (uopInterpretation.status === "excluded") {
        pushExclusion(
          {
            effectId: uopInterpretation.effectId,
            kind: uopInterpretation.detail === CARRIER_DETAIL ? "log" : "userOperationEvent",
            reason: uopInterpretation.reason,
            detail: uopInterpretation.detail,
          },
          effect,
        );
      } else {
        const observation = uopInterpretation.observation;
        if (observation.emitter !== claim.entryPoint) {
          // A UserOperationEvent-shaped log from a non-claimed emitter
          // carries no EntryPoint semantics; it cannot help and cannot
          // mislead. Kept visible through count + warning, never a
          // candidate and never a conflict.
          nonEntryEmitterCount += 1;
          adapterWarnings.push(
            adapterWarning(
              ERC4337_WARNING_CODES.nonEntryEmitterExcluded,
              `UserOperationEvent-shaped effect ${JSON.stringify(observation.effectId)} was emitted by ${observation.emitter}, not the claimed EntryPoint ${claim.entryPoint}`,
              observation.evidenceIds,
            ),
          );
          continue;
        }
        if (bindsToBundle(observation, "userOperationEvent", effect)) {
          uopCandidates.push(observation);
        }
      }
      continue;
    }
    const tsInterpretation = interpretTransferSingleEffect(effect);
    if (tsInterpretation.status !== "unrelated") {
      if (tsInterpretation.status === "excluded") {
        pushExclusion(
          {
            effectId: tsInterpretation.effectId,
            kind: tsInterpretation.detail === CARRIER_DETAIL ? "log" : "transferSingle",
            reason: tsInterpretation.reason,
            detail: tsInterpretation.detail,
          },
          effect,
        );
        continue;
      }
      if (bindsToBundle(tsInterpretation.observation, "transferSingle", effect)) {
        tsCandidates.push(tsInterpretation.observation);
      }
      continue;
    }
    // Not a UserOperationEvent or TransferSingle shape: try TransferBatch.
    const tbInterpretation = interpretTransferBatchEffect(effect);
    if (tbInterpretation.status === "unrelated") {
      // Valid carrier, topic0 matches neither pinned event: ordinary noise.
      unrelatedEffectCount += 1;
      continue;
    }
    if (tbInterpretation.status === "excluded") {
      pushExclusion(
        {
          effectId: tbInterpretation.effectId,
          kind: tbInterpretation.detail === CARRIER_DETAIL ? "log" : "transferBatch",
          reason: tbInterpretation.reason,
          detail: tbInterpretation.detail,
        },
        effect,
      );
      continue;
    }
    if (bindsToBundle(tbInterpretation.observation, "transferBatch", effect)) {
      tbCandidates.push(tbInterpretation.observation);
    }
  }

  // -----------------------------------------------------------------------
  // UserOperation selection (fail closed).
  // -----------------------------------------------------------------------
  const expectedUserOpHash = claim.userOperation.userOpHash;
  const expectedSender = claim.userOperation.sender;
  const identityMatching = expectedUserOpHash
    ? uopCandidates.filter((o) => o.userOpHash === expectedUserOpHash)
    : uopCandidates.filter((o) => o.sender === expectedSender);

  let userOpLayer: UserOpLayerOutcome;
  if (identityMatching.length > 1) {
    // Duplicate exact candidates: fail closed, never arbitrarily choose
    // the first log.
    userOpLayer = { status: "duplicate", duplicates: identityMatching, matching: identityMatching };
    const citation = uniqueSorted(identityMatching.flatMap((o) => o.evidenceIds));
    const identityDescription = expectedUserOpHash
      ? `userOpHash ${expectedUserOpHash}`
      : `sender ${expectedSender}`;
    adapterWarnings.push(
      adapterWarning(
        ERC4337_WARNING_CODES.duplicateExactUserOperations,
        `${identityMatching.length} UserOperationEvents equally match the expected ${identityDescription}; failing closed instead of choosing one`,
        citation,
      ),
    );
    if (view.evidence.length > 0) {
      adapterConflicts.push(
        adapterConflict({
          code: ERC4337_CONFLICT_CODES.duplicateExactUserOperations,
          id: `${PROPOSITION_NAMESPACE}:${ERC4337_CONFLICT_CODES.duplicateExactUserOperations}`,
          description: `${identityMatching.length} usable UserOperationEvents equally match the expected identity (${identityDescription}); selecting one would be arbitrary`,
          scope,
          evidenceIds: citation,
          metadata: {
            expectedUserOpHash: expectedUserOpHash ?? null,
            expectedSender,
            duplicateCount: identityMatching.length,
            effectIds: identityMatching.map((o) => o.effectId),
          },
        }),
      );
    }
  } else if (identityMatching.length === 1) {
    const selected = identityMatching[0]!;
    if (selected.sender !== expectedSender) {
      // Only reachable in exact-userOpHash mode: the hash exists in this
      // bundle but names a different sender.
      userOpLayer = {
        status: "failed",
        selected,
        failure: { observation: selected, reason: "senderMismatch" },
        matching: identityMatching,
      };
      adapterWarnings.push(
        adapterWarning(
          ERC4337_WARNING_CODES.userOperationSenderMismatch,
          `the event carrying userOpHash ${selected.userOpHash} names sender ${selected.sender}, not the expected ${expectedSender}`,
          selected.evidenceIds,
        ),
      );
    } else if (claim.userOperation.requireSuccess && !selected.success) {
      // The selected UserOperation's own success word overrides bundle
      // receipt success for THIS proposition.
      userOpLayer = {
        status: "failed",
        selected,
        failure: { observation: selected, reason: "userOperationFailed" },
        matching: identityMatching,
      };
      adapterWarnings.push(
        adapterWarning(
          ERC4337_WARNING_CODES.userOperationFailed,
          "the selected UserOperationEvent reports success=false (bundle receipt status stays separate)",
          selected.evidenceIds,
        ),
      );
    } else {
      userOpLayer = { status: "matched", selected, matching: identityMatching };
    }
  } else {
    userOpLayer = { status: "absent", matching: [] };
    adapterWarnings.push(
      adapterWarning(
        ERC4337_WARNING_CODES.noUserOperationEventObserved,
        uopCandidates.length === 0
          ? `no usable UserOperationEvent among ${view.observedEffects.length} observed effects (${unrelatedEffectCount} unrelated); bundle execution alone never supports a UserOperation`
          : `${uopCandidates.length} usable UserOperationEvent(s) observed but none matches the expected ${expectedUserOpHash ? "userOpHash" : "sender"}`,
      ),
    );
  }

  // -----------------------------------------------------------------------
  // Expected ERC-1155 burn layer (exact predicate; mint is never a burn).
  // -----------------------------------------------------------------------
  let burnLayer: BurnLayerOutcome | undefined;
  if (claim.expectedEffect !== undefined) {
    const expected = claim.expectedEffect;

    // Project every burn-shaped observation from BOTH carriers into one
    // unified list, so exact-burn correlation and duplicate detection treat
    // TransferSingle and TransferBatch members uniformly. Never summed.
    const toBurnObservation = (
      carrier: "transferSingle" | "transferBatch",
      obs: TransferSingleObservation | (TransferBatchMemberObservation & { contract: string }),
    ): Erc1155BurnObservation => {
      if (carrier === "transferBatch") {
        const m = obs as TransferBatchMemberObservation & { contract: string };
        return {
          carrier,
          effectId: m.memberId,
          carrierEffectId: m.carrierEffectId,
          memberIndex: m.memberIndex,
          contract: m.contract,
          operator: m.operator,
          from: m.from,
          to: m.to,
          tokenId: m.tokenId,
          value: m.value,
          evidenceIds: m.evidenceIds,
        };
      }
      const s = obs as TransferSingleObservation;
      return {
        carrier,
        effectId: s.effectId,
        contract: s.contract,
        operator: s.operator,
        from: s.from,
        to: s.to,
        tokenId: s.tokenId,
        value: s.value,
        evidenceIds: s.evidenceIds,
      };
    };

    const singleBurns = tsCandidates
      .filter((o) => o.to === ZERO_ADDRESS)
      .map((o) => toBurnObservation("transferSingle", o));
    const batchBurns = tbCandidates
      .flatMap((batch) => batch.members.map((m) => ({ batch, m })))
      .filter(({ m }) => m.to === ZERO_ADDRESS)
      .map(({ batch, m }) =>
        toBurnObservation("transferBatch", { ...m, contract: batch.contract }),
      );
    const allBurns: Erc1155BurnObservation[] = [...singleBurns, ...batchBurns];

    // Mints (from == zero) on the expected contract are never burns; surface
    // them loudly across both carriers.
    const mintsOnExpectedContract = [
      ...tsCandidates.filter((o) => o.from === ZERO_ADDRESS && o.contract === expected.contract),
      ...tbCandidates
        .filter((b) => b.from === ZERO_ADDRESS && b.contract === expected.contract)
        .flatMap((b) => b.members),
    ];
    if (mintsOnExpectedContract.length > 0) {
      adapterWarnings.push(
        adapterWarning(
          ERC4337_WARNING_CODES.erc1155MintIsNotBurn,
          `${mintsOnExpectedContract.length} ERC-1155 mint(s) (from == zero) observed on the expected contract; mint semantics are never classified as burn`,
        ),
      );
    }

    const matches = allBurns.filter(
      (o) =>
        o.contract === expected.contract &&
        o.from === expected.from &&
        o.tokenId === expected.tokenId &&
        o.value === expected.value,
    );
    const violations: BurnViolation[] = [];
    if (matches.length === 0) {
      for (const burn of allBurns) {
        if (burn.contract !== expected.contract || burn.from !== expected.from) continue;
        const fields = burnFieldViolations(burn, expected);
        if (fields.length > 0) violations.push({ observation: burn, violations: fields });
      }
    }

    if (matches.length > 1) {
      // Materially non-unique exact burn evidence: a proposition-scoped
      // material conflict (fail closed to ambiguous), never "supported +
      // warning". Spans single+single, single+batch and batch member+batch
      // member — the first match is never arbitrarily chosen.
      burnLayer = { status: "duplicate", matches, violations: [], allBurns };
      const citation = uniqueSorted(matches.flatMap((o) => o.evidenceIds));
      adapterWarnings.push(
        adapterWarning(
          ERC4337_WARNING_CODES.duplicateExactBurns,
          `${matches.length} identical exact burns satisfy the expectation across ${new Set(matches.map((m) => m.carrier)).size} carrier shape(s); material conflict (ambiguous), double-redemption/replay is not adjudicated here`,
          citation,
        ),
      );
      if (view.evidence.length > 0) {
        adapterConflicts.push(
          adapterConflict({
            code: ERC4337_CONFLICT_CODES.duplicateExactBurns,
            id: `${PROPOSITION_NAMESPACE}:${ERC4337_CONFLICT_CODES.duplicateExactBurns}`,
            description: `${matches.length} usable exact burns (contract+from+zero destination+tokenId+value) are materially non-unique; selecting one would be arbitrary (spans single/batch carriers)`,
            scope,
            evidenceIds: citation,
            metadata: {
              exactBurnCount: matches.length,
              carriers: [...new Set(matches.map((m) => m.carrier))],
              effectIds: matches.map((m) => m.effectId),
            },
          }),
        );
      }
    } else if (matches.length === 1) {
      burnLayer = { status: "matched", matches, violations: [], allBurns };
    } else if (violations.length > 0) {
      burnLayer = { status: "violated", matches: [], violations, allBurns };
      const citation = uniqueSorted(violations.flatMap((v) => v.observation.evidenceIds));
      adapterWarnings.push(
        adapterWarning(
          ERC4337_WARNING_CODES.burnExpectationViolated,
          `${violations.length} burn(s) from the expected account on the expected contract violate the exact expectation (${uniqueSorted(violations.flatMap((v) => v.violations)).join(", ")})`,
          citation,
        ),
      );
    } else {
      burnLayer = { status: "absent", matches: [], violations: [], allBurns };
      adapterWarnings.push(
        adapterWarning(
          ERC4337_WARNING_CODES.burnNotObserved,
          `no usable ERC-1155 burn (TransferSingle or TransferBatch member) satisfies the exact expectation (burns require to == ${ZERO_ADDRESS}); absence of the expected effect is insufficiency, never silent success`,
        ),
      );
    }
  }

  // -----------------------------------------------------------------------
  // Contributions for THE state machine (deterministic precedence).
  // -----------------------------------------------------------------------
  const allConflicts: readonly Conflict[] = [...view.conflicts, ...adapterConflicts];

  const inspectedEffectIds = [
    ...uopCandidates.map((o) => o.effectId),
    ...tsCandidates.map((o) => o.effectId),
    ...txHashMismatches.map((m) => m.effectId),
    ...excludedCandidates.map((e) => e.effectId),
  ];
  // RELEVANT DISPUTE: only conflicts whose scope feeds one of THIS
  // assessment's layers (the proposition itself, the required generic
  // execution layer, or any inspected effect). Settlement/finality-scoped
  // disputes concern propositions this adapter never evaluates (finality is
  // orthogonal by contract), so they neither force ambiguity nor crash the
  // composition — they stay visible through the fragment's own artifacts.
  const relevantDispute = allConflicts.some((c) => {
    if (!c.material) return false;
    if (c.scope.kind === "result") return true;
    if (c.scope.kind === "dimension" && c.scope.dimension === "execution") {
      return true;
    }
    if (c.scope.kind === "observed_effect") {
      return inspectedEffectIds.includes(c.scope.effectId);
    }
    return samePropositionScope(c.scope, scope);
  });

  const execDim = view.execution;
  const executionProvided = execDim !== undefined;

  // Execution input (REQUIRED layer):
  //   - absent            -> verdict-less applicable input (+warning);
  //   - not_applicable    -> demoted to verdict-less applicable (+warning);
  //   - unknown           -> fed VERBATIM (asserted uncertainty poisons);
  //   - otherwise         -> passthrough of the fragment's own assertion.
  let executionDemotedToUnproven = !executionProvided;
  if (!executionProvided) {
    adapterWarnings.push(
      adapterWarning(
        ERC4337_WARNING_CODES.executionDimensionAbsent,
        "the fragment provides no execution dimension; successful bundle execution is unproven for the claim",
      ),
    );
  } else if (execDim.applicability === "not_applicable") {
    executionDemotedToUnproven = true;
    adapterWarnings.push(
      adapterWarning(
        ERC4337_WARNING_CODES.executionDimensionNotApplicable,
        "the fragment marks the execution dimension not_applicable; treated as unproven for the claim",
      ),
    );
  }
  function executionInput(): VerdictInput {
    const dimScope = { kind: "dimension", dimension: "execution" } as const;
    if (executionDemotedToUnproven || execDim === undefined) {
      return stripped(dimScope, [], ["deterministic_derivation"]);
    }
    return {
      scope: dimScope,
      applicability: execDim.applicability,
      ...(execDim.verdict === undefined ? {} : { verdict: execDim.verdict }),
      basis: [...execDim.basis],
      evidence: [...execDim.evidence],
    };
  }

  const networkNegative =
    !networkMatched && uniqueSorted(view.evidence.map((r) => r.id)).length > 0;
  const executionContradicted = execDim?.verdict === "contradicted";
  // Carried settlement/finality matter ONLY when actually present AND
  // positively contradicted WITH citations; absence/inconclusiveness stays
  // absence (non-claims + warnings), never a fabricated dimension input.
  const carriedContradicted: Array<{ name: "settlement" | "finality"; dim: EvidenceDimension }> = [];
  for (const [name, dim] of [
    ["settlement", view.settlement],
    ["finality", view.finality],
  ] as const) {
    if (dim?.verdict === "contradicted" && dim.evidence.length > 0) {
      carriedContradicted.push({ name, dim });
    }
  }
  const userOpFailed = userOpLayer.status === "failed";
  const burnViolated = burnLayer?.status === "violated";
  const cleanNegative =
    !relevantDispute &&
    (networkNegative ||
      executionContradicted ||
      carriedContradicted.length > 0 ||
      userOpFailed ||
      burnViolated);
  const subjectUnbindableWithoutConflict =
    !subjectMatchesClaim && !subjectConflictEmitted && !relevantDispute;

  const networkEvidenceIds = uniqueSorted(
    execDim !== undefined && execDim.evidence.length > 0
      ? [...execDim.evidence]
      : view.evidence.map((ref) => ref.id),
  );
  const userOpPresenceEvidence = uniqueSorted(userOpLayer.matching.flatMap((o) => o.evidenceIds));
  const burnPresenceEvidence =
    burnLayer === undefined ? [] : uniqueSorted(burnLayer.matches.flatMap((o) => o.evidenceIds));

  let inputs: VerdictInput[];
  if (relevantDispute) {
    // (a) Full fidelity; the ladder's material-conflict rule decides
    //     (ambiguous) before aggregation could ever mix positives and
    //     negatives. Every inspected effect gets an explicit input so any
    //     observed_effect-scoped conflict reliably reaches the composer.
    inputs = [];
    inputs.push(
      !networkMatched && networkEvidenceIds.length > 0
        ? contradictedInput(scope, networkEvidenceIds)
        : stripped(scope, networkEvidenceIds, ["deterministic_derivation"]),
    );
    inputs.push(executionInput());
    if (userOpLayer.selected !== undefined) {
      inputs.push(
        userOpFailed
          ? contradictedInput(
              { kind: "observed_effect", effectId: userOpLayer.selected.effectId },
              userOpLayer.selected.evidenceIds,
            )
          : supportedEffectInput(userOpLayer.selected),
      );
    }
    for (const duplicate of userOpLayer.duplicates ?? []) {
      inputs.push(
        stripped(
          { kind: "observed_effect", effectId: duplicate.effectId },
          duplicate.evidenceIds,
          ["source_observation"],
        ),
      );
    }
    for (const candidate of uopCandidates) {
      if (
        userOpLayer.matching.some((m) => m.effectId === candidate.effectId) ||
        (userOpLayer.duplicates ?? []).some((d) => d.effectId === candidate.effectId)
      ) {
        continue;
      }
      inputs.push(
        stripped(
          { kind: "observed_effect", effectId: candidate.effectId },
          candidate.evidenceIds,
          ["source_observation"],
        ),
      );
    }
    if (burnLayer !== undefined) {
      for (const match of burnLayer.matches) {
        inputs.push(supportedEffectInput(match));
      }
      for (const violation of burnLayer.violations) {
        inputs.push(
          stripped(
            { kind: "observed_effect", effectId: violation.observation.effectId },
            violation.observation.evidenceIds,
            ["source_observation"],
          ),
        );
      }
      for (const candidate of burnLayer.allBurns) {
        if (
          burnLayer.matches.some((m) => m.effectId === candidate.effectId) ||
          burnLayer.violations.some((v) => v.observation.effectId === candidate.effectId)
        ) {
          continue;
        }
        inputs.push(
          stripped(
            { kind: "observed_effect", effectId: candidate.effectId },
            candidate.evidenceIds,
            ["source_observation"],
          ),
        );
      }
      if (burnViolated) {
        inputs.push(
          contradictedInput(
            scope,
            burnLayer.violations.flatMap((v) => v.observation.evidenceIds),
          ),
        );
      }
    }
    for (const mismatch of txHashMismatches) {
      const effect = view.observedEffects.find((e) => e.id === mismatch.effectId);
      inputs.push(
        stripped(
          { kind: "observed_effect", effectId: mismatch.effectId },
          effect?.evidence ?? [],
          ["source_observation"],
        ),
      );
    }
    for (const excluded of excludedCandidates) {
      const effect = view.observedEffects.find((e) => e.id === excluded.effectId);
      inputs.push(
        stripped(
          { kind: "observed_effect", effectId: excluded.effectId },
          effect?.evidence ?? [],
          ["source_observation"],
        ),
      );
    }
    // Carried settlement/finality scopes are represented whenever present
    // so their (non-dispute) citations stay visible in the full-fidelity
    // view; they never decide this proposition by themselves.
    if (view.settlement !== undefined) {
      inputs.push(
        stripped(
          { kind: "dimension", dimension: "settlement" },
          view.settlement.evidence,
          ["source_observation"],
        ),
      );
    }
    if (view.finality !== undefined) {
      inputs.push(
        stripped(
          { kind: "dimension", dimension: "finality" },
          view.finality.evidence,
          ["source_observation"],
        ),
      );
    }
    inputs.push(presenceInput(userOpLayer.status === "matched", userOpPresenceEvidence, scope));
    if (burnLayer !== undefined) {
      inputs.push(presenceInput(burnLayer.status === "matched", burnPresenceEvidence, scope));
    }
  } else if (cleanNegative) {
    // (b) Clean contradiction: negatives decide, everything else loses its
    // voice (no supported-vs-contradicted mixing, no proof laundering).
    inputs = [];
    if (networkNegative) {
      inputs.push(contadictedNetworkInput(scope, networkEvidenceIds));
    }
    if (executionContradicted && execDim !== undefined) {
      inputs.push({
        scope: { kind: "dimension", dimension: "execution" },
        applicability: "applicable",
        verdict: "contradicted",
        basis: [...execDim.basis],
        evidence: [...execDim.evidence],
      });
    }
    for (const { name, dim } of carriedContradicted) {
      inputs.push({
        scope: { kind: "dimension", dimension: name },
        applicability: "applicable",
        verdict: "contradicted",
        basis: [...dim.basis],
        evidence: [...dim.evidence],
      });
    }
    if (userOpFailed && userOpLayer.failure !== undefined) {
      inputs.push(
        contradictedInput(
          { kind: "observed_effect", effectId: userOpLayer.failure.observation.effectId },
          userOpLayer.failure.observation.evidenceIds,
        ),
      );
    }
    if (burnViolated && burnLayer !== undefined) {
      inputs.push(
        contradictedInput(
          scope,
          burnLayer.violations.flatMap((v) => v.observation.evidenceIds),
        ),
      );
    }
    inputs.push(stripped(scope, userOpPresenceEvidence, ["deterministic_derivation"]));
    inputs.push(
      stripped(
        { kind: "dimension", dimension: "execution" },
        execDim?.evidence ?? [],
        ["source_observation"],
      ),
    );
  } else if (subjectUnbindableWithoutConflict) {
    // (c) Nothing binds this evidence to the claimed bundle transaction
    // (and no citable disagreement exists): nothing may speak positively.
    inputs = [
      stripped(scope, networkEvidenceIds, ["deterministic_derivation"]),
      executionInput(),
    ];
    adapterWarnings.push(
      adapterWarning(
        ERC4337_WARNING_CODES.subjectDoesNotMatchClaim,
        "the evidence cannot be bound to the claimed bundle transaction; treating every layer as unproven",
      ),
    );
  } else {
    // (d) Positive path: binding + execution + selected-op + exact burns +
    // presence. Unmatched/near-miss effects contribute NOTHING here (they
    // are listed in the report instead).
    inputs = [];
    inputs.push(
      networkEvidenceIds.length === 0
        ? stripped(scope, networkEvidenceIds, ["deterministic_derivation"])
        : {
            scope,
            applicability: "applicable",
            verdict: networkMatched ? ("supported" as const) : ("contradicted" as const),
            basis: ["source_observation", "deterministic_derivation"],
            evidence: networkEvidenceIds,
          },
    );
    inputs.push(executionInput());
    if (userOpLayer.status === "matched" && userOpLayer.selected !== undefined) {
      inputs.push(supportedEffectInput(userOpLayer.selected));
    }
    if (burnLayer !== undefined) {
      for (const match of burnLayer.matches) {
        inputs.push(supportedEffectInput(match));
      }
      inputs.push(presenceInput(burnLayer.status === "matched", burnPresenceEvidence, scope));
    }
    inputs.push(presenceInput(userOpLayer.status === "matched", userOpPresenceEvidence, scope));
  }

  // THE frozen core state machine decides.
  const composed = composeVerdict(inputs, { conflicts: allConflicts, evidenceRefs: view.evidence });

  // Separate reporting composition for the GENERIC execution proposition.
  const execReport = composeVerdict([executionInput()], {
    conflicts: view.conflicts,
    evidenceRefs: view.evidence,
  });

  // -----------------------------------------------------------------------
  // Adapter-level reporting warnings.
  // -----------------------------------------------------------------------
  if (unboundNoHashExcludedCount > 0) {
    adapterWarnings.push(
      adapterWarning(
        ERC4337_WARNING_CODES.subjectDoesNotMatchClaim,
        `${unboundNoHashExcludedCount} relevant effect(s) carry neither their own transaction hash nor an exactly-correlated subject`,
      ),
    );
  }
  // Standing non-claim surfacing: absent/inconclusive dimensions are
  // reported as absence — never fabricated into applicability.
  if (view.finality?.verdict !== "supported") {
    adapterWarnings.push(
      adapterWarning(
        ERC4337_WARNING_CODES.finalityNotEstablished,
        "L2 block finality is not established by this evidence; UserOperation success != finality",
      ),
    );
  }
  if (view.settlement?.verdict !== "supported") {
    adapterWarnings.push(
      adapterWarning(
        ERC4337_WARNING_CODES.settlementNotEstablished,
        "settlement reliability beyond execution status is not established by this evidence",
      ),
    );
  }

  const warnings = mergeWarnings(composed.warnings, mergeWarnings([], adapterWarnings));
  const materialConflictIds = allConflicts
    .filter((c) => c.material)
    .map((c) => c.id)
    .sort();

  const verdict = composed.verdict;
  return {
    adapterProfile: ERC4337_ADAPTER_PROFILE,
    protocol: "erc4337",
    claimDigest,
    claim,
    correlationStrength: "same_bundle_only",
    bundleTransactionHash: bundleHash,
    subjectMatchesClaim,
    observedNetwork: {
      networkId: view.networkId,
      ...(view.chainId === undefined ? {} : { chainId: view.chainId }),
      matchedRequirement: networkMatched,
    },
    outcome: {
      applicability: composed.applicability,
      ...(verdict === undefined ? {} : { verdict }),
      basis: [...composed.basis],
      evidence: [...composed.evidence],
      materialConflictIds,
    },
    execution: {
      providedByFragment: executionProvided,
      applicability: execReport.applicability,
      ...(execReport.verdict === undefined ? {} : { verdict: execReport.verdict }),
    },
    claimLabel:
      verdict === undefined ? ERC4337_CLAIM_LABELS.undetermined : ERC4337_CLAIM_LABELS[verdict],
    nonClaims: ERC4337_NON_CLAIMS,
    ...(userOpLayer.selected === undefined ? {} : { selectedUserOperation: userOpLayer.selected }),
    ...(userOpLayer.failure === undefined
      ? {}
      : { selectedUserOperationFailure: userOpLayer.failure }),
    userOperationCandidates: uopCandidates,
    matchingBurns: burnLayer?.matches ?? [],
    conflictingBurns: burnLayer?.violations ?? [],
    excludedCandidates,
    transactionHashMismatches: txHashMismatches,
    candidateCount: uopCandidates.length,
    transferSingleCandidateCount: tsCandidates.length,
    transferBatchCandidateCount: tbCandidates.length,
    unrelatedEffectCount,
    nonEntryEmitterCount,
    warnings,
  };
}

/** Contradicted network-layer input (branch b helper; kept deterministic). */
function contadictedNetworkInput(scope: PropositionScope, evidence: readonly string[]): VerdictInput {
  return contradictedInput(scope, evidence);
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

/**
 * PRIMARY v0.1 assessment: evaluate an exact expected ERC-4337 UserOperation
 * CLAIM against ONE frozen-core `NetworkEvidenceFragment` (generic network
 * resolver output).
 *
 * Fail-closed intake:
 *   - the claim is parsed/validated strictly (normalized addresses, exact
 *     decimal amounts, canonical hashes);
 *   - the fragment is FULLY validated through core before any field is read;
 *     a structurally invalid fragment throws (never degrades to a verdict).
 */
export function assessErc4337UserOperation(
  claimInput: Erc4337Claim | unknown,
  fragment: NetworkEvidenceFragment,
): Erc4337Evaluation {
  const parsed = parseErc4337Claim(claimInput);
  validateNetworkEvidenceFragment(fragment);
  return assessInternal(parsed, {
    networkId: fragment.network.networkId,
    ...(fragment.network.chainId === undefined ? {} : { chainId: fragment.network.chainId }),
    subject: fragment.subject,
    execution: fragment.networkEvidence.execution,
    settlement: fragment.networkEvidence.settlement,
    finality: fragment.networkEvidence.finality,
    observedEffects: fragment.networkEvidence.observedEffects ?? [],
    evidence: fragment.evidence,
    conflicts: fragment.conflicts,
  });
}

/**
 * COMPATIBILITY wrapper: evaluate against a COMPLETE
 * `NetworkEvidenceResult` (the recovered prototype's input shape). It
 * validates the result through core, projects it into the fragment view and
 * delegates to THE ONE shared internal path used by
 * `assessErc4337UserOperation`.
 */
export function evaluateErc4337Bundle(
  claimInput: Erc4337Claim | unknown,
  result: NetworkEvidenceResult,
): Erc4337Evaluation {
  validateNetworkEvidenceResult(result);
  const parsed = parseErc4337Claim(claimInput);
  return assessInternal(parsed, {
    networkId: result.network.networkId,
    ...(result.network.chainId === undefined ? {} : { chainId: result.network.chainId }),
    subject: result.subject,
    execution: result.networkEvidence.execution,
    settlement: result.networkEvidence.settlement,
    finality: result.networkEvidence.finality,
    observedEffects: result.networkEvidence.observedEffects,
    evidence: result.evidence,
    conflicts: result.conflicts,
  });
}
