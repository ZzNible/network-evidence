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
`@nec/resolver-solana`, and `@nec/adapter-x402-svm`. The Solana resolver is
generic post-fact Solana network evidence; the x402 SVM adapter is x402 v2
exact-SVM interpretation above that generic Solana evidence. The ERC-4337
package is a narrow evidence-correlation adapter above generic EVM evidence.
Package manifests retain `private: true` to prevent accidental npm publication.

This repository intentionally has fresh history. Its selected package content
comes from frozen source snapshots, but private Git history is not imported.
It is licensed under [Apache-2.0](LICENSE).
