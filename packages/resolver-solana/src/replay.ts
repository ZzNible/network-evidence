import { runSolanaAcquisitionPipeline, REPLAY_ENDPOINT } from "./acquire.js";
import type { SolanaTransactionAcquisition } from "./acquire.js";
import { NecResolverSolanaError } from "./errors.js";
import { exchangeIdentityKey } from "./rpc.js";
import type { FetchLike } from "./rpc.js";
import { validateSolanaAcquisitionFixture } from "./fixture.js";

export async function replaySolanaTransaction(fixtureValue: unknown): Promise<SolanaTransactionAcquisition> {
  const fixture = validateSolanaAcquisitionFixture(fixtureValue);
  let cursor = 0;
  const fetchFn: FetchLike = async (_input, init) => {
    let request: Record<string, unknown>;
    try { request = JSON.parse(typeof init?.body === "string" ? init.body : "") as Record<string, unknown>; }
    catch { throw new NecResolverSolanaError("SOLANA_REPLAY_UNMATCHED_REQUEST", "replay received malformed request"); }
    const params = Array.isArray(request.params) ? request.params : [];
    const expected = fixture.captures[cursor];
    if (typeof request.method !== "string" || expected === undefined || exchangeIdentityKey(request.method, params) !== exchangeIdentityKey(expected.rpcMethod, expected.rpcParams)) {
      throw new NecResolverSolanaError("SOLANA_REPLAY_UNMATCHED_REQUEST", `capture ${cursor} does not match outbound request`);
    }
    cursor += 1;
    const result = "resultJson" in expected
      ? `"result":${expected.resultJson}`
      : `"error":{"code":${expected.error.code},"message":${JSON.stringify(expected.error.message)}}`;
    return new Response(`{"jsonrpc":"2.0","id":${JSON.stringify(request.id)},${result}}`, { status: expected.httpStatus, headers: { "content-type": "application/json" } });
  };
  const acquisition = await runSolanaAcquisitionPipeline({ provenance: fixture.source, endpoint: REPLAY_ENDPOINT, signature: fixture.subject.signature, now: fixture.acquiredAt, fetchFn });
  if (cursor !== fixture.captures.length) throw new NecResolverSolanaError("SOLANA_REPLAY_UNUSED_CAPTURES", `fixture contains ${fixture.captures.length - cursor} unused capture(s)`);
  return acquisition;
}
