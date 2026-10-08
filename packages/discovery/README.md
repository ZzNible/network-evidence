# @nec/discovery

Public Discovery orchestrator above `@nec/core`. It answers, for an EXPLICIT
caller-supplied candidate set: *what can each exact network support, and what
is currently observable or usable with evidence?* It never chooses a network.

```ts
import { discoverNetworks } from "@nec/discovery";

const outcome = discoverNetworks({
  requestId: "disc-1",
  generatedAt: "2026-10-08T09:00:00.000Z", // explicit; no clock is read
  requirements: {
    requirements: [
      { capability: "execution", strength: "required" },
      { capability: "finality", strength: "desired" },
    ],
  },
  candidates: [
    // network/manifest/snapshot = an already-derived BEFORE foundation
    { id: "base-sepolia", environment: "testnet", network, manifest, snapshot },
    { id: "solana-mainnet", environment: "mainnet", network, manifest, snapshot },
  ],
  scope: { environments: ["testnet"] }, // optional; candidateIds also supported
});

outcome.result;              // Core DiscoverNetworksResult (built + verified by Core)
outcome.candidates;          // [{ id, environment, networkId, resolver, match }]
outcome.scope;               // applied filters + in/out-of-scope ids
outcome.verificationContext; // re-verify with Core verifyDiscoverNetworksResult
```

The caller then chooses externally and invokes the resolver-specific evidence
preflight (e.g. `deriveOpStackBeforePreflightResult`,
`deriveSolanaBeforePreflightResult`) for its chosen network.

## Delegation to Core (sole truth-table authority)

- `validateDiscoveryRequirements` — request validation.
- `composeDiscoveryMatch` — binding gate for EVERY supplied candidate (full
  fingerprint equality, manifest id/version/digest, manifest authority,
  self-digests) and the classification + evaluations for every in-scope
  candidate. Results are embedded verbatim; nothing is rewritten.
- `buildDiscoverNetworksResult` + `verifyDiscoverNetworksResult` — the
  returned result is Core-built and re-verified against the complete context.

Required unsatisfied/unknown => `ineligible`; desired unsatisfied/unknown =>
`conditional`; unsupported, unavailable, degraded and archived-replay
`unknown` keep exactly their Core meaning. `networkAllowlist` /
`networkDenylist` remain Core request semantics (candidate reported as
`ineligible`), unlike scope, which removes candidates from the result.

## Scope and environment

- `environment` (`"mainnet" | "testnet"`) is a presentation record owned by
  this wrapper: explicit per candidate, never inferred from network ids,
  source ids, labels, fixture names or evidence metadata, never passed to
  Core, never read from evidence. It can only remove candidates from scope;
  relabelling never changes the Core result bytes.
- `scope.candidateIds` is exact. Unknown ids fail closed
  (`DISCOVERY_SCOPE_UNKNOWN_CANDIDATE`), as do empty or duplicate filter
  lists (`DISCOVERY_SCOPE_INVALID`) and a named id excluded by the
  environment filter (`DISCOVERY_SCOPE_CONFLICT`).
- Every supplied candidate is validated through Core, in or out of scope.
- An empty scoped set yields a valid, Core-verified result with no matches
  (Core permits empty `matches`).

## Determinism

Output depends only on input values. `result.matches`, `candidates` and
`verificationContext.capabilitySnapshots` are ordered by candidate
presentation id (UTF-16 code-unit order); manifests are de-duplicated and
ordered by manifest id. Every candidate permutation yields byte-identical
output. The outcome is deep-frozen and detached from caller input.

## Fail-closed errors (`NecDiscoveryError.code`)

`DISCOVERY_INPUT_INVALID`, `DISCOVERY_REQUIREMENTS_INVALID`,
`DISCOVERY_CANDIDATE_ID_INVALID`, `DISCOVERY_CANDIDATE_ID_DUPLICATE`,
`DISCOVERY_ENVIRONMENT_INVALID`, `DISCOVERY_CANDIDATE_BINDING_INVALID`,
`DISCOVERY_NETWORK_DUPLICATE`, `DISCOVERY_CONTEXT_CONFLICT` (shared snapshot
id, or one manifest id with two versions/digests — Core's verification
context resolves by id), `DISCOVERY_SCOPE_INVALID`,
`DISCOVERY_SCOPE_UNKNOWN_CANDIDATE`, `DISCOVERY_SCOPE_CONFLICT`,
`DISCOVERY_RESULT_INVALID`. Core rejections are preserved as `cause`.

## Not owned

No network I/O or URL fetching, no clock, no score, rank, recommendation or
"best network", no wallet, signer, gas/funding, submission or policy logic.
zkSYS replay-only semantics are untouched.

`TARGET_CORE_MUTATIONS = 0`.
