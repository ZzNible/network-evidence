# Clean-machine reproduction

These steps reproduce the current signoff candidate from a clean checkout.
They need no secrets, credentials, RPC endpoints, wallets or signing keys.
No step performs live network evidence I/O, signing, funding or transaction
submission; network access is used only by `npm ci`/`npm audit` (npm
registry) and the optional read-only release-state check.

## What is being reproduced

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

## Prerequisites

- Node.js 20.12 or newer (root `engines.node` is `>=20.12`).
- npm with lockfile version 3 support (bundled with Node.js 20).
- Git and a SHA-256 tool (`sha256sum` or `shasum -a 256`).
- Network access to the npm registry for `npm ci` and `npm audit` only.

## Install, audit, typecheck and tests

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

### Targeted suites

These are included in `npm test`; run them alone to check the BEFORE and
Discovery gates directly.

| Command | Scope | Expected |
| --- | --- | --- |
| `npx vitest run packages/resolver-opstack/test/before.test.ts` | Base BEFORE (`eip155:8453` mainnet, `eip155:84532` testnet) | 1 file, 52 tests passed |
| `npx vitest run packages/resolver-solana/test/before.test.ts` | Solana BEFORE (`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` mainnet, `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` testnet) | 1 file, 71 tests passed |
| `npx vitest run packages/discovery` | `@nec/discovery` orchestrator | 1 file, 34 tests passed |
| `npx vitest run examples/discovery` | Discovery demo | 1 file, 10 tests passed |
| `npm run -s test:maps` | NE Maps (`examples/ne-maps/test`) | 3 files, 29 tests passed |

## Deterministic outputs

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

### Core -> Hub -> Lens demo

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

### Historical compatibility (F1/F2/F3)

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

### Synthetic/local integrability fixture

Expected stdout (one line):

```text
INTEGRABILITY_FIXTURE_PASS sha256:ee7263927cf3470ecd524f6321287bd056b3f444e5285a5d355a07d8440bc1ef
```

The fixture is a synthetic/local literal, not a network observation. The
command verifies `examples/integrability-fixture/data/SHA256SUMS`:

```sh
(cd examples/integrability-fixture/data && sha256sum -c SHA256SUMS)
```

### NE Maps collection

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

### Discovery demo

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

## Release-state check (read-only)

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

## What reproduction does not establish

Passing these steps reproduces the documented results and deterministic
outputs of the `v1.1.0` source tree. Reproduction does not itself create,
modify or republish a tag/GitHub Release, and it does not publish npm packages
or deploy a hosted service. It does not establish live network availability,
hosted monitoring, settlement or finality beyond the explicit boundaries in
each package README, and it does not change the dependency-advisory status
described in [DEPENDENCY_ADVISORIES.md](DEPENDENCY_ADVISORIES.md).
