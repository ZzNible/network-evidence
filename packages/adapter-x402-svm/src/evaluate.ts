import { composeVerdict, deepFreeze, samePropositionScope, validateNetworkEvidenceFragment } from "@nec/core";
import type { Applicability, Conflict, EvidenceBasis, EvidenceDimension, EvidenceId, EvidenceVerdict, NetworkEvidenceFragment, ObservedEffect, PropositionScope, Warning } from "@nec/core";
import { parsePublicKey, parseSignature, SPL_TOKEN_PROGRAM, TOKEN_2022_PROGRAM, TRANSFER_CHECKED_EFFECT_TYPE } from "@nec/resolver-solana";

import { parseX402SvmPaymentClaim } from "./claim.js";
import type { X402SvmPaymentClaim } from "./claim.js";
import { deriveAssociatedTokenAddress } from "./pda.js";
import { computeX402SvmRequirementDigest } from "./requirement.js";
import type { X402SvmExactRequirement } from "./requirement.js";

export const X402_SVM_ADAPTER_PROFILE = "nec-adapter-x402-svm-v0.1";
export const X402_SVM_PROPOSITION_NAMESPACE = "x402.svm.adapter";
export const X402_SVM_NON_CLAIMS = Object.freeze([
  "FACILITATOR_VERIFY_OUTCOME_NOT_ESTABLISHED",
  "FACILITATOR_SETTLE_OUTCOME_NOT_ESTABLISHED",
  "PROTOCOL_SUCCESS_CLAIM_NOT_ESTABLISHED",
  "SETTLEMENT_RESPONSE_NOT_FINALITY",
  "SPONSOR_ACCEPTANCE_POLICY_NOT_NETWORK_FACT",
  "FEE_PAYER_ISOLATION_NOT_A_PAYMENT_OUTCOME",
  "ECONOMIC_IRREVERSIBILITY_NOT_ESTABLISHED",
]);

export const X402_SVM_CLAIM_LABELS: Readonly<Record<EvidenceVerdict, string>> = Object.freeze({
  supported: "ONE_OBSERVED_TRANSFER_CHECKED_MATCHES_EXPECTED_X402_SVM_PAYMENT_OUTCOME",
  contradicted: "COMPLETE_NETWORK_EVIDENCE_CONTRADICTS_EXPECTED_X402_SVM_PAYMENT_OUTCOME",
  insufficient: "INSUFFICIENT_EVIDENCE_FOR_EXPECTED_X402_SVM_PAYMENT_OUTCOME",
  ambiguous: "MATERIAL_CONFLICT_PREVENTS_DETERMINISTIC_X402_SVM_PAYMENT_CONCLUSION",
});

export interface SvmTransferObservation {
  readonly effectId: string;
  readonly tokenProgram: string;
  readonly mint: string;
  readonly source: string;
  readonly destination: string;
  readonly authority: string;
  readonly amount: string;
  readonly decimals: number;
  readonly location: Record<string, unknown>;
  readonly transactionSignature: string;
  readonly evidenceIds: readonly string[];
}

export interface ExcludedSvmCandidate { readonly effectId: string; readonly detail: string }

export interface X402SvmAssessmentContext {
  readonly correlationStrength?: "STRONG_BUT_ONE_FIELD_MISSING";
  readonly historicalPaymentRequirementsPublic?: boolean;
  readonly historicalPaymentPayloadPublic?: boolean;
  readonly historicalSettlementResponsePublic?: boolean;
}

export interface X402SvmPaymentEvaluation {
  readonly adapterProfile: typeof X402_SVM_ADAPTER_PROFILE;
  readonly requirementDigest: string;
  readonly requirement: X402SvmExactRequirement;
  readonly paymentSignature: string;
  readonly subjectMatchesClaim: boolean;
  readonly outcome: { readonly applicability: Applicability; readonly verdict?: EvidenceVerdict; readonly basis: readonly EvidenceBasis[]; readonly evidence: readonly EvidenceId[]; readonly materialConflictIds: readonly string[] };
  readonly execution: { readonly providedByFragment: boolean; readonly applicability: Applicability; readonly verdict?: EvidenceVerdict };
  readonly networkFinality: { readonly providedByFragment: boolean; readonly applicability: Applicability; readonly verdict?: EvidenceVerdict; readonly basis: readonly EvidenceBasis[] };
  readonly settlementInferred: false;
  readonly claim: string;
  readonly nonClaims: readonly string[];
  readonly matchingTransfers: readonly SvmTransferObservation[];
  readonly qualifyingCandidateCount: number;
  readonly inspectedTransferCheckedCount: number;
  readonly excludedCandidates: readonly ExcludedSvmCandidate[];
  readonly conflicts: readonly Conflict[];
  readonly warnings: readonly Warning[];
  readonly correlation?: { readonly strength: "STRONG_BUT_ONE_FIELD_MISSING"; readonly historicalPaymentRequirementsPublic: boolean; readonly historicalPaymentPayloadPublic: boolean; readonly historicalSettlementResponsePublic: boolean };
}

const DECIMAL = /^(0|[1-9][0-9]*)$/;

function effectRecord(effect: ObservedEffect): { observation?: SvmTransferObservation; excluded?: ExcludedSvmCandidate; unrelated?: true } {
  if (effect.type !== TRANSFER_CHECKED_EFFECT_TYPE) return { unrelated: true };
  const f = effect.fields;
  try {
    const tokenProgram = f.tokenProgram;
    if (tokenProgram !== SPL_TOKEN_PROGRAM && tokenProgram !== TOKEN_2022_PROGRAM) throw new Error("unsupported token program");
    const mint = parsePublicKey(f.mint, "mint");
    const source = parsePublicKey(f.source, "source");
    const destination = parsePublicKey(f.destination, "destination");
    const authority = parsePublicKey(f.authority, "authority");
    if (typeof f.amount !== "string" || !DECIMAL.test(f.amount)) throw new Error("amount is not canonical decimal text");
    if (typeof f.decimals !== "number" || !Number.isSafeInteger(f.decimals) || f.decimals < 0 || f.decimals > 255) throw new Error("decimals is invalid");
    if (f.location === null || typeof f.location !== "object" || Array.isArray(f.location)) throw new Error("instruction location is invalid");
    const location = f.location as Record<string, unknown>;
    if (location.kind === "topLevel") {
      if (!Number.isSafeInteger(location.topLevelIndex) || (location.topLevelIndex as number) < 0) throw new Error("top-level instruction location is invalid");
    } else if (location.kind === "inner") {
      if (!Number.isSafeInteger(location.parentTopLevelIndex) || (location.parentTopLevelIndex as number) < 0 || !Number.isSafeInteger(location.innerIndex) || (location.innerIndex as number) < 0) throw new Error("inner instruction location is invalid");
    } else throw new Error("instruction location kind is invalid");
    const transactionSignature = parseSignature(f.transactionSignature, "transactionSignature");
    return { observation: { effectId: effect.id, tokenProgram, mint, source, destination, authority, amount: f.amount, decimals: f.decimals, location: { ...location }, transactionSignature, evidenceIds: [...effect.evidence] } };
  } catch (error) {
    return { excluded: { effectId: effect.id, detail: error instanceof Error ? error.message : "malformed TransferChecked effect" } };
  }
}

function locationKey(observation: SvmTransferObservation): string {
  const l = observation.location;
  return l.kind === "topLevel"
    ? `0:${String(l.topLevelIndex).padStart(10, "0")}:${observation.effectId}`
    : `1:${String(l.parentTopLevelIndex).padStart(10, "0")}:${String(l.innerIndex).padStart(10, "0")}:${observation.effectId}`;
}

function qualifying(observation: SvmTransferObservation, requirement: X402SvmExactRequirement): boolean {
  if (observation.mint !== requirement.asset) return false;
  if (observation.destination !== deriveAssociatedTokenAddress(requirement.payTo, requirement.asset, observation.tokenProgram)) return false;
  return BigInt(observation.amount) >= BigInt(requirement.amount);
}

function dimensionEcho(dimension: EvidenceDimension | undefined): { providedByFragment: boolean; applicability: Applicability; verdict?: EvidenceVerdict } {
  return dimension === undefined ? { providedByFragment: false, applicability: "unknown" } : { providedByFragment: true, applicability: dimension.applicability, ...(dimension.verdict === undefined ? {} : { verdict: dimension.verdict }) };
}
function paymentRelevantFragmentConflicts(
  fragment: NetworkEvidenceFragment,
  scope: PropositionScope,
  inspectedEffectIds: readonly string[],
): Conflict[] {
  return fragment.conflicts.filter((candidate) => {
    if (!candidate.material) return false;
    if (candidate.scope.kind === "result") return true;
    if (candidate.scope.kind === "dimension") return candidate.scope.dimension === "execution" || candidate.scope.dimension === "dataBinding";
    if (candidate.scope.kind === "observed_effect") return inspectedEffectIds.includes(candidate.scope.effectId);
    return samePropositionScope(candidate.scope, scope);
  }).sort((a, b) => a.id.localeCompare(b.id));
}

export function assessX402SvmExactPayment(fragment: NetworkEvidenceFragment, claimValue: X402SvmPaymentClaim | unknown, context: X402SvmAssessmentContext = {}): X402SvmPaymentEvaluation {
  validateNetworkEvidenceFragment(fragment);
  const claim = parseX402SvmPaymentClaim(claimValue);
  const requirement = claim.requirement;
  const requirementDigest = computeX402SvmRequirementDigest(requirement);
  const scope: PropositionScope = { kind: "custom", namespace: X402_SVM_PROPOSITION_NAMESPACE, id: requirementDigest };
  const subjectMatchesClaim = fragment.subject.type === "transaction" && fragment.subject.networkId === requirement.network && fragment.subject.txId === claim.paymentSignature && fragment.network.networkId === requirement.network;
  const adapterConflicts: Conflict[] = [];
  const warnings: Warning[] = [...fragment.warnings];
  const observations: SvmTransferObservation[] = [];
  const excludedCandidates: ExcludedSvmCandidate[] = [];
  for (const effect of fragment.networkEvidence.observedEffects ?? []) {
    const interpreted = effectRecord(effect);
    if (interpreted.observation) observations.push(interpreted.observation);
    if (interpreted.excluded) excludedCandidates.push(interpreted.excluded);
  }
  observations.sort((a, b) => locationKey(a).localeCompare(locationKey(b)));
  excludedCandidates.sort((a, b) => a.effectId.localeCompare(b.effectId));
  const bound = observations.filter((observation) => observation.transactionSignature === claim.paymentSignature);
  const mismatched = observations.filter((observation) => observation.transactionSignature !== claim.paymentSignature);
  for (const observation of mismatched) adapterConflicts.push({ id: `x402-svm-conflict:signature:${observation.effectId}`, code: "X402_SVM_EFFECT_SIGNATURE_MISMATCH", description: "TransferChecked effect is bound to a different transaction signature.", scope, evidence: [...observation.evidenceIds], material: true });
  for (const candidate of excludedCandidates) {
    const effect = fragment.networkEvidence.observedEffects?.find((entry) => entry.id === candidate.effectId);
    if (effect && effect.evidence.length > 0) adapterConflicts.push({ id: `x402-svm-conflict:malformed:${candidate.effectId}`, code: "X402_SVM_MALFORMED_RELEVANT_EFFECT", description: "A relevant TransferChecked effect is malformed and prevents a clean payment conclusion.", scope, evidence: [...effect.evidence], material: true });
  }
  if (!subjectMatchesClaim && fragment.evidence.length > 0) adapterConflicts.push({ id: "x402-svm-conflict:subject", code: "X402_SVM_SUBJECT_MISMATCH", description: "Evidence subject/network does not match the claimed x402 SVM payment transaction.", scope, evidence: fragment.evidence.map((ref) => ref.id), material: true });
  const matches = bound.filter((observation) => qualifying(observation, requirement));
  if (matches.length > 1) adapterConflicts.push({ id: "x402-svm-conflict:multiple-qualifying", code: "X402_SVM_MULTIPLE_QUALIFYING_TRANSFERS", description: "More than one qualifying TransferChecked was directly observed.", scope, evidence: [...new Set(matches.flatMap((match) => match.evidenceIds))], material: true, metadata: { candidateEffectIds: matches.map((match) => match.effectId) } });
  if (excludedCandidates.length > 0) warnings.push({ code: "X402_SVM_MALFORMED_TRANSFER_CHECKED_EXCLUDED", message: "Malformed relevant TransferChecked effects were excluded and cannot support payment.", evidence: [...new Set(excludedCandidates.flatMap((candidate) => fragment.networkEvidence.observedEffects?.find((effect) => effect.id === candidate.effectId)?.evidence ?? []))] });
  const executionDimension = fragment.networkEvidence.execution;
  const dataBinding = fragment.networkEvidence.dataBinding;
  const traceComplete = dataBinding?.verdict === "supported" && dataBinding.metadata?.instructionTraceComplete === true;
  const inspectedEffectIds = [...new Set([...bound.map((observation) => observation.effectId), ...excludedCandidates.map((candidate) => candidate.effectId)])];
  const relevantFragmentConflicts = paymentRelevantFragmentConflicts(fragment, scope, inspectedEffectIds);
  const allConflicts = [...relevantFragmentConflicts, ...adapterConflicts].sort((a, b) => a.id.localeCompare(b.id));
  const inputs: Array<{ scope: PropositionScope; applicability: Applicability; verdict?: EvidenceVerdict; basis: EvidenceBasis[]; evidence: string[] }> = [];
  const cleanNegative = allConflicts.length === 0 && (
    executionDimension?.verdict === "contradicted" ||
    (subjectMatchesClaim && matches.length === 0 && traceComplete && executionDimension?.verdict === "supported")
  );
  if (cleanNegative) {
    if (executionDimension?.verdict === "contradicted") inputs.push({ scope: { kind: "dimension", dimension: "execution" }, applicability: "applicable", verdict: "contradicted", basis: [...executionDimension.basis], evidence: [...executionDimension.evidence] });
    if (subjectMatchesClaim && matches.length === 0 && traceComplete && executionDimension?.verdict === "supported") inputs.push({ scope, applicability: "applicable", verdict: "contradicted", basis: ["source_observation", "deterministic_derivation"], evidence: [...new Set([...(executionDimension.evidence), ...(dataBinding?.evidence ?? [])])] });
    inputs.push({ scope: { kind: "dimension", dimension: "dataBinding" }, applicability: "applicable", basis: ["deterministic_derivation"], evidence: [] });
    for (const candidate of bound) inputs.push({ scope: { kind: "observed_effect", effectId: candidate.effectId }, applicability: "applicable", basis: ["source_observation"], evidence: [...candidate.evidenceIds] });
  } else {
    if (subjectMatchesClaim) {
      if (matches.length === 1 && traceComplete && executionDimension?.verdict === "supported") inputs.push({ scope, applicability: "applicable", verdict: "supported", basis: ["source_observation", "deterministic_derivation"], evidence: [...matches[0]!.evidenceIds] });
      else if (matches.length === 0 && traceComplete && executionDimension?.verdict === "supported") inputs.push({ scope, applicability: "applicable", verdict: "contradicted", basis: ["source_observation", "deterministic_derivation"], evidence: [...new Set([...(executionDimension.evidence), ...(dataBinding?.evidence ?? [])])] });
      else inputs.push({ scope, applicability: "applicable", basis: ["deterministic_derivation"], evidence: [] });
    } else inputs.push({ scope, applicability: "applicable", basis: ["deterministic_derivation"], evidence: [] });
    inputs.push(traceComplete
      ? { scope: { kind: "dimension", dimension: "dataBinding" }, applicability: "applicable", verdict: "supported", basis: [...(dataBinding?.basis ?? [])], evidence: [...(dataBinding?.evidence ?? [])] }
      : { scope: { kind: "dimension", dimension: "dataBinding" }, applicability: "applicable", basis: ["deterministic_derivation"], evidence: [] });
    for (const candidate of bound) inputs.push(matches.includes(candidate)
      ? { scope: { kind: "observed_effect", effectId: candidate.effectId }, applicability: "applicable", verdict: "supported", basis: ["source_observation", "deterministic_derivation"], evidence: [...candidate.evidenceIds] }
      : { scope: { kind: "observed_effect", effectId: candidate.effectId }, applicability: "applicable", basis: ["source_observation"], evidence: [...candidate.evidenceIds] });
    if (executionDimension?.verdict === "contradicted") inputs.push({ scope: { kind: "dimension", dimension: "execution" }, applicability: "applicable", verdict: "contradicted", basis: [...executionDimension.basis], evidence: [...executionDimension.evidence] });
    else if (executionDimension !== undefined && executionDimension.verdict !== "supported") inputs.push({ scope: { kind: "dimension", dimension: "execution" }, applicability: "applicable", basis: [...executionDimension.basis], evidence: [...executionDimension.evidence] });
  }
  if (!traceComplete) warnings.push({ code: "X402_SVM_INSTRUCTION_TRACE_INCOMPLETE", message: "The CPI instruction trace is unavailable, so exactly-one payment semantics cannot be established." });
  if (executionDimension === undefined || executionDimension.verdict !== "supported") warnings.push({ code: "X402_SVM_SUCCESSFUL_EXECUTION_NOT_ESTABLISHED", message: "A matching-looking instruction cannot establish payment without successful execution evidence." });
  if (matches.length === 0) warnings.push({ code: "X402_SVM_NO_QUALIFYING_TRANSFER", message: "No individual TransferChecked satisfied token program, mint, canonical destination ATA, and amount >= required." });
  if (matches.length > 1) warnings.push({ code: "X402_SVM_EXACTLY_ONE_VIOLATED", message: "Multiple qualifying transfers fail the exactly-one rule; candidates are exposed deterministically." });
  const outcomeDimension = composeVerdict(inputs, { conflicts: allConflicts, evidenceRefs: fragment.evidence });
  const verdict = outcomeDimension.verdict ?? "insufficient";
  const finalityDimension = fragment.networkEvidence.finality;
  const finalityReport = finalityDimension === undefined ? undefined : composeVerdict([{
    scope: { kind: "dimension", dimension: "finality" },
    applicability: finalityDimension.applicability,
    ...(finalityDimension.verdict === undefined ? {} : { verdict: finalityDimension.verdict }),
    basis: [...finalityDimension.basis],
    evidence: [...finalityDimension.evidence],
  }], { conflicts: fragment.conflicts, evidenceRefs: fragment.evidence });
  const evaluation: X402SvmPaymentEvaluation = {
    adapterProfile: X402_SVM_ADAPTER_PROFILE,
    requirementDigest,
    requirement,
    paymentSignature: claim.paymentSignature,
    subjectMatchesClaim,
    outcome: { applicability: outcomeDimension.applicability, ...(outcomeDimension.verdict === undefined ? {} : { verdict: outcomeDimension.verdict }), basis: outcomeDimension.basis, evidence: outcomeDimension.evidence, materialConflictIds: allConflicts.filter((candidate) => candidate.material).map((candidate) => candidate.id).sort() },
    execution: dimensionEcho(executionDimension),
    networkFinality: finalityReport === undefined ? { ...dimensionEcho(finalityDimension), basis: [] } : { providedByFragment: true, applicability: finalityReport.applicability, ...(finalityReport.verdict === undefined ? {} : { verdict: finalityReport.verdict }), basis: finalityReport.basis },
    settlementInferred: false,
    claim: X402_SVM_CLAIM_LABELS[verdict],
    nonClaims: X402_SVM_NON_CLAIMS,
    matchingTransfers: matches,
    qualifyingCandidateCount: matches.length,
    inspectedTransferCheckedCount: observations.length + excludedCandidates.length,
    excludedCandidates,
    conflicts: [...fragment.conflicts, ...adapterConflicts].sort((a, b) => a.id.localeCompare(b.id)),
    warnings: [...new Map(warnings.map((warning) => [`${warning.code}:${warning.message}`, warning])).values()].sort((a, b) => a.code.localeCompare(b.code)),
    ...(context.correlationStrength === undefined ? {} : { correlation: { strength: context.correlationStrength, historicalPaymentRequirementsPublic: context.historicalPaymentRequirementsPublic === true, historicalPaymentPayloadPublic: context.historicalPaymentPayloadPublic === true, historicalSettlementResponsePublic: context.historicalSettlementResponsePublic === true } }),
  };
  return deepFreeze(evaluation);
}
