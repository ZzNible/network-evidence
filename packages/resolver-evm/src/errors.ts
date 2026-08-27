/**
 * Resolver-local controlled errors for the generic EVM acquisition layer.
 *
 * Deliberately NOT `NecValidationError`/`NecWireError` (those are @nec/core
 * contracts): acquisition failures are resolver-family failures. Every
 * failure is fail-closed and carries a stable machine-readable code.
 */

export type NecResolverEvmErrorCode =
  | "EVM_SOURCE_CONFIG_INVALID"
  | "EVM_TX_HASH_INVALID"
  | "EVM_TIME_INVALID"
  | "EVM_NETWORK_MISMATCH"
  | "EVM_RPC_REQUEST_FAILED"
  | "EVM_RPC_ERROR_RESPONSE"
  | "EVM_MALFORMED_RESPONSE"
  | "EVM_LIMIT_EXCEEDED"
  | "EVM_OBSERVATION_INCOMPLETE"
  | "EVM_FIXTURE_INVALID"
  | "EVM_REPLAY_UNMATCHED_REQUEST"
  | "EVM_REPLAY_UNUSED_CAPTURES";

export class NecResolverEvmError extends Error {
  readonly code: NecResolverEvmErrorCode;

  constructor(code: NecResolverEvmErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = "NecResolverEvmError";
    this.code = code;
  }
}

export function evmFail(code: NecResolverEvmErrorCode, message: string): never {
  throw new NecResolverEvmError(code, message);
}

/**
 * Strip transport-adjacent material (RPC endpoint URLs) from an upstream
 * error message before it can flow into a resolver artifact or log line.
 * API keys/secrets must never enter artifacts; URLs must not either.
 */
export function redactUrlOccurrences(text: string, url: string): string {
  if (url.length === 0) return text;
  return text.split(url).join("[redacted-endpoint]");
}
