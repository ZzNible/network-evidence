# Release status

## Published source release — v1.2.0 (13 November 2026)

As verified on 13 November 2026, the public **source-only** GitHub Release was [Network Evidence Suite v1.2.0](https://github.com/ZzNible/network-evidence/releases/tag/v1.2.0), exact commit `272856c94514f1579c0f77f8a301a46f73049561`, source tree `f4e4da5e50ddbdb837428b6ce5c571b67a9991d6`. The release includes a deterministic source archive and an owner-authenticated SSH source statement; no npm package, hosted MCP/Maps service, wallet transaction or deployment is released. A moderate transitive Hono advisory was disclosed. Do not treat this source as a hardened Internet-facing MCP service.

**This file retains dated historical checkpoints below.** Any statements that v1.1.0 was the latest release, or that NE Suite v1 was not yet published, describe the *date of those checkpoints*, not today's publication status. A later security-patch worktree is a new **unpublished candidate**, not a modification of signed v1.2.0. See [Start here](docs/START_HERE.md) for a credential-free local test.

## Historical public v1.1.0 and pre-publication checkpoints (archived)

This file describes the **historical public v1.1.0 source release**,
the separate **unpublished NE Suite v1 source candidate** and earlier
independent MCP Cloud Run services. It is documentation only; it neither
performs nor authorizes any tag, GitHub Release, npm publication or deployment.
The historical inventory below does not describe a deployed NE Suite v1.

```text
LATEST_PUBLIC_RELEASE     = v1.1.0  (annotated tag; peeled commit de3ee11d08d22d2791d8b5acfe17c2e61df23e81; published 2026-10-08)
HISTORICAL_PUBLIC_RELEASE = v1.0.0  (annotated tag; peeled commit d3827f9b42084bf893e8d93faa0fb905fa339155; immutable)
RUNTIME_AUTHORITY         = ed5273b2e28cf7438dcdade0a2d48a08ffa7f9ef  (runtime/product authority; BEFORE + Discovery complete)
V1_1_0_TAG_OBJECT         = 62044f78851260d6af8bc5e8dffd6d8bace46d15
NPM_PUBLICATION           = NO  (every package manifest is "private": true)
V1_1_0_RELEASE_DEPLOYMENT = NONE  (source-only release, not later beta services)
TARGET_CORE_MUTATIONS     = 0
```

`v1.1.0` is the latest public source release: an annotated Git tag and GitHub
Release published on 2026-10-08. Its tag peels exactly to
`de3ee11d08d22d2791d8b5acfe17c2e61df23e81`. The release source commit is the
runtime authority above plus the independently reviewed documentation-only
release alignment; its source, tests, fixtures, package manifests and lockfile
are byte-identical to `ed5273b`.

`v1.0.0` remains an immutable historical release at
`d3827f9b42084bf893e8d93faa0fb905fa339155`. Earlier tags (`v0.1.0` –
`v0.4.0`) are also historical; `FREEZE_MANIFEST.md` records the `v0.1.0`
release and the provenance of the imported frozen package trees.

The v1.1 integrability target was published as `v1.1.0`. That **source-only
release** shipped neither an npm package nor a hosted executable. Separately
operated Cloud Run preview/beta services have historical observations in
`docs/distribution/MCP_BASE_SOLANA_PUBLIC_BETA_QUICKSTART.md`; their current
revisions and availability are not established by the historical source tag.

## NE Suite v1 — historical private documentation checkpoint (11 November 2026, Europe/Brussels)

At the 2026-11-11 Europe/Brussels private documentation checkpoint, a locally sanitized
six-tool integrated source candidate existed and had not been publicly released.
For any **subsequent** publication, consult
[GitHub Releases](https://github.com/ZzNible/network-evidence/releases);
this dated record is not a live release-status announcement. The separate
historical Cloud Run beta, MCP Registry entry and source tag are different
products/versions and are not upgraded by this candidate. Every final release
requires independently reproduced and authenticated exact-source evidence,
the owner's privacy/IP/disclosure approval, and a separate owner publication
GO for the exact final commit. The internal approval draft was
intentionally withheld from candidate history. **Never fast-forward private
development history to public Git.** See `docs/release/REPRODUCTION.md` for
qualification steps, not permission to publish.

## NE Suite v1 — real-action qualification (12 November 2026)

A real Base Sepolia EIP-3009 testnet action has now been assessed through
the existing local Core -> Hub -> Lens -> generic NE Maps pipeline.
The exact transaction, scope and limitations are recorded in
[the source behavior contract](docs/distribution/MCP_PUBLIC_CONTRACT.md).
Older offline BEFORE fixtures remain **simulated**. No current hosted MCP
or independent economic settlement/finality is demonstrated.

**At the 12 November checkpoint, this was an unpublished source-only candidate**; the exact source was subsequently published as v1.2.0 on 13 November 2026.
Any source commit change requires fresh integrity identifiers and
qualification. Publication, owner signing, tag, deployment and Registry
registration remain unapproved and are not performed by this document.

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

The historical `v1.1.0` source release is published. The separate
NE Suite v1 candidate is **not** published, tagged, registered or deployed
as a new public product. All workspace manifests remain `"private": true`.
Future source publication, npm packaging, cloud deployment and registry update
each require explicit, separately scoped owner authorization.
