/**
 * Optional strict claim intake for ONE existing read-only AFTER MCP tool.
 * This is a thin adapter dispatch, not a new Core verdict or settlement rule.
 * Parsing and subject/chain binding happen BEFORE any provider reads.
 */
import { decodeNecWireJson } from "@nec/core";
import { parseX402PaymentClaim, buildX402PaymentCorrelation, assessX402ExactPayment } from "@nec/adapter-x402";
import { parseErc4337Claim, buildErc4337Correlation, assessErc4337UserOperation } from "@nec/adapter-erc4337";
import { parseX402SvmPaymentClaim, buildX402SvmCorrelation, assessX402SvmExactPayment } from "@nec/adapter-x402-svm";
import { NeMcpError } from "./errors.js";
import { MULTICHAIN_RESULT_MAX_BYTES } from "./live-multichain.js";
import type { TransactionSubject, MultichainTool, MultichainObservation } from "./live-multichain.js";

export const CLAIM_PROTOCOLS = ["x402-evm", "erc4337", "x402-svm"] as const;
export type ClaimProtocol = typeof CLAIM_PROTOCOLS[number];

export interface OptionalClaim {
  readonly protocol: ClaimProtocol;
  /** Native strict adapter claim; caller-supplied protocol terms are UNVERIFIED by this intake. */
  readonly claim: Record<string, unknown>;
}
export interface ClaimBoundInput {
  readonly subject: TransactionSubject;
  readonly claim?: OptionalClaim;
}
export interface ClaimAssessmentEnvelope {
  readonly protocol: ClaimProtocol;
  readonly assessmentType: "adapter_local_protocol_assessment";
  /** The actual native adapter output; NOT a Core NetworkEvidenceResult. */
  readonly evaluation: Record<string, unknown>;
  readonly nonClaims: readonly string[];
}
export type ClaimBoundObservation = MultichainObservation & {readonly claimAssessment?: ClaimAssessmentEnvelope};

type X402Claim = ReturnType<typeof parseX402PaymentClaim>;
type ErcClaim = ReturnType<typeof parseErc4337Claim>;
type SvmClaim = ReturnType<typeof parseX402SvmPaymentClaim>;
type Prepared =
  | {readonly protocol:"x402-evm";readonly claim:X402Claim}
  | {readonly protocol:"erc4337";readonly claim:ErcClaim}
  | {readonly protocol:"x402-svm";readonly claim:SvmClaim};

function invalid(): never {
  throw new NeMcpError("MCP_CLAIM_INVALID",
    "the supplied protocol claim is malformed, unsupported, or not bound to the exact requested transaction and network");
}
function failed(): never {
  throw new NeMcpError("MCP_CLAIM_ASSESSMENT_FAILED",
    "native protocol assessment could not be validated against source-bound Core evidence");
}
function plain(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

/** This function must run before the first RPC request. */
export function prepareLiveClaim(subject: TransactionSubject, supplied: OptionalClaim): Prepared {
  if (!subject || subject.type !== "transaction" || !plain(supplied) || !plain(supplied.claim)
    || Object.keys(supplied).some(k => k !== "protocol" && k !== "claim")) invalid();
  const evm = subject.networkId === "eip155:8453" || subject.networkId === "eip155:84532";
  if ((supplied.protocol === "x402-svm" && evm)
    || ((supplied.protocol === "x402-evm" || supplied.protocol === "erc4337") && !evm)) invalid();
  let parsed: Prepared;
  let expected: {type:string;networkId:string;txId?:string};
  try {
    switch (supplied.protocol) {
      case "x402-evm": {
        const claim = parseX402PaymentClaim(supplied.claim);
        parsed = {protocol:"x402-evm",claim};
        expected = buildX402PaymentCorrelation(claim).subject;
        break;
      }
      case "erc4337": {
        const claim = parseErc4337Claim(supplied.claim);
        parsed = {protocol:"erc4337",claim};
        expected = buildErc4337Correlation(claim).subject;
        break;
      }
      case "x402-svm": {
        const claim = parseX402SvmPaymentClaim(supplied.claim);
        parsed = {protocol:"x402-svm",claim};
        expected = buildX402SvmCorrelation(claim).subject;
        break;
      }
      default: return invalid();
    }
  } catch {return invalid();}
  if (expected.type !== "transaction" || expected.networkId !== subject.networkId
    || expected.txId !== subject.txId) invalid();
  return parsed;
}

function assessPrepared(observation: MultichainObservation, prepared: Prepared): ClaimAssessmentEnvelope {
  let fragment: ReturnType<typeof decodeNecWireJson<"network-evidence-fragment">>;
  try {
    fragment = decodeNecWireJson("network-evidence-fragment", JSON.stringify(observation.fragment));
  } catch {return failed();}
  if (fragment.subject.type !== "transaction" || fragment.subject.txId !== observation.subject.txId
    || fragment.subject.networkId !== observation.subject.networkId
    || fragment.network.networkId !== observation.subject.networkId) failed();

  let native: unknown;
  try {
    switch (prepared.protocol) {
      case "x402-evm": native = assessX402ExactPayment(prepared.claim, fragment); break;
      case "erc4337": native = assessErc4337UserOperation(prepared.claim, fragment); break;
      case "x402-svm": native = assessX402SvmExactPayment(fragment, prepared.claim); break;
    }
  } catch {return failed();}
  if (!plain(native) || native.subjectMatchesClaim !== true || !plain(native.outcome)) failed();
  const verdict = native.outcome.verdict;
  if (verdict !== undefined && !["supported","contradicted","insufficient","ambiguous"].includes(String(verdict))) failed();
  if (native.outcome.applicability === "applicable" && verdict === undefined) failed();
  if (!Array.isArray(native.outcome.evidence)) failed();
  if (verdict === "supported" && native.outcome.evidence.length === 0) failed();
  // A cited Core ref alone is not enough: it must belong to this exact
  // source AND have a byte-digest match with an actually acquired RPC capture.
  if (!native.outcome.evidence.every((id:unknown) =>
    typeof id === "string" && fragment.evidence.some(ref =>
      ref.id === id && ref.sourceId === observation.source.sourceId &&
      observation.acquisition.captures.some(cap => cap.contentDigest === ref.contentDigest)
    ))) failed();

  let evaluation: Record<string, unknown>;
  try {
    evaluation = JSON.parse(JSON.stringify(native)) as Record<string, unknown>;
  } catch {return failed();}
  return {
    protocol: prepared.protocol,
    assessmentType: "adapter_local_protocol_assessment",
    evaluation,
    nonClaims: [
      "The structured protocol claim and original expected terms are supplied by the caller, not independently established by this RPC observation.",
      "Only the adapter's stated proposition and its cited network effects are assessed. This is NOT a Core NetworkEvidenceResult.",
      "A supported adapter-local matching effect does not establish x402 facilitator verification, protocol settlement, L1 settlement, withdrawal finalization or economic finality.",
      "No signing, transaction submission, protocol authorization, policy decision or trust score is provided.",
    ],
  };
}

/** Exactly ONE outbound acquisition, reused by all three native claim adapters. */
export async function resolveWithOptionalClaim(resolve: MultichainTool, input: ClaimBoundInput): Promise<ClaimBoundObservation> {
  const prepared = input.claim === undefined ? undefined : prepareLiveClaim(input.subject, input.claim);
  const observation = await resolve({subject: input.subject});
  if (prepared === undefined) return observation;
  const assessment = assessPrepared(observation, prepared);
  const response: ClaimBoundObservation = {...observation, claimAssessment:assessment};
  if (Buffer.byteLength(JSON.stringify(response)) > MULTICHAIN_RESULT_MAX_BYTES) {
    throw new NeMcpError("MCP_MULTICHAIN_TOO_LARGE", "bounded source evidence plus native assessment exceeds MCP tool output budget");
  }
  return response;
}
