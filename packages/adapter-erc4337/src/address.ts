/**
 * EVM address handling: canonical-lowercase normalization plus EIP-55
 * mixed-case checksum verification (via the local keccak256).
 *
 * Rules (fail closed):
 *   - an address MUST be `0x` + 40 hexadecimal digits;
 *   - all-lowercase and all-uppercase forms carry no checksum information
 *     and are accepted as-is;
 *   - a MIXED-case form carries an EIP-55 checksum which MUST verify;
 *     a bad checksum is rejected (typo protection on untrusted input).
 * All comparisons inside the adapter use the normalized lowercase form.
 */

import { keccak256Hex, utf8Bytes } from "./keccak.js";
import { erc4337Fail } from "./errors.js";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

export function isEvmAddressShape(value: unknown): value is string {
  return typeof value === "string" && ADDRESS_PATTERN.test(value);
}

/**
 * Normalize an already shape-valid address to lowercase. Does NOT verify a
 * mixed-case checksum (see `normalizeEvmAddressStrict`).
 */
export function normalizeEvmAddress(address: string): string {
  return address.toLowerCase();
}

/** True iff the input mixes upper- and lower-case hex digits. */
function isMixedCase(address: string): boolean {
  const body = address.slice(2);
  return /[a-f]/.test(body) && /[A-F]/.test(body);
}

/** Recompute the EIP-55 checksummed rendering of a lowercase address. */
export function eip55ChecksumAddress(lowercaseAddress: string): string {
  const body = lowercaseAddress.slice(2); // lowercase by contract
  const digest = keccak256Hex(utf8Bytes(body));
  let out = "0x";
  for (let i = 0; i < 40; i++) {
    const ch = body[i]!;
    if (ch >= "a" && ch <= "f") {
      const nibble = Number.parseInt(digest[i]!, 16);
      out += nibble >= 8 ? ch.toUpperCase() : ch;
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * Validate + normalize one caller-supplied EVM address. Mixed-case input
 * must carry a valid EIP-55 checksum.
 */
export function normalizeEvmAddressStrict(value: unknown, what: string): string {
  if (!isEvmAddressShape(value)) {
    erc4337Fail(
      "ERC4337_ADDRESS_INVALID",
      `${what}: must be 0x followed by 40 hexadecimal digits`,
    );
  }
  const lowered = normalizeEvmAddress(value);
  if (isMixedCase(value) && eip55ChecksumAddress(lowered) !== value) {
    erc4337Fail(
      "ERC4337_ADDRESS_CHECKSUM_INVALID",
      `${what}: mixed-case address does not carry a valid EIP-55 checksum`,
    );
  }
  return lowered;
}
