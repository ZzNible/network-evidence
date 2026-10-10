/**
 * Explicit v1 follow-up read for a previously acquired Solana transaction.
 * Uses getBlock(transactionDetails:"signatures") and checks direct membership
 * in THAT block's source-reported signature list. Historic 4-read F3 replay
 * and all native Core fragments remain unchanged.
 *
 * This is single-RPC source observation, NOT cryptographic verification,
 * economic irreversibility, or a settlement/finality claim.
 */
import { assertIso8601, deepFreeze } from "@nec/core";
import type { Iso8601 } from "@nec/core";

import { ACQUISITION_PROFILE } from "./acquire.js";
import type { SolanaTransactionAcquisition } from "./acquire.js";
import { parseSignature } from "./base58.js";
import { NecResolverSolanaError, solanaFail } from "./errors.js";
import { parseBlockResult } from "./normalize.js";
import { createRpcReader, validateSource } from "./rpc.js";
import type { FetchLike, SolanaRpcCapture, SolanaRpcSourceDescriptor, SolanaSourceProvenance } from "./rpc.js";

export const SOLANA_BLOCK_MEMBERSHIP_PROFILE = "nec-resolver-solana-block-signature-membership-v1";
export const SOLANA_BLOCK_SIGNATURE_MAX_COUNT = 6_000;

export interface SolanaBlockMembershipV1 {
  readonly profile: typeof SOLANA_BLOCK_MEMBERSHIP_PROFILE;
  readonly source: SolanaSourceProvenance;
  readonly subject: { readonly signature: string; readonly slot?: bigint };
  readonly observedAt: Iso8601;
  readonly basis: readonly ["source_observation", "deterministic_derivation"];
  /** Membership according to one RPC provider's block signature list ONLY. */
  readonly verdict: "supported" | "ambiguous" | "insufficient";
  readonly reason:
    | "SIGNATURE_IN_EXACT_BLOCK"
    | "SIGNATURE_ABSENT_FROM_REPORTED_BLOCK"
    | "BLOCK_IDENTITY_DISAGREEMENT"
    | "BLOCK_UNAVAILABLE"
    | "BASELINE_INSUFFICIENT"
    | "BASELINE_INCONSISTENT";
  readonly signatureCount?: number;
  readonly signatureIndex?: number;
  readonly observedBlockhash?: string;
  /** Digests of all ORIGINAL native acquisition captures. Traceability only,
   * not independent authentication of the caller-provided source descriptor. */
  readonly baselineCaptureDigests: readonly string[];
  /** Exact source payload with native capture digest. */
  readonly captures: readonly SolanaRpcCapture[];
}

export interface SolanaBlockMembershipInput {
  readonly acquisition: SolanaTransactionAcquisition;
  readonly source: SolanaRpcSourceDescriptor;
  readonly now: Iso8601;
  readonly fetchFn: FetchLike | undefined;
}

function provenanceFrom(source: SolanaRpcSourceDescriptor): SolanaSourceProvenance {
  return {
    sourceId: source.sourceId,
    sourceType: source.sourceType,
    networkId: source.networkId,
    ...(source.independenceGroup === undefined ? {} : { independenceGroup: source.independenceGroup }),
  };
}

/**
 * A narrow versioned SDK observation, NOT an automatic upgrade of the old
 * getBlock(none) fragment, and NOT a remote-MCP public API or Core verdict.
 */
export async function acquireSolanaBlockSignatureMembershipV1(
  input: SolanaBlockMembershipInput,
): Promise<SolanaBlockMembershipV1> {
  validateSource(input.source);
  assertIso8601(input.now, "block-membership.now");
  const acquisition = input.acquisition;
  if (acquisition?.profile !== ACQUISITION_PROFILE ||
      acquisition.source === undefined ||
      acquisition.subject === undefined ||
      typeof acquisition.subject.signature !== "string" ||
      typeof acquisition.genesisHash !== "string" ||
      acquisition.transaction === undefined ||
      acquisition.signatureStatus === undefined ||
      !Array.isArray(acquisition.captures) ||
      !Array.isArray(acquisition.checks) ||
      !acquisition.captures.every(c => c !== null && typeof c === "object" &&
        typeof c.contentDigest === "string")) {
    solanaFail("SOLANA_INPUT_INVALID", "block membership requires one complete native v1 Solana acquisition");
  }
  if (input.fetchFn === undefined) {
    solanaFail("SOLANA_RPC_REQUEST_FAILED", "block membership requires an explicit fetchFn");
  }
  const subject = parseSignature(acquisition.subject.signature, "block-membership subject");
  const source = provenanceFrom(input.source);
  const original = acquisition.source;
  if (source.sourceId !== original.sourceId ||
      source.sourceType !== original.sourceType ||
      source.networkId !== original.networkId ||
      source.independenceGroup !== original.independenceGroup ||
      acquisition.genesisHash.slice(0, 32) !== source.networkId.slice("solana:".length) ||
      acquisition.captures.some(cap => cap.sourceId !== source.sourceId ||
        cap.networkId !== source.networkId || cap.sourceType !== source.sourceType)) {
    solanaFail("SOLANA_NETWORK_MISMATCH", "block signature membership cannot cross original RPC source, provenance or genesis");
  }

  const transaction = acquisition.transaction;
  const priorBlock = acquisition.block;
  const slot = transaction?.slot ?? 0n;
  const result = (
    verdict: SolanaBlockMembershipV1["verdict"],
    reason: SolanaBlockMembershipV1["reason"],
    captures: readonly SolanaRpcCapture[],
    extras: { signatureCount?: number; signatureIndex?: number; observedBlockhash?: string } = {},
  ): SolanaBlockMembershipV1 => deepFreeze({
    profile: SOLANA_BLOCK_MEMBERSHIP_PROFILE,
    source, subject: { signature: subject, ...(transaction === null ? {} : { slot }) }, observedAt: input.now,
    basis: ["source_observation", "deterministic_derivation"] as const,
    baselineCaptureDigests: acquisition.captures.map(c => c.contentDigest),
    verdict, reason, ...extras, captures,
  });

  if (transaction === null || priorBlock === null || priorBlock === undefined) {
    return result("insufficient", "BASELINE_INSUFFICIENT", []);
  }
  const required = [
    "TRANSACTION_SIGNATURE_MATCHES_SUBJECT",
    "SIGNATURE_STATUS_PRESENT",
    "STATUS_SLOT_MATCHES_TRANSACTION",
    "STATUS_ERROR_MATCHES_TRANSACTION",
    "CONTAINING_BLOCK_PRESENT",
    "BLOCK_PARENT_PRECEDES_SLOT",
  ];
  // Recompute the key source identity and slot relationships; do not trust
  // only caller-supplied booleans in an old normalized acquisition.
  if (!acquisition.consistent ||
      transaction.signatures[0] !== subject ||
      acquisition.signatureStatus.value === null ||
      acquisition.signatureStatus.value.slot !== transaction.slot ||
      priorBlock.parentSlot >= transaction.slot ||
      !acquisition.checks.every(c => c.passed) ||
      required.some(code => acquisition.checks.filter(c => c.code === code && c.passed).length !== 1)) {
    return result("ambiguous", "BASELINE_INCONSISTENT", []);
  }
  if (transaction.slot < 0n || transaction.slot > BigInt(Number.MAX_SAFE_INTEGER)) {
    solanaFail("SOLANA_INPUT_INVALID", "block signature membership requires a safe RPC slot");
  }
  const rpc = createRpcReader({
    provenance: source,
    endpoint: input.source.transport.url,
    now: input.now,
    fetchFn: input.fetchFn,
  });
  const blockResult = (await rpc.read("getBlock", [
    Number(transaction.slot),
    { commitment: "finalized", transactionDetails: "signatures", rewards: false, maxSupportedTransactionVersion: 0 },
  ])).value;
  const block = parseBlockResult(blockResult);
  if (block === null) {
    return result("insufficient", "BLOCK_UNAVAILABLE", rpc.captures);
  }
  // A missing or malformed signature list must fail as malformed RPC data,
  // never be misrepresented as proof of absence on the network.
  if (blockResult === null || typeof blockResult !== "object" || Array.isArray(blockResult) ||
      !Object.hasOwn(blockResult, "signatures")) {
    solanaFail("SOLANA_MALFORMED_RESPONSE", "getBlock(signatures): mandatory signatures list is missing");
  }
  const raw = (blockResult as Record<string, unknown>).signatures;
  if (!Array.isArray(raw) || raw.length > SOLANA_BLOCK_SIGNATURE_MAX_COUNT) {
    solanaFail("SOLANA_MALFORMED_RESPONSE", "getBlock(signatures): expected bounded signature array");
  }
  const signatures: string[] = [];
  const unique = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    let parsed: string;
    try { parsed = parseSignature(entry, "getBlock.signatures[" + index + "]"); }
    catch { solanaFail("SOLANA_MALFORMED_RESPONSE", "getBlock(signatures): noncanonical signature entry"); }
    if (unique.has(parsed)) {
      solanaFail("SOLANA_MALFORMED_RESPONSE", "getBlock(signatures): duplicate signature entry");
    }
    unique.add(parsed);
    signatures.push(parsed);
  }
  const extras = { signatureCount: signatures.length, observedBlockhash: block.blockhash };
  if (block.blockhash !== priorBlock.blockhash ||
      block.previousBlockhash !== priorBlock.previousBlockhash ||
      block.parentSlot !== priorBlock.parentSlot ||
      block.blockTime !== priorBlock.blockTime ||
      block.blockHeight !== priorBlock.blockHeight) {
    return result("ambiguous", "BLOCK_IDENTITY_DISAGREEMENT", rpc.captures, extras);
  }
  const index = signatures.indexOf(subject);
  if (index < 0) {
    return result("ambiguous", "SIGNATURE_ABSENT_FROM_REPORTED_BLOCK", rpc.captures, extras);
  }
  return result("supported", "SIGNATURE_IN_EXACT_BLOCK", rpc.captures, {
    ...extras, signatureIndex: index,
  });
}
