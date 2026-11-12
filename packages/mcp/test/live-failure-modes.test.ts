/**
 * NE-L025 anti-drift contract for the agent-facing live-tool failure modes in
 * packages/mcp/README.md (fenced `json ne-failure-modes` block). Offline
 * replay: an in-process fake provider behind a hosted server on loopback,
 * driven by an SDK client over tools/call. Global fetch throws.
 *
 * Provider bytes are real pinned captures only, served verbatim per method:
 * - Base mainnet: x402 #1062 USDC transfer 0x8e01…e696 (the historical-compat
 *   "F1" authority fixture; unrelated to row F1 below).
 * - Base Sepolia: adapter-erc4337 base-sepolia-external-v06-userop.json (0xde8916c8…ed45).
 * - Solana mainnet: resolver-solana solana-mainnet-x402-real.json.
 * - Solana devnet: resolver-solana solana-devnet-before-probe.json.
 * Every other answer (HTTP status, null, JSON-RPC error, version, padding,
 * hold) is a SIMULATED mutation, named in the row title and in `provider`.
 *
 * Rows F1-F18 each assert the exact code or envelope and the exact ordered
 * provider methods read; the last test checks the README block against the
 * error-code literals in src/live-*.ts and against what every row observed.
 * F18's evidenceContext values are test-authored (not an original caller's).
 */
import { readdirSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { computeEvidencePolicyDigest, encodeNecWireJson } from "@nec/core";
import { startNeMcpHttpServer } from "../src/http.js";
import { LIVE_EVM_MAX_RPC_BYTES } from "../src/live-evm.js";
import { createMultichainTool, LIVE_MULTICHAIN_TOOL, MULTICHAIN_CALLS_PER_MINUTE } from "../src/live-multichain.js";
import { SOLANA_NETWORKS, SOLANA_RESPONSE_MAX_BYTES } from "../src/live-solana.js";
import { LIVE_BEFORE_TOOL_NAME } from "../src/live-before.js";
import { LIVE_PREFLIGHT_TOOL_NAME } from "../src/live-preflight.js";
import { EVIDENCE_CONTEXT_MAX_BYTES } from "../src/live-result.js";
import { LIVE_TOOL_NAMES } from "../src/tools.js";
import { collectKeys, simulatedHostFetch } from "./helpers.js";

interface Capture { rpcMethod: string; rpcParams?: unknown[]; resultJson: string }
interface Fixture { captures: Capture[] }
const read = <T>(path: string): T => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as T;
const X402_1062 = read<Fixture & { subject: { txHash: string } }>(
  "../../../examples/historical-compat/authority/fixtures/F1-x402-1062-partial/source/network-evidence/fixtures/base-mainnet-x402-1062-usdc-transfer.fixture.json");
const SEPOLIA = read<Fixture & { subject: { txHash: string } }>("../../adapter-erc4337/test/fixtures/base-sepolia-external-v06-userop.json");
const SOL = read<Fixture & { subject: { signature: string } }>("../../resolver-solana/test/fixtures/solana-mainnet-x402-real.json");
const DEVNET = read<Fixture & { subject: { signature: string } }>("../../resolver-solana/test/fixtures/solana-devnet-before-probe.json");

const ORIGIN = "https://mcp.example.org";
const HOST = "mcp.example.org";
type Endpoint = "base-mainnet" | "base-sepolia" | "solana-mainnet" | "solana-devnet";
/** The only provider URLs the guards admit (`new URL(source.url).href`). */
const ENDPOINTS: Readonly<Record<string, Endpoint>> = {
  "https://mainnet.base.org/": "base-mainnet",
  "https://sepolia.base.org/": "base-sepolia",
  "https://api.mainnet-beta.solana.com/": "solana-mainnet",
  "https://api.devnet.solana.com/": "solana-devnet",
};
const RPC_HOSTNAMES = ["mainnet.base.org", "sepolia.base.org", "api.mainnet-beta.solana.com", "api.devnet.solana.com"];
const FIXTURES: Readonly<Record<Endpoint, Fixture>> = {
  "base-mainnet": X402_1062, "base-sepolia": SEPOLIA, "solana-mainnet": SOL, "solana-devnet": DEVNET,
};
const PROVIDER_TEXT = "PROVIDER_TEXT_NE_L025_NEVER_EXPOSED";
const LEAK_URL = "https://internal-provider.example/upstream?key=SECRET_PROVIDER_KEY";

const BASE_SUBJECT = { type: "transaction", networkId: "eip155:8453", txId: X402_1062.subject.txHash } as const;
const SEPOLIA_SUBJECT = { type: "transaction", networkId: "eip155:84532", txId: SEPOLIA.subject.txHash } as const;
const SOL_SUBJECT = { type: "transaction", networkId: SOLANA_NETWORKS["solana-mainnet"].networkId, txId: SOL.subject.signature } as const;
const DEVNET_SUBJECT = { type: "transaction", networkId: SOLANA_NETWORKS["solana-devnet"].networkId, txId: DEVNET.subject.signature } as const;
const BASE_READS = ["eth_chainId", "eth_getTransactionReceipt", "eth_getBlockByHash", "eth_getTransactionByHash"];
const NULL_RECEIPT_READS = ["eth_chainId", "eth_getTransactionReceipt", "eth_getTransactionByHash"];
const REQUIREMENTS = { requirements: [{ capability: "execution", strength: "required" }] };
/** Keys a failed call must never carry. */
const VERDICT_KEYS = ["verdict", "classification", "readiness"];

/** Test-authored caller request (NOT an original caller's action or policy); decodes as a Core PreflightRequest. */
function preflightRequest(networkId: string) {
  const content = { id: "external_policy_1", version: "1", requiredDimensions: ["execution" as const], desiredDimensions: [] };
  return {
    schemaVersion: "0.1", requestId: "external_preflight_1", networkId,
    action: networkId.startsWith("eip155:")
      ? { kind: "erc20.transfer", target: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", fields: { expectedAmount: "1000" } }
      : { kind: "spl_token.transfer_checked", target: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", fields: { expectedAmount: "5000" } },
    evidencePolicy: { ...content, digest: computeEvidencePolicyDigest(content) },
  };
}
const preflightArgs = (subject: { readonly networkId: string }, request: unknown = preflightRequest(subject.networkId)) =>
  ({ selectedNetworkId: subject.networkId, probeSubject: subject, request });
const discoverArgs = (id: string, subjects: readonly unknown[]) => ({ requestId: id, requirements: REQUIREMENTS, subjects });

interface Simulated {
  /** Every read answers this HTTP status with provider text and a URL. */
  httpStatus?: 503 | 429;
  /** Base Sepolia receipt and transaction answers replaced by null. */
  nullSepoliaReceipt?: boolean;
  /** devnet getTransaction answers HTTP 200 with this JSON-RPC error code. */
  devnetRpcError?: number;
  /** devnet getTransaction answers the real capture with only `version` set to 1. */
  devnetVersion1?: boolean;
  /** The real answer to this method is padded with JSON whitespace to exactly `bytes`. */
  pad?: { method: string; bytes: number };
  /** Every read is held: until its signal aborts, or (ignoring the signal) until release(). */
  hold?: "until-abort" | "ignore-abort";
}

/** Replays the real captures for the four fixed origins only; `sim` is read at call time. */
function provider(sim: Simulated = {}) {
  const reads: string[] = [];
  const held: (() => void)[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).href;
    const endpoint = ENDPOINTS[url];
    if (endpoint === undefined) throw Error("Unapproved fake endpoint");
    const req = JSON.parse(init?.body as string) as { id: number; method: string; params?: unknown[] };
    reads.push(req.method);
    const respond = (body: string, status: number, contentType: string) => {
      const response = new Response(body, { status, headers: { "content-type": contentType } });
      Object.defineProperty(response, "url", { value: url });
      return response;
    };
    if (sim.hold === "until-abort") {
      await new Promise<void>((_resolve, reject) => {
        const signal = init?.signal ?? undefined;
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        if (signal?.aborted) reject(new Error("aborted"));
      });
    }
    if (sim.hold === "ignore-abort") {
      await new Promise<void>((_resolve, reject) => { held.push(() => reject(new Error("released"))); });
    }
    if (sim.httpStatus !== undefined) return respond(`${PROVIDER_TEXT} upstream ${LEAK_URL}`, sim.httpStatus, "text/plain");
    const found = FIXTURES[endpoint].captures.find(c => c.rpcMethod === req.method);
    if (!found) throw Error("Unexpected mock method");
    if (endpoint !== "solana-mainnet" && JSON.stringify(req.params ?? []) !== JSON.stringify(found.rpcParams)) {
      throw Error("Unexpected mock params");
    }
    let resultText = found.resultJson;
    if (endpoint === "base-sepolia" && sim.nullSepoliaReceipt
      && (req.method === "eth_getTransactionReceipt" || req.method === "eth_getTransactionByHash")) resultText = "null";
    if (endpoint === "solana-devnet" && req.method === "getTransaction") {
      if (sim.devnetRpcError !== undefined) {
        const error = { code: sim.devnetRpcError, message: `${PROVIDER_TEXT}: transaction version is not supported by the requesting client` };
        return respond(`{"jsonrpc":"2.0","id":${JSON.stringify(req.id)},"error":${JSON.stringify(error)}}`, 200, "application/json");
      }
      if (sim.devnetVersion1) resultText = JSON.stringify({ ...JSON.parse(found.resultJson) as Record<string, unknown>, version: 1 });
    }
    let body = `{"jsonrpc":"2.0","id":${JSON.stringify(req.id)},"result":${resultText}}`;
    if (sim.pad !== undefined && sim.pad.method === req.method) {
      body = body.slice(0, -1) + " ".repeat(sim.pad.bytes - Buffer.byteLength(body)) + "}";
    }
    return respond(body, 200, "application/json");
  };
  return { fetchFn, reads, sim, release: () => { for (const answer of held.splice(0)) answer(); } };
}
type Provider = ReturnType<typeof provider>;
type Call = (name: string, args: Record<string, unknown>) => Promise<any>;

/** One hosted opt-in server + modern MCP client over a SIMULATED public Host. */
async function hosted(p: Provider, run: (call: Call, client: Client) => Promise<void>, deadlineMs?: number) {
  const server = await startNeMcpHttpServer({
    host: "127.0.0.1", port: 0, hosted: { publicOrigin: ORIGIN },
    liveEvidence: createMultichainTool(p.fetchFn, deadlineMs === undefined ? {} : { deadlineMs }),
  });
  try {
    const client = new Client({ name: "live-failure-modes-test", version: "1" }, { versionNegotiation: { mode: "auto" } });
    await client.connect(new StreamableHTTPClientTransport(new URL(ORIGIN + "/mcp"), { fetch: simulatedHostFetch(server.port, HOST) }));
    try {
      await run((name, args) => client.callTool({ name, arguments: args }), client);
    } finally { await client.close(); }
  } finally {
    p.release();
    await server.close();
  }
}

/** A failed call: exactly {error:{code,message,cause}}, no structured result, no verdict key, no source detail. */
function errorCodeOf(result: any): string {
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toBeUndefined();
  expect(result.content).toHaveLength(1);
  expect(result.content[0].type).toBe("text");
  const text = result.content[0].text as string;
  const parsed = JSON.parse(text) as { error: { code: unknown; message: unknown; cause: unknown } };
  expect(Object.keys(parsed)).toEqual(["error"]);
  expect(Object.keys(parsed.error).sort()).toEqual(["cause", "code", "message"]);
  expect(typeof parsed.error.code).toBe("string");
  expect(typeof parsed.error.message).toBe("string");
  expect(parsed.error.cause).toBeNull();
  const keys = collectKeys(parsed);
  for (const key of VERDICT_KEYS) {
    expect(keys.has(key)).toBe(false);
    expect(text).not.toContain(`"${key}"`);
  }
  for (const leak of [...RPC_HOSTNAMES, PROVIDER_TEXT, "internal-provider.example"]) expect(text).not.toContain(leak);
  return parsed.error.code as string;
}

/** A successful call: an observed envelope, summarised by its execution verdict. */
function envelopeOf(result: any): string {
  expect(result.isError).toBeFalsy();
  const value = result.structuredContent;
  expect(value).toBeDefined();
  for (const host of RPC_HOSTNAMES) expect(JSON.stringify(result)).not.toContain(host);
  return `envelope:${String(value.toolStatus)} execution=${String(value.fragment.networkEvidence.execution.verdict)}`;
}

interface Observed { tool: string; outcome: string; reads: string[]; parallel?: number }
const ROW_IDS = Array.from({ length: 18 }, (_, i) => `F${i + 1}`);
/** What every row observed, in call order; compared with the README block by the last test. */
const observed = new Map<string, Observed[]>();
function record(row: string, entry: Observed): void {
  observed.set(row, [...(observed.get(row) ?? []), entry]);
}

/** One recorded tools/call: exact outcome and exact ordered provider reads. */
async function step(row: string, p: Provider, call: Call, tool: string, args: Record<string, unknown>,
  outcome: string, reads: readonly string[]): Promise<any> {
  p.reads.length = 0;
  const result = await call(tool, args);
  const got = result.isError === true ? errorCodeOf(result) : envelopeOf(result);
  const gotReads = [...p.reads];
  record(row, { tool, outcome: got, reads: gotReads });
  expect(got).toBe(outcome);
  expect(gotReads).toEqual(reads);
  return result;
}

interface Contract {
  schema: string;
  test: string;
  liveSurface: { tools: string[]; openWorldHintTrueIdempotentHintFalse: string[] };
  codes: Record<string, { status: string; rows?: string[]; reason?: string; note?: string }>;
  rows: Record<string, { trigger: string; calls: Observed[] }>;
}
function readmeContract(): { text: string; contract: Contract } {
  const text = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const blocks = [...text.matchAll(/^```json ne-failure-modes\n([\s\S]*?)^```$/gm)];
  expect(blocks).toHaveLength(1);
  return { text, contract: JSON.parse(blocks[0]![1]!) as Contract };
}

/** Every quoted MCP_* literal in src/live-*.ts, each checked against the NeMcpErrorCode union. */
function sourceCodes(): Set<string> {
  const dir = new URL("../src/", import.meta.url);
  // P3: the composer's context errors are exposed by tools/call (tools.ts -> live-claim.ts -> live-result.ts).
  expect(readFileSync(new URL("tools.ts", dir), "utf8")).toContain('from "./live-claim.js"');
  expect(readFileSync(new URL("live-claim.ts", dir), "utf8")).toContain('from "./live-result.js"');
  const files = readdirSync(dir).filter(name => /^live-[a-z0-9-]+\.ts$/.test(name)).sort();
  expect(files).toEqual(expect.arrayContaining([
    "live-before.ts", "live-claim.ts", "live-evm.ts", "live-multichain.ts", "live-preflight.ts", "live-result.ts", "live-solana.ts",
  ]));
  const union = new Set([...readFileSync(new URL("errors.ts", dir), "utf8").matchAll(/\|\s*"(MCP_[A-Z0-9_]+)"/g)].map(m => m[1]!));
  const codes = new Set<string>();
  for (const file of files) {
    for (const m of readFileSync(new URL(file, dir), "utf8").matchAll(/"(MCP_[A-Z0-9_]+)"/g)) codes.add(m[1]!);
  }
  expect(codes.size).toBeGreaterThan(0);
  for (const code of codes) expect(union.has(code)).toBe(true);
  return codes;
}

const realFetch = globalThis.fetch;
let globalFetchCalls = 0;
beforeAll(() => {
  globalThis.fetch = (async () => {
    globalFetchCalls += 1;
    throw new Error("network I/O is forbidden in live-failure-modes tests");
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("live-tool failure modes at the hosted tools/call surface (README ne-failure-modes rows)", () => {
  it("F1 control: the real Base mainnet capture replays to an observed envelope", async () => {
    expect(BASE_SUBJECT.txId).toBe("0x8e01aace01ced4155b30d636b547727becdbb8a700f9b7f54ed02c4d629ae696");
    const p = provider();
    await hosted(p, async (call) => {
      const result = await step("F1", p, call, LIVE_MULTICHAIN_TOOL, { subject: BASE_SUBJECT },
        "envelope:observed execution=supported", BASE_READS);
      expect(result.structuredContent).toMatchObject({
        subject: BASE_SUBJECT, source: { networkId: "eip155:8453", sourceType: "evm_rpc" },
        acquisition: { transactionObserved: true, blockObserved: true, consistent: true },
      });
    });
  });

  it("F2: an uppercase subject hash is MCP_MULTICHAIN_INPUT with no provider read", async () => {
    const upper = "0x" + BASE_SUBJECT.txId.slice(2).toUpperCase();
    expect(upper).not.toBe(BASE_SUBJECT.txId);
    expect(upper.toLowerCase()).toBe(BASE_SUBJECT.txId);
    const p = provider();
    await hosted(p, async (call) => {
      await step("F2", p, call, LIVE_MULTICHAIN_TOOL, { subject: { ...BASE_SUBJECT, txId: upper } }, "MCP_MULTICHAIN_INPUT", []);
    });
  });

  it("F3: includeL2Finality on a Solana subject is MCP_MULTICHAIN_INPUT with no provider read", async () => {
    const p = provider();
    await hosted(p, async (call) => {
      await step("F3", p, call, LIVE_MULTICHAIN_TOOL, { subject: SOL_SUBJECT, includeL2Finality: true }, "MCP_MULTICHAIN_INPUT", []);
    });
  });

  it("F4: a SYNTHETIC claim bound to another transaction, and a cross-family claim, are MCP_CLAIM_INVALID before any read", async () => {
    const p = provider();
    await hosted(p, async (call) => {
      // SYNTHETIC claimant terms (as in live-claim.test.ts); its paymentTxHash is a synthetic, foreign hash.
      const foreign = { protocol: "x402-evm", claim: {
        requirement: { x402Version: "2", scheme: "exact", network: "eip155:8453",
          asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", payTo: "0x11f591c3496c0632e7b173184f5bc71dc941125d", amount: "1000" },
        paymentTxHash: "0x" + "1".repeat(64),
      } };
      await step("F4", p, call, LIVE_MULTICHAIN_TOOL, { subject: BASE_SUBJECT, claim: foreign }, "MCP_CLAIM_INVALID", []);
      await step("F4", p, call, LIVE_MULTICHAIN_TOOL, { subject: BASE_SUBJECT, claim: { protocol: "x402-svm", claim: {} } },
        "MCP_CLAIM_INVALID", []);
    });
  });

  it("F5: SIMULATED Base HTTP 503 and 429 are MCP_LIVE_EVM_RPC_FAILED, never a rate-limit code", async () => {
    const p = provider();
    await hosted(p, async (call) => {
      for (const status of [503, 429] as const) {
        p.sim.httpStatus = status;
        await step("F5", p, call, LIVE_MULTICHAIN_TOOL, { subject: BASE_SUBJECT }, "MCP_LIVE_EVM_RPC_FAILED", ["eth_chainId"]);
      }
    });
  });

  it("F6: SIMULATED Solana HTTP 503 and 429 are MCP_MULTICHAIN_SOURCE_FAILED, never a rate-limit code", async () => {
    const p = provider();
    await hosted(p, async (call) => {
      for (const status of [503, 429] as const) {
        p.sim.httpStatus = status;
        await step("F6", p, call, LIVE_MULTICHAIN_TOOL, { subject: SOL_SUBJECT }, "MCP_MULTICHAIN_SOURCE_FAILED", ["getGenesisHash"]);
      }
    });
  });

  it("F7: SIMULATED devnet getTransaction -32015 and version 1 (properties of the transaction) are MCP_MULTICHAIN_SOURCE_FAILED", async () => {
    const p = provider();
    await hosted(p, async (call) => {
      for (const sim of [{ devnetRpcError: -32015 }, { devnetVersion1: true }]) {
        delete p.sim.devnetRpcError;
        delete p.sim.devnetVersion1;
        Object.assign(p.sim, sim);
        const result = await step("F7", p, call, LIVE_MULTICHAIN_TOOL, { subject: DEVNET_SUBJECT },
          "MCP_MULTICHAIN_SOURCE_FAILED", ["getGenesisHash", "getTransaction"]);
        expect(result.content[0].text).not.toContain("-32015");
        expect(result.content[0].text).not.toMatch(/version/i);
      }
    });
  });

  it("F8: SIMULATED oversized reads: Base is MCP_LIVE_EVM_TOO_LARGE, Solana surfaces as MCP_MULTICHAIN_SOURCE_FAILED", async () => {
    const p = provider();
    await hosted(p, async (call) => {
      p.sim.pad = { method: "eth_getTransactionReceipt", bytes: LIVE_EVM_MAX_RPC_BYTES + 1 };
      await step("F8", p, call, LIVE_MULTICHAIN_TOOL, { subject: BASE_SUBJECT }, "MCP_LIVE_EVM_TOO_LARGE",
        ["eth_chainId", "eth_getTransactionReceipt"]);
      p.sim.pad = { method: "getGenesisHash", bytes: SOLANA_RESPONSE_MAX_BYTES + 1 };
      await step("F8", p, call, LIVE_MULTICHAIN_TOOL, { subject: SOL_SUBJECT }, "MCP_MULTICHAIN_SOURCE_FAILED", ["getGenesisHash"]);
    });
  });

  it("F9: the SIMULATED oversized Base receipt passes through Discovery and preflight as MCP_LIVE_EVM_TOO_LARGE", async () => {
    const p = provider({ pad: { method: "eth_getTransactionReceipt", bytes: LIVE_EVM_MAX_RPC_BYTES + 1 } });
    await hosted(p, async (call) => {
      await step("F9", p, call, LIVE_BEFORE_TOOL_NAME, discoverArgs("ne_l025_f9_1", [BASE_SUBJECT]), "MCP_LIVE_EVM_TOO_LARGE",
        ["eth_chainId", "eth_getTransactionReceipt"]);
      await step("F9", p, call, LIVE_PREFLIGHT_TOOL_NAME, preflightArgs(BASE_SUBJECT), "MCP_LIVE_EVM_TOO_LARGE",
        ["eth_chainId", "eth_getTransactionReceipt"]);
    });
  });

  it("F10: after eight admitted calls in one minute every live tool is MCP_MULTICHAIN_RATE_LIMIT with no provider read", async () => {
    const p = provider();
    await hosted(p, async (call) => {
      for (let n = 0; n < MULTICHAIN_CALLS_PER_MINUTE; n++) {
        p.reads.length = 0;
        expect(envelopeOf(await call(LIVE_MULTICHAIN_TOOL, { subject: BASE_SUBJECT }))).toBe("envelope:observed execution=supported");
        expect(p.reads).toEqual(BASE_READS);
      }
      await step("F10", p, call, LIVE_MULTICHAIN_TOOL, { subject: BASE_SUBJECT }, "MCP_MULTICHAIN_RATE_LIMIT", []);
      await step("F10", p, call, LIVE_BEFORE_TOOL_NAME, discoverArgs("ne_l025_f10_1", [BASE_SUBJECT]), "MCP_MULTICHAIN_RATE_LIMIT", []);
      await step("F10", p, call, LIVE_PREFLIGHT_TOOL_NAME, preflightArgs(BASE_SUBJECT), "MCP_MULTICHAIN_RATE_LIMIT", []);
    });
  });

  it("F11: SIMULATED null receipt on the real Base Sepolia subject is an observed envelope, execution insufficient, never contradicted", async () => {
    expect(SEPOLIA_SUBJECT.txId).toBe("0xde8916c81ef6a7b36ddf9f7b44d1ca096e4db4818eddfd5e16eda8a7c292ed45");
    const p = provider({ nullSepoliaReceipt: true });
    await hosted(p, async (call) => {
      const result = await step("F11", p, call, LIVE_MULTICHAIN_TOOL, { subject: SEPOLIA_SUBJECT },
        "envelope:observed execution=insufficient", NULL_RECEIPT_READS);
      const value = result.structuredContent;
      expect(value.subject).toEqual(SEPOLIA_SUBJECT);
      expect(value.acquisition).toMatchObject({ transactionObserved: false, transactionLookupUsable: false, blockObserved: false });
      for (const dimension of Object.values(value.fragment.networkEvidence) as any[]) expect(dimension.verdict).not.toBe("contradicted");
      expect(value.nonClaims.some((x: string) => x.includes("not proof that the transaction never existed"))).toBe(true);
    });
  });

  it("F12: a duplicate network and a family-mismatched subject are MCP_LIVE_BEFORE_INPUT with no provider read", async () => {
    const p = provider();
    await hosted(p, async (call) => {
      await step("F12", p, call, LIVE_BEFORE_TOOL_NAME, discoverArgs("ne_l025_f12_1", [BASE_SUBJECT, BASE_SUBJECT]), "MCP_LIVE_BEFORE_INPUT", []);
      await step("F12", p, call, LIVE_BEFORE_TOOL_NAME, discoverArgs("ne_l025_f12_2", [{ ...SOL_SUBJECT, txId: BASE_SUBJECT.txId }]),
        "MCP_LIVE_BEFORE_INPUT", []);
    });
  });

  it("F13: a request for another network and a forged policy digest are MCP_LIVE_PREFLIGHT_INPUT with no provider read", async () => {
    const p = provider();
    await hosted(p, async (call) => {
      await step("F13", p, call, LIVE_PREFLIGHT_TOOL_NAME, preflightArgs(BASE_SUBJECT, preflightRequest(SOL_SUBJECT.networkId)),
        "MCP_LIVE_PREFLIGHT_INPUT", []);
      const request = preflightRequest(BASE_SUBJECT.networkId);
      const forged = { ...request, evidencePolicy: { ...request.evidencePolicy, digest: "sha256:" + "0".repeat(64) } };
      await step("F13", p, call, LIVE_PREFLIGHT_TOOL_NAME, preflightArgs(BASE_SUBJECT, forged), "MCP_LIVE_PREFLIGHT_INPUT", []);
    });
  });

  it("F14: SIMULATED held reads under a test-only 1,000 ms deadline are MCP_LIVE_DEADLINE_EXCEEDED on all three live tools", { timeout: 20_000 }, async () => {
    const p = provider({ hold: "until-abort" });
    await hosted(p, async (call) => {
      await step("F14", p, call, LIVE_MULTICHAIN_TOOL, { subject: BASE_SUBJECT }, "MCP_LIVE_DEADLINE_EXCEEDED", ["eth_chainId"]);
      await step("F14", p, call, LIVE_BEFORE_TOOL_NAME, discoverArgs("ne_l025_f14_1", [BASE_SUBJECT]), "MCP_LIVE_DEADLINE_EXCEEDED", ["eth_chainId"]);
      await step("F14", p, call, LIVE_PREFLIGHT_TOOL_NAME, preflightArgs(BASE_SUBJECT), "MCP_LIVE_DEADLINE_EXCEEDED", ["eth_chainId"]);
    }, 1_000);
  });

  it("F15: preflight with the SIMULATED null-receipt real Base Sepolia probe is MCP_LIVE_PREFLIGHT_UNAVAILABLE, never blocked", async () => {
    expect(SEPOLIA_SUBJECT.txId).toBe("0xde8916c81ef6a7b36ddf9f7b44d1ca096e4db4818eddfd5e16eda8a7c292ed45");
    const p = provider({ nullSepoliaReceipt: true });
    await hosted(p, async (call) => {
      await step("F15", p, call, LIVE_PREFLIGHT_TOOL_NAME, preflightArgs(SEPOLIA_SUBJECT), "MCP_LIVE_PREFLIGHT_UNAVAILABLE", NULL_RECEIPT_READS);
    });
  });

  it("F16: a SIMULATED signal-ignoring provider (H-1) keeps both inner EVM slots after the deadline; later calls are MCP_LIVE_EVM_RATE_LIMIT", { timeout: 20_000 }, async () => {
    const p = provider({ hold: "ignore-abort" });
    await hosted(p, async (call) => {
      p.reads.length = 0;
      const both = await Promise.all([
        call(LIVE_MULTICHAIN_TOOL, { subject: BASE_SUBJECT }), call(LIVE_MULTICHAIN_TOOL, { subject: BASE_SUBJECT }),
      ]);
      const codes = both.map(errorCodeOf);
      record("F16", { tool: LIVE_MULTICHAIN_TOOL, outcome: codes[0]!, reads: [...p.reads], parallel: 2 });
      expect(codes).toEqual(["MCP_LIVE_DEADLINE_EXCEEDED", "MCP_LIVE_DEADLINE_EXCEEDED"]);
      expect(p.reads).toEqual(["eth_chainId", "eth_chainId"]);
      await step("F16", p, call, LIVE_MULTICHAIN_TOOL, { subject: BASE_SUBJECT }, "MCP_LIVE_EVM_RATE_LIMIT", []);
      await step("F16", p, call, LIVE_BEFORE_TOOL_NAME, discoverArgs("ne_l025_f16_1", [BASE_SUBJECT]), "MCP_LIVE_EVM_RATE_LIMIT", []);
      await step("F16", p, call, LIVE_PREFLIGHT_TOOL_NAME, preflightArgs(BASE_SUBJECT), "MCP_LIVE_EVM_RATE_LIMIT", []);
    }, 1_000);
  });

  it("F17: SIMULATED HTTP 503 maps to *_UNAVAILABLE in Discovery (Base) and preflight (Solana)", async () => {
    const p = provider({ httpStatus: 503 });
    await hosted(p, async (call) => {
      await step("F17", p, call, LIVE_BEFORE_TOOL_NAME, discoverArgs("ne_l025_f17_1", [BASE_SUBJECT]), "MCP_LIVE_BEFORE_UNAVAILABLE", ["eth_chainId"]);
      await step("F17", p, call, LIVE_PREFLIGHT_TOOL_NAME, preflightArgs(SOL_SUBJECT), "MCP_LIVE_PREFLIGHT_UNAVAILABLE", ["getGenesisHash"]);
    });
  });

  it("F18: test-authored evidenceContext values are MCP_EVIDENCE_CONTEXT_* codes with no provider read", async () => {
    const CALLER_TEXT = "CALLER_TEXT_NE_P3_NEVER_ECHOED";
    const { requestId: _preflightRequestId, ...preflighted } = preflightRequest(BASE_SUBJECT.networkId);
    // efda0ca-shaped: an AFTER-only EvidenceRequest with neither request.preflight nor a PreflightResult.
    const afterOnly = JSON.parse(encodeNecWireJson("evidence-request", {
      ...preflighted, requestId: "external_request_1", subject: BASE_SUBJECT,
    })) as Record<string, unknown>;
    expect(afterOnly).not.toHaveProperty("preflight");
    const p = provider();
    await hosted(p, async (call) => {
      const results = [
        await step("F18", p, call, LIVE_MULTICHAIN_TOOL, { subject: BASE_SUBJECT, evidenceContext: { request: afterOnly } },
          "MCP_EVIDENCE_CONTEXT_NO_PREFLIGHT", []),
        await step("F18", p, call, LIVE_MULTICHAIN_TOOL,
          { subject: BASE_SUBJECT, evidenceContext: { request: afterOnly, manifest: { id: CALLER_TEXT } } },
          "MCP_EVIDENCE_CONTEXT_CALLER_MANIFEST", []),
        await step("F18", p, call, LIVE_MULTICHAIN_TOOL, { subject: BASE_SUBJECT, evidenceContext: { request: { note: CALLER_TEXT } } },
          "MCP_EVIDENCE_CONTEXT_INVALID", []),
        await step("F18", p, call, LIVE_MULTICHAIN_TOOL, {
          subject: BASE_SUBJECT,
          evidenceContext: { request: { ...afterOnly, metadata: { note: CALLER_TEXT, padding: "x".repeat(EVIDENCE_CONTEXT_MAX_BYTES) } } },
        }, "MCP_EVIDENCE_CONTEXT_TOO_LARGE", []),
      ];
      for (const result of results) expect(result.content[0].text).not.toContain(CALLER_TEXT);
    });
  });
});

describe("README ne-failure-modes contract", () => {
  it("six-tool live surface: exactly the three live tools are openWorldHint:true and idempotentHint:false (served tools/list)", async () => {
    const { text, contract } = readmeContract();
    expect(text).not.toContain("All three tools");
    await hosted(provider(), async (_call, client) => {
      const { tools } = await client.listTools();
      const names = tools.map(t => t.name).sort();
      expect(names).toEqual([...LIVE_TOOL_NAMES].sort());
      expect(names).toEqual([...contract.liveSurface.tools].sort());
      const open = tools.filter(t => t.annotations?.openWorldHint === true).map(t => t.name).sort();
      expect(open).toEqual([LIVE_MULTICHAIN_TOOL, LIVE_BEFORE_TOOL_NAME, LIVE_PREFLIGHT_TOOL_NAME].sort());
      expect(open).toEqual([...contract.liveSurface.openWorldHintTrueIdempotentHintFalse].sort());
      for (const tool of tools) {
        const live = open.includes(tool.name);
        expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: live, idempotentHint: !live });
      }
    });
  });

  it("the code set equals the src/live-*.ts literals; every row and code status matches what the rows observed; no global fetch", () => {
    const { contract } = readmeContract();
    expect(contract.schema).toBe("ne-mcp-live-failure-modes/v0.1");
    expect(contract.test).toBe("packages/mcp/test/live-failure-modes.test.ts");
    const codes = sourceCodes();
    expect(Object.keys(contract.codes).sort()).toEqual([...codes].sort());

    expect(Object.keys(contract.rows)).toEqual(ROW_IDS);
    expect([...observed.keys()].sort()).toEqual([...ROW_IDS].sort());
    for (const row of ROW_IDS) {
      expect(contract.rows[row]!.trigger.length).toBeGreaterThan(0);
      expect(contract.rows[row]!.calls).toEqual(observed.get(row));
    }

    const errorOutcomes = new Set([...observed.values()].flat().map(x => x.outcome).filter(x => !x.startsWith("envelope:")));
    for (const outcome of errorOutcomes) expect(codes.has(outcome)).toBe(true);
    for (const [code, entry] of Object.entries(contract.codes)) {
      const seenIn = ROW_IDS.filter(row => observed.get(row)!.some(x => x.outcome === code));
      if (entry.status === "reproduced-at-tool-surface") {
        expect(entry.rows).toEqual(seenIn);
        expect(seenIn.length).toBeGreaterThan(0);
      } else {
        expect(entry.status).toBe("not-reproduced");
        expect(entry.rows).toBeUndefined();
        expect(typeof entry.reason === "string" && entry.reason.length > 0).toBe(true);
        expect(seenIn).toEqual([]);
      }
    }
    expect(contract.codes.MCP_LIVE_EVM_INPUT?.reason).toContain("live-multichain.ts:151-165");
    expect(contract.codes.MCP_LIVE_EVM_CONFIG?.reason).toContain("live-evm.ts:277-331");
    expect(contract.codes.MCP_LIVE_EVM_CONFIG?.reason).toContain("NOT startup-only");
    expect(globalFetchCalls).toBe(0);
  });
});
