/**
 * CONSISTENCY INVARIANTS over normalized OP Stack finality observations.
 *
 * Same two failure classes as the generic EVM resolver:
 *
 *   1. STRUCTURAL malformation (unparseable/ill-typed data) fails closed
 *      immediately with a controlled error.
 *   2. SEMANTIC incoherence between values the source actually returned
 *      (chain identity vs finalized/safe/latest heads vs the walked
 *      parentHash ancestry vs the canonical block at the subject height)
 *      is EVIDENCE about the source: it is captured as failed checks inside
 *      the observation. The pure evaluator decides which failed checks
 *      become conflicts and which map to clean negative verdicts or plain
 *      insufficiency.
 *
 * Agreement between RPC-returned values is correlation from ONE source,
 * never cryptographic proof and never consensus. In particular a complete
 * parentHash walk proves only what THIS source reported during ONE
 * observation burst — it is not OP derivation and not a consensus check.
 */

export type OpStackConsistencyCheckCode =
  | "OP_CHAIN_ID_MATCHES_SOURCE"
  | "OP_CANONICAL_BLOCK_NUMBER_MATCHES_SUBJECT"
  | "OP_SUBJECT_BLOCK_STILL_CANONICAL"
  | "OP_FINALIZED_NOT_AHEAD_OF_SAFE"
  | "OP_SAFE_NOT_AHEAD_OF_LATEST"
  | "OP_SAFE_FINALIZED_COHERENT_AT_EQUAL_HEIGHT"
  | "OP_ANCESTRY_WALK_EXCEEDS_LIMIT"
  | "OP_ANCESTRY_HEIGHT_SEQUENCE"
  | "OP_ANCESTRY_HASH_CHAIN"
  | "OP_ANCESTRY_TERMINAL_MATCHES_SUBJECT"
  | "OP_FINALIZED_HEAD_STABLE";

export interface OpStackConsistencyCheck {
  readonly code: OpStackConsistencyCheckCode;
  readonly passed: boolean;
  /** Deterministic human-readable detail; present on failures. */
  readonly detail?: string;
}

/** Minimal hash+height projection of one observed block. */
export interface ObservedBlockRef {
  readonly hash: string;
  readonly number: bigint;
}

/**
 * One REQUIRED finalized-head -> subject ancestry walk as observed.
 *
 * `blocks` holds the walked PARENT blocks in walk order (the parent of the
 * observed finalized head first, ..., the terminal block at height S last).
 * A `null` entry means the source returned no block for that parentHash —
 * first-class captured evidence of an unprovable link, never an error.
 * The walk is required exactly when an observed finalized head lies at or
 * above the subject height; it is performed at most once per observation.
 */
export interface OpStackAncestryWalkObservation {
  /** Required parent reads for a complete walk: F.number - S (<= configured bound). */
  readonly requiredDepth: bigint;
  /** Explicit maximum ancestry depth configured for this acquisition. */
  readonly maxDepth: number;
  /** Walked parent blocks in order; truncated at the first broken link. */
  readonly blocks: readonly (ObservedBlockRef & { readonly parentHash: string } | null)[];
}

export interface OpStackConsistencyInput {
  readonly expectedChainId: bigint;
  readonly observedChainId: bigint;
  /** Subject containing-block height S observed by the generic EVM flow. */
  readonly subjectBlockNumber: bigint;
  /** Subject containing-block hash Hs observed by the generic EVM flow. */
  readonly subjectBlockHash: string;
  /** Canonical block returned for EXACT height S (null = none returned). */
  readonly canonicalSubjectBlock?: ObservedBlockRef | null;
  /** Observed "safe" head (null = source returned no block). */
  readonly safeHead?: ObservedBlockRef | null;
  /**
   * Observed "finalized" head (null = source returned no block). When an
   * ancestry walk is supplied, the head MUST carry its observed parentHash:
   * it is the origin of the walked chain.
   */
  readonly finalizedHead?: (ObservedBlockRef & { readonly parentHash?: string }) | null;
  /** Observed "latest" head (null = source returned no block). */
  readonly latestHead?: ObservedBlockRef | null;
  /**
   * The required finalized->subject ancestry walk; present exactly when a
   * walk was required (observed finalized head at/above the subject height).
   */
  readonly ancestryWalk?: OpStackAncestryWalkObservation;
  /**
   * Finalized-head stability re-read closing the observation burst
   * (undefined = not performed, null = source returned no block).
   */
  readonly finalizedReRead?: ObservedBlockRef | null;
  /** Hash of the finalized head as FIRST observed in the burst. */
  readonly initialFinalizedHash?: string;
}

function check(
  code: OpStackConsistencyCheckCode,
  passed: boolean,
  detail?: string,
): OpStackConsistencyCheck {
  return passed ? { code, passed: true } : { code, passed: false, detail };
}

function decimal(value: bigint): string {
  return value.toString(10);
}

/**
 * Assemble all OP Stack consistency checks in a fixed deterministic order:
 * chain identity, head ordering/coherence, required ancestry, canonical
 * exact-height subject view, burst stability.
 */
export function runOpStackConsistencyChecks(input: OpStackConsistencyInput): OpStackConsistencyCheck[] {
  const checks: OpStackConsistencyCheck[] = [];

  checks.push(
    check(
      "OP_CHAIN_ID_MATCHES_SOURCE",
      input.observedChainId === input.expectedChainId,
      `eth_chainId=${input.observedChainId} configured=${input.expectedChainId}`,
    ),
  );

  // Head coherence is only assertable over OBSERVED values: a missing head
  // is an availability question for the evaluator ("insufficient"), never
  // an incoherence conflict.
  if (input.safeHead != null && input.finalizedHead != null) {
    const safe = input.safeHead;
    const finalized = input.finalizedHead;
    checks.push(
      check(
        "OP_FINALIZED_NOT_AHEAD_OF_SAFE",
        finalized.number <= safe.number,
        `finalized.number=${decimal(finalized.number)} safe.number=${decimal(safe.number)}`,
      ),
      check(
        "OP_SAFE_NOT_AHEAD_OF_LATEST",
        input.latestHead == null || safe.number <= input.latestHead.number,
        input.latestHead == null
          ? "latest head unavailable"
          : `safe.number=${decimal(safe.number)} latest.number=${decimal(input.latestHead.number)}`,
      ),
      check(
        "OP_SAFE_FINALIZED_COHERENT_AT_EQUAL_HEIGHT",
        finalized.number !== safe.number || finalized.hash === safe.hash,
        `equal head heights must carry equal hashes: finalized=${finalized.hash} safe=${safe.hash}`,
      ),
    );
  }

  // --- required finalized -> subject ancestry ---------------------------------
  if (input.ancestryWalk !== undefined) {
    const walk = input.ancestryWalk;
    if (walk.requiredDepth > BigInt(walk.maxDepth)) {
      // Fail closed BEFORE any walk: the required parentHash chain exceeds
      // the explicitly configured maximum depth, so ancestry cannot be
      // established within this ruleset's evidentiary budget.
      checks.push(
        check(
          "OP_ANCESTRY_WALK_EXCEEDS_LIMIT",
          false,
          `required ancestry depth ${decimal(walk.requiredDepth)} exceeds the configured maximum ${walk.maxDepth}; no walk was performed`,
        ),
      );
    } else {
      // Fold every executed link into two aggregate invariants, stopping at
      // the first broken link (the acquisition truncates there too). The
      // walk ORIGIN is the observed finalized head itself, so a zero-depth
      // walk (finalized head exactly at the subject height) has the head as
      // its terminal block.
      let child: { readonly number: bigint; readonly parentHash?: string } | undefined =
        input.finalizedHead ?? undefined;
      let heightSequenceFailed: string | undefined;
      let hashChainFailed: string | undefined;
      let terminalHash: string | undefined = input.finalizedHead?.hash;
      for (let i = 0; i < walk.blocks.length; i++) {
        if (child === undefined) break;
        const parent = walk.blocks[i];
        const expectedParentHeight = child.number - 1n;
        if (parent == null) {
          const unavailable = `ancestor at expected height ${decimal(expectedParentHeight)} (link ${i + 1} of ${decimal(walk.requiredDepth)}) was not returned by the source`;
          heightSequenceFailed ??= unavailable;
          hashChainFailed ??= unavailable;
          break;
        }
        if (parent.number !== expectedParentHeight) {
          heightSequenceFailed ??= `link ${i + 1}: parent.number=${decimal(parent.number)} but child.number-1=${decimal(expectedParentHeight)}`;
          break;
        }
        if (child.parentHash !== parent.hash) {
          hashChainFailed ??= `link ${i + 1}: child.parentHash=${String(child.parentHash)} != parent.hash=${parent.hash}`;
          break;
        }
        terminalHash = parent.hash;
        child = parent;
      }
      const completed =
        heightSequenceFailed === undefined &&
        hashChainFailed === undefined &&
        Number(walk.requiredDepth) === walk.blocks.length &&
        child !== undefined &&
        child.number === input.subjectBlockNumber;
      if (heightSequenceFailed !== undefined) {
        checks.push(check("OP_ANCESTRY_HEIGHT_SEQUENCE", false, heightSequenceFailed));
      }
      if (hashChainFailed !== undefined) {
        checks.push(check("OP_ANCESTRY_HASH_CHAIN", false, hashChainFailed));
      }
      if (completed && terminalHash !== undefined) {
        checks.push(
          check(
            "OP_ANCESTRY_TERMINAL_MATCHES_SUBJECT",
            terminalHash === input.subjectBlockHash,
            `terminal ancestry block at height ${decimal(input.subjectBlockNumber)}: hash=${terminalHash} subject=${input.subjectBlockHash}`,
          ),
        );
      }
    }
  }

  if (input.canonicalSubjectBlock !== undefined) {
    if (input.canonicalSubjectBlock === null) {
      checks.push(
        check(
          "OP_CANONICAL_BLOCK_NUMBER_MATCHES_SUBJECT",
          false,
          `the source returned no block at the subject height ${decimal(input.subjectBlockNumber)}`,
        ),
        check(
          "OP_SUBJECT_BLOCK_STILL_CANONICAL",
          false,
          "no canonical block was observed at the subject height",
        ),
      );
    } else {
      const canonical = input.canonicalSubjectBlock;
      checks.push(
        check(
          "OP_CANONICAL_BLOCK_NUMBER_MATCHES_SUBJECT",
          canonical.number === input.subjectBlockNumber,
          `canonical.number=${decimal(canonical.number)} subject=${decimal(input.subjectBlockNumber)}`,
        ),
        check(
          "OP_SUBJECT_BLOCK_STILL_CANONICAL",
          canonical.hash === input.subjectBlockHash,
          `canonical.hash=${canonical.hash} subject=${input.subjectBlockHash}`,
        ),
      );
    }
  }

  // Burst stability: the finalized head must be unchanged between its first
  // observation and the re-read that closes the ancestry observation burst.
  if (input.finalizedReRead !== undefined && input.initialFinalizedHash !== undefined) {
    const reRead = input.finalizedReRead;
    checks.push(
      check(
        "OP_FINALIZED_HEAD_STABLE",
        reRead !== null && reRead.hash === input.initialFinalizedHash,
        reRead === null
          ? "the stability re-read returned no finalized block"
          : `first finalized hash=${input.initialFinalizedHash} re-read hash=${reRead.hash}`,
      ),
    );
  }

  return checks;
}

/** True iff every supplied check passed. */
export function allOpStackChecksPassed(checks: readonly OpStackConsistencyCheck[]): boolean {
  return checks.every((c) => c.passed);
}
