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

This first source capsule contains only `@nec/core`, `@nec/resolver-evm`,
`@nec/adapter-x402`, and `@nec/resolver-opstack`. Package manifests retain
`private: true` to prevent accidental npm publication.

This repository intentionally has fresh history. Its selected package content
comes from frozen source snapshots, but private Git history is not imported.
It is licensed under [Apache-2.0](LICENSE).
