/**
 * The FIXED public profile inventory exposed by `list_network_profiles`.
 *
 * Every entry is built from public resolver exports (profile constants and
 * resolver manifests); nothing here is observed. A resolver manifest says
 * which capabilities the resolver MAY evaluate for the network; it is not
 * current support and not availability. Current support and current
 * availability are therefore always reported as `not_assessed`: assessing them
 * requires a CapabilitySnapshot derived from an observation (or archived
 * replay) by the caller, which this server never acquires.
 *
 * zkSYS is Tanenbaum testnet / historical replay ONLY; there is no zkSYS
 * mainnet profile. Order is fixed inventory order and implies no ranking.
 */

import { CAPABILITY_NAMES, deepFreeze } from "@nec/core";
import type { CapabilityName, ResolverManifest } from "@nec/core";
import {
  BASE_MAINNET_OPSTACK_BEFORE_PROFILE,
  BASE_SEPOLIA_OPSTACK_BEFORE_PROFILE,
  OPSTACK_FINALITY_DOES_NOT_ESTABLISH,
  opStackBeforeResolverManifest,
} from "@nec/resolver-opstack";
import type { OpStackBeforeProfile } from "@nec/resolver-opstack";
import {
  SOLANA_DEVNET_BEFORE_PROFILE,
  SOLANA_FINALITY_DOES_NOT_ESTABLISH,
  SOLANA_MAINNET_BEFORE_PROFILE,
  solanaBeforeResolverManifest,
} from "@nec/resolver-solana";
import type { SolanaBeforeProfile } from "@nec/resolver-solana";
import { ZKSYS_TANENBAUM_CHAIN_ID, ZKSYS_TANENBAUM_NETWORK_ID, zksysBeforeResolverManifest } from "@nec/resolver-zksys";

export const PROFILES_SCHEMA = "ne-mcp-network-profiles/v0.1";

export type ProfileEnvironment = "mainnet" | "testnet";
export type ObservationKind = "probe" | "historical_replay";

export interface ProfileCapability {
  readonly capability: CapabilityName;
  /** True iff the resolver manifest lists the capability. Not evidence of current support. */
  readonly declaredByResolverManifest: boolean;
  readonly currentSupport: "not_assessed";
  readonly currentAvailability: "not_assessed";
}

export interface NetworkProfileEntry {
  readonly profileId: string;
  readonly label: string;
  readonly networkId: string;
  readonly chainId: number | null;
  readonly genesisHash: string | null;
  /** Presentation-only label carried by the public profile; never evidence. */
  readonly environment: ProfileEnvironment;
  readonly family: "opstack" | "solana" | "zksys";
  readonly source: string;
  readonly resolverManifest: {
    readonly id: string;
    readonly version: string;
    readonly digest: string;
    readonly package: string | null;
  };
  /** Observation kinds the public BEFORE derivation for this profile accepts. */
  readonly acceptedObservationKinds: readonly ObservationKind[];
  readonly capabilities: readonly ProfileCapability[];
  readonly currentStatus: "not_assessed";
  readonly doesNotEstablish: readonly string[];
  readonly notes: readonly string[];
}

export interface NetworkProfilesInventory {
  readonly schema: typeof PROFILES_SCHEMA;
  readonly liveObservation: false;
  readonly inventoryOrder: string;
  readonly profiles: readonly NetworkProfileEntry[];
  readonly truthBoundaries: readonly string[];
  readonly howToAssess: string;
}

export const TRUTH_BOUNDARIES: readonly string[] = Object.freeze([
  "BEFORE asks what an exact network/deployment can support and what is currently observable or usable WITH EVIDENCE; AFTER asks what the network itself can independently support about one exact action. This inventory answers neither for 'now': it lists fixed profiles only.",
  "Profile membership is not evidence of current availability. A resolver manifest declaration is not current support. Current support is not current availability.",
  "This server performs no network I/O: no RPC, crawler, watcher, explorer, indexer or live monitoring. Every currentSupport/currentAvailability here is 'not_assessed'.",
  "Archived (historical) replay keeps current availability 'unknown'; it proves only what was observed in the past.",
  "zkSYS eip155:57057 is Tanenbaum testnet with historical replay only. There is no zkSYS mainnet profile.",
  "Finality is not settlement. No settlement, economic-irreversibility or live finality claim is made.",
  "Network Evidence does not score, rank, recommend or choose a network. Inventory order is fixed and implies no preference.",
  "No wallet, signer, funding/gas, transaction submission or policy decision exists in this server.",
]);

const ALL_CAPABILITIES: readonly CapabilityName[] = CAPABILITY_NAMES;

function capabilities(manifest: ResolverManifest): ProfileCapability[] {
  const declared = new Set<string>(manifest.supportedCapabilities);
  return ALL_CAPABILITIES.map((capability) => ({
    capability,
    declaredByResolverManifest: declared.has(capability),
    currentSupport: "not_assessed",
    currentAvailability: "not_assessed",
  }));
}

function manifestRef(manifest: ResolverManifest): NetworkProfileEntry["resolverManifest"] {
  return {
    id: manifest.id,
    version: manifest.version,
    digest: manifest.digest,
    package: manifest.implementation.package ?? null,
  };
}

function stringList(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`profile inventory: ${what} is not a string list`);
  }
  return [...value];
}

function opStackEntry(profile: OpStackBeforeProfile, exportName: string): NetworkProfileEntry {
  const manifest = opStackBeforeResolverManifest();
  return {
    profileId: profile.id,
    label: profile.label,
    networkId: profile.config.networkId,
    chainId: profile.config.chainId,
    genesisHash: null,
    environment: profile.environment,
    family: "opstack",
    source: `${exportName} + opStackBeforeResolverManifest() (@nec/resolver-opstack)`,
    resolverManifest: manifestRef(manifest),
    acceptedObservationKinds: ["probe", "historical_replay"],
    capabilities: capabilities(manifest),
    currentStatus: "not_assessed",
    doesNotEstablish: [...OPSTACK_FINALITY_DOES_NOT_ESTABLISH],
    notes: [
      "OP Stack family is explicitly configured by the profile, never inferred from the chain id.",
      "Finality means OP Stack L2 block finality as reported by the configured source; never withdrawal or output-root finalization.",
    ],
  };
}

function solanaEntry(profile: SolanaBeforeProfile, exportName: string): NetworkProfileEntry {
  const manifest = solanaBeforeResolverManifest();
  return {
    profileId: profile.id,
    label: profile.label,
    networkId: profile.config.networkId,
    chainId: null,
    genesisHash: profile.config.genesisHash,
    environment: profile.environment,
    family: "solana",
    source: `${exportName} + solanaBeforeResolverManifest() (@nec/resolver-solana)`,
    resolverManifest: manifestRef(manifest),
    acceptedObservationKinds: ["probe", "historical_replay"],
    capabilities: capabilities(manifest),
    currentStatus: "not_assessed",
    doesNotEstablish: [...SOLANA_FINALITY_DOES_NOT_ESTABLISH],
    notes: [
      "The network id is bound to the full pinned genesis hash; an observation must match it exactly.",
      "Finality means the source-reported Solana finalized commitment (source_observation basis only).",
    ],
  };
}

function zksysEntry(): NetworkProfileEntry {
  const manifest = zksysBeforeResolverManifest();
  const metadata = manifest.metadata ?? {};
  return {
    profileId: "zksys-tanenbaum",
    label: "zkSYS Tanenbaum testnet (historical replay only)",
    networkId: ZKSYS_TANENBAUM_NETWORK_ID,
    chainId: ZKSYS_TANENBAUM_CHAIN_ID,
    genesisHash: null,
    environment: "testnet",
    family: "zksys",
    source: "ZKSYS_TANENBAUM_NETWORK_ID / ZKSYS_TANENBAUM_CHAIN_ID + zksysBeforeResolverManifest() (@nec/resolver-zksys)",
    resolverManifest: manifestRef(manifest),
    acceptedObservationKinds: ["historical_replay"],
    capabilities: capabilities(manifest),
    currentStatus: "not_assessed",
    doesNotEstablish: stringList(metadata.batchingDoesNotEstablish, "zkSYS batchingDoesNotEstablish"),
    notes: [
      "Tanenbaum testnet / archived replay ONLY. There is no zkSYS mainnet profile.",
      "Every volatile capability derived from archived replay keeps current availability 'unknown'.",
    ],
  };
}

function buildInventory(): NetworkProfilesInventory {
  return {
    schema: PROFILES_SCHEMA,
    liveObservation: false,
    inventoryOrder: "fixed inventory order; implies no ranking or preference",
    profiles: [
      opStackEntry(BASE_MAINNET_OPSTACK_BEFORE_PROFILE, "BASE_MAINNET_OPSTACK_BEFORE_PROFILE"),
      opStackEntry(BASE_SEPOLIA_OPSTACK_BEFORE_PROFILE, "BASE_SEPOLIA_OPSTACK_BEFORE_PROFILE"),
      solanaEntry(SOLANA_MAINNET_BEFORE_PROFILE, "SOLANA_MAINNET_BEFORE_PROFILE"),
      solanaEntry(SOLANA_DEVNET_BEFORE_PROFILE, "SOLANA_DEVNET_BEFORE_PROFILE"),
      zksysEntry(),
    ],
    truthBoundaries: TRUTH_BOUNDARIES,
    howToAssess:
      "Derive a complete network/manifest/CapabilitySnapshot with the profile's public resolver BEFORE export (e.g. deriveOpStackBeforeFoundation, deriveSolanaBeforeFoundation, replaySolanaBeforeFoundation, deriveZksysBeforeFoundation) from an observation you acquired yourself or an archived replay, then pass it to discover_network_candidates. This server never acquires observations.",
  };
}

let inventoryCache: NetworkProfilesInventory | undefined;

/** The frozen fixed inventory (built once from public resolver exports). */
export function networkProfilesInventory(): NetworkProfilesInventory {
  if (inventoryCache === undefined) inventoryCache = deepFreeze(buildInventory());
  return inventoryCache;
}

/** Four active live profiles only. Historical Tanenbaum is excluded from
 * the opt-in multichain mode; the original demo inventory remains untouched. */
export function activeNetworkProfilesInventory(): NetworkProfilesInventory {
  const base = networkProfilesInventory();
  return deepFreeze({
    ...base,
    profiles: base.profiles.filter(p => p.family !== "zksys"),
    truthBoundaries: [
      "Inventory declarations do not establish live network support or availability.",
      "Only the separate opt-in exact-action tool reads selected RPC sources; it does not prove source independence or network consensus.",
      "Source-reported OP Stack finality differs from withdrawal finalization; Solana finalized commitment is source observation, not cryptographic verification.",
      "Missing or pruned evidence is insufficient; it does not establish nonexistence.",
      "Tanenbaum historical replay remains in the source suite, never as an active live MCP network.",
      "No wallet, signing, funding, submission, policy or network ranking/choice.",
    ],
    howToAssess: "The opt-in resolve_transaction_evidence tool reads exact actions. BEFORE Discovery requires fresh, independently acquired complete CapabilitySnapshots; this inventory alone does not establish availability.",
  });
}

/** networkId -> presentation environment of the fixed inventory (MCP presentation guard only). */
export function fixedProfileEnvironments(): ReadonlyMap<string, ProfileEnvironment> {
  return new Map(networkProfilesInventory().profiles.map((profile) => [profile.networkId, profile.environment]));
}
