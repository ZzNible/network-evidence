/**
 * Controlled adapter errors. Adapter-local codes are namespaced `X402_*`;
 * failures originating from frozen core validation (artifact intake) are
 * rethrown unchanged so callers see the canonical NEC error.
 */

export type NecAdapterX402ErrorCode =
  | "X402_REQUIREMENT_INVALID"
  | "X402_VERSION_UNSUPPORTED"
  | "X402_SCHEME_UNSUPPORTED"
  | "X402_NETWORK_MALFORMED"
  | "X402_NETWORK_FAMILY_UNSUPPORTED"
  | "X402_CHAIN_ID_OUT_OF_RANGE"
  | "X402_ADDRESS_INVALID"
  | "X402_ADDRESS_CHECKSUM_INVALID"
  | "X402_AMOUNT_INVALID"
  | "X402_CLAIM_INVALID"
  | "X402_TX_HASH_INVALID";

export class NecAdapterX402Error extends Error {
  readonly code: NecAdapterX402ErrorCode;

  constructor(code: NecAdapterX402ErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = "NecAdapterX402Error";
    this.code = code;
  }
}

/** Controlled failure with an adapter-local error code (never silent). */
export function x402Fail(code: NecAdapterX402ErrorCode, message: string): never {
  throw new NecAdapterX402Error(code, message);
}
