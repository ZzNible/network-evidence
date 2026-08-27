/**
 * CONSISTENCY INVARIANTS over normalized observations.
 *
 * Two failure classes are deliberately separated:
 *
 *   1. STRUCTURAL malformation (unparseable/ill-typed data) fails closed
 *      immediately with a controlled error — nothing claimable can be
 *      built from it.
 *   2. SEMANTIC incoherence between values the provider actually returned
 *      (receipt vs block vs transaction vs logs) is EVIDENCE about the
 *      source: it is captured as failed consistency checks inside the
 *      observation instead of being hidden or thrown away. The later
 *      proposition evaluator turns failed checks into NEC conflicts.
 *
 * Agreement between RPC-returned values is correlation, never
 * cryptographic proof; nothing here claims more than "the same provider
 * returned coherent values".
 */

export type EvmConsistencyCheckCode =
  | "CHAIN_ID_MATCHES_SOURCE"
  | "RECEIPT_TX_HASH_MATCHES_SUBJECT"
  | "RECEIPT_BLOCK_HASH_MATCHES_BLOCK"
  | "RECEIPT_BLOCK_NUMBER_MATCHES_BLOCK"
  | "TRANSACTION_COHERENT_WITH_RECEIPT"
  | "LOG_BLOCK_COHERENT"
  | "LOG_TRANSACTION_COHERENT"
  | "LOG_NOT_REMOVED";

export interface EvmConsistencyCheck {
  readonly code: EvmConsistencyCheckCode;
  readonly passed: boolean;
  /** Deterministic human-readable detail; present on failures (and chain id). */
  readonly detail?: string;
}

export interface ConsistencyInput {
  readonly expectedTxHash: string;
  readonly expectedChainId: bigint;
  readonly observedChainId: bigint;
  readonly receipt?: {
    readonly transactionHash: string;
    readonly blockHash: string;
    readonly blockNumber: bigint;
    readonly transactionIndex?: bigint;
    readonly logs: readonly {
      readonly blockHash: string;
      readonly blockNumber: bigint;
      readonly transactionHash: string;
      readonly logIndex: bigint;
      readonly removed: boolean;
    }[];
  };
  /** Present = acquired; null = queried but the source returned no block. */
  readonly block?: { readonly hash: string; readonly number: bigint } | null;
  readonly transaction?: {
    readonly hash: string;
    readonly blockHash: string | null;
    readonly blockNumber: bigint | null;
    readonly transactionIndex: bigint | null;
  } | null;
}

function check(code: EvmConsistencyCheckCode, passed: boolean, detail?: string): EvmConsistencyCheck {
  return passed ? { code, passed: true } : { code, passed: false, detail };
}

/** Assemble all generic consistency checks in a fixed deterministic order. */
export function runConsistencyChecks(input: ConsistencyInput): EvmConsistencyCheck[] {
  const checks: EvmConsistencyCheck[] = [];

  checks.push(
    check(
      "CHAIN_ID_MATCHES_SOURCE",
      input.observedChainId === input.expectedChainId,
      `eth_chainId=${input.observedChainId} configured=${input.expectedChainId}`,
    ),
  );

  if (!input.receipt) return checks;

  checks.push(
    check(
      "RECEIPT_TX_HASH_MATCHES_SUBJECT",
      input.receipt.transactionHash === input.expectedTxHash,
      `receipt.transactionHash=${input.receipt.transactionHash} requested=${input.expectedTxHash}`,
    ),
  );

  if (input.block !== undefined) {
    if (input.block === null) {
      checks.push(
        check(
          "RECEIPT_BLOCK_HASH_MATCHES_BLOCK",
          false,
          `receipt.blockHash=${input.receipt?.blockHash ?? "unknown"} but the source returned no block`,
        ),
      );
    } else {
      checks.push(
        check(
          "RECEIPT_BLOCK_HASH_MATCHES_BLOCK",
          input.receipt.blockHash === input.block.hash,
          `receipt.blockHash=${input.receipt.blockHash} block.hash=${input.block.hash}`,
        ),
        check(
          "RECEIPT_BLOCK_NUMBER_MATCHES_BLOCK",
          input.receipt.blockNumber === input.block.number,
          `receipt.blockNumber=${input.receipt.blockNumber} block.number=${input.block.number}`,
        ),
      );
    }
  }

  if (input.transaction !== undefined) {
    const tx = input.transaction;
    if (tx === null) {
      checks.push(
        check("TRANSACTION_COHERENT_WITH_RECEIPT", false, "transaction not found although its receipt exists"),
      );
    } else {
      const coherent =
        tx.hash === input.expectedTxHash &&
        tx.blockHash === input.receipt.blockHash &&
        tx.blockNumber === input.receipt.blockNumber &&
        tx.transactionIndex !== null &&
        tx.transactionIndex === input.receipt.transactionIndex;
      checks.push(
        check(
          "TRANSACTION_COHERENT_WITH_RECEIPT",
          coherent,
          coherent
            ? undefined
            : `tx.hash=${tx.hash} tx.blockHash=${String(tx.blockHash)} tx.blockNumber=${String(tx.blockNumber)} tx.transactionIndex=${String(tx.transactionIndex)}`,
        ),
      );
    }
  }

  for (const log of input.receipt.logs) {
    checks.push(
      check(
        "LOG_BLOCK_COHERENT",
        log.blockHash === input.receipt.blockHash && log.blockNumber === input.receipt.blockNumber,
        `logIndex=${log.logIndex} log.blockHash=${log.blockHash} log.blockNumber=${log.blockNumber}`,
      ),
      check(
        "LOG_TRANSACTION_COHERENT",
        log.transactionHash === input.receipt.transactionHash,
        `logIndex=${log.logIndex} log.transactionHash=${log.transactionHash}`,
      ),
      check("LOG_NOT_REMOVED", !log.removed, `logIndex=${log.logIndex} removed=true`),
    );
  }

  return checks;
}

/** True iff every supplied check passed. */
export function allChecksPassed(checks: readonly EvmConsistencyCheck[]): boolean {
  return checks.every((c) => c.passed);
}
