/**
 * OFFLINE REPLAY — first-class deterministic re-execution of an
 * acquisition from a validated fixture.
 *
 * The replay "network" is a strict in-memory JSON-RPC responder built from
 * the fixture captures: requests are matched by (method, canonical params),
 * unmatched requests fail closed, and the global fetch is never referenced.
 * A replay therefore performs ZERO network I/O and reproduces byte-identical
 * normalized observations.
 */

import { exchangeIdentityKey } from "./capture.js";
import { isValidRpcId, recordedIdentityKey } from "./client.js";
import type { RecordedExchange } from "./client.js";
import { NecResolverEvmError } from "./errors.js";
import type { FetchLike } from "./client.js";
import { ACQUISITION_PROFILE, REPLAY_ENDPOINT, runAcquisitionPipeline } from "./acquire.js";
import type { EvmTransactionAcquisition } from "./acquire.js";
import { validateEvmAcquisitionFixture } from "./fixture.js";
import type { EvmAcquisitionFixture } from "./fixture.js";

export interface ReplayOptions {
  /** Also replay eth_getTransactionByHash if the fixture carries it. */
  readonly includeTransaction?: boolean;
  /** Default true: leftover captures fail closed (request/fixture mismatch). */
  readonly requireAllCapturesUsed?: boolean;
}

interface ReplayServer {
  readonly fetchFn: FetchLike;
  readonly servedKeys: () => readonly string[];
}

function buildReplayServer(fixture: EvmAcquisitionFixture): ReplayServer {
  const byKey = new Map<string, EvmAcquisitionFixture["captures"][number]>();
  for (const capture of fixture.captures) {
    byKey.set(exchangeIdentityKey(capture.rpcMethod, capture.rpcParams), capture);
  }
  const served = new Set<string>();

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
      // eth_chainId-style requests legitimately omit params.
      params = Array.isArray(parsed.params) ? parsed.params : [];
    } catch {
      throw new NecResolverEvmError("EVM_REPLAY_UNMATCHED_REQUEST", "replay received a malformed outbound request");
    }
    const key = exchangeIdentityKey(method, params);
    const capture = byKey.get(key);
    if (capture === undefined || served.has(key)) {
      throw new NecResolverEvmError(
        "EVM_REPLAY_UNMATCHED_REQUEST",
        `no fixture capture matches request ${key}`,
      );
    }
    served.add(key);
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

  return { fetchFn, servedKeys: () => [...served] };
}

/**
 * Replay one acquisition offline from a fixture. Throws on any deviation;
 * with default options every captured exchange must be consumed exactly.
 */
export async function replayTransactionAcquisition(
  fixtureValue: unknown,
  options: ReplayOptions = {},
): Promise<EvmTransactionAcquisition> {
  const fixture = validateEvmAcquisitionFixture(fixtureValue);
  const requireAllCapturesUsed = options.requireAllCapturesUsed !== false;
  const server = buildReplayServer(fixture);

  const acquisition = await runAcquisitionPipeline({
    provenance: {
      sourceId: fixture.source.sourceId,
      sourceType: fixture.source.sourceType,
      ...(fixture.source.independenceGroup === undefined
        ? {}
        : { independenceGroup: fixture.source.independenceGroup }),
      networkId: fixture.source.networkId,
      chainId: fixture.source.chainId,
    },
    endpointUrl: REPLAY_ENDPOINT,
    txHash: fixture.subject.txHash,
    now: fixture.acquiredAt,
    includeTransaction: options.includeTransaction === true,
    fetchFn: server.fetchFn,
  });

  if (requireAllCapturesUsed) {
    const allKeys = fixture.captures.map((c) => exchangeIdentityKey(c.rpcMethod, c.rpcParams));
    const unused = allKeys.filter((key) => !server.servedKeys().includes(key));
    if (unused.length > 0) {
      throw new NecResolverEvmError(
        "EVM_REPLAY_UNUSED_CAPTURES",
        `fixture contains ${unused.length} capture(s) the acquisition never requested`,
      );
    }
  }

  if (acquisition.profile !== ACQUISITION_PROFILE) {
    throw new NecResolverEvmError("EVM_FIXTURE_INVALID", "internal profile mismatch");
  }
  return acquisition;
}

/** Exposed for tests/tooling: identity key of a raw recorded exchange. */
export function exchangeKeyOf(exchange: Pick<RecordedExchange, "rpcMethod" | "rpcParams">): string {
  return recordedIdentityKey(exchange);
}
