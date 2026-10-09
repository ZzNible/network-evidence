/**
 * MCP-layer controlled errors and their safe, informative serialization.
 *
 * A tool error carries a stable `code`, a bounded message and (when the
 * failure came from @nec/core or @nec/discovery) the bounded name/code/message
 * of the preserved cause. Stack traces, file paths of the server and raw
 * caller payloads are never serialized.
 */

export type NeMcpErrorCode =
  | "MCP_INPUT_INVALID"
  | "MCP_WIRE_DECODE_FAILED"
  | "MCP_CANDIDATE_NETWORK_MISMATCH"
  | "MCP_ENVIRONMENT_LABEL_CONFLICT"
  | "MCP_CASE_UNKNOWN"
  | "MCP_LIVE_EVM_CONFIG"
  | "MCP_LIVE_EVM_INPUT"
  | "MCP_LIVE_EVM_RPC_FAILED"
  | "MCP_LIVE_EVM_TOO_LARGE"
  | "MCP_LIVE_EVM_RATE_LIMIT"
  | "MCP_MULTICHAIN_INPUT"
  | "MCP_MULTICHAIN_RATE_LIMIT"
  | "MCP_MULTICHAIN_TOO_LARGE"
  | "MCP_MULTICHAIN_SOURCE_FAILED"
  | "MCP_LIVE_BEFORE_INPUT"
  | "MCP_LIVE_BEFORE_UNAVAILABLE"
  | "MCP_LIVE_PREFLIGHT_INPUT"
  | "MCP_LIVE_PREFLIGHT_UNAVAILABLE"
  | "MCP_LIVE_PREFLIGHT_CONTEXT_INVALID"
  | "MCP_LIVE_PREFLIGHT_TOO_LARGE"
  | "MCP_CLAIM_INVALID"
  | "MCP_CLAIM_ASSESSMENT_FAILED"
  | "MCP_RESULT_UNVERIFIED"
  | "MCP_INTERNAL_ERROR";

export class NeMcpError extends Error {
  readonly code: NeMcpErrorCode;

  constructor(code: NeMcpErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "NeMcpError";
    this.code = code;
  }
}

/** Invalid or unsafe server configuration; the server refuses to start. */
export class NeMcpConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NeMcpConfigError";
  }
}

/** Upper bound on any message text returned to a caller. */
export const MAX_ERROR_MESSAGE_CHARS = 2000;

export interface SafeErrorCause {
  readonly name: string;
  readonly code: string | null;
  readonly message: string;
}

export interface SafeToolError {
  readonly code: string;
  readonly message: string;
  readonly cause: SafeErrorCause | null;
}

function bounded(text: string): string {
  return text.length <= MAX_ERROR_MESSAGE_CHARS ? text : `${text.slice(0, MAX_ERROR_MESSAGE_CHARS)}… [truncated]`;
}

function errorCode(error: Error): string | null {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/** Errors whose messages are authored by Network Evidence code (never raw I/O). */
const KNOWN_ERROR_NAMES = new Set([
  "NeMcpError",
  "NecDiscoveryError",
  "NecValidationError",
  "NecWireError",
  "NecCanonicalizationError",
  "NecDigestError",
]);

/**
 * Serialize an error for a caller. Known Network Evidence errors keep their
 * code and message (and one level of cause); anything else collapses to a
 * generic internal error with no detail.
 */
export function toSafeToolError(error: unknown): SafeToolError {
  if (!(error instanceof Error) || !KNOWN_ERROR_NAMES.has(error.name)) {
    return { code: "MCP_INTERNAL_ERROR", message: "internal error (details withheld)", cause: null };
  }
  const code = errorCode(error) ?? error.name;
  let cause: SafeErrorCause | null = null;
  const raw = error.cause;
  if (raw instanceof Error && KNOWN_ERROR_NAMES.has(raw.name)) {
    cause = { name: raw.name, code: errorCode(raw), message: bounded(raw.message) };
  } else if (raw !== undefined) {
    cause = { name: "Error", code: null, message: "cause withheld" };
  }
  return { code, message: bounded(error.message), cause };
}
