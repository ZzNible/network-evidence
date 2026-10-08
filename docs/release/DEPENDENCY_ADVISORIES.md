# Dependency advisory status

Source: host-observed `npm audit` (audit report version 2) during the 2026-10-07
release-hardening gate. The dependency-hardening code anchor is
`64b412d01bd12c1a87c93699a4fbc9ee64e61967`. At that gate, the sign-off
candidate was the Git commit containing this document. For the current
candidate, see the 2026-10-08 re-observation below and
[RELEASE.md](../../RELEASE.md); resolve the exact commit with
`git rev-parse HEAD` and compare it with the promoted SHA recorded in the
canonical project STATUS.

`npm audit` exited with code 0.

## Observed result (2026-10-07 hardening gate)

```text
critical  0
high      0
moderate  0
low       0
info      0
total     0

dependencies audited: 152 total (prod 29, dev 122, optional 79, peer 5)
```

This is a point-in-time release-gate observation against the locked dependency
graph. Future advisory-database changes can change `npm audit` output without a
repository change.

## Re-observation (2026-10-08, runtime authority `ed5273b`)

Host-observed `npm ci` then `npm audit --audit-level=high` at
`ed5273b2e28cf7438dcdade0a2d48a08ffa7f9ef` exited with code 0:

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
third-party dependency, and the locked third-party graph is unchanged. This
is also a point-in-time observation.

## Remediation recorded in the current tree

The pre-hardening release record reported four development/test-toolchain
advisory entries. The current tree supersedes that state for release sign-off:

- root `vitest` is declared `^4.1.11` and locked at `4.1.11`;
- root `vite` is explicitly declared `^6.4.3` and locked at `6.4.3`;
- `source-map-js` is locked at `1.2.2`;
- the previously reported `tinypool` package is not present in the current
  lockfile;
- `npm audit` reports zero vulnerable package entries.

The remediation changes only the development/test toolchain. The package
runtime dependency boundary remains unchanged: third-party runtime dependencies
are `viem` and `@noble/curves`, and all workspace package manifests remain
`"private": true`. No npm publication is implied.

## Verification

From the exact sign-off candidate checkout:

```sh
npm ci
npm audit
npm run typecheck
npm test
npm run test:maps
```

The full fresh-clone release gate additionally checks the deterministic demo and
fixture/export manifests documented in [REPRODUCTION.md](REPRODUCTION.md).
