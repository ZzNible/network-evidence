import { validateActionDescriptor, validateSubjectRef } from "@nec/core";
import type { ActionDescriptor, SubjectRef } from "@nec/core";
import { parseSignature } from "@nec/resolver-solana";

import { svmFail } from "./errors.js";
import { computeX402SvmRequirementDigest, parseX402SvmExactRequirement } from "./requirement.js";
import type { X402SvmExactRequirement } from "./requirement.js";

export const ACTION_KIND_X402_SVM_PAYMENT = "x402.svm.payment";

export interface X402SvmPaymentClaim {
  readonly requirement: X402SvmExactRequirement;
  readonly paymentSignature: string;
}

export function parseX402SvmPaymentClaim(value: unknown): X402SvmPaymentClaim {
  if (value === null || typeof value !== "object" || Array.isArray(value)) svmFail("X402_SVM_CLAIM_INVALID", "claim must be an object");
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) if (key !== "requirement" && key !== "paymentSignature") svmFail("X402_SVM_CLAIM_INVALID", `unknown claim field ${key}`);
  let paymentSignature: string;
  try { paymentSignature = parseSignature(raw.paymentSignature, "paymentSignature"); } catch { svmFail("X402_SVM_CLAIM_INVALID", "paymentSignature must be a canonical Solana signature"); }
  return Object.freeze({ requirement: parseX402SvmExactRequirement(raw.requirement), paymentSignature });
}

export interface X402SvmCorrelation { readonly subject: SubjectRef; readonly action: ActionDescriptor; readonly requirementDigest: string }

export function buildX402SvmCorrelation(value: X402SvmPaymentClaim | unknown): X402SvmCorrelation {
  const claim = parseX402SvmPaymentClaim(value);
  const requirementDigest = computeX402SvmRequirementDigest(claim.requirement);
  const subject: SubjectRef = { type: "transaction", networkId: claim.requirement.network, txId: claim.paymentSignature };
  validateSubjectRef(subject, "correlation.subject");
  const action: ActionDescriptor = { kind: ACTION_KIND_X402_SVM_PAYMENT, target: claim.requirement.payTo, value: claim.requirement.amount, fields: { asset: claim.requirement.asset, scheme: "exact", x402Version: "2", requirementDigest, ...(claim.requirement.extra?.feePayer === undefined ? {} : { feePayer: claim.requirement.extra.feePayer }) } };
  validateActionDescriptor(action, "correlation.action");
  return Object.freeze({ subject: Object.freeze(subject), action: Object.freeze(action), requirementDigest });
}
