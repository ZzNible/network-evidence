import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  acquireOpStackFinalityObservation,
  buildOpStackFinalityFixture,
  evaluateOpStackFinality,
  NecResolverOpStackError,
  replayOpStackFinalityObservation,
  validateOpStackFinalityFixture,
} from "../src/index.js";

import {
  config,
  genericAcquisition,
  NOW,
  opstackResponses,
  opstackSource,
  scriptedOpstackFetch,
  SUBJECT_HASH,
  SUBJECT_NUMBER,
} from "./helpers.js";

async function liveShapedObservation() {
  const { fetchFn } = scriptedOpstackFetch(opstackResponses({}));
  return acquireOpStackFinalityObservation({
    source: opstackSource(),
    subjectBlock: { number: SUBJECT_NUMBER, hash: SUBJECT_HASH },
    now: NOW,
    fetchFn,
  });
}

describe("offline deterministic replay", () => {
  it("I: replays twice with identical semantics (deep equality), including repeated finalized reads", async () => {
    const observation = await liveShapedObservation();
    const fixture = JSON.parse(JSON.stringify(buildOpStackFinalityFixture(observation)));
    const first = await replayOpStackFinalityObservation(fixture);
    const second = await replayOpStackFinalityObservation(fixture);
    expect(first).toEqual(second);
    expect(first.captures.map((c) => c.contentDigest)).toEqual(
      second.captures.map((c) => c.contentDigest),
    );
    // Replay reproduces the original observation byte-for-byte.
    expect(first).toEqual(observation);

    const evaluated = evaluateOpStackFinality({ config: config(), evm: await genericAcquisition(), finality: first });
    const evaluatedAgain = evaluateOpStackFinality({ config: config(), evm: await genericAcquisition(), finality: second });
    expect(evaluated.fragment).toEqual(evaluatedAgain.fragment);
  });

  it("rejects unmatched requests and unused captures", async () => {
    const observation = await liveShapedObservation();
    const fixture = buildOpStackFinalityFixture(observation);
    // Drop one capture -> the pipeline requests it -> unmatched.
    const missing = { ...fixture, captures: fixture.captures.slice(1) };
    await expect(replayOpStackFinalityObservation(missing)).rejects.toMatchObject({
      code: "OPSTACK_REPLAY_UNMATCHED_REQUEST",
    });
    // Duplicate an unrelated capture -> unused-captures failure.
    const extra = {
      ...fixture,
      captures: [
        ...fixture.captures,
        {
          rpcMethod: "eth_getBlockByNumber",
          rpcParams: ["earliest", false],
          httpStatus: 200,
          resultJson: "null",
        },
      ],
    };
    await expect(replayOpStackFinalityObservation(extra)).rejects.toMatchObject({
      code: "OPSTACK_REPLAY_UNUSED_CAPTURES",
    });
  });

  it("consumes same-key captures FIFO and fails closed when a repeated read goes unserved", async () => {
    const observation = await liveShapedObservation(); // contains TWO finalized reads
    const fixture = buildOpStackFinalityFixture(observation);
    // Remove only the SECOND finalized capture: the burst re-read then has
    // no capture left after the first is consumed -> unmatched request.
    let seenFinalized = 0;
    const withoutReRead = {
      ...fixture,
      captures: fixture.captures.filter((c) => {
        if (c.rpcMethod === "eth_getBlockByNumber" && c.rpcParams[0] === "finalized") {
          seenFinalized++;
          return seenFinalized === 1; // keep only the FIRST
        }
        return true;
      }),
    };
    await expect(replayOpStackFinalityObservation(withoutReRead)).rejects.toMatchObject({
      code: "OPSTACK_REPLAY_UNMATCHED_REQUEST",
    });
  });

  it("validates hostile fixtures fail closed", () => {
    expect(() => validateOpStackFinalityFixture(null)).toThrow(NecResolverOpStackError);
    expect(() => validateOpStackFinalityFixture({})).toThrow(NecResolverOpStackError);
    expect(() =>
      validateOpStackFinalityFixture({
        schemaVersion: "nec-resolver-opstack-fixture-v0",
        acquiredAt: NOW,
        source: {},
        subjectBlock: {},
        captures: [],
      }),
    ).toThrow(/schemaVersion/);
    expect(() =>
      validateOpStackFinalityFixture({
        schemaVersion: "nec-resolver-opstack-fixture-v1",
        acquiredAt: NOW,
        source: {
          sourceId: "src.base.primary",
          sourceType: "evm_rpc",
          networkId: "eip155:8453",
          chainId: 8453,
        },
        subjectBlock: { number: "not-decimal", hash: SUBJECT_HASH },
        captures: [
          { rpcMethod: "eth_chainId", rpcParams: [], httpStatus: 200, resultJson: '"0x2105"' },
        ],
      }),
    ).toThrow(/subjectBlock\.number/);
  });

  it("replays the committed Base mainnet finality fixture deterministically; the old subject's ancestry exceeds any honest bound -> INSUFFICIENT while execution stays supported", async () => {
    const fixturePath = fileURLToPath(new URL("./fixtures/base-mainnet-finality.fixture.json", import.meta.url));
    const raw = JSON.parse(readFileSync(fixturePath, "utf8")) as unknown;
    const fixture = validateOpStackFinalityFixture(raw);

    const replayA = await replayOpStackFinalityObservation(raw);
    const replayB = await replayOpStackFinalityObservation(raw);
    expect(replayA).toEqual(replayB);
    expect(replayA.subjectBlock.hash).toBe(fixture.subjectBlock.hash);

    // The committed fixture's provenance binds it to Base mainnet explicitly.
    expect(fixture.source.networkId).toBe("eip155:8453");
    expect(fixture.source.chainId).toBe(8453);

    // The live acquisition observed a finalized head far above the subject
    // height: the required parentHash walk exceeds ANY configured bound, so
    // the resolver refused it (fail closed) instead of inferring ancestry
    // from block numbers. Every non-walk read is still covered by replay.
    expect(replayA.ancestry).toBeDefined();
    expect(replayA.ancestry?.blocks).toHaveLength(0);
    expect(replayA.checks.map((c) => c.code)).toContain("OP_ANCESTRY_WALK_EXCEEDS_LIMIT");

    // Pair it with the package-local generic EVM acquisition fixture to
    // exercise the FULL composition path offline.
    const genericEvmFixturePath = fileURLToPath(
      new URL("./fixtures/base-mainnet-usdc-transfer.fixture.json", import.meta.url),
    );
    const genericEvmRaw = JSON.parse(readFileSync(genericEvmFixturePath, "utf8")) as unknown;
    const { replayTransactionAcquisition } = await import("@nec/resolver-evm");
    const paymentTransactionFixture = genericEvmRaw as { captures?: Array<{ rpcMethod?: string }> };
    const includeTransaction =
      Array.isArray(paymentTransactionFixture.captures) &&
      paymentTransactionFixture.captures.some((c) => c?.rpcMethod === "eth_getTransactionByHash");
    const evm = await replayTransactionAcquisition(genericEvmRaw, { includeTransaction });

    const evaluation = evaluateOpStackFinality({ config: config(), evm, finality: replayA });
    const dim = evaluation.dimension.dimension;
    // Honest v0.1 outcome for this aged subject: finality INSUFFICIENT —
    // never supported without a complete walked parentHash ancestry.
    expect(dim.verdict).toBe("insufficient");
    expect(dim.basis).toEqual(["source_observation"]);
    expect(dim.metadata?.ruleset).toBe("opstack.rpc-finalized-head-v1");
    expect(evaluation.warnings.some((w) => w.code === "OP_ANCESTRY_DEPTH_EXCEEDED")).toBe(true);
    expect(evaluation.conflicts).toHaveLength(0);

    const again = evaluateOpStackFinality({ config: config(), evm, finality: replayB });
    expect(again.fragment).toEqual(evaluation.fragment);
    const projection = JSON.stringify(evaluation.fragment, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v,
    );
    expect(projection).not.toContain("deterministic_derivation");
  });
});
