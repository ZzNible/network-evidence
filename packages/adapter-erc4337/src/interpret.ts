/**
 * INTERPRETATION LAYER: generic NEC `ObservedEffect` -> ERC-4337
 * UserOperationEvent-shaped and ERC-1155 TransferSingle-shaped observations.
 *
 * The adapter consumes ONLY generic artifacts. An observed effect is
 * interpretable when its `fields` mirror the generic EVM log observation
 * projection (address / topics / data / removed), i.e. the normalized
 * `EvmLogObservation` shape produced by generic EVM acquisition.
 *
 * Classification is SHAPE-DRIVEN, never label-driven: the effect `type`
 * string is ignored, the event topic structure decides. A log whose topic0
 * equals a pinned topic but which fails the remaining structural rules is
 * EXCLUDED with a recorded reason — never partially interpreted, never
 * silently dropped, and NEVER classified as unrelated. The APEL lesson is
 * preserved here: malformed RELEVANT evidence is not clean absence of a
 * matching effect; the evaluation layer fails closed on it.
 *
 * Interpretation is NOT verification: recognizing an EntryPoint-event-shaped
 * log makes no statement about bundler honesty, and recognizing a
 * TransferSingle makes no statement about token honesty.
 */

import type { ObservedEffect } from "@nec/core";

import { isEvmAddressShape, normalizeEvmAddress } from "./address.js";
import {
  TRANSFER_BATCH_TOPIC0,
  TRANSFER_SINGLE_TOPIC0,
  USER_OPERATION_EVENT_TOPIC0,
} from "./events.js";
import type {
  TransferBatchInterpretation,
  TransferBatchMemberObservation,
  TransferBatchObservation,
  TransferSingleInterpretation,
  TransferSingleObservation,
  UserOperationEventInterpretation,
  UserOperationEventObservation,
} from "./events.js";

const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const QUANTITY_PATTERN = /^0x[0-9a-f]+$/;
const DECIMAL_PATTERN = /^[0-9]+$/;

function lowerHash(value: string): string {
  return value.toLowerCase();
}

/**
 * Decode one indexed address topic: the low 20 bytes are the address, the
 * high 12 bytes MUST be zero padding. Returns "" when padding is malformed.
 */
export function decodeIndexedAddressTopic(topic: string): string {
  const body = topic.toLowerCase().slice(2);
  const padding = body.slice(0, 24);
  if (padding !== "0".repeat(24)) {
    return "";
  }
  return `0x${body.slice(24)}`;
}

function requireRecord(fields: unknown): Record<string, unknown> | null {
  if (fields === null || typeof fields !== "object" || Array.isArray(fields)) return null;
  return fields as Record<string, unknown>;
}

/** Shared structural pre-read of a candidate log effect. */
interface LogShape {
  readonly removed: boolean;
  readonly topics: readonly unknown[];
  readonly topic0: string;
  readonly fields: Record<string, unknown>;
  /** null when the carrier itself is malformed under the log contract. */
  readonly malformedDetail: string | null;
}

function readLogShape(effect: ObservedEffect): LogShape | null {
  const fields = requireRecord(effect.fields);
  if (fields === null) return null;
  // The removed flag is REQUIRED by the generic log observation contract;
  // absence means the projection did not follow the contract.
  if (typeof fields["removed"] !== "boolean") return null;
  const topicsRaw = fields["topics"];
  if (!Array.isArray(topicsRaw) || topicsRaw.length === 0) return null;
  for (let i = 0; i < topicsRaw.length; i++) {
    if (typeof topicsRaw[i] !== "string" || !HASH_PATTERN.test(topicsRaw[i] as string)) {
      return null;
    }
  }
  return {
    removed: fields["removed"] as boolean,
    topics: topicsRaw,
    topic0: (topicsRaw[0] as string).toLowerCase(),
    fields,
    malformedDetail: null,
  };
}

/**
 * Optional context quantities (`blockNumber`, `transactionIndex`,
 * `logIndex`) are JSON-safe strings in generic effect fields. THE frozen
 * generic EVM projection emits exact DECIMAL strings; canonical 0x-prefixed
 * hex quantities are equally unambiguous and are accepted defensively. Both
 * normalize to the same decimal string; anything else is malformed.
 */
function parseContextQuantityToDecimal(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 1002) {
    return null;
  }
  if (DECIMAL_PATTERN.test(value)) {
    return BigInt(value).toString();
  }
  if (QUANTITY_PATTERN.test(value)) {
    const body = value.slice(2);
    if (body.length > 1 && body[0] === "0") {
      return null;
    }
    return BigInt(value).toString();
  }
  return null;
}

/**
 * Validate optional context fields shared by both interpretations. Returns
 * the normalized context or a malformed detail (fail closed).
 */
function readContext(fields: Record<string, unknown>):
  | { readonly ok: true; readonly transactionHash?: string; readonly blockNumber?: string; readonly logIndex?: string }
  | { readonly ok: false; readonly detail: string } {
  let transactionHash: string | undefined;
  let blockNumber: string | undefined;
  let logIndex: string | undefined;
  const txHashRaw = fields["transactionHash"];
  if (txHashRaw !== undefined && txHashRaw !== null) {
    if (typeof txHashRaw !== "string" || !HASH_PATTERN.test(txHashRaw)) {
      return { ok: false, detail: "fields.transactionHash must be a 32-byte hash" };
    }
    transactionHash = lowerHash(txHashRaw);
  }
  const blockNumberRaw = fields["blockNumber"];
  if (blockNumberRaw !== undefined && blockNumberRaw !== null) {
    const parsed = parseContextQuantityToDecimal(blockNumberRaw);
    if (parsed === null) {
      return {
        ok: false,
        detail: "fields.blockNumber must be a canonical decimal or 0x-hex quantity string",
      };
    }
    blockNumber = parsed;
  }
  const logIndexRaw = fields["logIndex"];
  if (logIndexRaw !== undefined && logIndexRaw !== null) {
    const parsed = parseContextQuantityToDecimal(logIndexRaw);
    if (parsed === null) {
      return {
        ok: false,
        detail: "fields.logIndex must be a canonical decimal or 0x-hex quantity string",
      };
    }
    logIndex = parsed;
  }
  return {
    ok: true,
    ...(transactionHash === undefined ? {} : { transactionHash }),
    ...(blockNumber === undefined ? {} : { blockNumber }),
    ...(logIndex === undefined ? {} : { logIndex }),
  };
}

/**
 * Interpret ONE generic observed effect as an ERC-4337 UserOperationEvent.
 * Total function: never throws on evidence content — every failure mode is
 * a deterministic classification.
 */
export function interpretUserOperationEventEffect(
  effect: ObservedEffect,
): UserOperationEventInterpretation {
  const shape = readLogShape(effect);
  if (shape === null) {
    return {
      status: "excluded",
      effectId: effect.id,
      reason: "malformed",
      detail:
        "effect.fields must be a plain record carrying boolean removed and 32-byte-hash topics (generic log observation contract)",
    };
  }
  if (shape.topic0 !== USER_OPERATION_EVENT_TOPIC0) {
    return { status: "unrelated" };
  }

  // From here on the effect CLAIMS to be a UserOperationEvent: every
  // consumed field must be structurally sound or the effect is excluded.
  if (shape.removed) {
    return {
      status: "excluded",
      effectId: effect.id,
      reason: "removed",
      detail: "log carries removed=true (orphaned by reorg); unusable as canonical observation",
    };
  }

  const addressRaw = shape.fields["address"];
  if (typeof addressRaw !== "string" || !isEvmAddressShape(addressRaw)) {
    return {
      status: "excluded",
      effectId: effect.id,
      reason: "malformed",
      detail: "fields.address must be a 20-byte EVM address",
    };
  }
  if (shape.topics.length !== 4) {
    return {
      status: "excluded",
      effectId: effect.id,
      reason: "malformed",
      detail: `a UserOperationEvent has exactly 4 topics (topic0 + userOpHash + sender + paymaster); got ${shape.topics.length}`,
    };
  }
  const userOpHash = lowerHash(shape.topics[1] as string);
  const sender = decodeIndexedAddressTopic(shape.topics[2] as string);
  const paymaster = decodeIndexedAddressTopic(shape.topics[3] as string);
  if (sender === "" || paymaster === "") {
    return {
      status: "excluded",
      effectId: effect.id,
      reason: "malformed",
      detail: "indexed address topics must carry zero-padded 20-byte addresses",
    };
  }
  const dataRaw = shape.fields["data"];
  if (typeof dataRaw !== "string" || !/^0x[0-9a-fA-F]{256}$/.test(dataRaw)) {
    return {
      status: "excluded",
      effectId: effect.id,
      reason: "malformed",
      detail:
        "fields.data must be exactly four 32-byte words (nonce, success, actualGasCost, actualGasUsed)",
    };
  }
  const body = dataRaw.toLowerCase().slice(2);
  const wordAt = (i: number): bigint => BigInt(`0x${body.slice(i * 64, (i + 1) * 64)}`);
  const nonce = wordAt(0);
  const successWord = wordAt(1);
  // Canonical ABI bool: only 0 or 1 decodes; anything else is malformed.
  if (successWord > 1n) {
    return {
      status: "excluded",
      effectId: effect.id,
      reason: "malformed",
      detail: `success data word must be canonical ABI bool 0 or 1; got ${successWord}`,
    };
  }
  const actualGasCost = wordAt(2);
  const actualGasUsed = wordAt(3);

  const context = readContext(shape.fields);
  if (!context.ok) {
    return { status: "excluded", effectId: effect.id, reason: "malformed", detail: context.detail };
  }

  const observation: UserOperationEventObservation = {
    effectId: effect.id,
    emitter: normalizeEvmAddress(addressRaw),
    userOpHash,
    sender,
    paymaster,
    nonce: nonce.toString(),
    success: successWord === 1n,
    actualGasCost: actualGasCost.toString(),
    actualGasUsed: actualGasUsed.toString(),
    evidenceIds: [...effect.evidence],
    ...(context.transactionHash === undefined ? {} : { transactionHash: context.transactionHash }),
    ...(context.blockNumber === undefined ? {} : { blockNumber: context.blockNumber }),
    ...(context.logIndex === undefined ? {} : { logIndex: context.logIndex }),
  };
  return { status: "userOperationEvent", observation };
}

/**
 * Interpret ONE generic observed effect as an ERC-1155 TransferSingle.
 * Total function: never throws on evidence content — every failure mode is
 * a deterministic classification. Mint/burn classification is NOT decided
 * here (pure structure); burn semantics are applied by the evaluation layer.
 */
export function interpretTransferSingleEffect(
  effect: ObservedEffect,
): TransferSingleInterpretation {
  const shape = readLogShape(effect);
  if (shape === null) {
    return {
      status: "excluded",
      effectId: effect.id,
      reason: "malformed",
      detail:
        "effect.fields must be a plain record carrying boolean removed and 32-byte-hash topics (generic log observation contract)",
    };
  }
  if (shape.topic0 !== TRANSFER_SINGLE_TOPIC0) {
    return { status: "unrelated" };
  }

  if (shape.removed) {
    return {
      status: "excluded",
      effectId: effect.id,
      reason: "removed",
      detail: "log carries removed=true (orphaned by reorg); unusable as canonical observation",
    };
  }

  const addressRaw = shape.fields["address"];
  if (typeof addressRaw !== "string" || !isEvmAddressShape(addressRaw)) {
    return {
      status: "excluded",
      effectId: effect.id,
      reason: "malformed",
      detail: "fields.address must be a 20-byte EVM address",
    };
  }
  if (shape.topics.length !== 4) {
    return {
      status: "excluded",
      effectId: effect.id,
      reason: "malformed",
      detail: `a TransferSingle log has exactly 4 topics (topic0 + operator + from + to); got ${shape.topics.length}`,
    };
  }
  const operator = decodeIndexedAddressTopic(shape.topics[1] as string);
  const from = decodeIndexedAddressTopic(shape.topics[2] as string);
  const to = decodeIndexedAddressTopic(shape.topics[3] as string);
  if (operator === "" || from === "" || to === "") {
    return {
      status: "excluded",
      effectId: effect.id,
      reason: "malformed",
      detail: "indexed address topics must carry zero-padded 20-byte addresses",
    };
  }
  const dataRaw = shape.fields["data"];
  if (typeof dataRaw !== "string" || !/^0x[0-9a-fA-F]{128}$/.test(dataRaw)) {
    return {
      status: "excluded",
      effectId: effect.id,
      reason: "malformed",
      detail: "fields.data must be exactly two 32-byte words (uint256 id, uint256 value)",
    };
  }
  const body = dataRaw.toLowerCase().slice(2);
  const tokenId = BigInt(`0x${body.slice(0, 64)}`);
  const value = BigInt(`0x${body.slice(64, 128)}`);

  const context = readContext(shape.fields);
  if (!context.ok) {
    return { status: "excluded", effectId: effect.id, reason: "malformed", detail: context.detail };
  }

  const observation: TransferSingleObservation = {
    effectId: effect.id,
    contract: normalizeEvmAddress(addressRaw),
    operator,
    from,
    to,
    tokenId: tokenId.toString(),
    value: value.toString(),
    evidenceIds: [...effect.evidence],
    ...(context.transactionHash === undefined ? {} : { transactionHash: context.transactionHash }),
    ...(context.blockNumber === undefined ? {} : { blockNumber: context.blockNumber }),
    ...(context.logIndex === undefined ? {} : { logIndex: context.logIndex }),
  };
  return { status: "transferSingle", observation };
}

/**
 * Interpret ONE generic observed effect as an ERC-1155 TransferBatch with
 * STRICT dynamic ABI decoding. Total function: every structural failure mode
 * is a deterministic `excluded` classification; a malformed relevant batch
 * is never silently dropped and never mistaken for an unrelated log.
 *
 * Required structural rules (mirrors the frozen generic-EVM rigor):
 *   - exactly four topics (topic0 + operator + from + to), canonical
 *     zero-padded indexed addresses;
 *   - data is ABI `(uint256[] ids, uint256[] values)`: two 32-byte head
 *     offsets, each pointing to a well-formed dynamic array;
 *   - both head offsets aligned, in range, non-overlapping, complete tails
 *     (no trailing words, no truncation);
 *   - `ids.length === values.length`;
 *   - every element is a canonical uint256 serialized as a decimal string.
 *
 * Burn semantics are NOT decided here (pure structure); a member is a burn
 * when its projected `to == ZERO_ADDRESS`. Each member is projected with a
 * deterministic identity (`${effectId}#${index}`) and never summed.
 */
export function interpretTransferBatchEffect(
  effect: ObservedEffect,
): TransferBatchInterpretation {
  const shape = readLogShape(effect);
  if (shape === null) {
    return {
      status: "excluded",
      effectId: effect.id,
      reason: "malformed",
      detail:
        "effect.fields must be a plain record carrying boolean removed and 32-byte-hash topics (generic log observation contract)",
    };
  }
  if (shape.topic0 !== TRANSFER_BATCH_TOPIC0) {
    return { status: "unrelated" };
  }

  if (shape.removed) {
    return {
      status: "excluded",
      effectId: effect.id,
      reason: "removed",
      detail: "log carries removed=true (orphaned by reorg); unusable as canonical observation",
    };
  }

  const addressRaw = shape.fields["address"];
  if (typeof addressRaw !== "string" || !isEvmAddressShape(addressRaw)) {
    return {
      status: "excluded",
      effectId: effect.id,
      reason: "malformed",
      detail: "fields.address must be a 20-byte EVM address",
    };
  }
  if (shape.topics.length !== 4) {
    return {
      status: "excluded",
      effectId: effect.id,
      reason: "malformed",
      detail: `a TransferBatch log has exactly 4 topics (topic0 + operator + from + to); got ${shape.topics.length}`,
    };
  }
  const operator = decodeIndexedAddressTopic(shape.topics[1] as string);
  const from = decodeIndexedAddressTopic(shape.topics[2] as string);
  const to = decodeIndexedAddressTopic(shape.topics[3] as string);
  if (operator === "" || from === "" || to === "") {
    return {
      status: "excluded",
      effectId: effect.id,
      reason: "malformed",
      detail: "indexed address topics must carry zero-padded 20-byte addresses",
    };
  }

  const dataRaw = shape.fields["data"];
  if (typeof dataRaw !== "string") {
    return {
      status: "excluded",
      effectId: effect.id,
      reason: "malformed",
      detail: "fields.data must be the ABI-encoded (uint256[] ids, uint256[] values)",
    };
  }
  const parsed = decodeTransferBatchArrays(dataRaw);
  if ("error" in parsed) {
    return { status: "excluded", effectId: effect.id, reason: "malformed", detail: parsed.error };
  }

  const context = readContext(shape.fields);
  if (!context.ok) {
    return { status: "excluded", effectId: effect.id, reason: "malformed", detail: context.detail };
  }

  const members: TransferBatchMemberObservation[] = parsed.ids.map((id, index) => ({
    memberId: `${effect.id}#${index}`,
    carrierEffectId: effect.id,
    memberIndex: index,
    operator,
    from,
    to,
    tokenId: id.toString(),
    value: parsed.values[index]!.toString(),
    evidenceIds: [...effect.evidence],
    ...(context.transactionHash === undefined
      ? {}
      : { transactionHash: context.transactionHash }),
    ...(context.blockNumber === undefined ? {} : { blockNumber: context.blockNumber }),
    ...(context.logIndex === undefined ? {} : { logIndex: context.logIndex }),
  }));

  const observation: TransferBatchObservation = {
    effectId: effect.id,
    contract: normalizeEvmAddress(addressRaw),
    operator,
    from,
    to,
    members,
    evidenceIds: [...effect.evidence],
    ...(context.transactionHash === undefined ? {} : { transactionHash: context.transactionHash }),
    ...(context.blockNumber === undefined ? {} : { blockNumber: context.blockNumber }),
    ...(context.logIndex === undefined ? {} : { logIndex: context.logIndex }),
  };
  return { status: "transferBatch", observation };
}

/**
 * Strict ABI decode of `abi.encode(uint256[] ids, uint256[] values)`.
 * Returns either a decoded pair or a human-readable failure reason; never
 * throws. Enforces aligned, in-range, non-overlapping, complete tails and
 * equal array lengths.
 */
function decodeTransferBatchArrays(
  dataRaw: string,
): { ids: bigint[]; values: bigint[] } | { error: string } {
  if (!/^0x[0-9a-fA-F]*$/.test(dataRaw)) {
    return { error: "fields.data must be a 0x-prefixed hex string" };
  }
  const body = dataRaw.slice(2);
  if (body.length === 0 || body.length % 64 !== 0) {
    return { error: "fields.data must be a whole number of 32-byte words" };
  }
  const wordCount = body.length / 64;
  // Head occupies two offset words (ids, values).
  if (wordCount < 2) {
    return { error: "fields.data must carry at least the two head offset words" };
  }
  const wordAt = (i: number): bigint => BigInt(`0x${body.slice(i * 64, (i + 1) * 64)}`);

  const offsetIds = wordAt(0);
  const offsetValues = wordAt(1);
  // Offsets must be 32-byte aligned and fall inside the data.
  if (offsetIds % 32n !== 0n || offsetValues % 32n !== 0n) {
    return { error: "dynamic array head offsets must be 32-byte aligned" };
  }
  const idsStart = Number(offsetIds / 32n);
  const valuesStart = Number(offsetValues / 32n);
  if (idsStart < 2 || valuesStart < 2 || idsStart >= wordCount || valuesStart >= wordCount) {
    return { error: "dynamic array head offsets must point inside the data, after the head" };
  }

  const readArray = (
    start: number,
  ): { ok: true; count: number; dataStart: number; end: number } | { ok: false; error: string } => {
    const count = wordAt(start);
    if (count > 2n ** 32n) {
      return { ok: false, error: "dynamic array length overflows a sane bound" };
    }
    const c = Number(count);
    const dataStart = start + 1;
    const end = dataStart + c;
    if (end > wordCount) {
      return { ok: false, error: "dynamic array length exceeds available data (truncated tail)" };
    }
    return { ok: true, count: c, dataStart, end };
  };

  const idsRead = readArray(idsStart);
  if (!idsRead.ok) return { error: idsRead.error };
  const valuesRead = readArray(valuesStart);
  if (!valuesRead.ok) return { error: valuesRead.error };

  // Non-overlapping: the two array spans must not intersect, and together
  // they must consume ALL remaining words (no trailing garbage).
  const overlap =
    idsRead.dataStart < valuesRead.end && valuesRead.dataStart < idsRead.end;
  if (overlap) {
    return { error: "dynamic array spans overlap" };
  }
  const maxEnd = Math.max(idsRead.end, valuesRead.end);
  if (maxEnd !== wordCount) {
    return { error: "fields.data carries trailing words after the decoded arrays (incomplete tail)" };
  }

  const ids: bigint[] = [];
  for (let i = 0; i < idsRead.count; i++) {
    ids.push(wordAt(idsRead.dataStart + i));
  }
  const values: bigint[] = [];
  for (let i = 0; i < valuesRead.count; i++) {
    values.push(wordAt(valuesRead.dataStart + i));
  }
  if (ids.length !== values.length) {
    return { error: `ids.length (${ids.length}) must equal values.length (${values.length})` };
  }
  return { ids, values };
}
