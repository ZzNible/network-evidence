export type NecResolverZksysErrorCode =
  | "ZKSYS_INPUT_INVALID"
  | "ZKSYS_NETWORK_MISMATCH"
  | "ZKSYS_TIME_MISMATCH"
  | "ZKSYS_OBSERVATION_INCOMPLETE";

export class NecResolverZksysError extends Error {
  readonly code: NecResolverZksysErrorCode;

  constructor(code: NecResolverZksysErrorCode, message: string) {
    super(message);
    this.name = "NecResolverZksysError";
    this.code = code;
  }
}

export function zksysFail(code: NecResolverZksysErrorCode, message: string): never {
  throw new NecResolverZksysError(code, message);
}
