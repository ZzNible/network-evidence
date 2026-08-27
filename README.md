# Network Evidence Core (NEC)

NEC asks what an underlying network independently supports about an exact
action. It is evidence infrastructure: it observes, normalizes, replays, and
evaluates evidence. It is not a wallet, signer, transaction-submission tool,
or authority for an action.

NEC reports explicit verdicts: `supported`, `contradicted`, `insufficient`,
or `ambiguous`. Every conclusion records its evidence basis. Execution,
observed effect, settlement, and finality are separate questions; support for
one is not support for another.

This first capsule contains only `@nec/core`, `@nec/resolver-evm`,
`@nec/adapter-x402`, and `@nec/resolver-opstack`. Package manifests retain
`private: true` to prevent accidental npm publication.

This repository intentionally has fresh history. Its selected package content
comes from frozen private source snapshots, but private Git history is not
imported. The source license has not yet been selected, so this private
staging tree is not publication-ready.

```text
LICENSE_GATE = OPEN
PUBLICATION_READY = NO
PUBLICATION_EXECUTED = NO
```
