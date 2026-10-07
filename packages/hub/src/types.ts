import type { NetworkEvidenceResult } from "@nec/core";

export const TARGET_CORE_MUTATIONS = 0 as const;
export const HUB_RECORD_SCHEMA_VERSION = "hub-network-evidence-record/v0.1" as const;
export const HUB_ACCEPTED_WIRE_PROFILE = "nec-wire-json-v1" as const;

export interface HubNetworkEvidenceObjectInputV01 {
  kind: "network_evidence_result";
  result: NetworkEvidenceResult;
}

export interface HubNetworkEvidenceWireInputV01 {
  kind: "nec_wire_json_v1";
  wireType: "network-evidence-result";
  wire: string;
}

export type HubNetworkEvidenceInputV01 =
  | HubNetworkEvidenceObjectInputV01
  | HubNetworkEvidenceWireInputV01;

/** Admission path only; never a confidence/trust signal. */
export type HubValidationReceiptV01 =
  | {
      validator: "@nec/core";
      method: "validateNetworkEvidenceResult";
      wireProfile: null;
    }
  | {
      validator: "@nec/core";
      method: "decodeNecWireJson";
      wireProfile: typeof HUB_ACCEPTED_WIRE_PROFILE;
    };

/**
 * Minimal public Hub v0.1 record. `result` is the COMPLETE Core result after
 * Core validation/decoding. Hub v0.1 does not reinterpret, score, correlate,
 * or strengthen it. This exact preservation carries provenance, both digests,
 * verdicts/bases, observed effects, warnings/conflicts, evidence refs,
 * resolver/request/policy/snapshot identity, action and subject.
 */
export interface HubNetworkEvidenceRecordV01 {
  schemaVersion: typeof HUB_RECORD_SCHEMA_VERSION;
  sourceType: "network_evidence_result";
  sourceSchemaVersion: "0.1";
  validation: HubValidationReceiptV01;
  result: NetworkEvidenceResult;
}

/** Contract signature only in LOT 1. The implementation is LOT 2. */
export type NormalizeNetworkEvidenceV01 = (
  input: HubNetworkEvidenceInputV01,
) => HubNetworkEvidenceRecordV01;
