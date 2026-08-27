import { describe, expect, it } from "vitest";
import { computeEvidencePolicyDigest } from "@nec/core";
import type { EvidencePolicy, EvidenceRef, PolicyDimension, PreflightRequest } from "@nec/core";

import {
  acquireTransactionObservation,
  deriveEvmBeforeFoundation,
  deriveEvmBeforePreflightResult,
  EVALUATION_PROFILE,
  evaluateTransactionAcquisition,
  evmBeforeResolverManifest,
} from "../src/index.js";
import type {
  EvmBeforeDerivationInput,
  EvmBeforeFoundation,
  EvmCapabilityProbeObservation,
  EvmCapabilityProbeSource,
  EvmEvaluation,
  EvmProbePath,
  EvaluatedDimension,
} from "../src/index.js";

import {
  happyPathResponses,
  NOW,
  NETWORK_ID,
  scriptedFetch,
  source,
  successBlockResultText,
  successTransactionResultText,
  TX,
} from "./helpers.js";

const PATH_BYTES: Record<EvmProbePath, string> = {
  chainidentity: "aa",
  receipt: "bb",
  block: "cc",
  transaction: "dd",
};

function probeRef(path: EvmProbePath): EvidenceRef {
  return {
    id: `ev-probe-${path}`,
    sourceId: "src.sepolia.primary",
    sourceType: "evm_rpc",
    locator: `probe:${path}`,
    retrievedAt: NOW,
    contentDigest: `sha256:${PATH_BYTES[path].repeat(32)}`,
    networkId: NETWORK_ID,
    metadata: { probePath: path },
  };
}

const probeSource: EvmCapabilityProbeSource = {
  sourceId: "src.sepolia.primary",
  sourceType: "evm_rpc",
};

function healthyObservation(): EvmCapabilityProbeObservation {
  return {
    network: NETWORK_ID,
    chainId: 11155111,
    source: probeSource,
    observedAt: NOW,
    rpcReachable: true,
    chainIdentityObserved: true,
    receiptLookupUsable: true,
    blockLookupUsable: true,
    transactionLookupUsable: true,
    evidence: (["chainidentity", "receipt", "block", "transaction"] as const).map(probeRef),
  };
}

function evidencePolicy(required: PolicyDimension[]): EvidencePolicy {
  const content = {
    id: "payment-basic",
    version: "1",
    requiredDimensions: required,
  };
  return { ...content, digest: computeEvidencePolicyDigest(content) };
}

describe("public API surface (@nec/resolver-evm v0.1 entrypoint)", () => {
  it("exposes acquisition, evaluation and BEFORE entrypoints", () => {
    expect(typeof acquireTransactionObservation).toBe("function");
    expect(typeof evaluateTransactionAcquisition).toBe("function");
    expect(typeof evmBeforeResolverManifest).toBe("function");
    expect(typeof deriveEvmBeforeFoundation).toBe("function");
    expect(typeof deriveEvmBeforePreflightResult).toBe("function");
  });

  it("evaluates an acquired transaction through the public entrypoint", async () => {
    const { fetchFn } = scriptedFetch(
      happyPathResponses({
        block: successBlockResultText(),
        transaction: successTransactionResultText(),
      }),
    );
    const acquisition = await acquireTransactionObservation({
      source: source(),
      txHash: TX,
      now: NOW,
      fetchFn,
    });
    const evaluation: EvmEvaluation = evaluateTransactionAcquisition(acquisition);
    expect(evaluation.profile).toBe(EVALUATION_PROFILE);
    const execution: EvaluatedDimension = evaluation.dimensions.execution;
    expect(execution.dimension.verdict).toBe("supported");
    expect(evaluation.dimensions.dataBinding.dimension.verdict).toBe("supported");
    expect(evaluation.fragment.subject).toEqual({
      type: "transaction",
      networkId: NETWORK_ID,
      txId: TX,
    });
  });

  it("derives the BEFORE foundation and a READY preflight through the public entrypoint", () => {
    const manifest = evmBeforeResolverManifest();
    expect(manifest.id).toBe("resolver-evm-generic");

    const input: EvmBeforeDerivationInput = {
      networkId: NETWORK_ID,
      observation: healthyObservation(),
    };
    const foundation: EvmBeforeFoundation = deriveEvmBeforeFoundation(input);
    expect(foundation.manifest.digest).toBe(manifest.digest);

    const request: PreflightRequest = {
      schemaVersion: "0.1",
      requestId: "pf_public_api_1",
      networkId: NETWORK_ID,
      action: { kind: "erc20.transfer", target: `0x${"aa".repeat(20)}`, value: "0" },
      evidencePolicy: evidencePolicy(["execution"]),
    };
    const preflight = deriveEvmBeforePreflightResult(foundation, request);
    expect(preflight.status).toBe("ready");
    expect(preflight.evidenceReadiness.execution.status).toBe("ready");
  });

  it("keeps fragment and proposition internals out of the public namespace", async () => {
    const ns = (await import("../src/index.js")) as unknown as Record<string, unknown>;
    for (const name of [
      "decimalString",
      "captureEvidenceIndex",
      "LOG_EFFECT_DIGEST_DOMAIN",
      "EVM_LOG_EFFECT_TYPE",
      "CONFLICT_ID_PREFIX",
      "buildCheckConflict",
      "buildLogObservedEffect",
      "buildEvaluationFingerprint",
      "EXECUTION_PROPOSITION",
      "DATA_BINDING_PROPOSITION",
      "DIMENSIONS_NOT_EVALUATED_WARNING",
      "PROBE_PATH_METADATA_KEY",
    ]) {
      expect(ns[name], name).toBeUndefined();
    }
  });
});
