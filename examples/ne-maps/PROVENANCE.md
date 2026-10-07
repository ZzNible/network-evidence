# NE Maps export provenance

The minimal atlas is presentation-only. Its case data was exported from the exact reviewed browser-safe Lens projections in:

- repository: `ZzNible/agent-evidence-hub`
- branch: `autonomy/authority-v1`
- commit: `586a81a39c8da4d3a0dc0e879b605aabfd3f8d1d`

The public Suite checkpoint referenced by F2/F3 integration is:

- repository: `ZzNible/network-evidence`
- commit: `e536ca1c63465ebb2de46c855a01bac71e4dc768`

`data/cases.json` contains:

- F1 browser-safe Lens projection;
- F2 browser-safe exact UserOperation projection plus the four already-reviewed selector outcomes;
- F3 browser-safe Lens projection;
- presentation-only labels, exact-action handoff identifiers and an ordered Trail presentation list.

The Maps layer does not recompute any verdict. Trail ordering is written by Maps as navigation metadata only and creates no new causal edge. F1 intentionally keeps the source-reported application timeout in Lens only because the Trail handoff is network-action scoped; that omission is explicit in the exported `trailContextNote`.

Pinned export digest:

`eef096d0e774bef6ce2b9c111218b52be19d00613c75eb538ce8f936ccf580e1  cases.json`

The same value is stored in `data/CASES.sha256`.

## Versioned collection (v1.1 LOT 4)

Maps loads `data/collection.json` (`ne-maps-case-collection/v0.1`), derived deterministically by `build-collection.ts` from:

- `data/cases.json` above (byte-unchanged; each nested F1/F2/F3 Lens is also required to serialize byte-identically to `examples/historical-compat/data/<id>.lens-browser.json`);
- `examples/integrability-fixture/data/lens-browser.json` (SHA-256 `2daf7f598a5032ab786b698192ffd08c2142681ab7729f37936f7724185fc44f`), rebuilt live from the synthetic Core golden world through `@nec/hub` and `@nec/lens` and required to match byte-for-byte.

The F1/F2/F3 migration is envelope-only. The legacy collection-level `sourceAuthority`/`publicSuite` values are carried per case in `extensions.provenance`; the synthetic/local case carries its own fixture provenance and is labelled "synthetic/local fixture — not a network observation".

Pinned collection digest is stored in `data/COLLECTION.sha256`.

`TARGET_CORE_MUTATIONS = 0`.
