export type NecResolverSolanaErrorCode =
  | "SOLANA_INPUT_INVALID"
  | "SOLANA_NETWORK_MISMATCH"
  | "SOLANA_RPC_REQUEST_FAILED"
  | "SOLANA_RPC_ERROR_RESPONSE"
  | "SOLANA_MALFORMED_RESPONSE"
  | "SOLANA_UNSUPPORTED_TRANSACTION_VERSION"
  | "SOLANA_INCOMPLETE_ACCOUNT_KEYS"
  | "SOLANA_FIXTURE_INVALID"
  | "SOLANA_REPLAY_UNMATCHED_REQUEST"
  | "SOLANA_REPLAY_UNUSED_CAPTURES";

export class NecResolverSolanaError extends Error {
  readonly code: NecResolverSolanaErrorCode;

  constructor(code: NecResolverSolanaErrorCode, message: string) {
    super(message);
    this.name = "NecResolverSolanaError";
    this.code = code;
  }
}

export function solanaFail(code: NecResolverSolanaErrorCode, message: string): never {
  throw new NecResolverSolanaError(code, message);
}
