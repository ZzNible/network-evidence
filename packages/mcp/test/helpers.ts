/**
 * Test-only helpers. Candidate contexts come from the public, offline,
 * deterministic Discovery demo inputs (SYNTHETIC demo probes + one ARCHIVED
 * replay); they are encoded to nec-wire-json-v1 exactly as an external caller
 * would send them. Nothing here is live data.
 */

import { encodeNecWireJson } from "@nec/core";
import type { DiscoverNetworksInput } from "@nec/discovery";

import { loadDemoInputs } from "../../../examples/discovery/inputs.js";
import { buildDiscoveryInput } from "../../../examples/discovery/run.js";
import type { DiscoverToolInput } from "../src/discover.js";

export interface WireDemo {
  /** The runtime @nec/discovery input the demo itself uses. */
  readonly input: DiscoverNetworksInput;
  /** The same request as an MCP caller sends it (JSON, nec-wire-json-v1). */
  readonly wire: DiscoverToolInput;
}

export function wireJson(type: Parameters<typeof encodeNecWireJson>[0], value: unknown): Record<string, unknown> {
  return JSON.parse(encodeNecWireJson(type, value)) as Record<string, unknown>;
}

export async function loadWireDemo(): Promise<WireDemo> {
  const input = buildDiscoveryInput(await loadDemoInputs());
  const wire: DiscoverToolInput = {
    requestId: input.requestId,
    generatedAt: input.generatedAt,
    requirements: wireJson("discovery-requirements", input.requirements),
    candidates: input.candidates.map((candidate) => {
      const snapshot = wireJson("capability-snapshot", candidate.snapshot);
      return {
        id: candidate.id,
        environment: candidate.environment,
        network: structuredClone(snapshot.network) as Record<string, unknown>,
        manifest: wireJson("resolver-manifest", candidate.manifest),
        snapshot,
      };
    }),
    ...(input.scope === undefined ? {} : { scope: structuredClone(input.scope) as DiscoverToolInput["scope"] }),
  };
  return { input, wire };
}

/** Deep JSON clone for mutation in negative tests. */
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Keys that would carry choice semantics; must never appear in MCP output. */
export const FORBIDDEN_KEY_WORD = /^(rank\w*|scor\w*|best|recommend\w*|weight\w*|priorit\w*|prefer\w*|top|better|confidence|trustScore)$/i;

export function collectKeys(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, out);
  } else if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      out.add(key);
      collectKeys(item, out);
    }
  }
  return out;
}
