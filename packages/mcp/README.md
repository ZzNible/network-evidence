# @nec/mcp — local, read-only Network Evidence MCP server (v0)

> **Status: local v0 only.** This is NOT a public endpoint, NOT published to npm,
> NOT listed in any MCP registry or directory, and NOT a ChatGPT/Codex/Claude
> plugin. It binds loopback only and has no authentication. See
> [`docs/distribution/MCP_LAUNCH_CHECKLIST.md`](../../docs/distribution/MCP_LAUNCH_CHECKLIST.md)
> for what remains before any public launch.

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
  `liveObservation: false`, `networkIo: "none"`).

Request guards, in order: `Host`/`Origin` validation (loopback names only,
DNS-rebinding protection) → `Content-Type: application/json` (`415`) →
byte-bounded body read (`413`) → the **@nec/core strict wire parser** over the
raw body (duplicate JSON keys, malformed JSON, depth/node/string bounds →
`400`, JSON-RPC `-32700`) → SDK. Each request gets a fresh `McpServer`.

Logging is one stderr line per request: method, route (`/mcp`, `/healthz` or
`(other)`), status and duration. Headers, bodies, tool arguments, client
addresses and identifiers are never logged.

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
- HTTP guards;
- static source boundaries (no outbound I/O primitives).
