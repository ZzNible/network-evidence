# Freeze manifest

```text
LICENSE_GATE = OPEN
PUBLICATION_READY = NO
PUBLICATION_EXECUTED = NO
```

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
