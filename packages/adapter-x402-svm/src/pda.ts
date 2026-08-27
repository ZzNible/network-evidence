import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519";
import { decodeBase58, encodeBase58, parsePublicKey } from "@nec/resolver-solana";

import { NecAdapterX402SvmError } from "./errors.js";

export const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const PDA_MARKER = new TextEncoder().encode("ProgramDerivedAddress");

function isOnCurve(bytes: Uint8Array): boolean {
  try {
    ed25519.ExtendedPoint.fromHex(bytes);
    return true;
  } catch {
    return false;
  }
}

export function findProgramAddress(seeds: readonly Uint8Array[], programId: string): { address: string; bump: number } {
  parsePublicKey(programId, "programId");
  // findProgramAddress appends the bump as one seed, so callers may supply
  // at most 15 seeds under Solana's 16-seed total limit.
  if (seeds.length > 15 || seeds.some((seed) => seed.length > 32)) throw new NecAdapterX402SvmError("X402_SVM_PDA_DERIVATION_FAILED", "PDA seeds exceed Solana limits");
  const program = decodeBase58(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const hash = createHash("sha256");
    for (const seed of seeds) hash.update(seed);
    hash.update(Uint8Array.of(bump));
    hash.update(program);
    hash.update(PDA_MARKER);
    const candidate = new Uint8Array(hash.digest());
    if (!isOnCurve(candidate)) return { address: encodeBase58(candidate), bump };
  }
  throw new NecAdapterX402SvmError("X402_SVM_PDA_DERIVATION_FAILED", "unable to derive an off-curve program address");
}

export function deriveAssociatedTokenAddress(owner: string, mint: string, tokenProgram: string): string {
  parsePublicKey(owner, "owner");
  parsePublicKey(mint, "mint");
  parsePublicKey(tokenProgram, "tokenProgram");
  return findProgramAddress([decodeBase58(owner), decodeBase58(tokenProgram), decodeBase58(mint)], ASSOCIATED_TOKEN_PROGRAM).address;
}
