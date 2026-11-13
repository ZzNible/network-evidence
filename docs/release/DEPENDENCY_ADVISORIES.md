# Dependency advisory status

This file records host-observed `npm audit` results only as dated,
point-in-time observations bound to one exact commit each, plus the locked
toolchain versions of this tree. An observation holds only for the commit
and date it names: advisory-database changes can change `npm audit` output
without a repository change. No `npm audit` result is claimed for any other
commit, including the current tree.

## Observation 2026-10-07 at hardening anchor `64b412d01bd12c1a87c93699a4fbc9ee64e61967`

Source: host-observed `npm audit` (audit report version 2) during the
2026-10-07 release-hardening gate, at the dependency-hardening code anchor
`64b412d01bd12c1a87c93699a4fbc9ee64e61967`. At that gate, the sign-off
candidate was the Git commit that then contained this document.

At that commit on that date, `npm audit` exited with code 0:

```text
critical  0
high      0
moderate  0
low       0
info      0
total     0

dependencies audited: 152 total (prod 29, dev 122, optional 79, peer 5)
```

This is a point-in-time release-gate observation against the locked
dependency graph of that commit.

## Observation 2026-10-08 at runtime authority `ed5273b2e28cf7438dcdade0a2d48a08ffa7f9ef`

Host-observed `npm ci` then `npm audit --audit-level=high` at
`ed5273b2e28cf7438dcdade0a2d48a08ffa7f9ef` on 2026-10-08 exited with code 0:

```text
critical  0
high      0
moderate  0
low       0
info      0
total     0

dependencies audited: 158 total (prod 35, dev 122, optional 79, peer 5)
```

The higher count (152 at the hardening anchor) comes from the workspace
packages `@nec/hub`, `@nec/lens` and `@nec/discovery`. They add no
third-party dependency, and the locked third-party graph was unchanged at
that commit. This is also a point-in-time observation.

## Observation 2026-11-08 at local source candidate `b265008d685ca45ddfa48d2eb41528ef2fbdb160`

Host-observed on the *local-only*, unpublished candidate whose source tree
is `cada08b937a0baae343c02bf882ddbf7351c1eda` and root
`package-lock.json` SHA-256 is
`78c497461fcfaa43e07bec8669571c783a4168dbf7a0c64cdfa739cbefa5ba49`.
A clean archive extraction with `npm ci --include=dev`, followed by the
official `npm audit --audit-level=high --json` on 2026-11-08, exited with code 0.
The captured audit metadata reported the following counts at that date:

```text
info     0
low      0
moderate 0
high     0
critical 0
total    0
```

This observation is tied to the named local candidate and advisory database
at that time. The final source SHA after documentation updates still requires
its own clean-install security check. An audit result is not a software
security certification or release authorization.

## Current tree (no audit result claimed)

This section makes no `npm audit` result claim for the current tree.
The dated observations above belong to their *exact historical commits* and
do not automatically transfer to a new release commit. Record a fresh
`npm audit` result against the final release source after its exact SHA is
established. Release approval is a separate owner decision, not an audit exit.


The pre-hardening release record reported four development/test-toolchain
advisory entries; the 2026-10-07 hardening changed only the
development/test toolchain. The lockfile of this tree records:

- root `vitest` is declared `^4.1.11` and locked at `4.1.12`;
- root `vite` is explicitly declared `^6.4.3` and locked at `6.4.5`;
- `source-map-js` is locked at `1.2.2`;
- `zod` is locked at `4.6.7`;
- `@hono/node-server` is locked at `2.1.6`;
- `hono` is locked at `4.13.18`;
- the previously reported `tinypool` package is not present in the lockfile.

Third-party runtime dependencies declared in the `dependencies` of the workspace package manifests (`packages/*/package.json`) of this tree, `@nec/*` workspace packages excluded; the root `package.json` declares none:

- `@modelcontextprotocol/node`
- `@modelcontextprotocol/server`
- `@noble/curves`
- `viem`
- `zod`

All workspace package manifests are `"private": true`. No npm publication is
implied.

## Verification

From the exact sign-off candidate checkout:

```sh
npm ci
npm audit
npm run typecheck
npm test
npm run test:maps
```

Any `npm audit` run is an observation for that exact checkout on that date
only. The full fresh-clone release gate additionally checks the deterministic
demo and fixture/export manifests documented in
[REPRODUCTION.md](REPRODUCTION.md).
