# @nec/resolver-opstack

NEC's first **network-specific finality resolver** (v0.1): explicit OP Stack
chain-family configuration, single-source L2 block finality observation over
the `finalized`/`safe`/`latest` RPC heads with a bounded parentHash ancestry
walk down to the subject block, raw capture with offline deterministic
replay, and pure evaluation into a finality-only `NetworkEvidenceFragment`.

The generic EVM resolver (`@nec/resolver-evm`, frozen) establishes execution,
dataBinding and observedEffects — deliberately NOT settlement or finality.
This package adds ONLY chain-family-specific safety/finality evidence on top.
`@nec/core` is consumed through public exports; never redefined.

## THE semantic boundary (never collapsed)

> **An OP Stack L2 block being FINALIZED is NOT the same as a withdrawal or
> output root being finalized after a fault-proof dispute period.**

Per the current OP Stack specification there are three relevant L2 safety
levels:

| Level       | OP Stack semantics (pinned sources below)                                                                 |
| ----------- | --------------------------------------------------------------------------------------------------------- |
| `unsafe`    | Sequencer/preconfirmation level: blocks "not derived from L1", applied out of band and reorgable when L1 data conflicts (`headBlockHash`, labeled `"unsafe"` in user JSON-RPC). |
| `safe`      | Everything up to and including this block can be fully derived from the **currently canonical** L1 chain.   |
| `finalized` | Blocks that have been derived from **finalized L1 data** (the canonical and forever-irreversible part of L1). |

Base mainnet JSON-RPC exposes exactly these as `eth_getBlockByNumber` block
tags: `"latest"`, `"pending"`, `"safe"`, `"finalized"`.

Withdrawals are a DIFFERENT process entirely: a withdrawal is proven against a
proposed output root and finalized on L1 only after a fault-proof challenge
period. This package implements **L2 BLOCK FINALITY ONLY**. It never
evaluates withdrawals, output roots, dispute windows or settlement, and it
never populates the settlement dimension merely because finality is supported.

### What "finalized" means here (and what it does NOT)

Throughout this package, **"finalized" means the configured RPC source's OP
Stack L2 finalized VIEW**, as reported by `eth_getBlockByNumber("finalized")`
during one observation burst. It does NOT mean:

- a withdrawal is finalized;
- a dispute game is completed;
- an output root is economically irreversible;
- funds are economically irreversible.

### Pinned specification sources (inspected 2026-08-24)

- OP Stack Specification — *L2 Chain Derivation* (`specs.optimism.io/protocol/derivation.html`):
  definitions of unsafe/safe/finalized L2 blocks ("Finalized L2 blocks:
  refer to blocks that have been derived from finalized L1 data"; safe head =
  derivable from the currently canonical L1 chain).
- OP Stack Specification — *L2 Execution Engine* (`specs.optimism.io/protocol/exec-engine.html`):
  forkchoice translation (`headBlockHash` = unsafe, may reorg on L1 conflicts;
  `safeBlockHash` = derived from L1 data; `finalizedBlockHash` = irreversible,
  lower boundary of the dispute period).
- OP Stack Specification — *Withdrawals* (`specs.optimism.io/protocol/withdrawals.html`):
  proving + 7-day challenge period + portal finalization — separate from L2
  block finality.
- Base Documentation — *eth_getBlockByNumber* (`docs.base.org/base-chain/api-reference/ethereum-json-rpc-api/eth_getBlockByNumber`):
  block tags `latest | pending | safe | finalized | earliest`; block object or
  `null`.

## Explicit family configuration

NEC NEVER infers the chain family from a chain id (`8453 => opstack` is not a
rule here). Network identity and family semantics are configured explicitly
and re-validated at every boundary; unknown keys fail closed:

```ts
const config: OpStackFinalityConfig = {
  networkId: "eip155:8453",
  chainId: 8453,
  family: "opstack",                      // literal — required
  ruleset: "opstack.rpc-finalized-head-v1", // pinned ruleset identifier
  rulesetVersion: "1",                     // pinned ruleset version
};
```

Base mainnet (`eip155:8453`) is the FIRST TESTED configuration, never the only
possible one: any explicitly configured OP Stack network exposing the
`safe`/`finalized` tags is accepted under the same ruleset.

## Architecture

```text
generic EVM acquisition/evaluation (@nec/resolver-evm)
        |
        v
subject transaction + containing L2 block anchor (S, Hs)
        |
        v
OP Stack finality acquisition (ONE configured source, sequential):
    eth_chainId                                   (identity gate)
    eth_getBlockByNumber("finalized", false)      -> F   [first read of burst]
    eth_getBlockByNumber("safe", false)           -> Safe
    eth_getBlockByNumber("latest", false)         -> Latest
    IF F.number >= S AND F.number - S <= maxAncestryDepth:
        eth_getBlockByHash(parentHash, false)     repeated down to height S
        (explicit bounded parentHash ancestry — NEVER inferred from numbers;
         truncated at the first broken link)
    eth_getBlockByNumber(<S hex>, false)          -> canonical re-read at S
    IF the walk completed:
        eth_getBlockByNumber("finalized", false)  -> burst-stability re-read
        |  raw captures -> normalized observations -> consistency checks
        v
pure OP Stack evaluator (pinned ruleset, fail closed)
        |
        v
NetworkEvidenceFragment carrying FINALITY ONLY
        |
        v
core composition with the generic EVM fragment
(mergeConflicts / mergeWarnings / dimension-table merge — existing core APIs)
```

Acquisition is strictly separated from pure evaluation; the evaluator runs
offline (no network, no clock, no randomness).

## Evidence basis

`source_observation` — EXACTLY that, and nothing more. This resolver does NOT
replay OP derivation from L1 inputs and runs NO consensus engine: locally
comparing and linking RPC observations is not derivation. Therefore
`deterministic_derivation`, `local_consensus_engine` and
`cryptographic_verification` NEVER appear in any basis this package emits.

Standing limitations are emitted as explicit warnings in EVERY scenario:

- `CROSS_SOURCE_CONSENSUS_NOT_ESTABLISHED` — one configured RPC source is an
  observation, NOT independent consensus;
- `INDEPENDENT_L1_DERIVATION_NOT_ESTABLISHED` — the full OP Stack derivation
  pipeline was not independently replayed locally;
- `LOCAL_ROLLUP_NODE_VERIFICATION_NOT_ESTABLISHED` — no local rollup node
  verified these observations; every conclusion rests on direct source
  observation only;
- `WITHDRAWAL_FINALIZATION_NOT_EVALUATED` — L2 block finality is not
  withdrawal finalization; that question was not evaluated at all.

## The `opstack.rpc-finalized-head-v1` ruleset

Positive support requires ALL of:

1. the subject network matches the explicitly configured network;
2. the generic EVM evidence binds the transaction to containing block `S/Hs`;
3. head ordering held: `F.number <= Safe.number <= Latest.number`, with
   equal-height heads carrying equal hashes;
4. an observed finalized head lies at or above the subject height AND a
   complete parentHash ancestry was WALKED from `F` down to height `S`
   within one bounded observation burst (`maxAncestryDepth`, ceiling 10,000),
   every link satisfying `parent.number == child.number - 1` and
   `parent.hash == child.parentHash`;
5. the walk's terminal block at height `S` has hash `Hs`;
6. the canonical exact-height re-read still returns hash `Hs` at height `S`;
7. the burst-closing stability re-read returns the SAME finalized head `F`.

Then finality is SUPPORTED under the basis `source_observation` with the
pinned ruleset recorded in dimension metadata (`ruleset`, `rulesetVersion`,
`family`). Ancestry is never extrapolated from block numbers alone, and a
required walk exceeding the configured depth bound fails closed to
`insufficient`.

Epistemic limit: the resolver independently INTERPRETS network observations;
it does NOT independently replay the derivation pipeline.

## Deterministic decision ladder (fail closed)

| Observation                                                       | Verdict        |
| ----------------------------------------------------------------- | -------------- |
| Generic evidence does not bind tx -> block                        | applicability `unknown` (never a verdict) |
| Subject/observation network != configured network                 | `insufficient` + warning |
| Heads internally inconsistent (`F > Safe`, `Safe > Latest`, equal-height divergence) | material conflict scoped to finality -> `ambiguous` |
| Canonical block at S missing/incoherent                           | material conflict -> `ambiguous` |
| Broken parentHash ancestry (height or hash link, missing ancestor)| material conflict -> `ambiguous` |
| Finalized head changed during the burst                           | material conflict -> `ambiguous` |
| Canonical hash at S != `Hs`                                       | `contradicted` (clean negative, never silent) |
| Missing `finalized` response                                      | `insufficient` (never substituted by safe/latest) |
| Required ancestry exceeds `maxAncestryDepth`                      | `insufficient` (fail closed; no walk performed) |
| `F < S <= Safe`                                                   | `insufficient` + `OP_SAFE_BUT_NOT_FINALIZED` (safe-but-not-final is NOT finality) |
| `Safe < S`                                                        | `insufficient` (not even within the safe head) |

Settlement is NEVER populated by this package. A finalized L2 block decides
nothing about any settlement claim — downstream adapters own that mapping.

## Offline replay

Same philosophy as the frozen generic resolver: raw source capture ->
replay -> normalized observation -> pure evaluation. Fixtures store
provenance (never endpoint URLs or credentials), the subject anchor, the
acquisition time, the maximum ancestry depth in force, and byte-exact raw
results; replay serves them through a strict in-memory responder keyed by
`(method, params)` with same-key captures consumed first-in-first-out (one
burst may re-read an exchange). Unmatched requests and unused captures fail
closed. Two replays of one fixture produce deep-equal observations and
deep-equal fragments. No generic replay framework was introduced anywhere.

## First live fixture (Base mainnet)

`test/fixtures/base-mainnet-finality.fixture.json` records ONE read-only
live acquisition (no transactions, no wallet, no signing) against the public
Base endpoint `https://mainnet.base.org` for a recorded Base-mainnet subject
`0xcf496bca417f033e3ce5ad167e82a5bf95b2d815e4493de2f4943d3058b85afb`
(containing block 49803836, `0x31e398e8…bdfef7e`): `eth_chainId`, the
`finalized`/`safe`/`latest` heads and the canonical exact-height lookup.

The honest outcome is recorded as captured evidence: at acquisition time the
source's observed finalized head lay **597,672 blocks** above the subject
height — far beyond the 10,000-block ancestry ceiling — so the ruleset
REFUSED the parentHash walk (fail closed) instead of inferring ancestry from
block numbers, and offline replay evaluates the fixture to `insufficient`
with `OP_ANCESTRY_DEPTH_EXCEEDED`. All other invariants (head ordering,
canonical stability, chain identity) passed and are preserved in the
fixture. The companion package-local EVM fixture is an exact copy of the
required acquisition fixture from the pinned private source snapshot; only
its public-staging filename/path is genericized.

## Public API

- `acquireOpStackFinalityObservation({source, subjectBlock, now, fetchFn, maxAncestryDepth?})`
- `evaluateOpStackFinality({config, evm, finality})`
- `replayOpStackFinalityObservation(fixtureValue, options?)`
- `buildOpStackFinalityFixture(observation)` / `validateOpStackFinalityFixture(value)`
- `validateOpStackFinalityConfig(config)`, `OPSTACK_FINALITY_RULESET`,
  `OPSTACK_FAMILY`, `OPSTACK_MAX_ANCESTRY_DEPTH`, profile constants,
  observation/check types, `FINALITY_PROPOSITION`

No high-level universal `resolveNetworkEvidence` API exists here.
