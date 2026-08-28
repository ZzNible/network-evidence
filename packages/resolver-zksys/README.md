# `@nec/resolver-zksys`

Read-only zkSYS Tanenbaum BEFORE profile over `@nec/resolver-evm`.

## Scope

The v0.1 profile is limited to `eip155:57057` / chain ID `57057`. It verifies
archived native EVM request/response bytes, then uses generic EVM evaluation
for:

- `execution`
- `observedEffects`
- `dataBinding`

It adds exactly one zkSYS-specific capability:

> At the recorded observation time, an archived identity-checked zkSYS RPC
> source returned batch `3819` with reported range `5353..5353` for a request
> for block height `5353`.

The batch response binds the requested height, provider-reported batch and
provider-reported range. It contains no block hash. The archived EVM block
observation independently records height `5353` and its hash; the resolver
does not merge those observations into batch membership for that hash.

This establishes no Gateway settlement, data availability, PoDA availability,
proof verification, Syscoin inclusion, or finality. `simulation`,
`executionModel`, `accountModel`, and `gasModel` remain absent.

Manifest membership expresses resolver support, not availability. Every
supported volatile capability (`execution`, `observedEffects`, `dataBinding`,
and `batching`) has current availability `unknown`, even when archived bytes
show the path was usable or unusable at capture time. This pure-replay v0.1
profile has no `current_probe` mode, TTL, clock heuristic, or network I/O.
Snapshot time is checked against the latest `retrievedAt` of the archived EVM
EvidenceRefs, preventing a caller from relabeling the archive merely by
changing `observedAt`.

Every positive historical path requires a concrete, network-bound
`EvidenceRef` with a locator, response digest, and digest-bound native-source
envelope containing the exact RPC request and response. A bounded strict
parser rejects duplicate JSON members, unsafe numeric IDs, malformed or
unexpected envelopes, request/response ID mismatch, wrong methods and shapes,
null/error results, and incoherent EVM transaction/receipt/block bindings.
Only EVM evidence carries the independently sourced block hash. Batching
evidence carries the requested height, never a block hash.

## Pure API

```ts
const foundation = deriveZksysBeforeFoundation({
  networkId: "eip155:57057",
  evmObservation,
  batchingObservation,
});

const match = composeDiscoveryMatch(requirements, foundation.candidate);
const preflight = deriveZksysBeforePreflightResult(foundation, request);
```

The package performs no network, clock, wallet, balance, signing, funding,
paymaster, or transaction-submission operation. Preflight remains strictly
evidence readiness under the supplied evidence policy. `batching` is a
discovery capability, not a core preflight policy dimension.

The profile guarantees above apply to artifacts returned by
`deriveZksysBeforeFoundation(...)`. Generic core builders validate structure,
manifest and context; they do not attest which producer constructed an
artifact. v0.1 intentionally adds no signature scheme, producer registry, or
core field for that general trust boundary.

## Real fixture provenance

Tests replay the zkSYS portion of the real A3 batch-3819 capture:

- source repository: `ZzNible/network-evidence-core`
- source pack: `fixtures/a3-live-v31-3819`
- packaging commit: `09ffea96ae0ab540fa59d96620370191ecbe6eb5`
- original workspace commit pinned by the pack: `67559fe010642fee1a1ab3b4897c8ff234ed0362`
- capture time: `2026-08-25T13:14:24Z` to `2026-08-25T13:14:25Z`
- observed client: `zksync-os/v0.22.0`
- transaction: `0xf107268ee5f9177dbd23c2e6b040f0ea9b7c7323f1f385ee3ea43bb03b9e6b8d`
- block: `5353`
- observed batch: `3819`

The bounded fixture stores byte-exact archived RPC request/response files for
chain identity, client version, transaction, receipt, full block-by-hash, and
the block-height-to-batch lookup. Their source-pack SHA-256 values are checked
during replay. The normalized projection remains only a local cross-check;
raw request/response bytes are the derivation authority.

The resulting snapshot records capture-time outcomes and valid provenance
while projecting every supported volatile capability to current availability
`unknown`. Consequently historical preflight is never `ready`.
