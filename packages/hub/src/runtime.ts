import {
  decodeNecWireJson,
  deepFreeze,
  encodeNecWireJson,
  validateNetworkEvidenceResult,
} from "@nec/core";
import type { NetworkEvidenceResult } from "@nec/core";

import {
  HUB_ACCEPTED_WIRE_PROFILE,
  HUB_RECORD_SCHEMA_VERSION,
  type HubNetworkEvidenceInputV01,
  type HubNetworkEvidenceRecordV01,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function ownData(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor || !("value" in descriptor)) {
    throw new TypeError(`@nec/hub: ${key} must be an own data property`);
  }
  return descriptor.value;
}

function assertExactKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  const actual = Reflect.ownKeys(record);
  if (actual.some((key) => typeof key !== "string") || actual.length !== allowed.length) {
    throw new TypeError("@nec/hub: input has unsupported fields");
  }
  for (const key of actual as string[]) {
    if (!allowed.includes(key)) throw new TypeError(`@nec/hub: unsupported input field ${key}`);
  }
}

function detachedValidatedCopy(result: NetworkEvidenceResult): NetworkEvidenceResult {
  const wire = encodeNecWireJson("network-evidence-result", result);
  return decodeNecWireJson("network-evidence-result", wire);
}

/**
 * Admit one public Core NetworkEvidenceResult into the minimal Hub record.
 * Validation/decoding authority remains entirely in @nec/core.
 */
export function normalizeNetworkEvidenceV01(
  input: HubNetworkEvidenceInputV01,
): HubNetworkEvidenceRecordV01 {
  if (!isRecord(input)) throw new TypeError("@nec/hub: input must be a plain object");

  const kind = ownData(input, "kind");
  let result: NetworkEvidenceResult;
  let validation: HubNetworkEvidenceRecordV01["validation"];

  if (kind === "network_evidence_result") {
    assertExactKeys(input, ["kind", "result"]);
    const candidate = ownData(input, "result");
    validateNetworkEvidenceResult(candidate);
    // Round-trip only after Core validation so the Hub owns a detached copy;
    // callers cannot mutate the admitted evidence after validation.
    result = detachedValidatedCopy(candidate as NetworkEvidenceResult);
    validation = {
      validator: "@nec/core",
      method: "validateNetworkEvidenceResult",
      wireProfile: null,
    };
  } else if (kind === "nec_wire_json_v1") {
    assertExactKeys(input, ["kind", "wireType", "wire"]);
    if (ownData(input, "wireType") !== "network-evidence-result") {
      throw new TypeError("@nec/hub: wireType must be network-evidence-result");
    }
    const wire = ownData(input, "wire");
    if (typeof wire !== "string") throw new TypeError("@nec/hub: wire must be a string");
    result = decodeNecWireJson("network-evidence-result", wire);
    validation = {
      validator: "@nec/core",
      method: "decodeNecWireJson",
      wireProfile: HUB_ACCEPTED_WIRE_PROFILE,
    };
  } else {
    throw new TypeError("@nec/hub: unsupported input kind");
  }

  // Core validation is repeated over the owned value so both admission paths
  // end at the exact same invariant boundary before Hub wrapping.
  validateNetworkEvidenceResult(result);

  return deepFreeze({
    schemaVersion: HUB_RECORD_SCHEMA_VERSION,
    sourceType: "network_evidence_result",
    sourceSchemaVersion: result.schemaVersion,
    validation,
    result,
  }) as HubNetworkEvidenceRecordV01;
}
