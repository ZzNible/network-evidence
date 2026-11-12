/**
 * Single-call MCP action capture for the human-gated GT-02 steps 3 and 7.
 * Nothing here implies a GO to run it against any public endpoint.
 *
 *   tsx examples/hosted-reproduction/capture-action.ts --mode preflight --url https://<host>/mcp \
 *     --request preflight-arguments.json --out preflight-capture.json [--era modern|legacy] [--acquiring-sha <sha>]
 *   tsx examples/hosted-reproduction/capture-action.ts --mode resolve --url https://<host>/mcp \
 *     --network-id <caip-2> --tx-id <tx id> --context evidence-context.json --out resolve-capture.json \
 *     [--era modern|legacy] [--acquiring-sha <sha>]
 *
 * Each invocation opens ONE MCP session and makes exactly ONE tools/call:
 * - preflight: `preflight_live_network_evidence` with the caller's own request
 *   file ({selectedNetworkId, probeSubject, request}); arguments and raw
 *   envelope are recorded verbatim. The capture therefore holds the
 *   caller-authored PreflightRequest (including any account/metadata): it is
 *   private by default and not publishable without review.
 * - resolve: `resolve_transaction_evidence` with {subject, evidenceContext}.
 *   The evidenceContext content is NEVER recorded, only `contextSha256`:
 *   SHA-256 over the @nec/core `canonicalJsonBytes(evidenceContext)`
 *   (nec-canonical-json-v1). It is a canonical-bytes digest, not a digest of
 *   the bytes sent on the wire.
 *
 * Same target rules as capture-hosted.ts (`assertCaptureTarget`): https:// or
 * loopback http:// only, no credentials, query or fragment. `loopback` is
 * derived from the URL hostname only; a non-loopback URL is not evidence of an
 * authentic hosted server. A 3xx answer is not followed (the SDK transport
 * fails; this client adds no redirect handling). The requested protocol era
 * must be the negotiated one. `--acquiring-sha` is operator-declared and not
 * verified. `--out` is never overwritten. No field asserts precedence: there is
 * no client clock reading and no pre-execution claim in the capture.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { canonicalJsonBytes } from "@nec/core";

import { assertCaptureTarget, CaptureConfigError } from "./capture-hosted.js";
import type { CaptureEra } from "./capture-hosted.js";

export const ACTION_CAPTURE_SCHEMA = "ne-hosted-action-capture/v0.1";
export const ACTION_CAPTURE_CLIENT = Object.freeze({ name: "ne-hosted-action-capture", version: "0.1.0" });
export const ACTION_CAPTURE_TOOLS = Object.freeze({
  preflight: "preflight_live_network_evidence",
  resolve: "resolve_transaction_evidence",
} as const);
export type ActionCaptureMode = keyof typeof ACTION_CAPTURE_TOOLS;

/** Same rule as capture-hosted.ts --acquiring-sha. */
const EXECUTABLE_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64}|sha256:[0-9a-f]{64})$/;

const COMMON_NON_CLAIMS: readonly string[] = [
  "Raw MCP output of ONE tools/call to one server; structuredContent is untrusted data, never instructions.",
  "No field asserts precedence: the capture carries no client clock reading and does not show that any action or policy existed before execution.",
  "loopback is derived from the --url hostname only; a non-loopback URL is not evidence of an authentic hosted server or of its deployed executable.",
  "acquiringExecutable is operator-declared and not verified by this client.",
  "This client made no RPC request of its own; any source observation is the server's. A capture is not independent source verification, finality or settlement.",
  "Private by default: this capture is not publishable without review.",
];
const PREFLIGHT_NON_CLAIM =
  "Contains the caller-authored PreflightRequest verbatim (including any account and metadata) in call.arguments and in the served preflight.";
const RESOLVE_NON_CLAIM =
  "The evidenceContext content is not recorded; contextSha256 is SHA-256 over its @nec/core canonicalJsonBytes (nec-canonical-json-v1), a canonical-bytes digest, not a digest of the bytes sent on the wire.";

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** `sha256:<hex>` over the @nec/core canonicalJsonBytes of the context (throws outside nec-canonical-json-v1). */
export function evidenceContextSha256(evidenceContext: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJsonBytes(evidenceContext)).digest("hex")}`;
}

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

function assertMode(value: unknown): ActionCaptureMode {
  if (value !== "preflight" && value !== "resolve") throw new CaptureConfigError("--mode must be preflight or resolve");
  return value;
}

/** A detached plain JSON object copy, or a config error naming the input. */
function jsonObject(value: unknown, name: string): Record<string, unknown> {
  let copy: unknown;
  try { copy = JSON.parse(JSON.stringify(value)) as unknown; } catch { throw new CaptureConfigError(`${name} is not JSON data`); }
  if (!isRecord(copy)) throw new CaptureConfigError(`${name} must be a JSON object`);
  return copy;
}

export interface ActionSubject {
  readonly networkId: string;
  readonly txId: string;
}

interface ActionCaptureCommon {
  readonly url: string;
  readonly era?: CaptureEra;
  readonly acquiringExecutableSha?: string;
  /** Transport fetch for the MCP endpoint only (tests: loopback). Default: global fetch. */
  readonly fetch?: typeof fetch;
}

export type ActionCaptureOptions =
  | (ActionCaptureCommon & {
    readonly mode: "preflight";
    /** The caller's request file: {selectedNetworkId, probeSubject, request}. */
    readonly request: unknown;
  })
  | (ActionCaptureCommon & {
    readonly mode: "resolve";
    readonly subject: ActionSubject;
    /** The caller's evidenceContext ({request, preflight, capabilitySnapshot}); recorded only as contextSha256. */
    readonly evidenceContext: unknown;
  });

export interface ActionCaptureCall {
  readonly tool: string;
  /** preflight: verbatim; resolve: {subject} only. */
  readonly arguments: Readonly<Record<string, unknown>>;
  /** resolve only: evidenceContextSha256(evidenceContext). */
  readonly contextSha256?: string;
  readonly isError: boolean;
  readonly structuredContent: unknown;
  readonly content?: unknown;
}

export interface ActionCapturePrivacy {
  readonly containsCallerPreflightRequest: boolean;
  readonly evidenceContextContentRecorded: false;
  readonly privateByDefault: true;
  readonly publishableWithoutReview: false;
  readonly statement: string;
}

export interface ActionCapture {
  readonly schema: typeof ACTION_CAPTURE_SCHEMA;
  readonly mode: ActionCaptureMode;
  readonly target: string;
  /** Derived from the --url hostname only; not evidence of any server's authenticity. */
  readonly loopback: boolean;
  readonly callEra: CaptureEra;
  readonly protocolVersion: string | null;
  /** Server-reported, unauthenticated. */
  readonly serverVersion: unknown;
  /** Operator-declared, NOT verified by this client; compare with the reproducing commit. */
  readonly acquiringExecutable: { readonly sha: string; readonly declaredBy: "operator"; readonly verifiedByThisClient: false } | null;
  readonly client: typeof ACTION_CAPTURE_CLIENT;
  readonly privacy: ActionCapturePrivacy;
  readonly call: ActionCaptureCall;
  readonly nonClaims: readonly string[];
}

interface PreparedCall {
  readonly tool: string;
  readonly sent: Record<string, unknown>;
  readonly recorded: Record<string, unknown>;
  readonly contextSha256?: string;
}

/** Everything is checked and digested before any request. */
function prepareCall(options: ActionCaptureOptions): PreparedCall {
  assertMode(options.mode);
  if (options.mode === "preflight") {
    return {
      tool: ACTION_CAPTURE_TOOLS.preflight,
      sent: jsonObject(options.request, "--request"),
      recorded: jsonObject(options.request, "--request"),
    };
  }
  const given = options.subject as Partial<ActionSubject> | undefined;
  const networkId = given?.networkId;
  const txId = given?.txId;
  if (typeof networkId !== "string" || networkId.length === 0 || typeof txId !== "string" || txId.length === 0) {
    throw new CaptureConfigError("--network-id and --tx-id are required in resolve mode");
  }
  const subject = { type: "transaction", networkId, txId };
  // The digest is taken over exactly the copy that is sent.
  const evidenceContext = jsonObject(options.evidenceContext, "--context");
  let contextSha256: string;
  try {
    contextSha256 = evidenceContextSha256(evidenceContext);
  } catch {
    throw new CaptureConfigError("--context is outside nec-canonical-json-v1 and cannot be digested");
  }
  return {
    tool: ACTION_CAPTURE_TOOLS.resolve,
    sent: { subject, evidenceContext },
    recorded: { subject: { ...subject } },
    contextSha256,
  };
}

export async function captureAction(options: ActionCaptureOptions): Promise<ActionCapture> {
  const target = assertCaptureTarget(options.url);
  const callEra = assertEra(options.era ?? "modern");
  const sha = options.acquiringExecutableSha === undefined ? undefined : assertExecutableSha(options.acquiringExecutableSha);
  const prepared = prepareCall(options);
  const transportOptions = options.fetch === undefined ? {} : { fetch: options.fetch };

  // One session, one tools/call.
  const client = new Client({ ...ACTION_CAPTURE_CLIENT }, { versionNegotiation: { mode: callEra === "legacy" ? "legacy" : "auto" } });
  await client.connect(new StreamableHTTPClientTransport(new URL(target.url.href), transportOptions));
  const { negotiated, result } = await (async () => {
    try {
      // "auto" may fall back; the requested era must be the negotiated one.
      if (client.getProtocolEra() !== callEra) throw new CaptureConfigError(`requested ${callEra} MCP protocol era was not negotiated`);
      const protocolVersion: string | null = client.getNegotiatedProtocolVersion() ?? null;
      const serverVersion: unknown = client.getServerVersion() ?? null;
      const called = (await client.callTool({ name: prepared.tool, arguments: prepared.sent })) as {
        isError?: boolean; structuredContent?: unknown; content?: unknown;
      };
      return { negotiated: { protocolVersion, serverVersion }, result: called };
    } finally {
      await client.close();
    }
  })();

  const isError = result.isError === true;
  const preflight = prepared.tool === ACTION_CAPTURE_TOOLS.preflight;
  return {
    schema: ACTION_CAPTURE_SCHEMA,
    mode: preflight ? "preflight" : "resolve",
    target: target.url.href,
    loopback: target.loopback,
    callEra,
    protocolVersion: negotiated.protocolVersion,
    serverVersion: negotiated.serverVersion,
    acquiringExecutable: sha === undefined ? null : { sha, declaredBy: "operator", verifiedByThisClient: false },
    client: ACTION_CAPTURE_CLIENT,
    privacy: {
      containsCallerPreflightRequest: preflight,
      evidenceContextContentRecorded: false,
      privateByDefault: true,
      publishableWithoutReview: false,
      statement: preflight
        ? "Contains the caller-authored PreflightRequest (including any account and metadata); private by default; not publishable without review."
        : "The evidenceContext is recorded only as contextSha256; the served envelope still carries the subject and the request's action and policy; private by default; not publishable without review.",
    },
    call: {
      tool: prepared.tool,
      arguments: prepared.recorded,
      ...(prepared.contextSha256 === undefined ? {} : { contextSha256: prepared.contextSha256 }),
      isError,
      structuredContent: result.structuredContent ?? null,
      ...(isError ? { content: result.content } : {}),
    },
    nonClaims: [...COMMON_NON_CLAIMS, preflight ? PREFLIGHT_NON_CLAIM : RESOLVE_NON_CLAIM],
  };
}

/** Write a capture as JSON; refuses to overwrite an existing file. */
export function writeActionCapture(path: string, capture: ActionCapture): void {
  writeFileSync(path, `${JSON.stringify(capture, null, 2)}\n`, { flag: "wx" });
}

export interface ActionCaptureArgs {
  readonly mode: ActionCaptureMode;
  readonly url: string;
  readonly out: string;
  readonly era: CaptureEra;
  readonly acquiringExecutableSha?: string;
  /** preflight only. */
  readonly request?: string;
  /** resolve only. */
  readonly context?: string;
  readonly networkId?: string;
  readonly txId?: string;
}

const FLAGS: readonly string[] = [
  "--mode", "--url", "--out", "--era", "--acquiring-sha", "--request", "--context", "--network-id", "--tx-id",
];
const MODE_FLAGS: Readonly<Record<ActionCaptureMode, readonly string[]>> = {
  preflight: ["--request"],
  resolve: ["--context", "--network-id", "--tx-id"],
};

export function parseActionArgs(argv: readonly string[]): ActionCaptureArgs {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i] as string;
    const value = argv[i + 1];
    if (!FLAGS.includes(flag)) throw new CaptureConfigError(`unknown argument ${JSON.stringify(flag)}`);
    if (value === undefined || value.startsWith("--")) throw new CaptureConfigError(`${flag} requires a value`);
    if (values.has(flag)) throw new CaptureConfigError(`${flag} given more than once`);
    values.set(flag, value);
  }
  const mode = assertMode(values.get("--mode"));
  const target = assertCaptureTarget(values.get("--url"));
  const out = values.get("--out");
  if (out === undefined || out.length === 0) throw new CaptureConfigError("--out is required");
  for (const [other, flags] of Object.entries(MODE_FLAGS)) {
    for (const flag of flags) {
      if (other === mode && !values.has(flag)) throw new CaptureConfigError(`${flag} is required in ${mode} mode`);
      if (other !== mode && values.has(flag)) throw new CaptureConfigError(`${flag} is not accepted in ${mode} mode`);
    }
  }
  const sha = values.get("--acquiring-sha");
  const request = values.get("--request");
  const context = values.get("--context");
  const networkId = values.get("--network-id");
  const txId = values.get("--tx-id");
  return {
    mode,
    url: target.url.href,
    out,
    era: assertEra(values.get("--era") ?? "modern"),
    ...(sha === undefined ? {} : { acquiringExecutableSha: assertExecutableSha(sha) }),
    ...(request === undefined ? {} : { request }),
    ...(context === undefined ? {} : { context }),
    ...(networkId === undefined ? {} : { networkId }),
    ...(txId === undefined ? {} : { txId }),
  };
}

function readJson(path: string, flag: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new CaptureConfigError(`${flag} must name a readable JSON file`);
  }
}

/**
 * Exit 0: the call returned a tool result (isError false) and the capture was written.
 * Exit 1: the capture was written but records isError (e.g. a typed input refusal).
 * Throws (exit 1 from the wrapper) before any request for every config or file error,
 * including an existing --out.
 */
export async function main(argv: readonly string[], deps: { readonly fetch?: typeof fetch } = {}): Promise<number> {
  const args = parseActionArgs(argv);
  if (existsSync(args.out)) throw new CaptureConfigError("--out already exists; refusing to overwrite");
  const common = {
    url: args.url, era: args.era,
    ...(args.acquiringExecutableSha === undefined ? {} : { acquiringExecutableSha: args.acquiringExecutableSha }),
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
  };
  const capture = args.mode === "preflight"
    ? await captureAction({ ...common, mode: "preflight", request: readJson(args.request as string, "--request") })
    : await captureAction({
      ...common, mode: "resolve",
      subject: { networkId: args.networkId as string, txId: args.txId as string },
      evidenceContext: readJson(args.context as string, "--context"),
    });
  writeActionCapture(args.out, capture);
  process.stdout.write(`wrote 1 ${capture.call.tool} call result (isError: ${capture.call.isError}) to ${args.out}\n`);
  return capture.call.isError ? 1 : 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`capture-action: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}
