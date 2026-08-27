/**
 * EVALUATION LAYER: x402 v2 exact-scheme expected-payment semantics over
 * frozen-core network evidence.
 *
 * PRIMARY INPUT: a `NetworkEvidenceFragment` (what `NetworkResolver.resolve`
 * returns) plus an `X402PaymentClaim` (expected requirement + claimed
 * payment transaction). The complete `NetworkEvidenceResult` form remains
 * available through the COMPATIBILITY wrapper `evaluateX402ExactSettlement`,
 * which projects the result into the same fragment view and delegates to
 * THE ONE shared internal path below. There is no second semantics.
 *
 * THE PROPOSITION. One explicit NEC proposition per assessment:
 *
 *     "an observed ERC-20 Transfer, exactly correlated to the claimed
 *      payment transaction, matches the expected x402 exact payment
 *      requirement"
 *
 * scoped `{kind:"custom", namespace:"x402.adapter", id:<requirementDigest>}`.
 * The STRONGEST positive outcome is named exactly that: an observed,
 * subject-correlated transfer MATCHING the expectation. It is NOT "x402
 * verified settlement" and NOT "settlement/finality established" — see
 * `X402_NON_CLAIMS`.
 *
 * EXACT TRANSACTION BINDING (release-blocking rule):
 *   - the fragment subject MUST be `{type:"transaction"}`, carry the
 *     normalized x402 network id and the claimed paymentTxHash;
 *   - a Transfer observation that carries its own transactionHash MUST bind
 *     to the SAME hash; a log from transaction Y can never support a claim
 *     about transaction X. A violating log is excluded from candidacy AND
 *     recorded as an explicit material Conflict scoped to the payment
 *     proposition (never silently treated as ordinary noise);
 *   - a Transfer observation WITHOUT a transactionHash may only be a
 *     candidate while the fragment SUBJECT itself is exactly correlated.
 *
 * EXPECTATION CONFLICTS. A correlated candidate paying the RIGHT token but
 * violating recipient/amount/payer is an explicit claim-vs-network mismatch:
 * it surfaces as a material Conflict scoped to the payment proposition, so
 * the composed outcome can never be "supported". Near-miss transfers of
 * OTHER tokens remain ordinary noise. Network execution semantics stay
 * SEPARATE: a successful execution to the wrong payee keeps execution
 * supported (reported verbatim); only the payment proposition conflicts.
 * Conversely a genuinely contradicted execution dimension (revert) feeds a
 * negative contribution into the payment conclusion — no execution, no
 * payment.
 *
 * SETTLEMENT/FINALITY ABSENCE. Generic EVM evidence does not provide
 * settlement or finality. Absent or inconclusive carried dimensions are
 * NEVER fabricated into applicable+insufficient inputs just to fit the
 * evaluator: they remain absence, surfaced as permanent non-claims and
 * warnings. Only an actually-present CONTRADICTED carried dimension (with
 * citations) contributes negatively.
 *
 * MATCHING LAYERS (each becomes a contribution to THE frozen core state
 * machine, `composeVerdict`):
 *   1. subject/network correlation (payment scope),
 *   2. execution passthrough (REQUIRED layer; unknown poisons to unknown;
 *      contradicted contradicts; absent/verdict-less/N-A demoted to
 *      insufficiency with warnings),
 *   3..n candidates — one contribution PER bound Transfer-shaped effect,
 *   + presence — carries the actual match conclusion so a missing Transfer
 *     yields INSUFFICIENT, never silent success.
 *
 * DETERMINISTIC PRECEDENCE before feeding the machine (documented inline):
 *   a. RELEVANT DISPUTE (material conflict affecting the result, a relied-
 *      upon dimension, a candidate/excluded effect, or the payment
 *      proposition itself): full-fidelity inputs; the ladder forces
 *      "ambiguous".
 *   b. CLEAN NEGATIVES (network mismatch / contradicted execution /
 *      contradicted carried dimension, no relevant dispute): negatives-only
 *      ⇒ clean "contradicted".
 *   c. UNBINDABLE SUBJECT without a citable conflict: verdict-less inputs
 *      ⇒ "insufficient" (never positive).
 *   d. OTHERWISE positive path with bound matching candidates only.
 *
 * DETERMINISM. No clock, no randomness, no I/O; identical inputs produce
 * identical outputs. All report values are JSON-safe primitives.
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

import { parseX402PaymentClaim } from "./claim.js";
import type { X402PaymentClaim } from "./claim.js";
import { interpretObservedEffect } from "./interpret.js";
import type { TransferObservation } from "./interpret.js";
import {
  computeRequirementDigest,
  parseX402ExactPaymentRequirement,
} from "./requirement.js";
import type { X402ExactPaymentRequirement } from "./requirement.js";

export const X402_ADAPTER_PROFILE = "nec-adapter-x402-v0.1";
export const PROPOSITION_NAMESPACE = "x402.adapter";

/**
 * Adapter-emitted Conflict codes. These represent claim-vs-network
 * disagreements OBSERVED BY THIS ADAPTER between the normalized claim and
 * the artifact content — never protocol success strings.
 */
export const X402_CONFLICT_CODES = Object.freeze({
  observationTransactionHashMismatch: "X402_OBSERVATION_TX_HASH_MISMATCH",
  paymentExpectationMismatch: "X402_PAYMENT_EXPECTATION_MISMATCH",
  subjectNotPaymentTransaction: "X402_SUBJECT_NOT_PAYMENT_TRANSACTION",
} as const);

/** Adapter warning codes (stable identifiers, deterministic emission). */
export const X402_WARNING_CODES = Object.freeze({
  finalityNotEstablished: "X402_FINALITY_NOT_ESTABLISHED",
  settlementNotEstablished: "X402_SETTLEMENT_DIMENSION_NOT_ESTABLISHED",
  noTransferObserved: "X402_NO_TRANSFER_EVENT_OBSERVED",
  removedCandidateExcluded: "X402_REMOVED_TRANSFER_LOG_EXCLUDED",
  malformedCandidateExcluded: "X402_MALFORMED_TRANSFER_LOG_EXCLUDED",
  duplicateMatchingTransfers: "X402_DUPLICATE_MATCHING_TRANSFERS",
  executionDimensionNotApplicable: "X402_EXECUTION_DIMENSION_NOT_APPLICABLE",
  executionDimensionAbsent: "X402_EXECUTION_DIMENSION_ABSENT",
  transactionHashMismatch: "X402_TRANSACTION_HASH_MISMATCH",
  subjectDoesNotMatchClaim: "X402_SUBJECT_DOES_NOT_MATCH_CLAIM",
  paymentExpectationMismatch: "X402_PAYMENT_EXPECTATION_MISMATCH_WARNING",
});

/**
 * Claim labels by composed verdict. The supported label deliberately claims
 * only what the evidence establishes: an OBSERVED, EXACTLY CORRELATED match
 * of the requirement.
 */
export const X402_CLAIM_LABELS: Readonly<Record<EvidenceVerdict, string>> & {
  readonly undetermined: string;
} = Object.freeze({
  supported: "OBSERVED_CORRELATED_TRANSFER_MATCHES_EXPECTED_X402_PAYMENT_REQUIREMENT",
  contradicted: "EXECUTION_OR_NETWORK_EVIDENCE_CONTRADICTS_EXPECTED_PAYMENT",
  ambiguous: "EVIDENCE_CONFLICT_PREVENTS_DETERMINISTIC_PAYMENT_CONCLUSION",
  insufficient: "INSUFFICIENT_EVIDENCE_FOR_EXPECTED_X402_PAYMENT_REQUIREMENT",
  undetermined: "PAYMENT_CONCLUSION_UNDETERMINED",
});

/**
 * PERMANENT NON-CLAIMS. A matching Transfer event does NOT establish any of
 * these; they are emitted on EVERY assessment regardless of outcome:
 *
 *   - TOKEN_CONTRACT_HONESTY_NOT_ESTABLISHED:
 *       the token contract could emit arbitrary events (a malicious token
 *       can fake a Transfer without moving anything);
 *   - BALANCE_STATE_CHANGE_NOT_PROVEN_SEPARATELY:
 *       no state-diff/balance proof is consumed here;
 *   - X402_AUTHORIZATION_SIGNATURE_VALIDITY_NOT_EVALUATED:
 *       no EIP-712 / scheme signature was checked;
 *   - EIP3009_PERMIT2_AUTHORIZATION_CAUSATION_NOT_ESTABLISHED:
 *       nothing ties an x402 authorization to THIS transaction's cause;
 *   - FACILITATOR_VERIFY_OUTCOME_NOT_ESTABLISHED:
 *       no facilitator /verify call exists or was evaluated;
 *   - FACILITATOR_SETTLE_OUTCOME_NOT_ESTABLISHED:
 *       no facilitator /settle call exists or was evaluated;
 *   - PROTOCOL_SUCCESS_CLAIM_NOT_ESTABLISHED:
 *       x402/facilitator "success" fields are claims/context until
 *       independently correlated to network evidence;
 *   - TRANSACTION_FINALITY_NOT_ESTABLISHED:
 *       block depth / reorg resistance is not proven by this evidence;
 *   - ECONOMIC_IRREVERSIBILITY_NOT_ESTABLISHED:
 *       irreversibility is never claimed by observation alone.
 */
export const X402_NON_CLAIMS: readonly string[] = Object.freeze([
  "TOKEN_CONTRACT_HONESTY_NOT_ESTABLISHED",
  "BALANCE_STATE_CHANGE_NOT_PROVEN_SEPARATELY",
  "X402_AUTHORIZATION_SIGNATURE_VALIDITY_NOT_EVALUATED",
  "EIP3009_PERMIT2_AUTHORIZATION_CAUSATION_NOT_ESTABLISHED",
  "FACILITATOR_VERIFY_OUTCOME_NOT_ESTABLISHED",
  "FACILITATOR_SETTLE_OUTCOME_NOT_ESTABLISHED",
  "PROTOCOL_SUCCESS_CLAIM_NOT_ESTABLISHED",
  "TRANSACTION_FINALITY_NOT_ESTABLISHED",
  "ECONOMIC_IRREVERSIBILITY_NOT_ESTABLISHED",
]);

export interface ExcludedCandidate {
  readonly effectId: string;
  readonly reason: "removed" | "malformed";
  readonly detail: string;
}

/** A Transfer-shaped observation bound to a DIFFERENT transaction (P1). */
export interface TransactionHashMismatch {
  readonly effectId: string;
  /** Lowercase transaction hash carried by the observation. */
  readonly observedTransactionHash: string;
}

export interface X402PaymentEvaluation {
  readonly adapterProfile: typeof X402_ADAPTER_PROFILE;
  readonly protocol: "x402";
  readonly x402Version: "2";
  readonly scheme: "exact";
  /** Digest of the NORMALIZED requirement (`sha256:<hex>`). */
  readonly requirementDigest: string;
  /** Normalized requirement echo (lowercase addresses, canonical amount). */
  readonly requirement: X402ExactPaymentRequirement;
  /**
   * Echo of the claimed payment transaction hash this assessment was bound
   * to (lowercase), when an exact identity was available at all.
   */
  readonly paymentTxHash?: string;
  /**
   * True iff the evidence subject IS the claimed payment transaction
   * (`type:"transaction"`, matching networkId, txId === paymentTxHash).
   */
  readonly subjectMatchesClaim: boolean;
  readonly observedNetwork: {
    readonly networkId: string;
    readonly chainId?: number;
    readonly matchedRequirement: boolean;
  };
  /**
   * Composed outcome of THE x402 payment proposition from the frozen core
   * state machine (`composeVerdict`): applicability always present; verdict
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
   * SEPARATE generic execution semantics, composed by the same frozen state
   * machine over the fragment's own execution dimension. Never rewritten
   * because the payment expectation matched or failed: a successful
   * transaction to the wrong payee stays execution=supported while the
   * payment proposition conflicts.
   */
  readonly execution: {
    readonly providedByFragment: boolean;
    readonly applicability: Applicability;
    readonly verdict?: EvidenceVerdict;
  };
  /** Strongest claim licensed by the outcome (see X402_CLAIM_LABELS). */
  readonly claim: string;
  /** Permanent non-claims; identical on every assessment. */
  readonly nonClaims: readonly string[];
  readonly matchingTransfers: readonly TransferObservation[];
  readonly excludedCandidates: readonly ExcludedCandidate[];
  /** Transfer-shaped observations bound to a different transaction. */
  readonly transactionHashMismatches: readonly TransactionHashMismatch[];
  /** Ids of adapter-emitted expectation-mismatch conflicts (right token). */
  readonly expectationConflictIds: readonly string[];
  /** Number of bound Transfer-shaped effects inspected (matching or not). */
  readonly candidateCount: number;
  /** Number of observed effects that were not Transfer-shaped at all. */
  readonly unrelatedEffectCount: number;
  /** Composition warnings + adapter warnings, deduplicated, sorted. */
  readonly warnings: readonly Warning[];
}

const TX_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

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
  readonly warnings: readonly Warning[];
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function adapterWarning(code: string, message: string, evidence?: readonly string[]): Warning {
  return evidence !== undefined && evidence.length > 0
    ? { code, message, evidence: [...evidence] }
    : { code, message };
}

function paymentScopeOf(requirementDigest: string): PropositionScope {
  return { kind: "custom", namespace: PROPOSITION_NAMESPACE, id: requirementDigest };
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
    evidence: [...new Set(args.evidenceIds)],
    material: true,
    ...(args.metadata === undefined ? {} : { metadata: args.metadata }),
  };
}

/**
 * Presence layer (payment-scoped): carries the actual match conclusion so a
 * missing Transfer yields INSUFFICIENT rather than silent success.
 */
function presenceInput(
  matchingTransfers: readonly TransferObservation[],
  scope: PropositionScope,
): VerdictInput {
  return matchingTransfers.length > 0
    ? {
        scope,
        applicability: "applicable",
        verdict: "supported",
        basis: ["source_observation", "deterministic_derivation"],
        evidence: uniqueSorted(matchingTransfers.flatMap((o) => o.evidenceIds)),
      }
    : {
        scope,
        applicability: "applicable",
        basis: ["deterministic_derivation"],
        evidence: [],
      };
}

/** Verdict-less projection of any layer (scope/citation reach retained). */
function stripped(
  scope: PropositionScope,
  evidence: readonly string[],
  basis: readonly EvidenceBasis[],
): VerdictInput {
  return { scope, applicability: "applicable", basis: [...basis], evidence: [...evidence] };
}

function matchesRequirement(o: TransferObservation, req: X402ExactPaymentRequirement): boolean {
  if (o.asset !== req.asset) return false;
  if (o.to !== req.payTo) return false;
  if (BigInt(o.amount) !== BigInt(req.amount)) return false;
  if (req.payer !== undefined && o.from !== req.payer) return false;
  return true;
}

/** Which expected terms one right-token observation violates (deterministic order). */
function expectationViolations(
  o: TransferObservation,
  req: X402ExactPaymentRequirement,
): string[] {
  const violations: string[] = [];
  if (o.to !== req.payTo) violations.push(`recipient:${o.to}`);
  if (BigInt(o.amount) !== BigInt(req.amount)) violations.push(`amount:${o.amount}`);
  if (req.payer !== undefined && o.from !== req.payer) violations.push(`sender:${o.from}`);
  return violations;
}

/**
 * THE ONE shared internal assessment path. `expectedTxHash` is the
 * canonical lowercase claimed payment transaction hash, or undefined when
 * no usable exact identity exists (compatibility intake with an unusable
 * result subject) — in which case nothing can positively bind.
 */
function assessInternal(
  req: X402ExactPaymentRequirement,
  expectedTxHash: string | undefined,
  view: FragmentView,
): X402PaymentEvaluation {
  const requirementDigest = computeRequirementDigest(req);
  const scope = paymentScopeOf(requirementDigest);

  // -----------------------------------------------------------------------
  // Layer 1: network + subject correlation.
  // -----------------------------------------------------------------------
  const networkMatched =
    view.networkId === req.network &&
    (view.chainId === undefined || view.chainId === req.chainId);

  const subject = view.subject;
  const subjectMatchesClaim =
    subject.type === "transaction" &&
    subject.networkId === req.network &&
    expectedTxHash !== undefined &&
    typeof subject.txId === "string" &&
    subject.txId.toLowerCase() === expectedTxHash;

  const adapterConflicts: Conflict[] = [];
  const adapterWarnings: Warning[] = [];

  // Explicit subject-vs-claim disagreement: record it as a material conflict
  // scoped to the payment proposition whenever it can be cited (fail closed,
  // never silently treated as unrelated noise). When the network layer
  // ALREADY disagrees, no adapter conflicts are emitted at all: the clean
  // network contradiction decides (see deterministic precedence below).
  let subjectConflictEmitted = false;
  if (
    !subjectMatchesClaim &&
    networkMatched &&
    expectedTxHash !== undefined &&
    view.evidence.length > 0
  ) {
    const citation = uniqueSorted(view.evidence.map((ref) => ref.id));
    const conflict = adapterConflict({
      code: X402_CONFLICT_CODES.subjectNotPaymentTransaction,
      id: `${PROPOSITION_NAMESPACE}:${X402_CONFLICT_CODES.subjectNotPaymentTransaction}`,
      description:
        "the evidence subject is not the claimed x402 payment transaction; the claim cannot be assessed against this evidence",
      scope,
      evidenceIds: citation,
      metadata: {
        ...(subject.type === "transaction" ? { subjectTxId: subject.txId } : {}),
        claimedPaymentTxHash: expectedTxHash,
        subjectType: subject.type,
      },
    });
    adapterConflicts.push(conflict);
    subjectConflictEmitted = true;
    adapterWarnings.push(
      adapterWarning(
        X402_WARNING_CODES.subjectDoesNotMatchClaim,
        `evidence subject (${subject.type}) does not match the claimed payment transaction`,
        citation,
      ),
    );
  }

  // -----------------------------------------------------------------------
  // Layers 3..n: interpret every observed effect; classify candidates under
  // EXACT transaction binding.
  // -----------------------------------------------------------------------
  const candidates: TransferObservation[] = [];
  const excludedCandidates: ExcludedCandidate[] = [];
  const hashMismatches: TransactionHashMismatch[] = [];
  let unboundNoHashExcludedCount = 0;
  let unrelatedEffectCount = 0;

  for (let i = 0; i < view.observedEffects.length; i++) {
    const effect = view.observedEffects[i]!;
    const interpretation = interpretObservedEffect(effect);
    if (interpretation.status === "unrelated") {
      unrelatedEffectCount += 1;
      continue;
    }
    if (interpretation.status === "excluded") {
      excludedCandidates.push({
        effectId: interpretation.effectId,
        reason: interpretation.reason,
        detail: interpretation.detail,
      });
      adapterWarnings.push(
        interpretation.reason === "removed"
          ? adapterWarning(
              X402_WARNING_CODES.removedCandidateExcluded,
              `${interpretation.detail}`,
              effect.evidence,
            )
          : adapterWarning(
              X402_WARNING_CODES.malformedCandidateExcluded,
              `transfer-shaped effect ${JSON.stringify(effect.id)} excluded: ${interpretation.detail}`,
              effect.evidence,
            ),
      );
      continue;
    }

    const observation = interpretation.observation;
    if (observation.transactionHash !== undefined) {
      if (expectedTxHash === undefined || observation.transactionHash !== expectedTxHash) {
        // P1 RULE: a log from transaction Y must never support a claim about
        // transaction X. Exclude from candidacy and — when an exact claim
        // identity exists — record the disagreement explicitly as a
        // material conflict scoped to the payment proposition.
        hashMismatches.push({
          effectId: observation.effectId,
          observedTransactionHash: observation.transactionHash,
        });
        adapterWarnings.push(
          adapterWarning(
            X402_WARNING_CODES.transactionHashMismatch,
            `transfer-shaped effect ${JSON.stringify(observation.effectId)} belongs to transaction ${observation.transactionHash}, not the claimed payment transaction${expectedTxHash === undefined ? " (no claimable identity)" : ""}`,
            effect.evidence,
          ),
        );
        if (networkMatched && expectedTxHash !== undefined && view.evidence.length > 0) {
          adapterConflicts.push(
            adapterConflict({
              code: X402_CONFLICT_CODES.observationTransactionHashMismatch,
              id: `${PROPOSITION_NAMESPACE}:${X402_CONFLICT_CODES.observationTransactionHashMismatch}:${observation.effectId}`,
              description: `transfer-shaped effect ${JSON.stringify(observation.effectId)} carries transaction hash ${observation.transactionHash} which differs from the claimed payment transaction ${expectedTxHash}; it cannot support the claim`,
              scope,
              evidenceIds: effect.evidence,
              metadata: {
                effectId: observation.effectId,
                observedTransactionHash: observation.transactionHash,
                claimedPaymentTxHash: expectedTxHash,
              },
            }),
          );
        }
        continue;
      }
    } else if (!subjectMatchesClaim) {
      // No log-level hash and no exact subject binding: zero correlation,
      // never a positive candidate.
      unboundNoHashExcludedCount += 1;
      continue;
    }
    candidates.push(observation);
  }

  // Expectation evaluation over BOUND candidates only.
  const matchingTransfers = candidates.filter((o) => matchesRequirement(o, req));
  const expectationConflictIds: string[] = [];
  for (const candidate of candidates) {
    if (candidate.asset !== req.asset) continue; // other-token activity: noise
    const violations = expectationViolations(candidate, req);
    if (violations.length === 0) continue;
    // Right token, wrong terms inside the claimed payment transaction: an
    // explicit claim-vs-network mismatch, deterministically surfaced.
    if (view.evidence.length > 0) {
      const conflict = adapterConflict({
        code: X402_CONFLICT_CODES.paymentExpectationMismatch,
        id: `${PROPOSITION_NAMESPACE}:${X402_CONFLICT_CODES.paymentExpectationMismatch}:${candidate.effectId}`,
        description: `observed ERC-20 Transfer ${JSON.stringify(candidate.effectId)} moves the required asset but violates the expected x402 payment terms (${violations.join(", ")})`,
        scope,
        evidenceIds: candidate.evidenceIds,
        metadata: {
          effectId: candidate.effectId,
          violations,
          observedRecipient: candidate.to,
          observedAmount: candidate.amount,
        },
      });
      adapterConflicts.push(conflict);
      expectationConflictIds.push(conflict.id);
      adapterWarnings.push(
        adapterWarning(
          X402_WARNING_CODES.paymentExpectationMismatch,
          `transfer ${JSON.stringify(candidate.effectId)} violates the expected payment terms (${violations.join(", ")})`,
          candidate.evidenceIds,
        ),
      );
    }
  }

  // -----------------------------------------------------------------------
  // Contributions for THE state machine (deterministic precedence).
  // -----------------------------------------------------------------------
  const allConflicts: readonly Conflict[] = [...view.conflicts, ...adapterConflicts];

  const candidateEffectIds = candidates.map((o) => o.effectId);
  const excludedEffectIds = excludedCandidates.map((e) => e.effectId);
  const relevantDispute = allConflicts.some((c) => {
    if (!c.material) return false;
    if (c.scope.kind === "result") return true;
    if (
      c.scope.kind === "dimension" &&
      (c.scope.dimension === "execution" ||
        c.scope.dimension === "settlement" ||
        c.scope.dimension === "finality")
    ) {
      return true;
    }
    if (c.scope.kind === "observed_effect") {
      return (
        candidateEffectIds.includes(c.scope.effectId) ||
        excludedEffectIds.includes(c.scope.effectId)
      );
    }
    return samePropositionScope(c.scope, scope);
  });

  const execDim = view.execution;
  const executionProvided = execDim !== undefined;

  // Execution input (REQUIRED layer):
  //   - absent            -> verdict-less applicable input (+warning): the
  //                          layer is unproven, not excused;
  //   - not_applicable    -> demoted to verdict-less applicable (+warning);
  //   - unknown           -> fed VERBATIM: asserted uncertainty about this
  //                          required layer poisons the whole proposition;
  //   - otherwise         -> passthrough of the fragment's own assertion.
  let executionDemotedToUnproven = !executionProvided;
  if (!executionProvided) {
    adapterWarnings.push(
      adapterWarning(
        X402_WARNING_CODES.executionDimensionAbsent,
        "the fragment provides no execution dimension; successful execution is unproven for the payment claim",
      ),
    );
  } else if (execDim.applicability === "not_applicable") {
    executionDemotedToUnproven = true;
    adapterWarnings.push(
      adapterWarning(
        X402_WARNING_CODES.executionDimensionNotApplicable,
        "the fragment marks the execution dimension not_applicable; treated as unproven for the payment claim",
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

  // Negative conditions.
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
  const cleanNegative =
    !relevantDispute && (networkNegative || executionContradicted || carriedContradicted.length > 0);
  const subjectUnbindableWithoutConflict =
    !subjectMatchesClaim && !subjectConflictEmitted && !relevantDispute;

  const networkEvidenceIds = uniqueSorted(
    execDim !== undefined && execDim.evidence.length > 0
      ? [...execDim.evidence]
      : view.evidence.map((ref) => ref.id),
  );
  const presenceEvidence = uniqueSorted(matchingTransfers.flatMap((o) => o.evidenceIds));

  let inputs: VerdictInput[];
  if (relevantDispute) {
    // (a) Full fidelity; the ladder's material-conflict rule decides.
    inputs = [];
    inputs.push(
      !networkMatched && networkEvidenceIds.length > 0
        ? {
            scope,
            applicability: "applicable",
            verdict: "contradicted",
            basis: ["deterministic_derivation"],
            evidence: networkEvidenceIds,
          }
        : stripped(scope, networkEvidenceIds, ["deterministic_derivation"]),
    );
    inputs.push(executionInput());
    for (const candidate of candidates) {
      inputs.push(
        matchesRequirement(candidate, req)
          ? {
              scope: { kind: "observed_effect", effectId: candidate.effectId },
              applicability: "applicable",
              verdict: "supported",
              basis: ["source_observation", "deterministic_derivation"],
              evidence: [...candidate.evidenceIds],
            }
          : stripped({ kind: "observed_effect", effectId: candidate.effectId }, candidate.evidenceIds, [
              "source_observation",
            ]),
      );
    }
    for (const mismatch of hashMismatches) {
      const effect = view.observedEffects.find((e) => e.id === mismatch.effectId);
      inputs.push(
        stripped({ kind: "observed_effect", effectId: mismatch.effectId }, effect?.evidence ?? [], [
          "source_observation",
        ]),
      );
    }
    for (const effectId of excludedEffectIds) {
      const effect = view.observedEffects.find((e) => e.id === effectId);
      inputs.push(stripped({ kind: "observed_effect", effectId }, effect?.evidence ?? [], ["source_observation"]));
    }
    inputs.push(presenceInput(matchingTransfers, scope));
  } else if (cleanNegative) {
    // (b) Clean contradiction: negatives decide, everything else loses its
    // voice (no supported-vs-contradicted crash, no proof laundering).
    inputs = [];
    if (networkNegative) {
      inputs.push({
        scope,
        applicability: "applicable",
        verdict: "contradicted",
        basis: ["deterministic_derivation"],
        evidence: networkEvidenceIds,
      });
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
    inputs.push(stripped(scope, presenceEvidence, ["deterministic_derivation"]));
    inputs.push(stripped({ kind: "dimension", dimension: "execution" }, execDim?.evidence ?? [], [
      "source_observation",
    ]));
  } else if (subjectUnbindableWithoutConflict) {
    // (c) Nothing binds this evidence to the claimed payment transaction
    // (and no citable disagreement exists): nothing may speak positively.
    inputs = [
      stripped(scope, networkEvidenceIds, ["deterministic_derivation"]),
      executionInput(),
    ];
    adapterWarnings.push(
      adapterWarning(
        X402_WARNING_CODES.subjectDoesNotMatchClaim,
        "the evidence cannot be bound to the claimed payment transaction; treating every layer as unproven",
      ),
    );
  } else {
    // (d) Positive path: network + execution + BOUND matching candidates +
    // presence. Unbound/mismatched/near-miss effects contribute NOTHING
    // here (they are listed in the report instead).
    inputs = [];
    inputs.push(
      networkEvidenceIds.length === 0
        ? stripped(scope, networkEvidenceIds, ["deterministic_derivation"])
        : {
            scope,
            applicability: "applicable",
            verdict: networkMatched ? ("supported" as const) : ("contradicted" as const),
            basis: ["deterministic_derivation"],
            evidence: networkEvidenceIds,
          },
    );
    inputs.push(executionInput());
    for (const observation of matchingTransfers) {
      inputs.push({
        scope: { kind: "observed_effect", effectId: observation.effectId },
        applicability: "applicable",
        verdict: "supported",
        basis: ["source_observation", "deterministic_derivation"],
        evidence: [...observation.evidenceIds],
      });
    }
    inputs.push(presenceInput(matchingTransfers, scope));
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
  if (candidates.length === 0 && hashMismatches.length === 0 && excludedCandidates.length === 0) {
    adapterWarnings.push(
      adapterWarning(
        X402_WARNING_CODES.noTransferObserved,
        `no bound Transfer-shaped log among ${view.observedEffects.length} observed effects (${unrelatedEffectCount} unrelated)`,
      ),
    );
  }
  if (unboundNoHashExcludedCount > 0) {
    adapterWarnings.push(
      adapterWarning(
        X402_WARNING_CODES.subjectDoesNotMatchClaim,
        `${unboundNoHashExcludedCount} transfer-shaped effect(s) carry neither their own transaction hash nor an exactly-correlated subject`,
      ),
    );
  }
  if (matchingTransfers.length > 1) {
    adapterWarnings.push(
      adapterWarning(
        X402_WARNING_CODES.duplicateMatchingTransfers,
        `${matchingTransfers.length} transfers each individually match the requirement; treat double-payment/replay risk separately`,
        presenceEvidence,
      ),
    );
  }
  // Standing non-claim surfacing: absent/inconclusive dimensions are
  // reported as absence — never fabricated into applicability.
  if (view.finality?.verdict !== "supported") {
    adapterWarnings.push(
      adapterWarning(
        X402_WARNING_CODES.finalityNotEstablished,
        "transaction finality is not established by this evidence",
      ),
    );
  }
  if (view.settlement?.verdict !== "supported") {
    adapterWarnings.push(
      adapterWarning(
        X402_WARNING_CODES.settlementNotEstablished,
        "on-chain settlement reliability beyond execution status is not established by this evidence",
      ),
    );
  }

  const warnings = mergeWarnings(composed.warnings, mergeWarnings([], adapterWarnings));
  const materialConflictIds = allConflicts.filter((c) => c.material).map((c) => c.id).sort();

  const verdict = composed.verdict;
  return {
    adapterProfile: X402_ADAPTER_PROFILE,
    protocol: "x402",
    x402Version: "2",
    scheme: "exact",
    requirementDigest,
    requirement: req,
    ...(expectedTxHash === undefined ? {} : { paymentTxHash: expectedTxHash }),
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
    claim:
      verdict === undefined ? X402_CLAIM_LABELS.undetermined : X402_CLAIM_LABELS[verdict],
    nonClaims: X402_NON_CLAIMS,
    matchingTransfers,
    excludedCandidates,
    transactionHashMismatches: hashMismatches,
    expectationConflictIds,
    candidateCount: candidates.length,
    unrelatedEffectCount,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

/**
 * PRIMARY v0.1 assessment: evaluate an x402 v2 exact-scheme payment CLAIM
 * against ONE frozen-core `NetworkEvidenceFragment` (generic network
 * resolver output).
 *
 * Fail-closed intake:
 *   - the claim is parsed/validated strictly (normalized terms + canonical
 *     payment transaction hash);
 *   - the fragment is FULLY validated through core before any field is read;
 *     a structurally invalid fragment throws (never degrades to a verdict).
 */
export function assessX402ExactPayment(
  claim: X402PaymentClaim | unknown,
  fragment: NetworkEvidenceFragment,
): X402PaymentEvaluation {
  const parsed = parseX402PaymentClaim(claim);
  validateNetworkEvidenceFragment(fragment);
  return assessInternal(parsed.requirement, parsed.paymentTxHash, {
    networkId: fragment.network.networkId,
    ...(fragment.network.chainId === undefined ? {} : { chainId: fragment.network.chainId }),
    subject: fragment.subject,
    execution: fragment.networkEvidence.execution,
    settlement: fragment.networkEvidence.settlement,
    finality: fragment.networkEvidence.finality,
    observedEffects: fragment.networkEvidence.observedEffects ?? [],
    evidence: fragment.evidence,
    conflicts: fragment.conflicts,
    warnings: fragment.warnings,
  });
}

/**
 * COMPATIBILITY wrapper: evaluate against a COMPLETE
 * `NetworkEvidenceResult` (the recovered prototype's input shape). It
 * validates the result through core, projects it into the fragment view and
 * delegates to THE ONE shared internal path used by
 * `assessX402ExactPayment`. The exact transaction identity is taken from
 * the result's own transaction subject; results without a usable
 * transaction-subject hash can never positively bind.
 */
export function evaluateX402ExactSettlement(
  requirement: X402ExactPaymentRequirement | unknown,
  result: NetworkEvidenceResult,
): X402PaymentEvaluation {
  // (1) Untrusted requirement intake — fail closed.
  const req = parseX402ExactPaymentRequirement(requirement);
  // (2) Generic artifact intake — full frozen-core validation first.
  validateNetworkEvidenceResult(result);

  const subject = result.subject;
  const expectedTxHash =
    subject.type === "transaction" && TX_HASH_PATTERN.test(subject.txId)
      ? subject.txId.toLowerCase()
      : undefined;

  return assessInternal(req, expectedTxHash, {
    networkId: result.network.networkId,
    ...(result.network.chainId === undefined ? {} : { chainId: result.network.chainId }),
    subject,
    execution: result.networkEvidence.execution,
    settlement: result.networkEvidence.settlement,
    finality: result.networkEvidence.finality,
    observedEffects: result.networkEvidence.observedEffects,
    evidence: result.evidence,
    conflicts: result.conflicts,
    warnings: result.warnings,
  });
}
