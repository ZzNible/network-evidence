/**
 * Orchestrator-local controlled errors. Deliberately NOT `NecValidationError`
 * (a @nec/core contract): these codes name which orchestration step failed
 * closed. When Core rejected the input, the Core error is kept as `cause`.
 */

export type NecDiscoveryErrorCode =
  | "DISCOVERY_INPUT_INVALID"
  | "DISCOVERY_REQUIREMENTS_INVALID"
  | "DISCOVERY_CANDIDATE_ID_INVALID"
  | "DISCOVERY_CANDIDATE_ID_DUPLICATE"
  | "DISCOVERY_ENVIRONMENT_INVALID"
  | "DISCOVERY_CANDIDATE_BINDING_INVALID"
  | "DISCOVERY_NETWORK_DUPLICATE"
  | "DISCOVERY_CONTEXT_CONFLICT"
  | "DISCOVERY_SCOPE_INVALID"
  | "DISCOVERY_SCOPE_UNKNOWN_CANDIDATE"
  | "DISCOVERY_SCOPE_CONFLICT"
  | "DISCOVERY_RESULT_INVALID";

export class NecDiscoveryError extends Error {
  readonly code: NecDiscoveryErrorCode;

  constructor(code: NecDiscoveryErrorCode, message: string, options?: { cause?: unknown }) {
    super(`[${code}] ${message}`, options);
    this.name = "NecDiscoveryError";
    this.code = code;
  }
}

export function discoveryFail(code: NecDiscoveryErrorCode, message: string, cause?: unknown): never {
  throw new NecDiscoveryError(code, message, cause === undefined ? undefined : { cause });
}
