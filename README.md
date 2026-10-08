# Network Evidence

Independent network evidence for exact networks, capabilities and actions.

Network Evidence provides deterministic evidence infrastructure for two
related questions:

- Discovery: what can an exact network or deployment support, and what is
  currently observable or usable with evidence?
- Resolution: what does the underlying network itself independently support
  about this exact action?

Discovery support is distinct from current availability. Manifest membership
is not proof of current support or availability, and an unknown required
capability is not eligible.

Network Evidence observes, normalizes, replays, and evaluates evidence. It is
not a wallet, signer, transaction-submission tool, or authority for an action.
It reports explicit verdicts: `supported`, `contradicted`, `insufficient`, or
`ambiguous`. Every conclusion records its evidence basis. Execution, observed
effect, settlement, and finality are separate questions; support for one is
not support for another.

This source capsule contains `@nec/core`, `@nec/resolver-evm`,
`@nec/adapter-x402`, `@nec/resolver-opstack`, `@nec/adapter-erc4337`,
`@nec/resolver-solana`, `@nec/adapter-x402-svm`, `@nec/resolver-zksys`,
`@nec/hub`, `@nec/lens`, and `@nec/discovery`.
The Solana resolver is generic post-fact Solana network evidence; the x402 SVM
adapter is x402 v2 exact-SVM interpretation above that generic Solana evidence.
The ERC-4337 package is a narrow evidence-correlation adapter above generic EVM
evidence.

The zkSYS resolver is a thin zkSYS Tanenbaum BEFORE profile for pure historical
replay v0.1. Support does not imply current availability; archived replay gives
current availability `unknown`. It adds only a narrow provider-reported block
height-to-batch/range capability. It does not establish block-hash-to-batch
membership, Gateway settlement, data or PoDA availability, proof verification,
Syscoin inclusion, or finality. It is not wallet, signing, funding, paymaster,
or submission infrastructure. Package manifests retain `private: true` to
prevent accidental npm publication.

Base BEFORE parity uses the generic EVM BEFORE foundation plus a minimal OP
Stack overlay in `@nec/resolver-opstack`. There are two explicit profiles:
Base mainnet `eip155:8453` (labelled mainnet) and Base Sepolia `eip155:84532`
(labelled testnet). The labels are presentation only and are never evidence.
The overlay adds one capability, OP Stack L2 block `finality`, whose
availability comes only from probe observations. It never claims settlement
and never infers withdrawal or output-root finalization. Replaying the pinned
archived fixtures gives current availability `unknown`. See
[`packages/resolver-opstack/README.md`](packages/resolver-opstack/README.md#before-overlay-base-mainnet--base-sepolia).

Solana BEFORE support lives in `@nec/resolver-solana`. There are two explicit
genesis-bound profiles: Solana mainnet `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`
(labelled mainnet) and Solana devnet `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`
(labelled testnet). Each pins the full `getGenesisHash` result, and the labels
are presentation only. The manifest claims `execution`, `observedEffects`,
`dataBinding` and `finality`, never `settlement`. Availability comes only from
probe observations of the post-action read path. A Solana `finalized`
commitment is a source observation. It never establishes settlement or
economic irreversibility. Replaying the pinned archived mainnet and devnet
fixtures gives current availability `unknown`. See
[`packages/resolver-solana/README.md`](packages/resolver-solana/README.md#before-foundation-solana-mainnet--devnet).

`@nec/discovery` is a thin public Discovery orchestrator above Core. A caller
supplies requirements and explicit candidates (presentation id, explicit
`mainnet`/`testnet` label, and an already-derived network, manifest and
snapshot). It can filter by exact candidate id and by environment. Core
`composeDiscoveryMatch` classifies each candidate, and Core builds and verifies
the deterministic `DiscoverNetworksResult`. Environment selects scope only and
never changes a classification. There is no network I/O, ranking, scoring or
network choice. See [`packages/discovery/README.md`](packages/discovery/README.md).
A deterministic, offline integration demo runs with
`npm run -s demo:discovery`. It covers Base and Solana, mainnet and testnet,
an external caller choice, and an evidence preflight for the chosen
candidate. See [`examples/discovery/README.md`](examples/discovery/README.md).

This repository intentionally has fresh history. Its selected package content
comes from frozen source snapshots, but private Git history is not imported.
It is licensed under [Apache-2.0](LICENSE).

## Reproducible Core -> Hub -> Lens demo

A zero-secret public integration path is included for the reviewed Base Sepolia
ERC-4337 v0.6 case.

Requires Node.js 20.12 or newer.

~~~sh
git clone https://github.com/ZzNible/network-evidence.git
cd network-evidence
npm ci
npm run -s demo:core-hub-lens
~~~

The command replays a checksum-pinned public fixture through
@nec/resolver-evm, evaluates the exact UserOperation through
@nec/adapter-erc4337, equality-checks that fresh runtime result against the
reviewed exact-fixture F2 Hub projection, then emits the existing browser-safe
Lens case.

The demo is exact-fixture and deterministic. It does not add wallet/signing/
submission, bundler attribution, settlement, finality, confidence scoring or
policy authority. See examples/core-hub-lens/README.md and
examples/core-hub-lens/PROVENANCE.md.

## Minimal NE Maps atlas

`examples/ne-maps/` presents a versioned `ne-maps-case-collection/v0.1` — the three stable Suite v1 cases plus the clearly labelled synthetic/local integrability case — as a small generic/multichain evidence atlas. It validates the collection fail-closed and consumes pinned browser-safe Lens projections; it does not resolve network evidence or add a graph engine, policy layer or stronger claim. Each case exposes Lens, Trail and exact-action handoffs while preserving `supported`, `contradicted`, `insufficient`, `ambiguous` and `unavailable` states when present.

~~~sh
npm run maps:serve
~~~

Then open `http://127.0.0.1:4177/`. `TARGET_CORE_MUTATIONS = 0`.

## Release and reproducibility

- [RELEASE.md](RELEASE.md) — release status, package/version inventory and
  release artifacts. `v1.1.0` is the latest public source release, published
  on 2026-10-08 from `de3ee11d08d22d2791d8b5acfe17c2e61df23e81`; no
  package is published to npm and no hosted deployment is part of the release.
- [docs/release/REPRODUCTION.md](docs/release/REPRODUCTION.md) — clean-machine
  reproduction with expected test counts and output digests.
- [docs/INTEGRABILITY_V1_1.md](docs/INTEGRABILITY_V1_1.md) — Hub/Lens/Maps
  contracts and the BEFORE + Discovery completion summary.
- [docs/release/DEPENDENCY_ADVISORIES.md](docs/release/DEPENDENCY_ADVISORIES.md)
  — release-gate dependency status and remediation record (`npm audit`: 0 vulnerabilities observed on 2026-10-07 and 2026-10-08).
- [SECURITY_BOUNDARIES.md](SECURITY_BOUNDARIES.md) — evidence boundaries and
  the public/private boundary.
