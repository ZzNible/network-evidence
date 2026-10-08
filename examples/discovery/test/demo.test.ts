import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { canonicalJson, verifyDiscoverNetworksResult, verifyPreflightResult } from "@nec/core";
import * as discovery from "@nec/discovery";
import { discoverNetworks } from "@nec/discovery";
import type { DiscoverNetworksOutcome, DiscoveryEnvironment } from "@nec/discovery";
import { deriveSolanaBeforePreflightResult } from "@nec/resolver-solana";

import { chooseFirstEligibleByCallerPreference } from "../caller-policy.js";
import { loadDemoInputs } from "../inputs.js";
import type { DemoInputs } from "../inputs.js";
import {
  buildDiscoveryDemo,
  buildDiscoveryInput,
  CALLER_PREFERENCE,
  DEMO_CANDIDATES,
  renderDiscoveryDemo,
  runDiscoveryDemo,
} from "../run.js";
import type { DiscoveryDemo } from "../run.js";

const FORBIDDEN_WORDS = /\b(rank\w*|scor\w*|best|recommend\w*|weight\w*|priorit\w*)\b/i;
// Keys only: @nec/discovery outcome / preflight result keys must not carry choice semantics.
// prefer*/select* are legitimate in caller-policy prose and objects, so they are not in FORBIDDEN_WORDS.
const FORBIDDEN_KEY_WORD = /^(rank\w*|scor\w*|best|recommend\w*|weight\w*|priorit\w*|prefer\w*|select\w*|top|better)$/i;

const originalFetch = globalThis.fetch;
const fetchGuard = vi.fn(() => {
  throw new Error("network I/O is forbidden in Discovery demo tests");
});

let demo: DiscoveryDemo;
let inputs: DemoInputs;

beforeAll(async () => {
  globalThis.fetch = fetchGuard as unknown as typeof fetch;
  demo = await buildDiscoveryDemo();
  inputs = await loadDemoInputs();
});

afterAll(() => {
  expect(fetchGuard).not.toHaveBeenCalled();
  globalThis.fetch = originalFetch;
});

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function classes(outcome: DiscoverNetworksOutcome): Record<string, string> {
  return Object.fromEntries(outcome.candidates.map((c) => [c.id, c.match.classification]));
}

/** Split a key into camelCase / snake_case / kebab-case words and test each against FORBIDDEN_KEY_WORD. */
function hasForbiddenKeyWord(key: string): boolean {
  return key.split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])/).some((word) => FORBIDDEN_KEY_WORD.test(word));
}

function allKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const item of value) allKeys(item, out);
  else if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      out.push(key);
      allKeys(item, out);
    }
  }
  return out;
}

describe("public Discovery demo", () => {
  it("pins deterministic stdout across runs", async () => {
    const a = await runDiscoveryDemo();
    const b = await runDiscoveryDemo();
    expect(a).toBe(b);
    const expected = (await readFile(new URL("../EXPECTED_STDOUT.sha256", import.meta.url), "utf8")).trim();
    expect(sha256(a)).toBe(expected);
  });

  it("CLI stdout equals the in-process render (offline subprocess)", () => {
    const run = fileURLToPath(new URL("../run.ts", import.meta.url));
    const child = spawnSync(process.execPath, ["--import", "tsx", run], { encoding: "utf8", timeout: 60_000 });
    expect(child.status).toBe(0);
    expect(child.stdout).toBe(renderDiscoveryDemo(demo));
  });

  it("mixes Base + Solana, mainnet + testnet, with eligible / conditional / ineligible", () => {
    expect(demo.outcome.candidates.map((c) => [c.id, c.environment, c.networkId])).toEqual([
      ["base-mainnet", "mainnet", "eip155:8453"],
      ["base-sepolia", "testnet", "eip155:84532"],
      ["solana-devnet", "testnet", "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"],
      ["solana-mainnet", "mainnet", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"],
    ]);
    expect(classes(demo.outcome)).toEqual({
      "base-mainnet": "eligible",
      "base-sepolia": "conditional",
      "solana-devnet": "ineligible",
      "solana-mainnet": "eligible",
    });
  });

  it("output contains no ranking / score / best / recommendation language or field", async () => {
    const stdout = await runDiscoveryDemo();
    expect(stdout).not.toMatch(FORBIDDEN_WORDS);
    for (const key of allKeys(demo.outcome)) expect(key).not.toMatch(FORBIDDEN_WORDS);
    for (const key of allKeys(demo.preflight?.result)) expect(key).not.toMatch(FORBIDDEN_WORDS);
    expect(Object.keys(demo.outcome).sort()).toEqual(["candidates", "result", "scope", "verificationContext"]);
    expect(stdout.trimEnd().split("\n").at(-1)).toBe("NE did not execute, sign, fund or submit anything.");
  });

  it("@nec/discovery outcome and preflight result keys carry no rank / preference / selection field", () => {
    for (const bad of ["preferred", "preferredId", "selected", "selectedCandidate", "top", "isBetter", "candidate_rank", "best-score", "weight", "priority", "recommendation"]) {
      expect(hasForbiddenKeyWord(bad), bad).toBe(true);
    }
    for (const ok of ["candidates", "scope", "inScopeCandidateIds", "topic", "stop", "status", "evaluations"]) {
      expect(hasForbiddenKeyWord(ok), ok).toBe(false);
    }
    expect(allKeys(demo.outcome).filter(hasForbiddenKeyWord)).toEqual([]);
    expect(allKeys(demo.preflight?.result).filter(hasForbiddenKeyWord)).toEqual([]);
  });

  it("the chosen candidate comes from the explicit caller-policy function, not from @nec/discovery", () => {
    expect(Object.keys(discovery).sort()).toEqual(["DISCOVERY_ENVIRONMENTS", "NecDiscoveryError", "discoverNetworks"]);
    expect(demo.choice).toEqual(chooseFirstEligibleByCallerPreference(demo.outcome.candidates, CALLER_PREFERENCE));
    expect(demo.choice.chosenId).toBe("solana-mainnet");
    // Same discovery outcome, different caller preference => different choice.
    const other = chooseFirstEligibleByCallerPreference(demo.outcome.candidates, ["base-mainnet", "solana-mainnet"]);
    expect(other.chosenId).toBe("base-mainnet");
    // Alternatives stay visible: every candidate is in the outcome and in the policy trace.
    expect(demo.choice.steps.map((s) => s.candidateId).sort()).toEqual(demo.outcome.candidates.map((c) => c.id));
  });

  it("the discovery result verifies through Core with the returned and the original context", () => {
    expect(demo.resultVerified).toBe(true);
    expect(verifyDiscoverNetworksResult(demo.outcome.result, demo.outcome.verificationContext)).toBe(true);
    const foundations = DEMO_CANDIDATES.map(({ id }) => inputs[id].foundation);
    expect(
      verifyDiscoverNetworksResult(demo.outcome.result, {
        capabilitySnapshots: foundations.map((f) => f.snapshot),
        resolverManifests: foundations.map((f) => f.manifest),
      }),
    ).toBe(true);
  });

  it("the chosen preflight uses the resolver-specific function and verifies through Core", () => {
    const preflight = demo.preflight!;
    expect(preflight.binding.functionName).toBe("deriveSolanaBeforePreflightResult");
    expect(preflight.result.status).toBe("ready");
    expect(preflight.verified).toBe(true);
    expect(preflight.snapshotMatchesDiscovery).toBe(true);
    const foundation = inputs["solana-mainnet"].foundation;
    expect(verifyPreflightResult(preflight.result, { resolver: foundation.manifest, capabilitySnapshot: foundation.snapshot })).toBe(true);
    expect(canonicalJson(deriveSolanaBeforePreflightResult(foundation, preflight.request) as never)).toBe(
      canonicalJson(preflight.result as never),
    );
  });

  it("changing presentation environments without changing scope cannot improve a Core classification", () => {
    const flip = (env: DiscoveryEnvironment): DiscoveryEnvironment => (env === "mainnet" ? "testnet" : "mainnet");
    const flipped = discoverNetworks(
      buildDiscoveryInput(inputs, Object.fromEntries(DEMO_CANDIDATES.map(({ id, environment }) => [id, flip(environment)]))),
    );
    expect(canonicalJson(flipped.result as never)).toBe(canonicalJson(demo.outcome.result as never));
    expect(classes(flipped)).toEqual(classes(demo.outcome));
    const allMainnet = discoverNetworks(
      buildDiscoveryInput(inputs, Object.fromEntries(DEMO_CANDIDATES.map(({ id }) => [id, "mainnet"]))),
    );
    expect(allMainnet.result.artifactDigest).toBe(demo.outcome.result.artifactDigest);
    expect(classes(allMainnet)).toEqual(classes(demo.outcome));
  });

  it("archived replay keeps current availability unknown and stays ineligible for a required capability", () => {
    const devnet = demo.outcome.candidates.find((c) => c.id === "solana-devnet")!;
    expect(inputs["solana-devnet"].inputKind).toBe("archived-replay");
    expect(devnet.match.network.metadata?.observationKind).toBe("historical_replay");
    expect(devnet.match.classification).toBe("ineligible");
    expect(devnet.match.evaluations.map((e) => [e.requirement.capability, e.status])).toEqual([
      ["execution", "unknown"],
      ["finality", "unknown"],
    ]);
    const capabilities = inputs["solana-devnet"].foundation.snapshot.evidenceCapabilities;
    expect(capabilities.execution.availability).toBe("unknown");
    expect(capabilities.finality.availability).toBe("unknown");
    // Even if a caller insisted on it, the archived context gives no ready preflight.
    const pf = deriveSolanaBeforePreflightResult(inputs["solana-devnet"].foundation, {
      ...demo.preflight!.request,
      requestId: "pf-demo-solana-devnet",
      networkId: devnet.networkId,
    });
    expect(pf.status).not.toBe("ready");
  });
});
