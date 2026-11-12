# Network Evidence MCP — public source behavior contract

> **Source behavior, not a release approval.** This file records code-testable
> declarations, deterministic fixture cases and evidence boundaries of the
> six-tool MCP implementation. It is not a hosted deployment, a service-level
> promise, a wallet, a policy engine or an assessment of settlement/finality.
> Public-facing distribution and publication are separately authorized.

## 1. Status and non-claims

- The six tool definitions and four profiles below are source-declared, not proof of live availability.
- A single RPC response is source observation, not independent cryptographic finality.
- The offline demo does not establish an authenticated or cryptographically anchored BEFORE.
- Transaction inclusion and execution do not demonstrate withdrawal finalization or economic settlement.
- No caller-provided x402 or ERC-4337 economic terms are independently authenticated by the MCP server.
- No signing, funding, submission or payment execution is included.

- Every BEFORE in the two NE-P3 offline `evidenceContext` tests (`packages/mcp/test/live-result-tool.test.ts`, `examples/ne-maps/test/live-result-case-flow.test.ts`) is `SIMULATED_REPLAY_CLOCK` with fixedBeforeExecution:false; the NE-L003 composer test (`packages/mcp/test/live-result.test.ts`) runs its preflights under a pinned replay clock and labels its Solana probe SIMULATED. These replay-clock fixtures do not demonstrate the real action; GT-02 stays OPEN as a formal owner acceptance gate, notwithstanding the separate direct local real-action case below.
- Every BEFORE in the other offline tests that use `SIMULATED_REPLAY_CLOCK` (`packages/mcp/test/evidence-context-economics.test.ts`, `examples/hosted-reproduction/test/verify-evidence-result.test.ts`, `examples/hosted-reproduction/test/capture-action.test.ts`, `examples/hosted-reproduction/test/build-action-case.test.ts`, `examples/hosted-reproduction/test/verify-action-preflight.test.ts`, `examples/hosted-reproduction/test/action-chain-solana.test.ts`), including the NE-L042 to NE-L045 GT-02 operator tooling tests, is `SIMULATED_REPLAY_CLOCK` with fixedBeforeExecution:false on loopback only; their actions, requests and policies are TEST-AUTHORED, not an original caller's. The action-chain-solana BEFORE is a test-derived SIMULATED null probe, and a served Solana preflight appears only as a negative. These replay-clock fixtures demonstrate neither a real pre-execution action nor a hosted call; GT-02 stays OPEN as a formal owner acceptance gate, notwithstanding the separate direct local case below.

## 1a. Real testnet action: direct local BEFORE and AFTER (12 November 2026)

This separate case is **not** one of the replay-clock fixtures above.
On Base Sepolia (chain ID 84532), public transaction
`0x31cb03431986898346344aa3fa196b9924fbd30542f3a5e5f1bde57ff562b2b2`
was included in block 57831719 with receipt success. Two public RPC
operators agreed on its block and receipt. Its USDC contract receipt
contains an `AuthorizationUsed` event whose nonce equals the original
Core preflight artifact digest as bytes32, and a matching `Transfer`
of 10,000 raw test USDC (0.01 test USDC). The EIP-712 signer was
recovered from public transaction data.

The original caller action and policy were fixed **before** wallet
signing and submission. Using the existing candidate source, an
operator directly acquired the AFTER from public RPC endpoints. Core
returned `execution=supported` and `dataBinding=supported` with two
contract-observed effects. The preflight-to-event nonce anchor matched.
Hub admitted the unchanged Core digest; Lens and a generic NE Maps
private case collection passed. The existing independent offline
envelope verifier returned `verified:composed_result_verified`,
`fixedBeforeExecution=true`, and `anchor=anchored`. Three negative
envelope mutations were refused.

**Important limits:** this is direct local RPC acquisition with private
original BEFORE context and locally retained raw captures, **not**
a hosted MCP demonstration, downloadable public BEFORE bundle, independently
authenticated service, third-party human reproduction or deployed NE Maps
website. The public transaction alone cannot reconstruct the original
private BEFORE. A GitHub service timestamp corroborated that the digest was
recorded before execution; it is not a cryptographically signed timestamp
witness. Only execution and contract-observed token effects are supported.
Settlement, OP Stack finality and Ethereum withdrawal finalization are
not established. No new wallet action is necessary for offline verification.

**Release gate:** the genuine action technical GT-02 evidence passed.
Formal owner acceptance, source rights and privacy sign-off, authenticated
source provenance and public publication GO are **separate pending gates**.
The historical beta endpoint is not attested to serve this candidate.

## 2. Scope

The machine-readable blocks below are checked against the *local hosted-mode
source implementation*, not a promise about a currently deployed endpoint.
Older offline three-tool and public beta runtime surfaces must be assessed
against their own executable commits. No source test is an independently
acquired live RPC observation.

## 3. Tool surface

Six read-only tools; descriptions and annotations below are compared to real local SDK tools/list.

```json ne-distribution:tools
[
  {
    "name": "list_network_profiles",
    "title": "List fixed Network Evidence profiles",
    "annotations": { "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false }
  },
  {
    "name": "discover_network_candidates",
    "title": "Core Discovery over explicit candidate contexts",
    "annotations": { "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false }
  },
  {
    "name": "get_reviewed_evidence_case",
    "title": "Read one shipped reviewed NE Maps case",
    "annotations": { "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false }
  },
  {
    "name": "preflight_live_network_evidence",
    "title": "Evidence preflight on caller-selected Base or Solana network",
    "annotations": { "readOnlyHint": true, "destructiveHint": false, "idempotentHint": false, "openWorldHint": true }
  },
  {
    "name": "discover_live_network_evidence",
    "title": "Discover networks from exact live Base or Solana evidence",
    "annotations": { "readOnlyHint": true, "destructiveHint": false, "idempotentHint": false, "openWorldHint": true }
  },
  {
    "name": "resolve_transaction_evidence",
    "title": "Evaluate EVM or Solana transaction evidence (read only)",
    "annotations": { "readOnlyHint": true, "destructiveHint": false, "idempotentHint": false, "openWorldHint": true }
  }
]
```

```json ne-distribution:descriptions
{
  "list_network_profiles": "Returns four live-mode DECLARED profiles: Base mainnet/Sepolia and Solana mainnet/devnet, without zkSYS. Listing is NOT an actual availability probe; use discover_live_network_evidence with exact subjects for source observations.",
  "discover_network_candidates": "Runs the real @nec/discovery discoverNetworks (classification by @nec/core only) over 1..16 EXPLICIT, complete, already-derived candidate contexts you supply (network + ResolverManifest + CapabilitySnapshot in nec-wire-json-v1 form) and Core DiscoveryRequirements. Returns the Core-built, Core-verified DiscoverNetworksResult with digests and per-candidate eligible/conditional/ineligible copied from Core. The outcome depends ONLY on the supplied snapshots; this server observes nothing and does NOT choose, rank or recommend a network. Any resolver-specific evidence preflight is external to this tool. Invalid or incoherent contexts fail closed with a coded error.",
  "get_reviewed_evidence_case": "Returns ONE case by exact id (f1, f2, f3, synthetic-local-core-golden) from the shipped, checksum-pinned examples/ne-maps/data/collection.json: the browser-safe Lens envelope verbatim (all limitations, unavailable/unknown states and nonClaims preserved), its source provenance and an explicit label. f1/f2/f3 are HISTORICAL reviewed exports of past public-network observations; synthetic-local-core-golden is a SYNTHETIC fixture, not a network observation. No case is live evidence.",
  "preflight_live_network_evidence": "Read-only hosted pre-release: caller explicitly chooses one pinned Base/Solana network and supplies COMPLETE original Core PreflightRequest with expected action + valid evidencePolicy digest, and a separate exact completed same-network transaction as a source-capability probe. Validate ALL inputs BEFORE RPC, then derive the unchanged native EVM/Solana BEFORE foundation and context-verify the Core PreflightResult against complete ResolverManifest and CapabilitySnapshot. Readiness is evidence acquisition only, NOT prior network selection, future action execution, wallet/account/gas readiness, x402 agreement, settlement, or cryptographic consensus.",
  "discover_live_network_evidence": "Read-only opt-in PRE-RELEASE: acquire 1-3 source-bound transaction/signature probes (at most one per fixed profile) on fixed Base/Solana profiles, derive existing Core CapabilitySnapshots and run Core-verified Discovery. A probe supports only those exact read paths at observation time, not global uptime, settlement, cryptographic finality or a network recommendation. No arbitrary RPC, signing or submission.",
  "resolve_transaction_evidence": "Read-only opt-in pre-release: acquire an exact Base or Solana transaction from fixed RPC sources. On Base only, includeL2Finality optionally acquires a separate Core finality-only fragment under a bounded 8-ancestor native OP Stack ruleset; INSUFFICIENT has distinct native causes (unwalked ancestry, source head below the subject or missing facts); inspect the native warning and reason, do not infer a universal finalized or unfinalized state. This is a ONE-source L2 block view, NOT Ethereum settlement or withdrawal finalization. Optionally assess ONE caller-supplied native x402 EVM, ERC-4337 or x402 SVM structured claim, validated and bound to the exact subject BEFORE the read. Return original Core fragment plus adapter-local claim result, if requested; neither is protocol settlement, cryptographic finality, or a full Core NetworkEvidenceResult. Optional evidenceContext (caller-returned Core EvidenceRequest + PreflightResult + CapabilitySnapshot, validated BEFORE the read against the server-pinned family resolver manifest) adds evidenceResult: a Core-built, Core-verified NetworkEvidenceResult or an explicit not_composed reason. Preflight continuity is NOT precedence or proof the action and policy existed before execution, the result is NOT policy satisfaction, dimensions the resolver did not evaluate stay unknown, and OP Stack finality is never merged into it. Caller-supplied protocol terms are NOT independently authenticated by this intake; no arbitrary RPC URLs, wallet, signing, submission or ranking."
}
```

## 4. Active profiles

Four fixed declarations, not availability or consensus checks.

```json ne-distribution:profiles
[
  { "profileId": "base-mainnet", "networkId": "eip155:8453", "environment": "mainnet", "family": "opstack" },
  { "profileId": "base-sepolia", "networkId": "eip155:84532", "environment": "testnet", "family": "opstack" },
  { "profileId": "solana-mainnet", "networkId": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "environment": "mainnet", "family": "solana" },
  { "profileId": "solana-devnet", "networkId": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", "environment": "testnet", "family": "solana" }
]
```

## 5. Limits

Numbers below are exported from the code. Whole-call and per-source budgets are distinct.

```json ne-distribution:limits
{
  "MULTICHAIN_CALLS_PER_MINUTE": 8,
  "MULTICHAIN_MAX_INFLIGHT": 2,
  "LIVE_TOOL_DEADLINE_MS": 35000,
  "MULTICHAIN_RESULT_MAX_BYTES": 450000,
  "LIVE_BEFORE_MAX_AGE_MS": 180000,
  "LIVE_OPSTACK_MAX_ANCESTRY_DEPTH": 8,
  "LIVE_BEFORE_MAX_CANDIDATES": 3,
  "LIVE_BEFORE_MAX_OUTPUT_BYTES": 180000,
  "LIVE_PREFLIGHT_MAX_INPUT_BYTES": 30000,
  "LIVE_PREFLIGHT_MAX_OUTPUT_BYTES": 180000,
  "LIVE_EVM_MAX_CALLS_PER_MINUTE": 8,
  "LIVE_EVM_MAX_CONCURRENT": 2,
  "LIVE_EVM_RPC_TIMEOUT_MS": 6000,
  "LIVE_EVM_MAX_RPC_BYTES": 128000,
  "LIVE_EVM_MAX_RESULT_BYTES": 350000,
  "LIVE_OPSTACK_MAX_RPC_READS": 14,
  "SOLANA_READ_TIMEOUT_MS": 8000,
  "SOLANA_RESPONSE_MAX_BYTES": 800000,
  "EVIDENCE_CONTEXT_MAX_BYTES": 65536,
  "HTTP_MCP_ADMISSIONS_PER_MINUTE": {
    "configurableBy": "NE_MCP_RATE_LIMIT_PER_MINUTE",
    "hostedDefault": 240,
    "min": 1,
    "max": 6000
  }
}
```

- `MULTICHAIN_CALLS_PER_MINUTE`: live source acquisitions per 60 s window per process, shared by the three live tools; Discovery takes one per subject.
- `MULTICHAIN_MAX_INFLIGHT`: live acquisitions in flight at once per process.
- `LIVE_TOOL_DEADLINE_MS`: one whole-call deadline per live tool call; no provider read starts after it (defined in local source; deployment not established by this document).
- `MULTICHAIN_RESULT_MAX_BYTES`: maximum serialized size of one `resolve_transaction_evidence` result, including any `claimAssessment` and `evidenceResult`; the assembled envelope is measured once and refused whole, never truncated (`packages/mcp/src/live-claim.ts:181-185`).
- `LIVE_BEFORE_MAX_AGE_MS`: maximum age of the acquired observation that Discovery or preflight derives a capability snapshot from.
- `LIVE_OPSTACK_MAX_ANCESTRY_DEPTH`: bounded ancestor walk for the optional Base OP Stack L2 block view.
- `LIVE_BEFORE_MAX_CANDIDATES`: maximum subjects in one `discover_live_network_evidence` call, refused by the served input schema and again before any RPC read or budget charge (`packages/mcp/src/tools.ts:408`, `packages/mcp/src/live-before.ts:137`).
- `LIVE_BEFORE_MAX_OUTPUT_BYTES`: maximum serialized size of one `discover_live_network_evidence` result; a larger result is refused with no partial output (`packages/mcp/src/live-before.ts:213`).
- `LIVE_PREFLIGHT_MAX_INPUT_BYTES`: maximum serialized size of one `preflight_live_network_evidence` input, refused before any RPC read (`packages/mcp/src/live-preflight.ts:92`).
- `LIVE_PREFLIGHT_MAX_OUTPUT_BYTES`: maximum serialized size of one `preflight_live_network_evidence` result (`packages/mcp/src/live-preflight.ts:191`).
- `LIVE_EVM_MAX_CALLS_PER_MINUTE`: inner Base acquisitions per 60 s window per process, taken after the shared admission by every Base subject of the three live tools (`packages/mcp/src/live-evm.ts:209`, reached through `packages/mcp/src/live-multichain.ts:144,179`).
- `LIVE_EVM_MAX_CONCURRENT`: inner Base acquisitions in flight at once per process (`packages/mcp/src/live-evm.ts:209`).
- `LIVE_EVM_RPC_TIMEOUT_MS`: per-read time bound of one Base RPC read, inside the whole-call deadline (`packages/mcp/src/live-evm.ts:148`).
- `LIVE_EVM_MAX_RPC_BYTES`: maximum bytes of one Base RPC response, by advertised length and by bounded stream read; no truncated evidence is kept (`packages/mcp/src/live-evm.ts:162,176`).
- `LIVE_EVM_MAX_RESULT_BYTES`: maximum serialized size of the inner Base output before the `resolve_transaction_evidence` envelope is built (`packages/mcp/src/live-evm.ts:395`).
- `LIVE_OPSTACK_MAX_RPC_READS`: maximum Base RPC reads for the optional OP Stack L2 block view of one `resolve_transaction_evidence` call, derived from `LIVE_OPSTACK_MAX_ANCESTRY_DEPTH` (`packages/mcp/src/live-evm.ts:27,143`).
- `SOLANA_READ_TIMEOUT_MS`: per-read time bound of one Solana RPC read, inside the whole-call deadline (`packages/mcp/src/live-solana.ts:92`, reached through `packages/mcp/src/live-multichain.ts:212`).
- `SOLANA_RESPONSE_MAX_BYTES`: maximum bytes of one Solana RPC response, by advertised length and by bounded stream read (`packages/mcp/src/live-solana.ts:108,135`).
- `EVIDENCE_CONTEXT_MAX_BYTES`: maximum serialized size of the optional `evidenceContext` of one `resolve_transaction_evidence` call, refused with `MCP_EVIDENCE_CONTEXT_TOO_LARGE` before any RPC read (`packages/mcp/src/live-result.ts:38,200`, reached through `packages/mcp/src/live-claim.ts:167`). A refused context takes no live RPC admission (`MULTICHAIN_CALLS_PER_MINUTE`) and no provider read, but like any parsed request it is charged one HTTP `/mcp` admission (`packages/mcp/src/http.ts:271`).
- Per `discover_live_network_evidence` call (bound, as `packages/mcp/README.md:486-503` records): ≤`LIVE_BEFORE_MAX_CANDIDATES` shared admissions (one per subject, never refunded), at most one inner EVM admission per Base subject, ≤12 provider reads (at most 4 per subject) and exactly one HTTP `/mcp` admission whatever the subject count. The budget is checked per subject and not reserved up front, so a call that runs out mid-way fails `MCP_MULTICHAIN_RATE_LIMIT` with no result after reading its earlier subjects.
- `HTTP_MCP_ADMISSIONS_PER_MINUTE`: process-wide `/mcp` admissions per 60 s, all callers together (not per user), set by `NE_MCP_RATE_LIMIT_PER_MINUTE`. The source default applies only when the variable is unset. Any deployed revision's actual value is configuration-specific and must be checked from that revision.

## 6. Privacy-notice delta vs `MCP_PRIVACY_POLICY.md`

The public `MCP_PRIVACY_POLICY.md` was updated on 2026-11-08 (editorially clarified 2026-11-11) to clarify the boundary between historical hosted services and unpublished source. The deployed revision and hosting retention were not independently rechecked.

- **`evidenceContext` (source behavior; deployment not established):** the optional `evidenceContext` of `resolve_transaction_evidence` is never sent to the RPC providers. The served `evidenceResult` echoes the `requestId`, the request digest, the complete expected action and the policy id, version and digest. It does not echo the `account`, the request or preflight `metadata`, or the content of the supplied preflight or capability snapshot. Nothing of the context is logged. The notice's caller-originated Core request and policy description (`MCP_PRIVACY_POLICY.md`, Information processed) covers the substance; `MCP_PRIVACY_POLICY.md` was updated for source/deployment scope; actual hosted revision privacy and retention still require revalidation.

## 7. How to read the cases

A capture specification is a reproducible request definition, not proof that
a provider was contacted or that an economic consequence occurred. Preserve
separate network observation, local derivation, execution, effect, settlement
and finality. Synthetic and historical fixtures remain explicitly identified.

## 8. Reproducible fixture and capture cases

These case IDs are local fixtures or read-only capture scripts, not evidence
that a live provider was queried during a test or that an economic action occurred.
The cases below refer to the 14 `CAPTURE_CALLS` but do not establish release authorization.

<!-- reviewer-cases:start -->
| RC | type | tool | evidence | expected |
| --- | --- | --- | --- | --- |
| RC1 | positive | `list_network_profiles` | `capture:profiles` | Exactly the four profiles of §4 and no `eip155:57057`; every `currentAvailability` is `not_assessed` (a listing is not availability). |
| RC2 | positive | `resolve_transaction_evidence` | `capture:base-mainnet-pinned` `fixture:packages/mcp/test/fixtures/base-mainnet-l2-finalized-positive-evm.json` | `toolStatus: observed`, `evidenceBasis: source_observation`, `artifactType: network-evidence-fragment` for `0x71c9…625c`; a fragment, not a full Core result; no contradicted verdict. |
| RC3 | positive | `resolve_transaction_evidence` | `capture:base-mainnet-pinned-l2-finality` `fixture:packages/mcp/test/fixtures/base-mainnet-l2-finalized-positive-opstack.json` | As RC2 plus `opStackFinality` with ruleset `opstack.rpc-finalized-head-v1`, `withdrawalFinalization: not_evaluated`, `ethereumSettlement: not_evaluated` and `maxAncestryDepth` equal to `LIVE_OPSTACK_MAX_ANCESTRY_DEPTH`; one-source L2 block view only. |
| RC4 | positive | `resolve_transaction_evidence` | `capture:solana-mainnet-pinned` `fixture:packages/resolver-solana/test/fixtures/solana-mainnet-x402-real.json` | Observed fragment for `4DYWUMEx…LF71`; the finalized commitment is source-reported, not cryptographic; no x402 settlement is evaluated. |
| RC5 | positive | `discover_live_network_evidence` then `preflight_live_network_evidence` | `capture:discover-mainnet` `capture:discover-three-candidates` `capture:preflight-base-mainnet-probe` | As in the NE-L015 offline replay of the same subjects: `base-mainnet` conditional and `solana-mainnet` eligible with no ranking or choice key; preflight `choiceSource: caller`, status `blocked`, finality and settlement readiness `not_applicable`. The probe request is capture-client-authored, not the new exact action. `discover-three-candidates`: one Core Discovery result with `eip155:8453` conditional, `eip155:84532` ineligible and Solana mainnet eligible, no ranking or choice key. Its Base Sepolia probe is a SYNTHETIC-SUBJECT made-up well-formed hash, not an observed action: ineligible there is not proof of nonexistence or of network unavailability. A `source_failure` is never a verdict. |
| RC6 | negative | `resolve_transaction_evidence` | `capture:refuse-unsupported-network` | `eip155:57057` is refused as input (SDK input-schema refusal or typed input code) before any RPC read. |
| RC7 | negative | `resolve_transaction_evidence` | `capture:refuse-malformed-solana-signature` | A signature whose first character is outside base58 is refused as input before any RPC read. |
| RC8 | negative | `resolve_transaction_evidence` | `capture:synthetic-base-mainnet-subject` | SYNTHETIC-SUBJECT made-up well-formed hash: `transactionObserved: false` (insufficient) or a typed source failure, never contradicted; not-found is not proof of nonexistence. |
<!-- reviewer-cases:end -->

## Source assurance limits

This public-source contract intentionally excludes release-approval drafts,
human/Registry approval placeholders, private deployment-state notes,
internal owner rulings and the private gate matrix. Consult the actual
versioned product source and current external service observations independently.
