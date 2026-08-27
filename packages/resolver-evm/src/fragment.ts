/**
 * PURE projection helpers: normalized acquisition pieces -> core artifact
 * fragments (NetworkFingerprint, ObservedEffect, Conflict, evidence
 * citation index).
 *
 * This layer owns NO proposition semantics: it never decides verdicts,
 * applicability or conflict materiality. It only converts already-validated
 * observations into the frozen core contracts deterministically:
 *
 *   - bigint quantities become exact decimal strings in generic JSON-safe
 *     fields (never numbers, never bigint),
 *   - observed-effect ids are content digests (same log => same id),
 *   - conflict ids are stable functions of the failed check and its target.
 *
 * No clock, no randomness, no environment, no network.
 */

import { digestCanonicalJson } from "@nec/core";
import type { Conflict, EvidenceRef, NetworkFingerprint, ObservedEffect, PropositionScope } from "@nec/core";

import type { EvmTransactionAcquisition } from "./acquire.js";
import type { EvmConsistencyCheck } from "./checks.js";
import { NecResolverEvmError } from "./errors.js";
import type { EvmLogObservation } from "./normalize.js";
import { toNetworkFingerprint } from "./evidence.js";

/** Digest domain for observed-effect identity derivation. */
export const LOG_EFFECT_DIGEST_DOMAIN = "nec.resolver-evm.log-effect";

/** Generic, non-protocol-specific observed-effect type for EVM logs. */
export const EVM_LOG_EFFECT_TYPE = "evm.log";

/** Prefix for evaluator-emitted conflict ids. */
export const CONFLICT_ID_PREFIX = "nec-evm-conflict";

/**
 * Project the acquisition's network context into a valid core
 * NetworkFingerprint. When the block was observed, the anchor is that block
 * (via the existing foundation helper). Otherwise the fingerprint carries an
 * EMPTY anchor: no block observation exists and none is invented. An empty
 * anchor never implies anything about finality or settlement.
 */
export function buildEvaluationFingerprint(acquisition: EvmTransactionAcquisition): NetworkFingerprint {
  if (acquisition.block) {
    return toNetworkFingerprint(acquisition);
  }
  return {
    networkId: acquisition.source.networkId,
    ...(Number.isSafeInteger(acquisition.source.chainId) ? { chainId: acquisition.source.chainId } : {}),
    observedAt: {},
  };
}

/**
 * Deterministic citation index over `buildEvidenceRefs(acquisition)` output:
 * capture order is fixed by the acquisition pipeline, so each logical read
 * maps to at most one EvidenceRef id. Values are undefined when that read
 * was not performed (or, for receipt/block/transaction, returned nothing —
 * a null result still produces a capture, hence a ref).
 */
export interface CaptureEvidenceIndex {
  readonly chainId?: string;
  readonly receipt?: string;
  readonly block?: string;
  readonly transaction?: string;
}

export function captureEvidenceIndex(
  acquisition: EvmTransactionAcquisition,
  refs: readonly EvidenceRef[],
): CaptureEvidenceIndex {
  if (refs.length !== acquisition.captures.length) {
    throw new NecResolverEvmError(
      "EVM_OBSERVATION_INCOMPLETE",
      "evidence refs must be built from the same acquisition (one ref per capture)",
    );
  }
  const index: { chainId?: string; receipt?: string; block?: string; transaction?: string } = {};
  for (let i = 0; i < acquisition.captures.length; i++) {
    const capture = acquisition.captures[i] as EvmTransactionAcquisition["captures"][number];
    const ref = refs[i] as EvidenceRef;
    switch (capture.rpcMethod) {
      case "eth_chainId":
        index.chainId ??= ref.id;
        break;
      case "eth_getTransactionReceipt":
        index.receipt ??= ref.id;
        break;
      case "eth_getBlockByHash":
        index.block ??= ref.id;
        break;
      case "eth_getTransactionByHash":
        index.transaction ??= ref.id;
        break;
      default:
        break;
    }
  }
  return index;
}

/**
 * Exact decimal string of a non-negative bigint — THE precision-safe JSON
 * representation used inside generic effect fields.
 */
export function decimalString(value: bigint): string {
  if (value < 0n) {
    throw new NecResolverEvmError("EVM_MALFORMED_RESPONSE", "negative quantities cannot appear in effect fields");
  }
  return value.toString(10);
}

/**
 * Build ONE generic observed effect from ONE coherent receipt log.
 *
 * Fields are JSON-safe by construction: every bigint becomes an exact
 * decimal string; `removed` is preserved as observed (callers must not emit
 * effects for logs whose consistency checks failed — this builder records,
 * it does not judge).
 *
 * The id derives from the effect's identifying content via a
 * domain-separated canonical digest: same log bytes => same id, always.
 */
export function buildLogObservedEffect(log: EvmLogObservation, receiptEvidenceId: string): ObservedEffect {
  const fields: Record<string, unknown> = {
    address: log.address,
    topics: [...log.topics],
    data: log.data,
    blockNumber: decimalString(log.blockNumber),
    blockHash: log.blockHash,
    transactionHash: log.transactionHash,
    transactionIndex: decimalString(log.transactionIndex),
    logIndex: decimalString(log.logIndex),
    removed: log.removed,
  };
  const digest = digestCanonicalJson(LOG_EFFECT_DIGEST_DOMAIN, fields);
  const id = `evm-log-${digest.slice("sha256:".length, "sha256:".length + 16)}`;
  return {
    id,
    type: EVM_LOG_EFFECT_TYPE,
    fields,
    basis: ["source_observation"],
    evidence: [receiptEvidenceId],
  };
}

/**
 * Build one core Conflict from ONE failed consistency check.
 *
 * The scope is supplied by the proposition layer (which owns semantics);
 * this builder guarantees the core contract shape: explicit scope, NEC
 * identifier id/code, non-empty citations for material conflicts and a
 * deterministic id (`<prefix>:<code>:<qualifier>`).
 */
export function buildCheckConflict(args: {
  check: EvmConsistencyCheck;
  qualifier: string;
  scope: PropositionScope;
  material: boolean;
  evidenceIds: readonly string[];
  description: string;
}): Conflict {
  const code = args.check.code;
  const id = `${CONFLICT_ID_PREFIX}:${code}:${args.qualifier}`;
  return {
    id,
    code,
    description: args.description,
    scope: args.scope,
    // Structural dedupe of identical citations keeps the conflict identity
    // permutation-invariant (set-like collection semantics).
    evidence: [...new Set(args.evidenceIds)],
    material: args.material,
    ...(args.check.detail === undefined ? {} : { metadata: { checkDetail: args.check.detail } }),
  };
}
