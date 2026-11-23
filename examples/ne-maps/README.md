# NE Maps — minimal v1 atlas

This directory is the bounded generic/multichain Maps surface. It renders any conforming `ne-maps-case-collection/v0.1` of `ne-maps-case/v0.1` envelopes, each wrapping one browser-safe `lens-case/v0.1` projection.

It is deliberately a presentation layer:

- any number of conforming cases (1–64), validated fail-closed by `collection.js` before rendering;
- no case-id, chain or case-count logic in `app.js`;
- no resolver, RPC acquisition, signing, submission, wallet or policy path;
- no graph engine;
- no global verdict, confidence or ranking;
- no chain-specific product logic;
- `TARGET_CORE_MUTATIONS = 0`.

## Cases in `data/collection.json`

1. Base mainnet x402 partial case — supported execution/data binding, insufficient OP Stack finality and x402 correlation, settlement unavailable.
2. Base Sepolia ERC-4337 v0.6 exact UserOperation — supported exact selection, with the already-reviewed selector outcomes for supported / insufficient / contradicted / ambiguous; finality and bundler provenance unavailable.
3. Solana mainnet x402-SVM partial case — supported execution/payment/source-observed RPC-finalized dimension, insufficient historical x402 correlation, settlement unavailable.
4. **Synthetic / local fixture — not a network observation.** The LOT 2 integrability proof (Core golden literals -> `@nec/hub` -> `@nec/lens` -> `lens-browser/v0.1`): execution supported, one observed ERC-20 effect, data binding not applicable, settlement and finality unknown. Its EVM-shaped identifiers are fixture literals.

5. zkSYS Genesis historical public testnet source trail: five network steps; the test verifier accepts a V8 MOCK TYPE 3 proof, NOT independently verified real ZK proof. Gateway event is a public index, and PoDA/ChainLock remain insufficient. No live RPC or wallet needed.

Cases 1–3 come from the frozen reviewed export pinned to:

- `ZzNible/agent-evidence-hub` `autonomy/authority-v1` at `586a81a39c8da4d3a0dc0e879b605aabfd3f8d1d`;
- public Suite repo `ZzNible/network-evidence` at `e536ca1c63465ebb2de46c855a01bac71e4dc768`.

`data/cases.json` is that frozen reviewed export (legacy `ne-maps/v0.1`, unchanged). Maps no longer loads it directly: `build-collection.ts` derives `data/collection.json` from it and from the LOT 2 fixture, carrying every nested Lens projection unchanged and moving only legacy presentation fields into the versioned envelope (`extensions.trailContextNote`, `extensions.reviewedSelectorOutcomes`, `extensions.provenance`). Display labels and Trail ordering are presentation metadata, not evidence.

F4 is frozen as data/f4-reviewed.json + data/F4_REVIEWED.sha256. Its five navigation steps are source-bound external Lens assessments (not Core settlement/finality verdicts); original source digest is in provenance. The generic Maps app.js remains unchanged, and MCP reads the same pinned collection.

## Adding a case

Append an `ne-maps-case/v0.1` envelope (`schemaVersion`, lowercase URL-safe `id`, `display { networkLabel, title, shape }`, `exactAction { networkId, id, ... }` with string values, `trailPropositionOrder` of existing proposition ids, browser-safe `lens`, optional `extensions`) to the collection. No `app.js` change is needed. Unknown extension keys are tolerated but not rendered; forbidden authority/ranking keys (`caseVerdict`, `confidence`, `trustScore`, `score`, `policyDecision`, `rank`, `ranking`) are rejected anywhere. Validate in Node with the public Lens validator:

~~~ts
import { validateLensBrowserSafeCaseV01 } from "@nec/lens";
import { validateNeMapsCollectionV01 } from "./collection.js";
validateNeMapsCollectionV01(collection, { validateLens: (lens) => validateLensBrowserSafeCaseV01(lens) });
~~~

The checked-in collection is reproduced and byte-checked by:

~~~sh
npm run maps:collection     # verify data/collection.json + data/COLLECTION.sha256
npx tsx examples/ne-maps/build-collection.ts --write   # deliberate regeneration; review changed bytes
~~~

## Case workspace vs reviewed examples (candidate UI)

The default browser landing page `#/` / `#/mine` is now **My cases**. It is intentionally empty until the integrating application supplies its own `data/my-collection.json` with the same strict `ne-maps-case-collection/v0.1` format. This second file is **optional** (absence means zero application cases); a present but malformed file yields an explicit validation failure. The generic collection contract still requires 1–64 cases, so an empty document is not treated as valid.

The five reviewed historical/synthetic cases remain unchanged under the separate **Examples** tab at `#/examples`. The old `#/case/{id}/{lens|trail|action}` deep links still target the examples; `#/mine/{id}/{view}` only resolves from the app-owned collection. Duplicate case IDs across the two sources are not silently merged. The demo does not provide persistence, upload, accounts or a live ingest API.

**Lens** displays declared relation endpoints, relation type, basis and limits in directional relationship cards alongside the complete set of propositions. **Trail** displays an ordered, numbered reading sequence of existing propositions, not a verified chronological or causal chain; omitted Lens-only context is signposted. For scope, architecture, test and release gates, see [the case/Lens/Trail specification](../../docs/NE_MAPS_CASES_LENS_TRAIL_V1_SPEC.md). This candidate UI is not a new NE Core assertion or release.

## Run

From the repository root:

~~~sh
npm run maps:serve
~~~

Open `http://127.0.0.1:4177/`.

Each case has three deterministic handoffs:

- **Lens** — propositions, assessments, basis and limitations;
- **Trail** — Maps-authored network-action ordering of existing case propositions, without inventing causal edges; Lens-only context omissions are explicit;
- **Exact action** — the source-backed transaction/UserOperation identity and exported case relations.

No external network lookup is performed by Maps.
