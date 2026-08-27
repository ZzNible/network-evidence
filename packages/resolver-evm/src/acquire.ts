/**
 * ACQUISITION orchestration for the preferred read model:
 *
 *   txHash -> eth_chainId (identity gate)
 *          -> eth_getTransactionReceipt
 *          -> eth_getBlockByHash(receipt.blockHash)   [when mined]
 *          [-> eth_getTransactionByHash  when explicitly requested]
 *          -> consistency checks
 *          -> normalized, frozen observation
 *
 * No RPC calls are made "because they exist": a null receipt stops the
 * flow immediately (nothing further is knowable through this source).
 * Every logical read is captured raw and every typed value derives from
 * the capture text — Viem's decoded objects only drive control flow.
 */

import { deepFreeze } from "@nec/core";
import type { Iso8601 } from "@nec/core";
import type { PublicClient } from "viem";

import { buildCapture } from "./capture.js";
import type { EvmRpcCapture } from "./capture.js";
import { allChecksPassed, runConsistencyChecks } from "./checks.js";
import type { ConsistencyInput, EvmConsistencyCheck } from "./checks.js";
import { callViemAction, createSourceClient } from "./client.js";
import type { FetchLike } from "./client.js";
import { NecResolverEvmError, evmFail } from "./errors.js";
import { parseTransactionHashInput } from "./hex.js";
import {
  parseBlockResult,
  parseChainIdResult,
  parseReceiptResult,
  parseTransactionResult,
} from "./normalize.js";
import type {
  EvmBlockObservation,
  EvmChainIdentityObservation,
  EvmReceiptObservation,
  EvmTransactionObservation,
} from "./normalize.js";
import { sourceProvenance, validateAcquisitionClock, validateEvmRpcSourceDescriptor } from "./source.js";
import type { EvmRpcSourceDescriptor, SourceProvenance } from "./source.js";

export const ACQUISITION_PROFILE = "nec-resolver-evm-acquisition-v1";

/**
 * Replay never touches a real endpoint; this sentinel exists only to
 * satisfy transport construction and is recorded nowhere.
 */
export const REPLAY_ENDPOINT = "http://nec-resolver-evm.replay.invalid/";

export interface EvmTransactionAcquisition {
  readonly profile: typeof ACQUISITION_PROFILE;
  readonly source: SourceProvenance;
  readonly subject: { readonly txHash: string };
  readonly acquiredAt: Iso8601;
  /** Chain identity observed from THIS source (eth_chainId result). */
  readonly chain: EvmChainIdentityObservation;
  /** Null means "confirmed absent at acquisition time" (unmined/unknown). */
  readonly receipt: EvmReceiptObservation | null;
  /** Present only when queried; null = source returned no such block. */
  readonly block?: EvmBlockObservation | null;
  readonly transaction?: EvmTransactionObservation | null;
  readonly captures: readonly EvmRpcCapture[];
  readonly checks: readonly EvmConsistencyCheck[];
  /** True iff every consistency check passed. */
  readonly consistent: boolean;
}

export interface TransactionAcquisitionInput {
  readonly source: EvmRpcSourceDescriptor;
  readonly txHash: string;
  /** Explicit acquisition time; never derived from a clock. */
  readonly now: Iso8601;
  /**
   * Network fetch implementation. Live callers pass their configured
   * fetch; tests inject scripted implementations. Refusing implicit
   * global network access keeps acquisitions explicit and auditable.
   */
  readonly fetchFn: FetchLike | undefined;
  /** Also query eth_getTransactionByHash for cross-checks. Default false. */
  readonly includeTransaction?: boolean;
}

/**
 * Acquire one transaction subject from ONE configured source over the live
 * Viem path.
 */
export async function acquireTransactionObservation(
  input: TransactionAcquisitionInput,
): Promise<EvmTransactionAcquisition> {
  validateEvmRpcSourceDescriptor(input.source);
  if (input.fetchFn === undefined) {
    throw new NecResolverEvmError(
      "EVM_RPC_REQUEST_FAILED",
      "acquisition requires an explicit fetchFn; refusing implicit global network access",
    );
  }
  return runAcquisitionPipeline({
    provenance: sourceProvenance(input.source),
    endpointUrl: input.source.transport.url,
    txHash: input.txHash,
    now: input.now,
    includeTransaction: input.includeTransaction === true,
    fetchFn: input.fetchFn,
  });
}

/**
 * THE sequential pipeline shared by live acquisition and fixture replay:
 * dispatch reads one at a time against a recording client, convert each
 * exchange into a validated raw capture, normalize strictly from capture
 * text, then assemble consistency checks over the normalized views.
 */
export async function runAcquisitionPipeline(args: {
  provenance: SourceProvenance;
  endpointUrl: string;
  txHash: string;
  now: Iso8601;
  includeTransaction: boolean;
  fetchFn: FetchLike;
}): Promise<EvmTransactionAcquisition> {
  validateAcquisitionClock(args.now);
  const txHash = parseTransactionHashInput(args.txHash);
  // Reads: chainId + receipt always; block only when mined; transaction
  // only on explicit request (a pending transaction is still evidence).
  const { client, recordings } = createSourceClient(args.endpointUrl, args.fetchFn);

  /**
   * One logical JSON-RPC read via Viem's typed request primitive.
   *
   * Deliberately `client.request` rather than the formatted actions for the
   * evidence reads: formatted actions convert provider-null results
   * (unknown receipt/block) into thrown exceptions, which would DESTROY
   * the captured evidence of absence. Here a null result is a first-class
   * capture and the normalization layer decides what it means.
   */
  function readViaViem(
    url: string,
    clientRef: PublicClient,
    method: string,
    params: unknown[],
  ): Promise<unknown> {
    return callViemAction(method, url, () =>
      // The loose argument shape is intentional: reads are dispatched by
      // method name with positional JSON-RPC params, and provider-null
      // results are preserved as evidence rather than converted to throws.
      clientRef.request({ method, ...(params.length === 0 ? {} : { params }) } as never),
    );
  }

  /**
   * Convert the exchange recorded by the JUST-COMPLETED await into a raw
   * capture. Sequential dispatching guarantees a 1:1 mapping between
   * logical reads and recorded exchanges.
   */
  const captureOfLastRead = (): EvmRpcCapture => {
    const last = recordings[recordings.length - 1];
    if (last === undefined) {
      evmFail("EVM_MALFORMED_RESPONSE", "expected exactly one new recorded exchange per dispatched read");
    }
    return buildCapture({
      provenance: args.provenance,
      rpcMethod: last.rpcMethod,
      rpcRequestId: last.rpcRequestId,
      rpcParams: last.rpcParams,
      httpStatus: last.httpStatus,
      responseBody: last.responseBody,
      acquiredAt: args.now,
    });
  };

  // --- read 1: chain identity (identity gate) ---------------------------------
  await readViaViem(args.endpointUrl, client, "eth_chainId", []);
  const chainCapture = captureOfLastRead();
  const chain = parseChainIdResult(chainCapture.resultText);

  if (chain.chainId !== BigInt(args.provenance.chainId)) {
    throw new NecResolverEvmError(
      "EVM_NETWORK_MISMATCH",
      `source ${args.provenance.sourceId} reports chainId ${chain.chainId} but is configured for chainId ${args.provenance.chainId}`,
    );
  }

  const captures: EvmRpcCapture[] = [chainCapture];

  // --- read 2: transaction receipt ---------------------------------------------
  await readViaViem(args.endpointUrl, client, "eth_getTransactionReceipt", [txHash]);
  const receiptCapture = captureOfLastRead();
  const receipt: EvmReceiptObservation | null = parseReceiptResult(receiptCapture.resultText);
  captures.push(receiptCapture);

  let block: EvmBlockObservation | null | undefined;
  let transaction: EvmTransactionObservation | null | undefined;

  if (receipt !== null) {
    // --- read 3: the referenced block ------------------------------------------
    await readViaViem(args.endpointUrl, client, "eth_getBlockByHash", [receipt.blockHash, false]);
    const blockCapture = captureOfLastRead();
    block = parseBlockResult(blockCapture.resultText);
    captures.push(blockCapture);
  }

  if (args.includeTransaction) {
    await readViaViem(args.endpointUrl, client, "eth_getTransactionByHash", [txHash]);
    const txCapture = captureOfLastRead();
    transaction = parseTransactionResult(txCapture.resultText);
    captures.push(txCapture);
  }

  const expectedReads = captures.length;
  if (recordings.length !== expectedReads) {
    evmFail("EVM_MALFORMED_RESPONSE", `expected exactly ${expectedReads} exchanges, saw ${recordings.length}`);
  }

  const checksInput: ConsistencyInput = {
    expectedTxHash: txHash,
    expectedChainId: BigInt(args.provenance.chainId),
    observedChainId: chain.chainId,
    ...(receipt === null ? {} : { receipt }),
    ...(block === undefined ? {} : { block }),
    ...(transaction === undefined ? {} : { transaction }),
  };
  const checks: EvmConsistencyCheck[] = runConsistencyChecks(checksInput);

  const acquisition: EvmTransactionAcquisition = {
    profile: ACQUISITION_PROFILE,
    source: args.provenance,
    subject: { txHash },
    acquiredAt: args.now,
    chain,
    receipt,
    ...(block === undefined ? {} : { block }),
    ...(transaction === undefined ? {} : { transaction }),
    captures,
    checks,
    consistent: allChecksPassed(checks),
  };
  return deepFreeze(acquisition);
}
