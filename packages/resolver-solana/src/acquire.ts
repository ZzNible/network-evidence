import { assertIso8601, deepFreeze } from "@nec/core";
import type { Iso8601 } from "@nec/core";

import { parseGenesisHash, parseSignature } from "./base58.js";
import { NecResolverSolanaError } from "./errors.js";
import { parseBlockResult, parseGenesisHashResult, parseSignatureStatusesResult, parseTransactionResult } from "./normalize.js";
import type { SolanaBlockObservation, SolanaSignatureStatusObservation, SolanaTransactionObservation } from "./normalize.js";
import { createRpcReader, SOURCE_TYPE, stableJsonKey, validateSource } from "./rpc.js";
import type { FetchLike, SolanaRpcCapture, SolanaRpcSourceDescriptor, SolanaSourceProvenance } from "./rpc.js";

export const ACQUISITION_PROFILE = "nec-resolver-solana-acquisition-v1";
export const REPLAY_ENDPOINT = "http://nec-resolver-solana.replay.invalid/";

export interface SolanaConsistencyCheck {
  readonly code: string;
  readonly passed: boolean;
  readonly detail?: string;
}

export interface SolanaTransactionAcquisition {
  readonly profile: typeof ACQUISITION_PROFILE;
  readonly source: SolanaSourceProvenance;
  readonly subject: { readonly signature: string };
  readonly acquiredAt: Iso8601;
  readonly genesisHash: string;
  readonly transaction: SolanaTransactionObservation | null;
  readonly signatureStatus: SolanaSignatureStatusObservation;
  readonly block?: SolanaBlockObservation | null;
  readonly captures: readonly SolanaRpcCapture[];
  readonly checks: readonly SolanaConsistencyCheck[];
  readonly consistent: boolean;
}

export interface SolanaAcquisitionInput {
  readonly source: SolanaRpcSourceDescriptor;
  readonly signature: string;
  readonly now: Iso8601;
  readonly fetchFn: FetchLike | undefined;
}

export async function acquireSolanaTransaction(input: SolanaAcquisitionInput): Promise<SolanaTransactionAcquisition> {
  validateSource(input.source);
  if (input.fetchFn === undefined) throw new NecResolverSolanaError("SOLANA_RPC_REQUEST_FAILED", "acquisition requires an explicit fetchFn; implicit global network access is refused");
  return runSolanaAcquisitionPipeline({
    provenance: {
      sourceId: input.source.sourceId,
      sourceType: SOURCE_TYPE,
      networkId: input.source.networkId,
      ...(input.source.independenceGroup === undefined ? {} : { independenceGroup: input.source.independenceGroup }),
    },
    endpoint: input.source.transport.url,
    signature: input.signature,
    now: input.now,
    fetchFn: input.fetchFn,
  });
}

function comparableError(value: unknown): string {
  return stableJsonKey(value);
}

export async function runSolanaAcquisitionPipeline(args: {
  provenance: SolanaSourceProvenance;
  endpoint: string;
  signature: string;
  now: Iso8601;
  fetchFn: FetchLike;
}): Promise<SolanaTransactionAcquisition> {
  assertIso8601(args.now, "acquisition.now");
  const signature = parseSignature(args.signature);
  const configuredGenesis = parseGenesisHash(args.provenance.networkId.slice("solana:".length), "configured network genesis hash");
  const rpc = createRpcReader({ provenance: args.provenance, endpoint: args.endpoint, now: args.now, fetchFn: args.fetchFn });

  const genesisHash = parseGenesisHashResult((await rpc.read("getGenesisHash", [])).value);
  const observedNetworkReference = genesisHash.slice(0, 32);
  if (observedNetworkReference !== configuredGenesis) throw new NecResolverSolanaError("SOLANA_NETWORK_MISMATCH", `source full genesis ${genesisHash} derives network reference ${observedNetworkReference} but networkId binds ${configuredGenesis}`);

  const transaction = parseTransactionResult((await rpc.read("getTransaction", [signature, {
    commitment: "finalized", encoding: "json", maxSupportedTransactionVersion: 0,
  }])).value);
  const signatureStatus = parseSignatureStatusesResult((await rpc.read("getSignatureStatuses", [[signature], { searchTransactionHistory: true }])).value);
  let block: SolanaBlockObservation | null | undefined;
  if (transaction !== null) {
    block = parseBlockResult((await rpc.read("getBlock", [Number(transaction.slot), {
      commitment: "finalized", transactionDetails: "none", rewards: false, maxSupportedTransactionVersion: 0,
    }])).value);
  }

  const checks: SolanaConsistencyCheck[] = [];
  if (transaction !== null) {
    checks.push({ code: "TRANSACTION_SIGNATURE_MATCHES_SUBJECT", passed: transaction.signatures[0] === signature });
    if (signatureStatus.value === null) {
      checks.push({ code: "SIGNATURE_STATUS_PRESENT", passed: false, detail: "status entry is null" });
    } else {
      checks.push({ code: "SIGNATURE_STATUS_PRESENT", passed: true });
      checks.push({ code: "STATUS_SLOT_MATCHES_TRANSACTION", passed: signatureStatus.value.slot === transaction.slot });
      checks.push({ code: "STATUS_ERROR_MATCHES_TRANSACTION", passed: comparableError(signatureStatus.value.err) === comparableError(transaction.executionError) });
    }
    checks.push({ code: "CONTAINING_BLOCK_PRESENT", passed: block !== null });
    if (block !== null && block !== undefined) {
      checks.push({ code: "BLOCK_PARENT_PRECEDES_SLOT", passed: block.parentSlot < transaction.slot });
    }
  }
  const acquisition: SolanaTransactionAcquisition = {
    profile: ACQUISITION_PROFILE,
    source: args.provenance,
    subject: { signature },
    acquiredAt: args.now,
    genesisHash,
    transaction,
    signatureStatus,
    ...(block === undefined ? {} : { block }),
    captures: rpc.captures,
    checks,
    consistent: checks.every((check) => check.passed),
  };
  return deepFreeze(acquisition);
}
