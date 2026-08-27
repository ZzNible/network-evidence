import { composeProposition, deepFreeze, digestCanonicalJson, nativeSourceContentDigest, RESOURCE_LIMITS, validateNetworkEvidenceFragment } from "@nec/core";
import type { Conflict, EvidenceDimension, EvidenceRef, NetworkEvidenceFragment, ObservedEffect, PropositionScope, Warning } from "@nec/core";

import type { SolanaTransactionAcquisition, SolanaConsistencyCheck } from "./acquire.js";
import { CAPTURE_DIGEST_DOMAIN, stableJsonKey } from "./rpc.js";

export const EVALUATION_PROFILE = "nec-resolver-solana-evaluation-v1";
export const TRANSFER_CHECKED_EFFECT_TYPE = "solana.token.transfer_checked";
const EXECUTION_SCOPE: PropositionScope = { kind: "dimension", dimension: "execution" };
const BINDING_SCOPE: PropositionScope = { kind: "dimension", dimension: "dataBinding" };
const FINALITY_SCOPE: PropositionScope = { kind: "dimension", dimension: "finality" };

function evidenceRefs(acquisition: SolanaTransactionAcquisition): EvidenceRef[] {
  return acquisition.captures.map((capture) => {
    const short = capture.rpcMethod.replace(/^get/, "").toLowerCase();
    const id = `solana-${short}-${capture.contentDigest.slice("sha256:".length, "sha256:".length + 16)}`;
    const ref: EvidenceRef = {
      id,
      sourceId: capture.sourceId,
      sourceType: capture.sourceType,
      ...(capture.independenceGroup === undefined ? {} : { independenceGroup: capture.independenceGroup }),
      locator: `${capture.rpcMethod}:${stableJsonKey(capture.rpcParams)}`,
      retrievedAt: capture.acquiredAt,
      contentDigest: capture.contentDigest,
      networkId: capture.networkId,
      ...(acquisition.transaction === null ? {} : { blockNumber: acquisition.transaction.slot, ...(acquisition.block ? { blockId: acquisition.block.blockhash } : {}) }),
      metadata: { rpcMethod: capture.rpcMethod, httpStatus: capture.httpStatus, captureProfile: capture.profile, digestDomain: CAPTURE_DIGEST_DOMAIN },
    };
    const bytes = new TextEncoder().encode(capture.resultText);
    if (bytes.length <= RESOURCE_LIMITS.MAX_NATIVE_SOURCE_PAYLOAD_BYTES) ref.nativeSource = { namespace: "nec.resolver-solana.rpc-result", mediaType: "application/json", encoding: "base64", payload: Buffer.from(bytes).toString("base64"), contentDigest: nativeSourceContentDigest(bytes) };
    return ref;
  });
}

function refFor(method: string, acquisition: SolanaTransactionAcquisition, refs: readonly EvidenceRef[]): string | undefined {
  const index = acquisition.captures.findIndex((capture) => capture.rpcMethod === method);
  return index < 0 ? undefined : refs[index]?.id;
}

function conflict(check: SolanaConsistencyCheck, scope: PropositionScope, evidence: readonly string[]): Conflict {
  return { id: `solana-conflict:${check.code.toLowerCase()}`, code: check.code, description: check.detail ?? `Solana acquisition consistency check ${check.code} failed.`, scope, evidence: [...new Set(evidence)], material: true };
}

export interface SolanaEvaluation {
  readonly profile: typeof EVALUATION_PROFILE;
  readonly fragment: NetworkEvidenceFragment;
}

export function evaluateSolanaTransaction(acquisition: SolanaTransactionAcquisition): SolanaEvaluation {
  const refs = evidenceRefs(acquisition);
  const txRef = refFor("getTransaction", acquisition, refs);
  const statusRef = refFor("getSignatureStatuses", acquisition, refs);
  const blockRef = refFor("getBlock", acquisition, refs);
  const genesisRef = refFor("getGenesisHash", acquisition, refs);
  const conflicts: Conflict[] = [];
  for (const check of acquisition.checks) {
    if (check.passed) continue;
    const scope = check.code.includes("SIGNATURE") || check.code.includes("STATUS_SLOT") ? BINDING_SCOPE : check.code.includes("ERROR") ? EXECUTION_SCOPE : FINALITY_SCOPE;
    conflicts.push(conflict(check, scope, [txRef, statusRef, blockRef].filter((id): id is string => id !== undefined)));
  }
  const tx = acquisition.transaction;
  const transactionEvidence = txRef === undefined ? [] : [txRef];
  const executionBase = tx === null
    ? { scope: EXECUTION_SCOPE, applicability: "applicable" as const, basis: ["source_observation" as const], evidence: transactionEvidence }
    : { scope: EXECUTION_SCOPE, applicability: "applicable" as const, verdict: tx.successful ? "supported" as const : "contradicted" as const, basis: ["source_observation" as const], evidence: transactionEvidence };
  const bindingPassed = tx !== null && acquisition.checks.filter((c) => c.code === "TRANSACTION_SIGNATURE_MATCHES_SUBJECT" || c.code === "STATUS_SLOT_MATCHES_TRANSACTION").every((c) => c.passed);
  const bindingBase = { scope: BINDING_SCOPE, applicability: "applicable" as const, ...(bindingPassed ? { verdict: "supported" as const } : {}), basis: ["source_observation" as const, "deterministic_derivation" as const], evidence: [genesisRef, txRef, statusRef].filter((id): id is string => id !== undefined) };
  const finalized = tx !== null && acquisition.signatureStatus.value?.confirmationStatus === "finalized" && acquisition.block !== null && acquisition.block !== undefined && acquisition.consistent;
  const finalityBase = { scope: FINALITY_SCOPE, applicability: "applicable" as const, ...(finalized ? { verdict: "supported" as const } : {}), basis: ["source_observation" as const], evidence: [txRef, statusRef, blockRef].filter((id): id is string => id !== undefined) };
  const executionComposed = composeProposition(executionBase, { conflicts, evidenceRefs: refs });
  const bindingComposed = composeProposition(bindingBase, { conflicts, evidenceRefs: refs });
  const finalityComposed = composeProposition(finalityBase, { conflicts, evidenceRefs: refs });
  const execution: EvidenceDimension = { applicability: executionComposed.applicability, ...(executionComposed.verdict === undefined ? {} : { verdict: executionComposed.verdict }), basis: [...executionComposed.basis], evidence: [...executionComposed.evidence] };
  const dataBinding: EvidenceDimension = { applicability: bindingComposed.applicability, ...(bindingComposed.verdict === undefined ? {} : { verdict: bindingComposed.verdict }), basis: [...bindingComposed.basis], evidence: [...bindingComposed.evidence], metadata: { instructionTraceComplete: tx?.instructionTraceComplete === true, signature: acquisition.subject.signature, ...(tx === null ? {} : { slot: tx.slot.toString() }) } };
  const finality: EvidenceDimension = { applicability: finalityComposed.applicability, ...(finalityComposed.verdict === undefined ? {} : { verdict: finalityComposed.verdict }), basis: [...finalityComposed.basis], evidence: [...finalityComposed.evidence], metadata: { basis: "source_observation", commitment: "finalized", economicIrreversibilityEstablished: false } };

  const effects: ObservedEffect[] = [];
  if (tx?.successful === true && bindingPassed && txRef !== undefined) {
    for (const transfer of tx.transferChecked) {
      const fields = { tokenProgram: transfer.tokenProgram, mint: transfer.mint, source: transfer.source, destination: transfer.destination, authority: transfer.authority, amount: transfer.amount, decimals: transfer.decimals, location: transfer.location, transactionSignature: acquisition.subject.signature };
      const digest = digestCanonicalJson("resolver-solana-transfer-checked-v1", fields);
      effects.push({ id: `solana-transfer-checked-${digest.slice("sha256:".length, "sha256:".length + 16)}`, type: TRANSFER_CHECKED_EFFECT_TYPE, fields, basis: ["source_observation", "deterministic_derivation"], evidence: [txRef] });
    }
  }
  const warnings: Warning[] = [{ code: "SOLANA_SOURCE_OBSERVATION_LIMIT", message: "Finalized commitment is a source observation, not independent cryptographic verification or economic irreversibility." }, { code: "SOLANA_SETTLEMENT_NOT_EVALUATED", message: "Generic Solana acquisition does not evaluate protocol settlement." }];
  if (tx === null) warnings.push({ code: "SOLANA_TRANSACTION_HISTORY_UNAVAILABLE", message: "getTransaction returned null; the transaction may be unknown, unavailable, or pruned at this source.", ...(txRef === undefined ? {} : { evidence: [txRef] }) });
  if (acquisition.signatureStatus.value === null) warnings.push({ code: "SOLANA_SIGNATURE_STATUS_UNAVAILABLE", message: "getSignatureStatuses returned a null entry.", ...(statusRef === undefined ? {} : { evidence: [statusRef] }) });
  const block = acquisition.block;
  const timestamp = block?.blockTime === null || block?.blockTime === undefined ? undefined : new Date(block.blockTime * 1000).toISOString();
  const fragment: NetworkEvidenceFragment = {
    network: { networkId: acquisition.source.networkId, genesisId: acquisition.genesisHash, observedAt: tx === null ? {} : { blockNumber: tx.slot, ...(block ? { blockId: block.blockhash } : {}), ...(timestamp === undefined ? {} : { timestamp }) } },
    subject: { type: "transaction", networkId: acquisition.source.networkId, txId: acquisition.subject.signature },
    networkEvidence: { execution, observedEffects: effects, dataBinding, finality },
    evidence: refs,
    conflicts,
    warnings,
  };
  validateNetworkEvidenceFragment(fragment);
  return deepFreeze({ profile: EVALUATION_PROFILE, fragment });
}
