/**
 * Pure zkSYS Tanenbaum BEFORE profile.
 *
 * Only archived historical replay is accepted. Exact request/response bytes
 * are verified before an owned generic-EVM observation is constructed. Every
 * supported volatile capability is then projected to current availability
 * UNKNOWN: historical usability is evidence, never a live availability probe.
 */

import { createHash } from "node:crypto";

import {
  assertIso8601,
  assertNecIdentifier,
  buildCapabilitySnapshot,
  computeResolverManifestDigest,
  decodeBase64Strict,
  deepFreeze,
  validateCapabilitySnapshot,
  validatePreflightRequest,
  validateResolverManifest,
} from "@nec/core";
import type {
  CapabilitySnapshot,
  CapabilityState,
  DiscoveryCandidate,
  EvidenceRef,
  Iso8601,
  NetworkFingerprint,
  NetworkId,
  PreflightRequest,
  PreflightResult,
  ResolverManifest,
  ResolverManifestRef,
} from "@nec/core";
import {
  deriveEvmBeforeFoundation,
  deriveEvmBeforePreflightResult,
} from "@nec/resolver-evm";
import type {
  EvmBeforeFoundation,
  EvmCapabilityProbeObservation,
} from "@nec/resolver-evm";

import { zksysFail } from "./errors.js";
import { ownedEvidenceArray, readExactObject } from "./inert.js";
import { parseStrictRpcExchange } from "./strict-json.js";
import type { StrictRpcExchange } from "./strict-json.js";

export const ZKSYS_TANENBAUM_NETWORK_ID = "eip155:57057" as NetworkId;
export const ZKSYS_TANENBAUM_CHAIN_ID = 57057;
export const ZKSYS_BATCHING_RPC_METHOD = "unstable_getBatchByBlockNumber";
export const ZKSYS_BATCHING_SEMANTICS =
  "an archived identity-checked zkSYS RPC source returned a provider-reported batch and range for a requested block height";

const ZKSYS_RPC_SOURCE_TYPE = "evm_rpc";
const HISTORICAL_REPLAY = "historical_replay";
const ARCHIVED_RPC_NAMESPACE = "nec.resolver-zksys.archived-rpc";
const ARCHIVED_RPC_SCHEMA = "zksys-archived-rpc-exchange-v0.1";
const BATCHING_RPC_NAMESPACE = "nec.resolver-zksys.rpc-probe";
const BATCHING_RPC_SCHEMA = "zksys-block-to-batch-probe-v0.1";
const HASH_32 = /^0x[0-9a-f]{64}$/;
const HEX_QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]*)$/;

const MANIFEST_CONTENT: Omit<ResolverManifest, "digest"> = {
  id: "resolver-zksys-tanenbaum",
  version: "0.1.0",
  networkFamilies: ["eip155"],
  implementation: { package: "@nec/resolver-zksys" },
  supportedCapabilities: ["execution", "observedEffects", "dataBinding", "batching"],
  sourceRequirements: [{ sourceType: ZKSYS_RPC_SOURCE_TYPE, required: true }],
  metadata: {
    profile: "zksys-tanenbaum-before-v0.1",
    observationKind: HISTORICAL_REPLAY,
    networkId: ZKSYS_TANENBAUM_NETWORK_ID,
    chainId: ZKSYS_TANENBAUM_CHAIN_ID,
    batchingSemantics: ZKSYS_BATCHING_SEMANTICS,
    producerBoundary:
      "profile guarantees apply to artifacts returned by deriveZksysBeforeFoundation; generic core builders do not attest producer identity",
    batchingDoesNotEstablish: [
      "gateway_settlement",
      "data_availability",
      "poda_availability",
      "proof_verification",
      "syscoin_inclusion",
      "finality",
    ],
  },
};

let manifestCache: ResolverManifest | undefined;

export function zksysBeforeResolverManifest(): ResolverManifest {
  if (manifestCache === undefined) {
    const manifest = { ...MANIFEST_CONTENT, digest: computeResolverManifestDigest(MANIFEST_CONTENT) };
    validateResolverManifest(manifest);
    manifestCache = deepFreeze(manifest);
  }
  return manifestCache;
}

export interface ZksysBatchAssociation {
  /** Height requested from unstable_getBatchByBlockNumber; never a hash binding. */
  readonly blockNumber: number;
  readonly batchNumber: number;
  readonly reportedBlockRange: {
    readonly start: number;
    readonly end: number;
  };
}

export interface ZksysBatchingProbeSource {
  readonly sourceId: string;
  readonly sourceType: string;
}

export type ZksysBatchingObservationKind = "historical_replay";

/** Already-acquired observation. This type performs no RPC or other I/O. */
export interface ZksysBatchingProbeObservation {
  readonly network: NetworkId;
  readonly source: ZksysBatchingProbeSource;
  readonly observedAt: Iso8601;
  readonly observationKind: ZksysBatchingObservationKind;
  readonly rpcReachable: boolean;
  readonly blockToBatchLookupUsable: boolean;
  readonly association?: ZksysBatchAssociation;
  readonly evidence: EvidenceRef[];
}

export interface ZksysBeforeDerivationInput {
  readonly networkId: NetworkId;
  readonly evmObservation: EvmCapabilityProbeObservation;
  readonly batchingObservation?: ZksysBatchingProbeObservation;
}

export interface ZksysBeforeFoundation {
  readonly manifest: ResolverManifest;
  readonly network: NetworkFingerprint;
  readonly snapshot: CapabilitySnapshot;
  readonly candidate: DiscoveryCandidate;
}

interface OwnedSource {
  readonly sourceId: string;
  readonly sourceType: "evm_rpc";
}

interface VerifiedEvmContext {
  readonly observation: EvmCapabilityProbeObservation;
  readonly source: OwnedSource;
  readonly blockNumber?: number;
  readonly blockHash?: string;
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    zksysFail("ZKSYS_INPUT_INVALID", `${path} must be a non-empty string`);
  }
  return value;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") zksysFail("ZKSYS_INPUT_INVALID", `${path} must be a boolean`);
  return value;
}

function safeNonNegativeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    zksysFail("ZKSYS_INPUT_INVALID", `${path} must be a safe non-negative integer`);
  }
  return value;
}

function internalObject(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    zksysFail("ZKSYS_OBSERVATION_INCOMPLETE", `${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function internalArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) zksysFail("ZKSYS_OBSERVATION_INCOMPLETE", `${path} must be an array`);
  return value;
}

function strictHash(value: unknown, path: string): string {
  if (typeof value !== "string" || !HASH_32.test(value)) {
    zksysFail("ZKSYS_OBSERVATION_INCOMPLETE", `${path} must be a lowercase 32-byte hex hash`);
  }
  return value;
}

function quantity(value: unknown, path: string): number {
  if (typeof value !== "string" || !HEX_QUANTITY.test(value)) {
    zksysFail("ZKSYS_OBSERVATION_INCOMPLETE", `${path} must be a canonical lowercase hex quantity`);
  }
  const parsed = Number.parseInt(value.slice(2), 16);
  if (!Number.isSafeInteger(parsed)) {
    zksysFail("ZKSYS_OBSERVATION_INCOMPLETE", `${path} exceeds the safe integer range`);
  }
  return parsed;
}

function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function sourceFrom(value: unknown, path: string): OwnedSource {
  const fields = readExactObject(value, path, ["sourceId", "sourceType"], ["sourceId", "sourceType"]);
  const sourceId = nonEmptyString(fields.sourceId, `${path}.sourceId`);
  try {
    assertNecIdentifier(sourceId, `${path}.sourceId`);
  } catch (error) {
    zksysFail("ZKSYS_INPUT_INVALID", (error as Error).message);
  }
  if (fields.sourceType !== ZKSYS_RPC_SOURCE_TYPE) {
    zksysFail("ZKSYS_INPUT_INVALID", `${path}.sourceType must be exactly ${JSON.stringify(ZKSYS_RPC_SOURCE_TYPE)}`);
  }
  return { sourceId, sourceType: ZKSYS_RPC_SOURCE_TYPE };
}

function strictExchange(
  ref: EvidenceRef,
  namespace: string,
  schema: string,
  path: string,
): StrictRpcExchange {
  const native = ref.nativeSource;
  if (
    native === undefined ||
    native.namespace !== namespace ||
    native.schema !== schema ||
    native.mediaType !== "application/json" ||
    native.encoding !== "base64"
  ) {
    zksysFail("ZKSYS_OBSERVATION_INCOMPLETE", `${path} requires the expected digest-bound native RPC exchange`);
  }
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(
      decodeBase64Strict(native.payload, `${path}.nativeSource.payload`),
    );
  } catch (error) {
    zksysFail("ZKSYS_OBSERVATION_INCOMPLETE", (error as Error).message);
  }
  const exchange = parseStrictRpcExchange(decoded, `${path}.nativeSource`);
  if (ref.contentDigest === undefined || ref.contentDigest !== sha256(exchange.responseText)) {
    zksysFail("ZKSYS_OBSERVATION_INCOMPLETE", `${path}.contentDigest must bind the exact response bytes`);
  }
  return exchange;
}

function expectMethod(exchange: StrictRpcExchange, method: string, path: string): unknown[] {
  if (exchange.request.method !== method) {
    zksysFail("ZKSYS_OBSERVATION_INCOMPLETE", `${path} method must be ${method}`);
  }
  return internalArray(exchange.request.params, `${path}.request.params`);
}

interface ParsedEvmRpc {
  readonly method: string;
  readonly ref: EvidenceRef;
  readonly exchange: StrictRpcExchange;
}

function evidenceMethod(ref: EvidenceRef, path: string): string {
  const method = ref.metadata?.rpcMethod;
  if (typeof method !== "string") {
    zksysFail("ZKSYS_INPUT_INVALID", `${path}.metadata.rpcMethod is required`);
  }
  if (ref.metadata?.observationKind !== HISTORICAL_REPLAY) {
    zksysFail("ZKSYS_INPUT_INVALID", `${path}.metadata.observationKind must be historical_replay`);
  }
  return method;
}

function latestRetrievedAt(evidence: readonly EvidenceRef[], callerTime: unknown, path: string): Iso8601 {
  if (typeof callerTime !== "string") zksysFail("ZKSYS_INPUT_INVALID", `${path} must be an ISO-8601 string`);
  try {
    assertIso8601(callerTime, path);
  } catch (error) {
    zksysFail("ZKSYS_INPUT_INVALID", (error as Error).message);
  }
  if (evidence.length === 0) return callerTime as Iso8601;
  let archivedTime = evidence[0]!.retrievedAt;
  for (let i = 1; i < evidence.length; i++) {
    if (evidence[i]!.retrievedAt > archivedTime) archivedTime = evidence[i]!.retrievedAt;
  }
  if (callerTime !== archivedTime) {
    zksysFail("ZKSYS_TIME_MISMATCH", `${path} must equal the latest retrievedAt in the archived EvidenceRefs`);
  }
  return archivedTime;
}

function validateRefProvenance(ref: EvidenceRef, source: OwnedSource, path: string): void {
  if (
    ref.networkId !== ZKSYS_TANENBAUM_NETWORK_ID ||
    ref.sourceId !== source.sourceId ||
    ref.sourceType !== ZKSYS_RPC_SOURCE_TYPE
  ) {
    zksysFail("ZKSYS_INPUT_INVALID", `${path} must use the profile network and the single evm_rpc source`);
  }
  if (ref.locator === undefined || ref.contentDigest === undefined) {
    zksysFail("ZKSYS_OBSERVATION_INCOMPLETE", `${path} requires locator and contentDigest`);
  }
}

function ownedEvmObservation(value: unknown): VerifiedEvmContext {
  const fields = readExactObject(
    value,
    "evmObservation",
    [
      "network", "source", "observedAt", "chainId", "rpcReachable", "chainIdentityObserved",
      "receiptLookupUsable", "blockLookupUsable", "transactionLookupUsable", "evidence",
    ],
    [
      "network", "source", "observedAt", "chainId", "rpcReachable", "chainIdentityObserved",
      "receiptLookupUsable", "blockLookupUsable", "transactionLookupUsable", "evidence",
    ],
  );
  if (fields.network !== ZKSYS_TANENBAUM_NETWORK_ID || fields.chainId !== ZKSYS_TANENBAUM_CHAIN_ID) {
    zksysFail("ZKSYS_NETWORK_MISMATCH", "evmObservation must identify eip155:57057 / chainId 57057");
  }
  const source = sourceFrom(fields.source, "evmObservation.source");
  const evidence = ownedEvidenceArray(fields.evidence, "evmObservation.evidence");
  const observedAt = latestRetrievedAt(evidence, fields.observedAt, "evmObservation.observedAt");
  const flags = {
    rpcReachable: boolean(fields.rpcReachable, "evmObservation.rpcReachable"),
    chainIdentityObserved: boolean(fields.chainIdentityObserved, "evmObservation.chainIdentityObserved"),
    receiptLookupUsable: boolean(fields.receiptLookupUsable, "evmObservation.receiptLookupUsable"),
    blockLookupUsable: boolean(fields.blockLookupUsable, "evmObservation.blockLookupUsable"),
    transactionLookupUsable: boolean(fields.transactionLookupUsable, "evmObservation.transactionLookupUsable"),
  };

  const allowedMethods = new Set([
    "eth_chainId", "eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_getBlockByHash",
  ]);
  const byMethod = new Map<string, ParsedEvmRpc>();
  for (let i = 0; i < evidence.length; i++) {
    const ref = evidence[i]!;
    const path = `evmObservation.evidence[${i}]`;
    validateRefProvenance(ref, source, path);
    const method = evidenceMethod(ref, path);
    if (!allowedMethods.has(method)) {
      zksysFail("ZKSYS_INPUT_INVALID", `${path} carries an RPC method outside the narrow zkSYS profile`);
    }
    if (byMethod.has(method)) {
      zksysFail("ZKSYS_INPUT_INVALID", `evmObservation.evidence has duplicate ${method} provenance`);
    }
    byMethod.set(method, {
      method,
      ref,
      exchange: strictExchange(ref, ARCHIVED_RPC_NAMESPACE, ARCHIVED_RPC_SCHEMA, path),
    });
  }

  if (flags.rpcReachable && evidence.length === 0) {
    zksysFail("ZKSYS_OBSERVATION_INCOMPLETE", "positive historical RPC reachability requires raw evidence");
  }
  for (const [flag, method] of [
    [flags.chainIdentityObserved, "eth_chainId"],
    [flags.transactionLookupUsable, "eth_getTransactionByHash"],
    [flags.receiptLookupUsable, "eth_getTransactionReceipt"],
    [flags.blockLookupUsable, "eth_getBlockByHash"],
  ] as const) {
    if (flag && !byMethod.has(method)) {
      zksysFail("ZKSYS_OBSERVATION_INCOMPLETE", `positive historical ${method} claim requires its raw RPC exchange`);
    }
    if (!flag && byMethod.has(method)) {
      zksysFail("ZKSYS_OBSERVATION_INCOMPLETE", `caller ${method} boolean contradicts its positive raw RPC exchange`);
    }
  }
  if (flags.rpcReachable !== (evidence.length > 0)) {
    zksysFail("ZKSYS_OBSERVATION_INCOMPLETE", "caller rpcReachable boolean contradicts the supplied positive raw exchanges");
  }

  const chain = byMethod.get("eth_chainId");
  if (chain !== undefined) {
    const params = expectMethod(chain.exchange, "eth_chainId", "eth_chainId exchange");
    if (params.length !== 0 || chain.exchange.response.result !== "0xdee1") {
      zksysFail("ZKSYS_NETWORK_MISMATCH", "raw eth_chainId exchange must establish chainId 57057 (0xdee1)");
    }
  }

  let transactionHash: string | undefined;
  let txBlockHash: string | undefined;
  let txBlockNumber: number | undefined;
  const transaction = byMethod.get("eth_getTransactionByHash");
  if (transaction !== undefined) {
    const params = expectMethod(transaction.exchange, "eth_getTransactionByHash", "transaction exchange");
    if (params.length !== 1) zksysFail("ZKSYS_OBSERVATION_INCOMPLETE", "transaction request requires one hash param");
    transactionHash = strictHash(params[0], "transaction request hash");
    const result = internalObject(transaction.exchange.response.result, "transaction result");
    if (result.hash !== transactionHash) {
      zksysFail("ZKSYS_OBSERVATION_INCOMPLETE", "transaction response.hash differs from the requested hash");
    }
    if (result.chainId !== "0xdee1") {
      zksysFail("ZKSYS_NETWORK_MISMATCH", "transaction response.chainId does not identify chainId 57057");
    }
    txBlockHash = strictHash(result.blockHash, "transaction result.blockHash");
    txBlockNumber = quantity(result.blockNumber, "transaction result.blockNumber");
  }

  let receiptBlockHash: string | undefined;
  let receiptBlockNumber: number | undefined;
  const receipt = byMethod.get("eth_getTransactionReceipt");
  if (receipt !== undefined) {
    const params = expectMethod(receipt.exchange, "eth_getTransactionReceipt", "receipt exchange");
    if (params.length !== 1) zksysFail("ZKSYS_OBSERVATION_INCOMPLETE", "receipt request requires one hash param");
    const requested = strictHash(params[0], "receipt request hash");
    const result = internalObject(receipt.exchange.response.result, "receipt result");
    const returned = strictHash(result.transactionHash, "receipt result.transactionHash");
    if (returned !== requested || (transactionHash !== undefined && returned !== transactionHash)) {
      zksysFail("ZKSYS_OBSERVATION_INCOMPLETE", "receipt transaction binding is incoherent");
    }
    if (result.status !== "0x1") {
      zksysFail("ZKSYS_OBSERVATION_INCOMPLETE", "the archived A3 receipt status must remain 0x1");
    }
    receiptBlockHash = strictHash(result.blockHash, "receipt result.blockHash");
    receiptBlockNumber = quantity(result.blockNumber, "receipt result.blockNumber");
  }

  let blockHash: string | undefined;
  let blockNumber: number | undefined;
  const block = byMethod.get("eth_getBlockByHash");
  if (block !== undefined) {
    const params = expectMethod(block.exchange, "eth_getBlockByHash", "block exchange");
    if (params.length !== 2 || params[1] !== true) {
      zksysFail("ZKSYS_OBSERVATION_INCOMPLETE", "block request must contain [blockHash, true]");
    }
    const requested = strictHash(params[0], "block request hash");
    const result = internalObject(block.exchange.response.result, "block result");
    blockHash = strictHash(result.hash, "block result.hash");
    blockNumber = quantity(result.number, "block result.number");
    if (blockHash !== requested) {
      zksysFail("ZKSYS_OBSERVATION_INCOMPLETE", "block response.hash differs from the requested hash");
    }
    const transactions = internalArray(result.transactions, "block result.transactions");
    if (transactionHash !== undefined) {
      let bound = false;
      for (let i = 0; i < transactions.length; i++) {
        const tx = internalObject(transactions[i], `block result.transactions[${i}]`);
        if (
          tx.hash === transactionHash && tx.blockHash === blockHash &&
          quantity(tx.blockNumber, `block result.transactions[${i}].blockNumber`) === blockNumber
        ) {
          bound = true;
        }
      }
      if (!bound) zksysFail("ZKSYS_OBSERVATION_INCOMPLETE", "block result does not bind the relevant transaction");
    }
  }

  const blockNumbers = [txBlockNumber, receiptBlockNumber, blockNumber].filter((value): value is number => value !== undefined);
  const blockHashes = [txBlockHash, receiptBlockHash, blockHash].filter((value): value is string => value !== undefined);
  if (new Set(blockNumbers).size > 1 || new Set(blockHashes).size > 1) {
    zksysFail("ZKSYS_OBSERVATION_INCOMPLETE", "transaction, receipt and block raw exchanges disagree on block context");
  }
  for (const parsed of byMethod.values()) {
    if (parsed.method === "eth_chainId") {
      if (parsed.ref.blockNumber !== undefined || parsed.ref.blockId !== undefined) {
        zksysFail("ZKSYS_INPUT_INVALID", "chain identity EvidenceRef must not invent a block anchor");
      }
    } else if (
      blockNumber !== undefined && blockHash !== undefined &&
      (parsed.ref.blockNumber !== BigInt(blockNumber) || parsed.ref.blockId !== blockHash)
    ) {
      zksysFail("ZKSYS_OBSERVATION_INCOMPLETE", `${parsed.method} EvidenceRef anchor differs from verified raw bytes`);
    }
  }

  const observation: EvmCapabilityProbeObservation = {
    network: ZKSYS_TANENBAUM_NETWORK_ID,
    chainId: ZKSYS_TANENBAUM_CHAIN_ID,
    source,
    observedAt,
    ...flags,
    evidence,
  };
  return {
    observation,
    source,
    ...(blockNumber === undefined ? {} : { blockNumber }),
    ...(blockHash === undefined ? {} : { blockHash }),
  };
}

interface OwnedBatching {
  readonly observation: ZksysBatchingProbeObservation;
  readonly pathEvidence: EvidenceRef[];
}

function ownedAssociation(value: unknown): ZksysBatchAssociation {
  const fields = readExactObject(
    value,
    "batchingObservation.association",
    ["blockNumber", "batchNumber", "reportedBlockRange"],
    ["blockNumber", "batchNumber", "reportedBlockRange"],
  );
  const range = readExactObject(
    fields.reportedBlockRange,
    "batchingObservation.association.reportedBlockRange",
    ["start", "end"],
    ["start", "end"],
  );
  const blockNumber = safeNonNegativeInteger(fields.blockNumber, "batchingObservation.association.blockNumber");
  const batchNumber = safeNonNegativeInteger(fields.batchNumber, "batchingObservation.association.batchNumber");
  const start = safeNonNegativeInteger(range.start, "batchingObservation.association.reportedBlockRange.start");
  const end = safeNonNegativeInteger(range.end, "batchingObservation.association.reportedBlockRange.end");
  if (batchNumber === 0 || start > end || blockNumber < start || blockNumber > end) {
    zksysFail("ZKSYS_OBSERVATION_INCOMPLETE", "batch association/range is invalid or excludes the requested height");
  }
  return { blockNumber, batchNumber, reportedBlockRange: { start, end } };
}

function ownedBatchingObservation(
  value: unknown,
  evm: VerifiedEvmContext,
  generatedAt: Iso8601,
): OwnedBatching {
  const fields = readExactObject(
    value,
    "batchingObservation",
    ["network", "source", "observedAt", "observationKind", "rpcReachable", "blockToBatchLookupUsable", "association", "evidence"],
    ["network", "source", "observedAt", "observationKind", "rpcReachable", "blockToBatchLookupUsable", "evidence"],
  );
  if (fields.network !== ZKSYS_TANENBAUM_NETWORK_ID) {
    zksysFail("ZKSYS_NETWORK_MISMATCH", "batchingObservation.network must identify zkSYS Tanenbaum");
  }
  if (fields.observationKind !== HISTORICAL_REPLAY) {
    zksysFail("ZKSYS_INPUT_INVALID", "zkSYS BEFORE v0.1 accepts only historical_replay");
  }
  const source = sourceFrom(fields.source, "batchingObservation.source");
  if (source.sourceId !== evm.source.sourceId) {
    zksysFail("ZKSYS_INPUT_INVALID", "batching and EVM observations must use the same sourceId/sourceType");
  }
  const evidence = ownedEvidenceArray(fields.evidence, "batchingObservation.evidence");
  const observedAt = latestRetrievedAt(evidence, fields.observedAt, "batchingObservation.observedAt");
  if (observedAt !== generatedAt) {
    zksysFail("ZKSYS_TIME_MISMATCH", "EVM and batching archives must resolve to the same capture time");
  }
  const rpcReachable = boolean(fields.rpcReachable, "batchingObservation.rpcReachable");
  const usable = boolean(fields.blockToBatchLookupUsable, "batchingObservation.blockToBatchLookupUsable");
  const hasAssociation = Object.prototype.hasOwnProperty.call(fields, "association");
  if (!rpcReachable && usable) {
    zksysFail("ZKSYS_OBSERVATION_INCOMPLETE", "batch lookup cannot be usable when historical RPC reachability is false");
  }
  if (!usable && hasAssociation) {
    zksysFail("ZKSYS_OBSERVATION_INCOMPLETE", "an unusable historical batch lookup cannot carry an association");
  }
  const association = hasAssociation ? ownedAssociation(fields.association) : undefined;
  if (usable && association === undefined) {
    zksysFail("ZKSYS_OBSERVATION_INCOMPLETE", "usable historical batch lookup requires an association");
  }
  if (evm.blockNumber !== undefined && association !== undefined && association.blockNumber !== evm.blockNumber) {
    zksysFail("ZKSYS_NETWORK_MISMATCH", "batch request height differs from the independently observed EVM block height");
  }

  const pathEvidence: EvidenceRef[] = [];
  for (let i = 0; i < evidence.length; i++) {
    const ref = evidence[i]!;
    const path = `batchingObservation.evidence[${i}]`;
    validateRefProvenance(ref, source, path);
    if (ref.blockId !== undefined) {
      zksysFail("ZKSYS_INPUT_INVALID", `${path} must not imply a block-hash binding absent from the batch RPC`);
    }
    if (evidenceMethod(ref, path) !== ZKSYS_BATCHING_RPC_METHOD) {
      zksysFail("ZKSYS_INPUT_INVALID", `${path} has the wrong batching RPC method`);
    }
    const exchange = strictExchange(ref, BATCHING_RPC_NAMESPACE, BATCHING_RPC_SCHEMA, path);
    const params = expectMethod(exchange, ZKSYS_BATCHING_RPC_METHOD, "batching exchange");
    if (params.length !== 1 || typeof params[0] !== "number" || !Number.isSafeInteger(params[0]) || params[0] < 0) {
      zksysFail("ZKSYS_OBSERVATION_INCOMPLETE", "batching request requires exactly one safe block-height number");
    }
    const result = internalObject(exchange.response.result, "batching result");
    const batchInfo = internalObject(result.batch_info, "batching result.batch_info");
    const blockRange = internalObject(result.block_range, "batching result.block_range");
    const rawBatch = safeNonNegativeInteger(batchInfo.batch_number, "batching result.batch_info.batch_number");
    const rawStart = safeNonNegativeInteger(blockRange.start, "batching result.block_range.start");
    const rawEnd = safeNonNegativeInteger(blockRange.end, "batching result.block_range.end");
    if (
      rawBatch === 0 || rawStart > rawEnd || params[0] < rawStart || params[0] > rawEnd ||
      ref.blockNumber !== BigInt(params[0])
    ) {
      zksysFail("ZKSYS_OBSERVATION_INCOMPLETE", "raw batching height/batch/range or EvidenceRef anchor is incoherent");
    }
    if (
      association !== undefined &&
      (params[0] !== association.blockNumber || rawBatch !== association.batchNumber ||
        rawStart !== association.reportedBlockRange.start || rawEnd !== association.reportedBlockRange.end)
    ) {
      zksysFail("ZKSYS_OBSERVATION_INCOMPLETE", "caller batching association differs from verified raw height/batch/range");
    }
    pathEvidence.push(ref);
  }
  if ((rpcReachable || usable) && pathEvidence.length === 0) {
    zksysFail("ZKSYS_OBSERVATION_INCOMPLETE", "positive historical batching flags require raw RPC evidence");
  }
  if (rpcReachable !== (pathEvidence.length > 0) || usable !== (pathEvidence.length > 0)) {
    zksysFail("ZKSYS_OBSERVATION_INCOMPLETE", "caller batching booleans contradict the supplied positive raw exchange");
  }
  return {
    observation: {
      network: ZKSYS_TANENBAUM_NETWORK_ID,
      source,
      observedAt,
      observationKind: HISTORICAL_REPLAY,
      rpcReachable,
      blockToBatchLookupUsable: usable,
      ...(association === undefined ? {} : { association }),
      evidence,
    },
    pathEvidence,
  };
}

function historicalState(state: CapabilityState, observedAt: Iso8601): CapabilityState {
  if (state.support !== "supported") return state;
  return {
    support: state.support,
    availability: "unknown",
    reason: "archived historical replay does not establish current availability",
    ...(state.evidence === undefined ? {} : { evidence: [...state.evidence] }),
    metadata: {
      observationKind: HISTORICAL_REPLAY,
      historicalCaptureTime: observedAt,
      historicalAvailabilityAtCapture: state.availability,
      currentAvailability: "unknown",
      statement: "the cited paths were observed at capture time; this is not a current probe",
    },
  };
}

function batchingMetadata(
  observation: ZksysBatchingProbeObservation,
  association: ZksysBatchAssociation,
): Record<string, unknown> {
  return {
    semantics: ZKSYS_BATCHING_SEMANTICS,
    observationKind: HISTORICAL_REPLAY,
    observationStatement: `At ${observation.observedAt}, an archived identity-checked zkSYS RPC source returned batch ${association.batchNumber} with reported range ${association.reportedBlockRange.start}..${association.reportedBlockRange.end} for a request for block height ${association.blockNumber}.`,
    requestedBlockHeight: association.blockNumber,
    batchNumber: association.batchNumber,
    reportedBlockRange: { ...association.reportedBlockRange },
    relationStrength: "provider_reported_height_lookup",
    sourceScope: "single_rpc_source_separately_probed_method",
    currentAvailability: "unknown",
    doesNotEstablish: [
      "block_hash_membership",
      "gateway_settlement",
      "data_availability",
      "poda_availability",
      "proof_verification",
      "syscoin_inclusion",
      "finality",
    ],
  };
}

function batchingState(
  observation: ZksysBatchingProbeObservation | undefined,
  evidence: readonly EvidenceRef[],
): CapabilityState {
  if (observation === undefined) {
    return {
      support: "supported",
      availability: "unknown",
      reason: "no archived zkSYS height-to-batch observation was supplied; current availability is unknown",
    };
  }
  return {
    support: "supported",
    availability: "unknown",
    reason: "archived historical replay does not establish current batching availability",
    ...(observation.association === undefined ? {} : {
      evidence: evidence.map((ref) => ref.id),
      metadata: batchingMetadata(observation, observation.association),
    }),
  };
}

function manifestRef(manifest: ResolverManifest): ResolverManifestRef {
  return { id: manifest.id, version: manifest.version, digest: manifest.digest };
}

export function deriveZksysBeforeFoundation(input: ZksysBeforeDerivationInput): ZksysBeforeFoundation {
  const root = readExactObject(
    input,
    "input",
    ["networkId", "evmObservation", "batchingObservation"],
    ["networkId", "evmObservation"],
  );
  if (root.networkId !== ZKSYS_TANENBAUM_NETWORK_ID) {
    zksysFail("ZKSYS_NETWORK_MISMATCH", `v0.1 profile is limited to ${ZKSYS_TANENBAUM_NETWORK_ID}`);
  }
  const verifiedEvm = ownedEvmObservation(root.evmObservation);
  const evm = deriveEvmBeforeFoundation({
    networkId: ZKSYS_TANENBAUM_NETWORK_ID,
    observation: verifiedEvm.observation,
  });
  if (evm.network.chainId !== ZKSYS_TANENBAUM_CHAIN_ID) {
    zksysFail("ZKSYS_NETWORK_MISMATCH", "verified EVM foundation does not identify zkSYS Tanenbaum");
  }

  let batching: OwnedBatching | undefined;
  if (Object.prototype.hasOwnProperty.call(root, "batchingObservation")) {
    batching = ownedBatchingObservation(root.batchingObservation, verifiedEvm, evm.snapshot.generatedAt);
  }
  const batchingEvidence = batching?.observation.evidence ?? [];
  const evmIds = new Set(evm.snapshot.evidence.map((ref) => ref.id));
  for (const ref of batchingEvidence) {
    if (evmIds.has(ref.id)) {
      zksysFail("ZKSYS_INPUT_INVALID", `EvidenceId ${JSON.stringify(ref.id)} is duplicated across EVM and batching observations`);
    }
  }

  const manifest = zksysBeforeResolverManifest();
  const generatedAt = evm.snapshot.generatedAt;
  const snapshot = buildCapabilitySnapshot(
    {
      schemaVersion: "0.1",
      id: `zksys-capsnap-${ZKSYS_TANENBAUM_NETWORK_ID}`,
      generatedAt,
      network: evm.snapshot.network,
      evidenceCapabilities: {
        execution: historicalState(evm.snapshot.evidenceCapabilities.execution, generatedAt),
        observedEffects: historicalState(evm.snapshot.evidenceCapabilities.observedEffects, generatedAt),
        dataBinding: historicalState(evm.snapshot.evidenceCapabilities.dataBinding, generatedAt),
        settlement: evm.snapshot.evidenceCapabilities.settlement,
        finality: evm.snapshot.evidenceCapabilities.finality,
      },
      executionCapabilities: {
        batching: batchingState(batching?.observation, batching?.pathEvidence ?? []),
      },
      evidence: [...evm.snapshot.evidence, ...batchingEvidence],
      resolver: manifestRef(manifest),
    },
    { resolver: manifest, networkId: ZKSYS_TANENBAUM_NETWORK_ID },
  );
  return deepFreeze({
    manifest,
    network: snapshot.network,
    snapshot,
    candidate: { network: snapshot.network, snapshot, resolver: manifest },
  });
}

/** Preflight remains core evidence readiness; historical UNKNOWN stays fail-closed. */
export function deriveZksysBeforePreflightResult(
  foundation: ZksysBeforeFoundation,
  request: PreflightRequest,
): PreflightResult {
  try {
    validatePreflightRequest(request);
    validateResolverManifest(foundation.manifest);
    validateCapabilitySnapshot(foundation.snapshot);
  } catch (error) {
    zksysFail("ZKSYS_INPUT_INVALID", (error as Error).message);
  }
  if (request.networkId !== ZKSYS_TANENBAUM_NETWORK_ID) {
    zksysFail("ZKSYS_NETWORK_MISMATCH", "preflight request does not target zkSYS Tanenbaum");
  }
  const expected = zksysBeforeResolverManifest();
  if (
    foundation.manifest.id !== expected.id ||
    foundation.manifest.version !== expected.version ||
    foundation.manifest.digest !== expected.digest
  ) {
    zksysFail("ZKSYS_INPUT_INVALID", "preflight foundation is not bound to the zkSYS v0.1 manifest");
  }
  return deriveEvmBeforePreflightResult(foundation as EvmBeforeFoundation, request);
}
