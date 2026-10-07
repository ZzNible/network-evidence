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

`TARGET_CORE_MUTATIONS = 0`.
