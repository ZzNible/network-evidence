/**
 * @nec/resolver-opstack — NEC's first NETWORK-SPECIFIC finality resolver.
 *
 * Vertical slice (acquisition strictly separated from pure evaluation):
 *
 *   generic EVM acquisition/evaluation (@nec/resolver-evm, frozen)
 *     -> subject transaction + containing L2 block anchor
 *     -> OP Stack finality acquisition (ONE configured source):
 *          eth_getBlockByNumber("finalized", false)
 *          eth_getBlockByNumber("safe", false)
 *          eth_getBlockByNumber("latest", false)
 *          [bounded parentHash ancestry walk down to the subject height]
 *          eth_getBlockByNumber(<subject height>, false)   [re-read]
 *          eth_getBlockByNumber("finalized", false)        [stability re-read]
 *     -> raw capture -> normalized observation
 *     -> pure OP Stack evaluator (pinned ruleset)
 *     -> NetworkEvidenceFragment carrying FINALITY ONLY
 *
 * SEMANTIC BOUNDARY (never collapsed): OP Stack L2 block finality is NOT
 * withdrawal/output finalization after a fault-proof dispute period. This
 * package implements L2 BLOCK FINALITY only; it never populates settlement.
 * "Finalized" always means the CONFIGURED SOURCE's OP Stack L2 finalized
 * view — never withdrawal finalization, dispute-game completion, or
 * economic irreversibility of funds.
 *
 * Evidence basis: source_observation ONLY, over ONE JSON-RPC source. This
 * resolver does not replay OP derivation from L1 inputs and runs no
 * consensus engine: local comparison/linking of RPC observations is not
 * derivation. Never deterministic_derivation, never local_consensus_engine,
 * never cryptographic_verification.
 */

// Errors
export { NecResolverOpStackError, opstackFail } from "./errors.js";
export type { NecResolverOpStackErrorCode } from "./errors.js";

// Explicit family configuration (Phase 4: family is NEVER inferred)
export {
  OPSTACK_FAMILY,
  OPSTACK_FINALITY_RULESET,
  OPSTACK_FINALITY_RULESET_VERSION,
  OPSTACK_MAX_ANCESTRY_DEPTH,
  opStackFinalityMetadata,
  validateOpStackFinalityConfig,
} from "./config.js";
export type { OpStackFinalityConfig } from "./config.js";

// Consistency invariants
export {
  allOpStackChecksPassed,
  runOpStackConsistencyChecks,
} from "./checks.js";
export type {
  ObservedBlockRef,
  OpStackAncestryWalkObservation,
  OpStackConsistencyCheck,
  OpStackConsistencyCheckCode,
  OpStackConsistencyInput,
} from "./checks.js";

// Acquisition
export {
  acquireOpStackFinalityObservation,
  OPSTACK_ACQUISITION_PROFILE,
  OPSTACK_REPLAY_ENDPOINT,
  runOpStackFinalityPipeline,
} from "./acquire.js";
export type {
  OpStackFinalityAcquisitionInput,
  OpStackFinalityObservation,
  OpStackSubjectBlockAnchor,
} from "./acquire.js";

// Pure evaluation (THE pinned ruleset semantics)
export {
  evaluateOpStackFinality,
  FINALITY_PROPOSITION,
  OPSTACK_CONFLICT_ID_PREFIX,
  OPSTACK_EVALUATION_PROFILE,
} from "./evaluator.js";
export type {
  EvaluatedOpStackDimension,
  OpStackFinalityEvaluation,
  OpStackFinalityEvaluationInput,
} from "./evaluator.js";

// Fixtures + replay
export {
  buildOpStackFinalityFixture,
  OPSTACK_FIXTURE_PROFILE,
  validateOpStackFinalityFixture,
} from "./fixture.js";
export type { OpStackFinalityFixture, OpStackFixtureSource } from "./fixture.js";
export { replayOpStackFinalityObservation } from "./replay.js";
export type { OpStackReplayOptions } from "./replay.js";
