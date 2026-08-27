/**
 * @nec/adapter-x402 — x402 v2 EVM payment-evidence adapter.
 *
 * PURE protocol layer between x402 and NEC: maps a normalized x402 v2
 * `exact`-scheme payment CLAIM (expected terms + claimed payment
 * transaction) onto frozen NEC contracts, then assesses generic
 * `NetworkEvidenceFragment` EVM evidence (frozen `NetworkResolver.resolve`
 * output) for an observed ERC-20 Transfer that EXACTLY correlates to the
 * claimed transaction and matches the expected terms.
 *
 * Nothing here acquires evidence, calls facilitators, owns keys, signs or
 * submits transactions; nothing here extends or redefines @nec/core; nothing
 * here performs network I/O.
 *
 * SCOPE CLAIM (deliberately narrow): x402 protocol version 2, network
 * family eip155 (EVM), scheme `exact`, post-fact evidence assessment.
 * No other x402 scheme is claimed as supported.
 *
 * CHAIN OF TRUST (each link distinct — see README):
 *   protocol claim != network observation != successful execution !=
 *   matching observed Transfer != settlement/finality.
 *
 * STRONGEST POSITIVE RESULT: "an observed, exactly-correlated ERC-20
 * Transfer matches the expected x402 payment requirement". This is NOT
 * "x402 verified settlement"; see `X402_NON_CLAIMS`.
 */

// Claim layer: normalized claim + pure protocol→NEC correlation mapping.
export {
  parseX402PaymentClaim,
  buildX402PaymentCorrelation,
  ACTION_KIND_X402_PAYMENT,
} from "./claim.js";
export type {
  X402PaymentClaim,
  X402PaymentCorrelation,
  X402CorrelationOptions,
} from "./claim.js";

// Assessment layer (fragment-first PRIMARY path + result compatibility form).
export {
  X402_ADAPTER_PROFILE,
  PROPOSITION_NAMESPACE,
  X402_CONFLICT_CODES,
  X402_CLAIM_LABELS,
  X402_NON_CLAIMS,
  X402_WARNING_CODES,
  assessX402ExactPayment,
  evaluateX402ExactSettlement,
} from "./evaluate.js";
export type {
  X402PaymentEvaluation,
  ExcludedCandidate,
  TransactionHashMismatch,
} from "./evaluate.js";

// Interpretation layer: generic ObservedEffect -> ERC-20 Transfer observation.
export { interpretObservedEffect, ERC20_TRANSFER_EVENT_TOPIC } from "./interpret.js";
export type { TransferObservation, EffectInterpretation } from "./interpret.js";

// Requirement layer: x402 v2 exact expected-payment terms.
export {
  SUPPORTED_X402_SCHEME,
  SUPPORTED_X402_VERSION,
  REQUIREMENT_DIGEST_DOMAIN,
  computeRequirementDigest,
  parseX402ExactPaymentRequirement,
} from "./requirement.js";
export type { X402ExactPaymentRequirement } from "./requirement.js";

// Primitive value layers (retained recovered utilities).
export { parseAtomicAmount } from "./amount.js";
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
export { NecAdapterX402Error } from "./errors.js";
export type { NecAdapterX402ErrorCode } from "./errors.js";
