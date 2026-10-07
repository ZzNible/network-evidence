# v1.1 LOT 3 historical F1/F2/F3 compatibility path

The three reviewed historical cases are promoted under the public Hub/Lens
contracts without being rewritten:

```text
pinned public/authority fixture bytes
-> fresh offline public Core replay (existing resolvers/adapters)
-> fail-closed equality gate against the reviewed frozen semantics
-> promoted authority exact-fixture adapter (byte copy, authority 586a81a)
-> @nec/lens validateLensBrowserSafeCaseV01 + serializeLensBrowserSafeV01
```

| Case | Network | Fresh Core replay | Promoted adapter |
| --- | --- | --- | --- |
| F1 x402 #1062 partial | Base mainnet `eip155:8453` | `@nec/resolver-evm`, `@nec/resolver-opstack`, `@nec/adapter-x402` | `authority/lib/f1.mjs` |
| F2 ERC-4337 v0.6 exact UserOperation | Base Sepolia `eip155:84532` | `@nec/resolver-evm`, `@nec/adapter-erc4337` | `authority/lib/f2.mjs` |
| F3 x402-SVM exact partial | Solana mainnet | `@nec/resolver-solana`, `@nec/adapter-x402-svm` | `authority/lib/f3.mjs` |

Case-specific semantics stay in the promoted adapters. `@nec/hub` / `@nec/lens`
gain no case logic and no new semantics. This is exact-fixture compatibility,
not generic x402, ERC-4337 or Solana Hub ingestion.

## Preserved semantics

- **F1:** execution and data binding `supported`; historical OP Stack finality
  `insufficient` (`OP_ANCESTRY_DEPTH_EXCEEDED`); full x402 claim correlation
  `insufficient` (Hub field-presence check, `networkEvidenceAuthority: none`);
  settlement `unavailable` (availability state, not a verdict); observed
  transfer and service delivery carry no verdict; the issue timeout stays a
  source claim.
- **F2:** exact UserOperation `supported`; reviewed selector checks remain
  `supported` / `insufficient` / `contradicted` / `ambiguous`; finality and
  bundler provenance `unavailable`.
- **F3:** execution, payment and RPC-finalized Network Evidence finality
  `supported`; economic irreversibility not established; historical x402
  correlation `insufficient` as an operator-reviewed public-documentation limit
  with `networkEvidenceAuthority: none`; settlement `unavailable`.

The embedded Lens evaluator provenance remains the reviewed imported authority
(`localRecomputation: not_performed`). The fresh Core replay is recorded
separately in `data/proof-summary.json` (`coreReplay.localRecomputation:
performed`) and is an equality gate only; it never replaces or recomputes a
reviewed verdict.

## Reproduce

From repository root after `npm ci`:

```sh
npm run demo:historical-compat
npx vitest run examples/historical-compat
```

`demo:historical-compat` rebuilds all three cases, requires each browser
projection to be semantically and byte-identical to the reviewed 586a81a
projection pinned in `examples/ne-maps/data/cases.json` (`CASES.sha256`), runs
the four reviewed F2 selector checks, then verifies `data/` and `SHA256SUMS`.

Deliberate regeneration while developing this exact contract:

```sh
npx tsx examples/historical-compat/run.ts --write
```

Changed bytes require review.

## Regression guard

`compareHistoricalProjectionV01` / `assertHistoricalProjectionPreservedV01`
compare a candidate projection with the reviewed one and report
`verdict_strengthened`, `verdict_changed`, `basis_changed`,
`availability_changed`, `limitation_lost`, `provenance_lost`,
`provenance_changed`, `open_question_changed`, `relation_changed`,
`unauthorized_browser_field`, `exact_action_identity_changed`, or a
catch-all `semantic_drift`. Only the construction metadata `namespace` and
`createdAt` are excluded. `test/compat.test.ts` mutates each reviewed
projection to prove every category fails.

## Files

- `authority/` — byte copies of authority files, pinned by
  `AUTHORITY_SHA256SUMS`; `*.d.mts` are LOT 3 type declarations only.
- `compat.ts` — replay, equality gates, public Lens validation/serialization,
  regression guard.
- `run.ts` — materializer/verifier.
- `data/` — `f1|f2|f3.lens-browser.json` (public canonical bytes),
  `proof-summary.json`, `SHA256SUMS`.
- `PROVENANCE.md` — exact authority SHA, blob identities, exported subset.

`TARGET_CORE_MUTATIONS = 0`.
