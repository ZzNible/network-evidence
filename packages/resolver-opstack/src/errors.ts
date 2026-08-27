/**
 * Resolver-local controlled errors for the OP Stack finality layer.
 *
 * Deliberately NOT `NecValidationError`/`NecWireError` (those are @nec/core
 * contracts) and NOT `NecResolverEvmError` (the generic EVM resolver's own
 * surface): OP Stack finality failures are resolver-family failures with
 * their own stable machine-readable codes. Every failure is fail-closed.
 */

export type NecResolverOpStackErrorCode =
  | "OPSTACK_SOURCE_CONFIG_INVALID"
  | "OPSTACK_CONFIG_INVALID"
  | "OPSTACK_SUBJECT_BLOCK_INVALID"
  | "OPSTACK_TIME_INVALID"
  | "OPSTACK_NETWORK_MISMATCH"
  | "OPSTACK_RPC_REQUEST_FAILED"
  | "OPSTACK_RPC_ERROR_RESPONSE"
  | "OPSTACK_MALFORMED_RESPONSE"
  | "OPSTACK_LIMIT_EXCEEDED"
  | "OPSTACK_OBSERVATION_INCOMPLETE"
  | "OPSTACK_FIXTURE_INVALID"
  | "OPSTACK_REPLAY_UNMATCHED_REQUEST"
  | "OPSTACK_REPLAY_UNUSED_CAPTURES";

export class NecResolverOpStackError extends Error {
  readonly code: NecResolverOpStackErrorCode;

  constructor(code: NecResolverOpStackErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = "NecResolverOpStackError";
    this.code = code;
  }
}

export function opstackFail(code: NecResolverOpStackErrorCode, message: string): never {
  throw new NecResolverOpStackError(code, message);
}
