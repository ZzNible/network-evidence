/**
 * CAIP-2 parsing for the claim `network` field, restricted to the EVM family
 * (`eip155:<chainId>`) — the ONLY network family this adapter supports.
 *
 * CAIP-2 grammar: `<namespace>:<reference>`; namespace matches
 * `[-a-z0-9]{3,8}`; for eip155 the reference is a decimal chain id.
 */

import { erc4337Fail } from "./errors.js";

const CAIP2_PATTERN = /^([-a-z0-9]{3,8}):([-a-zA-Z0-9]{1,64})$/;
const EIP155_REFERENCE_PATTERN = /^[1-9][0-9]{0,15}$/;

export interface Caip2EvmNetwork {
  /** Canonical CAIP-2 string (namespace is lowercase by grammar). */
  readonly caip2: string;
  readonly namespace: "eip155";
  /** Decimal chain id (safe integer; EIP-155 chain ids are far smaller). */
  readonly chainId: number;
}

/**
 * Parse a CAIP-2 network identifier. Non-eip155 namespaces fail with
 * `ERC4337_NETWORK_FAMILY_UNSUPPORTED`; malformed identifiers fail with
 * `ERC4337_NETWORK_MALFORMED`.
 */
export function parseCaip2EvmNetwork(value: unknown): Caip2EvmNetwork {
  if (typeof value !== "string") {
    erc4337Fail("ERC4337_NETWORK_MALFORMED", "network must be a CAIP-2 string");
  }
  const match = CAIP2_PATTERN.exec(value);
  if (match === null) {
    erc4337Fail(
      "ERC4337_NETWORK_MALFORMED",
      "network must match CAIP-2 `<namespace>:<reference>` (lowercase namespace, bounded reference)",
    );
  }
  const namespace = match[1]!;
  const reference = match[2]!;
  if (namespace !== "eip155") {
    erc4337Fail(
      "ERC4337_NETWORK_FAMILY_UNSUPPORTED",
      `network namespace ${JSON.stringify(namespace)} is not supported; this adapter supports only eip155 (EVM)`,
    );
  }
  if (!/^[0-9]+$/.test(reference)) {
    erc4337Fail("ERC4337_NETWORK_MALFORMED", "eip155 reference must be a decimal chain id");
  }
  if (!EIP155_REFERENCE_PATTERN.test(reference) || !Number.isSafeInteger(Number(reference))) {
    erc4337Fail(
      "ERC4337_CHAIN_ID_OUT_OF_RANGE",
      "eip155 reference must be a decimal chain id without leading zeros within the safe integer range",
    );
  }
  return { caip2: `${namespace}:${reference}`, namespace: "eip155", chainId: Number(reference) };
}
