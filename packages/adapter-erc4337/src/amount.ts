/**
 * Exact uint256 quantity handling for claim fields (`tokenId`, `value`,
 * compared against event data words). Decimal strings of atomic units —
 * compared with BigInt arithmetic only; no JS-number amount semantics
 * anywhere near precision-relevant values.
 */

import { MAX_DECIMAL_INTEGER_DIGITS } from "@nec/core";

import { erc4337Fail } from "./errors.js";

const DECIMAL_PATTERN = /^[0-9]+$/;
const UINT256_MAX = (1n << 256n) - 1n;

/**
 * Validate an exact uint256 decimal string:
 *   - digits only (no sign, whitespace, separators or exponent);
 *   - at most `MAX_DECIMAL_INTEGER_DIGITS` digits (core resource bound);
 *   - value within the uint256 range.
 * The returned value is the canonical digit string WITHOUT leading zeros.
 * Zero is allowed here; callers decide whether zero is degenerate for their
 * field (`value` must be strictly positive, `tokenId` may legitimately be 0).
 */
export function parseUint256Decimal(value: unknown, what: string): string {
  if (typeof value !== "string" || !DECIMAL_PATTERN.test(value)) {
    erc4337Fail("ERC4337_AMOUNT_INVALID", `${what} must be a decimal string (digits only)`);
  }
  if (value.length > MAX_DECIMAL_INTEGER_DIGITS) {
    erc4337Fail("ERC4337_AMOUNT_INVALID", `${what} exceeds ${MAX_DECIMAL_INTEGER_DIGITS} decimal digits`);
  }
  const canonical = value.replace(/^0+/, "") || "0";
  if (BigInt(canonical) > UINT256_MAX) {
    erc4337Fail("ERC4337_AMOUNT_INVALID", `${what} exceeds the uint256 range`);
  }
  return canonical;
}
