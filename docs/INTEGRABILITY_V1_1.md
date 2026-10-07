# Network Evidence Suite v1.1 integrability contract freeze

**Status:** LOT 4 GENERIC MAPS COLLECTION CANDIDATE (local; review pending)
**Historical release:** `v1.0.0` remains unchanged.
**Target:** a future `v1.1.0` only after the full integrability DoD passes.
**Core rule:** `TARGET_CORE_MUTATIONS = 0`.

## 1. Required reusable path

A third-party developer must be able to compose:

```text
NetworkEvidenceResult or nec-wire-json-v1
-> @nec/hub
-> @nec/lens
-> ne-maps-case/v0.1
-> NE Maps
```

without a Core change and without case-specific code in `examples/ne-maps/app.js`.

The three historical F1/F2/F3 cases remain compatibility fixtures. Their verdicts, limitations, provenance, missing/unavailable states, and evidence boundaries must not be strengthened or rewritten by the generic path.

## 2. @nec/hub v0.1 — minimum public contract

Source contract: `packages/hub/src/types.ts`.

Accepted inputs are exactly:

1. a Core `NetworkEvidenceResult` runtime object; or
2. a Core `nec-wire-json-v1` string with wire type `network-evidence-result`.

LOT 2 implementation requirements:

- object input -> call Core `validateNetworkEvidenceResult`;
- wire input -> call Core `decodeNecWireJson("network-evidence-result", wire)`;
- fail closed on invalid/unsupported input;
- emit `hub-network-evidence-record/v0.1`;
- retain the **complete validated Core result unchanged** in the Hub record.

Keeping the complete Core result is the preservation mechanism. Hub must not recompute or translate:

- `semanticDigest` / `artifactDigest`;
- subject/action/network identity;
- execution/dataBinding/settlement/finality verdicts;
- evidence bases;
- observed effects;
- evidence refs;
- warnings/conflicts;
- resolver/request/policy/snapshot provenance.

Hub v0.1 adds no generic A2A/MCP ingestion, live fetching, DB/service layer, correlation engine, policy decision, wallet/signing/submission, confidence or trust score.

## 3. @nec/lens v0.1 — minimum public contract

Source contract: `packages/lens/src/types.ts`.

Public schema identity remains `lens-case/v0.1`; the design is promoted from the existing reviewed Lens contract rather than replaced.

LOT 2 implements the four frozen runtime surfaces plus two additive browser verification helpers needed for deterministic materialization:

```text
validateLensCaseV01(unknown)
buildLensCaseFromHubV01(input)
projectLensBrowserSafeV01(case)
serializeLensCaseV01(case)
validateLensBrowserSafeCaseV01(unknown)   # additive LOT 2 helper
serializeLensBrowserSafeV01(browser)      # additive LOT 2 helper
```

### Generic mapping rule

The builder is mechanical, not an evaluator:

- create one network proposition for each Core evidence dimension (`execution`, `dataBinding`, `settlement`, `finality`);
- when Core carries a verdict, copy that exact verdict and exact Core evidence bases into a `network_evidence_verdict/v0.1` assessment;
- when Core does not carry a verdict, do **not** invent one; preserve applicability/reason as unresolved/not-applicable context;
- preserve observed effects as Network Evidence material without assigning them a new verdict;
- preserve warnings/conflicts and both Core digests in the internal Lens `coreResultPreservation` field;
- do not repurpose the historical F1 `networkEvidence` field; F1/F2/F3 browser-safe projections remain valid unchanged;
- preserve resolver/subject identity;
- never translate another evaluator vocabulary into Network Evidence vocabulary;
- never derive settlement/finality/service delivery/policy consequences from execution or observed effects.

`lens-case/v0.1` has no global case verdict, confidence, trust score, hidden ranking, wallet/signing/submission authority, or Core authority.

### Runtime validator

The validator must accept the current reviewed F1/F2/F3 projections unchanged, accept the documented generic fields above, reject unknown new top-level semantic fields unless they are carried in `extensions`, and fail closed on malformed contract fields. It also enforces the conditional Network Evidence rule:

```text
evaluator.type == network_evidence
=> vocabulary == network_evidence_verdict/v0.1
=> value is exactly supported|contradicted|insufficient|ambiguous
=> basis values are Core EvidenceBasis values only
```

Unknown evaluator vocabularies remain their own vocabularies.

### Browser-safe projection

The browser projection is an explicit nested allowlist. It removes private locators and artifact digests, never carries raw `nativeSource.payload` bytes, omits source-native `value` payloads and assessment `inputRefs`, does not spread unknown nested fields, withholds the internal revision digest, and retains only safe provenance identifiers required for inspection. Projection never changes proposition meaning.
The strict nested allowlist is enforced for generic `projectionPolicy: lens-browser/v0.1`; the three frozen historical projections remain accepted under their reviewed legacy/absent projection labels and are not rewritten.

### Deterministic serialization

Serialization uses the existing Hub-owned `hub-json-sorted-keys/v0.1` sorted-key output profile. LOT 2 narrows its accepted runtime domain to strict JSON-safe plain data (no bigint, accessors, symbols, sparse arrays, cycles, non-finite/-0 numbers or unpaired surrogates); valid values retain the reviewed Hub byte ordering. The 8 MiB output budget is enforced incrementally during serialization rather than after complete output construction. It is for Lens-owned records only and is not a source-byte canonicalization rule.

## 4. NE Maps case envelope v0.1

Source contract: `examples/ne-maps/contracts/case-envelope.ts`.

Required fields for each new generic case:

```text
schemaVersion = ne-maps-case/v0.1
id
display { networkLabel, title, shape }
exactAction { networkId, id, kind? }
trailPropositionOrder[]
lens = browser-safe lens-case/v0.1
```

Optional presentation-only extensions may include the historical F1 Trail context note, F2 reviewed selector outcomes, or per-case `provenance` (string values). The v0.1 collection contract keeps optional collection-level `sourceAuthority`/`publicSuite` and required `nonClaims`. A new generic case must require none of the case-specific extensions.

### LOT 4 generic collection

Maps loads only `examples/ne-maps/data/collection.json` (`ne-maps-case-collection/v0.1`) and validates it with the Maps-only runtime validator `examples/ne-maps/collection.js` before rendering. It fails closed on unsupported collection/case `schemaVersion`, unknown collection/case/display fields, invalid URL-unsafe or duplicate case ids, non-string exact-action values, Trail ids that are not Lens propositions, malformed known extensions, forbidden authority/ranking keys anywhere (`caseVerdict`, `confidence`, `trustScore`, `score`, `policyDecision`, `rank`, `ranking`), non-withheld browser revision digests, non-null artifact `locatorRef`, and empty or over-bound (>64) collections. There is no exactly-three or case-id dependency. Unknown extension keys are tolerated per contract and never rendered. In Node, callers additionally inject the public `@nec/lens` `validateLensBrowserSafeCaseV01`; the browser check only covers what Maps renders and does not restate Lens semantics.

The frozen reviewed `data/cases.json` (legacy `ne-maps/v0.1`, SHA-256 `eef096d0…`) is unchanged and remains the input pinned by `examples/historical-compat`. `examples/ne-maps/build-collection.ts` derives the collection deterministically (`npm run maps:collection`):

- F1/F2/F3: envelope-only migration. The nested Lens, `display`, `exactAction` and `trailPropositionOrder` are carried unchanged; legacy top-level `trailContextNote` / `reviewedSelectorOutcomes` move to `extensions`; the legacy collection-level `sourceAuthority`/`publicSuite` values move to per-case `extensions.provenance` because the mixed collection no longer shares one authority. Each nested Lens must serialize byte-identically to the LOT 3 `examples/historical-compat/data/<id>.lens-browser.json`.
- Synthetic/local: the LOT 2 fixture is rebuilt live (Core object -> `@nec/hub` -> `@nec/lens` -> `lens-browser/v0.1`) and must equal `examples/integrability-fixture/data/lens-browser.json` byte-for-byte; it is wrapped only by presentation metadata whose display labels and `exactAction.realityClass` state "synthetic/local fixture — not a network observation".

Maps may:

- render Lens propositions/relations/limitations;
- order existing proposition ids for navigation;
- display exact-action identity.

Maps may not:

- resolve network evidence;
- create a new assessment/relation basis;
- turn missing/unavailable into success/failure;
- strengthen `insufficient`/`ambiguous`;
- infer settlement/finality/causality;
- score/rank cases.

LOT 4 removes the historical `cases.length === 3` / `[f1,f2,f3]` structural freeze and adds runtime envelope validation while retaining dedicated regression assertions for F1/F2/F3.

## 5. Historical compatibility

Existing authority remains:

```text
ZzNible/agent-evidence-hub autonomy/authority-v1
586a81a39c8da4d3a0dc0e879b605aabfd3f8d1d
```

The public H1 and F2 copies at the v1.0.0 code are byte-identical to that authority. LOT 2/3 should promote/reuse reviewed algorithms rather than reimplement them where applicable.

F1/F2/F3 exact-fixture adapters remain valid compatibility adapters. Generic integration does not replace the case-specific facts they established.

### LOT 3 historical compatibility path

`examples/historical-compat/` promotes the reviewed F1/F2/F3 adapters byte-for-byte from authority `586a81a` (`lib/h1.mjs`, `lib/f1.mjs`, `lib/f2.mjs`, `lib/f3.mjs` plus the minimal pinned fixture subset; see its `PROVENANCE.md`). For each case:

```text
pinned bytes -> fresh offline public Core replay -> fail-closed equality with reviewed frozen semantics
-> promoted authority adapter -> validateLensBrowserSafeCaseV01 -> serializeLensBrowserSafeV01
```

The resulting browser projections are semantically and byte-identical to the reviewed projections pinned in `examples/ne-maps/data/cases.json`; the F3 authority demo digest and the existing F2 public demo projection are reproduced; the four reviewed F2 selector outcomes agree between fresh Core and the adapter. `compareHistoricalProjectionV01` is the regression guard for strengthened/changed verdicts, lost limitations/provenance, unauthorized browser fields and exact-action identity changes.

Case-specific semantics remain in the promoted adapters. No `@nec/hub`/`@nec/lens` change was required: the historical projections already satisfy the public `lens-case/v0.1` browser validator under their reviewed legacy projection labels, and the public serializer produces their deterministic bytes. Historical internal revisions remain under their reviewed authority serializers; only the browser projection is the public contract surface. `npm run demo:historical-compat` reproduces the checked-in outputs.

## 5A. Minimal LOT 2 contract corrections

Implementation exposed one frozen-type mismatch without requiring Core change:

1. Core `SubjectRef` may contain `blockNumber: bigint`. Lens-owned JSON/browser records therefore use `LensSubjectRefV01`, where block number is the same non-negative integer encoded as canonical decimal text. This is representation-only; Core subject semantics remain unchanged.
2. `validateLensBrowserSafeCaseV01` and `serializeLensBrowserSafeV01` are additive helpers so the browser projection itself can be fail-closed validated and byte-reproduced. They add no evidence semantics.

No other LOT 1 semantic boundary changed. `TARGET_CORE_MUTATIONS = 0`.

## 6. Synthetic/local proof fixture

Prepared in `examples/integrability-fixture/README.md` from the independent literal golden world in `packages/core/test/golden.test.ts`. It deliberately proves the generic plumbing, not a new network/protocol feature.

LOT 2 demonstrates both Core object and Core wire inputs produce byte-identical Lens and browser semantics. Checked-in materialized outputs and SHA-256 sums live under `examples/integrability-fixture/data/` and are reproduced by `npm run demo:integrability`.

## 7. Integrability Definition of Done for v1.1.0

Before a future `v1.1.0`:

1. Core remains unchanged and directly reusable.
2. `@nec/hub` exposes and documents the public v0.1 normalization contract and runtime implementation.
3. `@nec/lens` exposes and documents `lens-case/v0.1`, runtime validation, generic Hub builder, browser-safe projection and deterministic serialization.
4. NE Maps consumes a versioned case collection and accepts an additional conforming case without case-specific `app.js` logic.
5. The prepared synthetic/local fixture demonstrates Core -> Hub -> Lens -> Maps with `TARGET_CORE_MUTATIONS = 0`.
6. F1/F2/F3 preserve their reviewed verdicts, limitations, provenance and missing/unavailable states.
7. Tests, typecheck, fixture/manifests and fresh-clone gate are green.
8. Integration docs let a third-party developer use each layer without chat history.
9. Independent review is CLEAN.
10. No cloud service, DB, graph engine, generic A2A/MCP layer, wallet/signing/submission, policy engine, trust/confidence scoring, or new Core abstraction is introduced to satisfy this DoD.

## 8. Lot boundaries

LOT 1 froze the contracts. LOT 2 implements only the generic Hub/Lens runtime and synthetic proof described below.

LOT 2 is limited to:

```text
Core object/wire
-> @nec/hub runtime normalization
-> @nec/lens validator + generic builder + browser-safe projection + serialization
-> materialized synthetic/local proof artifacts
```

LOT 2 does not modify Maps behavior or migrate F1/F2/F3.

LOT 3 adds only the historical compatibility path described in section 5. It does not modify Core, `@nec/hub`, `@nec/lens`, Maps behavior or the frozen v1.0.0 `examples/core-hub-lens/` export.

LOT 4 changes only `examples/ne-maps/**` (generic loader/validator, derived collection, tests, docs), the typing of the optional `extensions.provenance` in the Maps envelope contract, and a root `maps:collection` script. It does not modify Core, `@nec/hub`, `@nec/lens`, `examples/historical-compat`, `examples/integrability-fixture` or the frozen reviewed `cases.json`.
