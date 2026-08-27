/**
 * OP STACK FINALITY ACQUISITION orchestration (ONE configured source):
 *
 *   subject containing-block anchor (from the generic EVM flow)
 *     -> eth_chainId                              (identity gate)
 *     -> eth_getBlockByNumber("finalized", false) -> F  [first read of burst]
 *     -> eth_getBlockByNumber("safe", false)
 *     -> eth_getBlockByNumber("latest", false)
 *     -> IF F.number >= S AND F.number - S <= maxAncestryDepth:
 *          eth_getBlockByHash(parentHash, false)  repeated down to height S
 *          (bounded, explicit parentHash ancestry — NEVER inferred from
 *           block numbers alone; truncated at the first broken link)
 *     -> eth_getBlockByNumber(<S hex>, false)     [canonical re-read at S]
 *     -> IF the walk completed:
 *          eth_getBlockByNumber("finalized", false) [burst-stability re-read]
 *     -> consistency checks
 *     -> normalized, frozen observation
 *
 * Every logical read is captured raw and every typed value derives from
 * the capture text. Acquisition is deliberately DUMB about finality: it
 * observes heads and walks recorded parent hashes; the pure evaluator owns
 * all semantics.
 */

import type { Iso8601 } from "@nec/core";
import { deepFreeze } from "@nec/core";

import {
  buildCapture,
  createSourceClient,
  parseBlockResult,
  parseChainIdResult,
  redactUrlOccurrences,
  sourceProvenance,
  validateAcquisitionClock,
  validateEvmRpcSourceDescriptor,
} from "@nec/resolver-evm";
import type {
  EvmBlockObservation,
  EvmChainIdentityObservation,
  EvmRpcCapture,
  EvmRpcSourceDescriptor,
  FetchLike,
  SourceProvenance,
} from "@nec/resolver-evm";
import { NecResolverEvmError } from "@nec/resolver-evm";
import { parseHexHash } from "@nec/resolver-evm";

import { OPSTACK_MAX_ANCESTRY_DEPTH } from "./config.js";
import { runOpStackConsistencyChecks, allOpStackChecksPassed } from "./checks.js";
import type {
  ObservedBlockRef,
  OpStackAncestryWalkObservation,
  OpStackConsistencyCheck,
} from "./checks.js";
import { NecResolverOpStackError, opstackFail } from "./errors.js";
import type { NecResolverOpStackErrorCode } from "./errors.js";

export const OPSTACK_ACQUISITION_PROFILE = "nec-resolver-opstack-acquisition-v1";

/**
 * Replay never touches a real endpoint; this sentinel exists only to
 * satisfy transport construction and is recorded nowhere.
 */
export const OPSTACK_REPLAY_ENDPOINT = "http://nec-resolver-opstack.replay.invalid/";

/** The containing-block anchor observed for the subject by the generic flow. */
export interface OpStackSubjectBlockAnchor {
  /** Subject containing-block height S. */
  readonly number: bigint;
  /** Subject containing-block hash Hs (canonical lowercase 32-byte hex). */
  readonly hash: string;
}

/** One completed OP Stack finality observation from ONE configured source. */
export interface OpStackFinalityObservation {
  readonly profile: typeof OPSTACK_ACQUISITION_PROFILE;
  readonly source: SourceProvenance;
  readonly acquiredAt: Iso8601;
  readonly subjectBlock: OpStackSubjectBlockAnchor;
  /** Chain identity observed from THIS source (eth_chainId result). */
  readonly chain: EvmChainIdentityObservation;
  /** Observed "finalized" head; null means the source returned no block. */
  readonly finalizedHead: EvmBlockObservation | null;
  /** Observed "safe" head; null means the source returned no block. */
  readonly safeHead: EvmBlockObservation | null;
  /** Observed "latest" head; null means the source returned no block. */
  readonly latestHead: EvmBlockObservation | null;
  /**
   * The required finalized->subject ancestry walk; present exactly when a
   * walk was REQUIRED (observed finalized head at/above the subject height).
   * Absent when no finalized head was observed or it lies below the subject.
   */
  readonly ancestry: OpStackAncestryWalkObservation | undefined;
  /** Canonical block returned at EXACT height S; null means none returned. */
  readonly canonicalSubjectBlock: EvmBlockObservation | null;
  /**
   * Finalized-head stability re-read closing the burst; defined exactly when
   * it was performed (i.e. after a completed ancestry walk).
   */
  readonly finalizedReRead: EvmBlockObservation | null | undefined;
  /** Explicit maximum ancestry depth in force for this acquisition. */
  readonly maxAncestryDepth: number;
  readonly captures: readonly EvmRpcCapture[];
  readonly checks: readonly OpStackConsistencyCheck[];
  /** True iff every consistency check passed. */
  readonly consistent: boolean;
}

export interface OpStackFinalityAcquisitionInput {
  /** ONE explicitly configured evidentiary source (never a request URL). */
  readonly source: EvmRpcSourceDescriptor;
  /** Containing-block anchor of the subject from the generic EVM flow. */
  readonly subjectBlock: OpStackSubjectBlockAnchor;
  /** Explicit acquisition time; never derived from a clock. */
  readonly now: Iso8601;
  /**
   * Network fetch implementation. Live callers pass their configured
   * fetch; tests/replay inject scripted implementations. Refusing implicit
   * global network access keeps acquisitions explicit and auditable.
   */
  readonly fetchFn: FetchLike | undefined;
  /**
   * Explicit maximum finalized->subject ancestry depth. Defaults to the
   * ruleset ceiling; any value above the ceiling fails closed.
   */
  readonly maxAncestryDepth?: number;
}

/** Canonical 0x-prefixed lowercase hex quantity encoding of a block height. */
function hexQuantity(value: bigint): string {
  if (value < 0n) opstackFail("OPSTACK_SUBJECT_BLOCK_INVALID", "block numbers are non-negative");
  return `0x${value.toString(16)}`;
}

/** Hash+height+parentHash projection used by the ancestry walk records. */
function blockRef(block: EvmBlockObservation): ObservedBlockRef & { readonly parentHash: string } {
  return { hash: block.hash, number: block.number, parentHash: block.parentHash };
}

/**
 * Invoke one read, keeping THIS package's error surface: controlled
 * `NecResolverOpStackError`s (e.g. replay mismatches) pass through
 * unchanged; any other upstream failure is re-typed into
 * OPSTACK_RPC_REQUEST_FAILED with endpoint material redacted.
 */
async function callSource<T>(endpointUrl: string, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof NecResolverOpStackError) throw error;
    // Transport layers may wrap controlled errors as `cause`s (e.g. Viem's
    // HttpRequestError around a replay mismatch): unwrap before re-typing.
    let current = (error as { cause?: unknown }).cause;
    while (current !== null && current !== undefined && typeof current === "object") {
      if (current instanceof NecResolverOpStackError) throw current;
      const next = (current as { cause?: unknown }).cause;
      if (next === current || next === undefined || next === null) break;
      current = next;
    }
    const name = (error as { name?: unknown }).name;
    const details = (error as { details?: unknown }).details;
    const shortMessage = (error as { shortMessage?: unknown }).shortMessage;
    const parts = [typeof name === "string" ? name : "Error"];
    if (typeof shortMessage === "string") parts.push(shortMessage);
    if (typeof details === "string") parts.push(details);
    throw new NecResolverOpStackError(
      "OPSTACK_RPC_REQUEST_FAILED",
      `${parts.join(": ")} (${redactUrlOccurrences(error instanceof Error ? error.message : "unknown error", endpointUrl)})`,
    );
  }
}

/** Re-type frozen generic-resolver normalization failures into this surface. */
function retypeGenericError(error: unknown): never {
  if (error instanceof NecResolverOpStackError) throw error;
  if (error instanceof NecResolverEvmError) {
    const mapped: NecResolverOpStackErrorCode =
      error.code === "EVM_MALFORMED_RESPONSE"
        ? "OPSTACK_MALFORMED_RESPONSE"
        : error.code === "EVM_LIMIT_EXCEEDED"
          ? "OPSTACK_LIMIT_EXCEEDED"
          : error.code === "EVM_RPC_ERROR_RESPONSE"
            ? "OPSTACK_RPC_ERROR_RESPONSE"
            : "OPSTACK_MALFORMED_RESPONSE";
    throw new NecResolverOpStackError(mapped, error.message);
  }
  throw error;
}

/**
 * Acquire one OP Stack finality observation set from ONE configured source
 * over the live Viem path.
 */
export async function acquireOpStackFinalityObservation(
  input: OpStackFinalityAcquisitionInput,
): Promise<OpStackFinalityObservation> {
  validateEvmRpcSourceDescriptor(input.source);
  let maxAncestryDepth = OPSTACK_MAX_ANCESTRY_DEPTH;
  if (input.maxAncestryDepth !== undefined) {
    if (
      !Number.isSafeInteger(input.maxAncestryDepth) ||
      input.maxAncestryDepth < 1 ||
      input.maxAncestryDepth > OPSTACK_MAX_ANCESTRY_DEPTH
    ) {
      throw new NecResolverOpStackError(
        "OPSTACK_CONFIG_INVALID",
        `maxAncestryDepth must be an integer in [1, ${OPSTACK_MAX_ANCESTRY_DEPTH}]`,
      );
    }
    maxAncestryDepth = input.maxAncestryDepth;
  }
  if (input.fetchFn === undefined) {
    throw new NecResolverOpStackError(
      "OPSTACK_RPC_REQUEST_FAILED",
      "acquisition requires an explicit fetchFn; refusing implicit global network access",
    );
  }
  return runOpStackFinalityPipeline({
    provenance: sourceProvenance(input.source),
    endpointUrl: input.source.transport.url,
    subjectBlock: input.subjectBlock,
    now: input.now,
    fetchFn: input.fetchFn,
    maxAncestryDepth,
  });
}

/**
 * THE sequential pipeline shared by live acquisition and fixture replay:
 * dispatch reads one at a time against a recording client, convert each
 * exchange into a validated raw capture, normalize strictly from capture
 * text, then assemble consistency checks over the normalized views.
 */
export async function runOpStackFinalityPipeline(args: {
  provenance: SourceProvenance;
  endpointUrl: string;
  subjectBlock: OpStackSubjectBlockAnchor;
  now: Iso8601;
  fetchFn: FetchLike;
  maxAncestryDepth: number;
}): Promise<OpStackFinalityObservation> {
  if (typeof args.now !== "string") {
    throw new NecResolverOpStackError("OPSTACK_TIME_INVALID", "now must be an ISO-8601 UTC timestamp string");
  }
  try {
    validateAcquisitionClock(args.now);
  } catch (error) {
    throw new NecResolverOpStackError(
      "OPSTACK_TIME_INVALID",
      `now must be exactly YYYY-MM-DDTHH:mm:ss.sssZ (${(error as Error).message})`,
    );
  }
  let subjectHash: string;
  try {
    subjectHash = parseHexHash(args.subjectBlock.hash, "subjectBlock.hash");
  } catch (error) {
    throw new NecResolverOpStackError(
      "OPSTACK_SUBJECT_BLOCK_INVALID",
      `subjectBlock.hash must be a lowercase 0x-prefixed 32-byte hash (${(error as Error).message})`,
    );
  }
  const subjectBlock: OpStackSubjectBlockAnchor = deepFreeze({
    number: args.subjectBlock.number,
    hash: subjectHash,
  }) as OpStackSubjectBlockAnchor;

  const { client, recordings } = createSourceClient(args.endpointUrl, args.fetchFn);

  /**
   * One logical JSON-RPC read via Viem's typed request primitive. As in the
   * generic resolver, provider-null results (e.g. an unavailable head) are
   * first-class captured evidence — never converted into thrown exceptions.
   */
  function readViaViem(method: string, params: unknown[]): Promise<unknown> {
    return callSource(args.endpointUrl, () =>
      client.request({ method, ...(params.length === 0 ? {} : { params }) } as never),
    );
  }

  /**
   * Convert the exchange recorded by the JUST-COMPLETED await into a raw
   * capture. Sequential dispatching guarantees a 1:1 mapping between
   * logical reads and recorded exchanges.
   */
  const captureOfLastRead = (): EvmRpcCapture => {
    const last = recordings[recordings.length - 1];
    if (last === undefined) {
      opstackFail(
        "OPSTACK_MALFORMED_RESPONSE",
        "expected exactly one new recorded exchange per dispatched read",
      );
    }
    try {
      return buildCapture({
        provenance: args.provenance,
        rpcMethod: last.rpcMethod,
        rpcRequestId: last.rpcRequestId,
        rpcParams: last.rpcParams,
        httpStatus: last.httpStatus,
        responseBody: last.responseBody,
        acquiredAt: args.now,
      });
    } catch (error) {
      retypeGenericError(error);
    }
  };

  // --- read 1: chain identity (identity gate) ---------------------------------
  await readViaViem("eth_chainId", []);
  const chainCapture = captureOfLastRead();
  let chain: EvmChainIdentityObservation;
  try {
    chain = parseChainIdResult(chainCapture.resultText);
  } catch (error) {
    retypeGenericError(error);
  }

  if (chain.chainId !== BigInt(args.provenance.chainId)) {
    throw new NecResolverOpStackError(
      "OPSTACK_NETWORK_MISMATCH",
      `source ${args.provenance.sourceId} reports chainId ${chain.chainId} but is configured for chainId ${args.provenance.chainId}`,
    );
  }

  const captures: EvmRpcCapture[] = [chainCapture];

  // --- reads 2..4: finalized head, safe head, latest head ---------------------
  async function readHead(param: string): Promise<{
    capture: EvmRpcCapture;
    block: EvmBlockObservation | null;
  }> {
    await readViaViem("eth_getBlockByNumber", [param, false]);
    const capture = captureOfLastRead();
    try {
      return { capture, block: parseBlockResult(capture.resultText) };
    } catch (error) {
      retypeGenericError(error);
    }
  }

  const finalizedRead = await readHead("finalized");
  captures.push(finalizedRead.capture);

  const safeRead = await readHead("safe");
  captures.push(safeRead.capture);

  const latestRead = await readHead("latest");
  captures.push(latestRead.capture);

  // --- required bounded parentHash ancestry walk ------------------------------
  //
  // Performed EXACTLY when an observed finalized head lies at or above the
  // subject height. The walk follows recorded parentHash links one explicit
  // eth_getBlockByHash read at a time and truncates at the first broken
  // link; ancestry is never extrapolated from block numbers alone.
  let ancestry: OpStackAncestryWalkObservation | undefined;
  let walkCompleted = false;
  const finalizedHead = finalizedRead.block;
  if (finalizedHead !== null && finalizedHead.number >= subjectBlock.number) {
    const requiredDepth = finalizedHead.number - subjectBlock.number;
    if (requiredDepth > BigInt(args.maxAncestryDepth)) {
      // Fail closed BEFORE any walk: the required chain exceeds the
      // explicitly configured evidentiary budget. No ancestry may be claimed.
      ancestry = { requiredDepth, maxDepth: args.maxAncestryDepth, blocks: [] };
    } else {
      const walkedBlocks: (ObservedBlockRef & { readonly parentHash: string } | null)[] = [];
      let current: EvmBlockObservation = finalizedHead;
      let broke = false;
      while (current.number > subjectBlock.number) {
        await readViaViem("eth_getBlockByHash", [current.parentHash, false]);
        const capture = captureOfLastRead();
        captures.push(capture);
        let parent: EvmBlockObservation | null;
        try {
          parent = parseBlockResult(capture.resultText);
        } catch (error) {
          retypeGenericError(error);
        }
        if (
          parent === null ||
          parent.number !== current.number - 1n ||
          parent.hash !== current.parentHash
        ) {
          // First-class captured evidence of a broken link: record the
          // missing/ill-fitting ancestor and stop walking.
          walkedBlocks.push(parent === null ? null : blockRef(parent));
          broke = true;
          break;
        }
        walkedBlocks.push(blockRef(parent));
        current = parent;
      }
      walkCompleted = !broke && current.number === subjectBlock.number;
      ancestry = {
        requiredDepth,
        maxDepth: args.maxAncestryDepth,
        blocks: walkedBlocks,
      };
    }
  }

  // --- canonical exact-height re-read at S ------------------------------------
  const canonicalRead = await readHead(hexQuantity(subjectBlock.number));
  captures.push(canonicalRead.capture);

  // --- burst-stability re-read of the finalized head ---------------------------
  // Only meaningful once a complete ancestry was walked: it closes the
  // observation burst over the SAME claim the walk established.
  let finalizedReRead: EvmBlockObservation | null | undefined;
  if (walkCompleted) {
    const reRead = await readHead("finalized");
    captures.push(reRead.capture);
    finalizedReRead = reRead.block;
  }

  const expectedReads = captures.length;
  if (recordings.length !== expectedReads) {
    opstackFail(
      "OPSTACK_MALFORMED_RESPONSE",
      `expected exactly ${expectedReads} exchanges, saw ${recordings.length}`,
    );
  }

  const checks = runOpStackConsistencyChecks({
    expectedChainId: BigInt(args.provenance.chainId),
    observedChainId: chain.chainId,
    subjectBlockNumber: subjectBlock.number,
    subjectBlockHash: subjectBlock.hash,
    canonicalSubjectBlock:
      canonicalRead.block === null
        ? null
        : { hash: canonicalRead.block.hash, number: canonicalRead.block.number },
    safeHead:
      safeRead.block === null ? null : { hash: safeRead.block.hash, number: safeRead.block.number },
    finalizedHead:
      finalizedRead.block === null
        ? null
        : {
            hash: finalizedRead.block.hash,
            number: finalizedRead.block.number,
            parentHash: finalizedRead.block.parentHash,
          },
    latestHead:
      latestRead.block === null
        ? null
        : { hash: latestRead.block.hash, number: latestRead.block.number },
    ancestryWalk: ancestry,
    finalizedReRead:
      finalizedReRead === undefined
        ? undefined
        : finalizedReRead === null
          ? null
          : { hash: finalizedReRead.hash, number: finalizedReRead.number },
    initialFinalizedHash:
      finalizedReRead === undefined || finalizedRead.block === null
        ? undefined
        : finalizedRead.block.hash,
  });

  const observation: OpStackFinalityObservation = {
    profile: OPSTACK_ACQUISITION_PROFILE,
    source: args.provenance,
    acquiredAt: args.now,
    subjectBlock,
    chain,
    finalizedHead: finalizedRead.block,
    safeHead: safeRead.block,
    latestHead: latestRead.block,
    ancestry,
    canonicalSubjectBlock: canonicalRead.block,
    finalizedReRead,
    maxAncestryDepth: args.maxAncestryDepth,
    captures,
    checks,
    consistent: allOpStackChecksPassed(checks),
  };
  return deepFreeze(observation);
}
