export type NecAdapterX402SvmErrorCode =
  | "X402_SVM_REQUIREMENT_INVALID"
  | "X402_SVM_VERSION_UNSUPPORTED"
  | "X402_SVM_SCHEME_UNSUPPORTED"
  | "X402_SVM_NETWORK_UNSUPPORTED"
  | "X402_SVM_CLAIM_INVALID"
  | "X402_SVM_PDA_DERIVATION_FAILED";

export class NecAdapterX402SvmError extends Error {
  readonly code: NecAdapterX402SvmErrorCode;
  constructor(code: NecAdapterX402SvmErrorCode, message: string) {
    super(message);
    this.name = "NecAdapterX402SvmError";
    this.code = code;
  }
}

export function svmFail(code: NecAdapterX402SvmErrorCode, message: string): never {
  throw new NecAdapterX402SvmError(code, message);
}
