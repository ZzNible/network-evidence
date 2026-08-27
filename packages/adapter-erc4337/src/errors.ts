/**
 * Controlled adapter errors. Adapter-local codes are namespaced `ERC4337_*`;
 * failures originating from frozen core validation (artifact intake) are
 * rethrown unchanged so callers see the canonical NEC error.
 */

export type NecAdapterErc4337ErrorCode =
  | "ERC4337_CLAIM_INVALID"
  | "ERC4337_NETWORK_MALFORMED"
  | "ERC4337_NETWORK_FAMILY_UNSUPPORTED"
  | "ERC4337_CHAIN_ID_OUT_OF_RANGE"
  | "ERC4337_ADDRESS_INVALID"
  | "ERC4337_ADDRESS_CHECKSUM_INVALID"
  | "ERC4337_AMOUNT_INVALID"
  | "ERC4337_TX_HASH_INVALID"
  | "ERC4337_HASH_INVALID"
  | "ERC4337_REQUIRE_SUCCESS_UNSUPPORTED"
  | "ERC4337_ENTRYPOINT_PROFILE_UNKNOWN"
  | "ERC4337_ENTRYPOINT_PROFILE_MISMATCH";

export class NecAdapterErc4337Error extends Error {
  readonly code: NecAdapterErc4337ErrorCode;

  constructor(code: NecAdapterErc4337ErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = "NecAdapterErc4337Error";
    this.code = code;
  }
}

/** Controlled failure with an adapter-local error code (never silent). */
export function erc4337Fail(code: NecAdapterErc4337ErrorCode, message: string): never {
  throw new NecAdapterErc4337Error(code, message);
}
