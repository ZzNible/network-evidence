# @nec/mcp — local, read-only Network Evidence MCP server (v0)

> **Current (2026-10-11):** the **original three-tool OFFLINE** public service remains at `https://network-evidence-mcp-jrkc26rjga-ew.a.run.app/mcp` and MCP Registry `io.github.ZzNible/network-evidence` v0.0.2. Its tools never fetch live RPC. The separately approved **six-tool Base + Solana public read-only beta** is LIVE at `https://network-evidence-mcp-beta-jrkc26rjga-ew.a.run.app/mcp`, Cloud Run revision `network-evidence-mcp-beta-00004-pwq` (100% public traffic; same executable image/source as the prior revision, ingress limit updated only), exactly four active profile declarations. This beta performs bounded source observations of exact actions via pinned public RPC endpoints. It is **not** a fully verified Core NetworkEvidenceResult or independent cryptographic settlement/finality certification. Use the [public agent quickstart](../../docs/distribution/MCP_BASE_SOLANA_PUBLIC_BETA_QUICKSTART.md); source release v1.1.0 and old Registry listing do not automatically publish the beta to ChatGPT or Claude directories.

> **Three hosted-only beta tools:** `resolve_transaction_evidence` (AFTER, optional original caller-supplied claim/OP Stack L2 block-finality), `discover_live_network_evidence` (BEFORE/Core Discovery from exact sources), and `preflight_live_network_evidence` (caller-selected native Core evidence preflight requiring **complete original input/policy**). There is no automatic network choice/ranking, wallet, signing, submission, settlement inference, Core schema replacement or manufactured full Core Result from fragments. Caller-supplied protocol terms are not independently authenticated. Public beta Cloud Run limits are **max one instance, concurrent request one, 24 HTTP `/mcp` admissions per 60 seconds per process (separate unchanged eight live-RPC acquisitions/minute/process)**, shared among all anonymous clients. These constraints are NOT the local default values shown below. Earlier IAM-private live canary remains IAM-private; the old original offline service remains separate for rollback.

> Full [beta deployment, exact source, tests and rollback](../../docs/distribution/CLOUD_RUN_FREE_PREVIEW_RUNBOOK.md) and [distribution launch checklist](../../docs/distribution/MCP_LAUNCH_CHECKLIST.md).

A Model Context Protocol server over public Network Evidence code. In its **default local and official Registry v0.0.2 OFFLINE mode**, it exposes
three read-only tools and performs **no network I/O**. In the separate,
hosted-only public beta mode it exposes **three more read-only source-fetching
tools** for Base/Solana. Neither mode is a wallet, signer, funding/gas or
transaction submission service; neither scores, ranks or chooses networks.

- **BEFORE** asks: what can an exact network/deployment support, and what is
  currently observable/usable *with evidence*?
- **AFTER** asks: what can the network itself independently support about one
  exact action?

In default offline mode the server observes nothing and never answers
"now". Hosted public beta sources can observe exact transactions in real time,
but do not infer worldwide availability, consensus or settlement from one RPC.
Current support is distinct from current availability. Manifest membership is
not live availability. Archived replay keeps current availability `unknown`.

## Run it

Requirements: Node.js ≥ 20.12, a checkout of this repository.

```sh
npm ci
npm run mcp:serve                       # http://127.0.0.1:4178/mcp, health at /healthz
npm run mcp:serve -- --port 4300        # or NE_MCP_PORT=4300
npm run -s mcp:smoke                    # SDK-client protocol smoke (in-process server, ephemeral port)
npm run -s mcp:smoke -- --url http://127.0.0.1:4178/mcp   # smoke against the running server
```

Point an MCP client that supports Streamable HTTP at `http://127.0.0.1:4178/mcp`.
The CLI replaces global `fetch` with a throwing guard.

| setting | default | notes |
| --- | --- | --- |
| host (`--host`, `NE_MCP_HOST`) | `127.0.0.1` | only `127.0.0.1`, `::1`, `localhost` accepted; anything else fails at startup |
| port (`--port`, `NE_MCP_PORT`) | `4178` | `0` = ephemeral |
| request body | 1 MiB | `startNeMcpHttpServer({ maxBodyBytes })`, 1 KiB..4 MiB |
| `/mcp` concurrency (`NE_MCP_MAX_CONCURRENT`) | 16 | global, 1..64; excess → `429`, `Retry-After: 1` |
| `/mcp` rate (`NE_MCP_RATE_LIMIT_PER_MINUTE`) | 600 / 60 s | global fixed window, 1..6000; excess → `429` + `Retry-After` |

Local mode ignores the platform variable `PORT`. Setting `NE_MCP_PUBLIC_ORIGIN`
or `NE_MCP_CUSTOM_ORIGIN` without `NE_MCP_MODE=hosted` is refused at startup.

## Hosted preview mode (opt-in; public Cloud Run preview)

For a **separately approved** deployment behind a platform that terminates
HTTPS and forwards plain HTTP (e.g. a Render Web Service). It is an
**anonymous, read-only preview**, not a reviewed production service: no
authentication, no per-client quota, global limits only. Runbook:
[`docs/distribution/RENDER_DEPLOY_RUNBOOK.md`](../../docs/distribution/RENDER_DEPLOY_RUNBOOK.md).

| variable | required | rule |
| --- | --- | --- |
| `NE_MCP_MODE` | yes | exactly `hosted` (anything other than unset/`local`/`hosted` is refused) |
| `NE_MCP_PUBLIC_ORIGIN` | yes | exact canonical origin `https://<public hostname>`: lowercase, no path, port, trailing slash, query, credentials or wildcard; not an IP, not localhost-class or special-use (`.local`, `.internal`, `.test`, …) |
| `NE_MCP_CUSTOM_ORIGIN` | no | a second exact origin for an explicitly configured custom domain; same rules; must differ |
| `PORT` | yes | set by the platform; decimal 1..65535 |
| `NE_MCP_MAX_CONCURRENT` | no | default 8 in hosted mode (1..64) |
| `NE_MCP_RATE_LIMIT_PER_MINUTE` | no | default 240 in hosted mode (1..6000) |

```sh
NE_MCP_MODE=hosted NE_MCP_PUBLIC_ORIGIN=https://<exact-public-hostname> PORT=<n> npm run mcp:serve
```

Behaviour:

- binds `0.0.0.0:$PORT` (the only non-loopback bind in the package);
  `--host`, `--port`, `NE_MCP_HOST`, `NE_MCP_PORT` are refused in hosted mode;
- `Host` must be exactly a configured hostname (case-insensitive, **no port**).
  Loopback names, IPs, `:443`, sub/superdomains and anything else → `403`;
- no `Origin` (server-to-server MCP clients) passes; any present `Origin` must
  equal a configured `https://` origin byte-for-byte. `http://`, other ports,
  `localhost`, `null`, wildcards → `403`;
- `X-Forwarded-*`, `Forwarded`, `X-Real-IP` are **never read**; the client
  address is never read either;
- 403 bodies are static and never echo the rejected header;
- `/healthz` reports `"mode": "hosted"` and
  `"scope": "hosted preview v0: anonymous, read-only, offline; not a reviewed production service"`;
- all other guards, limits, tools, outputs and digests are identical to local mode.

Refusals exit with status 1 before anything is bound, e.g.
`Network Evidence MCP v0: NE_MCP_PUBLIC_ORIGIN is required in hosted mode (exact https origin)`.

## Transport and protocol

- Streamable HTTP at `POST /mcp`, built with the official MCP TypeScript SDK v2
  (`@modelcontextprotocol/server` 2.4.0, `@modelcontextprotocol/node` 2.1.2,
  `createMcpHandler` + `toNodeHandler`).
- Both protocol eras are served by one per-request server factory:
  - **2025 era** (`2025-11-25` and earlier): `initialize` → `notifications/initialized`
    → `tools/list` → `tools/call`, served statelessly (no session id);
  - **modern** (`2026-07-28`): `server/discover` + per-request `_meta` envelope.
- any non-`POST /mcp` (`GET`, `DELETE`, …) → direct `405` with `Allow: POST`
  (stateless; no standalone SSE stream; never dispatched to the SDK and does
  not charge the rate window).
- `GET /healthz` → static JSON (`status`, tool names, `readOnly: true`,
  `liveObservation: false`, `networkIo: "none"`, `mode`, and a mode-specific
  `scope`: `"local v0; not a public endpoint"` locally).

Request guards, in order: `Host`/`Origin` validation (DNS-rebinding
protection; local: loopback `Host` names and, when an `Origin` is sent, only
the exact same-port loopback origin `http://{127.0.0.1|localhost|[::1]}:<port>`.
A browser page on another local port is refused. Hosted: see above) →
global `/mcp` abuse limiter **reservation**: window pre-check plus one
concurrency slot, taken before the method check and before any body byte is
read (`429` + `Retry-After` when the window is full or all slots are held;
the slot is released when the response closes) → `POST`-only method check
(`405`, `Allow: POST`) → `Content-Type: application/json` (`415`) → body read
bounded by bytes (`413`) and by an absolute **5 s deadline** (`408`,
`Connection: close`, request destroyed after the response is flushed) → UTF-8
decode (`400`, `-32700`) → the **@nec/core strict wire parser** over the raw
body (duplicate JSON keys, malformed JSON, depth/node/string bounds → `400`,
JSON-RPC `-32700`) → **window charge** (`429` + `Retry-After` if the window
filled while the body was read) → JSON-RPC batch refusal (`400`, `-32600`) →
`subscriptions/listen` refusal (`200`, `-32601`; invalid id → `400`) → SDK.
Each request gets a fresh `McpServer`.

The fixed 60 s window is therefore charged only after a strict parse succeeds:
`405`, `415`, `413`, `408` and the two parse `400`s do not consume it (a
non-`POST` `405` no longer consumes admission), while batch and
`subscriptions/listen` refusals, and every SDK-dispatched request, still do.
Residual caveat, stated plainly: refusals are free against the window, so one
slow or incomplete sender can hold a concurrency slot for up to 5 s per
attempt and reconnect repeatedly without ever receiving `429` itself. With a
small `NE_MCP_MAX_CONCURRENT` (the public beta uses 1) that can starve other
clients. Limits are process-local, global and anonymous; per-client fairness
is not provided and needs edge controls.

For **Google Cloud Run**, use `GET /health` (or HEAD) in hosted mode for health checks. Cloud Run reserves some URL paths ending in `z`, so `/healthz` can return a Google frontend 404 without reaching the application. Hosted `/health` returns the identical static payload and keeps the exact Host/Origin guards. `/healthz` stays available for Render and local mode; local mode deliberately does not serve `/health`.

Browser-based cross-origin clients are not supported in hosted preview mode (no CORS preflight headers). Server-to-server MCP clients with no `Origin` header are supported; any supplied `Origin` must exactly match an explicitly configured HTTPS origin.

Logging is one stderr line per request: method, route (`/mcp`, `/healthz` or
`(other)`), status and duration. Headers, bodies, tool arguments, client
addresses and identifiers are never logged. The abuse limiter keeps two global
counters only. It stores no IP, payload, credential or client identifier.


### Hosted ingress and live-source security (2026-10-09 draft candidate)

JSON-RPC ARRAY/BATCH messages are rejected with HTTP 400 and JSON-RPC -32600
before the SDK can dispatch any operation, including one-element, empty and
notifications-only arrays. The process-local HTTP admission limiter counts HTTP
requests, not arbitrary numbers of tool calls inside a single batch. Existing
single-call MCP clients (both protocol eras) still work. Core strict duplicate
key and JSON resource bounds remain in place before any SDK processing.

Live Solana provider reads now stream through ONE original response body only:
maximum 800,000 delivered bytes, fixed-origin and method allowlist, 8-second
source deadline plus caller abort, cancellation on rejected URL/status/length
or excess bytes. No Response.clone tee buffering or provider error body leak.
The SDK-only new Solana block signatures membership read is NOT admitted by
the hosted method allowlist; the original three-tool public MCP endpoint remains OFFLINE; the separate Base + Solana public beta serves six tools with live read-only observations.

**Public beta operational limit (not a blocker retroactively):** the approved
six-tool Base/Solana beta is already LIVE with one Cloud Run instance and a
process-local shared 24 HTTP `/mcp` admissions/minute quota (with a separate eight/minute live-RPC acquisition ceiling). The deployed beta
executable `f12f2ca` predates SEC-01 (`218489b`, not deployed): on that revision a non-POST GET answered with 405 was observed to also take one admission; at `218489b` a 405 does not consume it (guard order above). Additional instances or production-scale agent
traffic would require independently justified cross-instance admission and
provider/cost controls; do NOT widen quotas on the basis of beta success.
The official 3-tool Registry listing remains offline until a separate
full-result product/compliance release decision.

## Tools

The three offline tools below carry explicit annotations
`{ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }`
and strict input schemas (`additionalProperties: false`). In hosted live mode
the six-tool live surface keeps them unchanged and adds three tools
(`resolve_transaction_evidence`, `discover_live_network_evidence`,
`preflight_live_network_evidence`) with
`{ readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true }`:
they read fixed external RPC sources and charge a shared budget, so a repeated
call can return a different observation or code. Their failure modes are listed
in [Hosted live tools: failure modes](#hosted-live-tools-failure-modes). Errors come back as
`isError: true` tool results whose text is `{"error":{"code","message","cause"}}`.
`cause` holds the name/code/message of a preserved @nec/core or
@nec/discovery error. Stack traces and server paths are never returned.
Unexpected errors collapse to `MCP_INTERNAL_ERROR` with no detail.

### 1. `list_network_profiles`

Input: `{}`. Returns `ne-mcp-network-profiles/v0.1`: the fixed inventory built
from public resolver exports, in fixed order (no ranking):

| profileId | networkId | environment | accepted observation kinds |
| --- | --- | --- | --- |
| `base-mainnet` | `eip155:8453` | mainnet | probe, historical_replay |
| `base-sepolia` | `eip155:84532` | testnet | probe, historical_replay |
| `solana-mainnet` | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | mainnet | probe, historical_replay |
| `solana-devnet` | `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` | testnet | probe, historical_replay |
| `zksys-tanenbaum` | `eip155:57057` | testnet | **historical_replay only**; no zkSYS mainnet exists |

Each profile lists the resolver manifest (id/version/digest/package), every
Core capability with `declaredByResolverManifest`, and
`currentSupport: "not_assessed"` / `currentAvailability: "not_assessed"` /
`currentStatus: "not_assessed"`. It also includes `doesNotEstablish`, notes and
the global `truthBoundaries`.

### 2. `discover_network_candidates`

Runs the real `@nec/discovery` `discoverNetworks` over contexts **you supply**.
Classification is done by `@nec/core` only. This server never reimplements the
truth table. There are no default or demo candidates.

Input (`ne-mcp` → Core, all values in `nec-wire-json-v1` form):

```jsonc
{
  "requestId": "disc-1",                          // NEC identifier grammar
  "generatedAt": "2026-10-08T09:00:00.000Z",      // explicit; the server reads no clock
  "requirements": {                               // Core DiscoveryRequirements
    "requirements": [
      { "capability": "execution", "strength": "required" },
      { "capability": "finality",  "strength": "desired"  }
    ],
    "networkAllowlist": ["..."],                  // optional, Core semantics
    "networkDenylist":  ["..."]                   // optional, Core semantics
  },
  "candidates": [                                 // 1..16 explicit contexts
    {
      "id": "base-sepolia",                       // opaque presentation id, unique
      "environment": "testnet",                   // presentation label only
      "network":  { ... },                        // NetworkFingerprint == snapshot.network (canonically identical)
      "manifest": { ... },                        // COMPLETE ResolverManifest behind snapshot.resolver
      "snapshot": { ... }                         // COMPLETE CapabilitySnapshot; blockNumber values are decimal STRINGS
    }
  ],
  "scope": { "candidateIds": ["..."], "environments": ["testnet"] }   // optional
}
```

How to produce a candidate context: derive a BEFORE foundation with a public
resolver export (`deriveOpStackBeforeFoundation`, `deriveSolanaBeforeFoundation`,
`replaySolanaBeforeFoundation`, `deriveZksysBeforeFoundation`) from an
observation you acquired or an archived replay. Then encode it with Core:

```ts
import { encodeNecWireJson } from "@nec/core";
const snapshot = JSON.parse(encodeNecWireJson("capability-snapshot", foundation.snapshot));
const candidate = {
  id: "base-sepolia",
  environment: "testnet",
  network: snapshot.network,
  manifest: JSON.parse(encodeNecWireJson("resolver-manifest", foundation.manifest)),
  snapshot,
};
```

[`test/helpers.ts`](test/helpers.ts) does exactly this for the offline Discovery
demo contexts (synthetic demo probes plus one archived replay; **not live data**).

Processing: Core `decodeNecWireJson` for requirements, manifest and snapshot
(strict parse, bigint positions, full Core validation including self-digests)
→ canonical equality of `network` vs `snapshot.network` → MCP presentation
guard (an `environment` may not contradict the fixed profile inventory for a
listed network, e.g. `eip155:57057` labelled `mainnet` is rejected) →
`discoverNetworks` → Core `verifyDiscoverNetworksResult` again →
`encodeNecWireJson("discovery-result")`.

Output `ne-mcp-discovery/v0.1`:

- `coreResult`: THE Core `DiscoverNetworksResult` (wire form, verbatim);
- `coreVerification`: `resultArtifactDigest`, `reverifiedAtMcpBoundary: true`;
- `candidates[]`: `id`, `environment` (`environmentLabelSource: "caller"`),
  `networkId`, `resolver`, `classification` copied from Core, and
  `suppliedSnapshot` (`id`, `artifactDigest`, `generatedAt`, `networkObservedAt`,
  `declaredObservationKind` as recorded in the snapshot, `evidenceSourceIds`);
- `scope`, `verificationContextRefs` (snapshot and manifest digests);
- `qualification[]`, `networkChoice` ("none"), `liveObservation: false`.

The outcome depends **only** on the supplied snapshots. The caller chooses a
network externally and must then run the resolver-specific evidence preflight
(e.g. `deriveOpStackBeforePreflightResult`). This server does not call it.

Error codes: `MCP_INPUT_INVALID`, `MCP_WIRE_DECODE_FAILED`,
`MCP_CANDIDATE_NETWORK_MISMATCH`, `MCP_ENVIRONMENT_LABEL_CONFLICT`,
`MCP_RESULT_UNVERIFIED`, plus every `@nec/discovery` code
(`DISCOVERY_CANDIDATE_BINDING_INVALID`, `DISCOVERY_CANDIDATE_ID_DUPLICATE`,
`DISCOVERY_NETWORK_DUPLICATE`, `DISCOVERY_SCOPE_UNKNOWN_CANDIDATE`, …).
Schema violations (unknown keys, more than 16 candidates, empty candidates)
are rejected by the SDK input validation before the handler runs.

### 3. `get_reviewed_evidence_case`

Input: `{ "caseId": "f1" | "f2" | "f3" | "synthetic-local-core-golden" }` (exact
enum; no paths, prefixes or case folding).

Reads only the fixed file `examples/ne-maps/data/collection.json`. At startup
the bytes must match SHA-256
`e10250b3f4714883f54c96003f1cdb5f1c2ed36cb7bd18dcf3f94b194139fa49` (pinned here
and in `data/COLLECTION.sha256`). They are then strictly parsed by Core and
validated by the shipped Maps validator plus `@nec/lens`
`validateLensBrowserSafeCaseV01`. On any mismatch the server refuses to start.

Output `ne-mcp-reviewed-case/v0.1`: `evidenceClass` + `label`
(`historical-reviewed-public-network-fixture` for f1–f3 — **HISTORICAL**, past
observations at pinned commits; `synthetic-local-fixture` — **SYNTHETIC, not a
network observation**), `liveObservation: false`,
`currentAvailability: "unknown"`, `source` (path, sha256, pins, validators),
`caseProvenance`, `collectionNonClaims`, `serverNonClaims`, and the `envelope`
**verbatim**. All limitations, open questions, unavailable/unknown states and
extensions are preserved.

## Hosted live tools: failure modes

This contract covers the three hosted live tools. A failed live call is an
`isError: true` tool result with no `structuredContent`. Its only text is
exactly `{"error":{"code","message","cause"}}`, and `cause` is `null` for every
code below. A failed call never carries a partial observation, a `verdict`,
`classification` or `readiness` key, an RPC hostname or provider text. A
failure is not evidence about the subject or the network.

The block below is the machine-checked contract.
[`test/live-failure-modes.test.ts`](test/live-failure-modes.test.ts) checks
these points:

- its code set equals the `MCP_*` literals in `src/live-*.ts`;
- every row runs at the hosted `tools/call` surface with exactly the listed
  `outcome` and ordered provider `reads`;
- every `reproduced-at-tool-surface` code is observed in exactly its listed
  rows, and no `not-reproduced` code is observed;
- the `liveSurface` lists match the served `tools/list` annotations.

The rows replay real pinned captures offline. Every other answer is a mutation
labelled SIMULATED in the row trigger. Rows that use a 1,000 ms whole-call
deadline use a test-only value; production uses 35,000 ms. An `envelope:`
outcome is a successful observed result, summarised by its execution verdict.

```json ne-failure-modes
{
  "schema": "ne-mcp-live-failure-modes/v0.1",
  "test": "packages/mcp/test/live-failure-modes.test.ts",
  "liveSurface": {
    "tools": ["list_network_profiles", "discover_network_candidates", "get_reviewed_evidence_case", "resolve_transaction_evidence", "discover_live_network_evidence", "preflight_live_network_evidence"],
    "openWorldHintTrueIdempotentHintFalse": ["resolve_transaction_evidence", "discover_live_network_evidence", "preflight_live_network_evidence"]
  },
  "codes": {
    "MCP_MULTICHAIN_INPUT": { "status": "reproduced-at-tool-surface", "rows": ["F2", "F3"] },
    "MCP_CLAIM_INVALID": { "status": "reproduced-at-tool-surface", "rows": ["F4"] },
    "MCP_LIVE_EVM_RPC_FAILED": { "status": "reproduced-at-tool-surface", "rows": ["F5"] },
    "MCP_MULTICHAIN_SOURCE_FAILED": { "status": "reproduced-at-tool-surface", "rows": ["F6", "F7", "F8"] },
    "MCP_LIVE_EVM_TOO_LARGE": { "status": "reproduced-at-tool-surface", "rows": ["F8", "F9"] },
    "MCP_MULTICHAIN_RATE_LIMIT": { "status": "reproduced-at-tool-surface", "rows": ["F10"] },
    "MCP_LIVE_BEFORE_INPUT": { "status": "reproduced-at-tool-surface", "rows": ["F12"] },
    "MCP_LIVE_PREFLIGHT_INPUT": { "status": "reproduced-at-tool-surface", "rows": ["F13"] },
    "MCP_LIVE_DEADLINE_EXCEEDED": { "status": "reproduced-at-tool-surface", "rows": ["F14", "F16"] },
    "MCP_LIVE_PREFLIGHT_UNAVAILABLE": { "status": "reproduced-at-tool-surface", "rows": ["F15", "F17"] },
    "MCP_LIVE_EVM_RATE_LIMIT": { "status": "reproduced-at-tool-surface", "rows": ["F16"], "note": "only reached with the SIMULATED signal-ignoring provider of F16 (NE-L024 H-1); otherwise the outer multichain budget (same 8/min, 2 in flight) is checked first" },
    "MCP_LIVE_BEFORE_UNAVAILABLE": { "status": "reproduced-at-tool-surface", "rows": ["F17"] },
    "MCP_EVIDENCE_CONTEXT_NO_PREFLIGHT": { "status": "reproduced-at-tool-surface", "rows": ["F18"] },
    "MCP_EVIDENCE_CONTEXT_CALLER_MANIFEST": { "status": "reproduced-at-tool-surface", "rows": ["F18"] },
    "MCP_EVIDENCE_CONTEXT_INVALID": { "status": "reproduced-at-tool-surface", "rows": ["F18"] },
    "MCP_EVIDENCE_CONTEXT_TOO_LARGE": { "status": "reproduced-at-tool-surface", "rows": ["F18"] },
    "MCP_LIVE_EVM_INPUT": { "status": "not-reproduced", "reason": "shadowed by MCP_MULTICHAIN_INPUT: network, includeL2Finality and the lowercase hash are validated first (live-multichain.ts:151-165), so live-evm.ts:200-204 is never reached from a hosted tool" },
    "MCP_LIVE_EVM_CONFIG": { "status": "not-reproduced", "reason": "internal contract violation, NOT startup-only: besides the constructor check (live-evm.ts:195) it fires at call time in the OP Stack phase when the profile/source binding, the extra-read budget or the native evaluator/fragment invariants break (live-evm.ts:277-331); no pinned capture breaks them without a src change" },
    "MCP_LIVE_CALL_CANCELLED": { "status": "not-reproduced", "reason": "a hosted caller abort comes only from the client's HTTP disconnect, after which no reply reaches that client; reproduced below the tool surface only (live-abort-confirmation.test.ts, M-3)" },
    "MCP_MULTICHAIN_TOO_LARGE": { "status": "not-reproduced", "reason": "no row produces an envelope over 450,000 bytes (live-multichain.ts:278, live-claim.ts:181-185); an oversized Solana read surfaces as MCP_MULTICHAIN_SOURCE_FAILED (F8); function-level only (live-claim.test.ts:164-166; the assembled evidenceResult envelope in live-result-tool.test.ts)" },
    "MCP_CLAIM_ASSESSMENT_FAILED": { "status": "not-reproduced", "reason": "needs a native adapter that throws or cites evidence not bound to this source and capture; no such case found with the real resolver and pinned captures; function-level only (live-claim.test.ts:161-163)" },
    "MCP_LIVE_PREFLIGHT_CONTEXT_INVALID": { "status": "not-reproduced", "reason": "native composition or Core contextual verification failing after a usable probe (live-preflight.ts:135-164); no decodable caller request with a pinned capture reaches it" },
    "MCP_LIVE_PREFLIGHT_TOO_LARGE": { "status": "not-reproduced", "reason": "needs a native preflight plus context over 180,000 bytes (live-preflight.ts:191) from a request capped at 30,000 bytes (live-preflight.ts:92); no row reaches it" },
    "MCP_RESULT_UNVERIFIED": { "status": "not-reproduced", "reason": "fail-closed evidenceContext composer guard after a usable read (live-result.ts:138-141, 304-316, 374-383): the hosted observation, its pinned-manifest dimensions or its Core rebuild would have to disagree with the prepared context; no pinned capture does; function-level only (live-result.test.ts:465-476)" }
  },
  "rows": {
    "F1": { "trigger": "control: real Base mainnet capture 0x8e01…e696 replayed verbatim", "calls": [
      { "tool": "resolve_transaction_evidence", "outcome": "envelope:observed execution=supported", "reads": ["eth_chainId", "eth_getTransactionReceipt", "eth_getBlockByHash", "eth_getTransactionByHash"] }] },
    "F2": { "trigger": "the F1 hash with uppercase hex digits", "calls": [
      { "tool": "resolve_transaction_evidence", "outcome": "MCP_MULTICHAIN_INPUT", "reads": [] }] },
    "F3": { "trigger": "Solana mainnet subject with includeL2Finality:true (OP Stack L2 finality is Base-only)", "calls": [
      { "tool": "resolve_transaction_evidence", "outcome": "MCP_MULTICHAIN_INPUT", "reads": [] }] },
    "F4": { "trigger": "SYNTHETIC x402-evm claim whose paymentTxHash names another transaction; an x402-svm claim on a Base subject", "calls": [
      { "tool": "resolve_transaction_evidence", "outcome": "MCP_CLAIM_INVALID", "reads": [] },
      { "tool": "resolve_transaction_evidence", "outcome": "MCP_CLAIM_INVALID", "reads": [] }] },
    "F5": { "trigger": "SIMULATED HTTP 503, then 429, with provider text from the Base mainnet endpoint", "calls": [
      { "tool": "resolve_transaction_evidence", "outcome": "MCP_LIVE_EVM_RPC_FAILED", "reads": ["eth_chainId"] },
      { "tool": "resolve_transaction_evidence", "outcome": "MCP_LIVE_EVM_RPC_FAILED", "reads": ["eth_chainId"] }] },
    "F6": { "trigger": "SIMULATED HTTP 503, then 429, with provider text from the Solana mainnet endpoint", "calls": [
      { "tool": "resolve_transaction_evidence", "outcome": "MCP_MULTICHAIN_SOURCE_FAILED", "reads": ["getGenesisHash"] },
      { "tool": "resolve_transaction_evidence", "outcome": "MCP_MULTICHAIN_SOURCE_FAILED", "reads": ["getGenesisHash"] }] },
    "F7": { "trigger": "real Solana devnet capture 4D3WXyMK…kFpJ; SIMULATED getTransaction JSON-RPC error -32015, then the real answer with only version set to 1", "calls": [
      { "tool": "resolve_transaction_evidence", "outcome": "MCP_MULTICHAIN_SOURCE_FAILED", "reads": ["getGenesisHash", "getTransaction"] },
      { "tool": "resolve_transaction_evidence", "outcome": "MCP_MULTICHAIN_SOURCE_FAILED", "reads": ["getGenesisHash", "getTransaction"] }] },
    "F8": { "trigger": "SIMULATED whitespace padding: the real Base receipt answer to 128,001 bytes; the real Solana getGenesisHash answer to 800,001 bytes", "calls": [
      { "tool": "resolve_transaction_evidence", "outcome": "MCP_LIVE_EVM_TOO_LARGE", "reads": ["eth_chainId", "eth_getTransactionReceipt"] },
      { "tool": "resolve_transaction_evidence", "outcome": "MCP_MULTICHAIN_SOURCE_FAILED", "reads": ["getGenesisHash"] }] },
    "F9": { "trigger": "the F8 SIMULATED oversized Base receipt through Discovery and preflight", "calls": [
      { "tool": "discover_live_network_evidence", "outcome": "MCP_LIVE_EVM_TOO_LARGE", "reads": ["eth_chainId", "eth_getTransactionReceipt"] },
      { "tool": "preflight_live_network_evidence", "outcome": "MCP_LIVE_EVM_TOO_LARGE", "reads": ["eth_chainId", "eth_getTransactionReceipt"] }] },
    "F10": { "trigger": "eight admitted F1 calls in one minute (four reads each), then one call per live tool", "calls": [
      { "tool": "resolve_transaction_evidence", "outcome": "MCP_MULTICHAIN_RATE_LIMIT", "reads": [] },
      { "tool": "discover_live_network_evidence", "outcome": "MCP_MULTICHAIN_RATE_LIMIT", "reads": [] },
      { "tool": "preflight_live_network_evidence", "outcome": "MCP_MULTICHAIN_RATE_LIMIT", "reads": [] }] },
    "F11": { "trigger": "real Base Sepolia capture 0xde8916c8…ed45; SIMULATED null receipt and transaction answers", "calls": [
      { "tool": "resolve_transaction_evidence", "outcome": "envelope:observed execution=insufficient", "reads": ["eth_chainId", "eth_getTransactionReceipt", "eth_getTransactionByHash"] }] },
    "F12": { "trigger": "two subjects on the same network; a Solana subject carrying an EVM hash", "calls": [
      { "tool": "discover_live_network_evidence", "outcome": "MCP_LIVE_BEFORE_INPUT", "reads": [] },
      { "tool": "discover_live_network_evidence", "outcome": "MCP_LIVE_BEFORE_INPUT", "reads": [] }] },
    "F13": { "trigger": "request.networkId differs from selectedNetworkId; a forged evidencePolicy digest", "calls": [
      { "tool": "preflight_live_network_evidence", "outcome": "MCP_LIVE_PREFLIGHT_INPUT", "reads": [] },
      { "tool": "preflight_live_network_evidence", "outcome": "MCP_LIVE_PREFLIGHT_INPUT", "reads": [] }] },
    "F14": { "trigger": "test-only 1,000 ms whole-call deadline; SIMULATED provider holds every read until its signal aborts", "calls": [
      { "tool": "resolve_transaction_evidence", "outcome": "MCP_LIVE_DEADLINE_EXCEEDED", "reads": ["eth_chainId"] },
      { "tool": "discover_live_network_evidence", "outcome": "MCP_LIVE_DEADLINE_EXCEEDED", "reads": ["eth_chainId"] },
      { "tool": "preflight_live_network_evidence", "outcome": "MCP_LIVE_DEADLINE_EXCEEDED", "reads": ["eth_chainId"] }] },
    "F15": { "trigger": "preflight with the F11 SIMULATED null-receipt real Base Sepolia probe 0xde8916c8…ed45", "calls": [
      { "tool": "preflight_live_network_evidence", "outcome": "MCP_LIVE_PREFLIGHT_UNAVAILABLE", "reads": ["eth_chainId", "eth_getTransactionReceipt", "eth_getTransactionByHash"] }] },
    "F16": { "trigger": "test-only 1,000 ms deadline; SIMULATED provider that ignores its abort signal and never answers (NE-L024 H-1); two parallel calls, then one call per live tool", "calls": [
      { "tool": "resolve_transaction_evidence", "outcome": "MCP_LIVE_DEADLINE_EXCEEDED", "reads": ["eth_chainId", "eth_chainId"], "parallel": 2 },
      { "tool": "resolve_transaction_evidence", "outcome": "MCP_LIVE_EVM_RATE_LIMIT", "reads": [] },
      { "tool": "discover_live_network_evidence", "outcome": "MCP_LIVE_EVM_RATE_LIMIT", "reads": [] },
      { "tool": "preflight_live_network_evidence", "outcome": "MCP_LIVE_EVM_RATE_LIMIT", "reads": [] }] },
    "F17": { "trigger": "SIMULATED HTTP 503: Discovery over Base mainnet, preflight on Solana mainnet", "calls": [
      { "tool": "discover_live_network_evidence", "outcome": "MCP_LIVE_BEFORE_UNAVAILABLE", "reads": ["eth_chainId"] },
      { "tool": "preflight_live_network_evidence", "outcome": "MCP_LIVE_PREFLIGHT_UNAVAILABLE", "reads": ["getGenesisHash"] }] },
    "F18": { "trigger": "test-authored evidenceContext on the F1 Base subject, each refused before any provider read: an AFTER-only request with no preflight (efda0ca-shaped), a caller manifest key, a request that is not a Core EvidenceRequest, a context over the 64 KiB cap", "calls": [
      { "tool": "resolve_transaction_evidence", "outcome": "MCP_EVIDENCE_CONTEXT_NO_PREFLIGHT", "reads": [] },
      { "tool": "resolve_transaction_evidence", "outcome": "MCP_EVIDENCE_CONTEXT_CALLER_MANIFEST", "reads": [] },
      { "tool": "resolve_transaction_evidence", "outcome": "MCP_EVIDENCE_CONTEXT_INVALID", "reads": [] },
      { "tool": "resolve_transaction_evidence", "outcome": "MCP_EVIDENCE_CONTEXT_TOO_LARGE", "reads": [] }] }
  }
}
```

The following per-family differences are observed behaviour, pinned by the rows
above. They are documented here, not reported as defects:

- **Provider HTTP 503/429:** Base yields `MCP_LIVE_EVM_RPC_FAILED` (F5) and
  Solana yields `MCP_MULTICHAIN_SOURCE_FAILED` (F6).
- **Provider 429 is not a server rate limit:** it never maps to
  `MCP_MULTICHAIN_RATE_LIMIT` or `MCP_LIVE_EVM_RATE_LIMIT`. Those two codes
  report only this server's process-local budgets (F10, F16). The per-minute
  count is never refunded.
- **Oversized provider answer:** Base yields `MCP_LIVE_EVM_TOO_LARGE` (F8,
  F9). On Solana the resolver wraps the guard's size error, so it surfaces as
  `MCP_MULTICHAIN_SOURCE_FAILED` (F8).
- **Solana JSON-RPC `-32015` or a version-1 transaction:** the result is
  `MCP_MULTICHAIN_SOURCE_FAILED` (F7). The cause is a property of the
  transaction, namely its version against the fixed
  `maxSupportedTransactionVersion: 0` request. It is not a source outage, and
  it says nothing about whether the transaction exists.
- **Discovery and preflight error mapping:** a failed probe maps to
  `MCP_LIVE_BEFORE_UNAVAILABLE` / `MCP_LIVE_PREFLIGHT_UNAVAILABLE` (F17). Six
  codes pass through unchanged: `MCP_MULTICHAIN_RATE_LIMIT`,
  `MCP_MULTICHAIN_TOO_LARGE`, `MCP_LIVE_EVM_RATE_LIMIT`,
  `MCP_LIVE_EVM_TOO_LARGE`, `MCP_LIVE_DEADLINE_EXCEEDED` and
  `MCP_LIVE_CALL_CANCELLED` (`live-before.ts:172-177`,
  `live-preflight.ts:68-76`; F9, F10, F14, F16).
- **Missing receipt:**
  - `resolve_transaction_evidence` returns an observed envelope with execution
    `insufficient`, never `contradicted` (F11).
  - Preflight reports `MCP_LIVE_PREFLIGHT_UNAVAILABLE`, never `blocked` (F15).
  - Discovery returns a Core-built result in which the candidate is
    `ineligible` (`live-testnet-parity.test.ts`).
  - In all three cases the missing receipt is not proof that the transaction
    never existed.
- **Subject hash case:** an EVM subject hash must be lowercase (F2). This is an
  input rule, not an observation.

## Hosted live Discovery: one result, up to three candidates

`discover_live_network_evidence` accepts 1–3 exact subjects, at most one per
fixed profile. Count, shape, duplicate profile, network and identifier are all
validated before any RPC read or budget charge (`MCP_LIVE_BEFORE_INPUT`). One
call builds ONE Core-verified `discovery-result`.
[`test/live-before-three-candidates.test.ts`](test/live-before-three-candidates.test.ts)
pins one call over the real F1 Base mainnet capture (`0x8e01…e696`), the real
F3 Solana mainnet capture (`4DYWUMEx…LF71`) and a **test-only absent** Base
Sepolia probe. The absent probe has a synthetic hash; only its `eth_chainId`
answer is real (`base-sepolia-external-v06-userop.json`), and its receipt and
transaction lookups answer `null`. Under `execution` required and `finality`
desired, Core classifies Base mainnet `conditional` (generic EVM finality
unsupported), the absent probe `ineligible` and Solana mainnet `eligible`. The
absent probe is not an observed action. It is not proof that the transaction
never existed or that the network is unavailable.

Budgets, timeouts and size ceilings are unchanged:

- **Admissions:** each subject takes one shared admission
  (`MULTICHAIN_CALLS_PER_MINUTE` 8 per minute, 2 in flight, never refunded),
  and each Base subject also takes one inner EVM admission (8 per minute). Two
  three-subject calls fit in one window. The budget is checked per subject and
  not reserved up front, so a third call reads its first two subjects and then
  fails `MCP_MULTICHAIN_RATE_LIMIT` with no result.
- **Reads:** at most 4 provider reads per subject, 12 per call. The pinned case
  reads 11 (3 for the absent probe).
- **Deadline:** one 35 s whole-call deadline is shared by all subjects. Per-read bounds (6 s
  EVM, 8 s Solana) sum to more: 74 s for the pinned 11 reads, 88 s for the worst allowed 12
  (1 EVM + 2 Solana). A stalled call ends with `MCP_LIVE_DEADLINE_EXCEEDED` and no partial result.
- **Source failures:** a failed source for any subject fails the whole call
  (`MCP_LIVE_BEFORE_UNAVAILABLE`). This includes foreign chain-id bytes and
  provider HTTP 503/429. A provider 429 is never this server's rate-limit code.
- **HTTP ingress:** one call is one HTTP `/mcp` admission, whatever the subject
  count. Ingress 429 (rate/concurrency), 413 (body over the 1 MiB default) and
  408 (5 s body read) are unchanged. The output stays under
  `LIVE_BEFORE_MAX_OUTPUT_BYTES` (180,000).

The offline hosted-reproduction verifier
(`examples/hosted-reproduction/verify-live-before.ts`) accepts 1–3 candidates
on distinct live networks; its cap is pinned by test to
`LIVE_BEFORE_MAX_CANDIDATES`. The capture client's fixed call
`discover-three-candidates` asks for this three-class result over the pinned
Base mainnet tx, the pinned Solana mainnet signature and a made-up Base Sepolia
hash (SYNTHETIC-SUBJECT). The verifier CLI exits 0 only if, besides its
existing conditions, that call verified and its class coverage is met: exactly
one `conditional`, one `eligible` and one `ineligible` candidate. Coverage
never changes a report status. This is proven on loopback only; no hosted
campaign has run.

## Hosted AFTER with an optional `evidenceContext`

`resolve_transaction_evidence` accepts one optional `evidenceContext`: exactly
`{ request, preflight, capabilitySnapshot }` in `nec-wire-json-v1` form. The
`request` is the later Core `EvidenceRequest` for the exact subject. Its
`request.preflight` must reference the supplied Core `PreflightResult` (for
example the `preflight` and `capabilitySnapshot` of an earlier
`preflight_live_network_evidence` call), and its expected action and evidence
policy must canonically equal the preflighted ones. No new tool exists.

- **Validated before any read:** `live-claim.ts` calls `live-result.ts`
  `prepareEvidenceContext` before the single acquisition: size at most
  `EVIDENCE_CONTEXT_MAX_BYTES` (65,536), exact keys, Core wire decoding,
  subject equality, Core contextual verification of snapshot and preflight
  against the server-pinned family manifest (`resolver-evm-generic` or
  `resolver-solana-before`), digest and request binding, and action, policy
  and network continuity. A refused context makes no provider read (row F18)
  and takes no live RPC admission of `MULTICHAIN_CALLS_PER_MINUTE` (`test/live-result-tool.test.ts`), but like any
  parsed request it is charged one HTTP `/mcp` admission (`src/http.ts`): `MCP_EVIDENCE_CONTEXT_NO_PREFLIGHT`,
  `MCP_EVIDENCE_CONTEXT_CALLER_MANIFEST` (any key naming a manifest),
  `MCP_EVIDENCE_CONTEXT_INVALID` or `MCP_EVIDENCE_CONTEXT_TOO_LARGE`.
- **Output:** the envelope is unchanged and gains `evidenceResult`. It is
  either `status: "composed"` with THE Core NetworkEvidenceResult, its
  EvidenceSnapshot and the pinned manifest in wire form (built by Core
  `buildNetworkEvidenceResult`, re-verified by `verifyNetworkEvidenceResult`
  after a wire round trip), or `status: "not_composed"` with one reason:
  `transaction_not_observed`, `block_not_observed`, `acquisition_inconsistent`,
  `block_timestamp_absent`, `preflight_not_before_block` or `output_budget`.
  A composed result enters the generic Hub, Lens and NE Maps path unchanged.
- **Unevaluated dimensions:** a dimension the pinned resolver did not evaluate
  (EVM settlement and finality, Solana settlement) is `applicability:
  "unknown"` with no verdict, basis or evidence. Its `reason` is the fragment's
  own warning rendered `CODE: message`. A policy that requires it stays
  unsatisfied; missing is never zero. The optional `opStackFinality` fragment
  is never merged, so no foreign finality evidence enters the result.
- **Non-claims:** preflight continuity is not precedence. The composer compares `preflight.generatedAt`, which is
  caller-authorable unless it came from the hosted `preflight_live_network_evidence` tool, with the source-reported
  block timestamp. An earlier value is a necessary rejection check only; its provenance is not established, and it is
  not proof that the action or policy existed before execution. The result is not policy satisfaction and
  establishes no settlement; Solana finality stays source-reported. `efda0ca`
  has no pre-execution preflight (fixedBeforeExecution:false) and is refused
  with `MCP_EVIDENCE_CONTEXT_NO_PREFLIGHT`; an authentic AFTER is never recast
  as a BEFORE.
- **Budget:** no extra RPC read, admission or quota. A composed result that
  would not fit becomes `not_composed`/`output_budget`. The final assembled
  envelope (observation, optional `claimAssessment`, `evidenceResult`) is
  measured once against `MULTICHAIN_RESULT_MAX_BYTES` and refused whole with
  `MCP_MULTICHAIN_TOO_LARGE`, never truncated. The `output_budget` fallback
  applies without a concurrent `claim`. With a `claim`, the composer's own
  check (`src/live-result.ts`) measures the envelope without
  `claimAssessment`, so an over-cap assembled envelope that passed that check
  is refused whole with `MCP_MULTICHAIN_TOO_LARGE` and nothing is returned,
  not `output_budget` (`test/evidence-context-economics.test.ts`). Without
  `evidenceContext` the envelope is byte-identical to the one returned before
  this option existed.
- **Replay only:** every BEFORE in the offline tests
  (`test/live-result-tool.test.ts`,
  `examples/ne-maps/test/live-result-case-flow.test.ts`) is labelled
  `SIMULATED_REPLAY_CLOCK` with fixedBeforeExecution:false. The preflight runs
  under a pinned clock over recorded bytes, and the Solana probe is a
  SIMULATED null answer. They show the composer path, not a genuine
  pre-execution action; no hosted call has run.

## Limits and boundaries

- `discover_live_network_evidence`: 1–3 subjects, at most one per fixed profile.
- ≤ 16 candidates per Discovery call; 1 MiB request body by default;
  Core resource bounds (depth 64, 50 000 nodes, 1 MiB strings) on every body.
- No user-supplied URLs or filesystem paths. One fixed data file is read once at startup.
- No live settlement or finality claims. Finality is not settlement.
- zkSYS `eip155:57057` is Tanenbaum testnet / replay only. Base before mainnet
  `eip155:8453` / Sepolia `eip155:84532`. Solana mainnet
  `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` / devnet
  `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`.
- `TARGET_CORE_MUTATIONS = 0`.

## Tests

```sh
npx vitest run packages/mcp
```

- profile inventory truthfulness;
- Discovery byte-equality with direct `@nec/discovery`, plus fail-closed negatives;
- case verbatim/pin/label checks;
- raw JSON-RPC `initialize → tools/list → tools/call` and SDK client (both eras);
- HTTP guards, including the same-port local `Origin` rule;
- hosted mode (`test/hosted.test.ts`): configuration refusals, a real
  `0.0.0.0` bind, exact `Host`/`Origin` admission with simulated public `Host`
  headers, spoofed `X-Forwarded-*`, raw JSON-RPC and SDK-client (both eras)
  through the hosted guards, malformed bodies, and `429` rate/concurrency bounds;
- live-tool failure modes (`test/live-failure-modes.test.ts`): rows F1-F18 of
  the `ne-failure-modes` block at the hosted `tools/call` surface, and the block's
  code set against `src/live-*.ts`;
- optional `evidenceContext` at the hosted `tools/call` surface
  (`test/live-result-tool.test.ts`): no-context byte identity, zero reads and
  no live RPC admission for refused contexts, Core re-verification, OP Stack never merged,
  the once-measured final envelope; all BEFOREs `SIMULATED_REPLAY_CLOCK`;
- static source boundaries (no outbound I/O primitives).
