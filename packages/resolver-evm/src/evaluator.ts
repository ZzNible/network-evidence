/**
 * PURE single-source proposition evaluation over ONE
 * `EvmTransactionAcquisition`.
 *
 * Pipeline (no network, no clock, no randomness, no filesystem):
 *
 *   EvmTransactionAcquisition
 *     -> per-dimension base contributions (observation-level verdicts)
 *     -> THE core normative composer (`composeProposition`)
 *     -> EvidenceDimension / ObservedEffect / Conflict
 *     -> NetworkEvidenceFragment (+ resolver-local evaluation record)
 *
 * SEMANTIC RULES ENFORCED HERE (never collapsed):
 *
 *   - null receipt            != contradiction  (=> applicable+insufficient)
 *   - evidence not acquired   != contradiction  (=> applicability "unknown")
 *   - settlement / finality   NOT EVALUATED     (a generic single-source EVM
 *                               acquisition answers neither question, so both
 *                               dimensions are OMITTED from the partial
 *                               fragment; one explicit deterministic warning
 *                               makes the limitation inspectable. Later
 *                               policy-aware composition may turn a required
 *                               but unevaluated dimension into
 *                               insufficient/unknown — this evaluator never
 *                               pretends it evaluated the question.)
 *   - block observation       != finality       (anchor coherence only)
 *   - provider self-coherence != cryptographic proof (basis stays
 *                               source_observation/deterministic_derivation)
 *   - one source              != consensus      (single-source provenance only)
 *   - removed log             != valid observed effect (omitted + conflict)
 *
 * STRUCTURAL INCOHERENCE: failed consistency checks from
 * `acquisition.checks` become explicit material Conflicts with precise
 * proposition scopes; THE core composer then forces the affected dimension
 * to "ambiguous" — a clean supported/contradicted verdict can never survive
 * a genuine material inconsistency.
 *
 * Conflict scope map (precise propositions, never EvidenceId-derived):
 *
 *   RECEIPT_TX_HASH_MATCHES_SUBJECT=false  -> dimension dataBinding
 *     (the receipt proves nothing about THIS subject, so the execution
 *      contribution is also downgraded to insufficient at input level)
 *   TRANSACTION_COHERENT_WITH_RECEIPT=false -> dimension dataBinding
 *   RECEIPT_BLOCK_HASH_MATCHES_BLOCK=false  -> dimension execution
 *   RECEIPT_BLOCK_NUMBER_MATCHES_BLOCK=false -> dimension execution
 *   LOG_* failures (per log)                -> dimension execution
 *
 * No Conflict is ever invented for a null receipt, an RPC failure or
 * evidence that was simply not acquired.
 */

import { composeProposition } from "@nec/core";
import { deepFreeze, validateNetworkEvidenceFragment } from "@nec/core";
import type {
  Conflict,
  EvidenceBasis,
  EvidenceDimension,
  EvidenceId,
  EvidenceRef,
  EvidenceVerdict,
  Applicability,
  NetworkEvidenceFragment,
  NetworkId,
  ObservedEffect,
  PropositionScope,
  SubjectRef,
  Warning,
} from "@nec/core";

import type { EvmTransactionAcquisition } from "./acquire.js";
import type { EvmConsistencyCheck, EvmConsistencyCheckCode } from "./checks.js";
import { buildEvidenceRefs, toSubjectRef } from "./evidence.js";
import { NecResolverEvmError } from "./errors.js";
import {
  buildCheckConflict,
  buildEvaluationFingerprint,
  buildLogObservedEffect,
  captureEvidenceIndex,
  decimalString,
} from "./fragment.js";

export const EVALUATION_PROFILE = "nec-resolver-evm-evaluation-v1";

/** Explicit proposition text evaluated for each core evidence dimension. */
export const EXECUTION_PROPOSITION =
  "The subject transaction was executed on-chain and completed with a successful status, as observed by this single source.";
export const DATA_BINDING_PROPOSITION =
  "The acquired receipt binds to the requested subject transaction id.";

/**
 * THE one deterministic limitation warning: settlement and finality are
 * never evaluated here, in any scenario, so the partial fragment omits both
 * dimensions entirely.
 */
export const DIMENSIONS_NOT_EVALUATED_WARNING: Warning = {
  code: "EVM_DIMENSIONS_NOT_EVALUATED",
  message:
    "Generic single-source EVM acquisition does not evaluate settlement or network-specific finality.",
  metadata: { dimensions: ["finality", "settlement"] },
};

const EXECUTION_SCOPE: PropositionScope = { kind: "dimension", dimension: "execution" };
const DATA_BINDING_SCOPE: PropositionScope = { kind: "dimension", dimension: "dataBinding" };

type CoreDimensionName = "execution" | "dataBinding";

/** One evaluated core dimension plus the exact proposition it answers. */
export interface EvaluatedDimension {
  readonly name: CoreDimensionName;
  /** Precise proposition scope carried by any conflicts affecting it. */
  readonly scope: PropositionScope;
  readonly proposition: string;
  readonly dimension: EvidenceDimension;
}

/** Resolver-local evaluation result: fragment PLUS explicit propositions. */
export interface EvmEvaluation {
  readonly profile: typeof EVALUATION_PROFILE;
  readonly networkId: NetworkId;
  readonly subject: SubjectRef;
  /**
   * Only dimensions actually evaluated by this generic resolver. Settlement
   * and finality are deliberately absent — never projected as
   * applicable+insufficient placeholders (see the module header).
   */
  readonly dimensions: {
    readonly execution: EvaluatedDimension;
    readonly dataBinding: EvaluatedDimension;
  };
  readonly observedEffects: readonly ObservedEffect[];
  readonly conflicts: readonly Conflict[];
  readonly warnings: readonly Warning[];
  /** Clean core fragment projection of exactly this evaluation. */
  readonly fragment: NetworkEvidenceFragment;
}

interface DimensionInput {
  readonly scope: PropositionScope;
  readonly applicability: Applicability;
  readonly verdict?: EvidenceVerdict;
  readonly basis?: readonly EvidenceBasis[];
  readonly evidence: readonly EvidenceId[];
}

function checkOfCode(
  checks: readonly EvmConsistencyCheck[],
  code: EvmConsistencyCheckCode,
): EvmConsistencyCheck | undefined {
  return checks.find((c) => c.code === code);
}

/**
 * Evaluate ONE acquisition into propositions + fragment. Deterministic:
 * the same acquisition yields a deep-equal evaluation, always.
 */
export function evaluateTransactionAcquisition(
  acquisition: EvmTransactionAcquisition,
): EvmEvaluation {
  const refs: EvidenceRef[] = buildEvidenceRefs(acquisition);
  const citations = captureEvidenceIndex(acquisition, refs);

  const warnings: Warning[] = [
    // Unconditional, in every scenario: the generic single-source resolver
    // never evaluates settlement or finality, so both stay omitted from the
    // partial fragment (never applicable+insufficient placeholders).
    DIMENSIONS_NOT_EVALUATED_WARNING,
  ];
  const conflicts: Conflict[] = [];
  // Per-log coherence in receipt.logs order; empty when no receipt.
  const logCoherent: boolean[] = [];

  // --- degenerate guard: nothing acquired at all ---------------------------
  // No captures => no grounded proposition => applicability "unknown"
  // everywhere (never a verdict, never a conflict).
  if (acquisition.captures.length === 0) {
    warnings.push({
      code: "EVM_NO_EVIDENCE_ACQUIRED",
      message: "The acquisition carries no captures; no proposition can be evaluated.",
    });
  }

  const receipt = acquisition.receipt;
  const receiptId = citations.receipt;
  const blockId = citations.block;
  const transactionId = citations.transaction;

  // --- structural incoherence -> explicit scoped conflicts -----------------
  if (receipt !== null && receipt !== undefined) {
    const txMismatch = checkOfCode(acquisition.checks, "RECEIPT_TX_HASH_MATCHES_SUBJECT");
    if (txMismatch && !txMismatch.passed) {
      conflicts.push(
        buildCheckConflict({
          check: txMismatch,
          qualifier: "subject",
          scope: DATA_BINDING_SCOPE,
          material: true,
          evidenceIds: [receiptId as string],
          description:
            "The acquired receipt's transactionHash does not match the requested subject; the receipt does not bind to this subject.",
        }),
      );
    }

    const blockHashCheck = checkOfCode(acquisition.checks, "RECEIPT_BLOCK_HASH_MATCHES_BLOCK");
    if (blockHashCheck && !blockHashCheck.passed) {
      conflicts.push(
        buildCheckConflict({
          check: blockHashCheck,
          qualifier: "block-hash",
          scope: EXECUTION_SCOPE,
          material: true,
          evidenceIds: blockId === undefined ? [receiptId as string] : [receiptId as string, blockId],
          description:
            "The receipt's blockHash does not cohere with this source's block observation for the referenced block (including when the source returned no such block).",
        }),
      );
    }

    const blockNumberCheck = checkOfCode(acquisition.checks, "RECEIPT_BLOCK_NUMBER_MATCHES_BLOCK");
    if (blockNumberCheck && !blockNumberCheck.passed) {
      conflicts.push(
        buildCheckConflict({
          check: blockNumberCheck,
          qualifier: "block-number",
          scope: EXECUTION_SCOPE,
          material: true,
          evidenceIds: blockId === undefined ? [receiptId as string] : [receiptId as string, blockId],
          description:
            "The receipt's blockNumber does not match the number of the block observed for the referenced block hash.",
        }),
      );
    }

    const txCoherence = checkOfCode(acquisition.checks, "TRANSACTION_COHERENT_WITH_RECEIPT");
    if (txCoherence && !txCoherence.passed) {
      conflicts.push(
        buildCheckConflict({
          check: txCoherence,
          qualifier: "transaction",
          scope: DATA_BINDING_SCOPE,
          material: true,
          evidenceIds:
            transactionId === undefined ? [receiptId as string] : [receiptId as string, transactionId],
          description:
            "The acquired transaction observation is not coherent with the acquired receipt (hash, block anchor or index disagree).",
        }),
      );
    }

    // Per-log checks are emitted by the acquisition pipeline in
    // receipt.logs order, exactly three per log; attribute failures back to
    // their log position deterministically.
    const logChecks = acquisition.checks.filter((c) => c.code.startsWith("LOG_"));
    if (logChecks.length !== receipt.logs.length * 3) {
      throw new NecResolverEvmError(
        "EVM_MALFORMED_RESPONSE",
        `acquisition checks carry ${logChecks.length} LOG_ entries for ${receipt.logs.length} logs; failing closed`,
      );
    }
    const omittedLogIndexes: string[] = [];
    for (let i = 0; i < receipt.logs.length; i++) {
      const triple = logChecks.slice(i * 3, i * 3 + 3) as EvmConsistencyCheck[];
      const logIndexDecimal = decimalString((receipt.logs[i] as (typeof receipt.logs)[number]).logIndex);
      let coherent = true;
      for (const failed of triple) {
        if (failed.passed) continue;
        coherent = false;
        conflicts.push(
          buildCheckConflict({
            check: failed,
            qualifier: `log:${logIndexDecimal}`,
            scope: EXECUTION_SCOPE,
            material: true,
            evidenceIds: [receiptId as string],
            description: `Receipt log at logIndex=${logIndexDecimal} failed consistency check ${failed.code}; the log cannot stand as clean observed-effect evidence.`,
          }),
        );
      }
      logCoherent.push(coherent);
      if (!coherent) omittedLogIndexes.push(logIndexDecimal);
    }
    if (omittedLogIndexes.length > 0 && receiptId !== undefined) {
      warnings.push({
        code: "EVM_OBSERVED_EFFECTS_OMITTED",
        message:
          "Logs failing their consistency checks were not emitted as observed effects; see the corresponding conflicts.",
        evidence: [receiptId],
        metadata: { logIndexes: omittedLogIndexes },
      });
    }
  }

  // Observed effects: only logs that are individually coherent AND belong to
  // a receipt that binds to the requested subject. A log whose relevant
  // consistency checks failed is NEVER emitted as clean observed-effect
  // evidence. Identical duplicate log entries collapse (identical content
  // carries zero additional information).
  const effects: ObservedEffect[] = [];
  if (
    receipt !== null &&
    receipt !== undefined &&
    receiptId !== undefined &&
    logCoherent.length === receipt.logs.length &&
    checkOfCode(acquisition.checks, "RECEIPT_TX_HASH_MATCHES_SUBJECT")?.passed === true
  ) {
    const seenEffectIds = new Set<string>();
    for (let i = 0; i < receipt.logs.length; i++) {
      if (!logCoherent[i]) continue;
      const effect = buildLogObservedEffect(receipt.logs[i] as (typeof receipt.logs)[number], receiptId);
      if (seenEffectIds.has(effect.id)) continue;
      seenEffectIds.add(effect.id);
      effects.push(effect);
    }
  }

  // --- base contributions (observation level; THE composer owns the ladder).
  const inputs = baseDimensionInputs(acquisition, citations, warnings);
  const composed = {
    execution: composeProposition(inputs.execution, { conflicts, evidenceRefs: refs }),
    dataBinding: composeProposition(inputs.dataBinding, { conflicts, evidenceRefs: refs }),
  };

  return assembleEvaluation({
    acquisition,
    refs,
    inputs,
    composed,
    effects: [...effects].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    conflicts: [...conflicts].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    warnings: [...warnings].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)),
  });
}

// ---------------------------------------------------------------------------
// Base contribution construction (inputs to THE core composer)
// ---------------------------------------------------------------------------

function baseDimensionInputs(
  acquisition: EvmTransactionAcquisition,
  citations: ReturnType<typeof captureEvidenceIndex>,
  warnings: Warning[],
): Record<CoreDimensionName, DimensionInput> {
  const receipt = acquisition.receipt;
  const receiptId = citations.receipt;

  // Evidence not acquired at all -> unknown applicability (never a verdict).
  if (receipt === undefined || receiptId === undefined) {
    return {
      execution: { scope: EXECUTION_SCOPE, applicability: "unknown", evidence: [] },
      dataBinding: { scope: DATA_BINDING_SCOPE, applicability: "unknown", evidence: [] },
    };
  }

  // Null receipt: confirmed absence AT ACQUISITION TIME through THIS source.
  // This is never a contradiction and never proof of non-execution.
  if (receipt === null) {
    warnings.push({
      code: "EVM_RECEIPT_NOT_OBSERVED",
      message:
        "The source returned no receipt at acquisition time; a null receipt is absence of observation, not evidence of non-execution.",
      evidence: [receiptId],
    });
    return {
      execution: {
        scope: EXECUTION_SCOPE,
        applicability: "applicable",
        verdict: "insufficient",
        basis: ["source_observation"],
        evidence: [receiptId],
      },
      dataBinding: {
        scope: DATA_BINDING_SCOPE,
        applicability: "applicable",
        verdict: "insufficient",
        basis: [],
        evidence: [],
      },
    };
  }

  const bindsToSubject =
    checkOfCode(acquisition.checks, "RECEIPT_TX_HASH_MATCHES_SUBJECT")?.passed === true;

  // Subject binding broken -> the receipt proves nothing about THIS subject;
  // the execution contribution is downgraded to insufficient (the scoped
  // dataBinding conflict still forces dataBinding to ambiguous).
  const execution: DimensionInput = bindsToSubject
    ? {
        scope: EXECUTION_SCOPE,
        applicability: "applicable",
        verdict: receipt.status === "success" ? "supported" : "contradicted",
        basis: ["source_observation"],
        evidence: [receiptId],
      }
    : {
        scope: EXECUTION_SCOPE,
        applicability: "applicable",
        verdict: "insufficient",
        basis: ["source_observation"],
        evidence: [receiptId],
      };

  const bindingEvidence: EvidenceId[] = [receiptId];
  if (citations.transaction !== undefined) bindingEvidence.push(citations.transaction);

  const dataBinding: DimensionInput = bindsToSubject
    ? {
        scope: DATA_BINDING_SCOPE,
        applicability: "applicable",
        verdict: "supported",
        basis: ["deterministic_derivation", "source_observation"],
        evidence: bindingEvidence,
      }
    : {
        scope: DATA_BINDING_SCOPE,
        applicability: "applicable",
        verdict: "insufficient",
        basis: ["deterministic_derivation", "source_observation"],
        evidence: bindingEvidence,
      };

  if (acquisition.transaction === undefined) {
    warnings.push({
      code: "EVM_TRANSACTION_NOT_ACQUIRED",
      message:
        "eth_getTransactionByHash was not part of this acquisition; transaction/receipt cross-coherence is unverified.",
    });
  }

  return { execution, dataBinding };
}

// ---------------------------------------------------------------------------
// Assembly + fail-closed self validation
// ---------------------------------------------------------------------------

function reasonFor(name: CoreDimensionName, inputs: DimensionInput): string | undefined {
  if (name === "execution") {
    if (inputs.verdict === "supported") {
      return "Supported by this source's receipt observation alone; not a settlement or finality claim.";
    }
    if (inputs.verdict === "contradicted") {
      return "This source's receipt reports a reverted status; the successful-execution proposition is contradicted (the transaction still executed).";
    }
    if (inputs.verdict === "insufficient") {
      return "No receipt binds this subject to an on-chain execution outcome; a null receipt is not evidence of non-execution.";
    }
    return undefined;
  }
  if (name === "dataBinding" && inputs.verdict !== "supported") {
    return "Subject binding is not established for this acquisition; nothing can be bound to the requested subject.";
  }
  return undefined;
}

function assembleEvaluation(args: {
  acquisition: EvmTransactionAcquisition;
  refs: readonly EvidenceRef[];
  inputs: Record<CoreDimensionName, DimensionInput>;
  composed: Record<CoreDimensionName, ReturnType<typeof composeProposition>>;
  effects: readonly ObservedEffect[];
  conflicts: readonly Conflict[];
  warnings: readonly Warning[];
}): EvmEvaluation {
  const scopes: Record<CoreDimensionName, PropositionScope> = {
    execution: EXECUTION_SCOPE,
    dataBinding: DATA_BINDING_SCOPE,
  };
  const propositions: Record<CoreDimensionName, string> = {
    execution: EXECUTION_PROPOSITION,
    dataBinding: DATA_BINDING_PROPOSITION,
  };

  const evaluated = (name: CoreDimensionName): EvaluatedDimension => {
    const composed = args.composed[name];
    const dimension: EvidenceDimension = {
      applicability: composed.applicability,
      ...(composed.verdict === undefined ? {} : { verdict: composed.verdict }),
      basis: [...composed.basis],
      evidence: [...composed.evidence],
      ...(reasonFor(name, args.inputs[name]) === undefined
        ? {}
        : { reason: reasonFor(name, args.inputs[name]) }),
      metadata: { proposition: propositions[name] },
    };
    return { name, scope: scopes[name], proposition: propositions[name], dimension };
  };

  const executionDim = evaluated("execution");
  const dataBindingDim = evaluated("dataBinding");

  // Partial networkEvidence: ONLY dimensions actually evaluated are present.
  // Settlement and finality are omitted entirely (never projected as
  // applicable+insufficient placeholders).
  const fragment: NetworkEvidenceFragment = {
    network: buildEvaluationFingerprint(args.acquisition),
    subject: toSubjectRef(args.acquisition),
    networkEvidence: {
      execution: executionDim.dimension,
      dataBinding: dataBindingDim.dimension,
      observedEffects: [...args.effects],
    },
    evidence: [...args.refs],
    conflicts: [...args.conflicts],
    warnings: [...args.warnings],
  };

  // Fail closed BEFORE anything escapes: the assembled fragment must satisfy
  // the complete frozen core contract (citation closure, state machine,
  // unique ids, warning/conflict resolvability).
  try {
    validateNetworkEvidenceFragment(fragment);
  } catch (error) {
    throw new NecResolverEvmError(
      "EVM_MALFORMED_RESPONSE",
      `evaluator produced an invalid fragment; failing closed (${(error as Error).message})`,
    );
  }

  return deepFreeze({
    profile: EVALUATION_PROFILE,
    networkId: args.acquisition.source.networkId,
    subject: fragment.subject,
    dimensions: {
      execution: executionDim,
      dataBinding: dataBindingDim,
    },
    observedEffects: fragment.networkEvidence.observedEffects ?? [],
    conflicts: fragment.conflicts,
    warnings: fragment.warnings,
    fragment,
  });
}
