import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  evaluateTransactionAcquisition,
  replayTransactionAcquisition,
  validateEvmAcquisitionFixture,
} from "@nec/resolver-evm";
import {
  assessErc4337UserOperation,
  ENTRY_POINT_PROFILES,
  ERC4337_CLAIM_LABELS,
  ERC4337_WARNING_CODES,
} from "@nec/adapter-erc4337";

import {
  F2_REFERENCE,
  F2_REFERENCE_SHA256,
  F2_SUPPORTED_LABEL,
  TARGET_CORE_MUTATIONS,
  buildF2Case,
  parseF2Reference,
  projectF2BrowserSafe,
} from "./hub/f2.mjs";

const NETWORK = "eip155:84532";
const BUNDLE_TX = "0xde8916c81ef6a7b36ddf9f7b44d1ca096e4db4818eddfd5e16eda8a7c292ed45";
const USER_OP_HASH = "0x5f1e12031272034de5460796bd5cabe903a8ee6845fcab5fde18c4de632acfcf";
const SENDER = "0xfef5b40ab4c543137262253dbaf7843bd9b3e5b6";
const PAYMASTER = "0x8817340e0a3435e06254f2ed411e6418cd070d6f";
const BLOCK_NUMBER = "12168926";
const BLOCK_HASH = "0x18cb57a710d328ea6304fc3be9ec47a34fbc54480cc42af59195d5a8e4763cbc";
const ENTRY_POINT_V06 = ENTRY_POINT_PROFILES["v0.6"];
const PUBLIC_FIXTURE_SHA256 = "37f7da5719220a16a2841a08360eff4738aab9bbc4873dcbf79307847f4131a3";
const HUB_AUTHORITY_SHA = "fbc5b2a1f8a58bae43fa90e7ecf1569d672a998e";
const DEMO_CREATED_AT = "2026-10-06T20:30:00.000Z";
const PUBLIC_FIXTURE_PATH = "packages/adapter-erc4337/test/fixtures/base-sepolia-external-v06-userop.json";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export async function buildDemoResult() {
  const fixtureBytes = await readFile(new URL("../../packages/adapter-erc4337/test/fixtures/base-sepolia-external-v06-userop.json", import.meta.url));
  assert.equal(sha256(fixtureBytes), PUBLIC_FIXTURE_SHA256, "public fixture digest changed");

  const rawFixture = JSON.parse(fixtureBytes.toString("utf8")) as unknown;
  const fixture = validateEvmAcquisitionFixture(rawFixture);
  assert.equal(fixture.source.networkId, NETWORK);
  assert.equal(fixture.subject.txHash, BUNDLE_TX);

  const acquisition = await replayTransactionAcquisition(rawFixture, { includeTransaction: true });
  assert.equal(acquisition.consistent, true, "fixture replay consistency failed");
  assert.equal(acquisition.checks.every((check) => check.passed), true, "fixture replay checks failed");
  assert.equal(acquisition.receipt?.blockNumber?.toString(), BLOCK_NUMBER);
  assert.equal(acquisition.receipt?.blockHash, BLOCK_HASH);
  assert.equal(acquisition.receipt?.to, ENTRY_POINT_V06);

  const fragment = evaluateTransactionAcquisition(acquisition).fragment;
  const selector = { userOpHash: USER_OP_HASH, sender: SENDER };
  const claim = {
    network: NETWORK,
    bundleTransactionHash: BUNDLE_TX,
    entryPoint: ENTRY_POINT_V06,
    entryPointProfile: "v0.6",
    userOperation: selector,
  };

  const evaluation = assessErc4337UserOperation(claim, fragment);
  assert.equal(evaluation.outcome.verdict, "supported");
  assert.equal(evaluation.execution.verdict, "supported");
  assert.equal(evaluation.claimLabel, ERC4337_CLAIM_LABELS.supportedUserOperationOnly);
  assert.equal(evaluation.claimLabel, F2_SUPPORTED_LABEL);
  assert.equal(evaluation.selectedUserOperation?.userOpHash, USER_OP_HASH);
  assert.equal(evaluation.selectedUserOperation?.sender, SENDER);
  assert.equal(evaluation.selectedUserOperation?.paymaster, PAYMASTER);
  assert.equal(evaluation.selectedUserOperation?.success, true);
  assert.equal(evaluation.selectedUserOperation?.blockNumber, BLOCK_NUMBER);
  assert.equal(evaluation.selectedUserOperation?.transactionHash, BUNDLE_TX);
  assert.equal(
    evaluation.warnings.some((warning) => warning.code === ERC4337_WARNING_CODES.finalityNotEstablished),
    true,
    "F2 must not silently strengthen execution into finality",
  );

  const referenceBytes = await readFile(new URL("./fixtures/01-frozen-network-evidence-reference.json", import.meta.url));
  const reference = parseF2Reference({
    artifactName: F2_REFERENCE,
    bytes: referenceBytes,
    expectedSha256: F2_REFERENCE_SHA256,
  });
  assert.equal(reference.value.sha256, PUBLIC_FIXTURE_SHA256, "Hub reference does not bind the public replay fixture");

  assert.equal(evaluation.outcome.verdict, "supported");
  assert.equal(evaluation.claimLabel, F2_SUPPORTED_LABEL);
  assert.equal(evaluation.selectedUserOperation?.actualGasCost, "10026199539816");
  assert.equal(evaluation.selectedUserOperation?.actualGasUsed, "186726");

  const lensCase = buildF2Case(
    reference,
    { namespace: "network-evidence-public-demo", createdAt: DEMO_CREATED_AT },
    selector,
  );
  const browserCase = projectF2BrowserSafe(lensCase);
  const lensAssessment = plain(browserCase.propositions)
    .find((proposition: { propositionId?: string }) => proposition.propositionId === "p-userop-execution")
    ?.assessments?.[0];

  assert.equal(lensAssessment?.value, evaluation.outcome.verdict);
  assert.equal(lensAssessment?.supportedLabel, evaluation.claimLabel);
  const lensBundleContext = plain(browserCase.propositions)
    .find((proposition: { propositionId?: string }) => proposition.propositionId === "p-bundle-context")
    ?.context;
  assert.equal(lensBundleContext?.network, NETWORK);
  assert.equal(lensBundleContext?.transactionHash, BUNDLE_TX);
  assert.equal(lensBundleContext?.blockNumber, BLOCK_NUMBER);
  assert.equal(lensBundleContext?.blockHash, BLOCK_HASH);
  assert.equal(lensBundleContext?.entryPoint, ENTRY_POINT_V06);
  assert.equal(browserCase.exactReviewedSemantics.selectedUserOperation.paymaster, evaluation.selectedUserOperation?.paymaster);
  assert.equal(browserCase.exactReviewedSemantics.selectedUserOperation.success, evaluation.selectedUserOperation?.success);
  assert.equal(TARGET_CORE_MUTATIONS, 0);

  return {
    schemaVersion: "ne-suite-demo/v0.1",
    demoId: "erc4337-base-sepolia-v06-core-hub-lens",
    source: {
      network: NETWORK,
      publicFixturePath: PUBLIC_FIXTURE_PATH,
      publicFixtureSha256: PUBLIC_FIXTURE_SHA256,
      bundleTransactionHash: BUNDLE_TX,
      userOpHash: USER_OP_HASH,
      sender: SENDER,
    },
    core: {
      resolver: "@nec/resolver-evm",
      adapter: "@nec/adapter-erc4337",
      replayConsistent: acquisition.consistent,
      verdict: evaluation.outcome.verdict,
      basis: [...evaluation.outcome.basis],
      claimLabel: evaluation.claimLabel,
      executionVerdict: evaluation.execution.verdict,
      selectedUserOperation: evaluation.selectedUserOperation
        ? {
            userOpHash: evaluation.selectedUserOperation.userOpHash,
            sender: evaluation.selectedUserOperation.sender,
            paymaster: evaluation.selectedUserOperation.paymaster,
            success: evaluation.selectedUserOperation.success,
            actualGasCost: evaluation.selectedUserOperation.actualGasCost,
            actualGasUsed: evaluation.selectedUserOperation.actualGasUsed,
          }
        : null,
      finality: {
        established: false,
        warningCode: ERC4337_WARNING_CODES.finalityNotEstablished,
      },
    },
    hub: {
      mode: "exact-reviewed-f2-runtime-binding",
      authoritySha: HUB_AUTHORITY_SHA,
      referenceSha256: F2_REFERENCE_SHA256,
      runtimeBindingChecks: "passed",
      runtimeBinding: {
        localRecomputation: "performed",
        publicFixturePath: PUBLIC_FIXTURE_PATH,
        publicFixtureSha256: PUBLIC_FIXTURE_SHA256,
        sourceVerdict: evaluation.outcome.verdict,
        sourceBasis: [...evaluation.outcome.basis],
        sourceClaimLabel: evaluation.claimLabel,
        blockNumber: BLOCK_NUMBER,
        blockHash: BLOCK_HASH,
        entryPoint: ENTRY_POINT_V06,
      },
      targetCoreMutations: TARGET_CORE_MUTATIONS,
      limitations: [
        "Exact public F2 fixture only; no generic Hub ingestion claim.",
        "No bundler identity, settlement, service completion, or finality is inferred.",
      ],
    },
    lens: {
      caseId: browserCase.caseId,
      propositionId: "p-userop-execution",
      verdict: lensAssessment?.value ?? null,
      supportedLabel: lensAssessment?.supportedLabel ?? null,
      openQuestions: plain(browserCase.openQuestions),
      provenanceNote: "The embedded Lens evaluator provenance records the reviewed imported F2 authority. The fresh public replay performed by this demo is recorded separately in hub.runtimeBinding.",
      browserSafeCase: plain(browserCase),
    },
  };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  const result = await buildDemoResult();
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}
