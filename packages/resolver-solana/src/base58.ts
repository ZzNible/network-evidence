import { solanaFail } from "./errors.js";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const INDEX = new Map([...ALPHABET].map((c, i) => [c, i]));

export function decodeBase58(value: string, label = "base58 value"): Uint8Array {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    solanaFail("SOLANA_INPUT_INVALID", `${label}: must be a bounded non-empty base58 string`);
  }
  const bytes: number[] = [0];
  for (const char of value) {
    const digit = INDEX.get(char);
    if (digit === undefined) solanaFail("SOLANA_INPUT_INVALID", `${label}: invalid base58 character`);
    let carry = digit;
    for (let i = 0; i < bytes.length; i++) {
      const next = (bytes[i] as number) * 58 + carry;
      bytes[i] = next & 0xff;
      carry = next >>> 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>>= 8;
    }
  }
  let leading = 0;
  while (leading < value.length && value[leading] === "1") leading += 1;
  const out = new Uint8Array(leading + bytes.length - (bytes.length === 1 && bytes[0] === 0 ? 1 : 0));
  for (let i = 0; i < out.length - leading; i++) out[out.length - 1 - i] = bytes[i] as number;
  return out;
}

export function encodeBase58(value: Uint8Array): string {
  if (value.length === 0) return "";
  const digits: number[] = [0];
  for (const byte of value) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      const next = (digits[i] as number) * 256 + carry;
      digits[i] = next % 58;
      carry = Math.floor(next / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let leading = 0;
  while (leading < value.length && value[leading] === 0) leading += 1;
  if (leading === value.length) return "1".repeat(leading);
  let out = "1".repeat(leading);
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i] as number];
  return out === "1" && value[0] !== 0 ? "" : out;
}

export function parsePublicKey(value: unknown, label: string): string {
  if (typeof value !== "string") solanaFail("SOLANA_INPUT_INVALID", `${label}: must be a base58 string`);
  const decoded = decodeBase58(value, label);
  if (decoded.length !== 32 || encodeBase58(decoded) !== value) {
    solanaFail("SOLANA_INPUT_INVALID", `${label}: must be a canonical 32-byte base58 public key`);
  }
  return value;
}

/** Solana cluster genesis identifiers are canonical base58 but are not public keys. */
export function parseGenesisHash(value: unknown, label = "genesis hash"): string {
  if (typeof value !== "string") solanaFail("SOLANA_INPUT_INVALID", `${label}: must be base58 text`);
  const decoded = decodeBase58(value, label);
  if (decoded.length < 16 || decoded.length > 64 || encodeBase58(decoded) !== value) {
    solanaFail("SOLANA_INPUT_INVALID", `${label}: must be a canonical bounded base58 hash`);
  }
  return value;
}

export function parseSignature(value: unknown, label = "signature"): string {
  if (typeof value !== "string") solanaFail("SOLANA_INPUT_INVALID", `${label}: must be a base58 string`);
  const decoded = decodeBase58(value, label);
  if (decoded.length !== 64 || encodeBase58(decoded) !== value) {
    solanaFail("SOLANA_INPUT_INVALID", `${label}: must be a canonical 64-byte base58 signature`);
  }
  return value;
}
