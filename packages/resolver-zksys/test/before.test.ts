import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  capabilityIsUsable,
  composeDiscoveryMatch,
  computeEvidencePolicyDigest,
  decodeBase64Strict,
  nativeSourceContentDigest,
  verifyCapabilitySnapshot,
  verifyPreflightResult,
} from "@nec/core";
import type { EvidencePolicy, EvidenceRef, PolicyDimension, PreflightRequest } from "@nec/core";
import type { EvmCapabilityProbeObservation } from "@nec/resolver-evm";

import {
  NecResolverZksysError,
  ZKSYS_BATCHING_SEMANTICS,
  ZKSYS_TANENBAUM_NETWORK_ID,
  deriveZksysBeforeFoundation,
  deriveZksysBeforePreflightResult,
  zksysBeforeResolverManifest,
} from "../src/index.js";
import type {
  NecResolverZksysErrorCode,
  ZksysBatchingProbeObservation,
  ZksysBeforeFoundation,
} from "../src/index.js";
import { loadA3ZksysFixtureObservation } from "./fixtures/a3-live-3819.js";

const TX = "0xf107268ee5f9177dbd23c2e6b040f0ea9b7c7323f1f385ee3ea43bb03b9e6b8d";
const OTHER_HASH = `0x${"ab".repeat(32)}`;

interface ExchangeEnvelope {
  request: string;
  response: string;
  observationKind: string;
}

function foundation(includeBatching = true): ZksysBeforeFoundation {
  const fixture = loadA3ZksysFixtureObservation();
  return deriveZksysBeforeFoundation({
    networkId: ZKSYS_TANENBAUM_NETWORK_ID,
    evmObservation: fixture.evmObservation,
    ...(includeBatching ? { batchingObservation: fixture.batchingObservation } : {}),
  });
}

function nativeEnvelope(ref: EvidenceRef): ExchangeEnvelope {
  return JSON.parse(
    Buffer.from(decodeBase64Strict(ref.nativeSource!.payload, "test.native")).toString("utf8"),
  ) as ExchangeEnvelope;
}

function replacedRef(
  ref: EvidenceRef,
  envelope: ExchangeEnvelope,
  overrides: Partial<EvidenceRef> = {},
): EvidenceRef {
  const bytes = new TextEncoder().encode(JSON.stringify(envelope));
  return {
    ...ref,
    ...overrides,
    contentDigest: `sha256:${createHash("sha256").update(envelope.response, "utf8").digest("hex")}`,
    nativeSource: {
      ...ref.nativeSource!,
      payload: Buffer.from(bytes).toString("base64"),
      contentDigest: nativeSourceContentDigest(bytes),
    },
  };
}

function rewriteEvm(
  observation: EvmCapabilityProbeObservation,
  method: string,
  rewrite: (request: Record<string, unknown>, response: Record<string, unknown>) => {
    request?: Record<string, unknown>;
    response?: Record<string, unknown>;
    overrides?: Partial<EvidenceRef>;
  },
): EvmCapabilityProbeObservation {
  return {
    ...observation,
    evidence: observation.evidence.map((ref) => {
      if (ref.metadata?.rpcMethod !== method) return ref;
      const envelope = nativeEnvelope(ref);
      const changed = rewrite(
        JSON.parse(envelope.request) as Record<string, unknown>,
        JSON.parse(envelope.response) as Record<string, unknown>,
      );
      return replacedRef(ref, {
        ...envelope,
        request: JSON.stringify(changed.request ?? JSON.parse(envelope.request)),
        response: JSON.stringify(changed.response ?? JSON.parse(envelope.response)),
      }, changed.overrides);
    }),
  };
}

function rawEvm(
  observation: EvmCapabilityProbeObservation,
  method: string,
  rewrite: (envelope: ExchangeEnvelope) => ExchangeEnvelope,
): EvmCapabilityProbeObservation {
  return {
    ...observation,
    evidence: observation.evidence.map((ref) =>
      ref.metadata?.rpcMethod === method ? replacedRef(ref, rewrite(nativeEnvelope(ref))) : ref),
  };
}

function rewriteBatch(
  observation: ZksysBatchingProbeObservation,
  rewrite: (request: Record<string, unknown>, response: Record<string, unknown>) => {
    request?: Record<string, unknown>;
    response?: Record<string, unknown>;
  },
): ZksysBatchingProbeObservation {
  const ref = observation.evidence[0]!;
  const envelope = nativeEnvelope(ref);
  const request = JSON.parse(envelope.request) as Record<string, unknown>;
  const response = JSON.parse(envelope.response) as Record<string, unknown>;
  const changed = rewrite(request, response);
  return {
    ...observation,
    evidence: [replacedRef(ref, {
      ...envelope,
      request: JSON.stringify(changed.request ?? request),
      response: JSON.stringify(changed.response ?? response),
    })],
  };
}

function rawBatch(
  observation: ZksysBatchingProbeObservation,
  rewrite: (envelope: ExchangeEnvelope) => ExchangeEnvelope,
): ZksysBatchingProbeObservation {
  const ref = observation.evidence[0]!;
  return { ...observation, evidence: [replacedRef(ref, rewrite(nativeEnvelope(ref)))] };
}

function derive(
  evmObservation: EvmCapabilityProbeObservation,
  batchingObservation?: ZksysBatchingProbeObservation,
): ZksysBeforeFoundation {
  return deriveZksysBeforeFoundation({
    networkId: ZKSYS_TANENBAUM_NETWORK_ID,
    evmObservation,
    ...(batchingObservation === undefined ? {} : { batchingObservation }),
  });
}

function expectZksysError(fn: () => unknown, code?: NecResolverZksysErrorCode): void {
  let error: unknown;
  try {
    fn();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(NecResolverZksysError);
  if (code !== undefined) expect((error as NecResolverZksysError).code).toBe(code);
}

function policy(requiredDimensions: PolicyDimension[]): EvidencePolicy {
  const content = { id: "zksys-execution-evidence", version: "1", requiredDimensions };
  return { ...content, digest: computeEvidencePolicyDigest(content) };
}

function preflightRequest(): PreflightRequest {
  return {
    schemaVersion: "0.1",
    requestId: "pf-zksys-a3-3819",
    networkId: ZKSYS_TANENBAUM_NETWORK_ID,
    action: {
      kind: "evm.transaction",
      target: "0xffc854565ff83a49d3302821c0ad23822ca1a50c",
      value: "100000000000000",
    },
    evidencePolicy: policy(["execution", "observedEffects", "dataBinding"]),
  };
}

describe("zkSYS historical/current boundary", () => {
  it("keeps all historically healthy volatile capabilities currently unknown", () => {
    const result = foundation();
    expect(result.network).toMatchObject({ networkId: "eip155:57057", chainId: 57057 });
    expect(result.snapshot.generatedAt).toBe("2026-08-25T13:14:25.000Z");
    expect(verifyCapabilitySnapshot(result.snapshot, {
      resolver: result.manifest,
      networkId: ZKSYS_TANENBAUM_NETWORK_ID,
    })).toBe(true);

    for (const capability of ["execution", "observedEffects", "dataBinding"] as const) {
      const state = result.snapshot.evidenceCapabilities[capability];
      expect(state).toMatchObject({
        support: "supported",
        availability: "unknown",
        metadata: {
          observationKind: "historical_replay",
          historicalAvailabilityAtCapture: "available",
          currentAvailability: "unknown",
        },
      });
      expect(state.evidence?.length).toBeGreaterThan(0);
      expect(capabilityIsUsable(state, result.snapshot.evidence)).toBe(false);
    }
    expect(result.snapshot.executionCapabilities.batching).toMatchObject({
      support: "supported",
      availability: "unknown",
      evidence: ["ev-a3-zksys-block-to-batch"],
    });
  });

  it("projects a historical outage to current unknown, never unavailable-now", () => {
    const fixture = loadA3ZksysFixtureObservation();
    const result = derive({
      ...fixture.evmObservation,
      rpcReachable: false,
      chainIdentityObserved: false,
      receiptLookupUsable: false,
      blockLookupUsable: false,
      transactionLookupUsable: false,
      evidence: [],
    });
    for (const capability of ["execution", "observedEffects", "dataBinding"] as const) {
      expect(result.snapshot.evidenceCapabilities[capability]).toMatchObject({
        support: "supported",
        availability: "unknown",
        metadata: { historicalAvailabilityAtCapture: "unavailable" },
      });
    }
    expect(result.snapshot.executionCapabilities.batching).toMatchObject({
      support: "supported",
      availability: "unknown",
    });
  });

  it("rejects caller relabeling of archived EvidenceRefs with a current or future observedAt", () => {
    const fixture = loadA3ZksysFixtureObservation();
    for (const observedAt of ["2026-08-28T00:00:00.000Z", "2099-01-01T00:00:00.000Z"]) {
      expectZksysError(
        () => derive({ ...fixture.evmObservation, observedAt }),
        "ZKSYS_TIME_MISMATCH",
      );
    }
  });

  it("keeps historical preflight non-ready and all required checks unknown", () => {
    const result = foundation();
    const preflight = deriveZksysBeforePreflightResult(result, preflightRequest());
    expect(preflight.status).toBe("unknown");
    expect(preflight.evidenceReadiness.execution.status).toBe("unknown");
    expect(preflight.evidenceReadiness.observedEffects.status).toBe("unknown");
    expect(preflight.evidenceReadiness.dataBinding.status).toBe("unknown");
    expect(verifyPreflightResult(preflight, {
      resolver: result.manifest,
      capabilitySnapshot: result.snapshot,
    })).toBe(true);
  });

  it("does not promote inherited EVM states when batching is absent", () => {
    const result = foundation(false);
    expect(result.snapshot.executionCapabilities.batching?.availability).toBe("unknown");
    for (const capability of ["execution", "observedEffects", "dataBinding"] as const) {
      expect(result.snapshot.evidenceCapabilities[capability].availability).toBe("unknown");
    }
  });
});

describe("zkSYS descriptor-first ownership boundary", () => {
  it("never invokes caller Symbol.iterator overrides on either evidence array", () => {
    let calls = 0;
    const evmFixture = loadA3ZksysFixtureObservation();
    Object.defineProperty(evmFixture.evmObservation.evidence, Symbol.iterator, {
      value: () => { calls += 1; return [][Symbol.iterator](); }, enumerable: true,
    });
    expectZksysError(() => derive(evmFixture.evmObservation), "ZKSYS_INPUT_INVALID");

    const batchingFixture = loadA3ZksysFixtureObservation();
    Object.defineProperty(batchingFixture.batchingObservation.evidence, Symbol.iterator, {
      value: () => { calls += 1; return [][Symbol.iterator](); }, enumerable: true,
    });
    expectZksysError(
      () => derive(batchingFixture.evmObservation, batchingFixture.batchingObservation),
      "ZKSYS_INPUT_INVALID",
    );
    expect(calls).toBe(0);
  });

  it("rejects accessors on association, source and EvidenceRef without invoking them", () => {
    const fixture = loadA3ZksysFixtureObservation();
    const cases: Array<() => unknown> = [];
    let calls = 0;

    const association = { ...fixture.batchingObservation.association! } as Record<string, unknown>;
    Object.defineProperty(association, "batchNumber", { enumerable: true, get: () => { calls += 1; return 3819; } });
    cases.push(() => derive(fixture.evmObservation, {
      ...fixture.batchingObservation,
      association,
    } as unknown as ZksysBatchingProbeObservation));

    const source = { ...fixture.evmObservation.source } as Record<string, unknown>;
    Object.defineProperty(source, "sourceType", { enumerable: true, get: () => { calls += 1; return "evm_rpc"; } });
    cases.push(() => derive({ ...fixture.evmObservation, source } as unknown as EvmCapabilityProbeObservation));

    const ref = { ...fixture.evmObservation.evidence[0]! } as Record<string, unknown>;
    Object.defineProperty(ref, "sourceId", { enumerable: true, get: () => { calls += 1; return "attacker"; } });
    cases.push(() => derive({
      ...fixture.evmObservation,
      evidence: [ref, ...fixture.evmObservation.evidence.slice(1)] as EvidenceRef[],
    }));

    for (const run of cases) expectZksysError(run, "ZKSYS_INPUT_INVALID");
    expect(calls).toBe(0);
  });

  it("rejects symbol keys, sparse arrays, augmented arrays and array subclasses", () => {
    const fixture = loadA3ZksysFixtureObservation();
    const symbolRef = { ...fixture.evmObservation.evidence[0]! };
    Object.defineProperty(symbolRef, Symbol("attacker"), { value: true, enumerable: true });
    expectZksysError(() => derive({
      ...fixture.evmObservation,
      evidence: [symbolRef, ...fixture.evmObservation.evidence.slice(1)],
    }), "ZKSYS_INPUT_INVALID");

    const sparse = new Array<EvidenceRef>(fixture.evmObservation.evidence.length);
    sparse[0] = fixture.evmObservation.evidence[0]!;
    expectZksysError(() => derive({ ...fixture.evmObservation, evidence: sparse }), "ZKSYS_INPUT_INVALID");

    const augmented = [...fixture.batchingObservation.evidence];
    Object.defineProperty(augmented, "attacker", { value: true, enumerable: true });
    expectZksysError(() => derive(fixture.evmObservation, {
      ...fixture.batchingObservation,
      evidence: augmented,
    }), "ZKSYS_INPUT_INVALID");

    class ExoticArray<T> extends Array<T> {}
    const exotic = new ExoticArray(...fixture.evmObservation.evidence);
    expectZksysError(() => derive({ ...fixture.evmObservation, evidence: exotic }), "ZKSYS_INPUT_INVALID");
  });

  it("uses an owned copy after validation", () => {
    const fixture = loadA3ZksysFixtureObservation();
    const result = derive(fixture.evmObservation, fixture.batchingObservation);
    fixture.evmObservation.evidence[0]!.sourceId = "mutated-after-derivation";
    (fixture.batchingObservation.association as unknown as Record<string, unknown>).batchNumber = 9999;
    expect(result.snapshot.evidence[0]?.sourceId).not.toBe("mutated-after-derivation");
    expect(result.snapshot.executionCapabilities.batching?.metadata?.batchNumber).toBe(3819);
  });
});

describe("zkSYS profile-wide source admission", () => {
  it("rejects every non-exact EVM sourceType even without batching", () => {
    for (const sourceType of ["zksys_rpc", "rpc", "http", "evm-rpc", "EVm_rpc", ""]) {
      const fixture = loadA3ZksysFixtureObservation();
      expectZksysError(() => derive({
        ...fixture.evmObservation,
        source: { ...fixture.evmObservation.source, sourceType },
      }), "ZKSYS_INPUT_INVALID");
    }
  });

  it("rejects EVM EvidenceRefs outside the observation source", () => {
    const fixture = loadA3ZksysFixtureObservation();
    expectZksysError(() => derive({
      ...fixture.evmObservation,
      evidence: fixture.evmObservation.evidence.map((ref, index) =>
        index === 0 ? { ...ref, sourceId: "other-source" } : ref),
    }), "ZKSYS_INPUT_INVALID");
  });

  it("rejects a batching source different from the EVM source", () => {
    const fixture = loadA3ZksysFixtureObservation();
    expectZksysError(() => derive(fixture.evmObservation, {
      ...fixture.batchingObservation,
      source: { ...fixture.batchingObservation.source, sourceId: "other-source" },
      evidence: fixture.batchingObservation.evidence.map((ref) => ({ ...ref, sourceId: "other-source" })),
    }), "ZKSYS_INPUT_INVALID");
  });
});

describe("zkSYS raw EVM provenance", () => {
  it.each([
    ["chain ID", "eth_chainId", (_request: Record<string, unknown>, response: Record<string, unknown>) => ({ response: { ...response, result: "0xdee2" } })],
    ["tx hash", "eth_getTransactionByHash", (_request: Record<string, unknown>, response: Record<string, unknown>) => ({ response: { ...response, result: { ...(response.result as object), hash: OTHER_HASH } } })],
    ["tx block hash", "eth_getTransactionByHash", (_request: Record<string, unknown>, response: Record<string, unknown>) => ({ response: { ...response, result: { ...(response.result as object), blockHash: OTHER_HASH } } })],
    ["tx block number", "eth_getTransactionByHash", (_request: Record<string, unknown>, response: Record<string, unknown>) => ({ response: { ...response, result: { ...(response.result as object), blockNumber: "0x14ea" } } })],
    ["receipt tx hash", "eth_getTransactionReceipt", (_request: Record<string, unknown>, response: Record<string, unknown>) => ({ response: { ...response, result: { ...(response.result as object), transactionHash: OTHER_HASH } } })],
    ["receipt block hash", "eth_getTransactionReceipt", (_request: Record<string, unknown>, response: Record<string, unknown>) => ({ response: { ...response, result: { ...(response.result as object), blockHash: OTHER_HASH } } })],
    ["receipt block number", "eth_getTransactionReceipt", (_request: Record<string, unknown>, response: Record<string, unknown>) => ({ response: { ...response, result: { ...(response.result as object), blockNumber: "0x14ea" } } })],
    ["receipt status", "eth_getTransactionReceipt", (_request: Record<string, unknown>, response: Record<string, unknown>) => ({ response: { ...response, result: { ...(response.result as object), status: "0x0" } } })],
    ["block hash", "eth_getBlockByHash", (_request: Record<string, unknown>, response: Record<string, unknown>) => ({ response: { ...response, result: { ...(response.result as object), hash: OTHER_HASH } } })],
    ["block number", "eth_getBlockByHash", (_request: Record<string, unknown>, response: Record<string, unknown>) => ({ response: { ...response, result: { ...(response.result as object), number: "0x14ea" } } })],
  ])("rejects digest-consistent %s mutation", (_label, method, mutate) => {
    const fixture = loadA3ZksysFixtureObservation();
    expectZksysError(() => derive(rewriteEvm(fixture.evmObservation, method, mutate)));
  });

  it("rejects positive booleans when the required raw exchanges are absent", () => {
    const fixture = loadA3ZksysFixtureObservation();
    expectZksysError(() => derive({ ...fixture.evmObservation, evidence: [] }), "ZKSYS_OBSERVATION_INCOMPLETE");
  });

  it("rejects caller booleans that downgrade verified positive raw exchanges", () => {
    const fixture = loadA3ZksysFixtureObservation();
    expectZksysError(
      () => derive({ ...fixture.evmObservation, receiptLookupUsable: false }),
      "ZKSYS_OBSERVATION_INCOMPLETE",
    );
  });
});

describe("zkSYS strict JSON-RPC", () => {
  it.each([
    ["unsafe request id", (e: ExchangeEnvelope) => ({ ...e, request: e.request.replace('"id":1', '"id":9007199254740992') })],
    ["different unsafe ids", (e: ExchangeEnvelope) => ({ ...e, request: e.request.replace('"id":1', '"id":9007199254740992'), response: e.response.replace('"id":1', '"id":9007199254740993') })],
    ["duplicate id", (e: ExchangeEnvelope) => ({ ...e, response: e.response.replace('"id":1', '"id":1,"id":1') })],
    ["duplicate method", (e: ExchangeEnvelope) => ({ ...e, request: e.request.replace('"method":"eth_chainId"', '"method":"eth_chainId","method":"eth_chainId"') })],
    ["duplicate result", (e: ExchangeEnvelope) => ({ ...e, response: e.response.replace('"result":', '"result":null,"result":') })],
    ["malformed JSON", (e: ExchangeEnvelope) => ({ ...e, response: e.response.slice(0, -1) })],
    ["wrong jsonrpc", (e: ExchangeEnvelope) => ({ ...e, response: e.response.replace('"2.0"', '"1.0"') })],
  ])("rejects %s in EVM envelopes", (_label, mutate) => {
    const fixture = loadA3ZksysFixtureObservation();
    expectZksysError(() => derive(rawEvm(fixture.evmObservation, "eth_chainId", mutate)));
  });

  it("applies the same duplicate/ID/malformed discipline to batching", () => {
    const mutations = [
      (e: ExchangeEnvelope): ExchangeEnvelope => ({ ...e, request: e.request.replace('"id":1', '"id":9007199254740992') }),
      (e: ExchangeEnvelope): ExchangeEnvelope => ({ ...e, response: e.response.replace('"result":', '"result":null,"result":') }),
      (e: ExchangeEnvelope): ExchangeEnvelope => ({ ...e, request: `${e.request}}` }),
    ];
    for (const mutate of mutations) {
      const fixture = loadA3ZksysFixtureObservation();
      expectZksysError(() => derive(
        fixture.evmObservation,
        rawBatch(fixture.batchingObservation, mutate),
      ));
    }
  });
});

describe("zkSYS batching semantic narrowing", () => {
  it("establishes only a provider-reported height lookup, with no block-hash claim", () => {
    const result = foundation();
    const state = result.snapshot.executionCapabilities.batching!;
    expect(state.metadata).toMatchObject({
      semantics: ZKSYS_BATCHING_SEMANTICS,
      requestedBlockHeight: 5353,
      batchNumber: 3819,
      reportedBlockRange: { start: 5353, end: 5353 },
      relationStrength: "provider_reported_height_lookup",
    });
    expect(state.metadata?.observationStatement).toBe(
      "At 2026-08-25T13:14:25.000Z, an archived identity-checked zkSYS RPC source returned batch 3819 with reported range 5353..5353 for a request for block height 5353.",
    );
    expect(JSON.stringify(state.metadata)).not.toContain("fd0c46");
    const ref = result.snapshot.evidence.find((candidate) => candidate.id === "ev-a3-zksys-block-to-batch")!;
    expect(ref.blockNumber).toBe(5353n);
    expect(ref.blockId).toBeUndefined();
  });

  it("accepts a coherent alternate EVM hash at the same height without strengthening batching", () => {
    const fixture = loadA3ZksysFixtureObservation();
    let evm = rewriteEvm(fixture.evmObservation, "eth_getTransactionByHash", (_request, response) => ({
      response: { ...response, result: { ...(response.result as object), blockHash: OTHER_HASH } },
      overrides: { blockId: OTHER_HASH },
    }));
    evm = rewriteEvm(evm, "eth_getTransactionReceipt", (_request, response) => ({
      response: { ...response, result: { ...(response.result as object), blockHash: OTHER_HASH } },
      overrides: { blockId: OTHER_HASH },
    }));
    evm = rewriteEvm(evm, "eth_getBlockByHash", (request, response) => {
      const result = response.result as Record<string, unknown>;
      const transactions = (result.transactions as Array<Record<string, unknown>>).map((tx) => ({ ...tx, blockHash: OTHER_HASH }));
      return {
        request: { ...request, params: [OTHER_HASH, true] },
        response: { ...response, result: { ...result, hash: OTHER_HASH, transactions } },
        overrides: { blockId: OTHER_HASH },
      };
    });
    const result = derive(evm, fixture.batchingObservation);
    expect(result.snapshot.executionCapabilities.batching?.availability).toBe("unknown");
    expect(JSON.stringify(result.snapshot.executionCapabilities.batching?.metadata)).not.toContain(OTHER_HASH);
  });

  it("rejects wrong method, params, batch, range, null, error and stale digests", () => {
    const cases: ZksysBatchingProbeObservation[] = [];
    for (const mutate of [
      (request: Record<string, unknown>) => ({ request: { ...request, method: "eth_getBlockByNumber" } }),
      (request: Record<string, unknown>) => ({ request: { ...request, params: ["5353"] } }),
      (request: Record<string, unknown>) => ({ request: { ...request, params: [5354] } }),
      (_request: Record<string, unknown>, response: Record<string, unknown>) => {
        const result = response.result as Record<string, unknown>;
        return { response: { ...response, result: { ...result, batch_info: { ...(result.batch_info as object), batch_number: 9999 } } } };
      },
      (_request: Record<string, unknown>, response: Record<string, unknown>) => {
        const result = response.result as Record<string, unknown>;
        return { response: { ...response, result: { ...result, block_range: { start: 5354, end: 5354 } } } };
      },
      (_request: Record<string, unknown>, response: Record<string, unknown>) => ({ response: { ...response, result: null } }),
      (_request: Record<string, unknown>, response: Record<string, unknown>) => ({ response: { jsonrpc: "2.0", id: 1, error: { code: -1, message: "no" } } }),
    ]) {
      const fixture = loadA3ZksysFixtureObservation();
      cases.push(rewriteBatch(fixture.batchingObservation, mutate));
    }
    for (const batching of cases) {
      const fixture = loadA3ZksysFixtureObservation();
      expectZksysError(() => derive(fixture.evmObservation, batching));
    }

    const fixture = loadA3ZksysFixtureObservation();
    const ref = fixture.batchingObservation.evidence[0]!;
    const stale = { ...fixture.batchingObservation, evidence: [{ ...ref, contentDigest: `sha256:${"00".repeat(32)}` }] };
    expectZksysError(() => derive(fixture.evmObservation, stale));

    const staleNative = {
      ...fixture.batchingObservation,
      evidence: [{
        ...ref,
        nativeSource: { ...ref.nativeSource!, contentDigest: `sha256:${"00".repeat(32)}` },
      }],
    };
    expectZksysError(() => derive(fixture.evmObservation, staleNative));
  });

  it("rejects Gateway/PoDA/proof/Syscoin/finality fields as inputs", () => {
    for (const key of ["gateway", "poda", "proof", "syscoin", "finality"]) {
      const fixture = loadA3ZksysFixtureObservation();
      expectZksysError(() => derive(fixture.evmObservation, {
        ...fixture.batchingObservation,
        [key]: { observed: true },
      } as unknown as ZksysBatchingProbeObservation), "ZKSYS_INPUT_INVALID");
    }
  });
});

describe("zkSYS discovery and pure replay", () => {
  it("fails closed for required unknown batching and is conditional for desired unknown batching", () => {
    const result = foundation();
    const required = composeDiscoveryMatch({
      requirements: [{ capability: "batching", strength: "required" }],
    }, result.candidate);
    const desired = composeDiscoveryMatch({
      requirements: [{ capability: "batching", strength: "desired" }],
    }, result.candidate);
    expect(required.classification).toBe("ineligible");
    expect(required.evaluations[0]?.status).toBe("unknown");
    expect(desired.classification).toBe("conditional");
    expect(desired.evaluations[0]?.status).toBe("unknown");
  });

  it("does not report historical generic EVM requirements as satisfied", () => {
    const result = foundation();
    const composed = composeDiscoveryMatch({
      requirements: [
        { capability: "execution", strength: "required" },
        { capability: "observedEffects", strength: "required" },
        { capability: "dataBinding", strength: "required" },
      ],
    }, result.candidate);
    expect(composed.classification).toBe("ineligible");
    expect(composed.evaluations.map((evaluation) => evaluation.status)).toEqual(["unknown", "unknown", "unknown"]);
  });

  it("replays deterministically with fetch poisoned", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("network I/O forbidden"); };
    try {
      const a = foundation();
      const b = foundation();
      expect(a.snapshot.artifactDigest).toBe(b.snapshot.artifactDigest);
      expect(deriveZksysBeforePreflightResult(a, preflightRequest()).artifactDigest).toBe(
        deriveZksysBeforePreflightResult(b, preflightRequest()).artifactDigest,
      );
      expect(Object.isFrozen(a.snapshot)).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("zkSYS public surface", () => {
  it("keeps the manifest and API narrow", async () => {
    const manifest = zksysBeforeResolverManifest();
    const publicApi = await import("../src/index.js");
    expect(manifest.supportedCapabilities).toEqual(["execution", "observedEffects", "dataBinding", "batching"]);
    expect(manifest.sourceRequirements).toEqual([{ sourceType: "evm_rpc", required: true }]);
    expect(manifest.metadata?.producerBoundary).toContain("deriveZksysBeforeFoundation");
    expect(Object.keys(publicApi).sort()).toEqual([
      "NecResolverZksysError",
      "ZKSYS_BATCHING_RPC_METHOD",
      "ZKSYS_BATCHING_SEMANTICS",
      "ZKSYS_TANENBAUM_CHAIN_ID",
      "ZKSYS_TANENBAUM_NETWORK_ID",
      "deriveZksysBeforeFoundation",
      "deriveZksysBeforePreflightResult",
      "zksysBeforeResolverManifest",
    ]);
    const serialized = JSON.stringify(foundation().snapshot, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString(10) : value);
    for (const forbidden of ["simulation", "executionModel", "accountModel", "gasModel", "paymaster", "signing", "submission"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
