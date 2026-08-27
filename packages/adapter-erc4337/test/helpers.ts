/**
 * Deterministic artifact world for adapter tests: builds REAL frozen-core
 * `NetworkEvidenceFragment` artifacts carrying generic EVM log-shaped
 * observed effects for the ERC-4337 / ERC-1155 pinned shapes.
 */

import {
  buildEvidenceSnapshot,
  buildNetworkEvidenceResult,
  computeEvidencePolicyDigest,
  computeResolverManifestDigest,
  validateNetworkEvidenceFragment as coreValidateFragment,
} from "@nec/core";
import type {
  CapabilityName,
  Conflict,
  EvidenceDimension,
  EvidencePolicy,
  EvidenceRef,
  NetworkEvidenceFragment,
  NetworkFingerprint,
  ObservedEffect,
  PolicyDimension,
  SubjectRef,
  Warning,
} from "@nec/core";

import {
  TRANSFER_BATCH_TOPIC0,
  TRANSFER_SINGLE_TOPIC0,
  USER_OPERATION_EVENT_TOPIC0,
  ZERO_ADDRESS,
} from "../src/events.js";

// ---------------------------------------------------------------------------
// Canonical sample world (Base-shaped, deterministic)
// ---------------------------------------------------------------------------

export const T0 = "2026-01-01T00:00:00.000Z";
export const T1 = "2026-01-02T12:30:00.000Z";

export const NETWORK_ID = "eip155:8453";
export const CHAIN_ID = 8453;

export const ENTRY_POINT = "0x0000000071727de22e5e9d8baf0edac6f37da032";
export const SENDER = `0x${"a1".repeat(20)}`;
export const OTHER_ACCOUNT = `0x${"b2".repeat(20)}`;
export const CREDITS_CONTRACT = `0x${"c3".repeat(20)}`;
export const OTHER_CONTRACT = `0x${"d4".repeat(20)}`;
export const FAKE_ENTRY_POINT = `0x${"e5".repeat(20)}`;

export const TX = `0x${"7b".repeat(32)}`;
export const USER_OP_HASH = `0x${"94".repeat(32)}`;
export const OTHER_USER_OP_HASH = `0x${"ff".repeat(32)}`;
export const TOKEN_ID = "107134729016282785317688751027026876438402324055584221042936325851129895197441";
export const OTHER_TOKEN_ID = "42";
export const BURN_VALUE = "1";
export const NONCE = "456245916723329235110820985289680093772101078459260784015790467369458991104";
export const GAS_COST = "0";
export const GAS_USED = "1201444";

export function padTopic(address: string): string {
  return `0x${"00".repeat(12)}${address.slice(2).toLowerCase()}`;
}

export function word(amount: string): string {
  return `0x${BigInt(amount).toString(16).padStart(64, "0")}`;
}

/** A 32-byte (64 hex char) word WITHOUT a 0x prefix, for raw ABI assembly. */
export function hexWord(amount: string): string {
  return BigInt(amount).toString(16).padStart(64, "0");
}

function words(...values: readonly string[]): string {
  return `0x${values.map((v) => word(v).slice(2)).join("")}`;
}

/** Canonical UserOperationEvent log fields (well-formed by default). */
export interface UopEffectOptions {
  readonly emitter?: string;
  readonly userOpHash?: string;
  readonly sender?: string;
  readonly paymaster?: string;
  readonly nonce?: string;
  readonly success?: boolean;
  readonly actualGasCost?: string;
  readonly actualGasUsed?: string;
  readonly topicsOverride?: string[];
  readonly dataOverride?: string;
  readonly omitRemoved?: boolean;
  readonly removed?: boolean;
  readonly transactionHash?: string | null;
  readonly cite?: string[];
}

export function userOpEventEffect(id: string, opts: UopEffectOptions = {}): ObservedEffect {
  const fields: Record<string, unknown> = {
    address: opts.emitter ?? ENTRY_POINT,
    topics:
      opts.topicsOverride ??
      [
        USER_OPERATION_EVENT_TOPIC0,
        opts.userOpHash ?? USER_OP_HASH,
        padTopic(opts.sender ?? SENDER),
        padTopic(opts.paymaster ?? ZERO_ADDRESS),
      ],
    data:
      opts.dataOverride ??
      words(
        opts.nonce ?? NONCE,
        (opts.success ?? true) ? "1" : "0",
        opts.actualGasCost ?? GAS_COST,
        opts.actualGasUsed ?? GAS_USED,
      ),
    blockNumber: "45309460",
    blockHash: `0x${"ab".repeat(32)}`,
    transactionHash: opts.transactionHash === null ? undefined : opts.transactionHash ?? TX,
    transactionIndex: "67",
    logIndex: "239",
    ...(opts.omitRemoved === true ? {} : { removed: opts.removed ?? false }),
  };
  if (fields["transactionHash"] === undefined) delete fields["transactionHash"];
  return {
    id,
    type: "evm.log",
    fields,
    basis: ["source_observation"],
    evidence: opts.cite ?? [`ev_${id}`],
  };
}

/** Canonical TransferSingle log fields (burn by default: to == zero). */
export interface TsEffectOptions {
  readonly contract?: string;
  readonly operator?: string;
  readonly from?: string;
  readonly to?: string;
  readonly tokenId?: string;
  readonly value?: string;
  readonly topicsOverride?: string[];
  readonly dataOverride?: string;
  readonly omitRemoved?: boolean;
  readonly removed?: boolean;
  readonly transactionHash?: string | null;
  readonly cite?: string[];
}

export function transferSingleEffect(id: string, opts: TsEffectOptions = {}): ObservedEffect {
  const fields: Record<string, unknown> = {
    address: opts.contract ?? CREDITS_CONTRACT,
    topics:
      opts.topicsOverride ??
      [
        TRANSFER_SINGLE_TOPIC0,
        padTopic(opts.operator ?? (opts.from ?? SENDER)),
        padTopic(opts.from ?? SENDER),
        padTopic(opts.to ?? ZERO_ADDRESS),
      ],
    data:
      opts.dataOverride ??
      words(opts.tokenId ?? TOKEN_ID, opts.value ?? BURN_VALUE),
    blockNumber: "45309460",
    blockHash: `0x${"ab".repeat(32)}`,
    transactionHash: opts.transactionHash === null ? undefined : opts.transactionHash ?? TX,
    transactionIndex: "67",
    logIndex: "238",
    ...(opts.omitRemoved === true ? {} : { removed: opts.removed ?? false }),
  };
  if (fields["transactionHash"] === undefined) delete fields["transactionHash"];
  return {
    id,
    type: "evm.log",
    fields,
    basis: ["source_observation"],
    evidence: opts.cite ?? [`ev_${id}`],
  };
}

export function unrelatedEffect(id: string): ObservedEffect {
  return {
    id,
    type: "evm.log",
    fields: {
      address: OTHER_CONTRACT,
      topics: [`0x${"99".repeat(32)}`, padTopic(SENDER)],
      data: "0x",
      removed: false,
      logIndex: "2",
    },
    basis: ["source_observation"],
    evidence: [`ev_${id}`],
  };
}

/**
 * Encode `(uint256[] ids, uint256[] values)` with STRICT canonical ABI:
 * two 32-byte head offsets followed by each dynamic array (length word +
 * elements). Each array carries its OWN length, so a length mismatch is
 * faithfully represented and the adapter's decoder must reject it.
 */
export function encodeTransferBatchData(ids: readonly string[], values: readonly string[]): string {
  const idWords = ids.map((v) => hexWord(v));
  const valueWords = values.map((v) => hexWord(v));
  const headIdsOffset = hexWord(String(2 * 32)); // 0x40
  const headValuesOffset = hexWord(String(2 * 32 + (1 + ids.length) * 32));
  return `0x${headIdsOffset}${headValuesOffset}${hexWord(String(ids.length))}${idWords.join("")}${hexWord(String(values.length))}${valueWords.join("")}`;
}

/** Canonical TransferBatch log fields (well-formed by default). */
export interface TbEffectOptions {
  readonly contract?: string;
  readonly operator?: string;
  readonly from?: string;
  readonly to?: string;
  readonly ids?: readonly string[];
  readonly values?: readonly string[];
  readonly topicsOverride?: string[];
  readonly dataOverride?: string;
  readonly omitRemoved?: boolean;
  readonly removed?: boolean;
  readonly transactionHash?: string | null;
  readonly cite?: string[];
}

export function transferBatchEffect(id: string, opts: TbEffectOptions = {}): ObservedEffect {
  const ids = opts.ids ?? ["1"];
  const values = opts.values ?? ["1"];
  const fields: Record<string, unknown> = {
    address: opts.contract ?? CREDITS_CONTRACT,
    topics:
      opts.topicsOverride ??
      [
        TRANSFER_BATCH_TOPIC0,
        padTopic(opts.operator ?? (opts.from ?? SENDER)),
        padTopic(opts.from ?? SENDER),
        padTopic(opts.to ?? ZERO_ADDRESS),
      ],
    data: opts.dataOverride ?? encodeTransferBatchData(ids, values),
    blockNumber: "45309460",
    blockHash: `0x${"ab".repeat(32)}`,
    transactionHash: opts.transactionHash === null ? undefined : opts.transactionHash ?? TX,
    transactionIndex: "67",
    logIndex: "237",
    ...(opts.omitRemoved === true ? {} : { removed: opts.removed ?? false }),
  };
  if (fields["transactionHash"] === undefined) delete fields["transactionHash"];
  return {
    id,
    type: "evm.log",
    fields,
    basis: ["source_observation"],
    evidence: opts.cite ?? [`ev_${id}`],
  };
}

// ---------------------------------------------------------------------------
// Core shapes
// ---------------------------------------------------------------------------

export function fingerprint(
  networkId: string = NETWORK_ID,
  chainId: number | undefined = CHAIN_ID,
): NetworkFingerprint {
  return {
    networkId,
    ...(chainId === undefined ? {} : { chainId }),
    observedAt: { blockNumber: 45309460n, blockId: `0x${"ab".repeat(32)}` },
  };
}

export function subject(networkId: string = NETWORK_ID): SubjectRef {
  return { type: "transaction", networkId, txId: TX };
}

function safeDigestSeed(id: string): string {
  let seed = "";
  for (let i = 0; i < 64; i++) {
    seed += ((id.charCodeAt(i % id.length) + i * 7) % 16).toString(16);
  }
  return `sha256:${seed}`;
}

export function evidenceRef(id: string): EvidenceRef {
  return {
    id,
    sourceId: "src.rpc.primary",
    sourceType: "evm_rpc",
    retrievedAt: T0,
    contentDigest: safeDigestSeed(id),
    locator: "eth_getTransactionReceipt",
    independenceGroup: "rpc-primary",
  };
}

export function dimension(overrides: Partial<EvidenceDimension> = {}): EvidenceDimension {
  return { applicability: "unknown", basis: [], evidence: [], ...overrides };
}

function mergeDimension(
  base: EvidenceDimension,
  overrides: Partial<EvidenceDimension> | undefined,
): EvidenceDimension {
  const out: Record<string, unknown> = { ...base };
  if (overrides !== undefined) {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) {
        delete out[key];
      } else {
        out[key] = value;
      }
    }
  }
  return out as unknown as EvidenceDimension;
}

function fullPolicy(): EvidencePolicy {
  const content = {
    id: "erc4337-basic",
    version: "1",
    requiredDimensions: ["execution", "observedEffects"] as PolicyDimension[],
    desiredDimensions: ["finality"] as PolicyDimension[],
  };
  return { ...content, digest: computeEvidencePolicyDigest(content) };
}

function fullManifest() {
  const content = {
    id: "resolver-evm",
    version: "0.1.0",
    networkFamilies: ["eip155"],
    implementation: { package: "@nec/resolver-evm" },
    supportedCapabilities: [
      "execution",
      "observedEffects",
      "dataBinding",
      "executionModel",
    ] as CapabilityName[],
    sourceRequirements: [{ sourceType: "evm_rpc", required: true }],
  };
  return { ...content, digest: computeResolverManifestDigest(content) };
}

export interface FragmentOptions {
  readonly networkId?: string;
  readonly chainId?: number | undefined;
  /** Defaults to the canonical bundle subject (txId = TX). */
  readonly subject?: SubjectRef;
  readonly effects?: readonly ObservedEffect[];
  /** Omit the execution dimension entirely (null-receipt worlds). */
  readonly omitExecution?: boolean;
  readonly executionDim?: Partial<EvidenceDimension>;
  readonly settlementDim?: Partial<EvidenceDimension>;
  readonly finalityDim?: Partial<EvidenceDimension>;
  readonly conflicts?: readonly Conflict[];
  readonly warnings?: readonly Warning[];
  readonly extraRefs?: readonly EvidenceRef[];
}

/**
 * Build a REAL, fully valid `NetworkEvidenceFragment`. Throws through
 * frozen-core validation if anything is incoherent.
 */
export function buildFragment(opts: FragmentOptions = {}): NetworkEvidenceFragment {
  const networkId = opts.networkId ?? NETWORK_ID;
  const effects = opts.effects ?? [];

  const allRefs = [
    evidenceRef("ev_receipt_1"),
    ...effects.flatMap((effect) => effect.evidence.map(evidenceRef)),
    ...(opts.extraRefs ?? []),
  ];
  const uniqueRefs = [...new Map(allRefs.map((r) => [r.id, r])).values()].map((r) => ({ ...r }));

  const fragment: NetworkEvidenceFragment = {
    network: fingerprint(networkId, opts.chainId),
    subject: opts.subject ?? subject(networkId),
    networkEvidence: {
      ...(opts.omitExecution
        ? {}
        : {
            execution: mergeDimension(
              dimension({
                applicability: "applicable",
                verdict: "supported",
                basis: ["source_observation"],
                evidence: ["ev_receipt_1"],
              }),
              opts.executionDim,
            ),
          }),
      ...(effects.length > 0 ? { observedEffects: [...effects] } : {}),
      ...(opts.settlementDim === undefined
        ? {}
        : { settlement: mergeDimension(dimension({ applicability: "unknown" }), opts.settlementDim) }),
      ...(opts.finalityDim === undefined
        ? {}
        : { finality: mergeDimension(dimension({ applicability: "unknown" }), opts.finalityDim) }),
    },
    evidence: uniqueRefs,
    conflicts: [...(opts.conflicts ?? [])],
    warnings: [...(opts.warnings ?? [])],
  };
  coreValidateFragment(fragment);
  return fragment;
}
