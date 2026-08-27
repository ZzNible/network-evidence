/**
 * The x402 v2 `exact` EVM expected-payment requirement.
 *
 * Scope is DELIBERATELY narrow (prototype):
 *   - protocol x402, version 2 ONLY;
 *   - scheme `exact` ONLY — no claim of support for any other scheme;
 *   - network family eip155 (EVM) only;
 *   - optional `payer`, used in matching ONLY when the requirement
 *     actually binds it.
 *
 * The requirement arrives from OUTSIDE NEC and is untrusted input: every
 * field is validated fail-closed before use. Addresses accept lowercase,
 * uppercase or EIP-55-checksummed forms and are normalized to lowercase.
 */

import { digestCanonicalJson } from "@nec/core";

import { parseAtomicAmount } from "./amount.js";
import { normalizeEvmAddressStrict } from "./address.js";
import { parseCaip2EvmNetwork } from "./caip2.js";
import { NecAdapterX402Error } from "./errors.js";
import { x402Fail } from "./errors.js";

/** Digest domain for the normalized-requirement identity digest. */
export const REQUIREMENT_DIGEST_DOMAIN = "x402.requirement";

export const SUPPORTED_X402_VERSION = "2";
export const SUPPORTED_X402_SCHEME = "exact";

export interface X402ExactPaymentRequirement {
  readonly x402Version: "2";
  readonly scheme: "exact";
  /** Canonical CAIP-2 network id (`eip155:<chainId>`). */
  readonly network: string;
  readonly chainId: number;
  /** Token contract address (lowercase). */
  readonly asset: string;
  /** Recipient address (lowercase). */
  readonly payTo: string;
  /** Atomic-units amount as a canonical decimal string (no leading zeros). */
  readonly amount: string;
  /** Bound payer address (lowercase) — present only when required. */
  readonly payer?: string;
}

const ALLOWED_FIELDS = new Set([
  "x402Version",
  "scheme",
  "network",
  "asset",
  "payTo",
  "amount",
  "payer",
  // Normalized-echo tolerance: a NORMALIZED requirement carries the derived
  // chainId. Re-parsing a normalized instance must be an identity operation
  // (idempotent intake), so chainId is accepted IFF it matches the network's
  // own decimal chain id — any other value still fails closed.
  "chainId",
]);

function requireString(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  if (typeof value !== "string") {
    x402Fail("X402_REQUIREMENT_INVALID", `${key}: must be a string`);
  }
  return value;
}

/**
 * Parse + validate an untrusted raw value into a normalized requirement.
 * Unknown fields are rejected (fail closed), never silently dropped.
 */
export function parseX402ExactPaymentRequirement(raw: unknown): X402ExactPaymentRequirement {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new NecAdapterX402Error(
      "X402_REQUIREMENT_INVALID",
      "requirement must be a plain object",
    );
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ALLOWED_FIELDS.has(key)) {
      x402Fail(
        "X402_REQUIREMENT_INVALID",
        `unknown field ${JSON.stringify(key)} is not part of the x402 exact payment requirement; failing closed`,
      );
    }
  }
  for (const key of ["x402Version", "scheme", "network", "asset", "payTo", "amount"] as const) {
    if (!(key in record)) {
      x402Fail("X402_REQUIREMENT_INVALID", `missing required field ${JSON.stringify(key)}`);
    }
  }

  // Version: exactly v2 ("2" or 2 accepted on input; canonicalized to "2").
  const version = record["x402Version"];
  if (version !== "2" && version !== 2) {
    x402Fail(
      "X402_VERSION_UNSUPPORTED",
      `x402Version ${JSON.stringify(String(version))} unsupported; this adapter supports only version "${SUPPORTED_X402_VERSION}"`,
    );
  }

  // Scheme: exactly "exact".
  const scheme = requireString(record, "scheme");
  if (scheme !== SUPPORTED_X402_SCHEME) {
    x402Fail(
      "X402_SCHEME_UNSUPPORTED",
      `scheme ${JSON.stringify(scheme)} unsupported; this adapter supports only ${JSON.stringify(SUPPORTED_X402_SCHEME)}`,
    );
  }

  const parsedNetwork = parseCaip2EvmNetwork(requireString(record, "network"));
  if (record["chainId"] !== undefined && record["chainId"] !== null) {
    const echo = record["chainId"];
    if (typeof echo !== "number" || !Number.isSafeInteger(echo) || echo !== parsedNetwork.chainId) {
      x402Fail(
        "X402_REQUIREMENT_INVALID",
        `chainId ${JSON.stringify(String(echo))} does not match the network's chain id ${parsedNetwork.chainId}`,
      );
    }
  }
  const asset = normalizeEvmAddressStrict(record["asset"], "asset");
  const payTo = normalizeEvmAddressStrict(record["payTo"], "payTo");
  const amount = parseAtomicAmount(record["amount"]);

  let payer: string | undefined;
  if (record["payer"] !== undefined && record["payer"] !== null) {
    payer = normalizeEvmAddressStrict(record["payer"], "payer");
  }

  return Object.freeze({
    x402Version: SUPPORTED_X402_VERSION,
    scheme: SUPPORTED_X402_SCHEME,
    network: parsedNetwork.caip2,
    chainId: parsedNetwork.chainId,
    asset,
    payTo,
    amount,
    ...(payer === undefined ? {} : { payer }),
  });
}

/**
 * Stable identity digest of the NORMALIZED requirement
 * (`sha256:<hex>` under the dedicated `x402.requirement` domain).
 */
export function computeRequirementDigest(requirement: X402ExactPaymentRequirement): string {
  return digestCanonicalJson(REQUIREMENT_DIGEST_DOMAIN, { ...requirement });
}
