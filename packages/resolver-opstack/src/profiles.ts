/**
 * EXPLICIT OP Stack BEFORE profiles for the two Base environments.
 *
 * A profile is presentation/routing metadata wrapped around ONE explicit
 * `OpStackFinalityConfig`. Only `config` ever enters a derivation; `id`,
 * `label` and `environment` are caller-facing labels kept OUTSIDE evidence
 * truth (they never appear in a manifest, snapshot, candidate or preflight).
 *
 * Profile membership is NOT evidence of current availability: a profile only
 * says which explicit configuration to evaluate. The OP Stack family is
 * configured here explicitly — it is never inferred from the chain id.
 */

import { deepFreeze } from "@nec/core";

import {
  OPSTACK_FAMILY,
  OPSTACK_FINALITY_RULESET,
  OPSTACK_FINALITY_RULESET_VERSION,
  validateOpStackFinalityConfig,
} from "./config.js";
import type { OpStackFinalityConfig } from "./config.js";

/** Presentation-only environment label. Never evidence. */
export type OpStackBeforeEnvironment = "mainnet" | "testnet";

export interface OpStackBeforeProfile {
  /** Stable presentation id of the profile. */
  readonly id: string;
  /** Human-readable presentation label. */
  readonly label: string;
  /** Presentation-only environment label (never evidence, never inferred). */
  readonly environment: OpStackBeforeEnvironment;
  /** THE explicit family/network configuration a derivation consumes. */
  readonly config: OpStackFinalityConfig;
}

function profile(
  id: string,
  label: string,
  environment: OpStackBeforeEnvironment,
  networkId: string,
  chainId: number,
): OpStackBeforeProfile {
  const config: OpStackFinalityConfig = {
    networkId,
    chainId,
    family: OPSTACK_FAMILY,
    ruleset: OPSTACK_FINALITY_RULESET,
    rulesetVersion: OPSTACK_FINALITY_RULESET_VERSION,
  };
  validateOpStackFinalityConfig(config);
  return deepFreeze({ id, label, environment, config });
}

/** Base mainnet — `eip155:8453`, explicitly configured as OP Stack. */
export const BASE_MAINNET_OPSTACK_BEFORE_PROFILE: OpStackBeforeProfile = profile(
  "base-mainnet",
  "Base mainnet",
  "mainnet",
  "eip155:8453",
  8453,
);

/** Base Sepolia — `eip155:84532`, explicitly configured as OP Stack. */
export const BASE_SEPOLIA_OPSTACK_BEFORE_PROFILE: OpStackBeforeProfile = profile(
  "base-sepolia",
  "Base Sepolia",
  "testnet",
  "eip155:84532",
  84532,
);

/** The explicit Base BEFORE profiles, in fixed order (no ranking implied). */
export const BASE_OPSTACK_BEFORE_PROFILES: readonly OpStackBeforeProfile[] = Object.freeze([
  BASE_MAINNET_OPSTACK_BEFORE_PROFILE,
  BASE_SEPOLIA_OPSTACK_BEFORE_PROFILE,
]);
