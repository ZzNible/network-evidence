/**
 * CLAIM LAYER: the exact expected ERC-4337 UserOperation CLAIM as an
 * explicit, normalized input.
 *
 * A claim is NOT network observation. It bundles:
 *   - `network` + `bundleTransactionHash`: WHICH execution to look at (the
 *     EntryPoint bundle transaction);
 *   - `entryPoint`: the EntryPoint contract whose UserOperationEvents are
 *     authoritative for this claim;
 *   - `userOperation`: the EXPECTED op identity (exact userOpHash when the
 *     caller knows it; always the expected sender) — v0.1 is success-only
 *     (`requireSuccess` defaults true and explicit false fails closed,
 *     because "the expected UserOperation succeeded" IS the proposition);
 *   - `expectedEffect`: OPTIONAL exact ERC-1155 burn expectation
 *     (`kind:"erc1155-burn"`, to == zero address by profile definition).
 *
 * Nothing here performs network I/O or protocol calls. The claim makes ZERO
 * network claims; whether the claimed bundle actually contains a matching
 * successful UserOperationEvent (+ burn) is decided later by
 * `assessErc4337UserOperation` against independently acquired evidence.
 *
 * Nevermined note: planId -> tokenId normalization belongs ABOVE this
 * package. The caller supplies `expectedTokenId` directly.
 */

import { digestCanonicalJson, validateActionDescriptor } from "@nec/core";
import type {
  ActionDescriptor,
  EvidencePolicy,
  EvidenceRequest,
  SubjectRef,
} from "@nec/core";

import { normalizeEvmAddressStrict } from "./address.js";
import { parseUint256Decimal } from "./amount.js";
import { parseCaip2EvmNetwork } from "./caip2.js";
import { erc4337Fail } from "./errors.js";
import { ENTRY_POINT_PROFILES, type EntryPointProfile } from "./events.js";

const TX_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const HASH32_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/** Stable, NEC-safe identifier for the EXPECTED ERC-4337 action semantics. */
export const ACTION_KIND_ERC4337_USEROPERATION = "erc4337.userOperation";

/** Stable identifier for the OPTIONAL expected ERC-1155 burn effect. */
export const EXPECTED_EFFECT_KIND_ERC1155_BURN = "erc1155-burn";

export interface Erc4337UserOperationExpectation {
  /**
   * Exact userOpHash when known: forces exact-match selection and makes
   * duplicates/ambiguities detectable. ABSENT means selection must be
   * justified by uniqueness — multiple equally-matching candidates fail
   * closed as ambiguous, never first-match.
   */
  readonly userOpHash?: string;
  /** Expected smart-account sender (lowercase). */
  readonly sender: string;
  /** Always normalized true in v0.1 (success-only profile). */
  readonly requireSuccess: true;
}

/** Exact expected ERC-1155 burn effect (to == zero address, by definition). */
export interface Erc1155BurnExpectation {
  readonly kind: "erc1155-burn";
  /** Expected ERC-1155 contract (lowercase). */
  readonly contract: string;
  /** Expected burning account (lowercase); correlated to the op sender. */
  readonly from: string;
  /** Expected token id as a canonical decimal string. */
  readonly tokenId: string;
  /** Expected burned value as a canonical decimal string (> 0). */
  readonly value: string;
}

/** Normalized exact expected ERC-4337 UserOperation claim. */
export interface Erc4337Claim {
  /** Canonical CAIP-2 network id (`eip155:<chainId>`). */
  readonly network: string;
  readonly chainId: number;
  /** Bundle transaction hash (lowercase) carrying the EntryPoint call. */
  readonly bundleTransactionHash: string;
  /**
   * Expected EntryPoint contract (lowercase). The emitter identity is
   * mandatory and is checked against the observed event's emitter.
   */
  readonly entryPoint: string;
  /**
   * Pre-committed EntryPoint event-PROFILE identifier (e.g. `"v0.7"`). The
   * profile is mandatory and fail-closed when unrecognized. The claimed
   * `entryPoint` MUST be the canonical emitter pinned for this profile;
   * a declared profile whose address disagrees with the claimed emitter is a
   * profile mismatch and cannot support the proposition. The profile is an
   * EXPECTATION only — the adapter never verifies bytecode/implementation
   * version from event logs alone.
   */
  readonly entryPointProfile: EntryPointProfile;
  readonly userOperation: Erc4337UserOperationExpectation;
  readonly expectedEffect?: Erc1155BurnExpectation;
}

const CLAIM_ALLOWED_FIELDS = new Set([
  "network",
  "bundleTransactionHash",
  "entryPoint",
  "entryPointProfile",
  "userOperation",
  "expectedEffect",
  // Normalized-echo tolerance: a NORMALIZED claim carries the derived
  // chainId. Re-parsing a normalized instance must be an identity operation
  // (idempotent intake), so chainId is accepted IFF it matches the
  // network's own decimal chain id — any other value still fails closed.
  "chainId",
]);
const USER_OP_ALLOWED_FIELDS = new Set(["userOpHash", "sender", "requireSuccess"]);
const EFFECT_ALLOWED_FIELDS = new Set(["kind", "contract", "from", "tokenId", "value"]);

function plainObject(raw: unknown, what: string): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    erc4337Fail("ERC4337_CLAIM_INVALID", `${what} must be a plain object`);
  }
  return raw as Record<string, unknown>;
}

function rejectUnknownFields(record: Record<string, unknown>, allowed: Set<string>, what: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      erc4337Fail(
        "ERC4337_CLAIM_INVALID",
        `unknown field ${JSON.stringify(key)} is not part of ${what}; failing closed`,
      );
    }
  }
}

/**
 * Parse + validate an untrusted raw value into a normalized claim. Unknown
 * fields are rejected (fail closed), never silently dropped. Addresses
 * accept lowercase, uppercase or EIP-55-checksummed forms and normalize to
 * lowercase.
 */
export function parseErc4337Claim(raw: unknown): Erc4337Claim {
  const record = plainObject(raw, "claim");
  rejectUnknownFields(record, CLAIM_ALLOWED_FIELDS, "an erc4337 claim");
  for (const key of ["network", "bundleTransactionHash", "entryPoint", "userOperation"] as const) {
    if (!(key in record)) {
      erc4337Fail("ERC4337_CLAIM_INVALID", `missing required field ${JSON.stringify(key)}`);
    }
  }

  const parsedNetwork = parseCaip2EvmNetwork(record["network"]);
  if (record["chainId"] !== undefined && record["chainId"] !== null) {
    const echo = record["chainId"];
    if (typeof echo !== "number" || !Number.isSafeInteger(echo) || echo !== parsedNetwork.chainId) {
      erc4337Fail(
        "ERC4337_CLAIM_INVALID",
        `chainId ${JSON.stringify(String(echo))} does not match the network's chain id ${parsedNetwork.chainId}`,
      );
    }
  }

  const bundleHashRaw = record["bundleTransactionHash"];
  if (typeof bundleHashRaw !== "string" || !TX_HASH_PATTERN.test(bundleHashRaw)) {
    erc4337Fail(
      "ERC4337_TX_HASH_INVALID",
      "bundleTransactionHash must be an EVM transaction hash (0x followed by 64 hexadecimal digits)",
    );
  }

  const entryPoint = normalizeEvmAddressStrict(record["entryPoint"], "entryPoint");

  if (!("entryPointProfile" in record)) {
    erc4337Fail("ERC4337_CLAIM_INVALID", 'missing required field "entryPointProfile"');
  }
  const rawProfile = record["entryPointProfile"];
  if (typeof rawProfile !== "string" || !(rawProfile in ENTRY_POINT_PROFILES)) {
    erc4337Fail(
      "ERC4337_ENTRYPOINT_PROFILE_UNKNOWN",
      `entryPointProfile must be one of ${Object.keys(ENTRY_POINT_PROFILES).join(", ")}; got ${JSON.stringify(rawProfile)}`,
    );
  }
  const entryPointProfile = rawProfile as EntryPointProfile;
  // Profile/emitter binding: the claimed emitter must be the canonical
  // address pinned for the declared profile. A mismatch cannot support the
  // proposition (fail closed — enforced during evaluation as a material
  // conflict, but rejected early here when trivially incoherent).
  const profileAddress = ENTRY_POINT_PROFILES[entryPointProfile].toLowerCase();
  if (entryPoint !== profileAddress) {
    erc4337Fail(
      "ERC4337_ENTRYPOINT_PROFILE_MISMATCH",
      `claimed entryPoint ${entryPoint} does not match the canonical emitter ${profileAddress} pinned for profile ${entryPointProfile}`,
    );
  }

  const userOpRecord = plainObject(record["userOperation"], "claim.userOperation");
  rejectUnknownFields(userOpRecord, USER_OP_ALLOWED_FIELDS, "claim.userOperation");
  if (!("sender" in userOpRecord)) {
    erc4337Fail("ERC4337_CLAIM_INVALID", 'missing required field "sender" in userOperation');
  }
  const sender = normalizeEvmAddressStrict(userOpRecord["sender"], "userOperation.sender");

  let userOpHash: string | undefined;
  if (userOpRecord["userOpHash"] !== undefined && userOpRecord["userOpHash"] !== null) {
    const hashRaw = userOpRecord["userOpHash"];
    if (typeof hashRaw !== "string" || !HASH32_PATTERN.test(hashRaw)) {
      erc4337Fail(
        "ERC4337_HASH_INVALID",
        "userOperation.userOpHash must be a bytes32 hash (0x followed by 64 hexadecimal digits)",
      );
    }
    userOpHash = hashRaw.toLowerCase();
  }

  // v0.1 profile is success-only: "the expected UserOperation succeeded"
  // is part of the proposition. An explicit false fails closed instead of
  // silently weakening the claim's meaning.
  let requireSuccess = true;
  if (userOpRecord["requireSuccess"] !== undefined && userOpRecord["requireSuccess"] !== null) {
    if (userOpRecord["requireSuccess"] !== true) {
      erc4337Fail(
        "ERC4337_REQUIRE_SUCCESS_UNSUPPORTED",
        "userOperation.requireSuccess=false is not part of the v0.1 success-only profile",
      );
    }
    requireSuccess = true;
  }

  let expectedEffect: Erc1155BurnExpectation | undefined;
  if (record["expectedEffect"] !== undefined && record["expectedEffect"] !== null) {
    const effectRecord = plainObject(record["expectedEffect"], "claim.expectedEffect");
    rejectUnknownFields(effectRecord, EFFECT_ALLOWED_FIELDS, "claim.expectedEffect");
    if (effectRecord["kind"] !== EXPECTED_EFFECT_KIND_ERC1155_BURN) {
      erc4337Fail(
        "ERC4337_CLAIM_INVALID",
        `expectedEffect.kind must be ${JSON.stringify(EXPECTED_EFFECT_KIND_ERC1155_BURN)}; other effect kinds are not part of the v0.1 profile`,
      );
    }
    for (const key of ["contract", "from", "tokenId", "value"] as const) {
      if (!(key in effectRecord)) {
        erc4337Fail(
          "ERC4337_CLAIM_INVALID",
          `missing required field ${JSON.stringify(key)} in expectedEffect`,
        );
      }
    }
    const contract = normalizeEvmAddressStrict(effectRecord["contract"], "expectedEffect.contract");
    const from = normalizeEvmAddressStrict(effectRecord["from"], "expectedEffect.from");
    const tokenId = parseUint256Decimal(effectRecord["tokenId"], "expectedEffect.tokenId");
    const value = parseUint256Decimal(effectRecord["value"], "expectedEffect.value");
    if (value === "0") {
      erc4337Fail("ERC4337_AMOUNT_INVALID", "expectedEffect.value must be greater than zero");
    }
    expectedEffect = { kind: EXPECTED_EFFECT_KIND_ERC1155_BURN, contract, from, tokenId, value };
  }

  return Object.freeze({
    network: parsedNetwork.caip2,
    chainId: parsedNetwork.chainId,
    bundleTransactionHash: bundleHashRaw.toLowerCase(),
    entryPoint,
    entryPointProfile,
    userOperation: Object.freeze({
      ...(userOpHash === undefined ? {} : { userOpHash }),
      sender,
      requireSuccess,
    }),
    ...(expectedEffect === undefined ? {} : { expectedEffect: Object.freeze(expectedEffect) }),
  });
}

/** Digest domain for the normalized-claim identity digest. */
export const CLAIM_DIGEST_DOMAIN = "erc4337.claim";

/**
 * Stable identity digest of the NORMALIZED claim (`sha256:<hex>` under the
 * dedicated `erc4337.claim` domain); used as the proposition scope id.
 */
export function computeErc4337ClaimDigest(claim: Erc4337Claim): string {
  return digestCanonicalJson(CLAIM_DIGEST_DOMAIN, {
    network: claim.network,
    chainId: claim.chainId,
    bundleTransactionHash: claim.bundleTransactionHash,
    entryPoint: claim.entryPoint,
    entryPointProfile: claim.entryPointProfile,
    userOperation: { ...claim.userOperation },
    ...(claim.expectedEffect === undefined
      ? {}
      : { expectedEffect: { ...claim.expectedEffect } }),
  });
}

/** Protocol→NEC expectation mapping produced by buildErc4337Correlation. */
export interface Erc4337Correlation {
  /**
   * THE exact network subject of the claim: the claimed EntryPoint bundle
   * transaction on the claim's network.
   */
  readonly subject: SubjectRef;
  /**
   * The EXPECTED ERC-4337 semantics as a frozen-core ActionDescriptor.
   * Expectation only — never an observation and never a settlement fact.
   */
  readonly action: ActionDescriptor;
  /**
   * Complete resolver request, present ONLY when the caller supplied both
   * an EvidencePolicy and a requestId.
   */
  readonly request?: EvidenceRequest;
}

export interface Erc4337CorrelationOptions {
  /** Resolver-request identity (NEC identifier grammar). */
  readonly requestId?: string;
  /** Evidence policy the resolver should satisfy for this request. */
  readonly evidencePolicy?: EvidencePolicy;
}

/**
 * Map a normalized claim onto EXISTING frozen NEC contracts. Pure
 * protocol→expectation mapping; no I/O, no network claims.
 *
 * ActionDescriptor policy (deliberately minimal):
 *   - kind      `erc4337.userOperation`;
 *   - target    the expected EntryPoint;
 *   - value     "0" (no native-value expectation is claimed);
 *   - fields    only normalized expectation fields needed to bind
 *               semantics: sender, requireSuccess and — only when the
 *               claim binds one — the exact userOpHash and the expected
 *               burn effect.
 */
export function buildErc4337Correlation(
  claim: Erc4337Claim | unknown,
  options: Erc4337CorrelationOptions = {},
): Erc4337Correlation {
  const parsed = parseErc4337Claim(claim);

  const subject: SubjectRef = Object.freeze({
    type: "transaction",
    networkId: parsed.network,
    txId: parsed.bundleTransactionHash,
  });

  const action: ActionDescriptor = Object.freeze({
    kind: ACTION_KIND_ERC4337_USEROPERATION,
    target: parsed.entryPoint,
    value: "0",
    fields: Object.freeze({
      sender: parsed.userOperation.sender,
      requireSuccess: "true",
      entryPointProfile: parsed.entryPointProfile,
      ...(parsed.userOperation.userOpHash === undefined
        ? {}
        : { userOpHash: parsed.userOperation.userOpHash }),
      ...(parsed.expectedEffect === undefined
        ? {}
        : {
            expectedEffect: [
              parsed.expectedEffect.kind,
              parsed.expectedEffect.contract,
              parsed.expectedEffect.from,
              parsed.expectedEffect.tokenId,
              parsed.expectedEffect.value,
            ].join(":"),
          }),
    }),
  });
  validateActionDescriptor(action, "correlation.action");

  const hasPolicy = options.evidencePolicy !== undefined;
  const hasRequestId = options.requestId !== undefined;
  if (hasPolicy !== hasRequestId) {
    erc4337Fail(
      "ERC4337_CLAIM_INVALID",
      "requestId and evidencePolicy must be supplied together to build an EvidenceRequest",
    );
  }
  if (!hasPolicy) {
    return Object.freeze({ subject, action });
  }

  const request: EvidenceRequest = {
    schemaVersion: "0.1",
    requestId: options.requestId!,
    networkId: parsed.network,
    subject,
    action,
    evidencePolicy: options.evidencePolicy!,
  };
  return Object.freeze({ subject, action, request });
}
