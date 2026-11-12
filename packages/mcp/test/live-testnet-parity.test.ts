/**
 * Testnet parity at the hosted MCP tool surface (offline replay, no live read).
 *
 * Real captures, served verbatim (exact resultJson bytes) for the exact
 * recorded params; no identifier is paired with foreign bytes:
 * - Base Sepolia: adapter-erc4337 base-sepolia-external-v06-userop.json
 *   (0xde8916c8…ed45, captured 2026-09-26).
 * - Solana devnet: resolver-solana solana-devnet-before-probe.json
 *   (4D3WXyMK…kFpJ, captured 2026-10-08).
 * Every other answer is a SIMULATED, documented mutation used only by tests
 * titled SIMULATED (see `provider`).
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { decodeNecWireJson } from "@nec/core";
import { startNeMcpHttpServer } from "../src/http.js";
import { createMultichainTool, LIVE_MULTICHAIN_TOOL } from "../src/live-multichain.js";
import { LIVE_BEFORE_TOOL_NAME } from "../src/live-before.js";
import { simulatedHostFetch } from "./helpers.js";

interface Capture { rpcMethod: string; rpcParams: unknown[]; resultJson: string }
const read = <T>(path: string): T => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as T;
const BASE = read<{ source: { networkId: string; chainId: number }; subject: { txHash: string }; captures: Capture[] }>(
  "../../adapter-erc4337/test/fixtures/base-sepolia-external-v06-userop.json");
const DEVNET = read<{ source: { networkId: string }; subject: { signature: string }; captures: Capture[] }>(
  "../../resolver-solana/test/fixtures/solana-devnet-before-probe.json");

const ORIGIN = "https://mcp.example.org";
const HOST = "mcp.example.org";
const BASE_URL = "https://sepolia.base.org/";
const DEVNET_URL = "https://api.devnet.solana.com/";
const SOURCE_HOSTS = ["sepolia.base.org", "api.devnet.solana.com"];
const ERROR_TEXT = "SECRET_INTERNAL_PROVIDER_MESSAGE_NEVER_EXPOSED";
const LEAK_URL = "https://internal-provider.example/upstream?key=SECRET_PROVIDER_KEY";
const BASE_SUBJECT = { type: "transaction", networkId: "eip155:84532", txId: BASE.subject.txHash } as const;
const DEVNET_SUBJECT = { type: "transaction", networkId: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", txId: DEVNET.subject.signature } as const;
const BASE_METHODS = ["eth_chainId", "eth_getTransactionReceipt", "eth_getBlockByHash", "eth_getTransactionByHash"];
const DEVNET_METHODS = ["getGenesisHash", "getTransaction", "getSignatureStatuses", "getBlock"];
const REQUIREMENTS = { requirements: [
  { capability: "execution", strength: "required" },
  { capability: "finality", strength: "desired" },
] };
/** Wording a failed read must never produce (it would claim absence or a verdict). */
const VERDICT_OR_ABSENCE = /absent|not exist|nonexist|never existed|contradicted|supported/i;

type BodyState = "open" | "drained" | "cancelled";

/** A provider error body that records whether it was cancelled or read to EOF. */
function trackedBody(text: string) {
  const tracked: { state: BodyState } = { state: "open" };
  let sent = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) { sent = true; controller.enqueue(new TextEncoder().encode(text)); return; }
      tracked.state = "drained";
      controller.close();
    },
    cancel() { tracked.state = "cancelled"; },
  });
  return { tracked, stream };
}

interface Simulated {
  /** Base Sepolia receipt and transaction answers replaced by null. */
  nullBaseReceipt?: boolean;
  /** The first read to this endpoint answers this HTTP status with provider text, a URL and headers. */
  httpError?: { endpoint: "base" | "devnet"; status: 503 | 429 };
  /** devnet getTransaction answers HTTP 200 with this JSON-RPC error code. */
  devnetRpcError?: number;
  /** devnet getTransaction answers the real capture with only `version` set to 1. */
  devnetVersion1?: boolean;
}

/**
 * Offline replay of the two real captures for the two fixed testnet origins
 * only (any other URL throws). `sim` is read at call time so one hosted
 * server can replay several SIMULATED answers in sequence.
 */
function provider(sim: Simulated = {}) {
  const methods: string[] = [];
  const bodies: { state: BodyState }[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).href;
    const req = JSON.parse(init?.body as string) as { id: number; method: string; params?: unknown[] };
    methods.push(req.method);
    const endpoint = url === BASE_URL ? "base" : url === DEVNET_URL ? "devnet" : null;
    if (endpoint === null) throw Error("Unapproved fake endpoint");
    const respond = (body: string | ReadableStream<Uint8Array>, status: number, headers: Record<string, string>) => {
      const response = new Response(body, { status, headers });
      Object.defineProperty(response, "url", { value: url });
      return response;
    };
    const failure = sim.httpError;
    if (failure !== undefined && failure.endpoint === endpoint) {
      const body = trackedBody(`${ERROR_TEXT} upstream ${LEAK_URL}`);
      bodies.push(body.tracked);
      return respond(body.stream, failure.status, {
        "content-type": "text/plain", "retry-after": "30", "x-upstream-detail": LEAK_URL,
      });
    }
    const found = (endpoint === "base" ? BASE : DEVNET).captures.find(c => c.rpcMethod === req.method);
    if (!found) throw Error("Unexpected mock method");
    if (JSON.stringify(req.params ?? []) !== JSON.stringify(found.rpcParams)) throw Error("Unexpected mock params");
    let resultText = found.resultJson;
    if (endpoint === "base" && sim.nullBaseReceipt
      && (req.method === "eth_getTransactionReceipt" || req.method === "eth_getTransactionByHash")) resultText = "null";
    if (endpoint === "devnet" && req.method === "getTransaction") {
      if (sim.devnetRpcError !== undefined) {
        const error = { code: sim.devnetRpcError, message: `${ERROR_TEXT}: transaction version is not supported by the requesting client` };
        return respond(`{"jsonrpc":"2.0","id":${JSON.stringify(req.id)},"error":${JSON.stringify(error)}}`, 200, {"content-type": "application/json"});
      }
      if (sim.devnetVersion1) resultText = JSON.stringify({ ...JSON.parse(found.resultJson) as Record<string, unknown>, version: 1 });
    }
    return respond(`{"jsonrpc":"2.0","id":${JSON.stringify(req.id)},"result":${resultText}}`, 200, {"content-type": "application/json"});
  };
  return { fetchFn, methods, bodies, sim };
}

/** One hosted opt-in server + modern MCP client over a SIMULATED public Host. */
async function hosted(fetchFn: typeof fetch, run: (call: (name: string, args: Record<string, unknown>) => Promise<any>) => Promise<void>) {
  const server = await startNeMcpHttpServer({
    host: "127.0.0.1", port: 0, hosted: { publicOrigin: ORIGIN }, liveEvidence: createMultichainTool(fetchFn),
  });
  try {
    const client = new Client({ name: "live-testnet-parity-test", version: "1" }, { versionNegotiation: { mode: "auto" } });
    await client.connect(new StreamableHTTPClientTransport(new URL(ORIGIN + "/mcp"), { fetch: simulatedHostFetch(server.port, HOST) }));
    try {
      await run((name, args) => client.callTool({ name, arguments: args }));
    } finally { await client.close(); }
  } finally { await server.close(); }
}

/** A failed tool call: bounded safe error only, no structured evidence, no source detail. */
function toolErrorOf(result: any): { code: string; text: string } {
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toBeUndefined();
  const text = result.content[0].text as string;
  for (const leak of [ERROR_TEXT, LEAK_URL, "internal-provider.example", ...SOURCE_HOSTS]) expect(text).not.toContain(leak);
  expect(text).not.toMatch(VERDICT_OR_ABSENCE);
  const parsed = JSON.parse(text) as { error: { code: string; message: string; cause: unknown } };
  expect(Object.keys(parsed)).toEqual(["error"]);
  expect(Object.keys(parsed.error).sort()).toEqual(["cause", "code", "message"]);
  expect(parsed.error.cause).toBeNull();
  return { code: parsed.error.code, text };
}

const noSourceUrl = (value: unknown) => {
  for (const host of SOURCE_HOSTS) expect(JSON.stringify(value)).not.toContain(host);
};

const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async () => {
    throw new Error("network I/O is forbidden in live-testnet-parity tests");
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("testnet parity: real Base Sepolia and Solana devnet captures at the hosted MCP surface", () => {
  it("replays both real testnet captures (offline) through resolve_transaction_evidence and discover_live_network_evidence", async () => {
    expect(BASE.subject.txHash).toBe("0xde8916c81ef6a7b36ddf9f7b44d1ca096e4db4818eddfd5e16eda8a7c292ed45");
    expect(BASE.source).toMatchObject({ networkId: "eip155:84532", chainId: 84532 });
    expect(DEVNET.subject.signature).toBe("4D3WXyMK9HdpXuXwM5H9ZrQ5i6ofVhygVKZMcYK9VjKkvDkhzhtoBtsMGRBsQF9R49RfkrDsdWwX2AdkmqbwkFpJ");
    expect(DEVNET.source.networkId).toBe(DEVNET_SUBJECT.networkId);
    const p = provider();
    await hosted(p.fetchFn, async (call) => {
      // Base Sepolia AFTER.
      const base = await call(LIVE_MULTICHAIN_TOOL, { subject: BASE_SUBJECT });
      expect(base.isError).toBeFalsy();
      const b = base.structuredContent as any;
      expect(b).toMatchObject({
        observationKind: "live_source_observation", evidenceBasis: "source_observation", toolStatus: "observed",
        artifactType: "network-evidence-fragment", subject: BASE_SUBJECT,
        source: { networkId: "eip155:84532", chainId: 84532, sourceType: "evm_rpc" },
        acquisition: { transactionObserved: true, transactionLookupUsable: true, blockObserved: true, consistent: true },
      });
      expect(p.methods).toEqual(BASE_METHODS);
      expect(b.acquisition.captures.map((x: any) => x.rpcMethod)).toEqual(BASE_METHODS);
      // Byte-for-byte: each capture's result size equals the real recorded resultJson.
      expect(b.acquisition.captures.map((x: any) => [x.httpStatus, x.resultBytes])).toEqual(
        BASE_METHODS.map(m => [200, Buffer.byteLength(BASE.captures.find(c => c.rpcMethod === m)!.resultJson)]));
      expect(b.fragment.networkEvidence.execution.verdict).toBe("supported");
      expect(b.fragment.networkEvidence).not.toHaveProperty("finality");
      expect(b.fragment.networkEvidence).not.toHaveProperty("settlement");
      expect(b).not.toHaveProperty("opStackFinality");
      expect(b.acquisition.captures.every((x: any) => x.contentDigest.startsWith("sha256:"))).toBe(true);
      expect(b.fragment.evidence.every((x: any) => x.contentDigest.startsWith("sha256:"))).toBe(true);
      const baseCore = decodeNecWireJson("network-evidence-fragment", JSON.stringify(b.fragment));
      expect(baseCore.subject).toEqual(BASE_SUBJECT);
      noSourceUrl(base);

      // Solana devnet AFTER.
      p.methods.length = 0;
      const dev = await call(LIVE_MULTICHAIN_TOOL, { subject: DEVNET_SUBJECT });
      expect(dev.isError).toBeFalsy();
      const d = dev.structuredContent as any;
      expect(d).toMatchObject({
        observationKind: "live_source_observation", evidenceBasis: "source_observation", toolStatus: "observed",
        artifactType: "network-evidence-fragment", subject: DEVNET_SUBJECT,
        source: { networkId: DEVNET_SUBJECT.networkId, sourceType: "svm_rpc" },
        acquisition: {
          transactionObserved: true, blockObserved: true, consistent: true,
          solanaProbe: { finalizedCommitmentObserved: true, lookupsCoherent: true },
        },
      });
      expect(p.methods).toEqual(DEVNET_METHODS);
      expect(d.acquisition.captures.map((x: any) => x.rpcMethod)).toEqual(DEVNET_METHODS);
      expect(d.acquisition.captures.map((x: any) => [x.httpStatus, x.resultBytes])).toEqual(
        DEVNET_METHODS.map(m => [200, Buffer.byteLength(DEVNET.captures.find(c => c.rpcMethod === m)!.resultJson)]));
      const e = d.fragment.networkEvidence;
      expect(e.execution.verdict).toBe("supported");
      // Finality only as the source-reported finalized commitment.
      expect(e.finality.verdict).toBe("supported");
      expect(e.finality.basis).toEqual(["source_observation"]);
      expect(e.finality.metadata).toEqual({ basis: "source_observation", commitment: "finalized", economicIrreversibilityEstablished: false });
      expect(e).not.toHaveProperty("settlement");
      expect(d.nonClaims.some((x: string) => x.includes("source-reported, not an independent cryptographic proof"))).toBe(true);
      expect(d.acquisition.captures.every((x: any) => x.contentDigest.startsWith("sha256:"))).toBe(true);
      expect(d.fragment.evidence.every((x: any) => x.contentDigest.startsWith("sha256:"))).toBe(true);
      noSourceUrl(dev);

      // BEFORE/Discovery over both testnet subjects.
      p.methods.length = 0;
      const discovered = await call(LIVE_BEFORE_TOOL_NAME, {
        requestId: "ne_mcp_testnet_parity_1", requirements: REQUIREMENTS, subjects: [BASE_SUBJECT, DEVNET_SUBJECT],
      });
      expect(discovered.isError).toBeFalsy();
      const out = discovered.structuredContent as any;
      expect(out).toMatchObject({
        schema: "ne-mcp-live-discovery/v0.1", observationKind: "live_source_observation",
        builtAndVerifiedBy: "@nec/discovery + @nec/core",
      });
      // Pinned observed classifications. They equal the mainnet analogy
      // (Base conditional: generic EVM finality unsupported while finality is
      // only desired; Solana eligible: source-reported finalized commitment).
      // A different value is a stop-and-report condition, never a refit.
      expect(out.candidates.map((c: any) => [c.id, c.environment, c.classification])).toEqual([
        ["base-sepolia", "testnet", "conditional"], ["solana-devnet", "testnet", "eligible"],
      ]);
      const [bc, sc] = out.candidates;
      expect(bc.capabilities.execution.availability).toBe("available");
      expect(bc.capabilities.finality.availability).toBe("unavailable");
      expect(bc.capabilities.settlement.support).toBe("unsupported");
      expect(sc.capabilities.execution.availability).toBe("available");
      expect(sc.capabilities.finality.availability).toBe("available");
      expect(sc.capabilities.settlement.support).toBe("unsupported");
      expect(bc.evidenceCaptures.map((c: any) => c.rpcMethod)).toEqual(BASE_METHODS);
      expect(sc.evidenceCaptures.map((c: any) => c.rpcMethod)).toEqual(DEVNET_METHODS);
      expect(p.methods).toEqual([...BASE_METHODS, ...DEVNET_METHODS]);
      for (const c of out.candidates) {
        expect(c.evidenceCaptures.every((x: any) => x.contentDigest.startsWith("sha256:"))).toBe(true);
        expect(c.snapshotDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
      }
      const core = decodeNecWireJson("discovery-result", JSON.stringify(out.result));
      expect(core.matches.map(m => m.classification)).toEqual(["conditional", "eligible"]);
      expect(core.matches[0]?.capabilitySnapshot.digest).toBe(bc.snapshotDigest);
      expect(core.matches[1]?.capabilitySnapshot.digest).toBe(sc.snapshotDigest);
      noSourceUrl(discovered);
    });
  });

  it("SIMULATED (real Base Sepolia capture, receipt+transaction nulled): execution insufficient, never contradicted, with the non-proof-of-absence non-claim", async () => {
    const p = provider({ nullBaseReceipt: true });
    await hosted(p.fetchFn, async (call) => {
      const result = await call(LIVE_MULTICHAIN_TOOL, { subject: BASE_SUBJECT });
      expect(result.isError).toBeFalsy();
      const value = result.structuredContent as any;
      expect(p.methods).toEqual(["eth_chainId", "eth_getTransactionReceipt", "eth_getTransactionByHash"]);
      expect(value.acquisition).toMatchObject({ transactionObserved: false, transactionLookupUsable: false, blockObserved: false, consistent: true });
      expect(value.fragment.networkEvidence.execution.verdict).toBe("insufficient");
      for (const dimension of Object.values(value.fragment.networkEvidence) as any[]) expect(dimension.verdict).not.toBe("contradicted");
      expect(value.fragment.networkEvidence).not.toHaveProperty("finality");
      expect(value.fragment.networkEvidence).not.toHaveProperty("settlement");
      expect(value.nonClaims.some((x: string) => x.includes("not proof that the transaction never existed"))).toBe(true);
      noSourceUrl(result);

      p.methods.length = 0;
      const discovered = await call(LIVE_BEFORE_TOOL_NAME, {
        requestId: "ne_mcp_testnet_null_receipt_1", requirements: REQUIREMENTS, subjects: [BASE_SUBJECT],
      });
      expect(discovered.isError).toBeFalsy();
      const out = discovered.structuredContent as any;
      expect(out.candidates.map((c: any) => [c.id, c.classification])).toEqual([["base-sepolia", "ineligible"]]);
      expect(out.candidates[0].capabilities.execution.availability).toBe("unavailable");
      expect(out.candidates[0].capabilities.finality.availability).toBe("unavailable");
      expect(out.nonClaims.some((x: string) => x.includes("not proof of network unavailability"))).toBe(true);
      expect(p.methods).toEqual(["eth_chainId", "eth_getTransactionReceipt", "eth_getTransactionByHash"]);
      noSourceUrl(discovered);
    });
  });

  it("SIMULATED HTTP 503 and 429 from each testnet endpoint: fail-closed source error, body not left open, nothing leaked", async () => {
    // Observed per path (pinned; no src change, no new code):
    // - Base Sepolia: the EVM guard does not cancel; it reads the error body
    //   to EOF within LIVE_EVM_MAX_RPC_BYTES and Viem maps the status, so the
    //   body is "drained". The code is the existing MCP_LIVE_EVM_RPC_FAILED.
    // - Solana devnet: the Solana guard cancels the non-200 body unread.
    // A provider 429 is never reported as this server's own rate-limit code.
    const cases = [
      { endpoint: "base", subject: BASE_SUBJECT, method: "eth_chainId", code: "MCP_LIVE_EVM_RPC_FAILED", body: "drained" },
      { endpoint: "devnet", subject: DEVNET_SUBJECT, method: "getGenesisHash", code: "MCP_MULTICHAIN_SOURCE_FAILED", body: "cancelled" },
    ] as const;
    for (const c of cases) {
      const p = provider();
      await hosted(p.fetchFn, async (call) => {
        for (const status of [503, 429] as const) {
          p.sim.httpError = { endpoint: c.endpoint, status };
          p.methods.length = 0;
          const resolved = toolErrorOf(await call(LIVE_MULTICHAIN_TOOL, { subject: c.subject }));
          expect(resolved.code).toBe(c.code);
          expect(p.methods).toEqual([c.method]);
          expect(p.bodies.at(-1)?.state).toBe(c.body);

          p.methods.length = 0;
          const discovered = toolErrorOf(await call(LIVE_BEFORE_TOOL_NAME, {
            requestId: "ne_mcp_testnet_http_error_1", requirements: REQUIREMENTS, subjects: [c.subject],
          }));
          expect(discovered.code).toBe("MCP_LIVE_BEFORE_UNAVAILABLE");
          expect(p.methods).toEqual([c.method]);
          expect(p.bodies.at(-1)?.state).toBe(c.body);
          for (const code of [resolved.code, discovered.code]) {
            expect(code).not.toBe("MCP_MULTICHAIN_RATE_LIMIT");
            expect(code).not.toBe("MCP_LIVE_EVM_RATE_LIMIT");
          }
        }
        expect(p.bodies).toHaveLength(4);
      });
    }
  });

  it("SIMULATED devnet getTransaction JSON-RPC -32015 and a version-1 answer: pinned MCP_MULTICHAIN_SOURCE_FAILED, never absent, contradicted or supported", async () => {
    // Source/subject conflation, recorded as observed: -32015 and an
    // unsupported `version` are properties of the SUBJECT's encoding relative
    // to the fixed maxSupportedTransactionVersion: 0 request, yet the MCP
    // boundary reports them with the SOURCE-failure code. Pinned, not changed
    // here (no new error codes). The version-1 answer is a mutation of the
    // real devnet capture (`version` only); it does not claim that version-1
    // transactions exist on any network.
    const simulated: Simulated[] = [{ devnetRpcError: -32015 }, { devnetVersion1: true }];
    for (const sim of simulated) {
      const p = provider(sim);
      await hosted(p.fetchFn, async (call) => {
        const resolved = toolErrorOf(await call(LIVE_MULTICHAIN_TOOL, { subject: DEVNET_SUBJECT }));
        expect(resolved.code).toBe("MCP_MULTICHAIN_SOURCE_FAILED");
        expect(resolved.text).not.toContain("-32015");
        expect(resolved.text).not.toMatch(/version/i);
        expect(p.methods).toEqual(["getGenesisHash", "getTransaction"]);

        p.methods.length = 0;
        const discovered = toolErrorOf(await call(LIVE_BEFORE_TOOL_NAME, {
          requestId: "ne_mcp_testnet_version_1", requirements: REQUIREMENTS, subjects: [DEVNET_SUBJECT],
        }));
        expect(discovered.code).toBe("MCP_LIVE_BEFORE_UNAVAILABLE");
        expect(p.methods).toEqual(["getGenesisHash", "getTransaction"]);
      });
    }
  });
});
