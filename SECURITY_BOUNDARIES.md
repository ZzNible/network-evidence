# Security boundaries

NEC preserves evidence boundaries:

- network observation != protocol claim
- execution != observed effect
- observed effect != settlement
- settlement != finality
- OP Stack L2 block finality != withdrawal finalization
- single-source RPC finalized view != independent consensus verification
- `source_observation` != `cryptographic_verification`

NEC does not decide trust, reputation, commercial success, work quality,
refund or release authority, liability, or economic policy. It has no wallet,
signing, or transaction-submission function.

## Public/private boundary

The public distribution is this repository's own fresh Git history and source
tree. Everything needed to install, type-check, test and run the examples is
in that tree plus the npm registry packages pinned by `package-lock.json`.

Not part of the public distribution:

- Private Git history, branches, refs and tag objects of
  `ZzNible/network-evidence-core`. Commit, tree and tag identifiers from that
  repository in `FREEZE_MANIFEST.md`, package READMEs and example
  `PROVENANCE.md` files are provenance text only.
- Source history of `ZzNible/agent-evidence-hub`. The demo and Maps examples
  contain curated exported files only; the referenced commits are provenance
  text and are not required to run anything.
- `reference/` (excluded by `.gitignore`).
- Design documents cited by `packages/core/README.md` — `docs/adr/`,
  `reference/context/` and `NEC_CONTRACTS_v0.1.md` — are not included in
  this repository. In the public tree, the package READMEs, source and tests
  are the available description of the contract.

Reproduction requires no secret, credential, RPC endpoint, wallet or signing
key. The Core -> Hub -> Lens demo reads only local, checksum-pinned files, and
the NE Maps server serves static local files on `127.0.0.1` only. Committed
replay fixtures contain no RPC endpoint URLs; a source locator that points
into the private repository (for example in the zkSYS fixture helper) is
provenance text and is never fetched. See each package README for its fixture
rules.

No `@nec/*` package is published to npm: every package manifest keeps
`"private": true`. Release and publication state is recorded in
[RELEASE.md](RELEASE.md); development-toolchain advisories are recorded in
[docs/release/DEPENDENCY_ADVISORIES.md](docs/release/DEPENDENCY_ADVISORIES.md).
