import { describe, expect, it } from "vitest";

import {
  acquireOpStackFinalityObservation,
  buildOpStackFinalityFixture,
  NecResolverOpStackError,
  OPSTACK_ACQUISITION_PROFILE,
  OPSTACK_FAMILY,
  OPSTACK_FINALITY_RULESET,
  OPSTACK_MAX_ANCESTRY_DEPTH,
  opstackFail,
  runOpStackConsistencyChecks,
  validateOpStackFinalityConfig,
} from "../src/index.js";

import {
  chainHash,
  config,
  NOW,
  opstackResponses,
  opstackSource,
  scriptedOpstackFetch,
  SUBJECT_HASH,
  SUBJECT_NUMBER,
  SUBJECT_NUMBER_HEX,
} from "./helpers.js";

describe("explicit family configuration", () => {
  it("accepts the pinned explicit configuration (Base mainnet as FIRST tested network)", () => {
    validateOpStackFinalityConfig(config());
    // Any other explicitly configured OP Stack network is equally valid.
    validateOpStackFinalityConfig(config({ networkId: "eip155:10", chainId: 10 }));
  });

  it("rejects inference-shaped and malformed configurations", () => {
    expect(() => validateOpStackFinalityConfig({ ...config(), family: "op-stack" })).toThrow(/family/);
    expect(() =>
      validateOpStackFinalityConfig({
        networkId: "eip155:8453",
        chainId: 8453,
      }),
    ).toThrow(NecResolverOpStackError);
    expect(() => validateOpStackFinalityConfig({ ...config(), chainId: "8453" })).toThrow(/chainId/);
    expect(() => validateOpStackFinalityConfig({ ...config(), networkId: "not a caip2 id!" })).toThrow();
    expect(() => validateOpStackFinalityConfig(null)).toThrow(NecResolverOpStackError);
  });

  it("keeps the ruleset identifier version-pinned and the ancestry ceiling bounded", () => {
    expect(OPSTACK_FINALITY_RULESET).toBe("opstack.rpc-finalized-head-v1");
    expect(OPSTACK_FAMILY).toBe("opstack");
    expect(OPSTACK_MAX_ANCESTRY_DEPTH).toBe(10_000);
  });
});

describe("OP Stack finality acquisition pipeline", () => {
  it("performs THE exact bounded burst: identity, finalized, safe, latest, parentHash walk down to S, canonical re-read, finalized stability re-read", async () => {
    const { fetchFn, seen } = scriptedOpstackFetch(opstackResponses({}));
    const observation = await acquireOpStackFinalityObservation({
      source: opstackSource(),
      subjectBlock: { number: SUBJECT_NUMBER, hash: SUBJECT_HASH },
      now: NOW,
      fetchFn,
    });
    const h = (n: bigint): string => chainHash(n);
    expect(seen.calls).toEqual([
      "eth_chainId",
      "eth_getBlockByNumber:finalized",
      "eth_getBlockByNumber:safe",
      "eth_getBlockByNumber:latest",
      `eth_getBlockByHash:${h(SUBJECT_NUMBER + 2n)}`, // walk follows recorded parentHashes
      `eth_getBlockByHash:${h(SUBJECT_NUMBER + 1n)}`,
      `eth_getBlockByHash:${SUBJECT_HASH}`,
      `eth_getBlockByNumber:${SUBJECT_NUMBER_HEX}`,
      "eth_getBlockByNumber:finalized", // burst-stability re-read
    ]);
    expect(observation.profile).toBe(OPSTACK_ACQUISITION_PROFILE);
    expect(observation.captures).toHaveLength(9);
    expect(observation.chain.chainId).toBe(8453n);
    expect(observation.finalizedHead?.number).toBe(SUBJECT_NUMBER + 3n);
    expect(observation.safeHead?.number).toBe(SUBJECT_NUMBER + 4n);
    expect(observation.latestHead?.number).toBe(SUBJECT_NUMBER + 5n);
    expect(observation.canonicalSubjectBlock?.hash).toBe(SUBJECT_HASH);
    expect(observation.finalizedReRead?.hash).toBe(observation.finalizedHead?.hash);
    // The walk records every traversed parent down to the subject height.
    expect(observation.ancestry).toBeDefined();
    expect(observation.ancestry?.requiredDepth).toBe(3n);
    expect(observation.ancestry?.blocks.map((b) => b?.number)).toEqual([
      SUBJECT_NUMBER + 2n,
      SUBJECT_NUMBER + 1n,
      SUBJECT_NUMBER,
    ]);
    expect(observation.consistent).toBe(true);
    // No endpoint URL ever enters provenance or captures.
    expect(JSON.stringify({ source: observation.source, captures: observation.captures })).not.toContain(
      "base.example",
    );
  });

  it("records head unavailability as captured null evidence, not an error", async () => {
    const { fetchFn } = scriptedOpstackFetch(
      opstackResponses({ finalized: null, safe: null, latest: null, canonical: null }),
    );
    const observation = await acquireOpStackFinalityObservation({
      source: opstackSource(),
      subjectBlock: { number: SUBJECT_NUMBER, hash: SUBJECT_HASH },
      now: NOW,
      fetchFn,
    });
    expect(observation.safeHead).toBeNull();
    expect(observation.finalizedHead).toBeNull();
    expect(observation.latestHead).toBeNull();
    expect(observation.canonicalSubjectBlock).toBeNull();
    // No finalized head -> NO ancestry walk was required or performed.
    expect(observation.ancestry).toBeUndefined();
    expect(observation.finalizedReRead).toBeUndefined();
    // Head coherence is only assertable over OBSERVED values; the missing
    // canonical exact-height block is recorded as failed checks.
    expect(observation.checks.map((c) => c.code)).toEqual([
      "OP_CHAIN_ID_MATCHES_SOURCE",
      "OP_CANONICAL_BLOCK_NUMBER_MATCHES_SUBJECT",
      "OP_SUBJECT_BLOCK_STILL_CANONICAL",
    ]);
    expect(observation.consistent).toBe(false);
  });

  it("refuses the ancestry walk (fail closed, zero walk reads) when the required depth exceeds the configured maximum", async () => {
    const { fetchFn, seen } = scriptedOpstackFetch(
      opstackResponses({ maxAncestryDepth: 2 }), // required depth is 3
    );
    const observation = await acquireOpStackFinalityObservation({
      source: opstackSource(),
      subjectBlock: { number: SUBJECT_NUMBER, hash: SUBJECT_HASH },
      now: NOW,
      fetchFn,
      maxAncestryDepth: 2,
    });
    // Exactly the five non-walk reads happened; ancestry was never extrapolated.
    expect(seen.calls).toEqual([
      "eth_chainId",
      "eth_getBlockByNumber:finalized",
      "eth_getBlockByNumber:safe",
      "eth_getBlockByNumber:latest",
      `eth_getBlockByNumber:${SUBJECT_NUMBER_HEX}`,
    ]);
    expect(observation.captures).toHaveLength(5);
    expect(observation.finalizedReRead).toBeUndefined();
    expect(observation.ancestry).toBeDefined();
    expect(observation.ancestry?.blocks).toHaveLength(0);
    expect(observation.checks.map((c) => c.code)).toContain("OP_ANCESTRY_WALK_EXCEEDS_LIMIT");
    expect(observation.checks.find((c) => c.code === "OP_ANCESTRY_WALK_EXCEEDS_LIMIT")?.passed).toBe(false);
    expect(observation.consistent).toBe(false);
  });

  it("rejects out-of-range maxAncestryDepth configurations at the boundary", async () => {
    const { fetchFn } = scriptedOpstackFetch(opstackResponses({}));
    for (const bad of [0, -1, 10_001, 1.5, Number.NaN]) {
      await expect(
        acquireOpStackFinalityObservation({
          source: opstackSource(),
          subjectBlock: { number: SUBJECT_NUMBER, hash: SUBJECT_HASH },
          now: NOW,
          fetchFn,
          maxAncestryDepth: bad,
        }),
      ).rejects.toMatchObject({ code: "OPSTACK_CONFIG_INVALID" });
    }
  });

  it("assembles deterministic consistency checks over observed values", () => {
    const checks = runOpStackConsistencyChecks({
      expectedChainId: 8453n,
      observedChainId: 8453n,
      subjectBlockNumber: 100000n,
      subjectBlockHash: SUBJECT_HASH,
      canonicalSubjectBlock: { hash: `0x${"ff".repeat(32)}`, number: 100000n },
      safeHead: { hash: `0x${"ee".repeat(32)}`, number: 100500n },
      finalizedHead: { hash: `0x${"dd".repeat(32)}`, number: 100600n }, // ahead of safe
      latestHead: { hash: `0x${"cc".repeat(32)}`, number: 100700n },
    });
    const failed = Object.fromEntries(checks.map((c) => [c.code, c.passed]));
    expect(failed["OP_SUBJECT_BLOCK_STILL_CANONICAL"]).toBe(false);
    expect(failed["OP_FINALIZED_NOT_AHEAD_OF_SAFE"]).toBe(false);
    expect(failed["OP_SAFE_NOT_AHEAD_OF_LATEST"]).toBe(true);
    expect(failed["OP_SAFE_FINALIZED_COHERENT_AT_EQUAL_HEIGHT"]).toBe(true);
  });

  it("fails closed on invalid time or subject anchor", async () => {
    const { fetchFn } = scriptedOpstackFetch(opstackResponses({}));
    await expect(
      acquireOpStackFinalityObservation({
        source: opstackSource(),
        subjectBlock: { number: 100000n, hash: SUBJECT_HASH },
        now: "2026-08-24 12:00:00" as never,
        fetchFn,
      }),
    ).rejects.toMatchObject({ code: "OPSTACK_TIME_INVALID" });
    await expect(
      acquireOpStackFinalityObservation({
        source: opstackSource(),
        subjectBlock: { number: 100000n, hash: "0x1234" },
        now: NOW,
        fetchFn,
      }),
    ).rejects.toMatchObject({ code: "OPSTACK_SUBJECT_BLOCK_INVALID" });
    void opstackFail;
  });

  it("builds a provenance-only fixture from an observation (including repeated finalized reads)", async () => {
    const { fetchFn } = scriptedOpstackFetch(opstackResponses({}));
    const observation = await acquireOpStackFinalityObservation({
      source: opstackSource(),
      subjectBlock: { number: SUBJECT_NUMBER, hash: SUBJECT_HASH },
      now: NOW,
      fetchFn,
    });
    const fixture = buildOpStackFinalityFixture(observation);
    expect(fixture.schemaVersion).toBe("nec-resolver-opstack-fixture-v1");
    expect(fixture.source).toEqual({
      sourceId: "src.base.primary",
      sourceType: "evm_rpc",
      networkId: "eip155:8453",
      chainId: 8453,
      independenceGroup: "base-public-rpc",
    });
    expect(fixture.subjectBlock).toEqual({ number: "100000", hash: SUBJECT_HASH });
    expect(fixture.captures).toHaveLength(9);
    // The two finalized reads share one exchange key by design (burst
    // re-read); fixtures preserve them ORDERED, not deduplicated.
    const finalizedCaptures = fixture.captures.filter(
      (c) => c.rpcMethod === "eth_getBlockByNumber" && c.rpcParams[0] === "finalized",
    );
    expect(finalizedCaptures).toHaveLength(2);
    expect(JSON.stringify(fixture)).not.toContain("base.example");
  });
});
