import { beforeAll, describe, expect, it } from "vitest";

import { decodeNecWireJson, encodeNecWireJson, verifyDiscoverNetworksResult } from "@nec/core";
import { discoverNetworks, NecDiscoveryError } from "@nec/discovery";

import { MAX_DISCOVERY_CANDIDATES, runDiscoverNetworkCandidates } from "../src/discover.js";
import type { DiscoverToolInput } from "../src/discover.js";
import { NeMcpError, toSafeToolError } from "../src/errors.js";
import { clone, collectKeys, FORBIDDEN_KEY_WORD, loadWireDemo } from "./helpers.js";
import type { WireDemo } from "./helpers.js";

let demo: WireDemo;

beforeAll(async () => {
  demo = await loadWireDemo();
});

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error instanceof NeMcpError || error instanceof NecDiscoveryError).toBe(true);
    return (error as NeMcpError | NecDiscoveryError).code;
  }
  throw new Error("expected a fail-closed rejection");
}

function mutate(edit: (input: DiscoverToolInput & { candidates: any[] }) => void): DiscoverToolInput {
  const input = clone(demo.wire) as DiscoverToolInput & { candidates: any[] };
  edit(input);
  return input;
}

const candidate = (input: { candidates: any[] }, id: string) => input.candidates.find((c) => c.id === id)!;

describe("discover_network_candidates — real Core Discovery", () => {
  it("returns exactly the Core result @nec/discovery builds for the same contexts", () => {
    const out = runDiscoverNetworkCandidates(demo.wire);
    const direct = discoverNetworks(demo.input);
    expect(JSON.stringify(out.coreResult)).toBe(encodeNecWireJson("discovery-result", direct.result));
    expect(out.coreVerification.resultArtifactDigest).toBe(direct.result.artifactDigest);
    expect(out.scope).toEqual(direct.scope);
    // The wire result decodes through Core and re-verifies against the Core context.
    const decoded = decodeNecWireJson("discovery-result", JSON.stringify(out.coreResult));
    expect(verifyDiscoverNetworksResult(decoded, direct.verificationContext)).toBe(true);
  });

  it("copies Core classifications verbatim (presentation-id order, no choice)", () => {
    const out = runDiscoverNetworkCandidates(demo.wire);
    expect(out.candidates.map((c) => [c.id, c.classification])).toEqual([
      ["base-mainnet", "eligible"],
      ["base-sepolia", "conditional"],
      ["solana-devnet", "ineligible"],
      ["solana-mainnet", "eligible"],
    ]);
    const matches = out.coreResult.matches as { classification: string }[];
    expect(out.candidates.map((c) => c.classification)).toEqual(matches.map((m) => m.classification));
    expect(out.networkChoice).toMatch(/does not choose/);
    for (const key of collectKeys(out)) expect(key).not.toMatch(FORBIDDEN_KEY_WORD);
  });

  it("surfaces how each supplied snapshot was produced, never as live data", () => {
    const out = runDiscoverNetworkCandidates(demo.wire);
    expect(out.liveObservation).toBe(false);
    const devnet = out.candidates.find((c) => c.id === "solana-devnet")!;
    expect(devnet.suppliedSnapshot.declaredObservationKind).toBe("historical_replay");
    const synthetic = out.candidates.find((c) => c.id === "base-mainnet")!;
    expect(synthetic.suppliedSnapshot.evidenceSourceIds).toEqual(["src.demo.synthetic"]);
    expect(synthetic.suppliedSnapshot.declaredObservationKind).toBe("probe");
    const text = out.qualification.join("\n");
    expect(text).toMatch(/depends ONLY on the network\/manifest\/CapabilitySnapshot contexts supplied/);
    expect(text).toMatch(/not current \(live\) availability/);
    expect(text).toMatch(/Archived replay keeps current availability 'unknown'/);
    expect(out.verificationContextRefs.capabilitySnapshots.map((s) => s.id)).toEqual(
      out.candidates.map((c) => c.suppliedSnapshot.id),
    );
  });

  it("is invariant under candidate permutation", () => {
    const reversed = { ...demo.wire, candidates: [...demo.wire.candidates].reverse() };
    expect(JSON.stringify(runDiscoverNetworkCandidates(reversed))).toBe(JSON.stringify(runDiscoverNetworkCandidates(demo.wire)));
  });

  it("applies presentation scope without changing classifications", () => {
    const scoped = runDiscoverNetworkCandidates({ ...demo.wire, scope: { environments: ["testnet"] } });
    expect(scoped.candidates.map((c) => [c.id, c.classification])).toEqual([
      ["base-sepolia", "conditional"],
      ["solana-devnet", "ineligible"],
    ]);
    expect(scoped.scope.outOfScopeCandidateIds).toEqual(["base-mainnet", "solana-mainnet"]);
  });
});

describe("discover_network_candidates — fail-closed rejections", () => {
  it("rejects a snapshot whose artifactDigest does not bind its content", () => {
    const input = mutate((i) => {
      candidate(i, "base-mainnet").snapshot.artifactDigest = `sha256:${"0".repeat(64)}`;
    });
    expect(codeOf(() => runDiscoverNetworkCandidates(input))).toBe("MCP_WIRE_DECODE_FAILED");
    let caught: unknown;
    try {
      runDiscoverNetworkCandidates(input);
    } catch (error) {
      caught = error;
    }
    expect(toSafeToolError(caught).cause?.message).toMatch(/self-digest mismatch/);
  });

  it("rejects a network that is not the snapshot's exact fingerprint", () => {
    const input = mutate((i) => {
      candidate(i, "base-mainnet").network.chainId = 1;
    });
    expect(codeOf(() => runDiscoverNetworkCandidates(input))).toBe("MCP_CANDIDATE_NETWORK_MISMATCH");
  });

  it("rejects a manifest that is not the snapshot's resolver (Core binding gate)", () => {
    const input = mutate((i) => {
      candidate(i, "base-mainnet").manifest = clone(candidate(i, "solana-mainnet").manifest);
    });
    expect(codeOf(() => runDiscoverNetworkCandidates(input))).toBe("DISCOVERY_CANDIDATE_BINDING_INVALID");
  });

  it("rejects a JSON-number blockNumber (wire profile requires decimal strings)", () => {
    const input = mutate((i) => {
      const evidence = candidate(i, "solana-devnet").snapshot.evidence[0];
      evidence.blockNumber = Number(evidence.blockNumber);
    });
    expect(codeOf(() => runDiscoverNetworkCandidates(input))).toBe("MCP_WIRE_DECODE_FAILED");
  });

  it("rejects unknown fields inside Core artifacts", () => {
    const input = mutate((i) => {
      candidate(i, "base-sepolia").snapshot.liveStatus = "available";
    });
    expect(codeOf(() => runDiscoverNetworkCandidates(input))).toBe("MCP_WIRE_DECODE_FAILED");
  });

  it("rejects an unknown capability in the requirements (Core vocabulary)", () => {
    const input = mutate((i) => {
      (i.requirements as any).requirements.push({ capability: "liveness", strength: "required" });
    });
    expect(codeOf(() => runDiscoverNetworkCandidates(input))).toBe("MCP_WIRE_DECODE_FAILED");
  });

  it("rejects duplicate candidate ids and duplicate networks", () => {
    const dupId = mutate((i) => {
      candidate(i, "base-sepolia").id = "base-mainnet";
    });
    expect(codeOf(() => runDiscoverNetworkCandidates(dupId))).toBe("DISCOVERY_CANDIDATE_ID_DUPLICATE");
    const dupNetwork = mutate((i) => {
      i.candidates.push({ ...clone(candidate(i, "base-mainnet")), id: "base-mainnet-again" });
    });
    expect(codeOf(() => runDiscoverNetworkCandidates(dupNetwork))).toBe("DISCOVERY_NETWORK_DUPLICATE");
  });

  it("rejects an environment label that contradicts the fixed profile inventory", () => {
    const input = mutate((i) => {
      candidate(i, "base-sepolia").environment = "mainnet";
    });
    expect(codeOf(() => runDiscoverNetworkCandidates(input))).toBe("MCP_ENVIRONMENT_LABEL_CONFLICT");
  });

  it("rejects scope naming an unknown candidate and an invalid requestId/generatedAt", () => {
    expect(codeOf(() => runDiscoverNetworkCandidates({ ...demo.wire, scope: { candidateIds: ["base"] } }))).toBe(
      "DISCOVERY_SCOPE_UNKNOWN_CANDIDATE",
    );
    expect(codeOf(() => runDiscoverNetworkCandidates({ ...demo.wire, requestId: "has space" }))).toBe("DISCOVERY_INPUT_INVALID");
    expect(codeOf(() => runDiscoverNetworkCandidates({ ...demo.wire, generatedAt: "2026-10-08" }))).toBe("DISCOVERY_INPUT_INVALID");
  });

  it(`rejects more than ${MAX_DISCOVERY_CANDIDATES} candidates`, () => {
    const many = { ...demo.wire, candidates: Array.from({ length: MAX_DISCOVERY_CANDIDATES + 1 }, () => demo.wire.candidates[0]!) };
    expect(codeOf(() => runDiscoverNetworkCandidates(many))).toBe("MCP_INPUT_INVALID");
  });

  it("serializes errors with code, bounded message and Core cause, never a stack", () => {
    let caught: unknown;
    try {
      runDiscoverNetworkCandidates(
        mutate((i) => {
          candidate(i, "base-mainnet").manifest = clone(candidate(i, "solana-mainnet").manifest);
        }),
      );
    } catch (error) {
      caught = error;
    }
    const safe = toSafeToolError(caught);
    expect(safe.code).toBe("DISCOVERY_CANDIDATE_BINDING_INVALID");
    expect(safe.cause?.name).toBe("NecValidationError");
    expect(JSON.stringify(safe)).not.toMatch(/\n\s+at |node_modules|\/home\//);
    expect(toSafeToolError(new TypeError("secret /etc/passwd"))).toEqual({
      code: "MCP_INTERNAL_ERROR",
      message: "internal error (details withheld)",
      cause: null,
    });
  });
});
