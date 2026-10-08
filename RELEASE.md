# Release status

This file records the release/packaging state of this repository. It is
documentation only: it does not perform, and does not claim, any tag, GitHub
Release, npm publication or deployment beyond what is stated below.

```text
HISTORICAL_PUBLIC_RELEASE = v1.0.0  (annotated tag; peeled commit d3827f9b42084bf893e8d93faa0fb905fa339155; immutable)
RUNTIME_AUTHORITY         = ed5273b2e28cf7438dcdade0a2d48a08ffa7f9ef  (runtime/product candidate; BEFORE + Discovery complete)
SIGNOFF_CANDIDATE         = current Git commit containing this file (resolve with `git rev-parse HEAD`)
NEXT_PUBLIC_VERSION       = UNDECIDED
V1_1_0_TAG                = NONE
V1_1_0_GITHUB_RELEASE     = NONE
NPM_PUBLICATION           = NO  (every package manifest is "private": true)
DEPLOYMENT                = NO
TARGET_CORE_MUTATIONS     = 0
```

`v1.0.0` is the latest public release: an annotated Git tag and GitHub Release
of the source tree, published on 2026-10-07. It is not moved, retagged or
rewritten. Earlier tags (`v0.1.0` – `v0.4.0`) are also historical;
`FREEZE_MANIFEST.md` records the `v0.1.0` release and the provenance of the
imported frozen package trees.

The signoff candidate is the runtime authority above plus documentation-only
release alignment. Its source, tests, fixtures, package manifests and lockfile
are byte-identical to `ed5273b`. A Git commit cannot contain its own SHA, so
record the candidate with `git rev-parse HEAD` and compare it with the
promoted SHA in the canonical project STATUS.

The repository's v1.1 integrability target
([docs/INTEGRABILITY_V1_1.md](docs/INTEGRABILITY_V1_1.md)) is a project target
name, not a chosen version. No `v1.1.0` tag or GitHub Release exists. Choosing
the next version, creating a tag or GitHub Release, publishing to npm and
deploying remain human decisions.

## Release documentation

- [docs/release/REPRODUCTION.md](docs/release/REPRODUCTION.md) — clean-machine
  reproduction steps and expected deterministic outputs.
- [docs/release/DEPENDENCY_ADVISORIES.md](docs/release/DEPENDENCY_ADVISORIES.md)
  — host-observed `npm audit` results and their classification.
- [docs/INTEGRABILITY_V1_1.md](docs/INTEGRABILITY_V1_1.md) — Hub/Lens/Maps
  contracts, BEFORE + Discovery completion summary and Definition of Done.
- [SECURITY_BOUNDARIES.md](SECURITY_BOUNDARIES.md) — evidence boundaries and
  the public/private boundary.
- [FREEZE_MANIFEST.md](FREEZE_MANIFEST.md) — source provenance of the frozen
  package trees and the `v0.1.0` release record.

## Package and version inventory

Host-observed from `packages/*/package.json` at the runtime authority. The
tree column is `git rev-parse ed5273b:<path>`; the last column compares it
with the same path at `v1.0.0`.

| Package | Manifest | Version | `private` | Tree at `ed5273b` | vs `v1.0.0` |
| --- | --- | --- | --- | --- | --- |
| `nec-monorepo` (workspace root) | `package.json` | none declared | `true` | — | scripts added |
| `@nec/core` | `packages/core/package.json` | `0.1.0` | `true` | `b8ed923c9f43d17365f224e3f03f3df3135c5e87` | identical |
| `@nec/resolver-evm` | `packages/resolver-evm/package.json` | `0.1.0` | `true` | `52ab4f567c0be829bf078e7ad34975a7b7d874ab` | identical |
| `@nec/adapter-x402` | `packages/adapter-x402/package.json` | `0.1.0` | `true` | `1564b2858621dbefdbb1862c1b398a827bb7d45f` | identical |
| `@nec/resolver-opstack` | `packages/resolver-opstack/package.json` | `0.1.0` | `true` | `98df0a31ba509e5b18ea5fac9d70c9ad0bf6015d` | changed (Base BEFORE) |
| `@nec/adapter-erc4337` | `packages/adapter-erc4337/package.json` | `0.1.0` | `true` | `e3e4bae3bbd0db734efa8af54bfe273ec28f471b` | identical |
| `@nec/resolver-solana` | `packages/resolver-solana/package.json` | `0.1.0` | `true` | `a79ea5429145c83a7210f0018af6ff76d8c65afa` | changed (Solana BEFORE) |
| `@nec/adapter-x402-svm` | `packages/adapter-x402-svm/package.json` | `0.1.0` | `true` | `784b7bb28af7c0a0b6aca68d4b20d2a39e899a99` | identical |
| `@nec/resolver-zksys` | `packages/resolver-zksys/package.json` | `0.1.0` | `true` | `63bda66bd957cc15ffc1ea228f2614c6031d0fee` | identical |
| `@nec/hub` | `packages/hub/package.json` | `0.1.0` | `true` | `e2ac42f0e2b839483fc18c4ceef36ae5e33e6c86` | new |
| `@nec/lens` | `packages/lens/package.json` | `0.1.0` | `true` | `b38a30c15666f4012fe6efac23b5b0d13aebcf0c` | new |
| `@nec/discovery` | `packages/discovery/package.json` | `0.1.0` | `true` | `00304e4d450ccbd98c9f31f3f5b74bd576453f28` | new |

Package manifest versions are workspace metadata. They are not npm
publications and do not by themselves name a public release; the public
release identity is the Git tag. A package reporting `0.1.0` here is not
asserted to be byte-identical to its content at the `v0.1.0` tag;
`FREEZE_MANIFEST.md` records the package-tree provenance of imported trees.

Third-party runtime dependencies declared by the packages (resolved versions
from `package-lock.json`, lockfile version 3):

| Dependency | Declared by | Range | Locked |
| --- | --- | --- | --- |
| `viem` | `@nec/resolver-evm` | `^2.21.0` | `2.55.19` |
| `@noble/curves` | `@nec/adapter-x402-svm` | `1.9.1` | `1.9.1` |

`@nec/core` has no runtime dependencies. `@nec/hub`, `@nec/lens` and
`@nec/discovery` depend only on workspace-internal `@nec/*` packages, as do
all other `@nec/*` dependencies. Since `v1.0.0` the lockfile only adds the
three new workspace package links; the third-party graph is unchanged.

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
| Workspace packages (TypeScript source, consumed via workspace `exports`) | `packages/*/` | Git tree SHAs above; imported frozen trees in `FREEZE_MANIFEST.md` |
| Locked dependency graph | `package-lock.json` | Lockfile `integrity` fields |
| Core -> Hub -> Lens F2 demo (frozen `v1.0.0` export) | `examples/core-hub-lens/` | `EXPORT_SHA256SUMS.txt`; CLI output SHA-256 in `EXPECTED_OUTPUT.sha256` |
| F2 public replay fixture | `packages/adapter-erc4337/test/fixtures/base-sepolia-external-v06-userop.json` | SHA-256 `37f7da5719220a16a2841a08360eff4738aab9bbc4873dcbf79307847f4131a3` |
| Synthetic/local integrability proof | `examples/integrability-fixture/` | `data/SHA256SUMS`; checked by `npm run demo:integrability` |
| F1/F2/F3 historical compatibility | `examples/historical-compat/` | `AUTHORITY_SHA256SUMS`; `data/SHA256SUMS`; checked by `npm run demo:historical-compat` |
| NE Maps atlas (static, local only) | `examples/ne-maps/` | `data/CASES.sha256` (frozen legacy export); `data/COLLECTION.sha256` (4-case collection, checked by `npm run maps:collection`) |
| Discovery demo (deterministic, offline) | `examples/discovery/` | CLI stdout SHA-256 in `EXPECTED_STDOUT.sha256` |
| License | `LICENSE` | Apache-2.0 |

Expected digests used for reproduction are listed in
[docs/release/REPRODUCTION.md](docs/release/REPRODUCTION.md).

## Open items

Release-process only; no semantic implementation work is pending.

1. Independent review of the documentation-only release-alignment commit.
2. Human decision on the next public version and whether to tag and create a
   GitHub Release for the signoff candidate. Any npm publication or deployment
   is a separate human decision; none is prepared and all manifests remain
   `"private": true`.
