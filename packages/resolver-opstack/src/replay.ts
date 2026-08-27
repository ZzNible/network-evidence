/**
 * OFFLINE REPLAY — first-class deterministic re-execution of ONE OP Stack
 * finality observation from a validated fixture.
 *
 * Same design philosophy as the generic EVM resolver (no generic replay
 * framework is introduced anywhere): the replay "network" is a strict
 * in-memory JSON-RPC responder built from the fixture captures; requests
 * are matched by (method, canonical params) and same-key captures are
 * consumed first-in-first-out (one burst may re-read an exchange); unmatched
 * requests and unused captures fail closed; the global fetch is never
 * referenced. A replay therefore performs ZERO network I/O and reproduces
 * byte-identical normalized observations — running it twice yields deep-equal
 * results.
 */

import { exchangeIdentityKey, isValidRpcId } from "@nec/resolver-evm";
import type { EvmFixtureCapture, FetchLike } from "@nec/resolver-evm";

import { NecResolverOpStackError } from "./errors.js";
import { OPSTACK_MAX_ANCESTRY_DEPTH } from "./config.js";
import {
  OPSTACK_ACQUISITION_PROFILE,
  OPSTACK_REPLAY_ENDPOINT,
  runOpStackFinalityPipeline,
} from "./acquire.js";
import type { OpStackFinalityObservation } from "./acquire.js";
import { validateOpStackFinalityFixture } from "./fixture.js";
import type { OpStackFinalityFixture } from "./fixture.js";

export interface OpStackReplayOptions {
  /** Default true: leftover captures fail closed (request/fixture mismatch). */
  readonly requireAllCapturesUsed?: boolean;
}

interface ReplayServer {
  readonly fetchFn: FetchLike;
  readonly servedCount: () => number;
  readonly leftoverCount: () => number;
}

function buildReplayServer(fixture: OpStackFinalityFixture): ReplayServer {
  // One FIFO queue per (method, params) identity: one observation burst may
  // read the same exchange repeatedly (e.g. the finalized-head stability
  // re-read), so same-key captures are consumed strictly in fixture order.
  const byKey = new Map<string, EvmFixtureCapture[]>();
  for (const capture of fixture.captures) {
    const key = exchangeIdentityKey(capture.rpcMethod, capture.rpcParams);
    const queue = byKey.get(key);
    if (queue === undefined) byKey.set(key, [capture]);
    else queue.push(capture);
  }
  let served = 0;
  let leftover = fixture.captures.length;

  const fetchFn: FetchLike = async (_input, init) => {
    const bodyText = typeof init?.body === "string" ? init.body : "";
    let method = "";
    let params: unknown[] = [];
    // The replay responds using the ACTUAL outbound JSON-RPC request id it
    // receives, so replay traverses the same request/response-binding
    // invariant as live acquisition (never a hardcoded id).
    let requestId: string | number | null = null;
    try {
      const parsed = JSON.parse(bodyText) as Record<string, unknown>;
      if (typeof parsed.method !== "string") throw new Error("shape");
      if (!isValidRpcId(parsed.id)) throw new Error("id");
      method = parsed.method;
      requestId = parsed.id as string | number | null;
      params = Array.isArray(parsed.params) ? parsed.params : [];
    } catch {
      throw new NecResolverOpStackError(
        "OPSTACK_REPLAY_UNMATCHED_REQUEST",
        "replay received a malformed outbound request",
      );
    }
    const key = exchangeIdentityKey(method, params);
    const queue = byKey.get(key);
    const capture = queue?.shift();
    if (capture === undefined) {
      throw new NecResolverOpStackError(
        "OPSTACK_REPLAY_UNMATCHED_REQUEST",
        `no unused fixture capture matches request ${key}`,
      );
    }
    served++;
    leftover--;
    const idText = JSON.stringify(requestId);
    const body =
      "resultJson" in capture
        ? `{"jsonrpc":"2.0","id":${idText},"result":${capture.resultJson}}`
        : `{"jsonrpc":"2.0","id":${idText},"error":{"code":${capture.error.code},"message":${JSON.stringify(capture.error.message)}}}`;
    return new Response(body, {
      status: capture.httpStatus,
      headers: { "Content-Type": "application/json" },
    });
  };

  return { fetchFn, servedCount: () => served, leftoverCount: () => leftover };
}

/**
 * Replay one OP Stack finality observation offline from a fixture. Throws
 * on any deviation; with default options every captured exchange must be
 * consumed exactly. Deterministic: two replays of the same fixture produce
 * deep-equal observations.
 */
export async function replayOpStackFinalityObservation(
  fixtureValue: unknown,
  options: OpStackReplayOptions = {},
): Promise<OpStackFinalityObservation> {
  const fixture = validateOpStackFinalityFixture(fixtureValue);
  const requireAllCapturesUsed = options.requireAllCapturesUsed !== false;
  const server = buildReplayServer(fixture);

  const observation = await runOpStackFinalityPipeline({
    provenance: {
      sourceId: fixture.source.sourceId,
      sourceType: fixture.source.sourceType,
      ...(fixture.source.independenceGroup === undefined
        ? {}
        : { independenceGroup: fixture.source.independenceGroup }),
      networkId: fixture.source.networkId,
      chainId: fixture.source.chainId,
    },
    endpointUrl: OPSTACK_REPLAY_ENDPOINT,
    subjectBlock: { number: BigInt(fixture.subjectBlock.number), hash: fixture.subjectBlock.hash },
    now: fixture.acquiredAt,
    fetchFn: server.fetchFn,
    // Replay re-runs the ancestry-walk gate with the SAME bound the live
    // acquisition used (default = the ruleset ceiling), so the burst is
    // reproduced decision-for-decision.
    maxAncestryDepth: fixture.maxAncestryDepth ?? OPSTACK_MAX_ANCESTRY_DEPTH,
  });

  if (requireAllCapturesUsed) {
    if (server.leftoverCount() > 0) {
      throw new NecResolverOpStackError(
        "OPSTACK_REPLAY_UNUSED_CAPTURES",
        `fixture contains ${server.leftoverCount()} capture(s) the acquisition never requested`,
      );
    }
    if (server.servedCount() !== fixture.captures.length) {
      throw new NecResolverOpStackError(
        "OPSTACK_FIXTURE_INVALID",
        "replay accounting mismatch: served exchanges differ from fixture captures",
      );
    }
  }

  if (observation.profile !== OPSTACK_ACQUISITION_PROFILE) {
    throw new NecResolverOpStackError("OPSTACK_FIXTURE_INVALID", "internal profile mismatch");
  }
  return observation;
}
