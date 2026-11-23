# NE Maps v1 — case isolation, Lens and Trail presentation

**Status:** candidate UI implementation; not an NE Core change, not a hosted deployment, not a new source release. Base: public main `e557ac5502e02f3712cecd1506f1670344300c7a`.

## Goal and scope

A third-party developer using the generic Suite must not mistake bundled historical/synthetic fixtures for their application evidence. People inspecting a case must see a meaningful separation between **Lens** (the declared evidence relationships and proposition assessments) and **Trail** (a guided *reading order* of existing propositions). This is a bounded UI change in `examples/ne-maps/`. Do not change `@nec/core`, `@nec/hub`, `@nec/lens`, the case schema, reviewed fixture bytes or MCP tools.

## Roles and sources of truth

| Surface | Responsibility | Never promises |
| --- | --- | --- |
| Core | Exact-action network evidence verdicts and provenance | A global trust percentage or an unobserved finality |
| Hub | Validated Core result preservation | Re-evaluation, source acquisition or policy |
| Lens | Browser-safe propositions, assessments, declared relations and limits | New judgments from visual relationships |
| Trail (in Maps) | Presentation order of Lens proposition IDs | Chronology, causation, proof of missing links |
| NE Maps | Browser that renders a versioned collection | Resolver, wallet, signer, or secret store |

All verdicts remain per proposition; `supported`, `contradicted`, `insufficient`, `ambiguous`, `unavailable` retain their exact semantics. A source-reported inclusion or successful execution is not settlement, ChainLock finality, independently verified proof or physical delivery.

## User stories and acceptance

1. **My cases:** the default `#/` and `#/mine` display only the optional application-owned collection. No provided collection yields an explicit empty state, not automatically the five fixtures. No browser storage or RPC source is introduced.
2. **Examples:** `#/examples` displays the reviewed frozen collection from `data/collection.json`, including the clearly labeled synthetic/local case. Unmodified legacy deep links `#/case/{id}/{lens|trail|action}` resolve to examples.
3. **Isolated IDs:** `#/mine/{id}/{view}` resolves only against the application collection; `#/examples/{id}/{view}` resolves only against the reviewed collection. The same ID in both collections does not cross-reference another source.
4. **Lens:** draws only `lens.relations[]` with exact `fromRef`, `relationType`, `toRef`, `basis` and limitations. Directional arrows show *declared source-to-target relations*, not a causal route. All propositions remain available outside the relationship view.
5. **Trail:** ordered, numbered steps render only `trailPropositionOrder[]` with **all** existing per-proposition assessments, evidence bases and limitations. Omitted Lens propositions are signposted. Step numbers and connectors are navigation only, not inferred temporal edges.
6. **Safety:** strings enter the DOM via `textContent` and not `innerHTML`; the existing `validateNeMapsCollectionV01` runs before display. Malformed application data is rejected and reported rather than substituted with examples; reviewed examples are unaffected. No new evidence authority, storage, fetch from arbitrary origin, Core mutation or scoring.
7. **Responsive and keyboard:** stacked relations and Trail columns remain readable at 320/390px; semantic headings, details and normal anchor focus states. Screenshot/Chromium QA is required before merge.

## Integration

The public demo intentionally retains `data/collection.json` as **Examples**. Consumers may omit that file; only a real HTTP 404 means no packaged examples, while invalid JSON or a different HTTP failure must fail closed. My cases must remain accessible when the optional examples file is absent. To use your application-owned cases, provide `examples/ne-maps/data/my-collection.json` separately as a `ne-maps-case-collection/v0.1` document. The collection must contain **1–64** valid cases; the file may be absent for **zero** cases. The same existing validator applies to either present collection; a missing collection represents zero cases. The optional app input is ignored by `examples/ne-maps/data/.gitignore`, but do not force-add private evidence into the public demo repository.

Start `npm run maps:serve`, then open `http://127.0.0.1:4177/`. The `#/` landing page is intentionally the app case workspace, not the fixture gallery. Click **Examples** to explore frozen cases; `#/case/f2/lens` remains backward-compatible. The prototype is local/loopback-only: this does not implement a multiuser account, editable case storage, dynamic ingestion API, hosted service or access control.

To add a new real-world case (e.g., Locutus M2), have an authorized external consumer produce a validated browser-safe Lens projection and a versioned Maps case envelope with exact source provenance; copying an RPC transaction summary alone is not enough to claim Gateway settlement or finality.

## Validation and stop conditions

1. `node --check examples/ne-maps/app.js` and `node --check examples/ne-maps/ui-navigation.js`.
2. `npm run -s test:maps` (baseline Maps tests and new presentation/route cases).
3. `npm run -s maps:collection` (frozen collection remains byte-identical).
4. Browser QA on 1440px, 390px and 320px for `#/`, `#/examples`, `#/case/f2/lens`, `#/case/f2/trail`, `#/case/zksys-genesis-20261118/lens`, `#/case/zksys-genesis-20261118/trail`. Confirm all incomplete links and MOCK boundaries remain visible.
5. Verify the current GitHub source SHA before review. Only when a separate operator-approved branch push has occurred, verify its remote SHA; **no merge, public deployment or release** as part of this candidate.

**Known limitation:** relation diagrams are deterministic **edge cards**, not a force-directed graph engine. Real provenance-preserving graph layouts or personal case ingestion must not be added unless further independently justified. This fulfills visual separation without inventing a new evidence model.
