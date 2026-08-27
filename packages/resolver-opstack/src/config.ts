/**
 * EXPLICIT FAMILY CONFIGURATION (fail closed).
 *
 * NEC never infers the OP Stack chain family from a chain id: `chainId
 * 8453 => opstack` is NOT a rule this package implements or accepts.
 * Network identity (CAIP-2 networkId + EIP-155 chainId) and family
 * semantics (family + pinned ruleset) must be configured EXPLICITLY and
 * are re-validated at every boundary.
 *
 * The ruleset identifier is version-pinned and recorded in finality
 * metadata so every produced fragment names exactly the deterministic
 * rule that was applied.
 */

import { assertNetworkId, assertSafePositiveInteger } from "@nec/core";

import { NecResolverOpStackError } from "./errors.js";
import type { NecResolverOpStackErrorCode } from "./errors.js";

/** THE one version-pinned v0.1 finality ruleset implemented here. */
export const OPSTACK_FINALITY_RULESET = "opstack.rpc-finalized-head-v1";

/** Ruleset version recorded alongside the identifier in finality metadata. */
export const OPSTACK_FINALITY_RULESET_VERSION = "1";

/** The ONLY chain family this package evaluates. Never inferred. */
export const OPSTACK_FAMILY = "opstack";

/**
 * THE maximum finalized-head -> subject parentHash ancestry depth this
 * ruleset will ever walk, in explicit block reads. The v0.1 semantic review
 * set this ceiling at 10,000: a source whose observed finalized head lies
 * further above the subject height can NEVER support finality here — the
 * acquisition refuses the walk (fail closed) instead of extrapolating
 * ancestry from block numbers.
 */
export const OPSTACK_MAX_ANCESTRY_DEPTH = 10_000;

/**
 * Explicit, exact-key OP Stack finality configuration.
 *
 * `networkId`/`chainId` identify the target NETWORK; `family`/`ruleset`/
 * `rulesetVersion` pin the chain-family SEMANTICS. All five fields are
 * required; unknown keys fail closed. A configuration whose family is not
 * exactly "opstack" — or whose ruleset/version is not the pinned
 * `opstack.rpc-finalized-head-v1` / `"1"` pair — is rejected outright:
 * this package implements nothing else in v0.1.
 */
export interface OpStackFinalityConfig {
  /** CAIP-2 network id of the target network, e.g. "eip155:8453". */
  readonly networkId: string;
  /** Expected EIP-155 chain id; enforced against eth_chainId at acquisition. */
  readonly chainId: number;
  /** Explicit chain family. Only "opstack" is supported in v0.1. */
  readonly family: typeof OPSTACK_FAMILY;
  /** Pinned ruleset identifier recorded in finality metadata. */
  readonly ruleset: typeof OPSTACK_FINALITY_RULESET;
  /** Pinned ruleset version recorded in finality metadata. */
  readonly rulesetVersion: typeof OPSTACK_FINALITY_RULESET_VERSION;
}

const CONFIG_KEYS = new Set(["networkId", "chainId", "family", "ruleset", "rulesetVersion"]);

/**
 * Structural CAIP-2 shape for the explicitly configured network identity
 * (namespace:reference). Core intentionally treats NetworkId as an opaque
 * bounded identifier; THIS package additionally requires real CAIP-2
 * structure because its semantics are chain-network-specific.
 */
const CAIP2_PATTERN = /^[-a-z0-9]{3,8}:[-a-zA-Z0-9]{1,64}$/;

function fail(code: NecResolverOpStackErrorCode, message: string): never {
  throw new NecResolverOpStackError(code, message);
}

/**
 * Validate a hostile config value completely; unknown keys, wrong literals
 * or malformed network/chain identities fail closed. Base mainnet
 * (`eip155:8453`) is the first TESTED configuration, never a hardcoded or
 * implied one: any explicitly configured OP Stack network is accepted.
 */
export function validateOpStackFinalityConfig(value: unknown): asserts value is OpStackFinalityConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("OPSTACK_CONFIG_INVALID", "config must be a plain object");
  }
  const proto = Object.getPrototypeOf(value) as object | null;
  if (proto !== Object.prototype && proto !== null) {
    fail("OPSTACK_CONFIG_INVALID", "config must have a plain prototype");
  }
  const config = value as Record<string, unknown>;
  // Reflect.ownKeys: symbol-keyed properties cannot smuggle hidden config
  // past this boundary.
  for (const key of Reflect.ownKeys(config)) {
    if (typeof key === "symbol") {
      fail("OPSTACK_CONFIG_INVALID", `config.${String(key)}: symbol-keyed property rejected`);
    }
    if (!CONFIG_KEYS.has(key as string)) {
      fail("OPSTACK_CONFIG_INVALID", `config: unknown key ${JSON.stringify(key)}`);
    }
  }
  for (const key of ["networkId", "chainId", "family", "ruleset", "rulesetVersion"]) {
    if (!Object.prototype.hasOwnProperty.call(config, key)) {
      fail("OPSTACK_CONFIG_INVALID", `config.${key}: missing required field`);
    }
  }
  if (typeof config.networkId !== "string") {
    fail("OPSTACK_CONFIG_INVALID", "config.networkId must be a string");
  }
  try {
    assertNetworkId(config.networkId, "config.networkId");
  } catch (error) {
    fail("OPSTACK_CONFIG_INVALID", `config.networkId: ${(error as Error).message}`);
  }
  if (!CAIP2_PATTERN.test(config.networkId)) {
    fail(
      "OPSTACK_CONFIG_INVALID",
      "config.networkId must be a CAIP-2 network identity (namespace:reference, e.g. eip155:8453)",
    );
  }
  if (typeof config.chainId !== "number") {
    fail("OPSTACK_CONFIG_INVALID", "config.chainId must be a number");
  }
  try {
    assertSafePositiveInteger(config.chainId, "config.chainId");
  } catch (error) {
    fail("OPSTACK_CONFIG_INVALID", `config.chainId: ${(error as Error).message}`);
  }
  if (config.family !== OPSTACK_FAMILY) {
    fail(
      "OPSTACK_CONFIG_INVALID",
      `config.family must be explicitly ${JSON.stringify(OPSTACK_FAMILY)}; chain families are never inferred from a chainId`,
    );
  }
  if (config.ruleset !== OPSTACK_FINALITY_RULESET) {
    fail(
      "OPSTACK_CONFIG_INVALID",
      `config.ruleset must be the pinned ${JSON.stringify(OPSTACK_FINALITY_RULESET)}`,
    );
  }
  if (config.rulesetVersion !== OPSTACK_FINALITY_RULESET_VERSION) {
    fail(
      "OPSTACK_CONFIG_INVALID",
      `config.rulesetVersion must be the pinned ${JSON.stringify(OPSTACK_FINALITY_RULESET_VERSION)}`,
    );
  }
}

/** Frozen canonical projection of a validated config (for metadata records). */
export function opStackFinalityMetadata(config: OpStackFinalityConfig): Readonly<{
  family: string;
  ruleset: string;
  rulesetVersion: string;
  networkId: string;
}> {
  validateOpStackFinalityConfig(config);
  return Object.freeze({
    family: config.family,
    ruleset: config.ruleset,
    rulesetVersion: config.rulesetVersion,
    networkId: config.networkId,
  });
}
