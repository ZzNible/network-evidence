/**
 * @nec/adapter-erc4337 — ERC-4337 UserOperation evidence adapter (v0.1).
 *
 * PURE protocol layer between ERC-4337 account-abstraction semantics and
 * NEC: maps an exact expected-UserOperation CLAIM (expected sender, exact
 * optional userOpHash, optional exact expected ERC-1155 burn) onto frozen
 * NEC contracts, then assesses generic `NetworkEvidenceFragment` EVM
 * evidence (frozen `NetworkResolver.resolve` output) for ONE EntryPoint
 * bundle transaction that EXACTLY identifies and correlates the claim.
 *
 * Nothing here acquires evidence, runs a bundler, owns keys, signs,
 * submits transactions, decides paymaster policy or performs Nevermined
 * plan lookups; nothing here extends or redefines @nec/core; nothing here
 * performs network I/O; nothing here claims finality.
 *
 * SCOPE CLAIM (deliberately narrow): ERC-4337 EntryPoint
 * UserOperationEvent interpretation on EVM (eip155) networks, success-only
 * v0.1 profile, optional exact ERC-1155 burn correlation across BOTH
 * TransferSingle and TransferBatch carriers. TransferBatch is first-class in
 * v0.1: each batch member is projected deterministically (carrier effect id
 * + member index, never silently summed), and duplicate exact burns across
 * carriers fail closed as ambiguous. No other account-abstraction surface is
 * claimed as supported.
 *
 * CHAIN OF TRUST (each link distinct — see README):
 *   bundle transaction != UserOperation != successful UserOperation !=
 *   matching observed burn != settlement/finality.
 */

// Claim layer: normalized claim + pure protocol→NEC correlation mapping.
export {
  parseErc4337Claim,
  buildErc4337Correlation,
  computeErc4337ClaimDigest,
  ACTION_KIND_ERC4337_USEROPERATION,
  EXPECTED_EFFECT_KIND_ERC1155_BURN,
  CLAIM_DIGEST_DOMAIN,
} from "./claim.js";
export type {
  Erc4337Claim,
  Erc4337UserOperationExpectation,
  Erc1155BurnExpectation,
  Erc4337Correlation,
  Erc4337CorrelationOptions,
} from "./claim.js";

// Assessment layer (fragment-first PRIMARY path + result compatibility form).
export {
  ERC4337_ADAPTER_PROFILE,
  PROPOSITION_NAMESPACE,
  ERC4337_CONFLICT_CODES,
  ERC4337_CLAIM_LABELS,
  ERC4337_NON_CLAIMS,
  ERC4337_WARNING_CODES,
  assessErc4337UserOperation,
  evaluateErc4337Bundle,
} from "./evaluate.js";
export type {
  Erc4337Evaluation,
  ExcludedCandidate,
  ObservationTxHashMismatch,
  BurnViolation,
  SelectedUserOperationFailure,
} from "./evaluate.js";

// Interpretation layer: generic ObservedEffect -> pinned event observations.
export {
  interpretUserOperationEventEffect,
  interpretTransferSingleEffect,
  interpretTransferBatchEffect,
  decodeIndexedAddressTopic,
} from "./interpret.js";

// Pinned event semantics.
export {
  USER_OPERATION_EVENT_TOPIC0,
  USER_OPERATION_EVENT_SIGNATURE,
  TRANSFER_SINGLE_TOPIC0,
  TRANSFER_SINGLE_SIGNATURE,
  TRANSFER_BATCH_TOPIC0,
  TRANSFER_BATCH_SIGNATURE,
  ZERO_ADDRESS,
  ENTRY_POINT_V0_7_OBSERVED_ON_BASE,
  ENTRY_POINT_PROFILES,
  entryPointAddressForProfile,
} from "./events.js";
export type {
  UserOperationEventObservation,
  UserOperationEventInterpretation,
  TransferSingleObservation,
  TransferSingleInterpretation,
  TransferBatchObservation,
  TransferBatchMemberObservation,
  TransferBatchInterpretation,
  Erc1155BurnObservation,
  EntryPointProfile,
} from "./events.js";

// Primitive value layers.
export { parseUint256Decimal } from "./amount.js";
export { parseCaip2EvmNetwork } from "./caip2.js";
export type { Caip2EvmNetwork } from "./caip2.js";
export {
  eip55ChecksumAddress,
  isEvmAddressShape,
  normalizeEvmAddress,
  normalizeEvmAddressStrict,
} from "./address.js";
export { keccak256, keccak256Hex, utf8Bytes } from "./keccak.js";

// Controlled errors.
export { NecAdapterErc4337Error } from "./errors.js";
export type { NecAdapterErc4337ErrorCode } from "./errors.js";
