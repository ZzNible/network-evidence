/**
 * verify-live-before.ts over real hosted BEFORE envelopes. Discovery and
 * preflight run through the existing live tools over a fake provider fetchFn
 * that serves the checked-in Base mainnet and Solana mainnet capture bytes for
 * the exact recorded params; global fetch throws. For the three-candidate call
 * Base Sepolia answers its real eth_chainId capture, and SIMULATED nulls for
 * the made-up SYNTHETIC_BASE_SEPOLIA_TX lookups (not an observed action, not
 * proof of nonexistence or of network unavailability). The arguments are the
 * capture client's own fixed calls. Every negative is a mutation of a real
 * envelope and must end as diverged or not_reproducible, never verified.
 * The CLI exit rule is driven over small capture files in a temp directory.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createLiveBeforeTool, createLivePreflightTool, createMultichainTool, LIVE_BEFORE_SCHEMA, LIVE_PREFLIGHT_SCHEMA as MCP_PREFLIGHT_SCHEMA,
} from "@nec/mcp";

import {
  LIVE_BEFORE_MAX_AGE_MS as MCP_MAX_AGE_MS, LIVE_BEFORE_MAX_CANDIDATES as MCP_MAX_CANDIDATES,
} from "../../../packages/mcp/src/live-before.js";
import { assessCaptureOutcomes, CAPTURE_CALLS, SYNTHETIC_BASE_SEPOLIA_TX } from "../capture-hosted.js";
import {
  LIVE_BEFORE_MAX_AGE_MS, LIVE_BEFORE_MAX_CANDIDATES, LIVE_DISCOVERY_SCHEMA, LIVE_PREFLIGHT_SCHEMA, main, verifyLiveDiscoveryEnvelope,
  verifyLivePreflightEnvelope,
} from "../verify-live-before.js";

type Capture = { rpcMethod: string; rpcParams: unknown[]; resultJson: string };
const load = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as { captures: Capture[] };
const EVM = load("../../../packages/mcp/test/fixtures/base-mainnet-l2-finalized-positive-evm.json");
const SOL = load("../../../packages/resolver-solana/test/fixtures/solana-mainnet-x402-real.json");
const SEPOLIA = load("../../../packages/adapter-erc4337/test/fixtures/base-sepolia-external-v06-userop.json");
/** Base Sepolia: the real eth_chainId capture; SIMULATED nulls for the made-up SYNTHETIC_BASE_SEPOLIA_TX lookups. */
const SEPOLIA_ANSWERS = { captures: [
  SEPOLIA.captures.find((c) => c.rpcMethod === "eth_chainId")!,
  ...["eth_getTransactionReceipt", "eth_getTransactionByHash"].map((rpcMethod) => ({
    rpcMethod, rpcParams: [SYNTHETIC_BASE_SEPOLIA_TX], resultJson: "null",
  })),
] };
const SOL_ID = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const DEVNET_ID = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";

function provider(): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).href;
    const q = JSON.parse(init?.body as string) as { id: unknown; method: string; params?: unknown[] };
    const fixture = url === "https://mainnet.base.org/" ? EVM : url === "https://api.mainnet-beta.solana.com/" ? SOL
      : url === "https://sepolia.base.org/" ? SEPOLIA_ANSWERS : null;
    if (fixture === null) throw new Error("Unapproved fake endpoint");
    const found = fixture.captures.find((c) => c.rpcMethod === q.method && isDeepStrictEqual(q.params ?? [], c.rpcParams));
    if (found === undefined) throw new Error(`Unexpected request: ${q.method}`);
    const response = new Response(`{"jsonrpc":"2.0","id":${JSON.stringify(q.id)},"result":${found.resultJson}}`, {
      status: 200, headers: { "content-type": "application/json" },
    });
    Object.defineProperty(response, "url", { value: url });
    return response;
  };
}

const argsOf = (id: string) => structuredClone(CAPTURE_CALLS.find((c) => c.id === id)!.arguments) as any;
const DISCOVERY_ARGS = argsOf("discover-mainnet");
const PREFLIGHT_ARGS = argsOf("preflight-base-mainnet-probe");
const THREE_ARGS = argsOf("discover-three-candidates");
const json = (value: unknown): any => JSON.parse(JSON.stringify(value));
const flip = (digest: string) => `${digest.slice(0, -1)}${digest.endsWith("0") ? "1" : "0"}`;
const shift = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();

const realFetch = globalThis.fetch;
let globalFetchAttempts = 0;
let discovery: any;
let preflight: any;
let three: any;
let threeExecutionOnly: any;
beforeAll(async () => {
  globalThis.fetch = (async () => {
    globalFetchAttempts += 1;
    throw new Error("global fetch is denied in hosted-reproduction tests");
  }) as typeof fetch;
  const resolve = createMultichainTool(provider());
  discovery = json(await createLiveBeforeTool(resolve)(DISCOVERY_ARGS));
  preflight = json(await createLivePreflightTool(resolve)(PREFLIGHT_ARGS));
  // One NE-L028-shaped call per fresh shared budget (3 admissions each).
  three = json(await createLiveBeforeTool(createMultichainTool(provider()))(THREE_ARGS));
  // Same subjects, other caller requirements: a genuine Core result with another class set.
  threeExecutionOnly = json(await createLiveBeforeTool(createMultichainTool(provider()))({
    ...THREE_ARGS, requirements: { requirements: [{ capability: "execution", strength: "required" }] },
  }));
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

/** A mutated copy of a real envelope. */
function mutate(envelope: any, change: (copy: any) => void): any {
  const copy = json(envelope);
  change(copy);
  return copy;
}

describe("verify-live-before (offline, fail closed)", () => {
  it("pins the verifier constants to the MCP server's", () => {
    expect(LIVE_DISCOVERY_SCHEMA).toBe(LIVE_BEFORE_SCHEMA);
    expect(LIVE_PREFLIGHT_SCHEMA).toBe(MCP_PREFLIGHT_SCHEMA);
    expect(LIVE_BEFORE_MAX_AGE_MS).toBe(MCP_MAX_AGE_MS);
    expect(LIVE_BEFORE_MAX_AGE_MS).toBe(180_000);
    expect(LIVE_BEFORE_MAX_CANDIDATES).toBe(MCP_MAX_CANDIDATES);
    expect(LIVE_BEFORE_MAX_CANDIDATES).toBe(3);
  });

  it("an NE-L028-shaped three-candidate envelope verifies with the three Core classes", () => {
    const report = verifyLiveDiscoveryEnvelope(three, { expected: THREE_ARGS });
    expect(report).toEqual({
      status: "verified", reason: "envelope_verified",
      resultArtifactDigest: three.result.artifactDigest,
      contextualVerification: "context_not_returned",
      candidates: three.candidates.map((c: any) => ({
        networkId: c.networkId, classification: c.classification, snapshotDigest: c.snapshotDigest,
        observationAgeMs: Date.parse(three.generatedAt) - Date.parse(c.observedAt),
      })),
    });
    expect(report.candidates.map((c) => [c.networkId, c.classification])).toEqual([
      ["eip155:8453", "conditional"], ["eip155:84532", "ineligible"], [SOL_ID, "eligible"],
    ]);
    expect(new Set(report.candidates.map((c) => c.snapshotDigest)).size).toBe(3);
    // The existing two-candidate discover-mainnet regression still verifies.
    expect(verifyLiveDiscoveryEnvelope(discovery, { expected: DISCOVERY_ARGS }).status).toBe("verified");
    expect(globalFetchAttempts).toBe(0);
  });

  it("three-candidate tampering is diverged or not_reproducible, never verified", () => {
    expect(three.candidates[1].classification).toBe("ineligible");
    const cases: [string, any, unknown, string, string, string][] = [
      ["4 candidates (over the cap)", mutate(three, (d) => {
        d.candidates.push({ ...d.candidates[2], id: "solana-devnet", environment: "testnet", networkId: DEVNET_ID });
      }), THREE_ARGS, "not_reproducible", "envelope_invalid", "/candidates"],
      ["duplicate network among 3", mutate(three, (d) => { d.candidates[2] = json(d.candidates[0]); }),
        THREE_ARGS, "not_reproducible", "envelope_invalid", "/candidates/2/networkId"],
      ["candidate dropped (2 vs Core 3)", mutate(three, (d) => { d.candidates.splice(1, 1); }),
        THREE_ARGS, "diverged", "candidate_binding_mismatch", "/candidates"],
      ["snapshot digests swapped between candidates 0 and 2", mutate(three, (d) => {
        [d.candidates[0].snapshotDigest, d.candidates[2].snapshotDigest] = [d.candidates[2].snapshotDigest, d.candidates[0].snapshotDigest];
      }), THREE_ARGS, "diverged", "candidate_binding_mismatch", "/candidates/0/snapshotDigest"],
      ["class changed ineligible -> conditional in the envelope only", mutate(three, (d) => { d.candidates[1].classification = "conditional"; }),
        THREE_ARGS, "diverged", "candidate_binding_mismatch", "/candidates/1/classification"],
      ["3-candidate envelope under discover-mainnet", three, DISCOVERY_ARGS, "diverged", "request_binding_mismatch", "/result/requestId"],
      ["3-candidate envelope under discover-mainnet subjects", three, { ...DISCOVERY_ARGS, requestId: THREE_ARGS.requestId },
        "diverged", "request_binding_mismatch", "/candidates"],
    ];
    for (const [name, envelope, expected, status, reason, pointer] of cases) {
      const report = verifyLiveDiscoveryEnvelope(envelope, { expected });
      expect([name, report.status, report.reason, report.firstDiffPointer]).toEqual([name, status, reason, pointer]);
      expect(report.contextualVerification).toBe("context_not_returned");
      expect(report.candidates).toEqual([]);
    }
    expect(globalFetchAttempts).toBe(0);
  });

  it("real discovery envelope verifies; Core contextual verification is reported context_not_returned", () => {
    const report = verifyLiveDiscoveryEnvelope(discovery, { expected: DISCOVERY_ARGS });
    expect(report).toEqual({
      status: "verified", reason: "envelope_verified",
      resultArtifactDigest: discovery.result.artifactDigest,
      contextualVerification: "context_not_returned",
      candidates: discovery.candidates.map((c: any) => ({
        networkId: c.networkId, classification: c.classification, snapshotDigest: c.snapshotDigest,
        observationAgeMs: Date.parse(discovery.generatedAt) - Date.parse(c.observedAt),
      })),
    });
    expect(report.candidates.map((c) => [c.networkId, c.classification])).toEqual([["eip155:8453", "conditional"], [SOL_ID, "eligible"]]);
    expect(verifyLiveDiscoveryEnvelope(discovery).status).toBe("verified");
    // The age bound is inclusive.
    const boundary = mutate(discovery, (d) => { d.candidates[0].observedAt = shift(d.generatedAt, -LIVE_BEFORE_MAX_AGE_MS); });
    expect(verifyLiveDiscoveryEnvelope(boundary).status).toBe("verified");
    expect(globalFetchAttempts).toBe(0);
  });

  it("real preflight envelope verifies against its returned context, bound to the capture's own request", () => {
    expect(verifyLivePreflightEnvelope(preflight, { expected: PREFLIGHT_ARGS })).toEqual({
      status: "verified", reason: "envelope_verified",
      preflightArtifactDigest: preflight.preflight.artifactDigest,
      selectedNetworkId: "eip155:8453", preflightStatus: "blocked",
      contextualVerification: "returned_context_verified",
    });
    expect(verifyLivePreflightEnvelope(preflight).status).toBe("verified");
    expect(globalFetchAttempts).toBe(0);
  });

  it("discovery tampering is diverged or not_reproducible, never verified", () => {
    const cases: [string, any, unknown, string, string][] = [
      ["tampered candidate classification", mutate(discovery, (d) => { d.candidates[0].classification = "eligible"; }),
        undefined, "diverged", "candidate_binding_mismatch"],
      ["tampered Core match classification", mutate(discovery, (d) => { d.result.matches[0].classification = "eligible"; }),
        undefined, "not_reproducible", "core_artifact_invalid"],
      ["swapped snapshot digests", mutate(discovery, (d) => {
        [d.candidates[0].snapshotDigest, d.candidates[1].snapshotDigest] = [d.candidates[1].snapshotDigest, d.candidates[0].snapshotDigest];
      }), undefined, "diverged", "candidate_binding_mismatch"],
      ["stale observedAt (> 180 s)", mutate(discovery, (d) => {
        d.candidates[1].observedAt = shift(d.generatedAt, -(LIVE_BEFORE_MAX_AGE_MS + 1));
      }), undefined, "diverged", "observation_stale"],
      ["observedAt after generatedAt", mutate(discovery, (d) => { d.candidates[0].observedAt = shift(d.generatedAt, 1); }),
        undefined, "diverged", "observation_after_generation"],
      ["mutated result self-digest", mutate(discovery, (d) => { d.result.artifactDigest = flip(d.result.artifactDigest); }),
        undefined, "not_reproducible", "core_artifact_invalid"],
      ["missing result", mutate(discovery, (d) => { delete d.result; }), undefined, "not_reproducible", "envelope_invalid"],
      ["missing candidate snapshotDigest", mutate(discovery, (d) => { delete d.candidates[0].snapshotDigest; }),
        undefined, "not_reproducible", "envelope_invalid"],
      ["generatedAt differs from the Core result", mutate(discovery, (d) => { d.generatedAt = shift(d.generatedAt, 1); }),
        undefined, "diverged", "generated_at_mismatch"],
      ["unknown schema", mutate(discovery, (d) => { d.schema = "ne-mcp-live-discovery/v0.2"; }), undefined, "not_reproducible", "unknown_schema"],
      ["extra key", mutate(discovery, (d) => { d.recommendation = "base-mainnet"; }), undefined, "not_reproducible", "envelope_invalid"],
      ["other requestId than the capture sent", discovery, { ...DISCOVERY_ARGS, requestId: "ne_other_1" }, "diverged", "request_binding_mismatch"],
    ];
    for (const [name, envelope, expected, status, reason] of cases) {
      const report = verifyLiveDiscoveryEnvelope(envelope, { expected });
      expect([name, report.status, report.reason]).toEqual([name, status, reason]);
      expect(report.contextualVerification).toBe("context_not_returned");
      expect(report.candidates).toEqual([]);
    }
    const getter = json(discovery);
    Object.defineProperty(getter, "generatedAt", { get: () => discovery.generatedAt, enumerable: true });
    expect(verifyLiveDiscoveryEnvelope(getter)).toMatchObject({ status: "not_reproducible", reason: "envelope_invalid" });
  });

  it("preflight tampering is diverged or not_reproducible, never verified", () => {
    const cases: [string, any, unknown, string, string][] = [
      ["probe network != selected network", mutate(preflight, (p) => { p.probeSubject.networkId = "eip155:84532"; }),
        undefined, "diverged", "probe_network_mismatch"],
      ["selected network != probe network", mutate(preflight, (p) => { p.selectedNetworkId = "eip155:84532"; }),
        undefined, "diverged", "probe_network_mismatch"],
      ["choice not by the caller", mutate(preflight, (p) => { p.choiceSource = "nec"; }), undefined, "diverged", "choice_source_mismatch"],
      ["mutated preflight self-digest", mutate(preflight, (p) => { p.preflight.artifactDigest = flip(p.preflight.artifactDigest); }),
        undefined, "not_reproducible", "core_artifact_invalid"],
      ["mutated snapshot self-digest", mutate(preflight, (p) => {
        p.capabilitySnapshot.artifactDigest = flip(p.capabilitySnapshot.artifactDigest);
      }), undefined, "not_reproducible", "core_artifact_invalid"],
      ["tampered preflight status", mutate(preflight, (p) => { p.preflight.status = "ready"; }),
        undefined, "not_reproducible", "core_artifact_invalid"],
      ["missing capabilitySnapshot", mutate(preflight, (p) => { delete p.capabilitySnapshot; }), undefined, "not_reproducible", "envelope_invalid"],
      ["missing resolverManifest", mutate(preflight, (p) => { delete p.resolverManifest; }), undefined, "not_reproducible", "envelope_invalid"],
      ["other request than the capture sent", preflight,
        { ...PREFLIGHT_ARGS, request: { ...PREFLIGHT_ARGS.request, requestId: "ne_other_probe_1" } }, "diverged", "request_binding_mismatch"],
      ["other probe than the capture sent", preflight,
        { ...PREFLIGHT_ARGS, probeSubject: { ...PREFLIGHT_ARGS.probeSubject, txId: `0x${"5e1ec7ed".repeat(8)}` } },
        "diverged", "request_binding_mismatch"],
    ];
    for (const [name, envelope, expected, status, reason] of cases) {
      const report = verifyLivePreflightEnvelope(envelope, { expected });
      expect([name, report.status, report.reason]).toEqual([name, status, reason]);
      expect(report.contextualVerification).toBe("not_verified");
    }
    // A mutated manifest self-digest breaks the manifest or its context binding; either way not verified.
    const manifest = verifyLivePreflightEnvelope(mutate(preflight, (p) => { p.resolverManifest.digest = flip(p.resolverManifest.digest); }));
    expect(["diverged", "not_reproducible"]).toContain(manifest.status);
  });

  it("same input gives byte-identical reports", () => {
    const stale = mutate(discovery, (d) => { d.candidates[0].observedAt = shift(d.generatedAt, -(LIVE_BEFORE_MAX_AGE_MS + 1)); });
    const wrongNetwork = mutate(preflight, (p) => { p.probeSubject.networkId = "eip155:84532"; });
    const dropped = mutate(three, (d) => { d.candidates.splice(1, 1); });
    for (const run of [
      () => verifyLiveDiscoveryEnvelope(discovery, { expected: DISCOVERY_ARGS }),
      () => verifyLiveDiscoveryEnvelope(stale),
      () => verifyLiveDiscoveryEnvelope(three, { expected: THREE_ARGS }),
      () => verifyLiveDiscoveryEnvelope(dropped, { expected: THREE_ARGS }),
      () => verifyLivePreflightEnvelope(preflight, { expected: PREFLIGHT_ARGS }),
      () => verifyLivePreflightEnvelope(wrongNetwork),
    ]) {
      expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
    }
    expect(globalFetchAttempts).toBe(0);
  });

  it("CLI exits 0 only with verified mainnet and three-class discoveries, a verified preflight report and met class coverage", async () => {
    const toolOf = (id: string) => CAPTURE_CALLS.find((c) => c.id === id)!.tool;
    const ok = (id: string, envelope: unknown) => ({
      id, tool: toolOf(id), arguments: argsOf(id), isError: false, structuredContent: envelope,
    });
    // A typed source failure: an expected outcome for both calls, but no BEFORE evidence.
    const failed = (id: string, code: string) => ({
      id, tool: toolOf(id), arguments: argsOf(id), isError: true, structuredContent: null,
      content: [{ type: "text", text: JSON.stringify({ error: { code } }) }],
    });
    const discoverFailed = failed("discover-mainnet", "MCP_LIVE_BEFORE_UNAVAILABLE");
    const threeFailed = failed("discover-three-candidates", "MCP_LIVE_BEFORE_UNAVAILABLE");
    const preflightFailed = failed("preflight-base-mainnet-probe", "MCP_LIVE_PREFLIGHT_UNAVAILABLE");
    const discoverOk = ok("discover-mainnet", discovery);
    const threeOk = ok("discover-three-candidates", three);
    const threeOtherClasses = ok("discover-three-candidates", threeExecutionOnly);
    const preflightOk = ok("preflight-base-mainnet-probe", preflight);
    const threeClasses = [
      { networkId: "eip155:8453", classification: "conditional" }, { networkId: "eip155:84532", classification: "ineligible" },
      { networkId: SOL_ID, classification: "eligible" },
    ];
    const otherClasses = [
      { networkId: "eip155:8453", classification: "eligible" }, { networkId: "eip155:84532", classification: "ineligible" },
      { networkId: SOL_ID, classification: "eligible" },
    ];
    // [name, calls, exit, missingVerified, classCoverage.observed, classCoverage.met, status of the three-class report]
    const cases: [string, unknown[], number, string[], unknown[], boolean, string | null][] = [
      ["all verified", [discoverOk, threeOk, preflightOk], 0, [], threeClasses, true, "verified"],
      ["both source failures", [discoverFailed, threeOk, preflightFailed], 1, ["discover-mainnet", "preflight-base-mainnet-probe"],
        threeClasses, true, "verified"],
      ["preflight source failure", [discoverOk, threeOk, preflightFailed], 1, ["preflight-base-mainnet-probe"], threeClasses, true, "verified"],
      ["discovery absent", [threeOk, preflightOk], 1, ["discover-mainnet"], threeClasses, true, "verified"],
      ["preflight envelope under the discovery id", [{ ...preflightOk, id: "discover-mainnet" }, threeOk, preflightOk], 1, ["discover-mainnet"],
        threeClasses, true, "verified"],
      ["three-class call missing", [discoverOk, preflightOk], 1, ["discover-three-candidates"], [], false, null],
      ["three-class call renamed", [discoverOk, { ...threeOk, id: "discover-three-classes" }, preflightOk], 1,
        ["discover-three-candidates"], [], false, null],
      ["three-class call MCP_LIVE_BEFORE_UNAVAILABLE", [discoverOk, threeFailed, preflightOk], 1, ["discover-three-candidates"], [], false, null],
      ["three-class call verified with another class set", [discoverOk, threeOtherClasses, preflightOk], 1, [], otherClasses, false, "verified"],
    ];
    // The M-2 shape: every outcome is expected and no report is unverified, yet there is no BEFORE evidence.
    expect(assessCaptureOutcomes([discoverFailed, threeFailed, preflightFailed]).map((o) => [o.outcome.kind, o.expected])).toEqual([
      ["source_failure", true], ["source_failure", true], ["source_failure", true],
    ]);

    const dir = mkdtempSync(join(tmpdir(), "ne-verify-live-before-"));
    const written: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });
    try {
      for (const [index, [name, calls, exit, missing, observed, met, threeStatus]] of cases.entries()) {
        const path = join(dir, `capture-${index}.json`);
        writeFileSync(path, JSON.stringify({ acquiringExecutable: null, calls }), { flag: "wx" });
        written.length = 0;
        const code = await main(["--capture", path]);
        const output = JSON.parse(written.join("")) as {
          missingVerified: string[]; classCoverage: unknown; reports: { id: string; report: { status: string } }[];
        };
        expect([name, code, output.missingVerified]).toEqual([name, exit, missing]);
        expect([name, output.classCoverage]).toEqual([name, {
          callId: "discover-three-candidates", required: ["conditional", "eligible", "ineligible"], observed, met,
        }]);
        // Coverage never changes a report status.
        expect([name, output.reports.find((r) => r.id === "discover-three-candidates")?.report.status ?? null]).toEqual([name, threeStatus]);
      }
    } finally {
      write.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
    expect(globalFetchAttempts).toBe(0);
  });
});
