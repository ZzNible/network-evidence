/**
 * Deterministic artifact world for adapter tests: builds REAL frozen-core
 * `NetworkEvidenceResult` artifacts (digests computed, contextual coherence
 * verified) carrying generic EVM log-shaped observed effects.
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
  EvidenceRequest,
  NetworkEvidenceFragment,
  NetworkEvidenceResult,
  NetworkFingerprint,
  ObservedEffect,
  PolicyDimension,
  ResolverManifest,
  SubjectRef,
  Warning,
} from "@nec/core";

// ---------------------------------------------------------------------------
// Canonical sample world (Base-shaped, deterministic)
// ---------------------------------------------------------------------------

export const T0 = "2026-01-01T00:00:00.000Z";
export const T1 = "2026-01-02T12:30:00.000Z";

export const NETWORK_ID = "eip155:8453";
export const CHAIN_ID = 8453;
export const OTHER_NETWORK_ID = "eip155:84532";

export const PAYER = `0x${"aa".repeat(20)}`;
export const RECIPIENT = `0x${"bb".repeat(20)}`;
export const TOKEN = `0x${"cc".repeat(20)}`;
export const OTHER_TOKEN = `0x${"dd".repeat(20)}`;
export const OTHER_SENDER = `0x${"ee".repeat(20)}`;
export const OTHER_RECIPIENT = `0x${"11".repeat(20)}`;

export const TX = `0x${"7a".repeat(32)}`;
export const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const AMOUNT_DEFAULT = "1000000";

export function padTopic(address: string): string {
  return `0x${"00".repeat(12)}${address.slice(2)}`;
}

export function amountWord(amount: string): string {
  return `0x${BigInt(amount).toString(16).padStart(64, "0")}`;
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
    observedAt: { blockNumber: 1000n, blockId: `0x${"ab".repeat(32)}` },
  };
}

export function subject(networkId: string = NETWORK_ID): SubjectRef {
  return { type: "transaction", networkId, txId: TX };
}

function safeDigestSeed(id: string): string {
  // Deterministic 64-hex-char seed derived from the ref id.
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

/** Generic EVM log observation projected into an NEC observed effect. */
export function transferEffect(
  id: string,
  opts: {
    address?: string;
    from?: string;
    to?: string;
    amount?: string;
    removed?: boolean;
    topicsOverride?: string[];
    dataOverride?: string;
    omitRemoved?: boolean;
    transactionHash?: string;
    cite?: string[];
  } = {},
): ObservedEffect {
  const fields: Record<string, unknown> = {
    address: opts.address ?? TOKEN,
    topics:
      opts.topicsOverride ??
      [
        TRANSFER_TOPIC,
        padTopic(opts.from ?? PAYER),
        padTopic(opts.to ?? RECIPIENT),
      ],
    data: opts.dataOverride ?? amountWord(opts.amount ?? AMOUNT_DEFAULT),
    blockNumber: "0x186a0",
    blockHash: `0x${"ab".repeat(32)}`,
    transactionHash: opts.transactionHash ?? TX,
    transactionIndex: "0x0",
    logIndex: "0x1",
    ...(opts.omitRemoved === true ? {} : { removed: opts.removed ?? false }),
  };
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
      address: OTHER_TOKEN,
      topics: [`0x${"99".repeat(32)}`, padTopic(PAYER)],
      data: "0x",
      removed: false,
      logIndex: "0x2",
    },
    basis: ["source_observation"],
    evidence: [`ev_${id}`],
  };
}

export function conflict(overrides: Partial<Conflict> = {}): Conflict {
  return {
    id: "conflict_provider_disagreement",
    code: "OBSERVED_EFFECT_DISAGREEMENT",
    description: "Independent observations disagree about an observed effect.",
    scope: { kind: "observed_effect", effectId: "eff_1" },
    evidence: ["ev_eff_1"],
    material: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Coherent core world (policy / manifest / snapshot / request)
// ---------------------------------------------------------------------------

function fullPolicy(): EvidencePolicy {
  const content = {
    id: "payment-basic",
    version: "1",
    requiredDimensions: ["execution", "observedEffects"] as PolicyDimension[],
    desiredDimensions: ["finality"] as PolicyDimension[],
  };
  return { ...content, digest: computeEvidencePolicyDigest(content) };
}

function fullManifest(): ResolverManifest {
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

/**
 * Merge dimension overrides over defaults; an explicit `undefined` override
 * REMOVES the key (so tests can say "no verdict") instead of leaving an
 * explicitly-undefined own property, which frozen-core rejects.
 */
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

export interface WorldOptions {
  readonly networkId?: string;
  readonly chainId?: number | undefined;
  readonly effects?: readonly ObservedEffect[];
  readonly executionDim?: Partial<EvidenceDimension>;
  readonly settlementDim?: Partial<EvidenceDimension>;
  readonly finalityDim?: Partial<EvidenceDimension>;
  readonly conflicts?: readonly Conflict[];
  readonly extraRefs?: readonly EvidenceRef[];
}

/**
 * Build a REAL validated `NetworkEvidenceResult` through the frozen core
 * builder. Throws if anything is incoherent — tests never fabricate
 * half-valid artifacts by hand (except where a test deliberately does).
 */
export function buildResult(opts: WorldOptions = {}): NetworkEvidenceResult {
  const networkId = opts.networkId ?? NETWORK_ID;
  const fp = fingerprint(networkId, opts.chainId);
  const effects = opts.effects ?? [];

  const policy = fullPolicy();
  const manifest = fullManifest();

  const allRefs = [
    evidenceRef("ev_receipt_1"),
    ...effects.flatMap((effect) => effect.evidence.map(evidenceRef)),
    ...(opts.extraRefs ?? []),
  ];
  const uniqueRefs = [...new Map(allRefs.map((r) => [r.id, r])).values()];

  const snapshot = buildEvidenceSnapshot({
    id: "snap_1",
    createdAt: T0,
    networkFingerprint: fp,
    anchors: [{ networkId, blockNumber: 1000n, timestamp: T0, role: "execution_observation" }],
    evidence: uniqueRefs.map((r) => ({ ...r })),
    resolverManifestDigest: manifest.digest,
    policyDigest: policy.digest,
  });

  const request: EvidenceRequest = {
    schemaVersion: "0.1",
    requestId: "req_x402_proto",
    networkId,
    subject: subject(networkId),
    action: { kind: "erc20.transfer", target: PAYER, value: "0" },
    evidencePolicy: policy,
  };

  const executionDim = mergeDimension(
    dimension({
      applicability: "applicable",
      verdict: "supported",
      basis: ["source_observation"],
      evidence: ["ev_receipt_1"],
    }),
    opts.executionDim,
  );

  return buildNetworkEvidenceResult(
    {
      schemaVersion: "0.1",
      requestId: request.requestId,
      generatedAt: T1,
      network: fp,
      subject: subject(networkId),
      action: request.action,
      policy: { id: policy.id, version: policy.version, digest: policy.digest },
      snapshot: { id: snapshot.id, digest: snapshot.digest },
      networkEvidence: {
        execution: executionDim,
        observedEffects: [...effects],
        dataBinding: dimension({ applicability: "not_applicable" }),
        settlement: mergeDimension(dimension({ applicability: "unknown" }), opts.settlementDim),
        finality: mergeDimension(
          dimension({
            applicability: "unknown",
            reason: "No network-specific finality resolver active.",
          }),
          opts.finalityDim,
        ),
      },
      evidence: uniqueRefs,
      conflicts: [...(opts.conflicts ?? [])],
      warnings: [],
      resolver: { id: manifest.id, version: manifest.version, digest: manifest.digest },
    },
    { policy, snapshot, resolver: manifest, request },
  );
}

// ---------------------------------------------------------------------------
// Fragment world (frozen-core NetworkEvidenceFragment — the PRIMARY v0.1
// assessment input, exactly what NetworkResolver.resolve returns)
// ---------------------------------------------------------------------------

export interface FragmentOptions {
  readonly networkId?: string;
  readonly chainId?: number | undefined;
  /** Defaults to the canonical transaction subject (txId = TX). */
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
 * frozen-core validation if anything is incoherent — tests never fabricate
 * half-valid fragments by hand.
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
      ...(opts.omitExecution ? {} : { execution: mergeDimension(
        dimension({
          applicability: "applicable",
          verdict: "supported",
          basis: ["source_observation"],
          evidence: ["ev_receipt_1"],
        }),
        opts.executionDim,
      ) }),
      ...(effects.length > 0 ? { observedEffects: [...effects] } : {}),
      ...(opts.settlementDim === undefined ? {} : { settlement: mergeDimension(dimension({ applicability: "unknown" }), opts.settlementDim) }),
      ...(opts.finalityDim === undefined ? {} : { finality: mergeDimension(dimension({ applicability: "unknown" }), opts.finalityDim) }),
    },
    evidence: uniqueRefs,
    conflicts: [...(opts.conflicts ?? [])],
    warnings: [...(opts.warnings ?? [])],
  };
  coreValidateFragment(fragment);
  return fragment;
}
