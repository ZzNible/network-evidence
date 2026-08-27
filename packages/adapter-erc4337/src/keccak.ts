/**
 * Self-contained, dependency-free Keccak-256 (legacy Keccak padding, as used
 * by Ethereum).
 *
 * Scope of use inside this adapter:
 *   1. EIP-55 mixed-case address checksum verification.
 *   2. Deriving the pinned event topic0 constants in tests:
 *      `UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)`
 *      and `TransferSingle(address,address,address,uint256,uint256)`.
 *      The runtime constants are pinned literals; the test suite proves the
 *      canonical-signature derivation matches the pins.
 *
 * Pure byte computation: no I/O, no clock, no randomness. Deterministic.
 */

const MASK64 = (1n << 64n) - 1n;
const ROUND_COUNT = 24;
const RATE_BYTES = 136; // Keccak-256 capacity 512 bits => rate 1088 bits.

/** Round constants iota(RC[round]) from the Keccak reference. */
const ROUND_CONSTANTS: readonly bigint[] = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

/**
 * Rotation offsets rho[r][c] for lane (r, c); lane (r, c) lives at state
 * index r + 5*c under the reference convention used below (A[x + 4y] with
 * x=r, y=c flattened over a 5x4 stride). Values are the canonical Keccak
 * rotation offset table.
 */
const ROTATION_OFFSETS: readonly (readonly number[])[] = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
];

function rotl64(value: bigint, shift: number): bigint {
  if (shift === 0) return value & MASK64;
  const n = BigInt(shift);
  return ((value << n) | (value >> (64n - n))) & MASK64;
}

function keccakF1600(lanes: bigint[]): void {
  for (let round = 0; round < ROUND_COUNT; round++) {
    // theta
    const c: bigint[] = new Array<bigint>(5);
    for (let x = 0; x < 5; x++) {
      c[x] = lanes[x]! ^ lanes[x + 5]! ^ lanes[x + 10]! ^ lanes[x + 15]! ^ lanes[x + 20]!;
    }
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5]! ^ rotl64(c[(x + 1) % 5]!, 1);
      for (let y = 0; y < 5; y++) {
        lanes[x + 5 * y] = (lanes[x + 5 * y]! ^ d) & MASK64;
      }
    }

    // rho + pi
    const b: bigint[] = new Array<bigint>(25).fill(0n);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl64(lanes[x + 5 * y]!, ROTATION_OFFSETS[x]![y]!);
      }
    }

    // chi
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        lanes[x + 5 * y] =
          (b[x + 5 * y]! ^ ((~b[(x + 1) % 5 + 5 * y]! & MASK64) & b[(x + 2) % 5 + 5 * y]!)) & MASK64;
      }
    }

    // iota
    lanes[0] = (lanes[0]! ^ ROUND_CONSTANTS[round]!) & MASK64;
  }
}

function loadLanes(block: Uint8Array): bigint[] {
  const lanes: bigint[] = new Array(25);
  for (let i = 0; i < 25; i++) {
    let lane = 0n;
    for (let j = 7; j >= 0; j--) {
      lane = (lane << 8n) | BigInt(block[i * 8 + j]!);
    }
    lanes[i] = lane;
  }
  return lanes;
}

function storeLanes(state: Uint8Array, lanes: bigint[]): void {
  for (let i = 0; i < 25; i++) {
    let lane = lanes[i]!;
    for (let j = 0; j < 8; j++) {
      state[i * 8 + j] = Number(lane & 0xffn);
      lane >>= 8n;
    }
  }
}

function xorBytesInto(state: Uint8Array, bytes: Uint8Array, offset: number): void {
  for (let i = 0; i < bytes.length; i++) {
    state[offset + i]! ^= bytes[i]!;
  }
}

function squeeze(state: Uint8Array): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = state[i]!;
  return out;
}

/** Keccak-256 (Ethereum variant: 0x01 domain padding, NOT SHA-3's 0x06). */
function permute(state: Uint8Array): void {
  const lanes = loadLanes(state);
  keccakF1600(lanes);
  storeLanes(state, lanes);
}

export function keccak256(bytes: Uint8Array): Uint8Array {
  const state = new Uint8Array(200);
  let offset = 0;
  // Absorb full-rate blocks while at least one byte of padding remains.
  while (bytes.length - offset >= RATE_BYTES) {
    xorBytesInto(state, bytes.subarray(offset, offset + RATE_BYTES), 0);
    permute(state);
    offset += RATE_BYTES;
  }
  // Final block with multi-rate padding pad10*1, domain byte 0x01:
  //   message || 0x01 || 0x00... || 0x80
  const remainder = bytes.subarray(offset);
  const block = new Uint8Array(RATE_BYTES);
  block.set(remainder, 0);
  block[remainder.length]! ^= 0x01;
  block[RATE_BYTES - 1]! ^= 0x80;
  xorBytesInto(state, block, 0);
  permute(state);
  return squeeze(state);
}

export function keccak256Hex(bytes: Uint8Array): string {
  const digest = keccak256(bytes);
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

export function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
