/** Frozen F4 public-source consumer. Offline only; no Core mutation or consensus assertion. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  buildEvidenceSnapshot,
  buildNetworkEvidenceResult,
  computeEvidencePolicyDigest,
  computeResolverManifestDigest,
  validateNetworkEvidenceResult,
} from "@nec/core";
import type {
  EvidencePolicy,
  EvidenceRef,
  EvidenceRequest,
  NetworkEvidenceResultContent,
  ResolverManifest,
} from "@nec/core";
import { normalizeNetworkEvidenceV01 } from "@nec/hub";
import {
  buildLensCaseFromHubV01,
  projectLensBrowserSafeV01,
  validateLensBrowserSafeCaseV01,
  validateLensCaseV01,
} from "@nec/lens";
import type { LensCaseV01, LensPropositionV01 } from "@nec/lens";
import { hubRevisionDigestV01 } from "../../packages/lens/src/canonical.js";
import { validateNeMapsCollectionV01 } from "../ne-maps/collection.js";
import type { NeMapsCaseEnvelopeV01 } from "../ne-maps/contracts/case-envelope.js";

const NETWORK = "eip155:57057" as const;
const GENESIS_TX = "0xa018d61db50752eeda10c6d52b51fd1741cc8eb41db46d9b972677539d5fef0b";
const BLOCK_HASH = "0x5320511d01ad39a4e19c6c72f029f97f27dfa002a737f58d783837da836136e3";
const CAPTURE_SHA = "a223831d3a304737e0f9e5004b25ebc1e8f18a754679b13a4770e506462384d8";
const REPORT_SHA = "01f1a80f0af86e6014fe7dfb6eed9856213b90d47ede8781e52175bf969debbb";
const VERDICTS_SHA = "c32b4fedb97d5e8366afc75604b4fae996129415c8f4f38612feef0929fad1fb";
const RECEIPT_SHA = "139d00bb13cce6de1caad0d30bd11a991f9a134dde0d45e8e359932f15addf62";
const TRANSACTION_SHA = "b76b3eccb9ccfc124bb183d99c7672548ddf468fab5d0cb4e48f5d7a3b9958c9";
const BLOCK_SHA = "3aa5f68291c68d16b8bcda3b058b9f98292082d0435ed79baf4e5a9a207d94d9";
const DOCS_SHA = "6f14d9af42f5cc4412b79278b8e8380e78426b28";
const SOURCE_SHA = "90526c75ad869b46fc19a585f6cbccc083627890";
const CASE_ID = "zksys-genesis-20261118";
const MISSING = [
  "core.poda_bytes_and_canonical_inclusion",
  "core.chainlock_finality",
  "nevm.historical_active_verifier_contract",
  "zk.real_cryptographic_proof_verified",
  "destination.withdrawal_effect",
] as const;
const SUPPORTED = [
  "genesis.exact_transaction_execution",
  "genesis.height_to_reported_batch",
  "genesis.batch_to_gateway_indexed_execution",
  "gateway.indexed_block_in_nevm_batch_range",
  "nevm.batch_mock_proof_acceptance",
  "nevm.batch_execution_commitment_match",
] as const;
const STATEMENTS: Record<string, string> = {
  "genesis.exact_transaction_execution": "Genesis transaction is recorded with a successful execution receipt at block 10968.",
  "genesis.height_to_reported_batch": "Genesis providers report block 10968 as part of Edge batch 10436 (height-based lookup only).",
  "genesis.batch_to_gateway_indexed_execution": "A public Gateway index reports Edge batch 10436 with matching state and batch commitments.",
  "gateway.indexed_block_in_nevm_batch_range": "A NEVM event records Gateway block 31362 inside batch 9448 range 31360–31362.",
  "nevm.batch_mock_proof_acceptance": "The NEVM verification transaction used V8 MOCK TYPE 3, not a real cryptographically checked ZK proof.",
  "nevm.batch_execution_commitment_match": "NEVM batch 9448 execution event matches the earlier batch commit hash and commitment.",
  "core.poda_bytes_and_canonical_inclusion": "Syscoin Core PoDA bytes match their commitment and are canonically included.",
  "core.chainlock_finality": "Syscoin ChainLock finality is independently established for the relevant Core block.",
  "nevm.historical_active_verifier_contract": "The active verifier at the historical proof block is independently identified.",
  "zk.real_cryptographic_proof_verified": "A real ZK proof is independently cryptographically verified.",
  "destination.withdrawal_effect": "The exact action's recipient-chain withdrawal or destination effect is established.",
};

type SourceClaim = {
  proposition: string;
  verdict: "supported" | "insufficient";
  evidence_basis: string;
  scope: string;
};
type SourceReport = {
  schema: string;
  archive_sha256: string;
  docs_sha: string;
  ne_source_sha: string;
  supported: number;
  insufficient: number;
  negative_tests_passed: number;
  mock_proof: { version: number; mock_proof_type: number; proof_word_count: number };
  claims: SourceClaim[];
};

function sha(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}
function sourceJson(path: string, digest: string): any {
  const raw = readFileSync(path);
  assert.equal(sha(raw), digest, "raw public source mismatch at " + path);
  return JSON.parse(raw.toString("utf8"));
}
function stamp(input: string): string {
  const date = new Date(input);
  assert.ok(Number.isFinite(date.getTime()), "invalid archive UTC timestamp");
  return date.toISOString();
}
function castHex(hex: string): `0x${string}` {
  assert.match(hex, /^0x[0-9a-f]+$/, "canonical lowercase hex");
  return hex as `0x${string}`;
}
function assertSourceReport(data: SourceReport): void {
  assert.equal(data.schema, "ne-zksys-f4-offline-source-join/v0.1");
  assert.equal(data.archive_sha256, CAPTURE_SHA);
  assert.equal(data.docs_sha, DOCS_SHA);
  assert.equal(data.ne_source_sha, SOURCE_SHA);
  assert.deepEqual([data.supported,data.insufficient,data.negative_tests_passed],[6,5,11]);
  assert.deepEqual(
    [data.mock_proof.version,data.mock_proof.mock_proof_type,data.mock_proof.proof_word_count],
    [8,3,4],
  );
  assert.deepEqual(data.claims.map(c => c.proposition), [...SUPPORTED,...MISSING]);
  for (const [i,claim] of data.claims.entries()) {
    assert.equal(claim.verdict, i<6 ? "supported" : "insufficient");
    assert.ok(["source_observation","deterministic_derivation"].includes(claim.evidence_basis));
    assert.ok(claim.scope.length>20);
  }
}
function digest(value: string): `sha256:${string}` {
  assert.match(value,/^[0-9a-f]{64}$/);
  return `sha256:${value}`;
}

function main(args: string[]): void {
  assert.equal(args.length,6,"Expected 6 args: verdicts.json REPORT.json receipt.json tx.json block.json output.json");
  const [resultPath,originalReportPath,receiptPath,transactionPath,blockPath,outPath] = args as [string,string,string,string,string,string];
  const reviewed = sourceJson(resultPath, VERDICTS_SHA) as SourceReport;
  assertSourceReport(reviewed);
  const record = sourceJson(originalReportPath, REPORT_SHA);
  const receiptEnvelope = sourceJson(receiptPath, RECEIPT_SHA);
  const txEnvelope = sourceJson(transactionPath, TRANSACTION_SHA);
  const blockEnvelope = sourceJson(blockPath, BLOCK_SHA);
  assert.equal(record.documentation_sha, DOCS_SHA);
  assert.equal(record.ne_public_sha, SOURCE_SHA);
  assert.equal(record.complete_http_response_count,19);
  assert.equal(record.rpc_errors,0);
  assert.equal(record.unavailable,0);
  assert.equal(record.file_sha256["genesis-receipt.response.json"],RECEIPT_SHA);
  assert.equal(record.file_sha256["genesis-transaction.response.json"],TRANSACTION_SHA);
  assert.equal(record.file_sha256["genesis-block-by-hash.response.json"],BLOCK_SHA);
  const receipt = receiptEnvelope.result;
  const tx = txEnvelope.result;
  const block = blockEnvelope.result;
  assert.equal(receipt.transactionHash, GENESIS_TX);
  assert.equal(tx.hash,GENESIS_TX);
  assert.equal(receipt.blockHash,BLOCK_HASH);
  assert.equal(tx.blockHash,BLOCK_HASH);
  assert.equal(block.hash,BLOCK_HASH);
  assert.equal(Number.parseInt(receipt.blockNumber,16),10968);
  assert.equal(Number.parseInt(tx.blockNumber,16),10968);
  assert.equal(Number.parseInt(block.number,16),10968);
  assert.equal(Number.parseInt(receipt.status,16),1);
  assert.equal(Number.parseInt(tx.chainId,16),57057);
  assert.ok(Array.isArray(block.transactions)&&block.transactions.includes(GENESIS_TX));
  const generatedAt = stamp(record.capture_finished);
  const observedAt = { blockNumber:10968n,blockId:castHex(BLOCK_HASH) };
  const network = {networkId:NETWORK,chainId:57057,observedAt};
  const subject = {type:"transaction" as const,networkId:NETWORK,txId:castHex(GENESIS_TX)};
  // This expected action is OBSERVATION of the transaction, never a claim about
  // transfer, user intent, settlement, bridge effect or external payment.
  const action = {kind:"evm.transaction.observation",target:castHex(tx.to)};
  const policyBody: Omit<EvidencePolicy,"digest"> = {
    id:"f4-narrow-execution",version:"0.1",
    requiredDimensions:["execution"],desiredDimensions:["dataBinding","settlement","finality"],
  };
  const policy = {...policyBody,digest:computeEvidencePolicyDigest(policyBody)};
  const manifestBody: Omit<ResolverManifest,"digest"> = {
    id:"external-f4-archived-genesis",version:"0.1.0",
    networkFamilies:["eip155"],implementation:{package:"ne-f4-archived-source-consumer"},
    supportedCapabilities:["execution","dataBinding"],
    sourceRequirements:[{sourceType:"evm_rpc",required:true}],
  };
  const manifest = {...manifestBody,digest:computeResolverManifestDigest(manifestBody)};
  const EVIDENCE = [
    ["f4_genesis_receipt",RECEIPT_SHA,"eth_getTransactionReceipt","genesis-receipt",GENESIS_TX],
    ["f4_genesis_transaction",TRANSACTION_SHA,"eth_getTransactionByHash","genesis-transaction",GENESIS_TX],
    ["f4_genesis_block",BLOCK_SHA,"eth_getBlockByHash","genesis-block-by-hash",BLOCK_HASH],
  ] as const;
  const evidence: EvidenceRef[] = EVIDENCE.map(([id,hash,method,requestKey,argument])=>({
    id,sourceId:"source.genesis.public.rpc",sourceType:"evm_rpc",
    independenceGroup:"genesis-rpc-primary",
    retrievedAt:stamp(record.requests[requestKey].at_utc),networkId:NETWORK,blockNumber:10968n,blockId:castHex(BLOCK_HASH),
    locator:method+"/"+argument,
    contentDigest:digest(hash),
  }));
  const snapshot = buildEvidenceSnapshot({
    id:"f4_genesis_snapshot",createdAt:generatedAt,
    networkFingerprint:network,
    anchors:[{networkId:NETWORK,blockNumber:10968n,blockId:castHex(BLOCK_HASH),role:"execution_observation"}],
    evidence,resolverManifestDigest:manifest.digest,policyDigest:policy.digest,
  });
  const request: EvidenceRequest = {
    schemaVersion:"0.1",requestId:"f4_genesis_execution",networkId:NETWORK,
    subject,action,evidencePolicy:policy,
  };
  const content: NetworkEvidenceResultContent = {
    schemaVersion:"0.1",requestId:request.requestId,generatedAt,
    network,subject,action,
    policy:{id:policy.id,version:policy.version,digest:policy.digest},
    snapshot:{id:snapshot.id,digest:snapshot.digest},
    networkEvidence:{
      execution:{applicability:"applicable",verdict:"supported",
        basis:["source_observation"],evidence:["f4_genesis_receipt"]},
      observedEffects:[],
      dataBinding:{applicability:"applicable",verdict:"supported",
        basis:["source_observation"],evidence:["f4_genesis_receipt","f4_genesis_transaction"]},
      settlement:{applicability:"unknown",basis:[],evidence:[],reason:"Source capture does not independently verify Gateway settlement or recipient effect."},
      finality:{applicability:"unknown",basis:[],evidence:[],reason:"No independent Syscoin Core ChainLock was observed."},
    },
    evidence,conflicts:[],warnings:[],
    resolver:{id:manifest.id,version:manifest.version,digest:manifest.digest},
  };
  const core = buildNetworkEvidenceResult(content,{request,policy,snapshot,resolver:manifest});
  validateNetworkEvidenceResult(core);
  const hubRecord = normalizeNetworkEvidenceV01({kind:"network_evidence_result",result:core});
  assert.equal(hubRecord.result.semanticDigest,core.semanticDigest);
  assert.equal(hubRecord.result.artifactDigest,core.artifactDigest);
  const base = buildLensCaseFromHubV01({
    hubRecord,caseId:CASE_ID,namespace:"ne.zksys.f4",
    createdAt:generatedAt,
    limitations:[
      "Historical public testnet source observations, not current network state or independent consensus.",
      "V8 MOCK TYPE 3 is not a real independently cryptographically verified ZK proof.",
      "Gateway RPC was not queried; gateway event evidence originates from a public indexer.",
      "PoDA raw bytes, canonical Core publication, ChainLock finality and recipient effects remain unverified.",
    ],
  });
  const f4SourceId = "f4:original-public-source-archive";
  const sourceArtifact = {
    artifactId:f4SourceId,artifactType:"archived_readonly_rpc_and_index_records",
    sourceSchema:"ne-zksys-f4-public-HTTP-capture/v0.1",
    mediaType:"application/zip",
    artifactDigest:{algorithm:"sha256" as const,value:CAPTURE_SHA,digestOf:"exact_original_public_source_capture"},
    locatorClass:"bundled_pinned_source_archive",locatorRef:null,availability:"available" as const,
    sourceObservedAt:generatedAt,
    limitations:["Archive digest binds public RPC and indexer observations; not a consensus/finality attestation."],
  };
  const f4Propositions: LensPropositionV01[] = reviewed.claims.map((claim, index)=>{
    const propositionId = "f4:"+claim.proposition;
    return {
      propositionId,domain:"zkSYS historical testnet",kind:"external_source_bound_edge",
      statement:STATEMENTS[claim.proposition]!,
      subjectRefs:[f4SourceId],sourceClaimRefs:[],
      assessments:[{
        assessmentId:"f4_external_assessment_"+index,propositionId,
        evaluator:{
          type:"f4_external_offline_source_join",version:"0.1.0",
          verificationMode:"strict_archived_public_sources",
          provenanceClass:"public_rpc_and_indexer_capture",
        },
        // IMPORTANT: never impersonate Core's network_evidence_verdict/v0.1.
        vocabulary:"f4_external_source_join/v0.1",
        value:claim.verdict,basis:[claim.evidence_basis],evidenceRefs:[f4SourceId],
        evaluatedAt:generatedAt,
        limitations:[claim.scope,
          "External case-level observation; this is NOT a Core dimension verdict or independent finality."],
      }],
      availability:claim.verdict==="supported"?"available":"unknown",
      limitations:[claim.scope],
    };
  });
  const order = f4Propositions.slice(0,6).map(x=>x.propositionId);
  const missing = f4Propositions.slice(6).map((x,i)=>({
    questionId:"f4_missing_"+i,domain:"zkSYS historical testnet",statement:"What independent evidence would establish this claim? "+x.statement,
    status:"awaiting_evidence" as const,relatedPropositionRefs:[x.propositionId],
    reason:"No independently sufficient source for this proposition in the frozen F4 capture.",
  }));
  const relations = order.slice(0,-1).map((ref,i)=>({
    relationId:"f4_follow_"+(i+1),fromRef:ref,toRef:order[i+1]!,
    relationType:"archived_provenance_sequence",basis:"presentation_order_only",
    assertedBy:"external_f4_source_consumer",evidenceRefs:[f4SourceId],
    limitations:["Following the five source records does not assert unproven causal chain linkage."],
  }));
  const {revisionDigest:_old,...baseBody} = base;
  const mergedBody = {
    ...baseBody,
    artifacts:[...base.artifacts,sourceArtifact],
    propositions:[...base.propositions,...f4Propositions],
    relations:[...base.relations,...relations],
    openQuestions:[...base.openQuestions,...missing],
    limitations:[...base.limitations,
      "All six source-join assessments are EXTERNAL, not Core-supported dimensions.",
      "Do not interpret the mock proof, Gateway index or batch relationship as finality."],
  };
  const lens = {
    ...mergedBody,
    revisionDigest:hubRevisionDigestV01(mergedBody),
  } as LensCaseV01;
  validateLensCaseV01(lens);
  const browser = projectLensBrowserSafeV01(lens);
  validateLensBrowserSafeCaseV01(browser);
  assert.equal(browser.propositions.filter(x=>x.propositionId.startsWith("f4:")).length,11);
  assert.equal(browser.openQuestions.length,5);
  assert.equal(browser.coreResultPreservation?.subject.type,"transaction");
  assert.equal(browser.coreResultPreservation?.subject.networkId,NETWORK);
  assert.equal(browser.projectionPolicy,"lens-browser/v0.1");
  assert.equal(browser.TARGET_CORE_MUTATIONS,0);
  const envelope: NeMapsCaseEnvelopeV01 = {
    schemaVersion:"ne-maps-case/v0.1",id:CASE_ID,
    display:{
      networkLabel:"zkSYS Genesis · public testnet",
      title:"Follow one real zkSYS Genesis transaction",
      shape:"Historical · 5 source records · mock proof · PoDA and finality unknown",
    },
    exactAction:{
      networkId:NETWORK,id:GENESIS_TX,kind:"transaction",
      historicalBlock:"10968",edgeBatch:"10436",gatewayBatch:"9448",
      genesisSource:"Genesis public RPC; archive capture/genesis-receipt.response.json",
      gatewayNetworkId:"eip155:57001",
      gatewayTransaction:"0x321f5184dea2ff8026bc84b01df304c8936b139e64b25774ffd326853b2391d9",
      gatewayBlock:"31362",
      gatewaySource:"Public Gateway indexer; archive capture/gateway-execution-tx-index.response.json and gateway-execution-logs-index.response.json; no independent Gateway consensus",
      nevmNetworkId:"eip155:5700",
      nevmCommitTransaction:"0x4661a9f890147e1ceb4dc8647eeba801ec206d4a318b299083c291b89f9820f3",
      nevmCommitBlock:"1009176",
      nevmCommitSource:"NEVM public RPC; archive capture/nevm-range-receipt.response.json",
      nevmMockProofTransaction:"0xc82091801f6b0947db4bed5fb2400e07313e2730b0c37d389d2b3c5dba9fdde0",
      nevmMockProofBlock:"1009179",
      nevmMockProofSource:"NEVM public RPC; archive capture/nevm-proof-transaction.response.json and nevm-proof-receipt.response.json; MOCK V8 TYPE 3",
      nevmExecutionTransaction:"0x6498e1f4bd29000890343b377d9790b2a63db10e03d3d25fcd5ea1f9ed4f29e6",
      nevmExecutionBlock:"1009182",
      nevmExecutionSource:"NEVM public RPC; archive capture/nevm-execution-receipt.response.json",
    },
    trailPropositionOrder:order,
    lens:browser,
    extensions:{
      trailContextNote:"Historical replay. Step 4 is a MOCK verifier; neither Core PoDA nor ChainLock is verified.",
      provenance:{
        sourceAuthority:"syscoin/sys-docs@"+DOCS_SHA,
        networkEvidenceSource:"ZzNible/network-evidence@"+SOURCE_SHA,
        originalCaptureSha256:CAPTURE_SHA,
        replayGuide:"examples/zksys-genesis-f4/README.md",
        sourceArchive:"examples/zksys-genesis-f4/ORIGINAL_PUBLIC_CAPTURE.zip",
        sourceVerdictsSha256:VERDICTS_SHA,
        realityClass:"source-bound candidate — NOT REVIEWED, NOT LIVE",
        construction:"external Core->Hub->Lens plus deterministic source joins; no Core mutation",
      },
    },
  };
  validateNeMapsCollectionV01({
    schemaVersion:"ne-maps-case-collection/v0.1",
    TARGET_CORE_MUTATIONS:0,
    nonClaims:["Private F4 source-bound candidate; not part of shipped public NE Maps or MCP.","Mock proof is not independent cryptographic ZK verification."],
    cases:[envelope],
  },{validateLens:validateLensBrowserSafeCaseV01});
  const output={
    schema:"ne-zksys-f4-private-hub-lens-candidate/v0.1",
    publicSourceSha:SOURCE_SHA,docsSha:DOCS_SHA,captureSha:CAPTURE_SHA,
    candidateOnly:true,reviewedForMcp:false,coreMutations:0,
    coreDigest:core.semanticDigest,coreArtifactDigest:core.artifactDigest,
    sourceEvidence:core.evidence.map(({id,locator,retrievedAt,contentDigest})=>({id,locator,retrievedAt,contentDigest})),
    coreExecutionVerdict:core.networkEvidence.execution.verdict,
    coreFinalityApplicability:core.networkEvidence.finality.applicability,
    coreSettlementApplicability:core.networkEvidence.settlement.applicability,
    hubSchema:hubRecord.schemaVersion,
    externalSupported:6,externalInsufficient:5,externalTamperTests:11,
    envelope,
  };
  writeFileSync(outPath,JSON.stringify(output,null,2)+"\n",{flag:"wx"});
  console.log("F4_CORE_HUB_LENS_PRIVATE_CANDIDATE_PASS execution=supported finality=unknown external=6/5 coreMutations=0");
}
main(process.argv.slice(2));
