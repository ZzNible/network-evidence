/**
 * Frozen, offline demo inputs for the public Discovery demo.
 *
 * Every candidate context is derived through a PUBLIC resolver BEFORE export:
 *
 *   - base-mainnet   SYNTHETIC demo probe observation (EVM paths + OP Stack
 *                    finality paths). Not live network availability.
 *   - base-sepolia   SYNTHETIC demo probe observation WITHOUT a finality
 *                    observation, so OP Stack finality stays `unknown`.
 *   - solana-mainnet SYNTHETIC demo probe observation (all read paths usable).
 *   - solana-devnet  OFFLINE REPLAY of the checksum-pinned archived devnet
 *                    fixture. Archived replay keeps CURRENT availability
 *                    `unknown`; it proves only what was observed in the past.
 *
 * No clock is read and no network I/O happens: timestamps are explicit
 * constants and evidence digests are sha256 over fixed demo seeds.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { CapabilitySnapshot, EvidenceRef, NetworkFingerprint, ResolverManifest } from "@nec/core";
import type { EvmCapabilityProbeObservation } from "@nec/resolver-evm";
import {
  BASE_MAINNET_OPSTACK_BEFORE_PROFILE,
  BASE_SEPOLIA_OPSTACK_BEFORE_PROFILE,
  deriveOpStackBeforeFoundation,
  OPSTACK_PROBE_PATH_METADATA_KEY,
} from "@nec/resolver-opstack";
import type {
  OpStackBeforeFoundation,
  OpStackBeforeProfile,
  OpStackFinalityProbeObservation,
  OpStackFinalityProbePath,
} from "@nec/resolver-opstack";
import {
  deriveSolanaBeforeFoundation,
  replaySolanaBeforeFoundation,
  SOLANA_DEVNET_BEFORE_PROFILE,
  SOLANA_MAINNET_BEFORE_PROFILE,
  SOLANA_PROBE_PATH_METADATA_KEY,
} from "@nec/resolver-solana";
import type { SolanaBeforeFoundation, SolanaBeforeProfile, SolanaProbePath } from "@nec/resolver-solana";

/** Frozen observation time of the synthetic demo probes (never a clock read). */
export const SYNTHETIC_OBSERVED_AT = "2026-10-08T06:00:00.000Z";

/** Synthetic demo source: clearly not a real RPC endpoint. */
const SYNTHETIC_SOURCE_ID = "src.demo.synthetic";

export const ARCHIVED_SOLANA_DEVNET_FIXTURE_PATH = "packages/resolver-solana/test/fixtures/solana-devnet-before-probe.json";
export const ARCHIVED_SOLANA_DEVNET_FIXTURE_SHA256 = "1b9b278db598b737bad69a675656d28c11f5ebf6ec9d6c2aef16a93df193282a";

/** How a candidate's evidence context was produced (demo presentation). */
export type DemoInputKind = "synthetic-demo-probe" | "archived-replay";

export interface DemoFoundation {
  readonly network: NetworkFingerprint;
  readonly manifest: ResolverManifest;
  readonly snapshot: CapabilitySnapshot;
}

export interface DemoInput<F extends DemoFoundation = DemoFoundation> {
  readonly inputKind: DemoInputKind;
  readonly note: string;
  /** The complete resolver BEFORE foundation (also what preflight consumes). */
  readonly foundation: F;
}

export interface DemoInputs {
  readonly "base-mainnet": DemoInput<OpStackBeforeFoundation>;
  readonly "base-sepolia": DemoInput<OpStackBeforeFoundation>;
  readonly "solana-mainnet": DemoInput<SolanaBeforeFoundation>;
  readonly "solana-devnet": DemoInput<SolanaBeforeFoundation>;
}

function sha256Hex(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function syntheticDigest(seed: string): string {
  return `sha256:${sha256Hex(`nec-discovery-demo-synthetic:${seed}`)}`;
}

function syntheticRef(networkId: string, sourceType: string, prefix: string, path: string, metadataKey: string): EvidenceRef {
  return {
    id: `ev-demo-${prefix}-${path}`,
    sourceId: SYNTHETIC_SOURCE_ID,
    sourceType,
    locator: `synthetic-demo:${networkId}:${prefix}:${path}`,
    retrievedAt: SYNTHETIC_OBSERVED_AT,
    contentDigest: syntheticDigest(`${networkId}:${prefix}:${path}`),
    networkId,
    metadata: { [metadataKey]: path },
  };
}

const EVM_PATHS = ["chainidentity", "receipt", "block", "transaction"] as const;
const OP_FINALITY_PATHS: readonly OpStackFinalityProbePath[] = ["chainidentity", "finalizedhead", "safehead", "latesthead"];
const SOLANA_PATHS: readonly SolanaProbePath[] = ["genesisidentity", "transaction", "signaturestatus", "finalizedblock"];

/** SYNTHETIC OP Stack probe. `withFinality: false` leaves finality `unknown`. */
function syntheticBaseFoundation(profile: OpStackBeforeProfile, withFinality: boolean): OpStackBeforeFoundation {
  const { networkId, chainId } = profile.config;
  const source = { sourceId: SYNTHETIC_SOURCE_ID, sourceType: "evm_rpc" };
  const evmObservation: EvmCapabilityProbeObservation = {
    network: networkId,
    chainId,
    source,
    observedAt: SYNTHETIC_OBSERVED_AT,
    rpcReachable: true,
    chainIdentityObserved: true,
    receiptLookupUsable: true,
    blockLookupUsable: true,
    transactionLookupUsable: true,
    evidence: EVM_PATHS.map((path) => syntheticRef(networkId, "evm_rpc", "evm", path, "probePath")),
  };
  const finalityObservation: OpStackFinalityProbeObservation = {
    network: networkId,
    chainId,
    source,
    observedAt: SYNTHETIC_OBSERVED_AT,
    rpcReachable: true,
    chainIdentityObserved: true,
    finalizedHeadLookupUsable: true,
    safeHeadLookupUsable: true,
    latestHeadLookupUsable: true,
    headOrderingCoherent: true,
    evidence: OP_FINALITY_PATHS.map((path) =>
      syntheticRef(networkId, "evm_rpc", "op", path, OPSTACK_PROBE_PATH_METADATA_KEY),
    ),
  };
  return deriveOpStackBeforeFoundation({
    config: profile.config,
    observationKind: "probe",
    evmObservation,
    ...(withFinality ? { finalityObservation } : {}),
  });
}

/** SYNTHETIC Solana probe with every post-action read path usable. */
function syntheticSolanaFoundation(profile: SolanaBeforeProfile): SolanaBeforeFoundation {
  const { networkId, genesisHash } = profile.config;
  return deriveSolanaBeforeFoundation({
    config: profile.config,
    observationKind: "probe",
    observation: {
      network: networkId,
      source: { sourceId: SYNTHETIC_SOURCE_ID, sourceType: "svm_rpc" },
      observedAt: SYNTHETIC_OBSERVED_AT,
      genesisHash,
      rpcReachable: true,
      paths: { genesisidentity: "usable", transaction: "usable", signaturestatus: "usable", finalizedblock: "usable" },
      finalizedCommitmentObserved: true,
      lookupsCoherent: true,
      evidence: SOLANA_PATHS.map((path) => syntheticRef(networkId, "svm_rpc", "sol", path, SOLANA_PROBE_PATH_METADATA_KEY)),
    },
  });
}

async function readPinnedFixture(repoRelativePath: string, expectedSha256: string): Promise<unknown> {
  const bytes = await readFile(new URL(`../../${repoRelativePath}`, import.meta.url));
  const actual = sha256Hex(bytes);
  if (actual !== expectedSha256) {
    throw new Error(`${repoRelativePath}: sha256 ${actual} does not match pinned ${expectedSha256}`);
  }
  return JSON.parse(bytes.toString("utf8")) as unknown;
}

/** Build the four frozen candidate evidence contexts. Offline and deterministic. */
export async function loadDemoInputs(): Promise<DemoInputs> {
  const solanaDevnet = await replaySolanaBeforeFoundation({
    config: SOLANA_DEVNET_BEFORE_PROFILE.config,
    fixture: await readPinnedFixture(ARCHIVED_SOLANA_DEVNET_FIXTURE_PATH, ARCHIVED_SOLANA_DEVNET_FIXTURE_SHA256),
  });
  return {
    "base-mainnet": {
      inputKind: "synthetic-demo-probe",
      note: "synthetic demo probe input (EVM + OP Stack finality paths); not live availability",
      foundation: syntheticBaseFoundation(BASE_MAINNET_OPSTACK_BEFORE_PROFILE, true),
    },
    "base-sepolia": {
      inputKind: "synthetic-demo-probe",
      note: "synthetic demo probe input without a finality observation; not live availability",
      foundation: syntheticBaseFoundation(BASE_SEPOLIA_OPSTACK_BEFORE_PROFILE, false),
    },
    "solana-mainnet": {
      inputKind: "synthetic-demo-probe",
      note: "synthetic demo probe input (all post-action read paths); not live availability",
      foundation: syntheticSolanaFoundation(SOLANA_MAINNET_BEFORE_PROFILE),
    },
    "solana-devnet": {
      inputKind: "archived-replay",
      note: `offline replay of ${ARCHIVED_SOLANA_DEVNET_FIXTURE_PATH}; current availability unknown`,
      foundation: solanaDevnet,
    },
  };
}
