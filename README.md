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
`@nec/resolver-solana`, `@nec/adapter-x402-svm`, and `@nec/resolver-zksys`.
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

`examples/ne-maps/` presents the three stable Suite v1 cases as a small generic/multichain evidence atlas. It consumes pinned browser-safe Lens projections; it does not resolve network evidence or add a graph engine, policy layer or stronger claim. Each case exposes Lens, Trail and exact-action handoffs while preserving `supported`, `contradicted`, `insufficient`, `ambiguous` and `unavailable` states when present.

~~~sh
npm run maps:serve
~~~

Then open `http://127.0.0.1:4177/`. `TARGET_CORE_MUTATIONS = 0`.

## Release and reproducibility

- [RELEASE.md](RELEASE.md) — release status, package/version inventory and
  release artifacts. The next public version is undecided; no package is
  published to npm.
- [docs/release/REPRODUCTION.md](docs/release/REPRODUCTION.md) — clean-machine
  reproduction with expected digests.
- [docs/release/DEPENDENCY_ADVISORIES.md](docs/release/DEPENDENCY_ADVISORIES.md)
  — open `npm audit` advisories in the development/test toolchain.
- [SECURITY_BOUNDARIES.md](SECURITY_BOUNDARIES.md) — evidence boundaries and
  the public/private boundary.
