/**
 * @nec/discovery orchestrator tests.
 *
 * Cross-family proof over the CURRENT public BEFORE artifacts: Base mainnet /
 * Base Sepolia (OP Stack overlay) and Solana mainnet / devnet, mixing
 * mainnet and testnet in one request. Inputs are synthetic frozen probe
 * observations or offline replays of pinned archived fixtures (current
 * availability stays UNKNOWN). Network access is forbidden for the whole
 * file.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  buildCapabilitySnapshot,
  canonicalJson,
  composeDiscoveryMatch,
  computeCapabilitySnapshotDigest,
  computeResolverManifestDigest,
  NecValidationError,
  verifyDiscoverNetworksResult,
} from "@nec/core";
import type {
  CapabilitySnapshot,
  CapabilitySnapshotContent,
  DiscoveryRequirements,
  EvidenceRef,
  ResolverManifest,
} from "@nec/core";
import type { EvmCapabilityProbeObservation } from "@nec/resolver-evm";
import {
  BASE_MAINNET_OPSTACK_BEFORE_PROFILE,
  BASE_SEPOLIA_OPSTACK_BEFORE_PROFILE,
  deriveOpStackBeforeFoundation,
  OPSTACK_PROBE_PATH_METADATA_KEY,
  replayOpStackBeforeFoundation,
} from "@nec/resolver-opstack";
import type { OpStackBeforeProfile, OpStackFinalityProbeObservation, OpStackFinalityProbePath } from "@nec/resolver-opstack";
import {
  deriveSolanaBeforeFoundation,
  replaySolanaBeforeFoundation,
  SOLANA_DEVNET_BEFORE_PROFILE,
  SOLANA_MAINNET_BEFORE_PROFILE,
  SOLANA_PROBE_PATH_METADATA_KEY,
} from "@nec/resolver-solana";
import type { SolanaBeforeProfile, SolanaProbePath } from "@nec/resolver-solana";

import * as discovery from "../src/index.js";
import { DISCOVERY_ENVIRONMENTS, discoverNetworks, NecDiscoveryError } from "../src/index.js";
import type {
  DiscoverNetworksInput,
  DiscoverNetworksOutcome,
  DiscoveryCandidateContext,
  DiscoveryEnvironment,
  NecDiscoveryErrorCode,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Frozen synthetic probe world + pinned archived fixtures (no network)
// ---------------------------------------------------------------------------

const T0 = "2026-10-08T06:00:00.000Z";
const GENERATED_AT = "2026-10-08T09:00:00.000Z";

function digest(seed: string): string {
  return `sha256:${createHash("sha256").update(seed).digest("hex")}`;
}

function readPinned(relative: string, sha256: string): unknown {
  const bytes = readFileSync(fileURLToPath(new URL(relative, import.meta.url)));
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(sha256);
  return JSON.parse(bytes.toString("utf8")) as unknown;
}

const EVM_PATHS = ["chainidentity", "receipt", "block", "transaction"] as const;
const OP_PATHS: readonly OpStackFinalityProbePath[] = ["chainidentity", "finalizedhead", "safehead", "latesthead"];
const SOL_PATHS: readonly SolanaProbePath[] = ["genesisidentity", "transaction", "signaturestatus", "finalizedblock"];

function evmRef(profile: OpStackBeforeProfile, path: string, prefix: string, key: string): EvidenceRef {
  return {
    id: `ev-${prefix}-${path}`,
    sourceId: "src.probe.primary",
    sourceType: "evm_rpc",
    locator: `probe:${prefix}:${path}`,
    retrievedAt: T0,
    contentDigest: digest(`${profile.id}:${prefix}:${path}`),
    networkId: profile.config.networkId,
    metadata: { [key]: path },
  };
}

/** Synthetic OP Stack probe; `withFinality: false` leaves finality UNKNOWN. */
function baseProbe(profile: OpStackBeforeProfile, withFinality: boolean) {
  const evmObservation: EvmCapabilityProbeObservation = {
    network: profile.config.networkId,
    chainId: profile.config.chainId,
    source: { sourceId: "src.probe.primary", sourceType: "evm_rpc" },
    observedAt: T0,
    rpcReachable: true,
    chainIdentityObserved: true,
    receiptLookupUsable: true,
    blockLookupUsable: true,
    transactionLookupUsable: true,
    evidence: EVM_PATHS.map((path) => evmRef(profile, path, "evm", "probePath")),
  };
  const finalityObservation: OpStackFinalityProbeObservation = {
    network: profile.config.networkId,
    chainId: profile.config.chainId,
    source: { sourceId: "src.probe.primary", sourceType: "evm_rpc" },
    observedAt: T0,
    rpcReachable: true,
    chainIdentityObserved: true,
    finalizedHeadLookupUsable: true,
    safeHeadLookupUsable: true,
    latestHeadLookupUsable: true,
    headOrderingCoherent: true,
    evidence: OP_PATHS.map((path) => evmRef(profile, path, "op", OPSTACK_PROBE_PATH_METADATA_KEY)),
  };
  return deriveOpStackBeforeFoundation({
    config: profile.config,
    observationKind: "probe",
    evmObservation,
    ...(withFinality ? { finalityObservation } : {}),
  });
}

function solanaProbe(profile: SolanaBeforeProfile) {
  return deriveSolanaBeforeFoundation({
    config: profile.config,
    observationKind: "probe",
    observation: {
      network: profile.config.networkId,
      source: { sourceId: "src.probe.primary", sourceType: "svm_rpc" },
      observedAt: T0,
      genesisHash: profile.config.genesisHash,
      rpcReachable: true,
      paths: { genesisidentity: "usable", transaction: "usable", signaturestatus: "usable", finalizedblock: "usable" },
      finalizedCommitmentObserved: true,
      lookupsCoherent: true,
      evidence: SOL_PATHS.map((path) => ({
        id: `ev-sol-${path}`,
        sourceId: "src.probe.primary",
        sourceType: "svm_rpc",
        locator: `probe:${path}`,
        retrievedAt: T0,
        contentDigest: digest(`${profile.config.networkId}:${path}`),
        networkId: profile.config.networkId,
        metadata: { [SOLANA_PROBE_PATH_METADATA_KEY]: path },
      })),
    },
  });
}

interface Foundation {
  readonly network: DiscoveryCandidateContext["network"];
  readonly manifest: ResolverManifest;
  readonly snapshot: CapabilitySnapshot;
}

function ctx(id: string, environment: DiscoveryEnvironment, f: Foundation): DiscoveryCandidateContext {
  return { id, environment, network: f.network, manifest: f.manifest, snapshot: f.snapshot };
}

let baseMainnet: Foundation; // probe, everything usable incl. finality
let baseSepolia: Foundation; // probe, finality UNKNOWN (no finality observation)
let solanaMainnet: Foundation; // probe, everything usable
let solanaDevnet: Foundation; // archived replay -> every capability currently UNKNOWN
let baseMainnetReplay: Foundation; // archived replay -> every capability currently UNKNOWN
let solanaMainnetReplay: Foundation; // archived replay -> every capability currently UNKNOWN

const originalFetch = globalThis.fetch;

beforeAll(async () => {
  globalThis.fetch = vi.fn(() => {
    throw new Error("network access is forbidden in discovery tests");
  }) as unknown as typeof fetch;
  baseMainnet = baseProbe(BASE_MAINNET_OPSTACK_BEFORE_PROFILE, true);
  baseSepolia = baseProbe(BASE_SEPOLIA_OPSTACK_BEFORE_PROFILE, false);
  solanaMainnet = solanaProbe(SOLANA_MAINNET_BEFORE_PROFILE);
  solanaDevnet = await replaySolanaBeforeFoundation({
    config: SOLANA_DEVNET_BEFORE_PROFILE.config,
    fixture: readPinned(
      "../../resolver-solana/test/fixtures/solana-devnet-before-probe.json",
      "1b9b278db598b737bad69a675656d28c11f5ebf6ec9d6c2aef16a93df193282a",
    ),
  });
  solanaMainnetReplay = await replaySolanaBeforeFoundation({
    config: SOLANA_MAINNET_BEFORE_PROFILE.config,
    fixture: readPinned(
      "../../resolver-solana/test/fixtures/solana-mainnet-x402-real.json",
      "62b5191f62b61e9514f4be785d480828c496c199ef88ca763db51caf667d720a",
    ),
  });
  baseMainnetReplay = await replayOpStackBeforeFoundation({
    config: BASE_MAINNET_OPSTACK_BEFORE_PROFILE.config,
    evmFixture: readPinned(
      "../../resolver-opstack/test/fixtures/base-mainnet-usdc-transfer.fixture.json",
      "e82b76bd7b195f0f0aff54362be26691774cee7e3633dd395bb5c32e80854279",
    ),
    finalityFixture: readPinned(
      "../../resolver-opstack/test/fixtures/base-mainnet-finality.fixture.json",
      "d3973e836e37e7f1255b59b26dc932155ed966edbd6476d6c3397a07c53b2388",
    ),
  });
});

afterAll(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  globalThis.fetch = originalFetch;
});

/** Mixed mainnet + testnet, Base + Solana. Environment labels are explicit. */
function crossFamily(): DiscoveryCandidateContext[] {
  return [
    ctx("base-mainnet", "mainnet", baseMainnet),
    ctx("base-sepolia", "testnet", baseSepolia),
    ctx("solana-mainnet", "mainnet", solanaMainnet),
    ctx("solana-devnet", "testnet", solanaDevnet),
  ];
}

const EXEC_REQUIRED_FINALITY_DESIRED: DiscoveryRequirements = {
  requirements: [
    { capability: "execution", strength: "required" },
    { capability: "finality", strength: "desired" },
  ],
};

function input(overrides: Partial<DiscoverNetworksInput> = {}): DiscoverNetworksInput {
  return {
    requestId: "disc-cross-family",
    generatedAt: GENERATED_AT,
    requirements: EXEC_REQUIRED_FINALITY_DESIRED,
    candidates: crossFamily(),
    ...overrides,
  };
}

function expectCode(fn: () => unknown, code: NecDiscoveryErrorCode): NecDiscoveryError {
  let error: unknown;
  try {
    fn();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(NecDiscoveryError);
  expect((error as NecDiscoveryError).code).toBe(code);
  return error as NecDiscoveryError;
}

function classes(outcome: DiscoverNetworksOutcome): Record<string, string> {
  return Object.fromEntries(outcome.candidates.map((c) => [c.id, c.match.classification]));
}

/** Order-preserving serialization (key AND array order); BigInt-aware. */
function bytes(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => (typeof entry === "bigint" ? `${entry}n` : entry));
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
  );
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

describe("public surface", () => {
  it("exports only the orchestrator, its error and the closed environment vocabulary", () => {
    expect(Object.keys(discovery).sort()).toEqual(["DISCOVERY_ENVIRONMENTS", "NecDiscoveryError", "discoverNetworks"]);
    expect(DISCOVERY_ENVIRONMENTS).toEqual(["mainnet", "testnet"]);
    expect(Object.isFrozen(DISCOVERY_ENVIRONMENTS)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cross-family Core delegation
// ---------------------------------------------------------------------------

describe("cross-family discovery (Base OP Stack + Solana, mainnet + testnet)", () => {
  it("returns Core's classification/evaluations verbatim for every candidate", () => {
    const outcome = discoverNetworks(input());
    expect(outcome.candidates.map((c) => [c.id, c.environment, c.networkId])).toEqual([
      ["base-mainnet", "mainnet", "eip155:8453"],
      ["base-sepolia", "testnet", "eip155:84532"],
      ["solana-devnet", "testnet", SOLANA_DEVNET_BEFORE_PROFILE.config.networkId],
      ["solana-mainnet", "mainnet", SOLANA_MAINNET_BEFORE_PROFILE.config.networkId],
    ]);
    expect(classes(outcome)).toEqual({
      "base-mainnet": "eligible",
      "base-sepolia": "conditional", // desired finality unknown
      "solana-devnet": "ineligible", // archived replay: required execution currently unknown
      "solana-mainnet": "eligible",
    });
    const byId = new Map(crossFamily().map((c) => [c.id, c]));
    for (const [i, candidate] of outcome.candidates.entries()) {
      const source = byId.get(candidate.id)!;
      const core = composeDiscoveryMatch(EXEC_REQUIRED_FINALITY_DESIRED, {
        network: source.network,
        snapshot: source.snapshot,
        resolver: source.manifest,
      });
      expect(candidate.match).toBe(outcome.result.matches[i]);
      expect(candidate.match.classification).toBe(core.classification);
      expect(canonicalJson(candidate.match.evaluations as never)).toBe(canonicalJson(core.evaluations as never));
      expect(candidate.match.capabilitySnapshot).toEqual({ id: source.snapshot.id, digest: source.snapshot.artifactDigest });
      expect(candidate.resolver).toEqual({ id: source.manifest.id, version: source.manifest.version, digest: source.manifest.digest });
    }
  });

  it("produces a result that verifies with Core, both with the returned and the original context", () => {
    const outcome = discoverNetworks(input());
    expect(verifyDiscoverNetworksResult(outcome.result, outcome.verificationContext)).toBe(true);
    const all = crossFamily();
    expect(
      verifyDiscoverNetworksResult(outcome.result, {
        capabilitySnapshots: all.map((c) => c.snapshot),
        resolverManifests: all.map((c) => c.manifest),
      }),
    ).toBe(true);
    expect(outcome.result.requestId).toBe("disc-cross-family");
    expect(outcome.result.generatedAt).toBe(GENERATED_AT);
    expect(canonicalJson(outcome.result.request as never)).toBe(canonicalJson(EXEC_REQUIRED_FINALITY_DESIRED as never));
    expect(outcome.verificationContext.resolverManifests.map((m) => m.id)).toEqual([
      "resolver-opstack-before",
      "resolver-solana-before",
    ]);
    expect(Object.isFrozen(outcome)).toBe(true);
    expect(Object.isFrozen(outcome.result)).toBe(true);
    expect(Object.isFrozen(outcome.candidates[0]!.match)).toBe(true);
  });

  it("required capability unknown => ineligible (never passes), with Core's reason", () => {
    const outcome = discoverNetworks(input({ requirements: { requirements: [{ capability: "finality", strength: "required" }] } }));
    const sepolia = outcome.candidates.find((c) => c.id === "base-sepolia")!;
    expect(sepolia.match.classification).toBe("ineligible");
    expect(sepolia.match.evaluations[0]?.status).toBe("unknown");
    const devnet = outcome.candidates.find((c) => c.id === "solana-devnet")!;
    expect(devnet.match.classification).toBe("ineligible");
    expect(devnet.match.evaluations[0]?.status).toBe("unknown");
    expect(classes(outcome)["base-mainnet"]).toBe("eligible");
    expect(classes(outcome)["solana-mainnet"]).toBe("eligible");
  });

  it("desired unknown => conditional where Core says so; archived replay stays unknown", () => {
    const outcome = discoverNetworks(
      input({
        requirements: { requirements: [{ capability: "finality", strength: "desired" }] },
        candidates: [
          ctx("base-mainnet-replay", "mainnet", baseMainnetReplay),
          ctx("solana-mainnet-replay", "mainnet", solanaMainnetReplay),
          ctx("base-sepolia", "testnet", baseSepolia),
          ctx("solana-devnet", "testnet", solanaDevnet),
        ],
      }),
    );
    for (const candidate of outcome.candidates) {
      expect(candidate.match.classification).toBe("conditional");
      expect(candidate.match.evaluations[0]?.status).toBe("unknown");
    }
  });

  it("unsupported capability (not in manifest) stays unknown => required ineligible, desired conditional", () => {
    const required = discoverNetworks(input({ requirements: { requirements: [{ capability: "settlement", strength: "required" }] } }));
    expect(new Set(Object.values(classes(required)))).toEqual(new Set(["ineligible"]));
    const desired = discoverNetworks(
      input({
        requirements: {
          requirements: [
            { capability: "execution", strength: "required" },
            { capability: "settlement", strength: "desired" },
          ],
        },
      }),
    );
    expect(classes(desired)["base-mainnet"]).toBe("conditional");
    expect(classes(desired)["solana-mainnet"]).toBe("conditional");
  });

  it("Core allow/deny lists keep their Core semantics (ineligible, still reported) — unlike scope", () => {
    const outcome = discoverNetworks(
      input({ requirements: { ...EXEC_REQUIRED_FINALITY_DESIRED, networkDenylist: ["eip155:8453"] } }),
    );
    expect(outcome.candidates).toHaveLength(4);
    expect(classes(outcome)["base-mainnet"]).toBe("ineligible");
  });
});

// ---------------------------------------------------------------------------
// Presentation-only environment scope
// ---------------------------------------------------------------------------

describe("environment scope is presentation-only", () => {
  it("selects scope only; in-scope matches are byte-identical to the unscoped run", () => {
    const full = discoverNetworks(input());
    for (const environment of DISCOVERY_ENVIRONMENTS) {
      const scoped = discoverNetworks(input({ scope: { environments: [environment] } }));
      const expected = full.candidates.filter((c) => c.environment === environment);
      expect(scoped.candidates.map((c) => c.id)).toEqual(expected.map((c) => c.id));
      for (const [i, candidate] of scoped.candidates.entries()) {
        expect(canonicalJson(candidate.match as never)).toBe(canonicalJson(expected[i]!.match as never));
      }
      expect(scoped.scope.environments).toEqual([environment]);
      expect(scoped.scope.outOfScopeCandidateIds).toEqual(
        full.candidates.filter((c) => c.environment !== environment).map((c) => c.id),
      );
      expect(verifyDiscoverNetworksResult(scoped.result, scoped.verificationContext)).toBe(true);
    }
  });

  it("cannot improve classification: an ineligible testnet stays ineligible when scoped to testnet", () => {
    const scoped = discoverNetworks(input({ scope: { environments: ["testnet"] } }));
    expect(classes(scoped)).toEqual({ "base-sepolia": "conditional", "solana-devnet": "ineligible" });
  });

  it("relabelling environments never changes the Core result bytes", () => {
    const flip = (env: DiscoveryEnvironment): DiscoveryEnvironment => (env === "mainnet" ? "testnet" : "mainnet");
    const a = discoverNetworks(input());
    const b = discoverNetworks(input({ candidates: crossFamily().map((c) => ({ ...c, environment: flip(c.environment) })) }));
    expect(bytes(b.result)).toBe(bytes(a.result));
    expect(b.candidates.map((c) => c.environment)).toEqual(a.candidates.map((c) => flip(c.environment)));
  });

  it("environment labels never enter the Core result, request or verification context", () => {
    const outcome = discoverNetworks(input());
    const core = bytes({ result: outcome.result, context: outcome.verificationContext });
    expect(core).not.toContain('"environment"');
    expect(core).not.toContain('"mainnet"');
    expect(core).not.toContain('"testnet"');
  });

  it("environment is never inferred: missing or non-vocabulary values fail closed", () => {
    const [first, ...rest] = crossFamily();
    const { environment: _omitted, ...withoutEnvironment } = first!;
    expectCode(
      () => discoverNetworks(input({ candidates: [withoutEnvironment as unknown as DiscoveryCandidateContext, ...rest] })),
      "DISCOVERY_INPUT_INVALID",
    );
    for (const bad of ["devnet", "sepolia", "Mainnet", "", null, 1]) {
      expectCode(
        () => discoverNetworks(input({ candidates: [{ ...first!, environment: bad as never }, ...rest] })),
        "DISCOVERY_ENVIRONMENT_INVALID",
      );
      expectCode(() => discoverNetworks(input({ scope: { environments: [bad as never] } })), "DISCOVERY_ENVIRONMENT_INVALID");
    }
  });
});

// ---------------------------------------------------------------------------
// Exact candidate-id scope
// ---------------------------------------------------------------------------

describe("candidate-id scope is exact and fail-closed", () => {
  it("selects exactly the named candidates, in deterministic order", () => {
    const outcome = discoverNetworks(input({ scope: { candidateIds: ["solana-mainnet", "base-sepolia"] } }));
    expect(outcome.candidates.map((c) => c.id)).toEqual(["base-sepolia", "solana-mainnet"]);
    expect(outcome.scope).toEqual({
      candidateIds: ["base-sepolia", "solana-mainnet"],
      environments: null,
      inScopeCandidateIds: ["base-sepolia", "solana-mainnet"],
      outOfScopeCandidateIds: ["base-mainnet", "solana-devnet"],
    });
    expect(verifyDiscoverNetworksResult(outcome.result, outcome.verificationContext)).toBe(true);
  });

  it("unknown, near-miss or network-id filter values are errors, not silently ignored", () => {
    for (const id of ["base-goerli", "Base-Sepolia", "base-sepolia ", "eip155:84532", SOLANA_DEVNET_BEFORE_PROFILE.config.networkId]) {
      expectCode(() => discoverNetworks(input({ scope: { candidateIds: [id] } })), "DISCOVERY_SCOPE_UNKNOWN_CANDIDATE");
    }
  });

  it("matches only the opaque presentation id, never networkId", () => {
    const devnetId = SOLANA_DEVNET_BEFORE_PROFILE.config.networkId;
    // A caller that literally chooses another candidate's networkId as a presentation id gets exactly that id.
    const outcome = discoverNetworks(
      input({
        candidates: [ctx(devnetId, "mainnet", solanaMainnet), ctx("devnet", "testnet", solanaDevnet)],
        scope: { candidateIds: [devnetId] },
      }),
    );
    expect(outcome.candidates.map((c) => [c.id, c.networkId])).toEqual([[devnetId, solanaMainnet.network.networkId]]);
    expectCode(
      () => discoverNetworks(input({ candidates: [ctx("devnet", "testnet", solanaDevnet)], scope: { candidateIds: [devnetId] } })),
      "DISCOVERY_SCOPE_UNKNOWN_CANDIDATE",
    );
  });

  it("empty, duplicate, non-string filters and unknown scope fields fail closed", () => {
    expectCode(() => discoverNetworks(input({ scope: { candidateIds: [] } })), "DISCOVERY_SCOPE_INVALID");
    expectCode(() => discoverNetworks(input({ scope: { environments: [] } })), "DISCOVERY_SCOPE_INVALID");
    expectCode(() => discoverNetworks(input({ scope: { candidateIds: ["base-mainnet", "base-mainnet"] } })), "DISCOVERY_SCOPE_INVALID");
    expectCode(() => discoverNetworks(input({ scope: { environments: ["mainnet", "mainnet"] } })), "DISCOVERY_SCOPE_INVALID");
    expectCode(() => discoverNetworks(input({ scope: { candidateIds: [7 as never] } })), "DISCOVERY_SCOPE_INVALID");
    expectCode(() => discoverNetworks(input({ scope: { networks: ["eip155:8453"] } as never })), "DISCOVERY_SCOPE_INVALID");
  });

  it("a named candidate excluded by the environment filter is a scope conflict", () => {
    expectCode(
      () => discoverNetworks(input({ scope: { candidateIds: ["base-mainnet"], environments: ["testnet"] } })),
      "DISCOVERY_SCOPE_CONFLICT",
    );
    const both = discoverNetworks(input({ scope: { candidateIds: ["base-sepolia"], environments: ["testnet"] } }));
    expect(both.candidates.map((c) => c.id)).toEqual(["base-sepolia"]);
  });

  it("an empty scoped set is a valid, Core-verified empty result", () => {
    const onlyMainnet = crossFamily().filter((c) => c.environment === "mainnet");
    const outcome = discoverNetworks(input({ candidates: onlyMainnet, scope: { environments: ["testnet"] } }));
    expect(outcome.result.matches).toEqual([]);
    expect(outcome.candidates).toEqual([]);
    expect(outcome.scope.outOfScopeCandidateIds).toEqual(["base-mainnet", "solana-mainnet"]);
    expect(verifyDiscoverNetworksResult(outcome.result, outcome.verificationContext)).toBe(true);
    const none = discoverNetworks(input({ candidates: [] }));
    expect(none.result.matches).toEqual([]);
    expect(verifyDiscoverNetworksResult(none.result, none.verificationContext)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("determinism", () => {
  it("every candidate input permutation yields byte-identical output", () => {
    const reference = bytes(discoverNetworks(input()));
    const all = permutations(crossFamily());
    expect(all).toHaveLength(24);
    for (const candidates of all) {
      expect(bytes(discoverNetworks(input({ candidates })))).toBe(reference);
      expect(
        bytes(discoverNetworks(input({ candidates, scope: { candidateIds: ["solana-devnet", "base-mainnet"] } }))),
      ).toBe(bytes(discoverNetworks(input({ scope: { candidateIds: ["base-mainnet", "solana-devnet"] } }))));
    }
  });

  it("orders result.matches by candidate presentation id (UTF-16 code units)", () => {
    const outcome = discoverNetworks(
      input({
        candidates: [
          ctx("z-base", "mainnet", baseMainnet),
          ctx("A-solana", "testnet", solanaDevnet),
          ctx("a-solana", "mainnet", solanaMainnet),
        ],
      }),
    );
    expect(outcome.candidates.map((c) => c.id)).toEqual(["A-solana", "a-solana", "z-base"]);
    expect(outcome.result.matches.map((m) => m.network.networkId)).toEqual([
      SOLANA_DEVNET_BEFORE_PROFILE.config.networkId,
      SOLANA_MAINNET_BEFORE_PROFILE.config.networkId,
      "eip155:8453",
    ]);
  });

  it("detaches from caller input: later mutation of inputs cannot alter the outcome", () => {
    const mutableSnapshot = structuredClone(baseMainnet.snapshot) as CapabilitySnapshot;
    const candidate = ctx("base-mainnet", "mainnet", { ...baseMainnet, snapshot: mutableSnapshot });
    const outcome = discoverNetworks(input({ candidates: [candidate] }));
    const before = bytes(outcome);
    (mutableSnapshot as { id: string }).id = "mutated";
    expect(bytes(outcome)).toBe(before);
    expect(verifyDiscoverNetworksResult(outcome.result, outcome.verificationContext)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// No ranking / scoring / choice
// ---------------------------------------------------------------------------

describe("no ranking, scoring or recommendation", () => {
  it("outcome contains no score/rank/recommendation/best fields anywhere", () => {
    const outcome = discoverNetworks(input());
    const forbidden = /score|rank|recommend|best|preferred|priority|weight|chosen|selected/i;
    const walk = (value: unknown, path: string): void => {
      if (Array.isArray(value)) {
        value.forEach((entry, i) => walk(entry, `${path}[${i}]`));
      } else if (value !== null && typeof value === "object") {
        for (const [key, entry] of Object.entries(value)) {
          expect(forbidden.test(key), `${path}.${key}`).toBe(false);
          walk(entry, `${path}.${key}`);
        }
      }
    };
    walk(outcome, "outcome");
    expect(Object.keys(outcome).sort()).toEqual(["candidates", "result", "scope", "verificationContext"]);
    expect(Object.keys(outcome.candidates[0]!).sort()).toEqual(["environment", "id", "match", "networkId", "resolver"]);
  });
});

// ---------------------------------------------------------------------------
// Fail-closed input and binding validation
// ---------------------------------------------------------------------------

function rebuildSnapshot(snapshot: CapabilitySnapshot, manifest: ResolverManifest, patch: Partial<CapabilitySnapshotContent>): CapabilitySnapshot {
  const { artifactDigest: _drop, ...content } = structuredClone(snapshot) as CapabilitySnapshot;
  return buildCapabilitySnapshot({ ...content, ...patch } as CapabilitySnapshotContent, {
    resolver: manifest,
    networkId: snapshot.network.networkId,
  });
}

describe("fail-closed validation", () => {
  it("rejects malformed wrapper input", () => {
    expectCode(() => discoverNetworks(null as never), "DISCOVERY_INPUT_INVALID");
    expectCode(() => discoverNetworks({ ...input(), extra: 1 } as never), "DISCOVERY_INPUT_INVALID");
    expectCode(() => discoverNetworks(input({ requestId: "not an id" })), "DISCOVERY_INPUT_INVALID");
    expectCode(() => discoverNetworks(input({ generatedAt: "yesterday" })), "DISCOVERY_INPUT_INVALID");
    expectCode(() => discoverNetworks(input({ candidates: {} as never })), "DISCOVERY_INPUT_INVALID");
    const [first, ...rest] = crossFamily();
    for (const extra of [{ score: 1 }, { label: "Base mainnet" }, { capabilities: ["finality"] }]) {
      expectCode(() => discoverNetworks(input({ candidates: [{ ...first!, ...extra } as never, ...rest] })), "DISCOVERY_INPUT_INVALID");
    }
    const { manifest: _m, ...noManifest } = first!;
    expectCode(() => discoverNetworks(input({ candidates: [noManifest as never, ...rest] })), "DISCOVERY_INPUT_INVALID");
  });

  it("rejects invalid requirements through Core", () => {
    const error = expectCode(
      () => discoverNetworks(input({ requirements: { requirements: [{ capability: "gasless" as never, strength: "required" }] } })),
      "DISCOVERY_REQUIREMENTS_INVALID",
    );
    expect(error.cause).toBeInstanceOf(NecValidationError);
    expectCode(
      () => discoverNetworks(input({ requirements: { requirements: [{ capability: "execution", strength: "preferred" as never }] } })),
      "DISCOVERY_REQUIREMENTS_INVALID",
    );
  });

  it("rejects invalid and duplicate candidate ids", () => {
    const [first, ...rest] = crossFamily();
    expectCode(() => discoverNetworks(input({ candidates: [{ ...first!, id: "has space" }, ...rest] })), "DISCOVERY_CANDIDATE_ID_INVALID");
    expectCode(
      () => discoverNetworks(input({ candidates: [...crossFamily(), { ...first!, network: baseSepolia.network }] })),
      "DISCOVERY_CANDIDATE_ID_DUPLICATE",
    );
  });

  it("rejects a snapshot bound to a different network than the candidate network", () => {
    const error = expectCode(
      () => discoverNetworks(input({ candidates: [{ ...ctx("base-mainnet", "mainnet", baseMainnet), network: baseSepolia.network }] })),
      "DISCOVERY_CANDIDATE_BINDING_INVALID",
    );
    expect(error.cause).toBeInstanceOf(NecValidationError);
  });

  it("rejects a manifest that does not match the snapshot resolver reference", () => {
    expectCode(
      () => discoverNetworks(input({ candidates: [{ ...ctx("base-mainnet", "mainnet", baseMainnet), manifest: solanaMainnet.manifest }] })),
      "DISCOVERY_CANDIDATE_BINDING_INVALID",
    );
  });

  it("rejects digest-tampered snapshots and manifests", () => {
    const tamperedSnapshot = { ...structuredClone(baseMainnet.snapshot), generatedAt: "2026-10-08T06:00:01.000Z" } as CapabilitySnapshot;
    expectCode(
      () => discoverNetworks(input({ candidates: [ctx("base-mainnet", "mainnet", { ...baseMainnet, snapshot: tamperedSnapshot })] })),
      "DISCOVERY_CANDIDATE_BINDING_INVALID",
    );
    const tamperedManifest = { ...structuredClone(baseMainnet.manifest), supportedCapabilities: ["execution", "finality", "settlement"] } as ResolverManifest;
    expectCode(
      () => discoverNetworks(input({ candidates: [ctx("base-mainnet", "mainnet", { ...baseMainnet, manifest: tamperedManifest })] })),
      "DISCOVERY_CANDIDATE_BINDING_INVALID",
    );
  });

  it("rejects (via Core) a snapshot claiming a capability its manifest does not authorize", () => {
    const { artifactDigest: _drop, ...content } = structuredClone(solanaMainnet.snapshot) as CapabilitySnapshot;
    const forgedContent = {
      ...content,
      evidenceCapabilities: {
        ...content.evidenceCapabilities,
        settlement: { ...content.evidenceCapabilities.finality },
      },
    } as CapabilitySnapshotContent;
    const forged = { ...forgedContent, artifactDigest: computeCapabilitySnapshotDigest(forgedContent as never) } as CapabilitySnapshot;
    const error = expectCode(
      () => discoverNetworks(input({ candidates: [ctx("solana-mainnet", "mainnet", { ...solanaMainnet, snapshot: forged })] })),
      "DISCOVERY_CANDIDATE_BINDING_INVALID",
    );
    expect(error.cause).toBeInstanceOf(NecValidationError);
    expect(String((error.cause as Error).message)).toContain("supportedCapabilities");
  });

  it("validates every supplied candidate, including out-of-scope ones", () => {
    const broken = { ...ctx("base-sepolia", "testnet", baseSepolia), network: baseMainnet.network };
    expectCode(
      () =>
        discoverNetworks(
          input({ candidates: [ctx("solana-mainnet", "mainnet", solanaMainnet), broken], scope: { environments: ["mainnet"] } }),
        ),
      "DISCOVERY_CANDIDATE_BINDING_INVALID",
    );
  });

  it("rejects two candidates for the same network", () => {
    expectCode(
      () => discoverNetworks(input({ candidates: [ctx("base-a", "mainnet", baseMainnet), ctx("base-b", "testnet", baseMainnet)] })),
      "DISCOVERY_NETWORK_DUPLICATE",
    );
  });

  it("rejects ambiguous Core context: shared snapshot ids or one manifest id with two digests", () => {
    const collidingSnapshot = rebuildSnapshot(solanaMainnet.snapshot, solanaMainnet.manifest, { id: baseMainnet.snapshot.id });
    expectCode(
      () =>
        discoverNetworks(
          input({
            candidates: [
              ctx("base-mainnet", "mainnet", baseMainnet),
              ctx("solana-mainnet", "mainnet", { ...solanaMainnet, snapshot: collidingSnapshot }),
            ],
          }),
        ),
      "DISCOVERY_CONTEXT_CONFLICT",
    );

    const { digest: _d, ...manifestContent } = structuredClone(solanaDevnet.manifest) as ResolverManifest;
    const variantContent = { ...manifestContent, metadata: { ...manifestContent.metadata, variant: "local-test" } };
    const variant = { ...variantContent, digest: computeResolverManifestDigest(variantContent) } as ResolverManifest;
    const variantSnapshot = rebuildSnapshot(solanaDevnet.snapshot, variant, {
      resolver: { id: variant.id, version: variant.version, digest: variant.digest },
    });
    expectCode(
      () =>
        discoverNetworks(
          input({
            candidates: [
              ctx("solana-mainnet", "mainnet", solanaMainnet),
              ctx("solana-devnet", "testnet", { network: solanaDevnet.network, manifest: variant, snapshot: variantSnapshot }),
            ],
          }),
        ),
      "DISCOVERY_CONTEXT_CONFLICT",
    );
  });

  it("rejects an empty requestId", () => {
    expectCode(() => discoverNetworks(input({ requestId: "" })), "DISCOVERY_INPUT_INVALID");
  });

  it("maps a non-cloneable exotic input (no-trap Proxy) to NecDiscoveryError, not a raw DataCloneError", () => {
    const proxied = { ...ctx("solana-mainnet", "mainnet", solanaMainnet), network: new Proxy(structuredClone(solanaMainnet.network), {}) };
    const error = expectCode(() => discoverNetworks(input({ candidates: [proxied] })), "DISCOVERY_INPUT_INVALID");
    expect(error.cause).toBeInstanceOf(Error);
    expect((error.cause as Error).name).toBe("DataCloneError");
    expectCode(
      () => discoverNetworks(input({ requirements: new Proxy(structuredClone(EXEC_REQUIRED_FINALITY_DESIRED), {}) })),
      "DISCOVERY_INPUT_INVALID",
    );
  });
});
