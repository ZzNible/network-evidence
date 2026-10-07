# Clean-machine reproduction

These steps reproduce the candidate from a clean checkout. They need no
secrets, credentials, RPC endpoints, wallets or signing keys.

## Prerequisites

- Node.js 20.12 or newer (root `engines.node` is `>=20.12`).
- npm with lockfile version 3 support (bundled with Node.js 20).
- Git and a SHA-256 tool (`sha256sum` or `shasum -a 256`).
- Network access to the npm registry for `npm ci` only.

## Steps

```sh
git clone https://github.com/ZzNible/network-evidence.git
cd network-evidence
git checkout <commit>   # the commit being reproduced
npm ci
npm audit
npm run typecheck
npm test
npm run test:maps
```

The dependency-hardening code anchor is
`64b412d01bd12c1a87c93699a4fbc9ee64e61967`. The exact release sign-off
candidate is the Git commit being reproduced, including any documentation-only
sign-off correction. Record it with `git rev-parse HEAD` and compare it with
the promoted SHA in the canonical project STATUS. This avoids an impossible
self-reference where a Git commit would need to contain its own SHA.

`npm ci` installs exactly the graph in `package-lock.json` and fails if
`package.json` and the lockfile disagree. Do not use `npm install` or
`npm audit fix` for reproduction; both may change the dependency graph.

`npm test` runs every `packages/*/test/**/*.test.ts` and
`examples/*/test/**/*.test.ts` file with Vitest (see `vitest.config.ts`).
`npm run test:maps` runs only the NE Maps test.

## Deterministic outputs

### Core -> Hub -> Lens demo

```sh
npm run -s demo:core-hub-lens > demo-output.json
sha256sum demo-output.json
```

Expected SHA-256 of the CLI output (also pinned in
`examples/core-hub-lens/EXPECTED_OUTPUT.sha256` and asserted by
`examples/core-hub-lens/test/demo.test.ts`):

```text
90e0827f223bbc2131fee438ad343946c6265c5e5ed8565ef466a0afa7cb0898
```

The `-s` flag keeps npm's own banner out of stdout. The demo reads only local
files and asserts the replay fixture digest before evaluating it:

```sh
sha256sum packages/adapter-erc4337/test/fixtures/base-sepolia-external-v06-userop.json
# 37f7da5719220a16a2841a08360eff4738aab9bbc4873dcbf79307847f4131a3
```

`examples/core-hub-lens/EXPORT_SHA256SUMS.txt` records the digests of the
example files at export time. It is not asserted by the test suite; check it
explicitly:

```sh
cd examples/core-hub-lens && sha256sum -c EXPORT_SHA256SUMS.txt && cd ../..
```

### NE Maps case data

```sh
cd examples/ne-maps/data && sha256sum -c CASES.sha256 && cd ../../..
# cases.json: OK
# eef096d0e774bef6ce2b9c111218b52be19d00613c75eb538ce8f936ccf580e1
```

To view the atlas locally:

```sh
npm run maps:serve   # binds 127.0.0.1:4177 (override with PORT)
```

The server listens on the loopback interface only and serves static files
from `examples/ne-maps/`. Maps performs no external network lookup.

## What reproduction does not establish

Passing these steps reproduces the documented deterministic outputs of the
candidate source tree. It is not a tag, GitHub Release, npm publication or
deployment, and it does not change the dependency-advisory status described in
[DEPENDENCY_ADVISORIES.md](DEPENDENCY_ADVISORIES.md).
