/**
 * x402 `amount` handling: a decimal string of ATOMIC token units, compared
 * with BigInt arithmetic only — no floats anywhere near payment precision.
 */

import { MAX_DECIMAL_INTEGER_DIGITS } from "@nec/core";

import { x402Fail } from "./errors.js";

const DECIMAL_PATTERN = /^[0-9]+$/;

/**
 * Validate an atomic-units amount string.
 *   - digits only (no sign, whitespace, separators or exponent);
 *   - strictly positive (an exact payment of zero is rejected as degenerate);
 *   - at most `MAX_DECIMAL_INTEGER_DIGITS` digits (core resource bound).
 * The returned value is the canonical digit string WITHOUT leading zeros.
 */
export function parseAtomicAmount(value: unknown): string {
  if (typeof value !== "string" || !DECIMAL_PATTERN.test(value)) {
    x402Fail(
      "X402_AMOUNT_INVALID",
      "amount must be a decimal string of atomic units (digits only)",
    );
  }
  if (value.length > MAX_DECIMAL_INTEGER_DIGITS) {
    x402Fail(
      "X402_AMOUNT_INVALID",
      `amount exceeds ${MAX_DECIMAL_INTEGER_DIGITS} decimal digits`,
    );
  }
  const canonical = value.replace(/^0+/, "") || "0";
  if (canonical === "0") {
    x402Fail("X402_AMOUNT_INVALID", "amount must be greater than zero");
  }
  return canonical;
}
