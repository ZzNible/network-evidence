import { digestCanonicalJson } from "@nec/core";
import { parseGenesisHash, parsePublicKey } from "@nec/resolver-solana";

import { NecAdapterX402SvmError, svmFail } from "./errors.js";

export const SUPPORTED_X402_VERSION = "2";
export const SUPPORTED_X402_SCHEME = "exact";
export const REQUIREMENT_DIGEST_DOMAIN = "x402.svm.requirement";
const DECIMAL = /^(0|[1-9][0-9]*)$/;

export interface X402SvmRequirementExtra {
  readonly feePayer?: string;
  readonly memo?: string;
  readonly recentBlockhash?: string;
  readonly lastValidBlockHeight?: string;
}

export interface X402SvmExactRequirement {
  readonly x402Version: "2";
  readonly scheme: "exact";
  readonly network: string;
  readonly asset: string;
  readonly payTo: string;
  readonly amount: string;
  readonly maxTimeoutSeconds?: number;
  readonly extra?: X402SvmRequirementExtra;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new NecAdapterX402SvmError("X402_SVM_REQUIREMENT_INVALID", `${label} must be a plain object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) svmFail("X402_SVM_REQUIREMENT_INVALID", `${label}: unknown field ${key}`);
}

function publicKey(value: unknown, label: string): string {
  try { return parsePublicKey(value, label); } catch { svmFail("X402_SVM_REQUIREMENT_INVALID", `${label}: must be a canonical Solana public key`); }
}

export function parseX402SvmExactRequirement(value: unknown): X402SvmExactRequirement {
  const raw = object(value, "requirement");
  exactKeys(raw, ["x402Version", "scheme", "network", "asset", "payTo", "amount", "maxTimeoutSeconds", "extra"], "requirement");
  if (raw.x402Version !== 2 && raw.x402Version !== "2") svmFail("X402_SVM_VERSION_UNSUPPORTED", "only x402Version 2 is supported");
  if (raw.scheme !== "exact") svmFail("X402_SVM_SCHEME_UNSUPPORTED", "only scheme exact is supported");
  if (typeof raw.network !== "string" || !raw.network.startsWith("solana:")) svmFail("X402_SVM_NETWORK_UNSUPPORTED", "network must be solana:<32-character canonical reference>");
  const networkReference = raw.network.slice("solana:".length);
  if (networkReference.length !== 32) svmFail("X402_SVM_NETWORK_UNSUPPORTED", "network must carry exactly 32 canonical base58 characters");
  try { parseGenesisHash(networkReference, "network reference"); } catch { svmFail("X402_SVM_NETWORK_UNSUPPORTED", "network must carry exactly 32 canonical base58 characters"); }
  const asset = publicKey(raw.asset, "asset");
  const payTo = publicKey(raw.payTo, "payTo");
  if (typeof raw.amount !== "string" || !DECIMAL.test(raw.amount)) svmFail("X402_SVM_REQUIREMENT_INVALID", "amount must be a canonical non-negative atomic decimal string");
  let maxTimeoutSeconds: number | undefined;
  if (raw.maxTimeoutSeconds !== undefined) {
    if (typeof raw.maxTimeoutSeconds !== "number" || !Number.isSafeInteger(raw.maxTimeoutSeconds) || raw.maxTimeoutSeconds <= 0) svmFail("X402_SVM_REQUIREMENT_INVALID", "maxTimeoutSeconds must be a positive safe integer");
    maxTimeoutSeconds = raw.maxTimeoutSeconds;
  }
  let extra: X402SvmRequirementExtra | undefined;
  if (raw.extra !== undefined) {
    const e = object(raw.extra, "requirement.extra");
    exactKeys(e, ["feePayer", "memo", "recentBlockhash", "lastValidBlockHeight"], "requirement.extra");
    const feePayer = e.feePayer === undefined ? undefined : publicKey(e.feePayer, "extra.feePayer");
    let memo: string | undefined;
    if (e.memo !== undefined) {
      if (typeof e.memo !== "string" || Buffer.byteLength(e.memo, "utf8") > 256) svmFail("X402_SVM_REQUIREMENT_INVALID", "extra.memo must be at most 256 UTF-8 bytes");
      memo = e.memo;
    }
    const recentBlockhash = e.recentBlockhash === undefined ? undefined : publicKey(e.recentBlockhash, "extra.recentBlockhash");
    if (e.lastValidBlockHeight !== undefined && (typeof e.lastValidBlockHeight !== "string" || !DECIMAL.test(e.lastValidBlockHeight))) svmFail("X402_SVM_REQUIREMENT_INVALID", "extra.lastValidBlockHeight must be canonical decimal text");
    extra = Object.freeze({ ...(feePayer === undefined ? {} : { feePayer }), ...(memo === undefined ? {} : { memo }), ...(recentBlockhash === undefined ? {} : { recentBlockhash }), ...(e.lastValidBlockHeight === undefined ? {} : { lastValidBlockHeight: e.lastValidBlockHeight as string }) });
  }
  return Object.freeze({ x402Version: "2", scheme: "exact", network: raw.network, asset, payTo, amount: raw.amount, ...(maxTimeoutSeconds === undefined ? {} : { maxTimeoutSeconds }), ...(extra === undefined ? {} : { extra }) });
}

export function computeX402SvmRequirementDigest(requirement: X402SvmExactRequirement): string {
  return digestCanonicalJson(REQUIREMENT_DIGEST_DOMAIN, requirement);
}
