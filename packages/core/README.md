# @nec/core

NEC v0.1 **core** (FREEZE R3): the pure, deterministic semantics that every
future NEC resolver (EVM, ZKsync-family, zkSYS) must share.

> **DOCUMENTATION AUTHORITY (R3).** The files under `reference/context/*`
> are HISTORICAL / SUPERSEDED DESIGN CONTEXT. They are not normative and are
> not maintained. The **current normative executable v0.1 contract** is this
> README plus the frozen ADRs under `docs/adr/` — with
> `docs/adr/0007-contract-closure-r3.md` adjudicating the R3 corrections and
> superseding any earlier statement it amends. Where an older ADR or any
> `reference/context` document disagrees with this README or ADR 0007, the
> README + ADR 0007 win.

Derived from `NEC_CONTRACTS_v0.1.md` with the adjudicated v0.1 freeze
decisions applied (see `docs/adr/0001..0007`; ADR 0006 is the four-surface
public-contract semantics pass, ADR 0007 the R3 contract-closure pass).

Zero runtime dependencies. Node >= 20. ESM. TypeScript strict.

## What core owns

- NEC contract types (freeze edition, R3)
- Explicit typed proposition scopes for conflict semantics
- THE normative applicability / verdict state machine, shared by the public
  composition helpers, fragment validation and full-result validation —
  with PER-CONTRIBUTION PROOF VALIDATION and NO proof laundering
- Closed v0.1 capability vocabulary (`CapabilityName`) and closed evidence-
  policy dimension vocabulary (`PolicyDimension`)
- ONE normative discovery composer (`composeDiscoveryMatch`) over FULL
  network-fingerprint context with deterministic evaluation reasons
- THREE-STATE policy-aware preflight composition with DERIVED readiness
  (`ready` must be derivable from the supplied capability context)
- EvidenceRequest (with the COMPLETE ActionDescriptor) -> Preflight ->
  Result digest-bound continuity chain, including ACTION continuity
- NEC-owned identifier grammar + opaque network-native identifiers
- Evidence basis vocabulary (exactly the five contract values)
- Network fingerprints, evidence refs, dimensions, snapshots, observed
  effects, conflicts, warnings, resolver manifests/policy refs
- Capability support vs. availability separation + manifest authority
- Canonicalization and digest profiles (`nec-canonical-json-v1`,
  `nec-digest-v1`) with two explicit result digests; `semanticDigest`
  BINDS the expected action
- Wire profile (`nec-wire-json-v1`) with schema-aware encode/decode and a
  raw parser that enforces the announced resource profile DURING parsing
- Opaque native-source payload boundary (`NativeSourcePayload`)
- Fail-closed validation for EVERY public data contract, immutable
  contextual artifact builders, and REQUIRED-CONTEXT claim verification

## What core explicitly does not own

No network I/O, filesystem, clock, randomness or environment access.
No Viem/EVM code, no x402/payment protocol, no wallet/keys/signing,
no database, no CLI, no MCP, no governance, no confidence or trust scores.
**No generic execution readiness**: wallet/account readiness, account
funding, gas acquisition, signing, transaction submission and generic
execution simulation are NOT preflight concepts in v0.1 (ADR 0007).

## Closed vocabularies (deliberately NOT extensible in v0.1)

- `CapabilityName`: exactly the capability slots of `CapabilitySnapshot` —
  `execution, observedEffects, dataBinding, settlement, finality` plus
  `executionModel, accountModel, gasModel, simulation, batching`.
  `CapabilityRequirement.capability` and
  `ResolverManifest.supportedCapabilities` accept nothing else; unknown
  capability strings fail closed. There is NO generic custom-capability
  escape hatch; a namespaced extension mechanism can only arrive with a
  versioned contract change.
- `PolicyDimension`: exactly `execution, observedEffects, dataBinding,
  settlement, finality` — the dimensions NEC can preflight and resolve.
  Unknown policy dimensions fail closed; no custom dimensions in v0.1.

## Capability claim authority

A `CapabilitySnapshot` is an observed/evaluated artifact, not a declaration
that becomes true because a resolver returned it:

- support = the resolver knows how to evaluate it; availability = required
  live sources are usable NOW. They stay distinct.
- **Manifest authority (R3, enforced in the CapabilitySnapshot
  builder/verifier itself, not only in Discovery):** the COMPLETE
  ResolverManifest is authoritative about what the resolver implementation
  knows how to evaluate. A snapshot MUST NOT claim `supported` or
  `conditional` for a capability absent from
  `manifest.supportedCapabilities`. Membership does NOT prove
  support/availability — it only permits evaluation; positive current
  capability claims still require live provenance.
- `capabilityIsUsable(state, evidenceTable)` (R3: CONTEXTUAL — there is no
  context-free usability helper) is true ONLY for supported + available +
  non-empty citations that RESOLVE against the supplied COMPLETE VALIDATED
  evidence table. A bare `evidence.length > 0` proves nothing; a ghost
  EvidenceId makes supported+available NOT usable.
- `buildCapabilitySnapshot(content, context)` REQUIRES the complete context
  `{resolver: ResolverManifest, networkId}` — the requested probe target
  plus the manifest — and enforces the manifest-authority invariant at
  construction time. Builders reject any snapshot whose network differs
  from the requested target, and snapshot resolver refs must match the
  complete manifest's id AND version AND digest.
- **Verification split (R3):** `verifyCapabilitySnapshotIntegrity(snapshot)`
  is the SELF-DIGEST/structural check and makes no claims. Contextual claim
  verification is `verifyCapabilitySnapshot(snapshot, context)` with
  REQUIRED context.

## Discovery: one normative composer

`composeDiscoveryMatch(requirements, candidate)` is the ONLY evaluation/
classification path used by builders and validators. Truth table (first
match wins):

```text
1 denylisted                                          -> ineligible
2 allowlist non-empty and network unlisted            -> ineligible
3 any REQUIRED requirement unsatisfied                -> ineligible
4 any REQUIRED requirement unknown                    -> ineligible
5 all REQUIRED satisfied and all DESIRED satisfied    -> eligible
6 otherwise                                           -> conditional
```

Denylist beats allowlist beats requirements; desired requirements only rank
eligible-vs-conditional. Requirement evaluations are deterministic:
`satisfied` iff the capability is USABLE (contextually, citations resolving
in the snapshot evidence table); `unsatisfied` iff deterministically negative
(unsupported/unavailable/degraded); `unknown` otherwise — never a silent
promotion, never a score. Evaluation `reason` fields are DETERMINISTIC
composer output; contextual verification requires stored evaluations to
reproduce them exactly (compared over NORMALIZED projections, so citation
permutations never fail comparison — genuine disagreement does).

Coherence gates (fail closed before any evaluation): the candidate snapshot's
network fingerprint must be CANONICALLY EQUAL to the candidate network (R3:
same networkId alone is insufficient — the full fingerprint is the context);
the snapshot resolver ref must exactly match the manifest; every
supported/conditional claim must be listed under
`manifest.supportedCapabilities`.

**Discovery evidence closure (R3):** every `EvidenceRef` used by a
discovery match must exist in the referenced CapabilitySnapshot evidence
table — matched by EvidenceId AND canonical equality of the COMPLETE ref.
The snapshot may be a superset; a caller may NOT keep the same EvidenceId
while replacing sourceId, locator, contentDigest, retrievedAt, networkId,
block position, metadata, nativeSource or independenceGroup.

Allowlist/denylist entries are validated as `NetworkId`s (the specialized
validator), never as loose strings. `CapabilityRequirement.constraints` is
NOT part of the v0.1 contract (removed in R3 — NEC has no constraint-
matching engine; unknown fields fail closed). A future version may add
typed constraints with explicit evaluators.

Builders verify every match against the complete supplied snapshots +
manifests and RECOMPUTE classification and evaluations through the
composer. Claim verification (`verifyDiscoverNetworksResult`) REQUIRES the
complete referenced snapshots and manifests.

## Policy-aware preflight truth table (THREE states)

Generic preflight means exactly: "Can NEC obtain the evidence REQUIRED by
this EvidencePolicy for THIS action on THIS network under the supplied
capability/resolver context?" `result.network.networkId ===
request.networkId` is enforced, and the overall status composes from
blockers + the bound policy's REQUIRED dimensions (first match wins):

```text
1 any blocker                                -> blocked
2 any REQUIRED dimension blocked             -> blocked
3 any REQUIRED dimension not_applicable      -> blocked
   (required dims cannot disappear)
4 otherwise any REQUIRED dimension unknown   -> unknown
5 otherwise every REQUIRED dimension ready   -> ready
   (vacuously true when nothing is required)
```

`PreflightStatus` is FROZEN to `ready | blocked | unknown`; **`partial`
was removed in R3**. Desired dimensions NEVER affect the overall status;
their individual readiness stays visible in `evidenceReadiness`. Blockers
can never coexist with ready.

**The caller does NOT author the overall status.** `buildPreflightResult`
recomputes it with the composer and rejects caller-supplied `status`
fields like self-digests; validators reject stored statuses that disagree.
**Builder-input type distinction (freeze-final):**
`PreflightResultContent` is the CALLER/BUILD input and excludes every
DERIVED field (`status` AND `artifactDigest`); the built `PreflightResult`
artifact carries the derived values. There is no optional-context build
path: `buildPreflightResult(content, context)` REQUIRES the complete
verification context (the complete ResolverManifest always; the complete
CapabilitySnapshot whenever one is referenced or any readiness is
claimed).

**Derived readiness (R3):** a dimension readiness of `ready` must be
DERIVABLE from the supplied CapabilitySnapshot / ResolverManifest context
and its cited provenance: the snapshot's capability state for that
dimension must be USABLE (supported + available + citations resolving in
the snapshot evidence table) AND the capability must be listed under
`manifest.supportedCapabilities`. **Readiness provenance binding
(freeze-final):** a ready check's own citations must be a NON-EMPTY SUBSET
of the validated CapabilityState evidence set used to derive readiness — a
ready conclusion may cite only the relevant subset of a larger capability
observation, but it may never cite an unrelated EvidenceRef, an empty set,
or evidence outside the justifying provenance. Desired/non-ready checks are
NOT required to fabricate evidence. Positive capability/readiness citations
must resolve. If generic core cannot derive a readiness claim, the check
is `unknown`, not `ready` — no execution-feasibility semantics were added
to fake derivability. The capability snapshot fingerprint used for
derivation is STORED/REFERENCED on the result and verified as the exact
context used (full fingerprint equality); a newer/stale fingerprint is
never silently substituted.

## PreflightResult identity (R3)

`PreflightRequest` carries `requestId: NecIdentifier` — the ONLY
preflight-request identity. `PreflightResult` embeds the COMPLETE request
and carries NO independent top-level id (the redundant `requestId` was
removed). `PreflightResultRef = { requestId: result.request.requestId,
digest: result.artifactDigest }`; validation/verifiers prove both. Two
PreflightResults for the same request share `requestId` but differ by
`artifactDigest` because observation/context/time differ.

## Request continuity chain (resolve surface)

`EvidenceRequest` carries a stable `requestId` and never digests itself.
It also carries the COMPLETE `ActionDescriptor` (R3). Every
`NetworkEvidenceResult` binds `request: {requestId, digest}` where digest
= `computeEvidenceRequestDigest(complete normalized request)` (dedicated
`evidence-request` domain) and carries the expected action as a SEMANTIC
field. With the complete artifacts supplied, builders/verifiers enforce:

```text
result.request      == computed ref of the bound request
result.requestId    == request.requestId
result.action       == request.action                (canonical equality)
result.network      == request network
result.subject      == request.subject               (canonical equality)
result.policy       == request.evidencePolicy
if request.preflight exists:
  preflight artifact fully verified WITH ITS OWN COMPLETE CONTEXT
  request.preflight.requestId == preflight.request.requestId
  request.preflight.digest    == preflight.artifactDigest
  preflight.request.networkId == request.networkId
  preflight.request.action    == request.action        (canonical equality)
  preflight.evidencePolicy    == request.evidencePolicy
```

Preflighting action A and then substituting request B cannot produce a
coherent-looking result: every link is digest-bound or canonically
compared. **This proves continuity of the EXPECTED ACTION only.** It does
NOT prove that an external execution produced the subject: whether
observed effects for the subject satisfy the expected action is an
evidence question for a resolver/protocol adapter. Core v0.1 does not
pretend action->subject causality is established without such evidence.
A request pairing a valid preflight with an unrelated subject is
structurally permitted as an evidence question and receives NO automatic
supported verdict.

The request reference participates ONLY in `artifactDigest` — the
semantic replay identity is unchanged by emission/correlation metadata.
The expected ACTION, however, IS bound into `semanticDigest`: same
subject/policy/evidence but a different expected action => different
semanticDigest (never rely on the request ref alone, which deliberately
excludes correlation metadata from replay identity).

## Verdict state machine (normative, single source)

For every proposition — enforced identically by the composer
(`composeVerdict`), fragment validation and full-result validation via ONE
shared helper (`assertNormativePropositionState`; no shadow truth table):

```text
applicability = "applicable"     -> verdict REQUIRED
applicability = "not_applicable" -> verdict MUST be absent
applicability = "unknown"        -> verdict MUST be absent

for an applicable proposition:
  supported     -> non-empty basis, non-empty evidence refs,
                   NO material conflict scoped to the proposition
  contradicted  -> same as supported
  ambiguous     -> non-empty basis, non-empty evidence refs,
                   >= 1 explicit material Conflict scoped to the proposition
                   (a result-scoped material conflict counts for every
                    proposition)
  insufficient  -> NO material conflict affecting the proposition
                   (basis/evidence may be empty)
```

**R3 composer semantics — validate each contribution independently BEFORE
aggregation; fail closed; never launder proofs:**

- **Complete closure (freeze-final):** every contribution is structurally
  validated and PROOF-checked BEFORE any ladder decision — an unknown
  contribution never shields a malformed positive one
  (`[valid unknown, malformed supported]` THROWS). Inputs are accepted
  only as INERT data under THE shared descriptor-first array model:
  caller-controlled getters, `Symbol.iterator`, `.map`/`.forEach`/
  `.entries` overrides can never influence composition, and no getter is
  ever invoked merely to reject input.
- The EvidenceRef index/table itself is fully validated first: complete
  refs only, map keys equal to `ref.id`, and DUPLICATE EvidenceIds
  REJECTED (never last-write-wins).
- EVERY supplied Conflict is completely validated before use — exact
  schema, explicit scope with the NEC identifier grammar for custom
  namespaces/ids, boolean material flag, unique conflict ids, and all
  cited EvidenceIds resolving against the validated index. A malformed
  conflict can never force `ambiguous`.
- Unknown runtime verdict strings are REJECTED (`"nonsense"` is never
  converted into `insufficient`).
- A `supported` / `contradicted` contribution requires applicability ==
  `applicable`, non-empty basis, non-empty EvidenceIds, and every cited id
  resolving against COMPLETE VALIDATED EvidenceRefs — otherwise the input
  is invalid and rejected (never silently downgraded).
- An `ambiguous` input must be justified by an explicit affecting material
  Conflict. An `insufficient` input must not coexist with one.
- **Supported proof + unproved contradicted input CANNOT produce
  contradicted** (and vice versa): unproven positive inputs never reach
  aggregation.
- Valid supported AND valid contradicted contributions for the same
  proposition with NO explicit material Conflict: FAIL CLOSED — the
  caller/resolver must represent the disagreement explicitly as a
  Conflict. With an explicit affecting material conflict the outcome is
  `ambiguous`, and the ambiguous basis/evidence may include the validated
  conflicting observations.
- **Provenance precision:** evidence belonging to a SUPPORTED contribution
  never becomes the provenance of a CONTRADICTED conclusion (or vice
  versa); the outcome's basis/evidence come only from contributions
  agreeing with the outcome verdict (plus conflict citations for
  ambiguous). Evidence is never globally unioned before choosing a
  verdict.
- Every composer output is re-checked against the same normative state
  machine used by artifact validation. **Single normative gate
  (freeze-final):** EVERY output branch — unknown, not_applicable,
  insufficient, supported, contradicted AND ambiguous — passes that ONE
  shared gate before returning; no branch returns before it. A forced-
  ambiguous outcome therefore still needs a non-empty basis from the
  considered observations (a conflict alone never fabricates basis) —
  otherwise composition fails closed.
- Ladder: empty inputs => unknown (+warning); all not_applicable =>
  not_applicable; any unknown input => unknown; affecting material
  conflict => ambiguous; otherwise aggregate (contradicted >
  all-supported > insufficient).

## Conflict semantic scope

EvidenceId overlap is PROVENANCE ONLY and never defines semantic scope.
Every `Conflict` carries an explicit `PropositionScope`:

```text
{ kind: "result" }                                   // affects every proposition
{ kind: "dimension", dimension: "execution" | ... }   // one fixed dimension
{ kind: "observed_effect", effectId }                 // one observed effect
{ kind: "custom", namespace, id }                     // extension point
```

Rules (fail closed):

- material conflict scoped to proposition P prevents `supported` /
  `contradicted` for P and requires `ambiguous`;
- a material conflict scoped to a different proposition does not affect P;
- result-scoped material conflicts affect every proposition;
- missing or invalid scope is rejected;
- scope is never inferred from shared EvidenceIds.

Source independence (v0.1): equal `independenceGroup` labels mean known
dependence; an absent group means independence is UNKNOWN; different labels
are NOT proof of independence. No majority vote exists anywhere in NEC.

## Two result digests

`NetworkEvidenceResult` carries TWO digests under separate explicit domains
(`network-evidence-result-semantic`, `network-evidence-result-artifact`):

| Digest | Binds | Excludes |
| --- | --- | --- |
| `semanticDigest` | schemaVersion, network, subject, **action**, policy ref, snapshot ref, dimensions, observed effects, evidence, conflicts, warnings, resolver ref | `requestId`, the bound request reference, `generatedAt`, both digests |
| `artifactDigest` | every logical field except itself (incl. `requestId`, the bound request reference, `generatedAt`, `semanticDigest`) | itself |

`semanticDigest` is the stable replay identity; re-verifying stored evidence
reproduces it; it BINDS the expected action (R3). `artifactDigest` is
logical artifact integrity; ANY mutation, including emission metadata,
breaks verification.

Set-like collections are canonically ordered inside all digest computations:
NESTED set-like children (citation/basis arrays) are normalized FIRST, then
the outer collection derives its deterministic order, then the digest is
taken — so input order never changes a digest at any nesting depth.
Duplicates are rejected (never silently discarded), and canonical order is
UTF-16 code-unit sort by identity key or canonical form (see ADR 0001 §6).
Truly ordered generic metadata arrays are NOT reordered.

## Verification surfaces (R3 naming contract)

Structural/runtime artifact validation and self-digest checks may operate
on one artifact; anything named as verifying the NEC claim/context requires
the complete context — there are NO optional context parameters on claim
verification:

| Surface | Self-digest only (no claims) | Contextual claim verification (REQUIRED context) |
| --- | --- | --- |
| CapabilitySnapshot | `verifyCapabilitySnapshotIntegrity(snapshot)` | `verifyCapabilitySnapshot(snapshot, {networkId, resolver})` |
| Discovery result | `verifyDiscoverNetworksResultIntegrity(result)` | `verifyDiscoverNetworksResult(result, {capabilitySnapshots, resolverManifests})` |
| Preflight result | `verifyPreflightResultIntegrity(result)` | `verifyPreflightResult(result, {resolver, capabilitySnapshot?})` — snapshot required at runtime when referenced or when any `ready` is claimed |
| Evidence result | `verifyNetworkEvidenceResultIntegrity(result)` / `...Semantics(result)` | `verifyNetworkEvidenceResult(result, {policy, snapshot, resolver, request[, preflight, preflightContext]})` |

## Cross-artifact coherence

Builders verify the ACTUAL artifacts behind references, not their shapes.
`buildNetworkEvidenceResult(content, context)` requires the complete
`{policy, snapshot, resolver, request[, preflight, preflightContext]}`
artifacts and enforces:

- policy/snapshot/resolver refs exactly match the provided artifacts
  (whose own self-digests are re-verified);
- the bound EvidenceRequest continuity chain (see above), including the
  complete preflight artifact — verified WITH its own complete context —
  whenever one is referenced;
- subject primary network == result primary network;
- snapshot `networkFingerprint` == result network context (canonical equality);
- snapshot `resolverManifestDigest` == computed manifest digest;
- snapshot `policyDigest` == computed policy digest;
- SNAPSHOT/RESULT EVIDENCE CLOSURE: every result `EvidenceRef` corresponds
  to an `EvidenceRef` in the referenced snapshot — matched by id AND by
  canonical equality of the COMPLETE ref (a result can never replace
  locator, retrievedAt, contentDigest, networkId, block position, metadata
  or nativeSource under an existing id). Snapshot evidence MAY be a superset
  of result evidence;
- cross-network evidence refs must carry an explicit snapshot anchor
  (cross-network evidence is ALLOWED; atomicity across anchors is NEVER
  implied — an anchor for one foreign network says nothing about another).

`buildDiscoverNetworksResult(content, context)` and
`buildPreflightResult(content, context)` are CLAIM-PRODUCING BUILDERS:
their complete context is a REQUIRED argument (no optional overload, no
compatibility shim — omitting it fails TS compilation for TS callers and
fails closed with `NecValidationError` at runtime). Discovery context must
contain the complete referenced CapabilitySnapshots AND the corresponding
ResolverManifests; preflight context the complete ResolverManifest (plus
the CapabilitySnapshot whenever referenced or needed to derive readiness).
`buildCapabilitySnapshot` likewise REQUIRES `{resolver, networkId}`.
Builders recompute every reference against the actual artifacts — a
digest-qualified ref alone is never treated as verification when NEC
claims to have checked an artifact it was actually given. A caller wanting
only structural validation uses the validators or the context-free
`verify*Integrity` self-digest checks.

## Canonicalization profile: `nec-canonical-json-v1`

Explicitly versioned INTERNAL profile. NOT RFC 8785/JCS.

- Objects: plain only (`Object.prototype` or null prototype); keys sorted by
  UTF-16 code-unit order; descriptor-first traversal (values are read from
  data descriptors, getters are NEVER invoked); accessor, symbol-keyed and
  non-enumerable properties rejected. Custom prototypes are rejected with a
  GENERIC error: rejection never inspects `value.constructor` or any other
  prototype-chain member (R3 — a `constructor` getter on the prototype is
  provably never invoked).
- Arrays: dense arrays with prototype exactly `Array.prototype`; holes,
  extra own properties, own symbol keys (including `Symbol.iterator`
  overrides), accessor indexes and subclasses rejected. Traversal is
  descriptor/index based — caller-controlled iteration surfaces of untrusted
  input are never invoked. This ONE inert-array model is shared by
  validation, canonicalization, cloning, ordering and digest normalization.
- Strings: JSON escaping identical to `JSON.stringify`; NO Unicode
  normalization; unpaired UTF-16 surrogates REJECTED (lossless UTF-8 only).
- Numbers: safe integers only; `-0` rejected. Bigints serialize as decimal
  tokens (schema-declared integer quantities only; GENERIC data such as
  metadata rejects bigint).
- `__proto__`: preserved as ordinary DATA via null-prototype records;
  prototype mutation is impossible.
- Cycles: rejected deterministically.
- Resource bounds (`nec-resource-limits-v0.1`) enforced during traversal:
  depth ≤ 64, nodes ≤ 50 000, container entries ≤ 10 000, strings ≤ 1 MiB
  UTF-8, canonical output ≤ 8 MiB UTF-8. Exceeding a bound throws a
  NEC-specific controlled error.

## Wire profile: `nec-wire-json-v1`

Distinct from the canonical profile. Schema-declared unbounded integer
quantities (every `blockNumber`) are `bigint` at runtime and CANONICAL
DECIMAL STRINGS on the wire (`"5318"`). Decimal-string constraints: ASCII
digits only, no `+`, no whitespace, no exponent, no leading zeros except
`"0"`, unsigned in v0.1.

Conversion is SCHEMA-AWARE: a declarative schema walks each artifact type and
converts exactly at declared positions — there is deliberately no global JSON
replacer/reviver heuristic. Generic metadata / generic `ObservedEffect.fields`
are JSON-safe NEC values and never contain bigint.

Decimal-digit bound: ONE rule (`MAX_DECIMAL_INTEGER_DIGITS = 1000`) applies
symmetrically to runtime bigint validation, wire encode AND wire decode for
schema-typed integer quantities. Ordinary decimal strings that are not
schema-typed integers are unaffected.

Schema membership uses exact OWN-PROPERTY checks only: an unknown field
named `constructor`, `prototype` or `__proto__` FAILS CLOSED on decode
(prototype-chain inheritance can never satisfy a schema lookup), while valid
own `"__proto__"` DATA survives encode → decode → re-encode byte-stably
(null-prototype records + explicit property definition).

**The public `parseNecWireJson` enforces the announced resource profile
DURING parsing (R3):** `MAX_DEPTH`, `MAX_TOTAL_NODES`,
`MAX_CONTAINER_ENTRIES` (arrays AND objects), `MAX_STRING_UTF8_BYTES`
(incremental guard plus exact UTF-8 check at string close) and the raw
`MAX_CANONICAL_BYTES` document bound. A hostile document can never
accumulate a 2 MiB string or a 10 001-member object just to be rejected
later in typed decode. Duplicate-key rejection and magic-key safety are
retained.

**Encoder output symmetry (freeze-final):** `encodeNecWireJson` enforces
the SAME `MAX_CANONICAL_BYTES` budget on the EMITTED wire document —
measured in exact UTF-8 bytes, not JavaScript string length — so
`decodeNecWireJson(type, encodeNecWireJson(type, artifact))` can never
fail solely because a successfully encoded artifact outgrew the public
byte budget. Exceeding it throws a controlled `NecWireError`
(`NEC_WIRE_ENCODE_FAILED`). Parser limits are never weakened.

Pipelines:

```text
inbound:  JSON bytes -> strict wire parse (bounds enforced while parsing)
          -> wire validation -> schema-aware decimal string -> bigint
          -> core validation
outbound: validated artifact -> core validation
          -> schema-aware bigint -> decimal string -> standard JSON
```

The bundled strict parser REJECTS duplicate JSON keys (standard
`JSON.parse` silently keeps the last duplicate and cannot enforce this),
unpaired surrogates, trailing content, and enforces the resource bounds.
Transports that parse JSON independently must match these guarantees before
handing documents to this profile.

## Native source payload boundary

Exact source-native content travels as an opaque `NativeSourcePayload`
attached to `EvidenceRef`:

- base64-encoded exact bytes; strict canonical base64 only;
- `contentDigest` binds the DECODED bytes under the dedicated
  `native-source-payload` domain and is re-verified during validation;
- decoded size ≤ `MAX_NATIVE_SOURCE_PAYLOAD_BYTES` (256 KiB): the ENCODED
  length is checked BEFORE decoded bytes are allocated, and the exact
  decoded length is verified afterwards (one documented decoded-byte limit);
- NEC never parses the inner fields — vendor terms such as `confidence`
  inside native bytes are inert data, never NEC scores;
- ordinary NEC metadata still rejects reserved score keys recursively
  (`confidence`, `trustScore`, `securityScore`, `probability`).

## Family-neutral identifiers

Core is network-family-neutral. NEC-OWNED identifiers (request ids —
including the preflight request id —, evidence ids, source ids/types,
resolver/policy/snapshot ids and versions, conflict/warning/blocker codes,
effect ids/types, action kinds, anchor roles, independence groups) follow
one intentionally boring ASCII grammar with NO silent normalization:

```text
[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}
```

Network-NATIVE identifiers are opaque, bounded canonical strings
(`NativeId`: `txId`, `blockId`, `genesisId`, `account`, `target`, batch
ids, custom subject values) and are deliberately NOT constrained by that
grammar: core validates bounds/well-formedness only (≤ 512 UTF-8 bytes),
and the resolver of a network family owns the detailed format. Generic hex
byte strings remain available as the `Hex` primitive: lowercase, `0x`
prefix, even digit count. Timestamps are exactly
`YYYY-MM-DDTHH:mm:ss.sssZ` with real calendar dates — no timezone aliases.
Optional fields must be ABSENT to be omitted; explicitly-`undefined`
fields fail closed. Builders reject caller-supplied self-digest fields
(and the preflight `status`) instead of overwriting them.

## Invariants enforced (tests)

1. `supported` requires resolvable, VALIDATED `EvidenceRef` backing — in
   artifacts AND per composer contribution.
2. Material conflicts block via EXPLICIT scope; EvidenceIds are provenance;
   supported-vs-contradicted disagreement without a conflict fails closed.
3. `not_applicable != insufficient`; normative applicability/verdict pairing.
4. Capability support != live availability; `conditional` support is never
   "usable"; claims absent from the manifest cannot exist.
5–7. Equivalent inputs → identical canonical form/digests; different bound
    inputs → different digests; both result digests bind per the declared
    profiles (semanticDigest binds the action); set-like collection order
    never changes digests.
8–9. No confidence score; no trust/security score (reserved keys rejected
    recursively; unknown top-level fields rejected).
10. Unknown/malformed data fails closed (`NecValidationError` /
    `NecCanonicalizationError` / `NecWireError`) — dangling provenance,
    duplicate ids, unknown fields, accessors, sparse arrays, cycles,
    unpaired surrogates, oversized inputs, fake evidence refs.
11. Evaluators are pure (source-hygiene test).
12. Conflicts/warnings stay explicit in output; duplicates never enter
    artifacts silently.
13. Builders never freeze or mutate caller-owned state; results are deep
    defensive copies frozen in place; exotic/custom-prototype roots (and any
    nested exotic object) are rejected BEFORE spread/read, so no getter is
    executed merely to reject input and no caller-owned object is frozen.
    Canonical rejection never reads `constructor` (getter-invocation-count
    regression pinned).
14. Golden vectors pin canonical bytes, digests AND wire text for
    cross-language reimplementation (`test/golden.test.ts`, ADRs 0001/0004;
    regenerated for R3 with the semantic `action` binding).
15. Resource bounds apply at EVERY entry point — INCLUDING during raw wire
    parsing (`parseNecWireJson` enforces depth/nodes/container/string/byte
    budgets while parsing, pinned at the exact 10 000/10 001 and 1 MiB
    boundaries).
16. Claim verification requires complete context on all four surfaces
    (R3); positive preflight readiness must be derivable from the supplied
    capability context AND cite a non-empty subset of the justifying
    CapabilityState evidence (freeze-final); discovery/preflight
    fingerprint equality is canonical, not id-based; discovery evidence
    closure is enforced.
17. Freeze-final closure: `composeVerdict` snapshots/validates every
    contribution before aggregation, rejects duplicate EvidenceRefs and
    malformed conflicts, and passes EVERY output branch through one
    normative gate; claim BUILDERS require complete context (no optional
    overloads); builder inputs are cloned descriptor-first BEFORE any read
    (no getter ever runs); discovery contextual comparison uses ONE
    normalized evaluation projection incl. `reason`; NEC-owned identifier
    grammar covers manifest source types and nested result refs;
    `capabilityIsUsable` is inert-read and duplicate-safe with exactly one
    index shape; the wire encoder enforces the parser's byte budget.
