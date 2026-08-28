# Freeze manifest

```text
LICENSE = Apache-2.0
LICENSE_GATE = MET
PUBLIC_RELEASE_TAG = v0.1.0
PUBLIC_RELEASE_COMMIT = ab30a5d3e00dc80a7da2785fdffc667b0ffd35f8
PUBLICATION_EXECUTED = YES
```

`v0.1.0` intentionally remains pinned to the verified release commit above. The
tagged manifest captured the final pre-push staging state and therefore still
contains the historical line `PUBLICATION_EXECUTED = NO`; this main-branch
documentation cleanup does not move or rewrite that release tag.

## SOURCE_PROVENANCE

```text
source snapshot:       9cd650d7f7491e59f02c31f6185e8ca61392a88e
core source tree:      b8ed923c9f43d17365f224e3f03f3df3135c5e87
resolver-evm source tree:
                       52ab4f567c0be829bf078e7ad34975a7b7d874ab
adapter-x402 source tree:
                       1564b2858621dbefdbb1862c1b398a827bb7d45f
resolver-opstack source tree:
                       18e7f7e1f72568ba86e32ef60e8552e1ba3e27d8
```

## PUBLIC_STAGING_PATCH

- Root `package.json`: removed the excluded-example demo script.
- `resolver-opstack`: vendored the exact EVM replay fixture package-locally
  from the pinned private source snapshot; only its public-staging
  filename/path is genericized.
- `resolver-opstack`: genericized fixture filenames, test comments, and the
  README fixture wording.
- No resolver semantic or API change.

## STAGING TREE SHAs

Recorded after staging content is finalized:

```text
core:                 b8ed923c9f43d17365f224e3f03f3df3135c5e87
resolver-evm:         52ab4f567c0be829bf078e7ad34975a7b7d874ab
adapter-x402:         1564b2858621dbefdbb1862c1b398a827bb7d45f
resolver-opstack:     99f2c74bce1005605216c81af4ecac9f2baf3635 (intentionally diverges from source tree)
root package.json:    b8cc5610e6d266ab97e84047de8ad3f563cdbbb9 (intentionally diverges from source blob)
```

The patched `resolver-opstack` staging tree is not byte-identical to its
source tree.

## ERC4337_ADAPTER_V0_2_SOURCE_PROVENANCE

```text
source repository:        ZzNible/network-evidence-core
source commit:            c12ea56d4a482fd9bafabb119b747edc1f0209e5
source/public package tree:
                           329f9999f838ee5b8ccd69d002ceb60fe878f432
tree byte-identical:      YES
```

The ERC-4337 adapter's private semantic provenance is distinct from public
Git history. Its reviewed package tree is copied into this public repository
without importing private commits, refs, tags, or ancestry.

## SOLANA_AND_X402_SVM_V0_3_SOURCE_PROVENANCE

```text
private source repository:             ZzNible/network-evidence-core
source commit:                         173283288789f129470c09f1d5b9aa7814eed01c
private provenance labels:             solana-v0.1-freeze, x402-svm-v0.1-freeze
resolver-solana source/public tree:    d0e4d72e1a8fce838e3cbee2cb3234a5df77c818
adapter-x402-svm source/public tree:   784b7bb28af7c0a0b6aca68d4b20d2a39e899a99
resolver-solana byte-identical:        YES
adapter-x402-svm byte-identical:       YES
```

The private semantic provenance labels are not public Git history. The public
release contains only fresh public commit and tag objects; no private commits,
refs, or tag objects were imported or reused.

## ZKSYS_BEFORE_V0_1_SOURCE_PROVENANCE

```text
private source repository:                  ZzNible/network-evidence-core
private frozen commit:                      98fd081cdbd6d299bbed99f2037a2750e04f3608
private freeze tag name (provenance only):  zksys-before-v0.1-freeze
private freeze tag object SHA:              96eb2980a1e03b8008fffc6fd7067d3d60fa73f0
private freeze peeled target:               98fd081cdbd6d299bbed99f2037a2750e04f3608
resolver-zksys private tree:                63bda66bd957cc15ffc1ea228f2614c6031d0fee
resolver-zksys candidate public tree:       63bda66bd957cc15ffc1ea228f2614c6031d0fee
resolver-zksys byte-identical:              YES
review gates summary:                       PASS
  npm ci, typecheck, full and targeted tests, zero-network replay
  privacy, provenance, frozen-tree identity and bounded-delta gates
```

The private freeze name and object identifiers above are textual provenance
only. This public candidate imports the frozen package tree, not private commit
ancestry, refs, branches, or the private tag object. The next public release
version remains undecided.
