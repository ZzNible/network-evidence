import type { LensBrowserSafeCaseV01 } from "@nec/lens";

export const TARGET_CORE_MUTATIONS = 0 as const;
export const NE_MAPS_CASE_SCHEMA_VERSION = "ne-maps-case/v0.1" as const;
export const NE_MAPS_COLLECTION_SCHEMA_VERSION = "ne-maps-case-collection/v0.1" as const;

export interface NeMapsDisplayV01 {
  networkLabel: string;
  title: string;
  shape: string;
}

export interface NeMapsExactActionV01 {
  networkId: string;
  id: string;
  kind?: string;
  /** Existing F2 exact-action context remains presentation metadata. */
  bundleTransactionHash?: string;
  sender?: string;
  [name: string]: unknown;
}

export interface NeMapsReviewedSelectorOutcomeV01 {
  label: string;
  verdict: "supported" | "contradicted" | "insufficient" | "ambiguous";
}

/** Minimal public Maps input envelope. Maps never strengthens Lens semantics. */
export interface NeMapsCaseEnvelopeV01 {
  schemaVersion: typeof NE_MAPS_CASE_SCHEMA_VERSION;
  id: string;
  display: NeMapsDisplayV01;
  exactAction: NeMapsExactActionV01;
  trailPropositionOrder: readonly string[];
  lens: LensBrowserSafeCaseV01;
  /** Compatibility/presentation-only extensions; none are required by the generic path. */
  extensions?: {
    trailContextNote?: string;
    reviewedSelectorOutcomes?: readonly NeMapsReviewedSelectorOutcomeV01[];
    [name: string]: unknown;
  };
}

export interface NeMapsSourceAuthorityV01 {
  repository: string;
  branch?: string;
  commit: string;
  export?: string;
}

export interface NeMapsPublicSuiteRefV01 {
  repository: string;
  commit: string;
}

export interface NeMapsCaseCollectionV01 {
  schemaVersion: typeof NE_MAPS_COLLECTION_SCHEMA_VERSION;
  TARGET_CORE_MUTATIONS: 0;
  sourceAuthority?: NeMapsSourceAuthorityV01;
  publicSuite?: NeMapsPublicSuiteRefV01;
  nonClaims: readonly string[];
  cases: readonly NeMapsCaseEnvelopeV01[];
}
