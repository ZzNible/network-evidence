# @nec/lens

Minimal public Lens runtime for Network Evidence Suite v1.1 integrability.

Public surfaces:

```ts
validateLensCaseV01(value)
buildLensCaseFromHubV01(input)
projectLensBrowserSafeV01(caseValue)
validateLensBrowserSafeCaseV01(browserValue)
serializeLensCaseV01(caseValue)
serializeLensBrowserSafeV01(browserValue)
```

`buildLensCaseFromHubV01` is mechanical. It copies a Core Network Evidence
verdict only when Core supplied one, preserves the exact Core evidence bases,
and does not manufacture a verdict for not-applicable/unknown dimensions or
observed effects. There is no global case verdict, confidence/trust score,
policy decision, wallet/signing/submission authority, settlement inference, or
finality inference.

The generic runtime stores Core result identity in `coreResultPreservation`.
Its subject is a wire-safe projection: Core `blockNumber: bigint`, when present,
is represented as canonical decimal text so Lens-owned JSON is serializable.
The historical F1 `networkEvidence` field is not repurposed.

Browser projection is an explicit nested allowlist: raw locators and artifact
digests are withheld, source-native `value` payloads and assessment `inputRefs`
are omitted, unknown nested fields are not copied, and full observed effects,
warning bodies and conflict bodies are replaced by identifiers/codes.

Serialization uses `hub-json-sorted-keys/v0.1`, compatible with the reviewed Hub
sorted-key algorithm on its valid domain but with a stricter JSON-safe input
boundary (plain enumerable data only; no bigint, accessors, symbols, sparse
arrays, non-finite/-0 numbers, cycles or unpaired surrogates). The 8 MiB output
budget is enforced incrementally while serializing, before unbounded aggregate
output can accumulate.

`TARGET_CORE_MUTATIONS = 0`.
