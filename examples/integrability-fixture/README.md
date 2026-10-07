# v1.1 generic integrability fixture

Synthetic/local proof of the reusable path, intentionally independent of the
F1/F2/F3 builders:

```text
Core NetworkEvidenceResult object or nec-wire-json-v1
-> @nec/hub
-> @nec/lens
-> lens-browser/v0.1
```

The Core world is copied from the independent literals in
`packages/core/test/golden.test.ts`, preserving the reviewed golden digests:

```text
semanticDigest = sha256:ee7263927cf3470ecd524f6321287bd056b3f444e5285a5d355a07d8440bc1ef
artifactDigest = sha256:5569171adbbe7a31dd82c363134e21532e5ad0bd7b8f2cf80e97ad4a49f29f7d
```

It deliberately contains:

- execution `supported` on `source_observation`;
- one observed ERC-20 transfer effect;
- data binding `not_applicable`;
- settlement `unknown`;
- finality `unknown`;
- no policy/confidence score.

## Reproduce

From repository root after `npm ci`:

```sh
npm run typecheck
npm run demo:integrability
```

`demo:integrability` rebuilds both object and wire paths and requires them to
produce byte-identical Lens and browser projections. It then compares them
against the checked-in files in `data/` and verifies `SHA256SUMS`.

To regenerate the checked-in fixture deliberately while developing this exact
contract:

```sh
npx tsx examples/integrability-fixture/run.ts --write
```

Regeneration is not a release step; changed bytes require review.

The materialized artifacts are:

- `core-result.wire.json` — Core public wire input;
- `lens-case.json` — deterministic `lens-case/v0.1` output;
- `lens-browser.json` — deterministic browser-safe projection;
- `proof-summary.json` — stage identities and pinned hashes;
- `SHA256SUMS` — exact fixture byte hashes.

`TARGET_CORE_MUTATIONS = 0`.
