/**
 * Paced MCP capture client for a LATER hosted reproduction campaign. Nothing
 * here implies a GO to run it against any public endpoint.
 *
 *   tsx examples/hosted-reproduction/capture-hosted.ts --url https://<host>/mcp --out capture.json \
 *     [--pacing-seconds 75] [--era modern|legacy] [--acquiring-sha <deployed executable sha>]
 *
 * It speaks MCP to ONE caller-named endpoint with the official SDK client:
 * tools/list in BOTH protocol eras (legacy initialize + modern), then a FIXED
 * call list in one era. It writes the raw tools/list results and the raw
 * structuredContent of every call to --out (never overwriting). It has no RPC
 * egress of its own: only the hosted server reads Base/Solana RPC.
 *
 * --url is REQUIRED (no default); only https:// or loopback http:// is
 * accepted, without credentials. Non-loopback targets are paced at least
 * MIN_PACING_SECONDS between tool calls (hosted live budget is 8 calls/min).
 *
 * Every call result is classified offline (`classifyCallOutcome`) and must be
 * in the frozen EXPECTED_OUTCOMES set for its call id.
 */
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { computeEvidencePolicyDigest, deepFreeze } from "@nec/core";
import type { PolicyDimension } from "@nec/core";

export const CAPTURE_SCHEMA = "ne-hosted-capture/v0.1";
export const CAPTURE_CLIENT = Object.freeze({ name: "ne-hosted-capture", version: "0.3.0" });
export const MIN_PACING_SECONDS = 75;
const LOOPBACK_HOSTNAMES: readonly string[] = ["127.0.0.1", "localhost", "[::1]"];

/** Pinned subjects, the same ones as the checked-in mainnet capture fixtures. */
export const PINNED_BASE_MAINNET_TX = "0x71c9e27a7195bdecf1c63e73d5f959c96ddb35a27f6f1308835494c3156d625c";
export const PINNED_SOLANA_MAINNET_SIGNATURE =
  "4DYWUMExSrMNxYLjUuH9G8feN4fmYXm4ToCx7gGaAEjJRf2QNrE8LsvoFSGhXwQJrchhgrnGpUFwjxrci9PRLF71";
/** Pinned testnet subjects: adapter-erc4337 base-sepolia-external-v06-userop.json and resolver-solana solana-devnet-before-probe.json. */
export const PINNED_BASE_SEPOLIA_TX = "0xde8916c81ef6a7b36ddf9f7b44d1ca096e4db4818eddfd5e16eda8a7c292ed45";
export const PINNED_SOLANA_DEVNET_SIGNATURE =
  "4D3WXyMK9HdpXuXwM5H9ZrQ5i6ofVhygVKZMcYK9VjKkvDkhzhtoBtsMGRBsQF9R49RfkrDsdWwX2AdkmqbwkFpJ";
/** SYNTHETIC-SUBJECT: a well-formed hash made up by this client, not a known transaction. */
export const SYNTHETIC_BASE_MAINNET_TX = `0x${"5e1ec7ed".repeat(8)}`;
/** SYNTHETIC-SUBJECT: the Base Sepolia probe of discover-three-candidates; made up, not a known transaction. */
export const SYNTHETIC_BASE_SEPOLIA_TX = `0x${"5e9011a5".repeat(8)}`;
/** The pinned Base tx's own `to` (pinned by test to the fixture), the probe request's action target. */
export const PROBE_ACTION_TARGET = "0x4200000000000000000000000000000000000015";
export const PROBE_REQUEST_LABEL = "capture-client-authored probe, no action executed, not the NEW-exact-action item";

const BASE_MAINNET = "eip155:8453";
const BASE_SEPOLIA = "eip155:84532";
const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOLANA_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const subject = (networkId: string, txId: string) => ({ type: "transaction", networkId, txId });
const BASE_SUBJECT = subject(BASE_MAINNET, PINNED_BASE_MAINNET_TX);
const SOLANA_SUBJECT = subject(SOLANA_MAINNET, PINNED_SOLANA_MAINNET_SIGNATURE);
const BASE_SEPOLIA_SUBJECT = subject(BASE_SEPOLIA, PINNED_BASE_SEPOLIA_TX);
const SOLANA_DEVNET_SUBJECT = subject(SOLANA_DEVNET, PINNED_SOLANA_DEVNET_SIGNATURE);
const REQUIREMENTS = { requirements: [
  { capability: "execution", strength: "required" },
  { capability: "finality", strength: "desired" },
] };
const PROBE_POLICY = { id: "capture_probe_policy", version: "1", requiredDimensions: ["execution", "finality"] as PolicyDimension[] };
/**
 * Authored by this capture client, fixed before any call: a readiness probe
 * only. No action is executed, and it is NOT the NEW-exact-action item.
 */
const PROBE_REQUEST = {
  schemaVersion: "0.1", requestId: "ne_hosted_capture_probe_1", networkId: BASE_MAINNET,
  action: { kind: "evm.contract_call", target: PROBE_ACTION_TARGET },
  evidencePolicy: { ...PROBE_POLICY, digest: computeEvidencePolicyDigest(PROBE_POLICY) },
  metadata: { probeLabel: PROBE_REQUEST_LABEL },
};

export interface CaptureCall {
  readonly id: string;
  readonly tool: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  /** Recorded with the call result; the target kind decides which one. */
  readonly label?: { readonly live: string; readonly loopback: string };
}

const RESOLVE = "resolve_transaction_evidence";
const DISCOVER = "discover_live_network_evidence";
const PREFLIGHT = "preflight_live_network_evidence";

/** The FIXED call list. Not configurable from the command line. */
export const CAPTURE_CALLS: readonly CaptureCall[] = deepFreeze([
  { id: "profiles", tool: "list_network_profiles", arguments: {} },
  // §4 Real multichain AFTER (mainnet).
  { id: "base-mainnet-pinned", tool: RESOLVE, arguments: { subject: BASE_SUBJECT } },
  { id: "base-mainnet-pinned-l2-finality", tool: RESOLVE, arguments: { subject: BASE_SUBJECT, includeL2Finality: true } },
  { id: "solana-mainnet-pinned", tool: RESOLVE, arguments: { subject: SOLANA_SUBJECT } },
  // §4 Testnet parity.
  { id: "base-sepolia-pinned", tool: RESOLVE, arguments: { subject: BASE_SEPOLIA_SUBJECT } },
  { id: "solana-devnet-pinned", tool: RESOLVE, arguments: { subject: SOLANA_DEVNET_SUBJECT } },
  // §4 BEFORE/Discovery, then a separate preflight on an explicit caller choice.
  {
    id: "discover-mainnet", tool: DISCOVER,
    arguments: { requestId: "ne_hosted_capture_discovery_mainnet_1", requirements: REQUIREMENTS, subjects: [BASE_SUBJECT, SOLANA_SUBJECT] },
  },
  {
    id: "discover-testnet", tool: DISCOVER,
    arguments: {
      requestId: "ne_hosted_capture_discovery_testnet_1", requirements: REQUIREMENTS,
      subjects: [BASE_SEPOLIA_SUBJECT, SOLANA_DEVNET_SUBJECT],
    },
  },
  // §4 three-class Discovery (NE-L028): one call, one Core result; the Base Sepolia path is a made-up subject.
  {
    id: "discover-three-candidates", tool: DISCOVER,
    arguments: {
      requestId: "ne_hosted_capture_discovery_three_1", requirements: REQUIREMENTS,
      subjects: [BASE_SUBJECT, SOLANA_SUBJECT, subject(BASE_SEPOLIA, SYNTHETIC_BASE_SEPOLIA_TX)],
    },
    label: {
      live: "SYNTHETIC-SUBJECT: Base Sepolia probe is a made-up well-formed hash; " +
        "not-found is not proof of nonexistence or of network unavailability",
      loopback: "SIMULATED: Base Sepolia probe is a made-up well-formed hash answered by a loopback server; not a network observation",
    },
  },
  {
    id: "preflight-base-mainnet-probe", tool: PREFLIGHT,
    arguments: { selectedNetworkId: BASE_MAINNET, probeSubject: BASE_SUBJECT, request: PROBE_REQUEST },
    label: { live: PROBE_REQUEST_LABEL, loopback: PROBE_REQUEST_LABEL },
  },
  // Negatives: input refusals before any RPC.
  { id: "refuse-unsupported-network", tool: RESOLVE, arguments: { subject: subject("eip155:57057", PINNED_BASE_MAINNET_TX) } },
  {
    id: "refuse-malformed-solana-signature", tool: RESOLVE,
    // "0" is outside the base58 alphabet.
    arguments: { subject: subject(SOLANA_MAINNET, `0${PINNED_SOLANA_MAINNET_SIGNATURE.slice(1)}`) },
  },
  { id: "refuse-l2-finality-on-solana", tool: RESOLVE, arguments: { subject: SOLANA_SUBJECT, includeL2Finality: true } },
  // Negative: a made-up subject.
  {
    id: "synthetic-base-mainnet-subject", tool: RESOLVE, arguments: { subject: subject(BASE_MAINNET, SYNTHETIC_BASE_MAINNET_TX) },
    label: {
      live: "SYNTHETIC-SUBJECT: made-up well-formed hash; a not-found answer is not proof of nonexistence",
      loopback: "SIMULATED: made-up well-formed hash answered by a loopback server; not a network observation",
    },
  },
]);

/**
 * Closed outcome vocabulary of one call result:
 * - observed: a tool envelope (resolve: transaction observed, no dimension contradicted);
 * - observed_insufficient: resolve envelope whose transaction the source did not return
 *   (absent, pruned or made up); insufficient, never proof of nonexistence;
 * - observed_contradicted: resolve envelope with a contradicted dimension;
 * - source_failure: a typed source/probe failure code;
 * - input_refusal: a typed input refusal (server code, or the SDK input-schema refusal);
 * - unclassified: anything else (rate limit, deadline, size, internal, unknown shape).
 */
export type CallOutcomeKind =
  | "observed" | "observed_insufficient" | "observed_contradicted"
  | "source_failure" | "input_refusal" | "unclassified";

export interface CallOutcome {
  readonly kind: CallOutcomeKind;
  /** The server's error code, SDK_SCHEMA_REFUSAL_CODE, or null. */
  readonly code: string | null;
}

const MAINNET_OBSERVATION: readonly CallOutcomeKind[] = ["observed", "source_failure"];
const TESTNET_OBSERVATION: readonly CallOutcomeKind[] = ["observed", "observed_insufficient", "source_failure"];
const REFUSED: readonly CallOutcomeKind[] = ["input_refusal"];

/** Frozen allowed outcome set per call id. "observed_contradicted" and "unclassified" are allowed nowhere. */
export const EXPECTED_OUTCOMES: Readonly<Record<string, readonly CallOutcomeKind[]>> = deepFreeze<Record<string, CallOutcomeKind[]>>({
  "profiles": ["observed"],
  "base-mainnet-pinned": [...MAINNET_OBSERVATION],
  "base-mainnet-pinned-l2-finality": [...MAINNET_OBSERVATION],
  "solana-mainnet-pinned": [...MAINNET_OBSERVATION],
  "base-sepolia-pinned": [...TESTNET_OBSERVATION],
  "solana-devnet-pinned": [...TESTNET_OBSERVATION],
  "discover-mainnet": [...MAINNET_OBSERVATION],
  "discover-testnet": [...MAINNET_OBSERVATION],
  "discover-three-candidates": [...MAINNET_OBSERVATION],
  "preflight-base-mainnet-probe": [...MAINNET_OBSERVATION],
  "refuse-unsupported-network": [...REFUSED],
  "refuse-malformed-solana-signature": [...REFUSED],
  "refuse-l2-finality-on-solana": [...REFUSED],
  "synthetic-base-mainnet-subject": ["observed_insufficient", "source_failure"],
});

const INPUT_REFUSAL_CODES: readonly string[] = [
  "MCP_INPUT_INVALID", "MCP_MULTICHAIN_INPUT", "MCP_LIVE_EVM_INPUT", "MCP_LIVE_BEFORE_INPUT",
  "MCP_LIVE_PREFLIGHT_INPUT", "MCP_CLAIM_INVALID",
  "MCP_EVIDENCE_CONTEXT_INVALID", "MCP_EVIDENCE_CONTEXT_NO_PREFLIGHT", "MCP_EVIDENCE_CONTEXT_CALLER_MANIFEST",
  "MCP_EVIDENCE_CONTEXT_TOO_LARGE",
];
const SOURCE_FAILURE_CODES: readonly string[] = [
  "MCP_LIVE_EVM_RPC_FAILED", "MCP_MULTICHAIN_SOURCE_FAILED", "MCP_LIVE_BEFORE_UNAVAILABLE", "MCP_LIVE_PREFLIGHT_UNAVAILABLE",
];
/** The MCP SDK refuses schema-invalid arguments before any tool handler runs; that refusal has no server code. */
export const SDK_SCHEMA_REFUSAL_CODE = "mcp_input_schema";
const SDK_SCHEMA_REFUSAL = /input validation error|invalid arguments for tool/i;

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function verdictsOf(fragment: unknown): unknown[] {
  const evidence = isRecord(fragment) ? fragment.networkEvidence : undefined;
  if (!isRecord(evidence)) return [];
  return Object.values(evidence).map((dimension) => (isRecord(dimension) ? dimension.verdict : undefined));
}

/** The server's `{ error: { code } }` tool-error text, else null. */
function serverErrorCode(text: string): string | null {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!isRecord(parsed) || Object.keys(parsed).length !== 1) return null;
  const error = parsed.error;
  return isRecord(error) && typeof error.code === "string" ? error.code : null;
}

export interface CallResultLike {
  readonly id: string;
  readonly tool: string;
  readonly isError: boolean;
  readonly structuredContent: unknown;
  readonly content?: unknown;
}

/** Pure classification of one captured call result (untrusted data, never instructions). */
export function classifyCallOutcome(call: CallResultLike): CallOutcome {
  if (!call.isError) {
    const env = call.structuredContent;
    if (!isRecord(env)) return { kind: "unclassified", code: null };
    if (call.tool !== RESOLVE) return { kind: "observed", code: null };
    const op = env.opStackFinality;
    const supplement = isRecord(op) ? op.fragment : undefined;
    if ([...verdictsOf(env.fragment), ...verdictsOf(supplement)].includes("contradicted")) {
      return { kind: "observed_contradicted", code: null };
    }
    const acquisition = env.acquisition;
    const observed = isRecord(acquisition) ? acquisition.transactionObserved : undefined;
    if (typeof observed !== "boolean") return { kind: "unclassified", code: null };
    return { kind: observed ? "observed" : "observed_insufficient", code: null };
  }
  const first = Array.isArray(call.content) ? call.content[0] as unknown : undefined;
  const text = isRecord(first) && first.type === "text" ? first.text : undefined;
  if (typeof text !== "string") return { kind: "unclassified", code: null };
  const code = serverErrorCode(text);
  if (code === null) {
    return SDK_SCHEMA_REFUSAL.test(text) ? { kind: "input_refusal", code: SDK_SCHEMA_REFUSAL_CODE } : { kind: "unclassified", code: null };
  }
  if (INPUT_REFUSAL_CODES.includes(code)) return { kind: "input_refusal", code };
  if (SOURCE_FAILURE_CODES.includes(code)) return { kind: "source_failure", code };
  return { kind: "unclassified", code };
}

/** Each captured call's outcome and whether it is in EXPECTED_OUTCOMES for its id. */
export function assessCaptureOutcomes(calls: readonly CallResultLike[]): {
  readonly id: string; readonly outcome: CallOutcome; readonly expected: boolean;
}[] {
  return calls.map((call) => {
    const outcome = classifyCallOutcome(call);
    const allowed = Object.hasOwn(EXPECTED_OUTCOMES, call.id) ? EXPECTED_OUTCOMES[call.id] : undefined;
    return { id: call.id, outcome, expected: allowed?.includes(outcome.kind) ?? false };
  });
}

export type CaptureEra = "legacy" | "modern";

export class CaptureConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptureConfigError";
  }
}

export interface CaptureTarget {
  readonly url: URL;
  readonly loopback: boolean;
}

export function assertCaptureTarget(raw: unknown): CaptureTarget {
  if (typeof raw !== "string" || raw.length === 0) throw new CaptureConfigError("--url is required (there is no default target)");
  let url: URL;
  try { url = new URL(raw); } catch { throw new CaptureConfigError("--url is not a valid URL"); }
  if (url.username !== "" || url.password !== "") throw new CaptureConfigError("--url must not carry credentials");
  if (url.search !== "" || url.hash !== "") throw new CaptureConfigError("--url must not carry a query or fragment");
  const loopback = LOOPBACK_HOSTNAMES.includes(url.hostname);
  if (url.protocol === "https:" || (url.protocol === "http:" && loopback)) return { url, loopback };
  throw new CaptureConfigError("--url must be https:// or loopback http:// (127.0.0.1, localhost, [::1])");
}

export function resolvePacingSeconds(target: CaptureTarget, requested?: number): number {
  if (requested !== undefined && (!Number.isSafeInteger(requested) || requested < 0)) {
    throw new CaptureConfigError("--pacing-seconds must be a non-negative integer");
  }
  if (target.loopback) return requested ?? 0;
  const pacing = requested ?? MIN_PACING_SECONDS;
  if (pacing < MIN_PACING_SECONDS) {
    throw new CaptureConfigError(`non-loopback targets require --pacing-seconds >= ${MIN_PACING_SECONDS}`);
  }
  return pacing;
}

const EXECUTABLE_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64}|sha256:[0-9a-f]{64})$/;

function assertEra(value: unknown): CaptureEra {
  if (value !== "legacy" && value !== "modern") throw new CaptureConfigError("--era must be modern or legacy");
  return value;
}

function assertExecutableSha(value: string): string {
  if (!EXECUTABLE_SHA.test(value)) {
    throw new CaptureConfigError("--acquiring-sha must be a full lowercase git SHA or sha256:<hex> image digest");
  }
  return value;
}

export interface CaptureArgs {
  readonly url: string;
  readonly out: string;
  readonly pacingSeconds: number;
  readonly era: CaptureEra;
  readonly acquiringExecutableSha?: string;
}

const FLAGS: readonly string[] = ["--url", "--out", "--pacing-seconds", "--era", "--acquiring-sha"];

export function parseCaptureArgs(argv: readonly string[]): CaptureArgs {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i] as string;
    const value = argv[i + 1];
    if (!FLAGS.includes(flag)) throw new CaptureConfigError(`unknown argument ${JSON.stringify(flag)}`);
    if (value === undefined || value.startsWith("--")) throw new CaptureConfigError(`${flag} requires a value`);
    if (values.has(flag)) throw new CaptureConfigError(`${flag} given more than once`);
    values.set(flag, value);
  }
  const target = assertCaptureTarget(values.get("--url"));
  const out = values.get("--out");
  if (out === undefined || out.length === 0) throw new CaptureConfigError("--out is required");
  const pacingRaw = values.get("--pacing-seconds");
  if (pacingRaw !== undefined && !/^\d{1,6}$/.test(pacingRaw)) throw new CaptureConfigError("--pacing-seconds must be an integer");
  const sha = values.get("--acquiring-sha");
  return {
    url: target.url.href,
    out,
    pacingSeconds: resolvePacingSeconds(target, pacingRaw === undefined ? undefined : Number(pacingRaw)),
    era: assertEra(values.get("--era") ?? "modern"),
    ...(sha === undefined ? {} : { acquiringExecutableSha: assertExecutableSha(sha) }),
  };
}

export interface CaptureOptions {
  readonly url: string;
  readonly pacingSeconds?: number;
  readonly era?: CaptureEra;
  readonly acquiringExecutableSha?: string;
  /** Transport fetch for the MCP endpoint only (tests: loopback). Default: global fetch. */
  readonly fetch?: typeof fetch;
  /** Injected for tests; default is a real timer. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface HostedCapture {
  readonly schema: typeof CAPTURE_SCHEMA;
  readonly target: string;
  readonly loopback: boolean;
  readonly pacingSeconds: number;
  readonly callEra: CaptureEra;
  /** Operator-declared, NOT verified by this client; compare with the reproducing commit. */
  readonly acquiringExecutable: { readonly sha: string; readonly declaredBy: "operator"; readonly verifiedByThisClient: false } | null;
  readonly client: typeof CAPTURE_CLIENT;
  readonly toolsList: readonly {
    readonly era: CaptureEra;
    readonly protocolVersion: string | null;
    readonly serverVersion: unknown;
    readonly tools: readonly unknown[];
  }[];
  readonly calls: readonly {
    readonly id: string;
    readonly tool: string;
    readonly arguments: Readonly<Record<string, unknown>>;
    readonly isError: boolean;
    readonly structuredContent: unknown;
    readonly content?: unknown;
    readonly label?: string;
  }[];
  readonly nonClaims: readonly string[];
}

export async function captureHostedEnvelopes(options: CaptureOptions): Promise<HostedCapture> {
  const target = assertCaptureTarget(options.url);
  const pacingSeconds = resolvePacingSeconds(target, options.pacingSeconds);
  const callEra = assertEra(options.era ?? "modern");
  const sha = options.acquiringExecutableSha === undefined ? undefined : assertExecutableSha(options.acquiringExecutableSha);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const transportOptions = options.fetch === undefined ? {} : { fetch: options.fetch };

  async function withClient<T>(era: CaptureEra, fn: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({ ...CAPTURE_CLIENT }, { versionNegotiation: { mode: era === "legacy" ? "legacy" : "auto" } });
    await client.connect(new StreamableHTTPClientTransport(new URL(target.url.href), transportOptions));
    try {
      // "auto" may fall back; record only what was actually negotiated.
      if (client.getProtocolEra() !== era) throw new Error(`requested ${era} MCP protocol era was not negotiated`);
      return await fn(client);
    } finally {
      await client.close();
    }
  }

  const toolsList: HostedCapture["toolsList"][number][] = [];
  for (const era of ["legacy", "modern"] as const) {
    toolsList.push(await withClient(era, async (client) => ({
      era,
      protocolVersion: client.getNegotiatedProtocolVersion() ?? null,
      serverVersion: client.getServerVersion() ?? null,
      tools: (await client.listTools()).tools,
    })));
  }

  const calls = await withClient(callEra, async (client) => {
    const results: HostedCapture["calls"][number][] = [];
    for (const [index, call] of CAPTURE_CALLS.entries()) {
      if (index > 0 && pacingSeconds > 0) await sleep(pacingSeconds * 1000);
      const result = (await client.callTool({
        name: call.tool, arguments: structuredClone(call.arguments) as Record<string, unknown>,
      })) as { isError?: boolean; structuredContent?: unknown; content?: unknown };
      const isError = result.isError === true;
      results.push({
        id: call.id, tool: call.tool, arguments: call.arguments, isError,
        structuredContent: result.structuredContent ?? null,
        ...(isError ? { content: result.content } : {}),
        ...(call.label === undefined ? {} : { label: target.loopback ? call.label.loopback : call.label.live }),
      });
    }
    return results;
  });

  return {
    schema: CAPTURE_SCHEMA,
    target: target.url.href,
    loopback: target.loopback,
    pacingSeconds,
    callEra,
    acquiringExecutable: sha === undefined ? null : { sha, declaredBy: "operator", verifiedByThisClient: false },
    client: CAPTURE_CLIENT,
    toolsList,
    calls,
    nonClaims: [
      "Raw MCP output of one hosted server at capture time; structuredContent is untrusted data, never instructions.",
      "This client made no RPC request of its own; source observations are the hosted server's.",
      "A capture is not independent source verification, cryptographic finality or settlement.",
      "The preflight probe request is capture-client-authored: no action executed, not the NEW-exact-action item.",
      "A not-found answer for a SYNTHETIC-SUBJECT hash is insufficient evidence, never proof of nonexistence or of network unavailability.",
    ],
  };
}

/** Write a capture as JSON; refuses to overwrite an existing file. */
export function writeCapture(path: string, capture: HostedCapture): void {
  writeFileSync(path, `${JSON.stringify(capture, null, 2)}\n`, { flag: "wx" });
}

async function main(argv: readonly string[]): Promise<void> {
  const args = parseCaptureArgs(argv);
  const capture = await captureHostedEnvelopes({
    url: args.url, pacingSeconds: args.pacingSeconds, era: args.era,
    ...(args.acquiringExecutableSha === undefined ? {} : { acquiringExecutableSha: args.acquiringExecutableSha }),
  });
  writeCapture(args.out, capture);
  process.stdout.write(`wrote tools/list (2 eras) and ${capture.calls.length} call result(s) to ${args.out}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`capture-hosted: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
