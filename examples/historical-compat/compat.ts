/**
 * NE Suite v1.1 LOT 3 historical F1/F2/F3 compatibility path.
 *
 * The reviewed exact-fixture Hub/Lens adapters are promoted byte-for-byte from
 * ZzNible/agent-evidence-hub autonomy/authority-v1 586a81a (`authority/lib`).
 * This module only composes them with:
 *
 * 1. a fresh offline public Core replay through the existing resolver/adapter
 *    packages, equality-checked fail-closed against the reviewed frozen
 *    projection before any Lens case is built; and
 * 2. the public `@nec/lens` browser validator and deterministic serializer.
 *
 * Case-specific semantics remain in the copied authority adapters. Nothing here
 * is generic Hub ingestion, a new evaluator, or a source of new verdicts.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { interpretObservedEffect } from "@nec/adapter-x402";
import { assessErc4337UserOperation, ENTRY_POINT_PROFILES, ERC4337_WARNING_CODES } from "@nec/adapter-erc4337";
import { assessX402SvmExactPayment } from "@nec/adapter-x402-svm";
import { serializeLensBrowserSafeV01, validateLensBrowserSafeCaseV01 } from "@nec/lens";
import type { LensBrowserSafeCaseV01 } from "@nec/lens";
import { evaluateTransactionAcquisition, replayTransactionAcquisition } from "@nec/resolver-evm";
import { evaluateOpStackFinality, replayOpStackFinalityObservation } from "@nec/resolver-opstack";
import { evaluateSolanaTransaction, replaySolanaTransaction } from "@nec/resolver-solana";

import * as f1 from "./authority/lib/f1.mjs";
import * as f2 from "./authority/lib/f2.mjs";
import * as f3 from "./authority/lib/f3.mjs";

export const TARGET_CORE_MUTATIONS = 0 as const;
export const HISTORICAL_COMPAT_VERSION = "ne-historical-compat/v0.1" as const;
export const HISTORICAL_COMPAT_AUTHORITY = Object.freeze({
  repository: "ZzNible/agent-evidence-hub",
  branch: "autonomy/authority-v1",
  commit: "586a81a39c8da4d3a0dc0e879b605aabfd3f8d1d",
});
export const HISTORICAL_CASE_IDS = Object.freeze(["f1", "f2", "f3"] as const);
export type HistoricalCaseId = (typeof HISTORICAL_CASE_IDS)[number];

/** Construction metadata of the reviewed Maps export; construction time only, not evidence. */
export const REVIEWED_EXPORT_METADATA = Object.freeze({
  namespace: "ne-maps-v1",
  createdAt: "2026-10-07T00:00:00.000Z",
});

export interface HistoricalExactActionV01 {
  kind: string;
  networkId: string;
  id: string;
  bundleTransactionHash?: string;
  sender?: string;
}

export const HISTORICAL_EXACT_ACTIONS: Readonly<Record<HistoricalCaseId, Readonly<HistoricalExactActionV01>>> = Object.freeze({
  f1: Object.freeze({
    kind: "transaction",
    networkId: "eip155:8453",
    id: "0x8e01aace01ced4155b30d636b547727becdbb8a700f9b7f54ed02c4d629ae696",
  }),
  f2: Object.freeze({
    kind: "user_operation",
    networkId: "eip155:84532",
    id: "0x5f1e12031272034de5460796bd5cabe903a8ee6845fcab5fde18c4de632acfcf",
    bundleTransactionHash: "0xde8916c81ef6a7b36ddf9f7b44d1ca096e4db4818eddfd5e16eda8a7c292ed45",
    sender: "0xfef5b40ab4c543137262253dbaf7843bd9b3e5b6",
  }),
  f3: Object.freeze({
    kind: "transaction",
    networkId: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    id: "4DYWUMExSrMNxYLjUuH9G8feN4fmYXm4ToCx7gGaAEjJRf2QNrE8LsvoFSGhXwQJrchhgrnGpUFwjxrci9PRLF71",
  }),
});

export interface F2SelectorV01 {
  userOpHash?: string;
  sender?: string;
}

const F2_REPEATED_SENDER = "0x9272f8c4b4f26a79701dd2272f7e0c82fb3cded2";
export const F2_EXACT_SELECTOR: Readonly<F2SelectorV01> = Object.freeze({
  userOpHash: HISTORICAL_EXACT_ACTIONS.f2.id,
  sender: HISTORICAL_EXACT_ACTIONS.f2.sender!,
});
/** The four reviewed F2 selector checks presented by Maps; outcomes are reviewed, not exact-case badges. */
export const F2_REVIEWED_SELECTOR_CHECKS = Object.freeze([
  { label: "Exact userOpHash + sender", selector: F2_EXACT_SELECTOR, verdict: "supported" },
  { label: "Unknown userOpHash", selector: { userOpHash: `0x${"00".repeat(32)}`, sender: F2_EXACT_SELECTOR.sender! }, verdict: "insufficient" },
  { label: "Exact userOpHash + wrong sender", selector: { userOpHash: F2_EXACT_SELECTOR.userOpHash!, sender: F2_REPEATED_SENDER }, verdict: "contradicted" },
  { label: "Repeated sender only", selector: { sender: F2_REPEATED_SENDER }, verdict: "ambiguous" },
] as const);

const AUTHORITY_ROOT = new URL("./authority/", import.meta.url);
/** Repository-relative location of the promoted authority bytes (for provenance output). */
const AUTHORITY_REPO_PATH = "examples/historical-compat/authority/";
const REPO_ROOT = new URL("../../", import.meta.url);
const F1_DIR = "fixtures/F1-x402-1062-partial/";
const F2_DIR = "fixtures/F2-erc4337-base-sepolia-v06/";
const F3_DIR = "fixtures/F3-solana-mainnet-x402-partial/";
const F1_ARTIFACT_PATHS: Readonly<Record<string, string>> = Object.freeze({
  "01-public-issue-claim.json": `${F1_DIR}01-public-issue-claim.json`,
  "02-frozen-network-evidence-reference.json": `${F1_DIR}02-frozen-network-evidence-reference.json`,
  "05-network-evidence-result.json": `${F1_DIR}source/hub-frozen-ne-projection/05-network-evidence-result.json`,
});
const F1_RAW_TRANSFER = `${F1_DIR}source/network-evidence/fixtures/base-mainnet-x402-1062-usdc-transfer.fixture.json`;
const F1_RAW_FINALITY = `${F1_DIR}source/network-evidence/fixtures/base-mainnet-x402-1062-finality.fixture.json`;

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Plain JSON copy: drops null prototypes/freezing exactly as the reviewed Maps export did. */
function plain<T = any>(value: unknown): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function authorityBytes(path: string): Buffer {
  return readFileSync(new URL(path, AUTHORITY_ROOT));
}

function publicBytes(path: string, expectedSha256: string): Buffer {
  const bytes = readFileSync(new URL(path, REPO_ROOT));
  assert.equal(sha256(bytes), expectedSha256, `public source digest mismatch: ${path}`);
  return bytes;
}

async function offline<T>(fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("NETWORK_DISABLED_DURING_HISTORICAL_COMPAT_REPLAY");
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

// ---------------------------------------------------------------------------
// F1 — Base mainnet x402 #1062 partial
// ---------------------------------------------------------------------------

function f1Records(): Record<string, unknown> {
  const records: Record<string, unknown> = Object.create(null);
  for (const name of f1.F1_REQUIRED_ARTIFACTS) {
    const bytes = authorityBytes(F1_ARTIFACT_PATHS[name]!);
    records[name] = f1.parseF1Artifact({ artifactName: name, bytes, expectedSha256: f1.F1_PINNED_SHA256[name]! });
  }
  return records;
}

function f1FrozenProjection(): any {
  const bytes = authorityBytes(F1_ARTIFACT_PATHS["05-network-evidence-result.json"]!);
  assert.equal(sha256(bytes), f1.F1_PINNED_SHA256["05-network-evidence-result.json"], "F1 frozen projection digest changed");
  return JSON.parse(bytes.toString("utf8"));
}

/** Reviewed Core semantics the F1 replay must reproduce (authority run-suite-demo `expectedFromFrozen`). */
export function expectedF1CoreReplayV01(): any {
  const frozen = f1FrozenProjection();
  return {
    subject: frozen.subject,
    networkEvidence: {
      execution: frozen.networkEvidence.execution,
      dataBinding: frozen.networkEvidence.dataBinding,
      observedEffects: frozen.networkEvidence.observedEffects,
      finality: frozen.networkEvidence.finality,
    },
  };
}

/** Fresh public Core replay of the pinned F1 Base captures (authority demo-core-runner algorithm). */
export async function replayF1CoreV01(): Promise<any> {
  const frozen = f1FrozenProjection();
  const transferBytes = authorityBytes(F1_RAW_TRANSFER);
  const finalityBytes = authorityBytes(F1_RAW_FINALITY);
  assert.equal(sha256(transferBytes), frozen.provenance.sourceFixtures.transfer.sha256, "F1 transfer capture digest mismatch");
  assert.equal(sha256(finalityBytes), frozen.provenance.sourceFixtures.finality.sha256, "F1 finality capture digest mismatch");
  const transferRaw = JSON.parse(transferBytes.toString("utf8"));
  const finalityRaw = JSON.parse(finalityBytes.toString("utf8"));

  return offline(async () => {
    const includeTransaction = transferRaw.captures.some((capture: any) => capture?.rpcMethod === "eth_getTransactionByHash");
    const acquisition = await replayTransactionAcquisition(transferRaw, { includeTransaction });
    const evaluated = evaluateTransactionAcquisition(acquisition);
    const finalityObservation = await replayOpStackFinalityObservation(finalityRaw);
    const finalityEvaluation = evaluateOpStackFinality({
      config: {
        networkId: "eip155:8453",
        chainId: 8453,
        family: "opstack",
        ruleset: "opstack.rpc-finalized-head-v1",
        rulesetVersion: "1",
      },
      evm: acquisition,
      finality: finalityObservation,
    });

    const transfers = (evaluated.fragment.networkEvidence.observedEffects ?? [])
      .map((effect) => interpretObservedEffect(effect) as any)
      .filter((result) => result.status === "transfer");
    assert.equal(transfers.length, 1, "F1 expects exactly one ERC-20 transfer");
    const transfer = transfers[0].observation;
    const depthWarning: any = finalityEvaluation.warnings.find((warning) => warning.code === "OP_ANCESTRY_DEPTH_EXCEEDED");
    assert.ok(depthWarning, "F1 missing OP_ANCESTRY_DEPTH_EXCEEDED warning");

    const execution = evaluated.fragment.networkEvidence.execution;
    const dataBinding = evaluated.fragment.networkEvidence.dataBinding;
    const finality = finalityEvaluation.fragment.networkEvidence.finality;
    assert.ok(execution && dataBinding && finality, "F1 required Network Evidence dimensions missing");

    return plain({
      subject: { type: "transaction", networkId: transferRaw.source.networkId, txId: transferRaw.subject.txHash },
      networkEvidence: {
        execution: {
          applicability: execution.applicability,
          verdict: execution.verdict,
          basis: execution.basis,
          evidence: execution.evidence,
          reason: execution.reason,
        },
        dataBinding: {
          applicability: dataBinding.applicability,
          verdict: dataBinding.verdict,
          basis: dataBinding.basis,
          evidence: dataBinding.evidence,
        },
        observedEffects: [{
          type: "erc20.transfer",
          effectId: transfer.effectId,
          asset: transfer.asset,
          from: transfer.from,
          to: transfer.to,
          amountAtomic: transfer.amount,
          transactionHash: transfer.transactionHash,
          blockNumber: transfer.blockNumber,
          logIndex: transfer.logIndex,
          evidenceIds: transfer.evidenceIds,
        }],
        finality: {
          applicability: finality.applicability,
          verdict: finality.verdict,
          basis: finality.basis,
          evidence: finality.evidence,
          reason: finality.reason,
          limitationCode: depthWarning.code,
          ancestryRequiredDepth: depthWarning.metadata?.requiredDepth,
          maxAncestryDepth: depthWarning.metadata?.maxAncestryDepth,
        },
      },
    });
  });
}

async function buildF1(metadata: HistoricalCompatMetadataV01): Promise<{ lens: any; coreReplay: HistoricalCoreReplaySummaryV01 }> {
  const core = await replayF1CoreV01();
  assert.deepStrictEqual(core, expectedF1CoreReplayV01(), "F1 public Core replay does not match the reviewed frozen projection");
  const lens = plain(f1.projectF1BrowserSafe(f1.buildF1Case(f1Records(), metadata)));
  for (const dimension of ["execution", "dataBinding", "finality"] as const) {
    const assessment = findAssessment(lens, `p-${dimension}`);
    assert.equal(assessment.value, core.networkEvidence[dimension].verdict, `F1 ${dimension} verdict drift`);
    assert.deepStrictEqual(assessment.basis, core.networkEvidence[dimension].basis, `F1 ${dimension} basis drift`);
  }
  assert.deepStrictEqual(lens.networkEvidence.preservedResult.observedEffects, core.networkEvidence.observedEffects);
  assert.equal(findProposition(lens, "p-settlement").availability, "unavailable");
  assert.equal(findAssessment(lens, "p-x402-correlation").value, "insufficient");
  const frozen = f1FrozenProjection();
  return {
    lens,
    coreReplay: {
      packages: ["@nec/resolver-evm", "@nec/resolver-opstack", "@nec/adapter-x402"],
      sources: [
        { path: `${AUTHORITY_REPO_PATH}${F1_RAW_TRANSFER}`, sha256: frozen.provenance.sourceFixtures.transfer.sha256 },
        { path: `${AUTHORITY_REPO_PATH}${F1_RAW_FINALITY}`, sha256: frozen.provenance.sourceFixtures.finality.sha256 },
      ],
      reviewedReference: { path: `${AUTHORITY_REPO_PATH}${F1_ARTIFACT_PATHS["05-network-evidence-result.json"]}`, sha256: f1.F1_PINNED_SHA256["05-network-evidence-result.json"]! },
      localRecomputation: "performed",
      reviewedEquality: "passed",
    },
  };
}

// ---------------------------------------------------------------------------
// F2 — Base Sepolia ERC-4337 v0.6 exact UserOperation
// ---------------------------------------------------------------------------

function f2Reference(): any {
  return f2.parseF2Reference({
    artifactName: f2.F2_REFERENCE,
    bytes: authorityBytes(`${F2_DIR}${f2.F2_REFERENCE}`),
    expectedSha256: f2.F2_REFERENCE_SHA256,
  });
}

/** Fresh public Core replay plus ERC-4337 adapter evaluation for one selector. */
export async function replayF2CoreV01(selector: F2SelectorV01): Promise<any> {
  const reference = f2Reference();
  const raw = JSON.parse(publicBytes(reference.value.path, reference.value.sha256).toString("utf8"));
  return offline(async () => {
    const acquisition = await replayTransactionAcquisition(raw, { includeTransaction: true });
    assert.equal(acquisition.consistent, true, "F2 fixture replay consistency failed");
    const fragment = evaluateTransactionAcquisition(acquisition).fragment;
    const evaluation = assessErc4337UserOperation({
      network: HISTORICAL_EXACT_ACTIONS.f2.networkId,
      bundleTransactionHash: HISTORICAL_EXACT_ACTIONS.f2.bundleTransactionHash!,
      entryPoint: ENTRY_POINT_PROFILES["v0.6"],
      entryPointProfile: "v0.6",
      userOperation: { ...selector },
    }, fragment);
    return {
      consistent: acquisition.consistent,
      blockNumber: acquisition.receipt?.blockNumber?.toString(),
      blockHash: acquisition.receipt?.blockHash,
      entryPoint: acquisition.receipt?.to,
      evaluation,
    };
  });
}

function buildF2Lens(selector: F2SelectorV01, metadata: HistoricalCompatMetadataV01): any {
  return plain(f2.projectF2BrowserSafe(f2.buildF2Case(f2Reference(), metadata, { ...selector })));
}

/** Runs one reviewed F2 selector through fresh Core and the reviewed adapter; both must agree. */
export async function checkF2SelectorV01(selector: F2SelectorV01): Promise<{ core: string; lens: string }> {
  const core = (await replayF2CoreV01(selector)).evaluation.outcome.verdict as string;
  const lens = findAssessment(buildF2Lens(selector, REVIEWED_EXPORT_METADATA), "p-userop-execution").value as string;
  assert.equal(lens, core, "F2 selector verdict differs between fresh Core and reviewed Lens adapter");
  return { core, lens };
}

async function buildF2(metadata: HistoricalCompatMetadataV01): Promise<{ lens: any; coreReplay: HistoricalCoreReplaySummaryV01 }> {
  const replay = await replayF2CoreV01(F2_EXACT_SELECTOR);
  const evaluation = replay.evaluation;
  const lens = buildF2Lens(F2_EXACT_SELECTOR, metadata);
  const assessment = findAssessment(lens, "p-userop-execution");
  const context = findProposition(lens, "p-bundle-context").context;
  const selected = lens.exactReviewedSemantics.selectedUserOperation;
  assert.equal(evaluation.outcome.verdict, assessment.value, "F2 verdict drift");
  assert.deepStrictEqual([...evaluation.outcome.basis].sort(), [...assessment.basis].sort(), "F2 basis drift");
  assert.equal(evaluation.claimLabel, assessment.supportedLabel, "F2 claim label drift");
  assert.equal(evaluation.execution.verdict, "supported");
  for (const key of ["userOpHash", "sender", "paymaster", "success", "actualGasCost", "actualGasUsed"] as const) {
    assert.equal(evaluation.selectedUserOperation?.[key], selected[key], `F2 selectedUserOperation.${key} drift`);
  }
  assert.equal(evaluation.selectedUserOperation?.transactionHash, context.transactionHash);
  assert.equal(replay.blockNumber, context.blockNumber);
  assert.equal(replay.blockHash, context.blockHash);
  assert.equal(replay.entryPoint, context.entryPoint);
  assert.equal(
    evaluation.warnings.some((warning: { code: string }) => warning.code === ERC4337_WARNING_CODES.finalityNotEstablished),
    true,
    "F2 must not silently strengthen execution into finality",
  );
  assert.equal(findProposition(lens, "p-finality").availability, "unavailable");
  const reference = f2Reference();
  return {
    lens,
    coreReplay: {
      packages: ["@nec/resolver-evm", "@nec/adapter-erc4337"],
      sources: [{ path: reference.value.path, sha256: reference.value.sha256 }],
      reviewedReference: { path: `${AUTHORITY_REPO_PATH}${F2_DIR}${f2.F2_REFERENCE}`, sha256: f2.F2_REFERENCE_SHA256 },
      localRecomputation: "performed",
      reviewedEquality: "passed",
    },
  };
}

// ---------------------------------------------------------------------------
// F3 — Solana mainnet x402-SVM exact partial
// ---------------------------------------------------------------------------

function f3Reference(): any {
  return f3.parseF3Reference({
    artifactName: f3.F3_REFERENCE,
    bytes: authorityBytes(`${F3_DIR}${f3.F3_REFERENCE}`),
    expectedSha256: f3.F3_REFERENCE_SHA256,
  });
}

/** Reviewed full Core runtime frozen by the authority (`source/04-frozen-core-runtime.json`). */
export function expectedF3CoreReplayV01(): any {
  const reference = f3Reference();
  const bytes = authorityBytes(`${F3_DIR}${reference.value.frozenCoreProjection.path}`);
  assert.equal(sha256(bytes), reference.value.frozenCoreProjection.sha256, "F3 frozen Core runtime digest mismatch");
  return JSON.parse(bytes.toString("utf8"));
}

/** Fresh public Core replay of the pinned Solana fixture (authority demo-solana-f3-core-runner algorithm). */
export async function replayF3CoreV01(): Promise<any> {
  const reference = f3Reference();
  const fixture = JSON.parse(publicBytes(reference.value.path, reference.value.sha256).toString("utf8"));
  publicBytes(reference.value.requirementContextSource.path, reference.value.requirementContextSource.sha256);
  publicBytes(reference.value.publicDocumentation.path, reference.value.publicDocumentation.sha256);
  const requirement = reference.value.reviewedRequirementContext;
  const claim = {
    requirement: {
      x402Version: Number(requirement.x402Version),
      scheme: requirement.scheme,
      network: reference.value.network,
      asset: requirement.asset,
      payTo: requirement.payTo,
      amount: requirement.amount,
      maxTimeoutSeconds: requirement.maxTimeoutSeconds,
      extra: { feePayer: requirement.feePayer },
    },
    paymentSignature: reference.value.subject.signature,
  };
  return offline(async () => {
    const replay = await replaySolanaTransaction(fixture);
    const fragment = evaluateSolanaTransaction(replay).fragment;
    const evaluation = assessX402SvmExactPayment(fragment, claim);
    return plain({
      subject: fragment.subject,
      networkEvidence: fragment.networkEvidence,
      conflicts: fragment.conflicts,
      claimContext: claim,
      payment: evaluation,
    });
  });
}

async function buildF3(metadata: HistoricalCompatMetadataV01): Promise<{ lens: any; coreReplay: HistoricalCoreReplaySummaryV01 }> {
  const core = await replayF3CoreV01();
  assert.deepStrictEqual(core, expectedF3CoreReplayV01(), "F3 public Core replay does not match the reviewed frozen runtime");
  assert.equal(core.payment.outcome?.verdict, "supported");
  assert.equal(core.payment.claim, f3.F3_PAYMENT_LABEL);
  assert.equal(core.payment.settlementInferred, false);
  assert.equal(Object.hasOwn(core.payment, "correlation"), false);
  const lens = plain(f3.projectF3BrowserSafe(f3.buildF3Case(f3Reference(), metadata)));
  const payment = findAssessment(lens, "p-x402-svm-payment");
  assert.equal(payment.value, core.payment.outcome.verdict, "F3 payment verdict drift");
  assert.deepStrictEqual(payment.basis, core.payment.outcome.basis, "F3 payment basis drift");
  assert.equal(payment.supportedLabel, core.payment.claim);
  const execution = findAssessment(lens, "p-network-execution");
  assert.equal(execution.value, core.networkEvidence.execution.verdict, "F3 execution verdict drift");
  assert.deepStrictEqual(execution.basis, core.networkEvidence.execution.basis);
  const finality = findAssessment(lens, "p-network-finality");
  assert.equal(finality.value, core.networkEvidence.finality.verdict, "F3 finality verdict drift");
  assert.deepStrictEqual(finality.basis, core.networkEvidence.finality.basis);
  assert.equal(lens.exactReviewedSemantics.networkFinality.economicIrreversibilityEstablished, false);
  const correlation = findAssessment(lens, "p-historical-x402-correlation");
  assert.equal(correlation.value, "insufficient");
  assert.equal(correlation.networkEvidenceAuthority, "none");
  assert.equal(findProposition(lens, "p-settlement").availability, "unavailable");
  const reference = f3Reference();
  return {
    lens,
    coreReplay: {
      packages: ["@nec/resolver-solana", "@nec/adapter-x402-svm"],
      sources: [
        { path: reference.value.path, sha256: reference.value.sha256 },
        { path: reference.value.requirementContextSource.path, sha256: reference.value.requirementContextSource.sha256 },
        { path: reference.value.publicDocumentation.path, sha256: reference.value.publicDocumentation.sha256 },
      ],
      reviewedReference: { path: `${AUTHORITY_REPO_PATH}${F3_DIR}${reference.value.frozenCoreProjection.path}`, sha256: reference.value.frozenCoreProjection.sha256 },
      localRecomputation: "performed",
      reviewedEquality: "passed",
    },
  };
}

// ---------------------------------------------------------------------------
// Public compatibility entry point
// ---------------------------------------------------------------------------

export interface HistoricalCompatMetadataV01 {
  namespace: string;
  createdAt: string;
}

export interface HistoricalCoreReplaySummaryV01 {
  packages: readonly string[];
  sources: ReadonlyArray<{ path: string; sha256: string }>;
  reviewedReference: { path: string; sha256: string };
  localRecomputation: "performed";
  reviewedEquality: "passed";
}

export interface HistoricalCompatCaseV01 {
  id: HistoricalCaseId;
  /** Reviewed browser-safe Lens projection, validated by public @nec/lens. */
  lens: LensBrowserSafeCaseV01;
  /** Public `serializeLensBrowserSafeV01` bytes (hub-json-sorted-keys/v0.1). */
  browserBytes: string;
  coreReplay: HistoricalCoreReplaySummaryV01;
}

const BUILDERS: Readonly<Record<HistoricalCaseId, (metadata: HistoricalCompatMetadataV01) => Promise<{ lens: any; coreReplay: HistoricalCoreReplaySummaryV01 }>>> = {
  f1: buildF1,
  f2: buildF2,
  f3: buildF3,
};

/**
 * Fresh offline Core replay -> fail-closed reviewed-equality gate -> promoted
 * authority adapter -> public Lens browser validation/serialization.
 */
export async function buildHistoricalCompatCaseV01(
  id: HistoricalCaseId,
  metadata: HistoricalCompatMetadataV01 = REVIEWED_EXPORT_METADATA,
): Promise<HistoricalCompatCaseV01> {
  if (!HISTORICAL_CASE_IDS.includes(id)) throw new TypeError(`unsupported historical case ${String(id)}`);
  const { lens, coreReplay } = await BUILDERS[id]({ namespace: metadata.namespace, createdAt: metadata.createdAt });
  validateLensBrowserSafeCaseV01(lens);
  assert.equal(lens.TARGET_CORE_MUTATIONS, 0);
  const identity = exactActionViolations(id, lens);
  if (identity.length > 0) throw new Error(`${id} exact-action identity drift: ${identity.map((v) => v.path).join(", ")}`);
  return { id, lens, browserBytes: serializeLensBrowserSafeV01(lens), coreReplay };
}

// ---------------------------------------------------------------------------
// Semantic preservation guard
// ---------------------------------------------------------------------------

export type HistoricalCompatViolationCodeV01 =
  | "verdict_strengthened"
  | "verdict_changed"
  | "basis_changed"
  | "availability_changed"
  | "limitation_lost"
  | "provenance_lost"
  | "provenance_changed"
  | "open_question_changed"
  | "relation_changed"
  | "unauthorized_browser_field"
  | "exact_action_identity_changed"
  | "semantic_drift";

export interface HistoricalCompatViolationV01 {
  code: HistoricalCompatViolationCodeV01;
  path: string;
}

const DECISIVE_VERDICTS = new Set(["supported", "contradicted"]);
const NON_ESTABLISHING_AVAILABILITY = new Set(["unavailable", "unknown", "not_applicable", "redacted"]);
const FORBIDDEN_AUTHORITY_KEYS = new Set(["caseVerdict", "confidence", "trustScore", "score", "policyDecision"]);
const VERDICT_KEYS = new Set(["verdict", "executionVerdict"]);
const LIMITATION_KEYS = new Set([
  "limitations", "limitationCode", "missingRequiredPublicFields", "missingHistoricalPublicArtifacts",
  "withheldReportedFields", "unavailableDimensions", "unavailableDimensionRef", "assessmentPolicy", "reason",
]);
const PROVENANCE_KEYS = new Set([
  "evaluator", "provenance", "provenanceClass", "verificationMode", "localRecomputation", "replayCapability",
  "verifierType", "verifierVersion", "verifierVersionAvailability", "verifierBuildRef", "verifierImmutableSourceRef",
  "immutableSourceRef", "buildRef", "networkEvidenceAuthority", "reviewClass", "absenceStatementScope",
  "importProvenanceClass", "extractionBasis", "frozenSourceIndex", "publicSourceIndex", "sourceSchema",
  "realityClass", "fixtureClass", "inputRefs", "inputDigests", "withheldInputDigestCount", "resultDigest",
  "resultVocabulary", "evidenceRefs", "subjectRefs", "sourceClaimRefs", "artifactRef", "vocabulary",
  "supportedLabel", "adapterContextLabel", "adapterContextLabelMeaning", "projectionPolicy", "browserDigestPolicy",
]);
/** Construction metadata only (`constructionTimeMeaning`); excluded from evidence comparison. */
const CONSTRUCTION_METADATA_PATHS = new Set(["$.namespace", "$.createdAt"]);

function flatten(value: unknown, path = "$", out = new Map<string, unknown>()): Map<string, unknown> {
  if (CONSTRUCTION_METADATA_PATHS.has(path)) return out;
  out.set(path, value);
  if (Array.isArray(value)) value.forEach((item, index) => flatten(item, `${path}[${index}]`, out));
  else if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) flatten((value as Record<string, unknown>)[key], `${path}.${key}`, out);
  }
  return out;
}

function objectKey(path: string): string | null {
  const match = /\.([^.[\]]+)$/.exec(path);
  return match ? match[1]! : null;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function findProposition(lens: any, propositionId: string): any {
  const proposition = (lens?.propositions ?? []).find((p: any) => p?.propositionId === propositionId);
  assert.ok(proposition, `missing proposition ${propositionId}`);
  return proposition;
}

function findAssessment(lens: any, propositionId: string): any {
  const assessment = findProposition(lens, propositionId).assessments?.[0];
  assert.ok(assessment, `missing assessment for ${propositionId}`);
  return assessment;
}

function exactActionFields(id: HistoricalCaseId, lens: any): Array<[string, unknown, unknown]> {
  const expected = HISTORICAL_EXACT_ACTIONS[id];
  const props: any[] = Array.isArray(lens?.propositions) ? lens.propositions : [];
  const prop = (pid: string) => props.find((p) => p?.propositionId === pid);
  const relation = (rid: string) => (Array.isArray(lens?.relations) ? lens.relations : []).find((r: any) => r?.relationId === rid);
  if (id === "f1") {
    const effects = lens?.networkEvidence?.preservedResult?.observedEffects ?? [];
    return [
      ["$.networkEvidence.subject.networkId", lens?.networkEvidence?.subject?.networkId, expected.networkId],
      ["$.networkEvidence.subject.txId", lens?.networkEvidence?.subject?.txId, expected.id],
      ["$.networkEvidence.preservedResult.observedEffects[0].transactionHash", effects[0]?.transactionHash, expected.id],
      ["$.sourceClaims[0].reportedIdentifiers.reportedTransaction", lens?.sourceClaims?.[0]?.reportedIdentifiers?.reportedTransaction, expected.id],
      ["p-execution.inputRefs[0]", prop("p-execution")?.assessments?.[0]?.inputRefs?.[0]?.txId, expected.id],
    ];
  }
  if (id === "f2") {
    const selected = lens?.exactReviewedSemantics?.selectedUserOperation;
    const context = prop("p-bundle-context")?.context;
    const inputRef = prop("p-userop-execution")?.assessments?.[0]?.inputRefs?.[0];
    return [
      ["$.exactReviewedSemantics.selectedUserOperation.userOpHash", selected?.userOpHash, expected.id],
      ["$.exactReviewedSemantics.selectedUserOperation.sender", selected?.sender, expected.sender],
      ["p-bundle-context.context.network", context?.network, expected.networkId],
      ["p-bundle-context.context.transactionHash", context?.transactionHash, expected.bundleTransactionHash],
      ["r-userop-bundle.fromRef", relation("r-userop-bundle")?.fromRef, expected.id],
      ["r-userop-bundle.toRef", relation("r-userop-bundle")?.toRef, expected.bundleTransactionHash],
      ["p-userop-execution.inputRefs[0].networkId", inputRef?.networkId, expected.networkId],
      ["p-userop-execution.inputRefs[0].userOpHash", inputRef?.userOpHash, expected.id],
      ["p-userop-execution.inputRefs[0].sender", inputRef?.sender, expected.sender],
    ];
  }
  const transaction = lens?.exactReviewedSemantics?.transaction;
  return [
    ["$.exactReviewedSemantics.transaction.network", transaction?.network, expected.networkId],
    ["$.exactReviewedSemantics.transaction.signature", transaction?.signature, expected.id],
    ["r-transfer-in-transaction.toRef", relation("r-transfer-in-transaction")?.toRef, expected.id],
  ];
}

function exactActionViolations(id: HistoricalCaseId, lens: unknown): HistoricalCompatViolationV01[] {
  return exactActionFields(id, lens)
    .filter(([, actual, expected]) => actual !== expected)
    .map(([path]) => ({ code: "exact_action_identity_changed" as const, path }));
}

/**
 * Compares a candidate browser projection with the reviewed one and reports
 * every semantic weakening/strengthening, lost limitation/provenance, added
 * browser field, or exact-action identity change. Any other byte difference
 * outside construction metadata is reported as `semantic_drift`.
 */
export function compareHistoricalProjectionV01(
  id: HistoricalCaseId,
  reviewed: unknown,
  candidate: unknown,
): HistoricalCompatViolationV01[] {
  const r = flatten(reviewed);
  const c = flatten(candidate);
  const violations: HistoricalCompatViolationV01[] = [];
  const add = (code: HistoricalCompatViolationCodeV01, path: string) => {
    if (!violations.some((v) => v.code === code && v.path === path)) violations.push({ code, path });
  };

  for (const [path, value] of c) {
    const key = objectKey(path);
    if (key !== null && FORBIDDEN_AUTHORITY_KEYS.has(key)) add("unauthorized_browser_field", path);
    if (key !== null && !r.has(path)) add("unauthorized_browser_field", path);
    if (/\.assessments\[\d+\]$/.test(path) && !r.has(path)) add("verdict_strengthened", path);
    if (key !== null && VERDICT_KEYS.has(key) && !r.has(path)) add("verdict_strengthened", path);
    if (key !== null && r.has(path) && r.get(path) === null && value !== null && /(Digest|digest|locatorRef)$/.test(key)) {
      add("unauthorized_browser_field", path);
    }
  }

  for (const [path, before] of r) {
    const key = objectKey(path);
    const present = c.has(path);
    const after = c.get(path);
    if (key === null) continue;
    if (VERDICT_KEYS.has(key) || /\.assessments\[\d+\]\.value$/.test(path)) {
      if (!present || after !== before) {
        add(DECISIVE_VERDICTS.has(after as string) && !DECISIVE_VERDICTS.has(before as string) ? "verdict_strengthened" : "verdict_changed", path);
      }
    }
    if (/(Established|Inferred|Claimed)$/.test(key) && before === false && after !== false) add("verdict_strengthened", path);
    if (key === "availability" && (!present || after !== before)) {
      add(NON_ESTABLISHING_AVAILABILITY.has(before as string) && after === "available" ? "verdict_strengthened" : "availability_changed", path);
    }
    if (key === "basis" && !same(before, after)) add("basis_changed", path);
    if (/Visibility$/.test(key) && after !== before) add("unauthorized_browser_field", path);
    if (LIMITATION_KEYS.has(key)) {
      if (!present) add("limitation_lost", path);
      else if (Array.isArray(before)) {
        const kept = Array.isArray(after) ? after.map((item) => JSON.stringify(item)) : [];
        if (before.some((item) => !kept.includes(JSON.stringify(item)))) add("limitation_lost", path);
      } else if (!same(before, after)) add("limitation_lost", path);
    }
    if (PROVENANCE_KEYS.has(key)) {
      if (!present) add("provenance_lost", path);
      else if (!same(before, after)) add("provenance_changed", path);
    }
  }

  if (!same((reviewed as any)?.openQuestions, (candidate as any)?.openQuestions)) add("open_question_changed", "$.openQuestions");
  if (!same((reviewed as any)?.relations, (candidate as any)?.relations)) add("relation_changed", "$.relations");
  for (const violation of exactActionViolations(id, candidate)) add(violation.code, violation.path);

  if (violations.length === 0) {
    const shape = (map: Map<string, unknown>) => JSON.stringify([...map]
      .map(([path, v]) => [path, Array.isArray(v) ? `[${v.length}]` : v !== null && typeof v === "object" ? "{}" : v])
      .sort(([a], [b]) => (a! < b! ? -1 : a! > b! ? 1 : 0)));
    if (shape(r) !== shape(c)) add("semantic_drift", "$");
  }
  return violations;
}

export function assertHistoricalProjectionPreservedV01(id: HistoricalCaseId, reviewed: unknown, candidate: unknown): void {
  const violations = compareHistoricalProjectionV01(id, reviewed, candidate);
  if (violations.length > 0) {
    throw new Error(`${id} historical semantics not preserved: ${violations.map((v) => `${v.code}@${v.path}`).join("; ")}`);
  }
}
