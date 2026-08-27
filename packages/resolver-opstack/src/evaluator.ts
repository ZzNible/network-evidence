/**
 * PURE single-proposition evaluation: OP Stack L2 BLOCK FINALITY.
 *
 * Pipeline (no network, no clock, no randomness, no filesystem):
 *
 *   explicit config + generic EVM acquisition + OP Stack finality
 *   observation (heads + walked parentHash ancestry + burst stability)
 *     -> deterministic decision ladder (fail closed)
 *     -> THE core normative composer (`composeProposition`)
 *     -> finality-only NetworkEvidenceFragment
 *
 * THE PROPOSITION (never collapsed with anything else):
 *
 *   Under the pinned ruleset `opstack.rpc-finalized-head-v1`, the subject
 *   transaction's containing L2 block remains the canonical block at its
 *   height per THIS ONE source, is connected to that source's observed
 *   "finalized" head by a complete, unbroken parentHash ancestry captured
 *   within one bounded observation burst, and lies at or below that head —
 *   which, per current OP Stack semantics, is derived from FINALIZED L1
 *   data.
 *
 * HARD SEMANTIC BOUNDARY: an OP Stack L2 block being FINALIZED is NOT the
 * same as a withdrawal/output being finalized after a fault-proof dispute
 * period. This evaluator answers the former only. It never evaluates
 * withdrawals, output roots or challenge periods, and never populates the
 * settlement dimension.
 *
 * EPISTEMIC BOUNDARY (basis): positive support rests on DIRECT SOURCE
 * OBSERVATION only — basis is exactly ["source_observation"]. This resolver
 * does NOT replay OP derivation from L1 inputs and runs NO consensus
 * engine: comparing and linking RPC observations is not derivation, so
 * `deterministic_derivation`, `local_consensus_engine` and
 * `cryptographic_verification` NEVER appear in any basis this package
 * emits.
 *
 * DECISION LADDER (first match wins; everything fails closed):
 *
 *   0. Generic binding not established (no receipt/block, or binding
 *      checks failed)          -> applicability "unknown"; never a verdict.
 *   1. Subject network != configured network -> insufficient + warning
 *      (fail closed; chain families/networks are NEVER inferred).
 *   2. Materially incoherent observations become Conflicts scoped to the
 *      finality dimension (THE composer forces "ambiguous"):
 *        - finalized > safe, safe > latest, equal-height hash divergence;
 *        - canonical exact-height observation missing/incoherent;
 *        - broken parentHash ancestry (number or hash link);
 *        - finalized head changed (or vanished) between the first read
 *          and the burst-closing stability re-read.
 *      A dethroning canonical observation (hash != subject hash at S)
 *      suppresses the terminal-ancestry conflict so the clean negative of
 *      step 3 can stand on its own.
 *   3. Canonical block at height S has a different hash than the subject
 *      containing block -> verdict "contradicted" (clean negative: this
 *      source no longer observes the subject block as canonical at its
 *      height). Never a conflict, never silent.
 *   4. Finalized/safe/latest heads unavailable -> "insufficient" + warning.
 *      The "finalized" view is never substituted by "safe" or "latest".
 *   5. Required ancestry walk refused by the configured maximum depth ->
 *      "insufficient" (fail closed): ancestry beyond the bound cannot be
 *      established honestly and is never inferred from block numbers.
 *   6. S <= F with the complete walked F -> S ancestry, terminal hash ==
 *      subject hash, coherent heads, intact canonical re-read and stable
 *      finalized re-read -> "supported", basis exactly
 *      ["source_observation"], pinned ruleset recorded in metadata.
 *      F < S <= safe -> "insufficient" + explicit safe-but-not-finalized
 *      warning. safe < S -> "insufficient".
 *
 * STANDING NON-CLAIMS (unconditional warnings, every scenario): one RPC
 * source is not cross-source consensus; L1 derivation was not replayed
 * locally; no local rollup-node verification was performed; withdrawal
 * finalization was not evaluated. "Finalized" always means THIS source's
 * OP Stack L2 finalized VIEW — never withdrawal finalization, dispute-game
 * completion, output-root irreversibility or economic irreversibility of
 * funds.
 */

import {
  composeProposition,
  deepFreeze,
  mergeConflicts,
  mergeWarnings,
  validateNetworkEvidenceFragment,
} from "@nec/core";
import type {
  Applicability,
  Conflict,
  EvidenceBasis,
  EvidenceDimension,
  EvidenceRef,
  EvidenceVerdict,
  NetworkEvidenceFragment,
  NetworkFingerprint,
  PropositionScope,
  Warning,
} from "@nec/core";

import { buildEvidenceRefs, ACQUISITION_PROFILE } from "@nec/resolver-evm";
import type {
  EvmConsistencyCheck,
  EvmConsistencyCheckCode,
  EvmTransactionAcquisition,
} from "@nec/resolver-evm";

import type { OpStackFinalityObservation } from "./acquire.js";
import { OPSTACK_ACQUISITION_PROFILE } from "./acquire.js";
import type { OpStackConsistencyCheck, OpStackConsistencyCheckCode } from "./checks.js";
import { NecResolverOpStackError } from "./errors.js";
import {
  OPSTACK_FAMILY,
  OPSTACK_FINALITY_RULESET,
  OPSTACK_FINALITY_RULESET_VERSION,
  opStackFinalityMetadata,
} from "./config.js";
import type { OpStackFinalityConfig } from "./config.js";

export const OPSTACK_EVALUATION_PROFILE = "nec-resolver-opstack-evaluation-v1";

/** Prefix for evaluator-emitted conflict ids. */
export const OPSTACK_CONFLICT_ID_PREFIX = "nec-opstack-conflict";

/** Explicit proposition text evaluated for the finality dimension. */
export const FINALITY_PROPOSITION =
  "The subject transaction's containing L2 block remains the observed canonical block at its height, is connected by a complete unbroken parentHash ancestry to this single source's observed OP Stack finalized head within one bounded observation burst, and lies at or below that finalized head, under the pinned rpc-finalized-head ruleset.";

/** THE finality proposition scope (core dimension vocabulary). */
export const FINALITY_SCOPE: PropositionScope = { kind: "dimension", dimension: "finality" };

// ---------------------------------------------------------------------------
// Standing non-claim warnings (every scenario, unconditionally)
// ---------------------------------------------------------------------------

const STANDING_LIMITATION_WARNINGS: readonly Warning[] = [
  {
    code: "CROSS_SOURCE_CONSENSUS_NOT_ESTABLISHED",
    message:
      "All finality observations come from ONE configured JSON-RPC source; one source is not independent consensus.",
  },
  {
    code: "INDEPENDENT_L1_DERIVATION_NOT_ESTABLISHED",
    message:
      "The full OP Stack L1 derivation pipeline was not independently replayed; head observations are interpreted, not recomputed.",
  },
  {
    code: "LOCAL_ROLLUP_NODE_VERIFICATION_NOT_ESTABLISHED",
    message:
      "No local rollup node or derivation engine verified these observations; every conclusion rests on direct source observation only.",
  },
  {
    code: "WITHDRAWAL_FINALIZATION_NOT_EVALUATED",
    message:
      'L2 block finality is not withdrawal finalization: "finalized" here is this source\'s OP Stack L2 finalized view — withdrawal proving/finalizing after the fault-proof dispute period was NOT evaluated.',
  },
];

function checkOfCode(
  checks: readonly OpStackConsistencyCheck[],
  code: OpStackConsistencyCheckCode,
): OpStackConsistencyCheck | undefined {
  return checks.find((c) => c.code === code);
}

function genericCheckOfCode(
  checks: readonly EvmConsistencyCheck[],
  code: EvmConsistencyCheckCode,
): EvmConsistencyCheck | undefined {
  return checks.find((c) => c.code === code);
}

function decimal(value: bigint): string {
  return value.toString(10);
}

/**
 * Build one core Conflict from ONE failed consistency check (material by
 * construction: structural incoherence between a source's own observations).
 */
function buildOpStackConflict(args: {
  check: OpStackConsistencyCheck;
  qualifier: string;
  evidenceIds: readonly string[];
  description: string;
}): Conflict {
  const code = args.check.code;
  return {
    id: `${OPSTACK_CONFLICT_ID_PREFIX}:${code}:${args.qualifier}`,
    code,
    description: args.description,
    scope: FINALITY_SCOPE,
    evidence: [...new Set(args.evidenceIds)],
    material: true,
    ...(args.check.detail === undefined ? {} : { metadata: { checkDetail: args.check.detail } }),
  };
}

// ---------------------------------------------------------------------------
// Evidence table
// ---------------------------------------------------------------------------

/**
 * Self-contained citation table: one EvidenceRef per OP Stack capture plus
 * the generic acquisition's refs (binding evidence the finality proposition
 * leans on). Ids derive deterministically from capture content digests;
 * prefixes keep the provenance families distinguishable.
 */
function buildFinalityEvidenceRefs(
  evm: EvmTransactionAcquisition,
  observation: OpStackFinalityObservation,
): EvidenceRef[] {
  const byId = new Map<string, EvidenceRef>();
  for (const ref of buildEvidenceRefs(evm)) byId.set(ref.id, ref);

  const kindOf = (method: string, params: readonly unknown[]): string => {
    if (method === "eth_chainId") return "chainidentity";
    if (method === "eth_getBlockByNumber") {
      const tag = params[0];
      if (tag === "safe") return "safe-head";
      if (tag === "finalized") return "finalized-head";
      if (tag === "latest") return "latest-head";
      return "canonical-block";
    }
    if (method === "eth_getBlockByHash") return "ancestry-block";
    return "rpc";
  };
  for (const capture of observation.captures) {
    const kind = kindOf(capture.rpcMethod, capture.rpcParams);
    const digestHex = capture.contentDigest.slice("sha256:".length);
    const paramsKey = JSON.stringify(
      capture.rpcParams.length === 1 ? capture.rpcParams[0] : capture.rpcParams,
    );
    byId.set(`opstack-${kind}-${digestHex.slice(0, 16)}`, {
      id: `opstack-${kind}-${digestHex.slice(0, 16)}`,
      sourceId: capture.sourceId,
      sourceType: capture.sourceType,
      ...(capture.independenceGroup === undefined ? {} : { independenceGroup: capture.independenceGroup }),
      locator: `${capture.rpcMethod}:${paramsKey}`,
      retrievedAt: capture.acquiredAt,
      contentDigest: capture.contentDigest,
      networkId: capture.networkId,
      metadata: {
        rpcMethod: capture.rpcMethod,
        httpStatus: capture.httpStatus,
        captureProfile: capture.profile,
        observationProfile: observation.profile,
      },
    });
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Role index over the citation table, resolved from CAPTURE ORDER (not id
 * sort order): repeated exchanges (the two finalized reads) and the many
 * ancestry reads need their first/last representatives identified
 * deterministically for citation purposes.
 */
interface RefIndex {
  chainId?: string;
  finalizedHead?: string;
  finalizedReRead?: string;
  safeHead?: string;
  latestHead?: string;
  canonicalBlock?: string;
  ancestryFirst?: string;
  ancestryLast?: string;
  receipt?: string;
  block?: string;
}

function citationIndex(refs: readonly EvidenceRef[], observation: OpStackFinalityObservation): RefIndex {
  const indexOfPrefix = (prefix: string): string | undefined =>
    refs.find((r) => r.id.startsWith(prefix))?.id;

  // Walk-order role assignment over the producing captures (id-sort order
  // is meaningless for repeated exchanges): the FIRST finalized read is the
  // burst head, the SECOND is the stability re-read; ancestry citations use
  // the walk's endpoints. Identical re-read content collapses to one ref.
  const finalizedIds: string[] = [];
  let ancestryFirst: string | undefined;
  let ancestryLast: string | undefined;
  for (const capture of observation.captures) {
    const digestHex = capture.contentDigest.slice("sha256:".length);
    const idFor = (kind: string): string => `opstack-${kind}-${digestHex.slice(0, 16)}`;
    if (capture.rpcMethod === "eth_getBlockByNumber" && capture.rpcParams[0] === "finalized") {
      finalizedIds.push(idFor("finalized-head"));
      continue;
    }
    if (capture.rpcMethod === "eth_getBlockByHash") {
      ancestryFirst ??= idFor("ancestry-block");
      ancestryLast = idFor("ancestry-block");
    }
  }

  return {
    chainId: indexOfPrefix("opstack-chainidentity-"),
    safeHead: indexOfPrefix("opstack-safe-head-"),
    finalizedHead: finalizedIds[0],
    finalizedReRead: finalizedIds.length > 1 ? finalizedIds[1] : finalizedIds[0],
    latestHead: indexOfPrefix("opstack-latest-head-"),
    canonicalBlock: indexOfPrefix("opstack-canonical-block-"),
    ancestryFirst,
    ancestryLast,
    receipt: indexOfPrefix("evm-receipt-"),
    block: indexOfPrefix("evm-block-"),
  };
}

// ---------------------------------------------------------------------------
// THE evaluator
// ---------------------------------------------------------------------------

export interface OpStackFinalityEvaluationInput {
  /** EXPLICIT family/ruleset configuration (validated, never inferred). */
  readonly config: OpStackFinalityConfig;
  /** Generic single-source EVM acquisition binding tx -> containing block. */
  readonly evm: EvmTransactionAcquisition;
  /** OP Stack finality observation from the SAME configured source family. */
  readonly finality: OpStackFinalityObservation;
}

export interface EvaluatedOpStackDimension {
  readonly name: "finality";
  readonly scope: PropositionScope;
  readonly proposition: string;
  readonly dimension: EvidenceDimension;
}

/** Resolver-local evaluation result: fragment PLUS the explicit proposition. */
export interface OpStackFinalityEvaluation {
  readonly profile: typeof OPSTACK_EVALUATION_PROFILE;
  readonly config: Readonly<{
    family: string;
    ruleset: string;
    rulesetVersion: string;
    networkId: string;
  }>;
  readonly networkId: string;
  readonly subject: NetworkEvidenceFragment["subject"];
  readonly dimension: EvaluatedOpStackDimension;
  readonly conflicts: readonly Conflict[];
  readonly warnings: readonly Warning[];
  /** Clean core fragment projection carrying ONLY the finality dimension. */
  readonly fragment: NetworkEvidenceFragment;
}

/**
 * Evaluate ONE OP Stack finality observation against ONE generically-bound
 * subject under ONE explicit config. Deterministic: the same inputs yield a
 * deep-equal evaluation, always.
 */
export function evaluateOpStackFinality(input: OpStackFinalityEvaluationInput): OpStackFinalityEvaluation {
  const config = input.config;
  // Config boundary re-validation: wrong family/ruleset/config shape throws
  // (case G) — this package implements exactly one pinned ruleset.
  const configMeta = opStackFinalityMetadata(config);

  if (input.evm.profile !== ACQUISITION_PROFILE || input.finality.profile !== OPSTACK_ACQUISITION_PROFILE) {
    throw new NecResolverOpStackError(
      "OPSTACK_OBSERVATION_INCOMPLETE",
      "finality evaluation requires a generic EVM acquisition and an OP Stack acquisition of this resolver version",
    );
  }

  const refs = buildFinalityEvidenceRefs(input.evm, input.finality);
  const citations = citationIndex(refs, input.finality);
  const conflicts: Conflict[] = [];
  const warnings: Warning[] = [];

  // --- ladder step 0: generic binding ---------------------------------------
  const evmReceipt = input.evm.receipt;
  const evmBlock = input.evm.block;
  const bindsSubject =
    evmReceipt !== null &&
    evmReceipt !== undefined &&
    evmBlock != null &&
    genericCheckOfCode(input.evm.checks, "RECEIPT_TX_HASH_MATCHES_SUBJECT")?.passed === true &&
    genericCheckOfCode(input.evm.checks, "RECEIPT_BLOCK_HASH_MATCHES_BLOCK")?.passed === true &&
    genericCheckOfCode(input.evm.checks, "RECEIPT_BLOCK_NUMBER_MATCHES_BLOCK")?.passed === true;

  if (!bindsSubject) {
    warnings.push({
      code: "OP_GENERIC_BINDING_NOT_ESTABLISHED",
      message:
        "The generic EVM evidence does not bind the subject transaction to a containing block; the OP Stack finality question cannot be posed for this subject.",
    });
    return assemble({
      configMeta,
      config,
      evm: input.evm,
      finality: input.finality,
      refs,
      citations,
      conflicts,
      warnings,
      contribution: { applicability: "unknown", evidence: [] },
    });
  }

  const S = evmBlock.number;
  const Hs = evmBlock.hash;

  // --- ladder step 1: explicit network identity (fail closed) ---------------
  const subjectNetworkMatches =
    input.evm.source.networkId === config.networkId &&
    input.evm.source.chainId === config.chainId;
  if (!subjectNetworkMatches) {
    warnings.push({
      code: "OP_SUBJECT_NETWORK_MISMATCH",
      message:
        "The generic evidence originates from a different network identity than the configured OP Stack target; finality is refused (networks are never inferred).",
      metadata: {
        evidenceNetworkId: input.evm.source.networkId,
        configuredNetworkId: config.networkId,
      },
    });
  }
  const observationNetworkMatches =
    input.finality.source.networkId === config.networkId &&
    input.finality.source.chainId === config.chainId;
  if (!observationNetworkMatches) {
    warnings.push({
      code: "OP_OBSERVATION_NETWORK_MISMATCH",
      message:
        "The finality observation originates from a different network identity than the configured OP Stack target; finality is refused.",
      metadata: {
        observationNetworkId: input.finality.source.networkId,
        configuredNetworkId: config.networkId,
      },
    });
  }
  if (!subjectNetworkMatches || !observationNetworkMatches) {
    return assemble({
      configMeta,
      config,
      evm: input.evm,
      finality: input.finality,
      refs,
      citations,
      conflicts,
      warnings,
      contribution: {
        applicability: "applicable",
        verdict: "insufficient",
        basis: ["source_observation"],
        evidence: citations.chainId === undefined ? [] : [citations.chainId],
        reason:
          "Evidence network identities do not match the explicitly configured OP Stack network; no finality is possible under this configuration.",
      },
    });
  }

  // --- ladder step 2: materially incoherent observations -> conflicts -------
  const conflictCitation = (keys: (keyof RefIndex)[]): string[] => {
    const ids = keys.map((k) => citations[k]).filter((x): x is string => x !== undefined);
    return [...new Set(ids)];
  };

  const pushConflict = (
    check: OpStackConsistencyCheck | undefined,
    qualifier: string,
    evidenceKeys: (keyof RefIndex)[],
    description: string,
  ): void => {
    if (check === undefined || check.passed) return;
    conflicts.push(
      buildOpStackConflict({
        check,
        qualifier,
        evidenceIds: conflictCitation(evidenceKeys),
        description,
      }),
    );
  };

  const finalizedAhead = checkOfCode(input.finality.checks, "OP_FINALIZED_NOT_AHEAD_OF_SAFE");
  pushConflict(
    finalizedAhead,
    "heads",
    ["safeHead", "finalizedHead"],
    "This source reports a finalized head ahead of its own safe head; the safe/finalized observations are internally inconsistent.",
  );

  const safeAheadOfLatest = checkOfCode(input.finality.checks, "OP_SAFE_NOT_AHEAD_OF_LATEST");
  pushConflict(
    safeAheadOfLatest,
    "heads-latest",
    ["safeHead", "latestHead"],
    "This source reports a safe head ahead of its own latest head; the head observations are internally inconsistent.",
  );

  const equalHeightCoherence = checkOfCode(
    input.finality.checks,
    "OP_SAFE_FINALIZED_COHERENT_AT_EQUAL_HEIGHT",
  );
  pushConflict(
    equalHeightCoherence,
    "equal-height",
    ["safeHead", "finalizedHead"],
    "This source reports different hashes for the safe and finalized heads at the same height; the head observations are internally inconsistent.",
  );

  // Canonical exact-height observation missing/incoherent -> material conflict.
  const canonical = input.finality.canonicalSubjectBlock;
  const numberCheck = checkOfCode(input.finality.checks, "OP_CANONICAL_BLOCK_NUMBER_MATCHES_SUBJECT");
  pushConflict(
    canonical === null || numberCheck === undefined || !numberCheck.passed
      ? (numberCheck ?? {
          code: "OP_CANONICAL_BLOCK_NUMBER_MATCHES_SUBJECT",
          passed: false,
          detail: "canonical exact-height block unavailable",
        })
      : undefined,
    "exact-height",
    ["canonicalBlock", "receipt", "block"],
    "The configured source did not return a coherent canonical block at the subject height; the ancestry required by the finality ruleset cannot be established.",
  );

  // Broken parentHash ancestry (height sequence / hash chain).
  const brokenAncestryDescription =
    "The walked parentHash ancestry from this source's observed finalized head to the subject height is broken; the source's own blocks do not form the chain its heads imply.";
  pushConflict(
    checkOfCode(input.finality.checks, "OP_ANCESTRY_HEIGHT_SEQUENCE"),
    "ancestry-heights",
    ["finalizedHead", "ancestryFirst", "ancestryLast"],
    brokenAncestryDescription,
  );
  pushConflict(
    checkOfCode(input.finality.checks, "OP_ANCESTRY_HASH_CHAIN"),
    "ancestry-hashes",
    ["finalizedHead", "ancestryFirst", "ancestryLast"],
    brokenAncestryDescription,
  );

  // Terminal ancestry divergence: only a CONFLICT when the canonical view
  // does not already cleanly dethrone the subject (then step 3 decides).
  const stillCanonical = checkOfCode(input.finality.checks, "OP_SUBJECT_BLOCK_STILL_CANONICAL");
  const dethronedCleanly = canonical !== null && stillCanonical !== undefined && !stillCanonical.passed;
  if (!dethronedCleanly) {
    pushConflict(
      checkOfCode(input.finality.checks, "OP_ANCESTRY_TERMINAL_MATCHES_SUBJECT"),
      "ancestry-terminal",
      ["ancestryFirst", "ancestryLast", "canonicalBlock"],
      "The walked finalized-chain ancestry terminates at the subject height on a different block than the subject containing block; the source's finalized chain does not contain the subject block.",
    );
  }

  // Burst stability of the finalized head.
  pushConflict(
    checkOfCode(input.finality.checks, "OP_FINALIZED_HEAD_STABLE"),
    "burst-stability",
    ["finalizedHead", "finalizedReRead"],
    "The observed finalized head changed during the observation burst; the ancestry evidence and the closing re-read disagree about what this source had finalized.",
  );

  // --- ladder step 3: subject dethroned at its height -> clean negative ------
  if (dethronedCleanly) {
    const cited = conflictCitation(["canonicalBlock", "block", "receipt"]);
    warnings.push({
      code: "OP_SUBJECT_NOT_CANONICAL_AT_HEIGHT",
      message:
        "The canonical block now observed at the subject height carries a different hash; the subject block is no longer this source's canonical block at its height.",
      evidence: cited,
    });
    return assemble({
      configMeta,
      config,
      evm: input.evm,
      finality: input.finality,
      refs,
      citations,
      conflicts,
      warnings,
      contribution: {
        applicability: "applicable",
        verdict: "contradicted",
        basis: ["source_observation"],
        evidence: cited,
        reason:
          "Contradicted by direct observation: the block this source returns at the subject height no longer equals the subject containing block, so the finality proposition is false under the pinned ruleset. This is not a withdrawal-finalization or settlement statement.",
      },
    });
  }

  // --- ladder step 4: head availability --------------------------------------
  const finalizedHead = input.finality.finalizedHead;
  const safeHead = input.finality.safeHead;
  const latestHead = input.finality.latestHead;
  if (finalizedHead === null || safeHead === null || latestHead === null) {
    if (finalizedHead === null) {
      warnings.push({
        code: "OP_FINALIZED_HEAD_UNAVAILABLE",
        message:
          'The source returned no "finalized" head; finality is insufficient without it (safe/latest never substitute for it).',
        ...(citations.finalizedHead === undefined ? {} : { evidence: [citations.finalizedHead] }),
      });
    }
    if (safeHead === null) {
      warnings.push({
        code: "OP_SAFE_HEAD_UNAVAILABLE",
        message: 'The source returned no "safe" head; head ordering cannot be interpreted.',
        ...(citations.safeHead === undefined ? {} : { evidence: [citations.safeHead] }),
      });
    }
    if (latestHead === null) {
      warnings.push({
        code: "OP_LATEST_HEAD_UNAVAILABLE",
        message:
          'The source returned no "latest" head; the required finalized <= safe <= latest ordering cannot be verified.',
        ...(citations.latestHead === undefined ? {} : { evidence: [citations.latestHead] }),
      });
    }
    return assemble({
      configMeta,
      config,
      evm: input.evm,
      finality: input.finality,
      refs,
      citations,
      conflicts,
      warnings,
      contribution: {
        applicability: "applicable",
        verdict: "insufficient",
        basis: ["source_observation"],
        evidence: conflictCitation(["finalizedHead", "safeHead", "latestHead"]),
        reason:
          "Observed head evidence is incomplete; the pinned ruleset cannot establish finality from the available observations.",
      },
    });
  }

  // --- ladder step 5: required ancestry must be complete ---------------------
  // Whenever an observed finalized head lies at/above the subject height, a
  // COMPLETE walked parentHash ancestry is structurally REQUIRED for any
  // positive outcome — its absence is insufficiency, never support.
  const ancestry = input.finality.ancestry;
  if (finalizedHead !== null && finalizedHead.number >= S) {
    const depthRefused =
      checkOfCode(input.finality.checks, "OP_ANCESTRY_WALK_EXCEEDS_LIMIT") !== undefined;
    const walkComplete =
      checkOfCode(input.finality.checks, "OP_ANCESTRY_TERMINAL_MATCHES_SUBJECT") !== undefined;
    if (ancestry === undefined || depthRefused || !walkComplete) {
      if (depthRefused) {
        warnings.push({
          code: "OP_ANCESTRY_DEPTH_EXCEEDED",
          message: `The required finalized-to-subject parentHash ancestry spans ${decimal(ancestry?.requiredDepth ?? finalizedHead.number - S)} blocks and exceeds the explicitly configured maximum depth of ${input.finality.maxAncestryDepth}; the walk was refused and ancestry is never inferred from block numbers alone.`,
          metadata: {
            requiredDepth: decimal(finalizedHead.number - S),
            maxAncestryDepth: input.finality.maxAncestryDepth,
          },
        });
      }
      return assemble({
        configMeta,
        config,
        evm: input.evm,
        finality: input.finality,
        refs,
        citations,
        conflicts,
        warnings,
        contribution: {
          applicability: "applicable",
          verdict: "insufficient",
          basis: ["source_observation"],
          evidence: conflictCitation([
            "finalizedHead",
            "ancestryFirst",
            "ancestryLast",
            "canonicalBlock",
          ]),
          reason:
            "The finalized-head ancestry required by the pinned ruleset could not be established within one bounded observation burst; finality fails closed.",
        },
      });
    }
  }

  // --- ladder step 6: deterministic verdict over ordered observations --------
  if (finalizedHead.number >= S) {
    return assemble({
      configMeta,
      config,
      evm: input.evm,
      finality: input.finality,
      refs,
      citations,
      conflicts,
      warnings,
      contribution: {
        applicability: "applicable",
        verdict: "supported",
        basis: ["source_observation"],
        evidence: conflictCitation([
          "chainId",
          "receipt",
          "block",
          "canonicalBlock",
          "safeHead",
          "finalizedHead",
          "finalizedReRead",
          "latestHead",
          "ancestryFirst",
          "ancestryLast",
        ]),
        reason:
          "Supported under the pinned rpc-finalized-head ruleset: within one bounded observation burst this source returned an unbroken parentHash ancestry from its observed finalized head down to the subject height with the terminal hash equal to the subject containing-block hash, the canonical block at the subject height still equals the subject block, head ordering finalized <= safe <= latest held, and the finalized head was unchanged between the first and final read. This is direct source observation — not cryptographic proof, not local consensus verification, not OP derivation replay, and not withdrawal finalization.",
      },
    });
  }

  if (safeHead.number >= S) {
    warnings.push({
      code: "OP_SAFE_BUT_NOT_FINALIZED",
      message:
        "The subject lies at or below the observed safe head but above the observed finalized head; safety does not imply v0.1 finality.",
      metadata: {
        subjectBlockNumber: decimal(S),
        safeHeadNumber: decimal(safeHead.number),
        finalizedHeadNumber: decimal(finalizedHead.number),
      },
    });
    return assemble({
      configMeta,
      config,
      evm: input.evm,
      finality: input.finality,
      refs,
      citations,
      conflicts,
      warnings,
      contribution: {
        applicability: "applicable",
        verdict: "insufficient",
        basis: ["source_observation"],
        evidence: conflictCitation(["safeHead", "finalizedHead", "canonicalBlock"]),
        reason:
          "Safe-but-not-finalized: the subject remains within this source's observed safe head but exceeds its observed finalized head; finality is NOT established (fail closed).",
      },
    });
  }

  warnings.push({
    code: "OP_ABOVE_SAFE_HEAD",
    message:
      "The subject lies above even the observed safe head; finality is not established.",
    metadata: {
      subjectBlockNumber: decimal(S),
      safeHeadNumber: decimal(safeHead.number),
    },
  });
  return assemble({
    configMeta,
    config,
    evm: input.evm,
    finality: input.finality,
    refs,
    citations,
    conflicts,
    warnings,
    contribution: {
      applicability: "applicable",
      verdict: "insufficient",
      basis: ["source_observation"],
      evidence: conflictCitation(["safeHead", "canonicalBlock"]),
      reason:
        "The subject exceeds this source's observed safe head; the pinned ruleset never promotes such a subject to finality.",
    },
  });
}

// ---------------------------------------------------------------------------
// Assembly + fail-closed self validation
// ---------------------------------------------------------------------------

interface ContributionSpec {
  readonly applicability: Applicability;
  readonly verdict?: EvidenceVerdict;
  readonly basis?: readonly EvidenceBasis[];
  readonly evidence: readonly string[];
  readonly reason?: string;
}

function assemble(args: {
  configMeta: ReturnType<typeof opStackFinalityMetadata>;
  config: OpStackFinalityConfig;
  evm: EvmTransactionAcquisition;
  finality: OpStackFinalityObservation;
  refs: readonly EvidenceRef[];
  citations: RefIndex;
  conflicts: Conflict[];
  warnings: Warning[];
  contribution: ContributionSpec;
}): OpStackFinalityEvaluation {
  const composed = composeProposition(
    {
      scope: FINALITY_SCOPE,
      applicability: args.contribution.applicability,
      ...(args.contribution.verdict === undefined ? {} : { verdict: args.contribution.verdict }),
      ...(args.contribution.basis === undefined ? {} : { basis: args.contribution.basis }),
      evidence: args.contribution.evidence,
    },
    { conflicts: args.conflicts, evidenceRefs: args.refs },
  );

  const ancestry = args.finality.ancestry;
  const dimension: EvidenceDimension = {
    applicability: composed.applicability,
    ...(composed.verdict === undefined ? {} : { verdict: composed.verdict }),
    basis: [...composed.basis],
    evidence: [...composed.evidence],
    ...(args.contribution.reason === undefined ? {} : { reason: args.contribution.reason }),
    metadata: {
      proposition: FINALITY_PROPOSITION,
      family: args.configMeta.family,
      ruleset: args.configMeta.ruleset,
      rulesetVersion: args.configMeta.rulesetVersion,
      networkId: args.configMeta.networkId,
      observedVia:
        'eth_getBlockByNumber("finalized"|"safe"|"latest"|<height>, false) + eth_getBlockByHash(<parentHash>, false)',
      maxAncestryDepth: args.finality.maxAncestryDepth,
      ...(ancestry === undefined
        ? {}
        : {
            ancestryRequiredDepth: decimal(ancestry.requiredDepth),
            ancestryWalkedLinks: decimal(BigInt(ancestry.blocks.length)),
          }),
      ...(args.evm.block?.number === undefined
        ? args.evm.receipt?.blockNumber === undefined || args.evm.receipt?.blockNumber === null
          ? {}
          : { subjectBlockNumber: decimal(args.evm.receipt.blockNumber) }
        : { subjectBlockNumber: decimal(args.evm.block.number) }),
      ...(args.finality.finalizedHead === null
        ? {}
        : { finalizedHeadNumber: decimal(args.finality.finalizedHead.number) }),
      ...(args.finality.safeHead === null ? {} : { safeHeadNumber: decimal(args.finality.safeHead.number) }),
      ...(args.finality.latestHead === null
        ? {}
        : { latestHeadNumber: decimal(args.finality.latestHead.number) }),
    },
  };

  const finalizedHead = args.finality.finalizedHead;
  const anchor: NetworkFingerprint["observedAt"] =
    finalizedHead === null
      ? {}
      : {
          blockNumber: finalizedHead.number,
          blockId: finalizedHead.hash,
          ...(finalizedHead.timestamp * 1000n <= BigInt(Number.MAX_SAFE_INTEGER)
            ? { timestamp: new Date(Number(finalizedHead.timestamp * 1000n)).toISOString() }
            : {}),
        };

  const fragment: NetworkEvidenceFragment = {
    network: {
      networkId: args.config.networkId,
      ...(Number.isSafeInteger(args.config.chainId) ? { chainId: args.config.chainId } : {}),
      observedAt: anchor,
    },
    subject: {
      type: "transaction",
      networkId: args.config.networkId,
      txId: args.evm.subject.txHash,
    },
    // ONLY the finality dimension: settlement is deliberately absent — a
    // finalized L2 block decides nothing about any settlement claim.
    networkEvidence: { finality: dimension },
    evidence: [...args.refs],
    conflicts: mergeConflicts([], args.conflicts),
    warnings: mergeWarnings([], [...STANDING_LIMITATION_WARNINGS, ...args.warnings]),
  };

  // Fail closed BEFORE anything escapes: the assembled fragment must satisfy
  // the complete frozen core contract (citation closure, state machine,
  // unique ids, warning/conflict resolvability).
  try {
    validateNetworkEvidenceFragment(fragment);
  } catch (error) {
    throw new NecResolverOpStackError(
      "OPSTACK_MALFORMED_RESPONSE",
      `evaluator produced an invalid fragment; failing closed (${(error as Error).message})`,
    );
  }

  return deepFreeze({
    profile: OPSTACK_EVALUATION_PROFILE,
    config: args.configMeta,
    networkId: args.config.networkId,
    subject: fragment.subject,
    dimension: {
      name: "finality" as const,
      scope: FINALITY_SCOPE,
      proposition: FINALITY_PROPOSITION,
      dimension,
    },
    conflicts: fragment.conflicts,
    warnings: fragment.warnings,
    fragment,
  });
}
