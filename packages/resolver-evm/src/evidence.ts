/**
 * PUBLIC CORE INTEGRATION — foundation helpers.
 *
 * These project normalized acquisitions TOWARD @nec/core artifacts
 * (NetworkFingerprint, SubjectRef, EvidenceRef). Acquisition and
 * proposition evaluation stay separate layers: nothing here claims
 * verdicts, applicability or conflicts. Evidence ids are deterministic
 * functions of capture content, so two sources observing the same
 * subject remain distinguishable provenance.
 */

import { nativeSourceContentDigest, RESOURCE_LIMITS } from "@nec/core";
import type { EvidenceRef, NetworkFingerprint, SubjectRef } from "@nec/core";

import type { EvmRpcCapture } from "./capture.js";
import { CAPTURE_DIGEST_DOMAIN } from "./capture.js";
import { NecResolverEvmError } from "./errors.js";
import type { EvmTransactionAcquisition } from "./acquire.js";

const EVM_ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;

/**
 * Project the acquisition's network context into a core NetworkFingerprint.
 * The anchor is the acquired block (receipt/block agreement is a separate,
 * already-recorded consistency question).
 */
export function toNetworkFingerprint(acquisition: EvmTransactionAcquisition): NetworkFingerprint {
  const block = acquisition.block;
  if (!block) {
    throw new NecResolverEvmError(
      "EVM_OBSERVATION_INCOMPLETE",
      "toNetworkFingerprint requires an acquired block observation (receipt present but block missing or not acquired)",
    );
  }
  // Deterministic timestamp conversion from the captured bigint seconds;
  // magnitudes that would lose millisecond precision omit the timestamp.
  let timestamp: string | undefined;
  const ms = block.timestamp * 1000n;
  if (ms <= BigInt(Number.MAX_SAFE_INTEGER)) {
    timestamp = new Date(Number(ms)).toISOString();
  }
  return {
    networkId: acquisition.source.networkId,
    ...(Number.isSafeInteger(acquisition.source.chainId) ? { chainId: acquisition.source.chainId } : {}),
    observedAt: {
      blockNumber: block.number,
      blockId: block.hash,
      ...(timestamp === undefined ? {} : { timestamp }),
    },
  };
}

/** Core SubjectRef for the acquisition's transaction subject. */
export function toSubjectRef(acquisition: EvmTransactionAcquisition): SubjectRef {
  return {
    type: "transaction",
    networkId: acquisition.source.networkId,
    txId: acquisition.subject.txHash,
  };
}

function shortKindOf(capture: EvmRpcCapture): string {
  switch (capture.rpcMethod) {
    case "eth_getTransactionReceipt":
      return "receipt";
    case "eth_getBlockByHash":
      return "block";
    case "eth_getTransactionByHash":
      return "transaction";
    case "eth_chainId":
      return "chainidentity";
    default:
      return "rpc";
  }
}

/**
 * Build one core EvidenceRef per raw capture:
 *   - `id` derives deterministically from the capture content digest
 *     (same source + same bytes => same id; different source => different id);
 *   - `contentDigest` binds the complete capture record;
 *   - exact provider bytes additionally travel opaquely in `nativeSource`
 *     when they fit the core payload budget;
 *   - no endpoint URL or credential can appear: captures never carry one.
 */
export function buildEvidenceRefs(acquisition: EvmTransactionAcquisition): EvidenceRef[] {
  const refs: EvidenceRef[] = [];
  for (const capture of acquisition.captures) {
    const kind = shortKindOf(capture);
    const idDigestHex = capture.contentDigest.slice("sha256:".length);
    const id = `evm-${kind}-${idDigestHex.slice(0, 16)}`;
    const paramsKey = JSON.stringify(
      capture.rpcParams.length === 1 ? capture.rpcParams[0] : capture.rpcParams,
    );
    const ref: EvidenceRef = {
      id,
      sourceId: capture.sourceId,
      sourceType: capture.sourceType,
      ...(capture.independenceGroup === undefined ? {} : { independenceGroup: capture.independenceGroup }),
      locator: `${capture.rpcMethod}:${paramsKey}`,
      retrievedAt: capture.acquiredAt,
      contentDigest: capture.contentDigest,
      networkId: capture.networkId,
      ...(kind === "receipt" || kind === "block" || kind === "transaction"
        ? receiptAnchorFields(acquisition)
        : {}),
      metadata: {
        rpcMethod: capture.rpcMethod,
        httpStatus: capture.httpStatus,
        captureProfile: capture.profile,
        digestDomain: CAPTURE_DIGEST_DOMAIN,
      },
    };
    const decodedBytes = new TextEncoder().encode(capture.resultText);
    if (decodedBytes.byteLength <= RESOURCE_LIMITS.MAX_NATIVE_SOURCE_PAYLOAD_BYTES) {
      ref.nativeSource = {
        namespace: "nec.resolver-evm.rpc-result",
        mediaType: "application/json",
        encoding: "base64",
        payload: Buffer.from(decodedBytes).toString("base64"),
        contentDigest: nativeSourceContentDigest(decodedBytes),
      };
    }
    refs.push(ref);
  }
  return refs;
}

function receiptAnchorFields(acquisition: EvmTransactionAcquisition): {
  blockNumber?: bigint;
  blockId?: string;
} {
  const block = acquisition.block;
  if (block) return { blockNumber: block.number, blockId: block.hash };
  const receipt = acquisition.receipt;
  if (receipt) return { blockNumber: receipt.blockNumber, blockId: receipt.blockHash };
  return {};
}

export function isEvmAddress(value: string): boolean {
  return EVM_ADDRESS_PATTERN.test(value);
}
