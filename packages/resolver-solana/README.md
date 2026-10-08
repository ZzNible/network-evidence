# @nec/resolver-solana

Generic, post-fact Solana network evidence for NEC. It performs no wallet, key, signing, transaction-construction, submission, sponsor, facilitator, payment-policy, or x402 work.

## Scope

The v0.1 resolver validates the `solana:<32-character CAIP genesis reference>` by deriving it from the full `getGenesisHash` result, then performs bounded sequential reads: `getTransaction(signature, {commitment:"finalized",encoding:"json",maxSupportedTransactionVersion:0})`, `getSignatureStatuses([signature], {searchTransactionHistory:true})`, and, when a transaction is available, compact `getBlock(slot, {commitment:"finalized",transactionDetails:"none",rewards:false,maxSupportedTransactionVersion:0})`. There is no batching or silent retry. An explicit `fetchFn` is required.

Legacy and version-0 transactions are supported. Version-0 effective account keys are the complete static + loaded-writable + loaded-readonly space. ALT lookup counts must exactly match resolved loaded addresses; missing or partial ALT resolution fails closed. Every program/account index is range-checked.

Compiled top-level instructions are decoded locally. An actual-array `meta.innerInstructions` (including `[]`) supplies complete CPI-trace metadata; `null` or an absent field does not establish a complete trace and is preserved as `instructionTraceComplete: false`. Only discriminator `12` `TransferChecked` under canonical SPL Token or Token-2022 is emitted. Source, mint, destination, authority, u64 amount, decimals, deterministic instruction location, stack height when observed, and transaction signature are preserved. A failed transaction never emits a positive observed effect.

## Fixture and replay

`nec-resolver-solana-fixture-v1` stores schema version, acquisition time, endpoint-free source identity, network, signature, and ordered raw RPC result text (or controlled RPC error). Replay is strict and offline: requests must match the next capture, duplicates/unmatched/unused captures fail, and repeated replay is deterministic. Fixtures reject endpoint URLs, credentials, private paths, secret-like text, exotic objects, accessors, and malformed raw results.

## Claim boundary

Execution means only that this source returned `meta.err == null` for the exact signature. Finality requires mutually consistent finalized transaction, signature-status, error, slot, and containing-block observations. Its basis is `source_observation`, not `cryptographic_verification`. Solana finalized commitment is not a claim of economic irreversibility. Generic acquisition does not infer settlement and contains no x402 interpretation.

## BEFORE foundation (Solana mainnet + devnet)

The BEFORE side is a pure derivation (`src/before.ts`). It takes one explicit genesis-bound config and one already-acquired probe observation, and builds frozen `@nec/core` artifacts: `ResolverManifest`, `CapabilitySnapshot`, `DiscoveryCandidate` and an evidence `PreflightResult`. The derivation does no network, clock, wallet, key, signing, funding or submission work. The post-action acquisition, evaluation and fixture paths above are unchanged.

Manifest `resolver-solana-before@0.1.0` (family `solana`, source `svm_rpc`) claims `execution`, `observedEffects`, `dataBinding` and `finality`. That is exactly what the post-action evaluator evaluates. It never claims `settlement`, and no execution-family slot is populated. Being in the manifest permits evaluation only. It never proves availability.

Availability. The post-action pipeline is one sequential read sequence, and any read failure aborts it. So every supported capability needs the same probe paths:

1. full `getGenesisHash` identity,
2. `getTransaction(finalized)`,
3. `getSignatureStatuses(searchTransactionHistory)`,
4. compact `getBlock(finalized)`.

Each path outcome is `usable`, `not_established` or `unusable`. `not_established` means not probed, or answered `null`: the subject was unknown, pruned or not yet visible. `unusable` means the read itself failed. The ladder, first match wins:

| Probe outcome | Availability |
| --- | --- |
| Source did not answer | `unavailable` |
| Genesis read failed | `unavailable` |
| Genesis not established | `unknown` |
| Any lookup read failed | `unavailable` |
| Any lookup not established | `unknown` |
| Lookups mutually inconsistent (signature, status slot, error, parent slot) | `degraded` |
| Finality only: finalized commitment not observed for the probe subject | `unknown` |
| Otherwise | `available`, citing the identity and lookup refs |

A `usable` path without a classified EvidenceRef is ghost evidence and is rejected. Refs are classified by `metadata.probePath`, or else by `metadata.rpcMethod`. Refs from other networks or a second source are also rejected.

Finality boundary. `finality` means only Solana finalized commitment as reported by the configured source, with basis `source_observation`. Its metadata lists `settlement`, `economic_irreversibility` and `independent_cryptographic_verification` as not established. Settlement is `unsupported`/`unavailable`. A required settlement requirement is therefore unsatisfied in discovery and `not_applicable` (blocked) in preflight.

Network identity. `SolanaBeforeNetworkConfig = {networkId, genesisHash}` pins the full genesis hash, and `networkId` must equal `solana:` plus its first 32 characters. The observed full hash must equal the pinned one exactly. This is stricter than the post-action prefix binding, which stays unchanged. Any network, genesis or evidence-network mismatch fails closed with `SOLANA_NETWORK_MISMATCH`.

Profiles. There are two:

- `SOLANA_MAINNET_BEFORE_PROFILE`: `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`, genesis `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d`, labelled `mainnet`.
- `SOLANA_DEVNET_BEFORE_PROFILE`: `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`, genesis `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`, labelled `testnet`.

A derivation consumes only `profile.config`. The profile `id`, `label` and `environment` never appear in an artifact. A profile object passed as config is rejected.

Observation kinds:

- `probe`: the caller's own fresh observation. For example, `acquireSolanaTransaction` with an explicit `fetchFn`, projected by `solanaProbeObservationFromAcquisition`.
- `historical_replay`: an archived fixture, for example via `replaySolanaBeforeFoundation`. Every supported capability gets current availability `unknown`. The capture-time outcome is kept only in metadata (`historicalAvailabilityAtCapture`, `historicalCaptureTime`).

Preflight reports evidence readiness only: no balance, fee funding, wallet, signer, transaction construction or submission, sponsor or facilitator readiness.

Pinned replay fixtures (read-only public RPC, no transactions created):

| Profile | Fixture | Capture |
| --- | --- | --- |
| Solana mainnet | `test/fixtures/solana-mainnet-x402-real.json` (reused unchanged, SHA-256 `62b5191f…720a`) | 2026-08-26, finalized slot 418897974 |
| Solana devnet | `test/fixtures/solana-devnet-before-probe.json` (SHA-256 `1b9b278d…282a`) | 2026-10-08, finalized slot 508743915 |

The devnet fixture was recorded with the unchanged `acquireSolanaTransaction` against the official public endpoint `https://api.devnet.solana.com`, with no credentials. The capture made these read-only calls:

1. `getSlot({commitment:"finalized"})`.
2. One `getBlock(slot, {commitment:"finalized", transactionDetails:"accounts", maxSupportedTransactionVersion:1})`, to list the block's transactions.
3. The resolver's four reads, on the first legacy/v0 non-vote transaction of that already-finalized block.

The subject is a third-party program call, used only to exercise the read path. It is not an action of this project, and nothing was created, signed or submitted. All six acquisition consistency checks passed.

Limitations:

- Archived fixtures never establish current availability.
- A probe's availability holds only at its probe time, for the probed source.
- The post-action resolver accepts only legacy and version-0 transactions. Devnet blocks now carry version-1 transactions, so actions using them are outside this resolver's evaluable scope.
- The post-action resolver rejects instruction data longer than 128 base58 characters. One example is devnet vote `TowerSync`.
- `observedEffects` covers only SPL Token / Token-2022 `TransferChecked`.

API:

- `solanaBeforeResolverManifest()`
- `deriveSolanaBeforeFoundation({config, observationKind, observation})`
- `deriveSolanaBeforePreflightResult(foundation, request)`
- `replaySolanaBeforeFoundation({config, fixture})`
- `solanaProbeObservationFromAcquisition(acquisition)`
- `validateSolanaBeforeNetworkConfig(config)`
- `SOLANA_MAINNET_BEFORE_PROFILE`, `SOLANA_DEVNET_BEFORE_PROFILE`, `SOLANA_BEFORE_PROFILES`, `SOLANA_FINALITY_DOES_NOT_ESTABLISH`
