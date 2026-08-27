/**
 * PINNED ERC-4337 / ERC-1155 event semantics (v0.1 profile).
 *
 * The topic0 constants below are PINNED LITERALS. The test suite derives
 * both from the canonical event signatures with the local keccak256 and
 * proves the derivation matches these pins — including that the CURRENT
 * (uint256 nonce) UserOperationEvent signature is used, never the old draft
 * uint64-nonce variant.
 *
 *   UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)
 *     topic[1] userOpHash  topic[2] sender  topic[3] paymaster
 *     data words: nonce, success, actualGasCost, actualGasUsed
 *
 *   TransferSingle(address,address,address,uint256,uint256)
 *     topic[1] operator    topic[2] from     topic[3] to
 *     data words: id, value
 *
 *   TransferBatch(address,address,address,uint256[],uint256[])
 *     topic[1] operator    topic[2] from     topic[3] to
 *     data words: ABI-encoded (uint256[] ids, uint256[] values)
 *
 * Burn semantics FOR THIS PROFILE: `to == ZERO_ADDRESS`. `from == zero` is
 * MINT semantics and never a burn. Both TransferSingle and TransferBatch
 * burns are first-class interpreted; each batch member is projected
 * deterministically with carrier effect id + member index and NEVER silently
 * summed with sibling members.
 */

/** ERC-4337 EntryPoint deployed-profile table (pinned emitter per profile). */
export const ENTRY_POINT_PROFILES = Object.freeze({
  "v0.6": "0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789",
  "v0.7": "0x0000000071727de22e5e9d8baf0edac6f37da032",
  "v0.8": "0x4337084d9e255ff0702461cf8895ce9e3b5f8f108",
  "v0.9": "0x433709009b8330fda32311df1c2afa402ed8d009",
} as const);

/** Known EntryPoint profile identifiers (fail-closed when unrecognized). */
export type EntryPointProfile = keyof typeof ENTRY_POINT_PROFILES;

/** Pinned emitter address for a KNOWN profile (lowercase). */
export function entryPointAddressForProfile(profile: string): string | undefined {
  const pinned = (ENTRY_POINT_PROFILES as Record<string, string>)[profile];
  return pinned === undefined ? undefined : pinned.toLowerCase();
}


/** keccak256(UserOperationEvent canonical signature) — pinned. */
export const USER_OPERATION_EVENT_TOPIC0 =
  "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f";

/** Canonical signature whose keccak256 MUST equal USER_OPERATION_EVENT_TOPIC0. */
export const USER_OPERATION_EVENT_SIGNATURE =
  "UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)";

/** keccak256(TransferSingle canonical signature) — pinned. */
export const TRANSFER_SINGLE_TOPIC0 =
  "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62";

/** Canonical signature whose keccak256 MUST equal TRANSFER_SINGLE_TOPIC0. */
export const TRANSFER_SINGLE_SIGNATURE = "TransferSingle(address,address,address,uint256,uint256)";

/** keccak256(TransferBatch canonical signature) — pinned (derived in tests). */
export const TRANSFER_BATCH_TOPIC0 =
  "0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb";

/** Canonical signature whose keccak256 MUST equal TRANSFER_BATCH_TOPIC0. */
export const TRANSFER_BATCH_SIGNATURE =
  "TransferBatch(address,address,address,uint256[],uint256[])";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * ERC-4337 EntryPoint v0.7 address OBSERVED on Base mainnet
 * (eip155:8453) during real-fixture acquisition. Informational constant
 * only: claims always name their expected entryPoint explicitly and no
 * semantic rule hardcodes this address.
 */
export const ENTRY_POINT_V0_7_OBSERVED_ON_BASE =
  "0x0000000071727de22e5e9d8baf0edac6f37da032";

/** Exact structural layout of one usable UserOperationEvent observation. */
export interface UserOperationEventObservation {
  readonly effectId: string;
  /** Emitting contract (lowercase); candidacy requires the claimed EntryPoint. */
  readonly emitter: string;
  readonly userOpHash: string;
  readonly sender: string;
  readonly paymaster: string;
  /** Exact decimal string of the uint256 nonce word. */
  readonly nonce: string;
  /** Canonical ABI bool decoded from the success word (only 0/1 survive). */
  readonly success: boolean;
  readonly actualGasCost: string;
  readonly actualGasUsed: string;
  readonly evidenceIds: readonly string[];
  /** Optional context (present only when well-formed in the effect). */
  readonly transactionHash?: string;
  readonly blockNumber?: string;
  readonly logIndex?: string;
}

export type UserOperationEventInterpretation =
  | { readonly status: "userOperationEvent"; readonly observation: UserOperationEventObservation }
  | {
      readonly status: "excluded";
      readonly effectId: string;
      readonly reason: "removed" | "malformed";
      readonly detail: string;
    }
  | { readonly status: "unrelated" };

/** Exact structural layout of one usable ERC-1155 TransferSingle observation. */
export interface TransferSingleObservation {
  readonly effectId: string;
  /** Token contract (lowercase). */
  readonly contract: string;
  readonly operator: string;
  readonly from: string;
  readonly to: string;
  /** Exact decimal strings of the two uint256 data words. */
  readonly tokenId: string;
  readonly value: string;
  readonly evidenceIds: readonly string[];
  readonly transactionHash?: string;
  readonly blockNumber?: string;
  readonly logIndex?: string;
}

export type TransferSingleInterpretation =
  | { readonly status: "transferSingle"; readonly observation: TransferSingleObservation }
  | {
      readonly status: "excluded";
      readonly effectId: string;
      readonly reason: "removed" | "malformed";
      readonly detail: string;
    }
  | { readonly status: "unrelated" };

/** One deterministically projected member of a TransferBatch. */
export interface TransferBatchMemberObservation {
  /** Stable member identity: carrier batch effectId + `#` + member index. */
  readonly memberId: string;
  /** Carrier batch effect id (the enclosing TransferBatch log). */
  readonly carrierEffectId: string;
  /** Zero-based member index inside the batch. */
  readonly memberIndex: number;
  readonly operator: string;
  readonly from: string;
  readonly to: string;
  readonly tokenId: string;
  readonly value: string;
  readonly evidenceIds: readonly string[];
  readonly transactionHash?: string;
  readonly blockNumber?: string;
  readonly logIndex?: string;
}

/** Exact structural layout of one usable ERC-1155 TransferBatch observation. */
export interface TransferBatchObservation {
  readonly effectId: string;
  readonly contract: string;
  readonly operator: string;
  readonly from: string;
  readonly to: string;
  /** Deterministically projected members (carrier effect id + member index). */
  readonly members: readonly TransferBatchMemberObservation[];
  readonly evidenceIds: readonly string[];
  readonly transactionHash?: string;
  readonly blockNumber?: string;
  readonly logIndex?: string;
}

export type TransferBatchInterpretation =
  | { readonly status: "transferBatch"; readonly observation: TransferBatchObservation }
  | {
      readonly status: "excluded";
      readonly effectId: string;
      readonly reason: "removed" | "malformed";
      readonly detail: string;
    }
  | { readonly status: "unrelated" };

/**
 * Unified ERC-1155 burn-shaped observation, regardless of carrier
 * (TransferSingle or a TransferBatch member). Used by the evaluation layer so
 * exact-burn correlation and duplicate detection treat both carriers
 * uniformly; duplicate detection therefore spans single+single, single+batch
 * and batch member+batch member.
 */
export interface Erc1155BurnObservation {
  /** Which pinned shape carried the burn. */
  readonly carrier: "transferSingle" | "transferBatch";
  /** Carrier-local identity: effectId (single) or memberId (batch member). */
  readonly effectId: string;
  /** Carrier batch effect id when carrier === "transferBatch". */
  readonly carrierEffectId?: string;
  /** Member index inside the batch when carrier === "transferBatch". */
  readonly memberIndex?: number;
  readonly contract: string;
  readonly operator: string;
  readonly from: string;
  readonly to: string;
  readonly tokenId: string;
  readonly value: string;
  readonly evidenceIds: readonly string[];
}
