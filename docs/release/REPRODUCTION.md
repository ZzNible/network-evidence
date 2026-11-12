# Clean-machine reproduction

This document distinguishes the **historical public v1.1.0 source release**
from the **newer, local NE Suite v1 publication candidate**. A successful
reproduction does not sign, fund, submit transactions, acquire live RPC, or
establish an independently cryptographically anchored BEFORE, settlement or
finality. At the 2026-11-11 private documentation checkpoint, owner
records identified no new public NE Suite v1 source release or promoted
service for this candidate. The Cloud Run control plane was not inspected;
anonymous health checks of the older public endpoints on 2026-11-10 UTC
returned HTTP 503 from the owner Ubuntu host. Registry listing state was not
re-verified; check
[GitHub Releases](https://github.com/ZzNible/network-evidence/releases)
for subsequent publication state. An archived checkpoint is not a live
release-status authority.

## NE Suite v1 — documentation checkpoint (11 November 2026, Europe/Brussels)

At this checkpoint the latest public source tag was `v1.1.0`. This
newer candidate had no new public tag or hosted release identified in the
owner's checkpoint records; live cloud control-plane state was not inspected
(anonymous checks of the older endpoints returned 503) and Registry listing
state was not re-verified. When a newer release is published, obtain its exact manifest
and source archive from the [GitHub Releases page](https://github.com/ZzNible/network-evidence/releases).
**Co-location does not authenticate:** a manifest attached to the same
release is not independent proof of its publisher or integrity. Authenticate
the exact publisher identity, source commit and source archive through
an owner-authenticated channel outside this repository, GitHub Releases
and the manifest itself. Obtain the owner signing-key fingerprint out of
band, then verify the release statement signature locally against that key.
That authenticated statement must explicitly bind the final source commit,
Git tree, archive SHA-256 and lock SHA-256. If the independent owner-key
authentication or signed statement is unavailable, or the statement omits
any required digest, STOP: treat the release as unauthenticated.
Only values bound by the authenticated statement are authenticated.
Other manifest fields (including CI or hosting results) are not authenticated
unless the statement also binds the full manifest SHA-256. A signed tag
without archive/lock digests does not authenticate those files. A new source
tag does not attest an old beta's executable or availability.
No SHA in this document self-certifies the eventual release: verify the
**exact final source commit, Git tree, archive SHA-256 and lock SHA-256**
against the independently authenticated owner-signed release statement
specified above. A co-located release manifest is not an authentication root.

A local development preview was qualified on 2026-11-08, but its observations do
**not** automatically qualify later documentation edits, other architectures
or an external service revision.

Prerequisites: Node.js 22, npm with lockfile-v3 support, Python 3, Git, Bash, `tar`,
`sha256sum` and a disposable environment. Only npm-registry access is
needed for installation/audit. Before publication, obtain the archive
privately from the authorized owner. After publication, use the archive
and exact-SHA manifest from that specific GitHub Release, **only after**
validating the expected digest and publisher via an independently authenticated
source. A release attachment alone is not such authentication.
Do not assume that a platform-generated ZIP has the same bytes as the
authenticated flat source tar. Neither the example values below nor
an unauthenticated archive validate themselves.
Use a clean checkout/work directory without wallet keys, RPC credentials
or personal data. Execute the following code block **as one Bash script**
in a disposable process (not by individually pasting commands). It stops on
the first failure, before extraction or npm lifecycle scripts proceed.

```sh
# Run this entire block as ONE disposable Bash script; never line-by-line.
# Abort on the first failed integrity or extraction check.
set -Eeuo pipefail
# Refuse ambient tar/working-tree overrides when extracting an approved archive.
unset TAR_OPTIONS CDPATH GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR
# Obtain the FOUR values below from an independently authenticated manifest.
# Neither the archive itself nor this illustrative runbook is a trust anchor.
SOURCE_ARCHIVE=/absolute/path/to/approved-source.tar
EXPECTED_ARCHIVE_SHA256=/digest/from/authenticated/manifest
EXPECTED_GIT_TREE=/git-tree-hex/from/authenticated/manifest
EXPECTED_LOCK_SHA256=/lock-sha256/from/authenticated/manifest
case "$SOURCE_ARCHIVE" in /*) : ;; *) echo "absolute archive path required" >&2; exit 64 ;; esac
umask 077
mkdir ne-v1-verify
cd ./ne-v1-verify
printf '%s  %s\n' "$EXPECTED_ARCHIVE_SHA256" "$SOURCE_ARCHIVE" | sha256sum -c -
# Refuse dangerous tar members BEFORE extraction, including .git, links,
# duplicates, oversized entries, alternate spellings and absolute/parent paths.
python3 -I - "$SOURCE_ARCHIVE" <<'PYTAR'
import pathlib,sys,tarfile
with tarfile.open(sys.argv[1],"r:") as source:
    entries=source.getmembers()
    if not entries or len(entries)>20000:
        raise SystemExit("INVALID_ARCHIVE_COUNT")
    names=set()
    total=0
    for entry in entries:
        name=entry.name
        path=pathlib.PurePosixPath(name)
        total+=entry.size
        if (not name or name in names or name.startswith("/")
            or name!=str(path) or ".." in path.parts or ".git" in path.parts
            or not (entry.isfile() or entry.isdir())
            or entry.size>33554432 or total>268435456):
            raise SystemExit("UNSAFE_ARCHIVE_MEMBER")
        names.add(name)
PYTAR
tar -xf "$SOURCE_ARCHIVE"  # flat Git archive, only after member validation
test -f package.json
test -f package-lock.json
test ! -e .git
# Exclude ambient Git global/system ignores; track ALL extracted files.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
git init -q
git -c core.autocrlf=false -c core.excludesFile=/dev/null add -A -f
test "$(git write-tree)" = "$EXPECTED_GIT_TREE"
printf '%s  %s\n' "$EXPECTED_LOCK_SHA256" package-lock.json | sha256sum -c -
# Historical 2026-11-08 lock, not a replacement for the approved manifest:
# 78c497461fcfaa43e07bec8669571c783a4168dbf7a0c64cdfa739cbefa5ba49
npm ci --include=dev --no-audit --no-fund
npm audit --audit-level=high
npm run -s typecheck
npm test
npm run -s maps:collection
npm run -s mcp:smoke
npm run -s demo:historical-compat
npm run -s demo:core-hub-lens
npm run -s demo:integrability
```

At local pre-release commit `b265008d685ca45ddfa48d2eb41528ef2fbdb160`
(tree `cada08b937a0baae343c02bf882ddbf7351c1eda`), on 2026-11-08,
123 Vitest suites passed: 1,836 tests plus one intentional expected failure. TypeScript,
MCP loopback and the offline historical/integrability demos also passed.
Those are **dated local observations, not acceptance results for a future
Git release SHA**, and no independent human/third-party review is claimed.
Native ARM64 and AMD64 runtime checks from the separate protected source
also cannot be transferred automatically to a changed public candidate.

A compliant runtime image must use the exact approved source archive and
immutable `Dockerfile` base, run non-root with read-only filesystem,
no capabilities, no-new-privileges, no external runtime network or host
ports during QA, include these five intended distribution files: `LICENSE`,
`README.md`, `SECURITY_BOUNDARIES.md`, `docs/release/REPRODUCTION.md`,
and `docs/distribution/MCP_PRIVACY_POLICY.md`; exclude
operator/deployment/approval runbooks. Both MCP eras (`2025-11-25`,
`2026-07-28`) must be checked on the **final** source and native target
architectures. A passing container test does not establish provider
availability, trust in source RPC results, on-chain finality or release
authorization.

## Historical v1.1.0 source release reproduction (archived)

The following original procedure and expected hashes describe the historical
runtime authority `ed5273b2` and public v1.1.0 source release, **not** the
separate unpublished NE Suite v1 candidate. They are retained for historical
falsifiability.

### What is being reproduced

```text
RUNTIME_AUTHORITY  = ed5273b2e28cf7438dcdade0a2d48a08ffa7f9ef
SIGNOFF_CANDIDATE  = the Git commit being reproduced (git rev-parse HEAD)
```

The signoff candidate is the runtime authority plus documentation-only
release alignment. A Git commit cannot contain its own SHA, so record the
candidate with `git rev-parse HEAD` and compare it with the promoted SHA in
the canonical project STATUS. Then confirm that only documentation differs
from the runtime authority:

```sh
git diff --name-only ed5273b2e28cf7438dcdade0a2d48a08ffa7f9ef HEAD
# expected: only *.md documentation files

git rev-parse HEAD:packages/core
# b8ed923c9f43d17365f224e3f03f3df3135c5e87  (unchanged since v1.0.0; see FREEZE_MANIFEST.md)
```

### Prerequisites

- Node.js 20.12 or newer (root `engines.node` is `>=20.12`).
- npm with lockfile version 3 support (bundled with Node.js 20).
- Git and a SHA-256 tool (`sha256sum` or `shasum -a 256`).
- Network access to the npm registry for `npm ci` and `npm audit` only.

### Install, audit, typecheck and tests

```sh
git clone https://github.com/ZzNible/network-evidence.git
cd network-evidence
git checkout <commit>   # the signoff candidate being reproduced
npm ci
npm audit --audit-level=high
npm run -s typecheck
npm test
```

`npm ci` installs exactly the graph in `package-lock.json` and fails if
`package.json` and the lockfile disagree. Do not use `npm install` or
`npm audit fix` for reproduction; both may change the dependency graph.

Expected results at the runtime authority:

| Command | Expected |
| --- | --- |
| `npm audit --audit-level=high` | exit 0, `found 0 vulnerabilities` (point-in-time; see [DEPENDENCY_ADVISORIES.md](DEPENDENCY_ADVISORIES.md)) |
| `npm run -s typecheck` | exit 0, no output |
| `npm test` | `Test Files 72 passed (72)`, `Tests 1361 passed (1361)` |

`npm test` runs every `packages/*/test/**/*.test.ts` and
`examples/*/test/**/*.test.ts` file with Vitest (see `vitest.config.ts`).

#### Targeted suites

These are included in `npm test`; run them alone to check the BEFORE and
Discovery gates directly.

| Command | Scope | Expected |
| --- | --- | --- |
| `npx vitest run packages/resolver-opstack/test/before.test.ts` | Base BEFORE (`eip155:8453` mainnet, `eip155:84532` testnet) | 1 file, 52 tests passed |
| `npx vitest run packages/resolver-solana/test/before.test.ts` | Solana BEFORE (`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` mainnet, `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` testnet) | 1 file, 71 tests passed |
| `npx vitest run packages/discovery` | `@nec/discovery` orchestrator | 1 file, 34 tests passed |
| `npx vitest run examples/discovery` | Discovery demo | 1 file, 10 tests passed |
| `npm run -s test:maps` | NE Maps (`examples/ne-maps/test`) | 3 files, 29 tests passed |

### Deterministic outputs

Each command below reads only local files and writes deterministic stdout.
The `-s` flag keeps npm's own banner out of stdout. Run each twice and
compare; the SHA-256 values are of the exact stdout bytes.

| Command | stdout bytes | stdout SHA-256 |
| --- | --- | --- |
| `npm run -s demo:core-hub-lens` | 11874 | `90e0827f223bbc2131fee438ad343946c6265c5e5ed8565ef466a0afa7cb0898` |
| `npm run -s demo:historical-compat` | 83 | `c133914937ee2970777823c002ccdd99a0dcb72823ce22f4c4965df43fe082d0` |
| `npm run -s demo:discovery` | 6811 | `de3da6d9b7b5ca5c0b328dbf6e8c72948739ae84c5fc6f406b762b0fd7d20260` |
| `npm run -s demo:integrability` | 99 | `789e2dc48f39c6c505cfbaa72f1eeec76fbf2dd60af14974846caf31b2895c17` |
| `npm run -s maps:collection` | 114 | `3710879095dc909e85fd4a98d1ee2e1a70f153a18e3fc33b463c6075bac1bf89` |

For example:

```sh
npm run -s demo:discovery | sha256sum
npm run -s demo:discovery | sha256sum   # must match the first run
```

The root scripts `demo:historical-compat`, `demo:integrability` and
`maps:collection` already pass `--verify`; do not add it again.

#### Core -> Hub -> Lens demo

The output SHA-256 is also pinned in
`examples/core-hub-lens/EXPECTED_OUTPUT.sha256` and asserted by
`examples/core-hub-lens/test/demo.test.ts`. The demo asserts the replay
fixture digest before evaluating it:

```sh
sha256sum packages/adapter-erc4337/test/fixtures/base-sepolia-external-v06-userop.json
# 37f7da5719220a16a2841a08360eff4738aab9bbc4873dcbf79307847f4131a3
```

`examples/core-hub-lens/EXPORT_SHA256SUMS.txt` records the digests of the
frozen `v1.0.0` example files at export time. It is not asserted by the test
suite; check it explicitly:

```sh
(cd examples/core-hub-lens && sha256sum -c EXPORT_SHA256SUMS.txt)
```

#### Historical compatibility (F1/F2/F3)

Expected stdout (one line):

```text
HISTORICAL_COMPAT_PASS f1 f2 f3 authority=586a81a39c8da4d3a0dc0e879b605aabfd3f8d1d
```

The command replays the pinned bytes through fresh offline public Core and
verifies `examples/historical-compat/data/SHA256SUMS`. The promoted authority
files can be checked separately:

```sh
(cd examples/historical-compat/data && sha256sum -c SHA256SUMS)
(cd examples/historical-compat/authority && sha256sum -c ../AUTHORITY_SHA256SUMS)
```

#### Synthetic/local integrability fixture

Expected stdout (one line):

```text
INTEGRABILITY_FIXTURE_PASS sha256:ee7263927cf3470ecd524f6321287bd056b3f444e5285a5d355a07d8440bc1ef
```

The fixture is a synthetic/local literal, not a network observation. The
command verifies `examples/integrability-fixture/data/SHA256SUMS`:

```sh
(cd examples/integrability-fixture/data && sha256sum -c SHA256SUMS)
```

#### NE Maps collection

Expected stdout (one line):

```text
NE_MAPS_COLLECTION_PASS cases=4 e10250b3f4714883f54c96003f1cdb5f1c2ed36cb7bd18dcf3f94b194139fa49  collection.json
```

The collection holds the three historical cases plus the labelled
synthetic/local case. The frozen legacy export and the derived collection are
both pinned:

```sh
(cd examples/ne-maps/data && sha256sum -c CASES.sha256 COLLECTION.sha256)
# cases.json: OK        (eef096d0e774bef6ce2b9c111218b52be19d00613c75eb538ce8f936ccf580e1)
# collection.json: OK   (e10250b3f4714883f54c96003f1cdb5f1c2ed36cb7bd18dcf3f94b194139fa49)
```

To view the atlas locally:

```sh
npm run maps:serve   # binds 127.0.0.1:4177 (override with PORT)
```

The server listens on the loopback interface only and serves static files
from `examples/ne-maps/`. Maps performs no external network lookup.

#### Discovery demo

The stdout SHA-256 is also pinned in `examples/discovery/EXPECTED_STDOUT.sha256`
and asserted by `npx vitest run examples/discovery`. The final stdout line is:

```text
NE did not execute, sign, fund or submit anything.
```

The demo takes no command-line options. It covers Base mainnet, Base Sepolia,
Solana mainnet and Solana devnet in one request. Its probe inputs are
synthetic demo inputs, not live availability; the Solana devnet candidate is
an offline archived replay whose current availability stays `unknown`. The
CLI replaces `fetch` with a throwing guard. Environment (`mainnet`/`testnet`)
scope filtering is covered by the `@nec/discovery` and `examples/discovery`
tests, not by a demo CLI switch. See
[examples/discovery/README.md](../../examples/discovery/README.md).

### Release-state check (read-only)

```sh
git ls-remote --tags origin 'v1.*'
# 60fc3e91860a226b020e9addefa152dbe23f4ffa  refs/tags/v1.0.0
# d3827f9b42084bf893e8d93faa0fb905fa339155  refs/tags/v1.0.0^{}
# 62044f78851260d6af8bc5e8dffd6d8bace46d15  refs/tags/v1.1.0
# de3ee11d08d22d2791d8b5acfe17c2e61df23e81  refs/tags/v1.1.0^{}

git rev-parse 'v1.1.0^{}'
# de3ee11d08d22d2791d8b5acfe17c2e61df23e81
```

`v1.1.0` is the current public source release and `v1.0.0` remains immutable
historical release state. No `@nec/*` package is published to npm and no hosted
deployment is part of `v1.1.0`.

### What reproduction does not establish

Passing these steps reproduces the documented results and deterministic
outputs of the `v1.1.0` source tree. Reproduction does not itself create,
modify or republish a tag/GitHub Release, and it does not publish npm packages
or deploy a hosted service. It does not establish live network availability,
hosted monitoring, settlement or finality beyond the explicit boundaries in
each package README, and it does not change the dependency-advisory status
described in [DEPENDENCY_ADVISORIES.md](DEPENDENCY_ADVISORIES.md).
