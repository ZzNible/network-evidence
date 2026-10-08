/**
 * EXPLICIT Solana BEFORE profiles for mainnet and devnet.
 *
 * A profile is presentation/routing metadata wrapped around ONE explicit
 * `SolanaBeforeNetworkConfig`. Only `config` ever enters a derivation; `id`,
 * `label` and `environment` are caller-facing labels kept OUTSIDE evidence
 * truth (they never appear in a manifest, snapshot, candidate or preflight).
 *
 * Each config pins the FULL `getGenesisHash` result; the CAIP-2 network id is
 * derived from it (`solana:` + first 32 characters). Profile membership is
 * NOT evidence of current availability.
 */

import { deepFreeze } from "@nec/core";

import { validateSolanaBeforeNetworkConfig } from "./before.js";
import type { SolanaBeforeNetworkConfig } from "./before.js";

/** Presentation-only environment label. Never evidence. */
export type SolanaBeforeEnvironment = "mainnet" | "testnet";

export interface SolanaBeforeProfile {
  /** Stable presentation id of the profile. */
  readonly id: string;
  /** Human-readable presentation label. */
  readonly label: string;
  /** Presentation-only environment label (never evidence, never inferred). */
  readonly environment: SolanaBeforeEnvironment;
  /** THE explicit genesis-bound network configuration a derivation consumes. */
  readonly config: SolanaBeforeNetworkConfig;
}

function profile(
  id: string,
  label: string,
  environment: SolanaBeforeEnvironment,
  genesisHash: string,
): SolanaBeforeProfile {
  const config: SolanaBeforeNetworkConfig = { networkId: `solana:${genesisHash.slice(0, 32)}`, genesisHash };
  validateSolanaBeforeNetworkConfig(config);
  return deepFreeze({ id, label, environment, config });
}

/**
 * Solana mainnet — full genesis `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d`
 * (as pinned by the real mainnet fixture), CAIP `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`.
 */
export const SOLANA_MAINNET_BEFORE_PROFILE: SolanaBeforeProfile = profile(
  "solana-mainnet",
  "Solana mainnet",
  "mainnet",
  "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
);

/**
 * Solana devnet — full genesis `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`
 * (read-only `getGenesisHash`, 2026-10-08, pinned by the devnet probe
 * fixture), CAIP `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`.
 */
export const SOLANA_DEVNET_BEFORE_PROFILE: SolanaBeforeProfile = profile(
  "solana-devnet",
  "Solana devnet",
  "testnet",
  "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
);

/** The explicit Solana BEFORE profiles, in fixed order (no ranking implied). */
export const SOLANA_BEFORE_PROFILES: readonly SolanaBeforeProfile[] = Object.freeze([
  SOLANA_MAINNET_BEFORE_PROFILE,
  SOLANA_DEVNET_BEFORE_PROFILE,
]);
