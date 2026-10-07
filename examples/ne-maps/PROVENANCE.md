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

The Maps layer does not recompute any verdict. Trail ordering is navigation metadata only and creates no new causal edge.

Pinned export digest:

`21486e34e268563c5186927b5b56b9c0346a55c9a0e2b2f34a1ff6a6bafb2d8b  cases.json`

The same value is stored in `data/CASES.sha256`.

`TARGET_CORE_MUTATIONS = 0`.
