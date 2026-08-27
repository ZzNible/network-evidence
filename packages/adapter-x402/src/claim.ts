/**
 * CLAIM LAYER: the x402 payment CLAIM as an explicit, normalized input.
 *
 * A claim is NOT network observation. It bundles:
 *   - `requirement`: the EXPECTED payment terms (what SHOULD happen), and
 *   - `paymentTxHash`: the canonical EVM transaction hash that allegedly
 *     carries this payment (WHICH execution to look at).
 *
 * Nothing here touches HTTP envelopes, facilitator responses or protocol
 * success strings: raw x402 transport payloads stay adapter-local/inert and
 * never enter NEC artifacts. The ONLY thing this layer produces for NEC is
 * the protocol→contract correlation: a frozen-core SubjectRef (the exact
 * transaction subject), an ActionDescriptor expressing the EXPECTED
 * payment semantics, and — when a caller supplies an EvidencePolicy plus
 * requestId — a complete EvidenceRequest for a network resolver.
 *
 * The correlation makes ZERO network claims. Whether the claimed
 * transaction actually contains a matching payment is decided later, by
 * `assessX402ExactPayment`, against independently acquired network
 * evidence.
 */

import {
  validateActionDescriptor,
  validateEvidenceRequest,
  validateSubjectRef,
} from "@nec/core";
import type { ActionDescriptor, EvidencePolicy, EvidenceRequest, SubjectRef } from "@nec/core";

import { NecAdapterX402Error } from "./errors.js";
import { x402Fail } from "./errors.js";
import { parseX402ExactPaymentRequirement } from "./requirement.js";
import type { X402ExactPaymentRequirement } from "./requirement.js";

const TX_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/**
 * Stable, NEC-safe identifier for the EXPECTED action described by an x402
 * exact payment. This names an expectation about protocol semantics; it is
 * not an observed effect and not a settlement statement.
 */
export const ACTION_KIND_X402_PAYMENT = "x402.payment";

/** Normalized x402 payment claim: expected terms + the claimed payment tx. */
export interface X402PaymentClaim {
  /** Normalized expected-payment requirement. */
  readonly requirement: X402ExactPaymentRequirement;
  /**
   * Canonical EVM transaction hash of the ALLEGED payment transaction
   * (lowercase `0x` + 64 hex digits). A claim without an exact transaction
   * identity cannot be exactly correlated to network evidence.
   */
  readonly paymentTxHash: string;
}

const CLAIM_ALLOWED_FIELDS = new Set(["requirement", "paymentTxHash"]);

/**
 * Parse + validate an untrusted raw value into a normalized claim. Unknown
 * fields are rejected (fail closed). The embedded requirement may be raw or
 * already normalized; both parse through the strict requirement intake.
 */
export function parseX402PaymentClaim(raw: unknown): X402PaymentClaim {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new NecAdapterX402Error("X402_CLAIM_INVALID", "claim must be a plain object");
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!CLAIM_ALLOWED_FIELDS.has(key)) {
      x402Fail(
        "X402_CLAIM_INVALID",
        `unknown field ${JSON.stringify(key)} is not part of an x402 payment claim; failing closed`,
      );
    }
  }
  if (!("requirement" in record)) {
    x402Fail("X402_CLAIM_INVALID", 'missing required field "requirement"');
  }
  if (!("paymentTxHash" in record)) {
    x402Fail("X402_CLAIM_INVALID", 'missing required field "paymentTxHash"');
  }
  const hashRaw = record["paymentTxHash"];
  if (typeof hashRaw !== "string" || !TX_HASH_PATTERN.test(hashRaw)) {
    x402Fail(
      "X402_TX_HASH_INVALID",
      "paymentTxHash must be an EVM transaction hash (0x followed by 64 hexadecimal digits)",
    );
  }
  return Object.freeze({
    requirement: parseX402ExactPaymentRequirement(record["requirement"]),
    paymentTxHash: hashRaw.toLowerCase(),
  });
}

/** Protocol→NEC expectation mapping produced by buildX402PaymentCorrelation. */
export interface X402PaymentCorrelation {
  /**
   * THE exact network subject of the claim: the claimed payment
   * transaction on the requirement's network.
   */
  readonly subject: SubjectRef;
  /**
   * The EXPECTED payment semantics as a frozen-core ActionDescriptor.
   * Expectation only — never an observation and never a settlement fact.
   */
  readonly action: ActionDescriptor;
  /**
   * Complete resolver request, present ONLY when the caller supplied both
   * an EvidencePolicy and a requestId.
   */
  readonly request?: EvidenceRequest;
}

export interface X402CorrelationOptions {
  /** Resolver-request identity (NEC identifier grammar). */
  readonly requestId?: string;
  /** Evidence policy the resolver should satisfy for this request. */
  readonly evidencePolicy?: EvidencePolicy;
}

/**
 * Map a normalized x402 payment claim onto EXISTING frozen NEC contracts.
 * Pure protocol→expectation mapping; it performs no I/O and makes no
 * network claims.
 *
 * ActionDescriptor policy (deliberately minimal):
 *   - kind      `x402.payment` — stable protocol-semantic identifier;
 *   - target    the expected recipient (`payTo`);
 *   - value     the expected atomic-units amount (decimal string);
 *   - fields    only normalized expectation fields needed to bind
 *               semantics: asset, scheme, version and — only when the
 *               requirement binds one — the payer.
 *
 * Raw response bodies, HTTP status codes, facilitator success strings and
 * similar protocol context MUST NOT be placed here: they are claims/context
 * until independently correlated to network evidence, and they would
 * otherwise masquerade as network truth inside a core artifact.
 */
export function buildX402PaymentCorrelation(
  claim: X402PaymentClaim | unknown,
  options: X402CorrelationOptions = {},
): X402PaymentCorrelation {
  const parsed = parseX402PaymentClaim(claim);
  const req = parsed.requirement;

  const subject: SubjectRef = Object.freeze({
    type: "transaction",
    networkId: req.network,
    txId: parsed.paymentTxHash,
  });
  validateSubjectRef(subject, "correlation.subject");

  const action: ActionDescriptor = Object.freeze({
    kind: ACTION_KIND_X402_PAYMENT,
    target: req.payTo,
    value: req.amount,
    fields: Object.freeze({
      asset: req.asset,
      scheme: req.scheme,
      x402Version: req.x402Version,
      ...(req.payer === undefined ? {} : { payer: req.payer }),
    }),
  });
  validateActionDescriptor(action, "correlation.action");

  const hasPolicy = options.evidencePolicy !== undefined;
  const hasRequestId = options.requestId !== undefined;
  if (hasPolicy !== hasRequestId) {
    x402Fail(
      "X402_CLAIM_INVALID",
      "requestId and evidencePolicy must be supplied together to build an EvidenceRequest",
    );
  }
  if (!hasPolicy) {
    return Object.freeze({ subject, action });
  }

  const request: EvidenceRequest = {
    schemaVersion: "0.1",
    requestId: options.requestId!,
    networkId: req.network,
    subject,
    action,
    evidencePolicy: options.evidencePolicy!,
  };
  // Fail closed through THE frozen-core request validation: identity
  // grammar, subject/network binding, action continuity and policy digest.
  validateEvidenceRequest(request, "correlation.request");
  return Object.freeze({ subject, action, request });
}
