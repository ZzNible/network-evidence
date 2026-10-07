# Release status

This file records the release/packaging state of this repository. It is
documentation only: it does not perform, and does not claim, any tag, GitHub
Release, npm publication or deployment beyond what is stated below.

```text
SIGNOFF_CANDIDATE        = current Git commit containing this file (resolve with `git rev-parse HEAD`)
CODE_BASE_COMMIT          = 64b412d01bd12c1a87c93699a4fbc9ee64e61967  (dependency-hardening anchor)
RECORDED_RELEASE_TAG      = v0.1.0  (see FREEZE_MANIFEST.md)
NEXT_PUBLIC_VERSION       = UNDECIDED
CANDIDATE_TAG_CREATED     = NO
CANDIDATE_GITHUB_RELEASE  = NO
NPM_PUBLICATION           = NO  (every package manifest is "private": true)
DEPLOYMENT                = NO
TARGET_CORE_MUTATIONS     = 0
```

Choosing the next version, creating a tag or GitHub Release, and publishing
to npm remain human decisions. Dependency hardening for the current sign-off
code base has been applied and independently gated; see the advisory record
below.

## Release documentation

- [docs/release/REPRODUCTION.md](docs/release/REPRODUCTION.md) — clean-machine
  reproduction steps and expected deterministic outputs.
- [docs/release/DEPENDENCY_ADVISORIES.md](docs/release/DEPENDENCY_ADVISORIES.md)
  — host-observed `npm audit` result and its classification.
- [SECURITY_BOUNDARIES.md](SECURITY_BOUNDARIES.md) — evidence boundaries and
  the public/private boundary.
- [FREEZE_MANIFEST.md](FREEZE_MANIFEST.md) — source provenance of the frozen
  package trees and the `v0.1.0` release record.

## Package and version inventory

Host-observed from the current sign-off tree. Workspace package versions were
not changed by the dependency hardening or this documentation-only correction.

| Package | Manifest | Version | `private` |
| --- | --- | --- | --- |
| `nec-monorepo` (workspace root) | `package.json` | none declared | `true` |
| `@nec/core` | `packages/core/package.json` | `0.1.0` | `true` |
| `@nec/resolver-evm` | `packages/resolver-evm/package.json` | `0.1.0` | `true` |
| `@nec/adapter-x402` | `packages/adapter-x402/package.json` | `0.1.0` | `true` |
| `@nec/resolver-opstack` | `packages/resolver-opstack/package.json` | `0.1.0` | `true` |
| `@nec/adapter-erc4337` | `packages/adapter-erc4337/package.json` | `0.1.0` | `true` |
| `@nec/resolver-solana` | `packages/resolver-solana/package.json` | `0.1.0` | `true` |
| `@nec/adapter-x402-svm` | `packages/adapter-x402-svm/package.json` | `0.1.0` | `true` |
| `@nec/resolver-zksys` | `packages/resolver-zksys/package.json` | `0.1.0` | `true` |

Package manifest versions are workspace metadata. They are not npm
publications and do not by themselves name a public release. A package
reporting `0.1.0` here is not asserted to be byte-identical to its content at
the `v0.1.0` tag; `FREEZE_MANIFEST.md` records the package-tree provenance.

Third-party runtime dependencies declared by the packages (resolved versions
from `package-lock.json`, lockfile version 3):

| Dependency | Declared by | Range | Locked |
| --- | --- | --- | --- |
| `viem` | `@nec/resolver-evm` | `^2.21.0` | `2.55.19` |
| `@noble/curves` | `@nec/adapter-x402-svm` | `1.9.1` | `1.9.1` |

`@nec/core` has no runtime dependencies. All other `@nec/*` dependencies are
workspace-internal.

Root development dependencies (test/typecheck/demo toolchain only):

| Dependency | Range | Locked |
| --- | --- | --- |
| `vite` | `^6.4.3` | `6.4.3` |
| `vitest` | `^4.1.11` | `4.1.11` |
| `typescript` | `^5.5.0` | `5.9.3` |
| `tsx` | `^4.23.0` | `4.23.12` |
| `@types/node` | `^20.14.0` | `20.19.43` |

## Release artifacts

The release artifact of this repository is the **Git source tree** at the
recorded commit. There is no npm tarball, container image, hosted site or
binary.

Explicit artifacts contained in the source tree:

| Artifact | Path | Integrity reference |
| --- | --- | --- |
| Workspace packages (TypeScript source, consumed via workspace `exports`) | `packages/*/` | Frozen package trees in `FREEZE_MANIFEST.md` |
| Locked dependency graph | `package-lock.json` | Lockfile `integrity` fields |
| Core -> Hub -> Lens demo | `examples/core-hub-lens/` | `EXPORT_SHA256SUMS.txt`; CLI output SHA-256 in `EXPECTED_OUTPUT.sha256` |
| Core -> Hub -> Lens public replay fixture | `packages/adapter-erc4337/test/fixtures/base-sepolia-external-v06-userop.json` | SHA-256 `37f7da5719220a16a2841a08360eff4738aab9bbc4873dcbf79307847f4131a3` |
| NE Maps atlas (static, local only) | `examples/ne-maps/` | `data/CASES.sha256` |
| License | `LICENSE` | Apache-2.0 |

Expected digests used for reproduction are listed in
[docs/release/REPRODUCTION.md](docs/release/REPRODUCTION.md).

## Open items requiring a human decision

1. Next public version and whether to tag/release the sign-off candidate.

The dependency-advisory remediation is complete for the current sign-off code
base; the observed release-gate audit result is recorded in
[docs/release/DEPENDENCY_ADVISORIES.md](docs/release/DEPENDENCY_ADVISORIES.md).
