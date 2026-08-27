/** Base class for all NEC core errors. Fail-closed by construction: any throw aborts the operation. */
export class NecError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** Thrown when input data is malformed, of an unknown enum value, or violates a NEC invariant. */
export class NecValidationError extends NecError {}

/** Thrown by `nec-canonical-json-v1` for values outside the deterministic input domain. */
export class NecCanonicalizationError extends NecError {}

/** Thrown by digest helpers for invalid domains or malformed inputs. */
export class NecDigestError extends NecError {}

/** Thrown by the `nec-wire-json-v1` profile for malformed or non-conforming wire documents. */
export class NecWireError extends NecError {}
