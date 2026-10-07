# Dependency advisories

Source: host-observed `npm audit` (audit report version 2) against the
candidate source commit `bcd4d5b1cd0e0e6e325a3e303cdfb16264c2a898`, generated
2026-10-07T14:09:53Z. `npm audit` exited with code 1.

**The candidate is not advisory-clean.** No dependency was changed to produce
this document, and no remediation is claimed.

## Summary

```text
critical  2
high      1
moderate  1
low       0
info      0
total     4   (vulnerable package entries)

dependencies audited: 134 total (prod 31, dev 104, optional 53, peer 0)
```

## Findings

| Package | Locked | Severity | Advisory | Direct? | Lockfile scope | Reached through |
| --- | --- | --- | --- | --- | --- | --- |
| `vitest` | `3.2.7` | critical (via `tinypool`); own advisory moderate | [GHSA-82fw-gwwq-j7x9](https://github.com/advisories/GHSA-82fw-gwwq-j7x9) — path traversal / arbitrary file read via `@vitest/mocker` redirect mock | yes (root `devDependencies`, `^3.0.0`) | `dev: true` | — |
| `tinypool` | `1.1.1` | critical | [GHSA-5gmw-xhrv-c9v3](https://github.com/advisories/GHSA-5gmw-xhrv-c9v3), [GHSA-85c8-ppgw-ccpr](https://github.com/advisories/GHSA-85c8-ppgw-ccpr) — prototype-pollution gadgets in worker / `run()` options leading to code execution | no | `dev: true` | `vitest` |
| `@vitest/mocker` | `3.2.7` | moderate | [GHSA-82fw-gwwq-j7x9](https://github.com/advisories/GHSA-82fw-gwwq-j7x9) | no | `dev: true` | `vitest` |
| `source-map-js` | `1.2.1` | high | [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q) — event-loop denial of service through indexed source-map section offsets | no | `dev: true` | `postcss` (dev) |

## Classification

All four entries are **development/test-toolchain dependencies**:

- every affected package is marked `"dev": true` in `package-lock.json`;
- none is declared by, or reachable from the `dependencies` of, any
  `packages/*/package.json` (whose only third-party runtime dependencies are
  `viem` and `@noble/curves`, neither of which is reported);
- `vitest`/`vitest/config` are imported only by `vitest.config.ts` and
  `*.test.ts` files; the demo (`examples/core-hub-lens/run.ts`) and the Maps
  server (`examples/ne-maps/serve.mjs`) do not import them;
- no package is published to npm (all manifests are `"private": true`), so no
  consumer installs this graph from a registry package.

The advisories are therefore **not** classified as affecting the
`@nec/*` runtime code. They **do** apply on any machine that runs
`npm test`/`npm run test:maps` (Vitest and Tinypool execute there) and to any
tooling that processes untrusted source maps through `source-map-js`.
Contributors should run the test suite only on trusted checkouts until the
toolchain is updated.

This classification is based on the lockfile `dev` flags and the import
graph above. The host did not record an `npm audit --omit=dev` run, and no
exploitability assessment beyond that is claimed.

## Remediation status: not performed

| Package | `npm audit` fix | Why it is not applied here |
| --- | --- | --- |
| `vitest`, `@vitest/mocker`, `tinypool` | `vitest@5.0.3` (`isSemVerMajor: true`) | Outside the declared `^3.0.0` range; requires a `package.json` and `package-lock.json` change and a major-version toolchain decision. |
| `source-map-js` | available within existing ranges (`fixAvailable: true`) | Requires a `package-lock.json` change. |

Both changes are dependency-metadata mutations and are outside release
documentation. They require a human decision and a separate reviewed change;
after any such change, `npm ci`, `npm run typecheck`, `npm test` and the
deterministic outputs in [REPRODUCTION.md](REPRODUCTION.md) must be
re-verified.
