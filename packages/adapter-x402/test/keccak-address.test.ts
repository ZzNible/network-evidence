import { describe, expect, it } from "vitest";

import {
  ERC20_TRANSFER_EVENT_TOPIC,
  NecAdapterX402Error,
  eip55ChecksumAddress,
  isEvmAddressShape,
  keccak256Hex,
  normalizeEvmAddressStrict,
  utf8Bytes,
} from "../src/index.js";

/** Deterministic byte pattern used for rate-boundary vectors. */
function patternBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 37 + 11) & 0xff;
  return out;
}

// Authoritative vectors generated independently with viem's keccak256 AND a
// from-scratch reference implementation, then pinned here so the
// dependency-free implementation stays honest.
const PINNED = {
  empty: "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
  abc: "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45",
  ascii200a: "96ea54061def936c4be90b518992fdc6f12f535068a256229aca54267b4d084d",
  bytes134: "bc3cddcf217dfd4bb76bb417c27dc2edcefc47b0c867f5cfec6e44533fe159f2",
  bytes135: "9b6deb2387c86783862216d0205051ba7d41fa4fa70a30e2abfe18ca94d22b22",
  bytes136: "b8717c6e7605ca3b5a0a94a147127679778a23a4324e53b910263673d0bfb55c",
  bytes137: "e2d9f409a6d575e1457f9d3f7436081485d5794bf84db179566eea07a8266e8d",
  bytes272: "79cacfd52db427ce7b9a771984a13387a6e31075bcc4716a5deddff6875c4e69",
} as const;

describe("keccak256 (Ethereum variant)", () => {
  it("matches published single-block vectors", () => {
    expect(keccak256Hex(utf8Bytes(""))).toBe(PINNED.empty);
    expect(keccak256Hex(utf8Bytes("abc"))).toBe(PINNED.abc);
  });

  it("matches pinned multi-rate-block and padding-boundary vectors", () => {
    expect(keccak256Hex(utf8Bytes("a".repeat(200)))).toBe(PINNED.ascii200a);
    expect(keccak256Hex(patternBytes(134))).toBe(PINNED.bytes134); // one pad byte
    expect(keccak256Hex(patternBytes(135))).toBe(PINNED.bytes135); // two pad bytes
    expect(keccak256Hex(patternBytes(136))).toBe(PINNED.bytes136); // exact rate
    expect(keccak256Hex(patternBytes(137))).toBe(PINNED.bytes137); // rate + 1
    expect(keccak256Hex(patternBytes(272))).toBe(PINNED.bytes272); // two blocks
  });

  it("derives the ERC-20 Transfer event topic constant", () => {
    expect(keccak256Hex(utf8Bytes("Transfer(address,address,uint256)"))).toBe(
      ERC20_TRANSFER_EVENT_TOPIC.slice(2),
    );
    expect(ERC20_TRANSFER_EVENT_TOPIC).toBe(
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
    );
  });
});

describe("EIP-55 checksummed addresses", () => {
  it("recomputes the canonical checksum for EIP-55 example addresses", () => {
    const lowercase = [
      "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed",
      "0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359",
      "0xdbf03b407c01e7cd3cbea99509d93f8dddc8c6fb",
      "0xd1220a0cf47c7b9be7a2e6ba89f429762e7b9adb",
    ];
    const checksummed = [
      "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
      "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
      "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
      "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
    ];
    for (let i = 0; i < lowercase.length; i++) {
      expect(eip55ChecksumAddress(lowercase[i]!)).toBe(checksummed[i]!);
    }
  });

  it("accepts lowercase, uppercase and valid-checksum mixed case", () => {
    const lower = "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed";
    expect(normalizeEvmAddressStrict(lower, "x")).toBe(lower);
    expect(normalizeEvmAddressStrict(`0x${lower.slice(2).toUpperCase()}`, "x")).toBe(lower);
    expect(normalizeEvmAddressStrict("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", "x")).toBe(
      lower,
    );
  });

  it("rejects invalid checksums, wrong shapes and non-strings", () => {
    // Last hex digit flipped from the valid checksum rendering.
    expect(() =>
      normalizeEvmAddressStrict("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD", "x"),
    ).toThrowError(NecAdapterX402Error);
    expect(() => normalizeEvmAddressStrict("0x1234", "x")).toThrowError(NecAdapterX402Error);
    expect(() => normalizeEvmAddressStrict("nope", "x")).toThrowError(NecAdapterX402Error);
    expect(() => normalizeEvmAddressStrict(42, "x")).toThrowError(NecAdapterX402Error);
  });

  it("shape guard is exact", () => {
    expect(isEvmAddressShape(`0x${"ab".repeat(20)}`)).toBe(true);
    expect(isEvmAddressShape(`0x${"AB".repeat(20)}`)).toBe(true);
    expect(isEvmAddressShape(`0x${"ab".repeat(19)}`)).toBe(false);
    expect(isEvmAddressShape(`0x${"ab".repeat(21)}`)).toBe(false);
    expect(isEvmAddressShape(`0x${"ag".repeat(20)}`)).toBe(false);
  });
});
