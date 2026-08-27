/**
 * @nec/resolver-evm — generic EVM acquisition for NEC.
 *
 * Vertical slice:
 *
 *   configured source -> Viem JSON-RPC acquisition -> raw capture
 *     -> normalized generic-EVM observation -> offline deterministic replay
 *     -> foundation for NetworkEvidenceFragment
 *
 * Evidence infrastructure only: no signing, no wallet ownership, no
 * transaction submission, no execution, no x402 interpretation.
 * @nec/core is consumed, never redefined.
 */

// Errors
export { NecResolverEvmError, redactUrlOccurrences } from "./errors.js";
export type { NecResolverEvmErrorCode } from "./errors.js";

// Strict hex primitives
export {
  parseHexAddress,
  parseHexBloom,
  parseHexBytes,
  parseHexHash,
  parseHexQuantity,
  parseTransactionHashInput,
} from "./hex.js";
export type { EvmAddress, EvmHash, EvmHexBytes } from "./hex.js";

// Source configuration
export {
  sourceProvenance,
  validateAcquisitionClock,
  validateEvmRpcSourceDescriptor,
} from "./source.js";
export type {
  AcquisitionClock,
  EvmHttpTransportConfig,
  EvmRpcSourceDescriptor,
  SourceProvenance,
} from "./source.js";

// Raw capture
export {
  buildCapture,
  CAPTURE_DIGEST_DOMAIN,
  CAPTURE_PROFILE,
  exchangeIdentityKey,
  maxCapturesPerAcquisition,
  stableJsonKey,
  validateFixtureCaptureShape,
} from "./capture.js";
export type { EvmRpcCapture } from "./capture.js";

// JSON-RPC envelope scanning (raw-text extraction)
export { scanRpcEnvelope } from "./envelope.js";
export type { RpcEnvelope, RpcResponseId } from "./envelope.js";

// Normalized observations
export {
  parseBlockResult,
  parseChainIdResult,
  parseLog,
  parseReceiptResult,
  parseTransactionResult,
} from "./normalize.js";
export type {
  EvmBlockObservation,
  EvmChainIdentityObservation,
  EvmLogObservation,
  EvmReceiptObservation,
  EvmTransactionObservation,
} from "./normalize.js";

// Consistency invariants
export { allChecksPassed, runConsistencyChecks } from "./checks.js";
export type { ConsistencyInput, EvmConsistencyCheck, EvmConsistencyCheckCode } from "./checks.js";

// Acquisition
export {
  ACQUISITION_PROFILE,
  acquireTransactionObservation,
  runAcquisitionPipeline,
} from "./acquire.js";
export type { EvmTransactionAcquisition, TransactionAcquisitionInput } from "./acquire.js";

// Client/transport adapter
export {
  callViemAction,
  createRecordingFetch,
  createSourceClient,
  isValidRpcId,
  recordedIdentityKey,
} from "./client.js";
export type { FetchLike, RecordedExchange, RecordingFetchOptions } from "./client.js";

// Fixtures + replay
export {
  buildEvmAcquisitionFixture,
  FIXTURE_PROFILE,
  validateEvmAcquisitionFixture,
} from "./fixture.js";
export type {
  EvmAcquisitionFixture,
  EvmFixtureCapture,
  EvmFixtureCaptureError,
  EvmFixtureCaptureResult,
  EvmFixtureSource,
} from "./fixture.js";
export { replayTransactionAcquisition } from "./replay.js";
export type { ReplayOptions } from "./replay.js";

// Public core integration foundation
export { buildEvidenceRefs, isEvmAddress, toNetworkFingerprint, toSubjectRef } from "./evidence.js";

// Pure evaluation (v0.1): ONE acquisition -> propositions + NetworkEvidenceFragment
export { EVALUATION_PROFILE, evaluateTransactionAcquisition } from "./evaluator.js";
export type { EvaluatedDimension, EvmEvaluation } from "./evaluator.js";

// BEFORE foundation (v0.1): capability-probe observation -> support vs availability
export {
  deriveEvmBeforeFoundation,
  deriveEvmBeforePreflightResult,
  evmBeforeResolverManifest,
} from "./before.js";
export type {
  EvmBeforeDerivationInput,
  EvmBeforeFoundation,
  EvmCapabilityProbeObservation,
  EvmCapabilityProbeSource,
  EvmProbePath,
} from "./before.js";
