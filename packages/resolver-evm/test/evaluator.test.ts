import { describe, expect, it, vi } from "vitest";

import { validateNetworkEvidenceFragment } from "@nec/core";

import { ACQUISITION_PROFILE, acquireTransactionObservation } from "../src/index.js";
import type { EvmTransactionAcquisition } from "../src/index.js";
import { buildEvidenceRefs } from "../src/evidence.js";
import {
  DATA_BINDING_PROPOSITION,
  DIMENSIONS_NOT_EVALUATED_WARNING,
  EXECUTION_PROPOSITION,
  evaluateTransactionAcquisition,
} from "../src/evaluator.js";
import {
  CHAIN_ID_DEC,
  NETWORK_ID,
  NOW,
  TX,
  OTHER_TX,
  TOKEN,
  happyPathResponses,
  scriptedFetch,
  source,
  successBlockResultText,
  successReceiptResultText,
  successTransactionResultText,
  transferLog,
} from "./helpers.js";

const OTHER_BLOCK = `0x${"ee".repeat(32)}`;
const HUGE_HEX = `0x${(10n ** 30n).toString(16)}`;

async function acquire(
  opts: Parameters<typeof happyPathResponses>[0] = {},
): Promise<EvmTransactionAcquisition> {
  const { fetchFn } = scriptedFetch(happyPathResponses(opts));
  return acquireTransactionObservation({
    source: source(),
    txHash: TX,
    now: NOW,
    fetchFn,
    ...(opts.transaction !== undefined ? { includeTransaction: true } : {}),
  });
}

function logObject(logIndexHex: string, overrides: Record<string, unknown> = {}): object {
  return JSON.parse(transferLog(logIndexHex, overrides)) as object;
}

/** Every scenario exercised by the adversarial loop below. */
const SCENARIOS: Record<string, Parameters<typeof happyPathResponses>[0]> = {
  success: { block: successBlockResultText() },
  successWithLogs: {
    receipt: successReceiptResultText({
      logs: [logObject("0x0"), logObject("0x1")],
    }),
    block: successBlockResultText(),
  },
  successWithCoherentTransaction: {
    receipt: successReceiptResultText(),
    block: successBlockResultText(),
    transaction: successTransactionResultText(),
  },
  revert: {
    receipt: successReceiptResultText({ status: "0x0", gasUsed: "0x1194", cumulativeGasUsed: "0x1194" }),
    block: successBlockResultText(),
  },
  nullReceipt: { receipt: "null" },
  blockMissingAfterReceipt: { block: "null" },
  blockHashMismatch: { block: successBlockResultText({ hash: OTHER_BLOCK }) },
  blockNumberMismatch: { block: successBlockResultText({ number: "0x186a1" }) },
  receiptForOtherTx: {
    receipt: successReceiptResultText({ transactionHash: OTHER_TX }),
    block: successBlockResultText(),
  },
  transactionIncoherentWithReceipt: {
    receipt: successReceiptResultText(),
    block: successBlockResultText(),
    transaction: successTransactionResultText({ blockNumber: "0x186a1" }),
  },
  removedLog: {
    receipt: successReceiptResultText({ logs: [logObject("0x0", { removed: true })] }),
    block: successBlockResultText(),
  },
  logFromWrongBlock: {
    receipt: successReceiptResultText({
      logs: [logObject("0x0", { blockHash: OTHER_BLOCK })],
    }),
    block: successBlockResultText(),
  },
  logFromWrongTransaction: {
    receipt: successReceiptResultText({
      logs: [logObject("0x0", { transactionHash: OTHER_TX })],
    }),
    block: successBlockResultText(),
  },
  mixedGoodAndBadLogs: {
    receipt: successReceiptResultText({
      logs: [logObject("0x0"), logObject("0x1", { removed: true }), logObject("0x2")],
    }),
    block: successBlockResultText(),
  },
  hugeQuantities: {
    receipt: successReceiptResultText({
      blockNumber: HUGE_HEX,
      logs: [logObject("0x0", { blockNumber: HUGE_HEX })],
    }),
    block: successBlockResultText({ number: HUGE_HEX }),
  },
};

async function evaluate(name: keyof typeof SCENARIOS) {
  const acquisition = await acquire(SCENARIOS[name]);
  return { acquisition, evaluation: evaluateTransactionAcquisition(acquisition) };
}

// ---------------------------------------------------------------------------
// PASS 1 — minimal happy path
// ---------------------------------------------------------------------------

describe("PASS 1: coherent successful observation", () => {
  it("supports execution and data binding with provenance and precise propositions", async () => {
    const { evaluation } = await evaluate("success");

    expect(evaluation.profile).toBe("nec-resolver-evm-evaluation-v1");
    expect(evaluation.dimensions.execution.dimension.applicability).toBe("applicable");
    expect(evaluation.dimensions.execution.dimension.verdict).toBe("supported");
    expect(evaluation.dimensions.execution.proposition).toBe(EXECUTION_PROPOSITION);
    expect(evaluation.dimensions.execution.dimension.basis.length).toBeGreaterThan(0);
    expect(evaluation.dimensions.execution.dimension.evidence.length).toBeGreaterThan(0);

    expect(evaluation.dimensions.dataBinding.dimension.verdict).toBe("supported");
    expect(evaluation.dimensions.dataBinding.proposition).toBe(DATA_BINDING_PROPOSITION);
    expect(evaluation.conflicts).toEqual([]);
  });

  it("keeps the single-source limit explicit in the supported-execution reason", async () => {
    const { evaluation } = await evaluate("success");
    expect(evaluation.dimensions.execution.dimension.reason).toMatch(/not a settlement or finality claim/);
  });

  it("warns when the transaction cross-check was not part of the acquisition", async () => {
    const { evaluation } = await evaluate("success");
    expect(evaluation.warnings.map((w) => w.code)).toContain("EVM_TRANSACTION_NOT_ACQUIRED");
  });

  it("does not warn about an unacquired transaction when one was coherently acquired", async () => {
    const { evaluation } = await evaluate("successWithCoherentTransaction");
    expect(evaluation.warnings.map((w) => w.code)).not.toContain("EVM_TRANSACTION_NOT_ACQUIRED");
    expect(evaluation.dimensions.dataBinding.dimension.verdict).toBe("supported");
  });

  it("emits generic evm.log observed effects only for coherent logs of a bound receipt", async () => {
    const { evaluation } = await evaluate("successWithLogs");
    expect(evaluation.observedEffects).toHaveLength(2);
    for (const effect of evaluation.observedEffects) {
      expect(effect.type).toBe("evm.log");
      expect(effect.fields.removed).toBe(false);
      expect(effect.fields.address).toBe(TOKEN);
    }
  });

  it("omits settlement and finality entirely (PASS 7 guard)", async () => {
    const { evaluation } = await evaluate("success");
    // A successful receipt and an observed block answer neither question, so
    // neither dimension may appear anywhere — not as insufficient placeholders.
    expect(evaluation.fragment.networkEvidence).not.toHaveProperty("settlement");
    expect(evaluation.fragment.networkEvidence).not.toHaveProperty("finality");
    expect(Object.keys(evaluation.dimensions).sort()).toEqual(["dataBinding", "execution"]);
    expect(evaluation.dimensions.execution.dimension.verdict).toBe("supported");
    expect(evaluation.dimensions.execution.proposition).toBe(EXECUTION_PROPOSITION);
    expect(evaluation.dimensions.dataBinding.proposition).toBe(DATA_BINDING_PROPOSITION);
  });

  it("emits exactly one deterministic not-evaluated warning listing finality + settlement", async () => {
    const { evaluation } = await evaluate("success");
    const warnings = evaluation.warnings.filter((w) => w.code === "EVM_DIMENSIONS_NOT_EVALUATED");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toEqual(DIMENSIONS_NOT_EVALUATED_WARNING);
    expect(warnings[0]?.message).toMatch(/does not evaluate settlement or network-specific finality/);
    expect(warnings[0]?.metadata?.dimensions).toEqual(["finality", "settlement"]);
  });
});

// ---------------------------------------------------------------------------
// PASS 3 — reverted transaction
// ---------------------------------------------------------------------------

describe("PASS 3: reverted transaction", () => {
  it("contradicts successful execution without denying that execution happened", async () => {
    const { evaluation } = await evaluate("revert");
    expect(evaluation.dimensions.execution.dimension.applicability).toBe("applicable");
    expect(evaluation.dimensions.execution.dimension.verdict).toBe("contradicted");
    expect(evaluation.dimensions.execution.dimension.reason).toMatch(/reverted/);
    expect(evaluation.conflicts).toEqual([]);
  });

  it("still omits settlement and finality from the fragment", async () => {
    const { evaluation } = await evaluate("revert");
    expect(evaluation.fragment.networkEvidence).not.toHaveProperty("settlement");
    expect(evaluation.fragment.networkEvidence).not.toHaveProperty("finality");
    expect(evaluation.dimensions).not.toHaveProperty("settlement");
    expect(evaluation.dimensions).not.toHaveProperty("finality");
  });
});

// ---------------------------------------------------------------------------
// PASS 2 — null / missing evidence
// ---------------------------------------------------------------------------

describe("PASS 2: null receipt and missing evidence", () => {
  it("treats a null receipt as insufficient, never contradicted", async () => {
    const { evaluation } = await evaluate("nullReceipt");
    expect(evaluation.dimensions.execution.dimension.applicability).toBe("applicable");
    expect(evaluation.dimensions.execution.dimension.verdict).toBe("insufficient");
    expect(evaluation.dimensions.execution.dimension.reason).toMatch(/null receipt/);
  });

  it("invents no conflict for a null receipt and warns explicitly", async () => {
    const { evaluation } = await evaluate("nullReceipt");
    expect(evaluation.conflicts).toEqual([]);
    expect(evaluation.warnings.map((w) => w.code)).toContain("EVM_RECEIPT_NOT_OBSERVED");
    expect(evaluation.observedEffects).toEqual([]);
  });

  it("leaves data binding unestablished without a receipt", async () => {
    const { evaluation } = await evaluate("nullReceipt");
    expect(evaluation.dimensions.dataBinding.dimension.verdict).toBe("insufficient");
  });

  it("builds a valid fragment whose fingerprint carries no block anchor", async () => {
    const { evaluation } = await evaluate("nullReceipt");
    expect(() => validateNetworkEvidenceFragment(evaluation.fragment)).not.toThrow();
    expect(evaluation.fragment.network.observedAt).toEqual({});
  });

  it("reports unknown applicability everywhere for an acquisition with no captures", () => {
    const degenerate = {
      profile: ACQUISITION_PROFILE,
      source: { sourceId: "src.degenerate", sourceType: "evm_rpc", networkId: NETWORK_ID, chainId: CHAIN_ID_DEC },
      subject: { txHash: TX },
      acquiredAt: NOW,
      chain: { chainId: BigInt(CHAIN_ID_DEC) },
      receipt: undefined,
      captures: [],
      checks: [],
      consistent: true,
    } as unknown as EvmTransactionAcquisition;

    const evaluation = evaluateTransactionAcquisition(degenerate);
    for (const name of ["execution", "dataBinding"] as const) {
      expect(evaluation.dimensions[name].dimension.applicability).toBe("unknown");
      expect(evaluation.dimensions[name].dimension.verdict).toBeUndefined();
    }
    expect(Object.keys(evaluation.dimensions).sort()).toEqual(["dataBinding", "execution"]);
    expect(evaluation.fragment.networkEvidence).not.toHaveProperty("settlement");
    expect(evaluation.fragment.networkEvidence).not.toHaveProperty("finality");
    expect(evaluation.warnings.map((w) => w.code)).toContain("EVM_NO_EVIDENCE_ACQUIRED");
    expect(evaluation.warnings.map((w) => w.code)).toContain("EVM_DIMENSIONS_NOT_EVALUATED");
    expect(evaluation.conflicts).toEqual([]);
    expect(() => validateNetworkEvidenceFragment(evaluation.fragment)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// PASS 4 — every failed consistency check becomes a scoped material conflict
// ---------------------------------------------------------------------------

describe("PASS 4: structural incoherence -> explicit scoped conflicts", () => {
  it("block missing after receipt forces execution ambiguous", async () => {
    const { evaluation } = await evaluate("blockMissingAfterReceipt");
    expect(evaluation.conflicts.map((c) => c.code)).toContain("RECEIPT_BLOCK_HASH_MATCHES_BLOCK");
    expect(evaluation.dimensions.execution.dimension.verdict).toBe("ambiguous");
    const conflict = evaluation.conflicts.find((c) => c.code === "RECEIPT_BLOCK_HASH_MATCHES_BLOCK");
    expect(conflict?.material).toBe(true);
    expect((conflict?.metadata as { checkDetail?: string }).checkDetail).toMatch(/returned no block/);
    expect(conflict?.scope).toEqual({ kind: "dimension", dimension: "execution" });
  });

  it("block hash mismatch forces execution ambiguous and cites both observations", async () => {
    const { acquisition, evaluation } = await evaluate("blockHashMismatch");
    const refs = buildEvidenceRefs(acquisition).map((r) => r.id);
    expect(evaluation.dimensions.execution.dimension.verdict).toBe("ambiguous");
    const conflict = evaluation.conflicts.find((c) => c.code === "RECEIPT_BLOCK_HASH_MATCHES_BLOCK");
    expect(conflict?.scope).toEqual({ kind: "dimension", dimension: "execution" });
    expect(conflict!.evidence.length).toBeGreaterThanOrEqual(2);
    for (const id of conflict!.evidence) expect(refs).toContain(id);
    // Unaffected dimension stays clean.
    expect(evaluation.dimensions.dataBinding.dimension.verdict).toBe("supported");
  });

  it("block number mismatch forces execution ambiguous without touching data binding", async () => {
    const { evaluation } = await evaluate("blockNumberMismatch");
    expect(evaluation.conflicts.map((c) => c.code)).toContain("RECEIPT_BLOCK_NUMBER_MATCHES_BLOCK");
    expect(evaluation.dimensions.execution.dimension.verdict).toBe("ambiguous");
    expect(evaluation.dimensions.dataBinding.dimension.verdict).toBe("supported");
  });

  it("receipt for another tx poisons data binding and proves nothing about this subject", async () => {
    const { evaluation } = await evaluate("receiptForOtherTx");
    const conflict = evaluation.conflicts.find((c) => c.code === "RECEIPT_TX_HASH_MATCHES_SUBJECT");
    expect(conflict).toBeDefined();
    expect(conflict?.scope).toEqual({ kind: "dimension", dimension: "dataBinding" });
    expect(evaluation.dimensions.dataBinding.dimension.verdict).toBe("ambiguous");
    // The receipt does not bind to THIS subject -> no clean execution claim.
    expect(evaluation.dimensions.execution.dimension.verdict).toBe("insufficient");
    // And no observed effects may leak from an unbound receipt.
    expect(evaluation.observedEffects).toEqual([]);
  });

  it("receipt for another tx emits no effects even when the foreign receipt carries logs", async () => {
    const acquisition = await acquire({
      // The foreign receipt is internally coherent (its logs agree with it),
      // so ONLY the subject-binding check fails.
      receipt: successReceiptResultText({
        transactionHash: OTHER_TX,
        logs: [logObject("0x0", { transactionHash: OTHER_TX })],
      }),
      block: successBlockResultText(),
    });
    const evaluation = evaluateTransactionAcquisition(acquisition);
    expect(evaluation.observedEffects).toEqual([]);
    expect(evaluation.conflicts.map((c) => c.code)).toEqual(["RECEIPT_TX_HASH_MATCHES_SUBJECT"]);
    expect(evaluation.dimensions.execution.dimension.verdict).toBe("insufficient");
  });

  it("incoherent transaction observation forces data binding ambiguous, execution stays supported", async () => {
    const { evaluation } = await evaluate("transactionIncoherentWithReceipt");
    const conflict = evaluation.conflicts.find((c) => c.code === "TRANSACTION_COHERENT_WITH_RECEIPT");
    expect(conflict).toBeDefined();
    expect(conflict?.scope).toEqual({ kind: "dimension", dimension: "dataBinding" });
    expect(evaluation.dimensions.dataBinding.dimension.verdict).toBe("ambiguous");
    expect(evaluation.dimensions.execution.dimension.verdict).toBe("supported");
  });
});

// ---------------------------------------------------------------------------
// PASS 5 — logs: coherent, removed, mismatched
// ---------------------------------------------------------------------------

describe("PASS 5: log observation semantics", () => {
  it("emits deterministic evm.log effects ordered by identity across repeated evaluation", async () => {
    const first = await evaluate("successWithLogs");
    const second = await evaluate("successWithLogs");
    expect(first.evaluation.observedEffects).toHaveLength(2);
    expect(first.evaluation.observedEffects).toEqual(second.evaluation.observedEffects);
    const ids = first.evaluation.observedEffects.map((e) => e.id);
    expect(ids).toEqual([...ids].sort());
  });

  it("omits removed logs, conflicts at execution scope, and never claims them as effects", async () => {
    const { evaluation } = await evaluate("removedLog");
    expect(evaluation.observedEffects).toEqual([]);
    const conflict = evaluation.conflicts.find((c) => c.code === "LOG_NOT_REMOVED");
    expect(conflict).toBeDefined();
    expect(conflict?.scope).toEqual({ kind: "dimension", dimension: "execution" });
    expect(conflict?.id).toContain("log:0");
    expect(evaluation.dimensions.execution.dimension.verdict).toBe("ambiguous");
    expect(evaluation.warnings.map((w) => w.code)).toContain("EVM_OBSERVED_EFFECTS_OMITTED");
  });

  it("omits logs whose block anchor disagrees with the receipt", async () => {
    const { evaluation } = await evaluate("logFromWrongBlock");
    expect(evaluation.observedEffects).toEqual([]);
    expect(evaluation.conflicts.map((c) => c.code)).toContain("LOG_BLOCK_COHERENT");
    expect(evaluation.dimensions.execution.dimension.verdict).toBe("ambiguous");
  });

  it("omits logs whose transaction hash disagrees with the receipt", async () => {
    const { evaluation } = await evaluate("logFromWrongTransaction");
    expect(evaluation.observedEffects).toEqual([]);
    expect(evaluation.conflicts.map((c) => c.code)).toContain("LOG_TRANSACTION_COHERENT");
    expect(evaluation.dimensions.execution.dimension.verdict).toBe("ambiguous");
  });

  it("mixed good/bad logs: good logs survive, bad logs become conflicts, execution goes ambiguous", async () => {
    const { evaluation } = await evaluate("mixedGoodAndBadLogs");
    expect(evaluation.observedEffects).toHaveLength(2);
    expect(evaluation.conflicts.map((c) => c.code)).toContain("LOG_NOT_REMOVED");
    expect(
      evaluation.warnings.find((w) => w.code === "EVM_OBSERVED_EFFECTS_OMITTED")?.metadata,
    ).toEqual({ logIndexes: ["1"] });
    expect(evaluation.dimensions.execution.dimension.verdict).toBe("ambiguous");
  });

  it("converts huge quantities into exact decimal-string fields without precision loss", async () => {
    const { evaluation } = await evaluate("hugeQuantities");
    expect(evaluation.observedEffects).toHaveLength(1);
    expect(evaluation.observedEffects[0]?.fields.blockNumber).toBe(`1${"0".repeat(30)}`);
    expect(JSON.stringify(evaluation.observedEffects[0])).not.toContain("bigint");
    expect(() => validateNetworkEvidenceFragment(evaluation.fragment)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// PASS 6 — provenance can never be fabricated
// ---------------------------------------------------------------------------

describe("PASS 6: evidence closure (no supported claim without provenance)", () => {
  const NAMES = Object.keys(SCENARIOS) as Array<keyof typeof SCENARIOS>;

  it("resolves every citation of every dimension against the fragment evidence table", async () => {
    for (const name of NAMES) {
      const { evaluation } = await evaluate(name);
      const known = new Set(evaluation.fragment.evidence.map((r) => r.id));
      for (const dim of Object.values(evaluation.dimensions)) {
        for (const id of dim.dimension.evidence) {
          expect(known.has(id), `${name}: ${dim.name} cites unknown ${id}`).toBe(true);
        }
        // Any supported/contradicted verdict MUST carry basis AND citations.
        if (dim.dimension.verdict === "supported" || dim.dimension.verdict === "contradicted") {
          expect(dim.dimension.basis.length, name).toBeGreaterThan(0);
          expect(dim.dimension.evidence.length, name).toBeGreaterThan(0);
        }
      }
    }
  });

  it("resolves every conflict and warning citation against the same table", async () => {
    for (const name of NAMES) {
      const { evaluation } = await evaluate(name);
      const known = new Set(evaluation.fragment.evidence.map((r) => r.id));
      for (const conflict of evaluation.conflicts) {
        expect(conflict.evidence.length, `${name}: material conflict without citations`).toBeGreaterThan(0);
        for (const id of conflict.evidence) expect(known.has(id), `${name}: ${id}`).toBe(true);
      }
      for (const warning of evaluation.warnings) {
        for (const id of warning.evidence ?? []) expect(known.has(id), `${name}: ${id}`).toBe(true);
      }
      for (const effect of evaluation.observedEffects) {
        expect(effect.basis.length).toBeGreaterThan(0);
        for (const id of effect.evidence) expect(known.has(id), `${name}: ${id}`).toBe(true);
      }
    }
  });

  it("never cites anything outside buildEvidenceRefs of the same acquisition (no fabricated provenance)", async () => {
    for (const name of NAMES) {
      const { acquisition, evaluation } = await evaluate(name);
      const known = new Set(buildEvidenceRefs(acquisition).map((r) => r.id));
      const cited: string[] = [
        ...evaluation.conflicts.flatMap((c) => c.evidence),
        ...evaluation.observedEffects.flatMap((e) => e.evidence),
        ...Object.values(evaluation.dimensions).flatMap((d) => d.dimension.evidence),
        ...evaluation.warnings.flatMap((w) => w.evidence ?? []),
      ];
      for (const id of cited) expect(known.has(id), `${name}: fabricated ${id}`).toBe(true);
    }
  });

  it("every scenario produces a fragment that satisfies the frozen core contract", async () => {
    for (const name of NAMES) {
      const { evaluation } = await evaluate(name);
      expect(() => validateNetworkEvidenceFragment(evaluation.fragment), name).not.toThrow();
      expect(evaluation.fragment.subject.networkId).toBe(evaluation.fragment.network.networkId);
    }
  });

  it("keeps conflict collections set-like: unique ids, deterministically sorted", async () => {
    for (const name of NAMES) {
      const { evaluation } = await evaluate(name);
      const ids = evaluation.conflicts.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toEqual([...ids].sort());
      for (const conflict of evaluation.conflicts) expect(conflict.material).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// PASS 7 — no semantic leakage (settlement/finality/purity)
// ---------------------------------------------------------------------------

describe("PASS 7: semantic leakage guards", () => {
  it.each(Object.keys(SCENARIOS) as Array<keyof typeof SCENARIOS>)(
    "%s: settlement is never evaluated and never projected",
    async (name) => {
      const { evaluation } = await evaluate(name);
      expect(evaluation.fragment.networkEvidence).not.toHaveProperty("settlement");
      expect(evaluation.dimensions).not.toHaveProperty("settlement");
    },
  );

  it.each(Object.keys(SCENARIOS) as Array<keyof typeof SCENARIOS>)(
    "%s: finality is never evaluated and never projected",
    async (name) => {
      const { evaluation } = await evaluate(name);
      expect(evaluation.fragment.networkEvidence).not.toHaveProperty("finality");
      expect(evaluation.dimensions).not.toHaveProperty("finality");
    },
  );

  it("every scenario carries exactly one deterministic not-evaluated warning", async () => {
    for (const name of Object.keys(SCENARIOS) as Array<keyof typeof SCENARIOS>) {
      const { evaluation } = await evaluate(name);
      const warnings = evaluation.warnings.filter((w) => w.code === "EVM_DIMENSIONS_NOT_EVALUATED");
      expect(warnings, name).toHaveLength(1);
      expect(warnings[0], name).toEqual(DIMENSIONS_NOT_EVALUATED_WARNING);
    }
  });

  it("the not-evaluated warning lists finality + settlement in deterministic order with the exact message", () => {
    expect(DIMENSIONS_NOT_EVALUATED_WARNING.metadata?.dimensions).toEqual([
      "finality",
      "settlement",
    ]);
    expect(DIMENSIONS_NOT_EVALUATED_WARNING.message).toBe(
      "Generic single-source EVM acquisition does not evaluate settlement or network-specific finality.",
    );
    // Determinism: rebuilding the warning object yields a deep-equal form.
    expect(JSON.parse(JSON.stringify(DIMENSIONS_NOT_EVALUATED_WARNING))).toEqual(
      JSON.parse(
        JSON.stringify({
          code: "EVM_DIMENSIONS_NOT_EVALUATED",
          message:
            "Generic single-source EVM acquisition does not evaluate settlement or network-specific finality.",
          metadata: { dimensions: ["finality", "settlement"] },
        }),
      ),
    );
  });

  it("every fragment satisfies the frozen core contract as a partial record", async () => {
    for (const name of Object.keys(SCENARIOS) as Array<keyof typeof SCENARIOS>) {
      const { evaluation } = await evaluate(name);
      expect(() => validateNetworkEvidenceFragment(evaluation.fragment), name).not.toThrow();
      const keys = Object.keys(evaluation.fragment.networkEvidence).sort();
      expect(keys).toEqual(["dataBinding", "execution", "observedEffects"]);
    }
  });
});

// ---------------------------------------------------------------------------
// Determinism + purity
// ---------------------------------------------------------------------------

describe("determinism and purity", () => {
  it("produces deep-identical output for the same input, twice over", async () => {
    const { acquisition, evaluation } = await evaluate("successWithLogs");
    const again = evaluateTransactionAcquisition(acquisition);
    expect(again).toEqual(evaluation);
    const wire = (v: unknown): string =>
      JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? `${x}n` : x));
    expect(wire(again)).toBe(wire(evaluation));
  });

  it("touches no clock and no randomness during evaluation", async () => {
    const { acquisition } = await evaluate("successWithLogs");
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("Date.now must not be called by the evaluator");
    });
    const randomSpy = vi.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("Math.random must not be called by the evaluator");
    });
    try {
      expect(() => evaluateTransactionAcquisition(acquisition)).not.toThrow();
      expect(nowSpy).not.toHaveBeenCalled();
      expect(randomSpy).not.toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
      randomSpy.mockRestore();
    }
  });

  it("returns deeply frozen output and never mutates the input acquisition", async () => {
    const { acquisition, evaluation } = await evaluate("blockHashMismatch");
    const snapshot = JSON.stringify(acquisition, (_k, v: unknown) => (typeof v === "bigint" ? `${v}n` : v));
    expect(Object.isFrozen(evaluation)).toBe(true);
    expect(Object.isFrozen(evaluation.fragment)).toBe(true);
    expect(Object.isFrozen(evaluation.dimensions.execution.dimension)).toBe(true);
    expect(Object.isFrozen(evaluation.observedEffects[0])).toBe(true);
    evaluateTransactionAcquisition(acquisition);
    expect(
      JSON.stringify(acquisition, (_k, v: unknown) => (typeof v === "bigint" ? `${v}n` : v)),
    ).toBe(snapshot);
  });

  it("exposes the identical dimensions inside the fragment and the local record", async () => {
    const { evaluation } = await evaluate("removedLog");
    expect(evaluation.fragment.networkEvidence.execution).toEqual(evaluation.dimensions.execution.dimension);
    expect(evaluation.fragment.networkEvidence.observedEffects).toEqual(evaluation.observedEffects);
    expect(evaluation.fragment.conflicts).toEqual(evaluation.conflicts);
    expect(evaluation.fragment.warnings).toEqual(evaluation.warnings);
  });
});
