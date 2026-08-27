import { describe, expect, it } from "vitest";

import { canonicalJson, mergeConflicts, mergeWarnings, validateNetworkEvidenceFragment } from "@nec/core";
import type { NetworkEvidenceFragment } from "@nec/core";
import { evaluateTransactionAcquisition } from "@nec/resolver-evm";
import type { EvmEvaluation } from "@nec/resolver-evm";

import {
  acquireOpStackFinalityObservation,
  evaluateOpStackFinality,
  FINALITY_PROPOSITION,
  NecResolverOpStackError,
  OPSTACK_FINALITY_RULESET,
  validateOpStackFinalityConfig,
} from "../src/index.js";
import type { OpStackFinalityEvaluation } from "../src/index.js";

import {
  config,
  genericAcquisition,
  NETWORK_ID,
  NOW,
  opstackResponses,
  opstackSource,
  OTHER_HASH,
  scriptedOpstackFetch,
  SUBJECT_HASH,
  SUBJECT_NUMBER,
  TX,
} from "./helpers.js";

async function evaluate(
  opts: Parameters<typeof opstackResponses>[0],
): Promise<OpStackFinalityEvaluation> {
  return evaluateWith(opts);
}

async function evaluateWith(
  opts: Parameters<typeof opstackResponses>[0] & {
    configOverrides?: Partial<ReturnType<typeof config>>;
    maxAncestryDepth?: number;
  } = {},
): Promise<OpStackFinalityEvaluation> {
  const evm = await genericAcquisition();
  const { fetchFn } = scriptedOpstackFetch(opstackResponses(opts));
  const observation = await acquireOpStackFinalityObservation({
    source: opstackSource(),
    subjectBlock: { number: SUBJECT_NUMBER, hash: SUBJECT_HASH },
    now: NOW,
    fetchFn,
    ...(opts.maxAncestryDepth === undefined ? {} : { maxAncestryDepth: opts.maxAncestryDepth }),
  });
  return evaluateOpStackFinality({
    config: config(opts.configOverrides),
    evm,
    finality: observation,
  });
}

/** BigInt-safe projection for whole-object assertions. */
function json(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v));
}

const STANDING_CODES = [
  "CROSS_SOURCE_CONSENSUS_NOT_ESTABLISHED",
  "INDEPENDENT_L1_DERIVATION_NOT_ESTABLISHED",
  "LOCAL_ROLLUP_NODE_VERIFICATION_NOT_ESTABLISHED",
  "WITHDRAWAL_FINALIZATION_NOT_EVALUATED",
] as const;

/** Merge two fragment evidence tables by id (shared refs are identical). */
function mergeEvidenceTables(
  a: readonly NetworkEvidenceFragment["evidence"][number][],
  b: readonly NetworkEvidenceFragment["evidence"][number][],
): NetworkEvidenceFragment["evidence"] {
  const byId = new Map<string, NetworkEvidenceFragment["evidence"][number]>();
  for (const ref of [...a, ...b]) {
    const existing = byId.get(ref.id);
    if (existing !== undefined && canonicalJson(existing) !== canonicalJson(ref)) {
      throw new Error(`evidence id collision with different content: ${ref.id}`);
    }
    byId.set(ref.id, ref);
  }
  return [...byId.values()].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

function mergeFinalityInto(
  generic: NetworkEvidenceFragment,
  finality: NetworkEvidenceFragment,
): NetworkEvidenceFragment {
  return {
    network: generic.network,
    subject: generic.subject,
    networkEvidence: {
      ...generic.networkEvidence,
      finality: finality.networkEvidence.finality,
    },
    evidence: mergeEvidenceTables(generic.evidence, finality.evidence),
    conflicts: mergeConflicts(generic.conflicts, finality.conflicts),
    warnings: mergeWarnings(generic.warnings, finality.warnings),
  };
}

describe("OP Stack finality evaluation (case matrix)", () => {
  it("A: complete walked finalized->subject ancestry at/below the finalized head -> SUPPORTED with basis EXACTLY [source_observation]", async () => {
    const result = await evaluate({});
    const dim = result.dimension.dimension;
    expect(dim.applicability).toBe("applicable");
    expect(dim.verdict).toBe("supported");
    // THE corrected basis contract: direct source observation ONLY.
    expect(dim.basis).toEqual(["source_observation"]);
    expect(dim.metadata?.ruleset).toBe(OPSTACK_FINALITY_RULESET);
    expect(dim.metadata?.rulesetVersion).toBe("1");
    expect(dim.metadata?.family).toBe("opstack");
    expect(result.fragment.networkEvidence.finality?.verdict).toBe("supported");
    // Fragment carries ONLY the finality dimension (settlement never populated).
    expect(Object.keys(result.fragment.networkEvidence).sort()).toEqual(["finality"]);
    expect(result.dimension.proposition).toBe(FINALITY_PROPOSITION);
    // Positive support cites walked ancestry endpoints and the stability re-read.
    expect(dim.evidence.some((id) => id.startsWith("opstack-ancestry-block-"))).toBe(true);
    expect(dim.metadata?.ancestryRequiredDepth).toBe("3");
    expect(dim.metadata?.ancestryWalkedLinks).toBe("3");
    expect(json(result)).not.toContain("deterministic_derivation");
  });

  it("deterministic_derivation NEVER appears in ANY evaluation (positive or negative)", async () => {
    for (const result of [
      await evaluate({}),
      await evaluate({ finalized: SUBJECT_NUMBER - 1n }), // safe-but-not-finalized
      await evaluate({ canonical: { number: SUBJECT_NUMBER, hash: OTHER_HASH } }),
      await evaluate({ finalized: null }),
      await evaluate({ maxAncestryDepth: 1 }), // walk beyond bound
      await evaluate({ latest: SUBJECT_NUMBER + 3n }), // safe > latest
    ]) {
      expect(json(result)).not.toContain("deterministic_derivation");
      expect(result.dimension.dimension.basis).toEqual(["source_observation"]);
    }
  });

  it("B: subject above finalized head but within safe head -> safe-but-NOT-finalized, insufficient", async () => {
    const result = await evaluate({
      finalized: SUBJECT_NUMBER - 1n,
      canonical: { number: SUBJECT_NUMBER, hash: SUBJECT_HASH },
    });
    const dim = result.dimension.dimension;
    expect(dim.verdict).toBe("insufficient");
    expect(dim.reason).toMatch(/Safe-but-not-finalized/i);
    expect(result.warnings.some((w) => w.code === "OP_SAFE_BUT_NOT_FINALIZED")).toBe(true);
    expect(result.conflicts).toHaveLength(0);
  });

  it("C: subject above even the safe head -> finality not established", async () => {
    const result = await evaluate({
      finalized: SUBJECT_NUMBER - 10n,
      safe: SUBJECT_NUMBER - 5n,
      canonical: { number: SUBJECT_NUMBER, hash: SUBJECT_HASH },
    });
    const dim = result.dimension.dimension;
    expect(dim.verdict).toBe("insufficient");
    expect(dim.reason).toMatch(/exceeds this source's observed safe head/);
    expect(result.warnings.some((w) => w.code === "OP_ABOVE_SAFE_HEAD")).toBe(true);
  });

  it("D: canonical exact-height hash != subject hash -> CONTRADICTED, never supported", async () => {
    const result = await evaluate({ canonical: { number: SUBJECT_NUMBER, hash: OTHER_HASH } });
    const dim = result.dimension.dimension;
    expect(dim.verdict).toBe("contradicted");
    expect(dim.basis).toEqual(["source_observation"]);
    // No material conflict invented for a clean negative observation.
    expect(result.conflicts).toHaveLength(0);
    expect(result.warnings.some((w) => w.code === "OP_SUBJECT_NOT_CANONICAL_AT_HEIGHT")).toBe(true);
    expect(result.fragment.networkEvidence.finality?.verdict).toBe("contradicted");
  });

  it("E: missing finalized response -> finality INSUFFICIENT (never substituted by safe/latest)", async () => {
    const result = await evaluate({
      finalized: null,
      canonical: { number: SUBJECT_NUMBER, hash: SUBJECT_HASH },
    });
    const dim = result.dimension.dimension;
    expect(dim.verdict).toBe("insufficient");
    expect(result.warnings.some((w) => w.code === "OP_FINALIZED_HEAD_UNAVAILABLE")).toBe(true);
    expect(result.conflicts).toHaveLength(0);
  });

  it("E2: missing latest response -> finality INSUFFICIENT (ordering unverifiable)", async () => {
    const result = await evaluate({
      latest: null,
      canonical: { number: SUBJECT_NUMBER, hash: SUBJECT_HASH },
    });
    const dim = result.dimension.dimension;
    expect(dim.verdict).toBe("insufficient");
    expect(result.warnings.some((w) => w.code === "OP_LATEST_HEAD_UNAVAILABLE")).toBe(true);
    expect(result.conflicts).toHaveLength(0);
  });

  it("F: network mismatch between evidence and configuration -> fail closed", async () => {
    const evm = await genericAcquisition();
    const { fetchFn } = scriptedOpstackFetch(opstackResponses({}));
    const observation = await acquireOpStackFinalityObservation({
      source: opstackSource(),
      subjectBlock: { number: SUBJECT_NUMBER, hash: SUBJECT_HASH },
      now: NOW,
      fetchFn,
    });
    // Subject-only mismatch (generic evidence from a different network).
    const subjectMismatch = evaluateOpStackFinality({
      config: config(),
      evm: { ...evm, source: { ...evm.source, networkId: "eip155:11155111", chainId: 11155111 } },
      finality: observation,
    });
    expect(subjectMismatch.dimension.dimension.verdict).toBe("insufficient");
    expect(subjectMismatch.warnings.some((w) => w.code === "OP_SUBJECT_NETWORK_MISMATCH")).toBe(true);
    expect(subjectMismatch.warnings.some((w) => w.code === "OP_OBSERVATION_NETWORK_MISMATCH")).toBe(false);

    // Observation-only mismatch.
    const observationMismatch = evaluateOpStackFinality({
      config: config(),
      evm,
      finality: { ...observation, source: { ...observation.source, networkId: "eip155:10", chainId: 10 } },
    });
    expect(observationMismatch.dimension.dimension.verdict).toBe("insufficient");
    expect(observationMismatch.warnings.some((w) => w.code === "OP_OBSERVATION_NETWORK_MISMATCH")).toBe(true);
    expect(observationMismatch.warnings.some((w) => w.code === "OP_SUBJECT_NETWORK_MISMATCH")).toBe(false);
  });

  it("G: family/ruleset not explicitly configured -> fail closed (throws)", async () => {
    const evm = await genericAcquisition();
    const { fetchFn } = scriptedOpstackFetch(opstackResponses({}));
    const observation = await acquireOpStackFinalityObservation({
      source: opstackSource(),
      subjectBlock: { number: SUBJECT_NUMBER, hash: SUBJECT_HASH },
      now: NOW,
      fetchFn,
    });
    expect(() =>
      evaluateOpStackFinality({
        config: config({ family: "ethereum" as never }),
        evm,
        finality: observation,
      }),
    ).toThrow(/family/);
    expect(() =>
      evaluateOpStackFinality({
        config: config({ ruleset: "universal-finality-v9" as never }),
        evm,
        finality: observation,
      }),
    ).toThrow(/ruleset/);
    expect(() =>
      evaluateOpStackFinality({
        config: config({ rulesetVersion: "2" as never }),
        evm,
        finality: observation,
      }),
    ).toThrow(/rulesetVersion/);
    expect(() =>
      validateOpStackFinalityConfig({ ...config(), extra: true }),
    ).toThrow(NecResolverOpStackError);
  });

  it("H: finalized ahead of safe -> material conflict forces AMBIGUOUS", async () => {
    // Finalized head exactly at the subject height (zero-depth walk), safe below.
    const inverted = await evaluate({ finalized: SUBJECT_NUMBER, safe: SUBJECT_NUMBER - 1n });
    expect(inverted.dimension.dimension.verdict).toBe("ambiguous");
    expect(inverted.conflicts.map((c) => c.code)).toContain("OP_FINALIZED_NOT_AHEAD_OF_SAFE");
    expect(inverted.conflicts.every((c) => c.material)).toBe(true);
    expect(
      inverted.conflicts.every((c) => c.scope.kind === "dimension" && c.scope.dimension === "finality"),
    ).toBe(true);
  });

  it("H2: equal-height safe/finalized hash divergence -> material conflict forces AMBIGUOUS", async () => {
    const divergent = await evaluate({
      finalized: SUBJECT_NUMBER, // zero-depth walk: no ancestry reads
      finalizedHash: SUBJECT_HASH,
      safe: SUBJECT_NUMBER,
      safeHash: OTHER_HASH,
    });
    expect(divergent.dimension.dimension.verdict).toBe("ambiguous");
    expect(divergent.conflicts.map((c) => c.code)).toContain(
      "OP_SAFE_FINALIZED_COHERENT_AT_EQUAL_HEIGHT",
    );
  });

  it("H3: safe ahead of latest -> material conflict forces AMBIGUOUS", async () => {
    const result = await evaluate({ latest: SUBJECT_NUMBER + 3n }); // safe = S+4 > latest
    expect(result.dimension.dimension.verdict).toBe("ambiguous");
    expect(result.conflicts.map((c) => c.code)).toContain("OP_SAFE_NOT_AHEAD_OF_LATEST");
    expect(result.conflicts.every((c) => c.material)).toBe(true);
  });

  it("H4: missing canonical block at a past mined height -> material conflict -> AMBIGUOUS", async () => {
    const result = await evaluate({ canonical: null });
    expect(result.dimension.dimension.verdict).toBe("ambiguous");
    expect(result.conflicts.map((c) => c.code)).toContain("OP_CANONICAL_BLOCK_NUMBER_MATCHES_SUBJECT");
  });

  it("ANCESTRY-1: broken parentHash identity link cannot support -> AMBIGUOUS via OP_ANCESTRY_HASH_CHAIN", async () => {
    const result = await evaluate({ ancestryBreak: "parent-hash" });
    expect(result.dimension.dimension.verdict).toBe("ambiguous");
    expect(result.conflicts.map((c) => c.code)).toContain("OP_ANCESTRY_HASH_CHAIN");
    expect(result.conflicts.map((c) => c.code)).not.toContain("OP_ANCESTRY_HEIGHT_SEQUENCE");
    expect(result.conflicts.every((c) => c.material)).toBe(true);
  });

  it("ANCESTRY-2: broken height sequence link cannot support -> AMBIGUOUS via OP_ANCESTRY_HEIGHT_SEQUENCE", async () => {
    const result = await evaluate({ ancestryBreak: "parent-number" });
    expect(result.dimension.dimension.verdict).toBe("ambiguous");
    expect(result.conflicts.map((c) => c.code)).toContain("OP_ANCESTRY_HEIGHT_SEQUENCE");
    expect(result.conflicts.map((c) => c.code)).not.toContain("OP_ANCESTRY_HASH_CHAIN");
  });

  it("ANCESTRY-3: missing ancestor block mid-walk cannot support -> AMBIGUOUS", async () => {
    const result = await evaluate({ ancestryBreak: "null-parent" });
    expect(result.dimension.dimension.verdict).toBe("ambiguous");
    for (const code of ["OP_ANCESTRY_HEIGHT_SEQUENCE", "OP_ANCESTRY_HASH_CHAIN"]) {
      expect(result.conflicts.map((c) => c.code)).toContain(code);
    }
    // The walk truncated at the break; no stability re-read ever happened.
    expect(result.conflicts.map((c) => c.code)).not.toContain("OP_FINALIZED_HEAD_STABLE");
  });

  it("ANCESTRY-4: walked terminal block differs from subject while canonical view agrees with source -> CONFLICT -> AMBIGUOUS", async () => {
    // The source's finalized chain terminates at S on a DIFFERENT block, yet
    // its canonical exact-height view still claims the subject block: the two
    // observations contradict each other -> material conflict, ambiguous.
    const result = await evaluate({ ancestryBreak: "terminal-hash" });
    expect(result.dimension.dimension.verdict).toBe("ambiguous");
    expect(result.conflicts.map((c) => c.code)).toContain("OP_ANCESTRY_TERMINAL_MATCHES_SUBJECT");
  });

  it("ANCESTRY-5: walked terminal AND canonical both differ from subject -> clean CONTRADICTED negative", async () => {
    const result = await evaluate({
      ancestryBreak: "terminal-hash",
      canonical: { number: SUBJECT_NUMBER, hash: OTHER_HASH },
    });
    expect(result.dimension.dimension.verdict).toBe("contradicted");
    expect(result.conflicts).toHaveLength(0);
    expect(result.warnings.some((w) => w.code === "OP_SUBJECT_NOT_CANONICAL_AT_HEIGHT")).toBe(true);
  });

  it("STABILITY-1: finalized head changes between first and final read -> AMBIGUOUS via OP_FINALIZED_HEAD_STABLE", async () => {
    const result = await evaluate({
      finalizedReRead: { hash: OTHER_HASH },
    });
    expect(result.dimension.dimension.verdict).toBe("ambiguous");
    expect(result.conflicts.map((c) => c.code)).toContain("OP_FINALIZED_HEAD_STABLE");
    expect(result.conflicts.every((c) => c.material)).toBe(true);
  });

  it("STABILITY-2: finalized head vanishes during the burst -> AMBIGUOUS", async () => {
    const result = await evaluate({ finalizedReRead: null });
    expect(result.dimension.dimension.verdict).toBe("ambiguous");
    expect(result.conflicts.map((c) => c.code)).toContain("OP_FINALIZED_HEAD_STABLE");
  });

  it("DEPTH-1: required ancestry beyond maxAncestryDepth -> INSUFFICIENT (fail closed, no walk)", async () => {
    const result = await evaluate({ maxAncestryDepth: 2 }); // required depth is 3
    const dim = result.dimension.dimension;
    expect(dim.verdict).toBe("insufficient");
    expect(dim.basis).toEqual(["source_observation"]);
    expect(dim.reason).toMatch(/could not be established/i);
    const warning = result.warnings.find((w) => w.code === "OP_ANCESTRY_DEPTH_EXCEEDED");
    expect(warning).toBeDefined();
    expect(warning?.metadata).toMatchObject({ requiredDepth: "3", maxAncestryDepth: 2 });
    expect(result.conflicts).toHaveLength(0);
  });

  it("DEPTH-2: a zero-depth walk (finalized head exactly at S) can support finality", async () => {
    const result = await evaluate({
      finalized: SUBJECT_NUMBER,
      finalizedHash: SUBJECT_HASH,
      safe: SUBJECT_NUMBER + 1n,
      latest: SUBJECT_NUMBER + 2n,
    });
    const dim = result.dimension.dimension;
    expect(dim.verdict).toBe("supported");
    expect(dim.metadata?.ancestryRequiredDepth).toBe("0");
    expect(dim.metadata?.ancestryWalkedLinks).toBe("0");
    expect(dim.evidence.some((id) => id.startsWith("opstack-ancestry-block-"))).toBe(false);
  });

  it("standing non-claims are present in EVERY scenario", async () => {
    const scenarios = [
      await evaluate({}),
      await evaluate({ canonical: { number: SUBJECT_NUMBER, hash: OTHER_HASH } }),
      await evaluate({ finalized: null }),
      await evaluate({ maxAncestryDepth: 1 }),
    ];
    for (const result of scenarios) {
      const codes = result.warnings.map((w) => w.code);
      for (const code of STANDING_CODES) expect(codes, code).toContain(code);
    }
    // The standing limitations document what "finalized" does NOT mean.
    const withdrawal = scenarios[0]!.warnings.find(
      (w) => w.code === "WITHDRAWAL_FINALIZATION_NOT_EVALUATED",
    );
    expect(withdrawal?.message).toMatch(/not withdrawal finalization/i);
    expect(withdrawal?.message).toMatch(/finalized view/i);
  });

  it("unbound generic evidence keeps finality applicability UNKNOWN (never a verdict)", async () => {
    const evm = await genericAcquisition({ receipt: { transactionHash: TX.replace("cf496b", "ff496b") } });
    const { fetchFn } = scriptedOpstackFetch(opstackResponses({}));
    const observation = await acquireOpStackFinalityObservation({
      source: opstackSource(),
      subjectBlock: { number: SUBJECT_NUMBER, hash: SUBJECT_HASH },
      now: NOW,
      fetchFn,
    });
    const result = evaluateOpStackFinality({ config: config(), evm, finality: observation });
    expect(result.dimension.dimension.applicability).toBe("unknown");
    expect(result.dimension.dimension.verdict).toBeUndefined();
    expect(result.warnings.some((w) => w.code === "OP_GENERIC_BINDING_NOT_ESTABLISHED")).toBe(true);
  });

  it("J/K: dimensions stay independent — execution remains supported while finality is insufficient or contradicted", async () => {
    const evm = await genericAcquisition();
    const generic: EvmEvaluation = evaluateTransactionAcquisition(evm);
    expect(generic.dimensions.execution.dimension.verdict).toBe("supported");

    // J: insufficient finality (safe-but-not-finalized)
    const { fetchFn } = scriptedOpstackFetch(
      opstackResponses({
        finalized: SUBJECT_NUMBER - 1n,
        canonical: { number: SUBJECT_NUMBER, hash: SUBJECT_HASH },
      }),
    );
    const observation = await acquireOpStackFinalityObservation({
      source: opstackSource(),
      subjectBlock: { number: SUBJECT_NUMBER, hash: SUBJECT_HASH },
      now: NOW,
      fetchFn,
    });
    const insufficiency = evaluateOpStackFinality({ config: config(), evm, finality: observation });
    const mergedJ = mergeFinalityInto(generic.fragment, insufficiency.fragment);
    expect(mergedJ.networkEvidence.execution?.verdict).toBe("supported");
    expect(mergedJ.networkEvidence.dataBinding?.verdict).toBe("supported");
    expect(mergedJ.networkEvidence.finality?.verdict).toBe("insufficient");
    validateNetworkEvidenceFragment(mergedJ);

    // K: contradicted finality must not rewrite execution history
    const { fetchFn: fetchFn2 } = scriptedOpstackFetch(
      opstackResponses({ canonical: { number: SUBJECT_NUMBER, hash: OTHER_HASH } }),
    );
    const conflicting = await acquireOpStackFinalityObservation({
      source: opstackSource(),
      subjectBlock: { number: SUBJECT_NUMBER, hash: SUBJECT_HASH },
      now: NOW,
      fetchFn: fetchFn2,
    });
    const contradiction = evaluateOpStackFinality({ config: config(), evm, finality: conflicting });
    const mergedK = mergeFinalityInto(generic.fragment, contradiction.fragment);
    expect(mergedK.networkEvidence.execution?.verdict).toBe("supported");
    expect(mergedK.networkEvidence.finality?.verdict).toBe("contradicted");
    // Execution history byte-stable:
    expect(mergedK.networkEvidence.execution).toEqual(generic.fragment.networkEvidence.execution);
    expect(mergedK.networkEvidence.observedEffects).toEqual(generic.fragment.networkEvidence.observedEffects);
    validateNetworkEvidenceFragment(mergedK);

    // J2: even depth-refused finality leaves execution untouched.
    const { fetchFn: fetchFn3 } = scriptedOpstackFetch(opstackResponses({ maxAncestryDepth: 1 }));
    const depthRefused = await acquireOpStackFinalityObservation({
      source: opstackSource(),
      subjectBlock: { number: SUBJECT_NUMBER, hash: SUBJECT_HASH },
      now: NOW,
      fetchFn: fetchFn3,
      maxAncestryDepth: 1,
    });
    const refused = evaluateOpStackFinality({ config: config(), evm, finality: depthRefused });
    const mergedJ2 = mergeFinalityInto(generic.fragment, refused.fragment);
    expect(mergedJ2.networkEvidence.finality?.verdict).toBe("insufficient");
    expect(mergedJ2.networkEvidence.execution?.verdict).toBe("supported");
    validateNetworkEvidenceFragment(mergedJ2);
  });

  it("fragment evidence citations resolve within its own table (self-contained)", async () => {
    for (const scenario of [
      {},
      { finalizedReRead: { hash: OTHER_HASH } }, // unstable burst still cites resolvable ids
      { ancestryBreak: "null-parent" as const },
    ]) {
      const result = await evaluate(scenario);
      const ids = new Set(result.fragment.evidence.map((r) => r.id));
      for (const id of result.dimension.dimension.evidence) expect(ids.has(id), id).toBe(true);
      for (const conflict of result.fragment.conflicts) {
        for (const id of conflict.evidence) expect(ids.has(id), `${conflict.id}:${id}`).toBe(true);
      }
      expect(result.fragment.subject).toEqual({ type: "transaction", networkId: NETWORK_ID, txId: TX });
      expect(result.fragment.network.chainId).toBe(8453);
    }
  });

  it("chain identity gate fails closed at acquisition", async () => {
    const { fetchFn } = scriptedOpstackFetch(opstackResponses({ chainIdHex: "0x2104" }));
    await expect(
      acquireOpStackFinalityObservation({
        source: opstackSource(),
        subjectBlock: { number: SUBJECT_NUMBER, hash: SUBJECT_HASH },
        now: NOW,
        fetchFn,
      }),
    ).rejects.toMatchObject({ code: "OPSTACK_NETWORK_MISMATCH" });
  });

  it("refuses implicit global network access", async () => {
    await expect(
      acquireOpStackFinalityObservation({
        source: opstackSource(),
        subjectBlock: { number: SUBJECT_NUMBER, hash: SUBJECT_HASH },
        now: NOW,
        fetchFn: undefined,
      }),
    ).rejects.toMatchObject({ code: "OPSTACK_RPC_REQUEST_FAILED" });
  });
});
