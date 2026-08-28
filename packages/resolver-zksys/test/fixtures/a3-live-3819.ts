import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { nativeSourceContentDigest } from "@nec/core";
import type { EvidenceRef } from "@nec/core";
import type { EvmCapabilityProbeObservation } from "@nec/resolver-evm";

import {
  ZKSYS_BATCHING_RPC_METHOD,
  ZKSYS_TANENBAUM_CHAIN_ID,
  ZKSYS_TANENBAUM_NETWORK_ID,
} from "../../src/index.js";
import type { ZksysBatchingProbeObservation } from "../../src/index.js";

const FIXTURE_ROOT = new URL("./a3-live-v31-3819/", import.meta.url);
const SOURCE_ID = "a3-live-v31-3819.zksys-rpc";
const OBSERVED_AT = "2026-08-25T13:14:25.000Z";
const PACKAGING_COMMIT = "09ffea96ae0ab540fa59d96620370191ecbe6eb5";
const SOURCE_LOCATOR_ROOT = `https://github.com/ZzNible/network-evidence-core/blob/${PACKAGING_COMMIT}/fixtures/a3-live-v31-3819`;
const TX = "0xf107268ee5f9177dbd23c2e6b040f0ea9b7c7323f1f385ee3ea43bb03b9e6b8d";
const BLOCK_HASH = "0xfd0c46ee92e3af04ba0491d1897e1e54b32c31142ef9075ea1941117293e112d";

interface RpcRequest {
  readonly method: string;
  readonly params: unknown[];
}

interface RpcResponse<T> {
  readonly result: T;
}

interface ZksysProjection {
  readonly chainIdDecimal: number;
  readonly clientVersion: string;
  readonly transactionT: {
    readonly hash: string;
    readonly blockNumber: number;
    readonly blockHash: string;
    readonly status: string;
  };
  readonly blockL: { readonly number: number; readonly hash: string };
  readonly batchF: { readonly batchNumber: number; readonly blockRange: [number, number] };
}

interface BatchResult {
  readonly batch_info: { readonly batch_number: number };
  readonly block_range: { readonly start: number; readonly end: number };
}

interface ReceiptResult {
  readonly transactionHash: string;
  readonly blockNumber: string;
  readonly blockHash: string;
  readonly status: string;
}

interface BlockResult {
  readonly hash: string;
  readonly number: string;
  readonly transactions: ReadonlyArray<{ readonly hash: string; readonly blockHash: string; readonly blockNumber: string }>;
}

function bytes(path: string): Buffer {
  return readFileSync(new URL(path, FIXTURE_ROOT));
}

function json<T>(path: string): T {
  return JSON.parse(bytes(path).toString("utf8")) as T;
}

function digest(path: string, expected: string): string {
  const actual = createHash("sha256").update(bytes(path)).digest("hex");
  if (actual !== expected) throw new Error(`historical fixture digest mismatch for ${path}`);
  return `sha256:${actual}`;
}

function provenance(rpcMethod: string, level: string): Record<string, unknown> {
  return {
    rpcMethod,
    provenance: "historical_fixture_replay",
    provenanceLevel: level,
    observationKind: "historical_replay",
    fixturePack: "a3-live-v31-3819",
    fixturePackagingCommit: PACKAGING_COMMIT,
  };
}

function archivedRpcNativeSource(
  requestPath: string,
  responsePath: string,
): NonNullable<EvidenceRef["nativeSource"]> {
  const raw = new TextEncoder().encode(JSON.stringify({
    request: bytes(requestPath).toString("utf8"),
    response: bytes(responsePath).toString("utf8"),
    observationKind: "historical_replay",
  }));
  return {
    namespace: "nec.resolver-zksys.archived-rpc",
    mediaType: "application/json",
    encoding: "base64",
    payload: Buffer.from(raw).toString("base64"),
    contentDigest: nativeSourceContentDigest(raw),
    schema: "zksys-archived-rpc-exchange-v0.1",
  };
}

function sourceLocator(path: string): string {
  return `${SOURCE_LOCATOR_ROOT}/${path}`;
}

function verifyArchivedChecksums(): void {
  const expected: Record<string, string> = {
    "raw/eth_chainId.request.json": "09fabe0af56b7726f1666ddd147482df4d951f86f66124b936716c53ab0e8471",
    "raw/eth_chainId.json": "aef4d857564085b045df438bd97012145f585652eb0a4c8b7fa5595bf43a7fb9",
    "raw/web3_clientVersion.request.json": "7b47d4a21cbcd269ef6ca54f1f4a162a5a968d3b995e54037fd89ea9061ee6a0",
    "raw/web3_clientVersion.json": "a877cd6645d074ece85b898c8daaed5f8cb871d66fb6d24d7b918f4fbcab3c35",
    "raw/tx_by_hash_T.request.json": "a095daefd58a26c18e06df8123514aef57b335d165021d67d631b55f554eb733",
    "raw/tx_by_hash_T.json": "e38077c015e75d8856274c5141a318727e7bcd3608f4d6c9a8cdcc8afccacc14",
    "raw/receipt_T.request.json": "4ede895e2977533f7c8d0e24fe65b7f9458a1fbf4c8f1f7d638031011d81a5ae",
    "raw/receipt_T.json": "bee2de4c6b635cd72ca1483d9c1c62d90f90d1f490cd514c7ad75129e574b0ae",
    "raw/block_5353_byHash_full.request.json": "3decf92ba11820fcfc1a1d1be6205f5e4ea50d4ffd75b5322a20be6a0eded07e",
    "raw/block_5353_byHash_full.json": "2664c98767f150b7f73621a11b88332bcc346a0640a6ff2aeb68bb25a60ffaa2",
    "raw/batch_by_block_5353.request.json": "33c9ec678b9df3e5fe1c58656bcd3a9a58e2c2e330c7a918a44ae611012134c0",
    "raw/batch_by_block_5353.json": "abc80915907cc50e1d58a0d522ad01293419ed8a09d32922d9e3235d79ab4808",
  };
  for (const [path, expectedDigest] of Object.entries(expected)) digest(path, expectedDigest);
}

export interface A3ZksysFixtureObservation {
  readonly evmObservation: EvmCapabilityProbeObservation;
  readonly batchingObservation: ZksysBatchingProbeObservation;
  readonly clientVersion: string;
  readonly transactionHash: string;
  readonly blockNumber: number;
  readonly batchNumber: number;
}

export function loadA3ZksysFixtureObservation(): A3ZksysFixtureObservation {
  verifyArchivedChecksums();
  const chainRequest = json<RpcRequest>("raw/eth_chainId.request.json");
  const chain = json<RpcResponse<string>>("raw/eth_chainId.json");
  const clientRequest = json<RpcRequest>("raw/web3_clientVersion.request.json");
  const client = json<RpcResponse<string>>("raw/web3_clientVersion.json");
  const txRequest = json<RpcRequest>("raw/tx_by_hash_T.request.json");
  const tx = json<RpcResponse<{ hash: string; chainId: string; blockNumber: string; blockHash: string }>>(
    "raw/tx_by_hash_T.json",
  );
  const receiptRequest = json<RpcRequest>("raw/receipt_T.request.json");
  const receipt = json<RpcResponse<ReceiptResult>>("raw/receipt_T.json");
  const blockRequest = json<RpcRequest>("raw/block_5353_byHash_full.request.json");
  const block = json<RpcResponse<BlockResult>>("raw/block_5353_byHash_full.json");
  const batchRequest = json<RpcRequest>("raw/batch_by_block_5353.request.json");
  const batch = json<RpcResponse<BatchResult>>("raw/batch_by_block_5353.json");
  const projection = json<ZksysProjection>("normalized/zksys_projection.json");

  if (
    chainRequest.method !== "eth_chainId" ||
    chain.result !== "0xdee1" ||
    clientRequest.method !== "web3_clientVersion" ||
    client.result !== "zksync-os/v0.22.0" ||
    txRequest.method !== "eth_getTransactionByHash" ||
    tx.result.hash !== TX ||
    tx.result.chainId !== "0xdee1" ||
    tx.result.blockNumber !== "0x14e9" ||
    tx.result.blockHash !== BLOCK_HASH ||
    receiptRequest.method !== "eth_getTransactionReceipt" ||
    receiptRequest.params[0] !== TX ||
    receipt.result.transactionHash !== TX ||
    receipt.result.status !== "0x1" ||
    receipt.result.blockNumber !== "0x14e9" ||
    receipt.result.blockHash !== BLOCK_HASH ||
    blockRequest.method !== "eth_getBlockByHash" ||
    blockRequest.params[0] !== BLOCK_HASH ||
    blockRequest.params[1] !== true ||
    block.result.hash !== BLOCK_HASH ||
    block.result.number !== "0x14e9" ||
    block.result.transactions.length !== 1 ||
    block.result.transactions[0]?.hash !== TX ||
    block.result.transactions[0]?.blockHash !== BLOCK_HASH ||
    block.result.transactions[0]?.blockNumber !== "0x14e9" ||
    batchRequest.method !== ZKSYS_BATCHING_RPC_METHOD ||
    batchRequest.params[0] !== 5353 ||
    projection.chainIdDecimal !== ZKSYS_TANENBAUM_CHAIN_ID ||
    projection.transactionT.hash !== TX ||
    projection.transactionT.status !== receipt.result.status ||
    projection.transactionT.blockNumber !== Number.parseInt(receipt.result.blockNumber, 16) ||
    projection.transactionT.blockHash !== BLOCK_HASH ||
    projection.blockL.number !== Number.parseInt(block.result.number, 16) ||
    projection.blockL.hash !== BLOCK_HASH ||
    projection.batchF.batchNumber !== batch.result.batch_info.batch_number ||
    projection.batchF.blockRange[0] !== batch.result.block_range.start ||
    projection.batchF.blockRange[1] !== batch.result.block_range.end
  ) {
    throw new Error("historical A3 zkSYS fixture identity/coherence check failed");
  }

  const evmEvidence: EvidenceRef[] = [
    {
      id: "ev-a3-zksys-chainidentity",
      sourceId: SOURCE_ID,
      sourceType: "evm_rpc",
      locator: sourceLocator("raw/eth_chainId.json"),
      retrievedAt: "2026-08-25T13:14:24.000Z",
      contentDigest: digest("raw/eth_chainId.json", "aef4d857564085b045df438bd97012145f585652eb0a4c8b7fa5595bf43a7fb9"),
      networkId: ZKSYS_TANENBAUM_NETWORK_ID,
      metadata: provenance("eth_chainId", "archived_raw_rpc_response"),
      nativeSource: archivedRpcNativeSource("raw/eth_chainId.request.json", "raw/eth_chainId.json"),
    },
    {
      id: "ev-a3-zksys-receipt",
      sourceId: SOURCE_ID,
      sourceType: "evm_rpc",
      locator: sourceLocator("raw/receipt_T.json"),
      retrievedAt: OBSERVED_AT,
      contentDigest: digest("raw/receipt_T.json", "bee2de4c6b635cd72ca1483d9c1c62d90f90d1f490cd514c7ad75129e574b0ae"),
      networkId: ZKSYS_TANENBAUM_NETWORK_ID,
      blockNumber: 5353n,
      blockId: BLOCK_HASH,
      metadata: provenance("eth_getTransactionReceipt", "archived_raw_rpc_response"),
      nativeSource: archivedRpcNativeSource("raw/receipt_T.request.json", "raw/receipt_T.json"),
    },
    {
      id: "ev-a3-zksys-block",
      sourceId: SOURCE_ID,
      sourceType: "evm_rpc",
      locator: sourceLocator("raw/block_5353_byHash_full.json"),
      retrievedAt: OBSERVED_AT,
      contentDigest: digest("raw/block_5353_byHash_full.json", "2664c98767f150b7f73621a11b88332bcc346a0640a6ff2aeb68bb25a60ffaa2"),
      networkId: ZKSYS_TANENBAUM_NETWORK_ID,
      blockNumber: 5353n,
      blockId: BLOCK_HASH,
      metadata: provenance("eth_getBlockByHash", "archived_raw_rpc_response"),
      nativeSource: archivedRpcNativeSource(
        "raw/block_5353_byHash_full.request.json",
        "raw/block_5353_byHash_full.json",
      ),
    },
    {
      id: "ev-a3-zksys-transaction",
      sourceId: SOURCE_ID,
      sourceType: "evm_rpc",
      locator: sourceLocator("raw/tx_by_hash_T.json"),
      retrievedAt: OBSERVED_AT,
      contentDigest: digest("raw/tx_by_hash_T.json", "e38077c015e75d8856274c5141a318727e7bcd3608f4d6c9a8cdcc8afccacc14"),
      networkId: ZKSYS_TANENBAUM_NETWORK_ID,
      blockNumber: 5353n,
      blockId: BLOCK_HASH,
      metadata: provenance("eth_getTransactionByHash", "archived_raw_rpc_response"),
      nativeSource: archivedRpcNativeSource("raw/tx_by_hash_T.request.json", "raw/tx_by_hash_T.json"),
    },
  ];

  const batchRequestText = bytes("raw/batch_by_block_5353.request.json").toString("utf8");
  const batchResponseText = bytes("raw/batch_by_block_5353.json").toString("utf8");
  const batchNativeBytes = new TextEncoder().encode(
    JSON.stringify({
      request: batchRequestText,
      response: batchResponseText,
      observationKind: "historical_replay",
    }),
  );
  const batchEvidence: EvidenceRef = {
    id: "ev-a3-zksys-block-to-batch",
    sourceId: SOURCE_ID,
    sourceType: "evm_rpc",
    locator: sourceLocator("raw/batch_by_block_5353.json"),
    retrievedAt: OBSERVED_AT,
    contentDigest: digest("raw/batch_by_block_5353.json", "abc80915907cc50e1d58a0d522ad01293419ed8a09d32922d9e3235d79ab4808"),
    networkId: ZKSYS_TANENBAUM_NETWORK_ID,
    blockNumber: 5353n,
    metadata: provenance(ZKSYS_BATCHING_RPC_METHOD, "archived_raw_rpc_response"),
    nativeSource: {
      namespace: "nec.resolver-zksys.rpc-probe",
      mediaType: "application/json",
      encoding: "base64",
      payload: Buffer.from(batchNativeBytes).toString("base64"),
      contentDigest: nativeSourceContentDigest(batchNativeBytes),
      schema: "zksys-block-to-batch-probe-v0.1",
    },
  };

  return {
    evmObservation: {
      network: ZKSYS_TANENBAUM_NETWORK_ID,
      chainId: ZKSYS_TANENBAUM_CHAIN_ID,
      source: { sourceId: SOURCE_ID, sourceType: "evm_rpc" },
      observedAt: OBSERVED_AT,
      rpcReachable: true,
      chainIdentityObserved: true,
      receiptLookupUsable: true,
      blockLookupUsable: true,
      transactionLookupUsable: true,
      evidence: evmEvidence,
    },
    batchingObservation: {
      network: ZKSYS_TANENBAUM_NETWORK_ID,
      source: { sourceId: SOURCE_ID, sourceType: "evm_rpc" },
      observedAt: OBSERVED_AT,
      observationKind: "historical_replay",
      rpcReachable: true,
      blockToBatchLookupUsable: true,
      association: {
        blockNumber: projection.blockL.number,
        batchNumber: batch.result.batch_info.batch_number,
        reportedBlockRange: {
          start: batch.result.block_range.start,
          end: batch.result.block_range.end,
        },
      },
      evidence: [batchEvidence],
    },
    clientVersion: client.result,
    transactionHash: tx.result.hash,
    blockNumber: projection.blockL.number,
    batchNumber: batch.result.batch_info.batch_number,
  };
}
