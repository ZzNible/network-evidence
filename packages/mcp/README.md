# @nec/mcp — local, read-only Network Evidence MCP server (v0)

> **Status (2026-10-09):** local mode stays loopback-only by default. The separate **public, anonymous, read-only Google Cloud Run service** is LIVE at `https://network-evidence-mcp-jrkc26rjga-ew.a.run.app/mcp`, checked in both MCP protocol eras. The official MCP Registry lists `io.github.ZzNible/network-evidence` **v0.0.2 ACTIVE**. The existing PRIVATE ChatGPT plugin v0.1.2, Codex and Claude Code have migrated to this URL; the latter two were tested with real tool calls, while a ChatGPT-conversation invocation remains unverified. The former `network-evidence-mcp-preview` Cloud Run service is kept temporarily as rollback. This is an **offline, limited read-only preview**, not live monitoring, an npm publication, a public ChatGPT/Claude catalog listing, or a production uptime commitment. See the [hosted preview](#hosted-preview-mode-opt-in-public-cloud-run-preview).
> See [`docs/distribution/MCP_LAUNCH_CHECKLIST.md`](../../docs/distribution/MCP_LAUNCH_CHECKLIST.md)
> and [`docs/distribution/RENDER_DEPLOY_RUNBOOK.md`](../../docs/distribution/RENDER_DEPLOY_RUNBOOK.md).

> **Separate candidate, NOT DEPLOYED:** an opt-in, read-only live Base EVM transaction tool is under review on branch `work/ne-mcp-live-evm-20261009`; see [MCP live EVM candidate](../../docs/distribution/MCP_LIVE_EVM_CANDIDATE_20261009.md). The production/public MCP still has 3 offline tools. No public RPC functionality should be claimed for it until explicitly deployed and verified.

A Model Context Protocol server over public Network Evidence code. It exposes
three read-only tools and performs **no network I/O**: no RPC, crawler,
transaction watcher, explorer, indexer or live monitoring. It has no wallet,
signer, funding/gas or transaction submission, and it never chooses, scores,
ranks or recommends a network.

- **BEFORE** asks: what can an exact network/deployment support, and what is
  currently observable/usable *with evidence*?
- **AFTER** asks: what can the network itself independently support about one
  exact action?

This server observes nothing, so it never answers "now". Current support is
not current availability. Manifest membership is not live availability.
Archived replay keeps current availability `unknown`.

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
  (`@modelcontextprotocol/server` 2.3.1, `@modelcontextprotocol/node` 2.1.1,
  `createMcpHandler` + `toNodeHandler`).
- Both protocol eras are served by one per-request server factory:
  - **2025 era** (`2025-11-25` and earlier): `initialize` → `notifications/initialized`
    → `tools/list` → `tools/call`, served statelessly (no session id);
  - **modern** (`2026-07-28`): `server/discover` + per-request `_meta` envelope.
- `GET`/`DELETE /mcp` → `405` (stateless; no standalone SSE stream).
- `GET /healthz` → static JSON (`status`, tool names, `readOnly: true`,
  `liveObservation: false`, `networkIo: "none"`, `mode`, and a mode-specific
  `scope`: `"local v0; not a public endpoint"` locally).

Request guards, in order: `Host`/`Origin` validation (DNS-rebinding
protection; local: loopback `Host` names and, when an `Origin` is sent, only
the exact same-port loopback origin `http://{127.0.0.1|localhost|[::1]}:<port>`.
A browser page on another local port is refused. Hosted: see above) →
global `/mcp` abuse limiter (`429`) → `Content-Type: application/json` (`415`) →
byte-bounded body read (`413`) → the **@nec/core strict wire parser** over the
raw body (duplicate JSON keys, malformed JSON, depth/node/string bounds →
`400`, JSON-RPC `-32700`) → SDK. Each request gets a fresh `McpServer`.

For **Google Cloud Run**, use `GET /health` (or HEAD) in hosted mode for health checks. Cloud Run reserves some URL paths ending in `z`, so `/healthz` can return a Google frontend 404 without reaching the application. Hosted `/health` returns the identical static payload and keeps the exact Host/Origin guards. `/healthz` stays available for Render and local mode; local mode deliberately does not serve `/health`.

Browser-based cross-origin clients are not supported in hosted preview mode (no CORS preflight headers). Server-to-server MCP clients with no `Origin` header are supported; any supplied `Origin` must exactly match an explicitly configured HTTPS origin.

Logging is one stderr line per request: method, route (`/mcp`, `/healthz` or
`(other)`), status and duration. Headers, bodies, tool arguments, client
addresses and identifiers are never logged. The abuse limiter keeps two global
counters only. It stores no IP, payload, credential or client identifier.

## Tools

All three tools carry explicit annotations
`{ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }`
and strict input schemas (`additionalProperties: false`). Errors come back as
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

## Limits and boundaries

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
- static source boundaries (no outbound I/O primitives).
