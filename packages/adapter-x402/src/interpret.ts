/**
 * INTERPRETATION LAYER: generic NEC `ObservedEffect` -> ERC-20
 * Transfer-shaped observation.
 *
 * The x402 adapter consumes ONLY generic artifacts. An observed effect is
 * interpretable here when its `fields` mirror the generic EVM log
 * observation projection (address / topics / data / removed), mirroring the
 * normalized `EvmLogObservation` shape produced by generic EVM acquisition.
 *
 * Classification is SHAPE-DRIVEN, never label-driven: the effect `type`
 * string is ignored, the event topic structure decides. A log whose topic0
 * equals the ERC-20 Transfer topic but which fails the remaining structural
 * rules (exactly 3 topics, exactly one 32-byte data word, boolean removed
 * flag, well-formed optional context fields) is EXCLUDED with a recorded
 * reason — never partially interpreted, never silently dropped.
 *
 * Interpretation is NOT verification: recognizing a Transfer-shaped log
 * makes no statement about token honesty or balance effects.
 */

import type { ObservedEffect } from "@nec/core";

import { isEvmAddressShape, normalizeEvmAddress } from "./address.js";

/** keccak256("Transfer(address,address,uint256)") — pinned constant. */
export const ERC20_TRANSFER_EVENT_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const QUANTITY_PATTERN = /^0x[0-9a-f]+$/;
const DECIMAL_PATTERN = /^[0-9]+$/;

export interface TransferObservation {
  readonly effectId: string;
  /** Token contract (lowercase). */
  readonly asset: string;
  /** Sender (lowercase, decoded from topics[1]). */
  readonly from: string;
  /** Recipient (lowercase, decoded from topics[2]). */
  readonly to: string;
  /** Atomic units, rendered as a decimal STRING (JSON-safe; BigInt internal). */
  readonly amount: string;
  readonly evidenceIds: readonly string[];
  /** Optional context (present only when well-formed in the effect). */
  readonly transactionHash?: string;
  readonly blockNumber?: string;
  readonly logIndex?: string;
}

export type EffectInterpretation =
  | { readonly status: "transfer"; readonly observation: TransferObservation }
  | {
      readonly status: "excluded";
      readonly effectId: string;
      readonly reason: "removed" | "malformed";
      readonly detail: string;
    }
  | { readonly status: "unrelated" };

function lowerHash(value: string): string {
  return value.toLowerCase();
}

function decodeIndexedAddress(topic: string): string {
  // An indexed address parameter travels as a 32-byte topic: the low 20
  // bytes are the address, the high 12 bytes MUST be zero padding.
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

/**
 * Interpret ONE generic observed effect. Total function: never throws on
 * evidence content — every failure mode is a deterministic classification.
 */
export function interpretObservedEffect(effect: ObservedEffect): EffectInterpretation {
  const fields = requireRecord(effect.fields);
  if (fields === null) {
    return {
      status: "excluded",
      effectId: effect.id,
      reason: "malformed",
      detail: "effect.fields must be a plain record",
    };
  }

  // The removed flag is REQUIRED by the generic log observation contract;
  // absence means the projection did not follow the contract, so the effect
  // cannot back a positive claim.
  const removedRaw = fields["removed"];
  if (typeof removedRaw !== "boolean") {
    return {
      status: "excluded",
      effectId: effect.id,
      reason: "malformed",
      detail: "fields.removed must be a boolean (generic log observation contract)",
    };
  }

  const topicsRaw = fields["topics"];
  if (!Array.isArray(topicsRaw) || topicsRaw.length === 0) {
    return { status: "unrelated" };
  }
  for (let i = 0; i < topicsRaw.length; i++) {
    if (typeof topicsRaw[i] !== "string" || !HASH_PATTERN.test(topicsRaw[i] as string)) {
      if (i === 0) return { status: "unrelated" };
      return {
        status: "excluded",
        effectId: effect.id,
        reason: "malformed",
        detail: `fields.topics[${i}] must be a 32-byte hash`,
      };
    }
  }
  const topic0 = (topicsRaw[0] as string).toLowerCase();
  if (topic0 !== ERC20_TRANSFER_EVENT_TOPIC) {
    return { status: "unrelated" };
  }

  // From here on the effect CLAIMS to be an ERC-20 Transfer: every consumed
  // field must be structurally sound or the effect is excluded.
  if (removedRaw) {
    return {
      status: "excluded",
      effectId: effect.id,
      reason: "removed",
      detail: "log carries removed=true (orphaned by reorg); unusable as positive evidence",
    };
  }

  const addressRaw = fields["address"];
  if (typeof addressRaw !== "string" || !isEvmAddressShape(addressRaw)) {
    return {
      status: "excluded",
      effectId: effect.id,
      reason: "malformed",
      detail: "fields.address must be a 20-byte EVM address",
    };
  }
  if (topicsRaw.length !== 3) {
    return {
      status: "excluded",
      effectId: effect.id,
      reason: "malformed",
      detail: `an ERC-20 Transfer log has exactly 3 topics; got ${topicsRaw.length}`,
    };
  }
  const dataRaw = fields["data"];
  if (typeof dataRaw !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(dataRaw)) {
    return {
      status: "excluded",
      effectId: effect.id,
      reason: "malformed",
      detail: "fields.data must be exactly one 32-byte word (uint256 value)",
    };
  }

  const from = decodeIndexedAddress(topicsRaw[1] as string);
  const to = decodeIndexedAddress(topicsRaw[2] as string);
  if (from === "" || to === "") {
    return {
      status: "excluded",
      effectId: effect.id,
      reason: "malformed",
      detail: "indexed address topics must carry zero-padded 20-byte addresses",
    };
  }

  // Optional context fields: when present they must be well-formed.
  let transactionHash: string | undefined;
  let blockNumber: string | undefined;
  let logIndex: string | undefined;
  const txHashRaw = fields["transactionHash"];
  if (txHashRaw !== undefined && txHashRaw !== null) {
    if (typeof txHashRaw !== "string" || !HASH_PATTERN.test(txHashRaw)) {
      return {
        status: "excluded",
        effectId: effect.id,
        reason: "malformed",
        detail: "fields.transactionHash must be a 32-byte hash",
      };
    }
    transactionHash = lowerHash(txHashRaw);
  }
  const blockNumberRaw = fields["blockNumber"];
  if (blockNumberRaw !== undefined && blockNumberRaw !== null) {
    const parsed = parseContextQuantityToDecimal(blockNumberRaw);
    if (parsed === null) {
      return {
        status: "excluded",
        effectId: effect.id,
        reason: "malformed",
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
        status: "excluded",
        effectId: effect.id,
        reason: "malformed",
        detail: "fields.logIndex must be a canonical decimal or 0x-hex quantity string",
      };
    }
    logIndex = parsed;
  }

  const amount = BigInt(dataRaw.toLowerCase());

  return {
    status: "transfer",
    observation: {
      effectId: effect.id,
      asset: normalizeEvmAddress(addressRaw),
      from,
      to,
      amount: amount.toString(),
      evidenceIds: [...effect.evidence],
      ...(transactionHash === undefined ? {} : { transactionHash }),
      ...(blockNumber === undefined ? {} : { blockNumber }),
      ...(logIndex === undefined ? {} : { logIndex }),
    },
  };
}

/**
 * Context quantities (`blockNumber`, `transactionIndex`, `logIndex`) are
 * JSON-safe strings in generic effect fields. THE frozen generic EVM
 * projection (`buildLogObservedEffect` in @nec/resolver-evm) emits exact
 * DECIMAL strings; canonical 0x-prefixed hex quantities are equally
 * unambiguous and are accepted defensively. Both normalize to the same
 * decimal string; anything else is malformed (fail closed).
 */
function parseContextQuantityToDecimal(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 1002) {
    return null;
  }
  if (DECIMAL_PATTERN.test(value)) {
    return BigInt(value).toString();
  }
  // Canonical hex quantity: "0x" + hexadecimal digits without leading zeros
  // ("0x0" is the canonical zero).
  if (QUANTITY_PATTERN.test(value)) {
    const body = value.slice(2);
    if (body.length > 1 && body[0] === "0") {
      return null;
    }
    return BigInt(value).toString();
  }
  return null;
}
