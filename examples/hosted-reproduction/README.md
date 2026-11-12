# Hosted envelope reproduction harness

Offline, examples-level tooling to re-derive ONE hosted
`resolve_transaction_evidence` result (`structuredContent`,
`ne-mcp-observation-envelope/v0.1`) from the raw provider bytes it already
carries, plus a paced MCP capture client for a later campaign. Nothing under
`packages/*/src`, Core or `package.json` is changed; no new MCP tool or
envelope field exists.

| File | Role |
| --- | --- |
| `reproduce.ts` | Pure `reproduceObservationEnvelope(envelope: unknown)` → report. Fail-closed `evaluateReproductionCapture` decision and optional CLI over a capture file. |
| `capture-hosted.ts` | MCP SDK client (legacy + modern era), fixed call list, frozen `EXPECTED_OUTCOMES`, writes raw output. |
| `verify-live-before.ts` | Pure `verifyLiveDiscoveryEnvelope` / `verifyLivePreflightEnvelope` → report. Optional CLI over a capture file. |
| `verify-preflight-anchor.ts` | Pure `matchPreflightAnchor` and envelope wrapper `verifyPreflightAnchor` → anchor (c) report. No CLI, no MCP tool. |
| `verify-evidence-result.ts` | Pure `verifyEvidenceResultEnvelope({ envelope, evidenceContext })` → report on a served `evidenceResult`. Optional fail-closed CLI over `capture-action.ts` captures. No MCP tool. |
| `capture-action.ts` | Single-call MCP client for GT-02 steps 3 and 7: ONE `preflight_live_network_evidence` or `resolve_transaction_evidence` call per invocation, caller-authored input, writes `ne-hosted-action-capture/v0.1`. |
| `build-action-case.ts` | GT-02 step 9: offline, fail-closed builder from ONE verified resolve action capture to ONE generic single-case `ne-maps-case-collection/v0.1`, gated by the unchanged verify-CLI decision. No MCP tool. |
| `test/reproduce.test.ts` | EVM + Solana positives, null receipt, OP Stack supplement, fail-closed negatives. |
| `test/reproduce-cli.test.ts` | The reproduce CLI exit rule over the 14-call loopback capture and SIMULATED single-call edits of it. |
| `test/capture-loopback.test.ts` | Full call list in both eras against a loopback hosted-mode server; outcomes expected, envelopes reproduce or verify. Pre-call ingress POSTs pinned; a 307 is not followed. |
| `test/verify-live-before.test.ts` | Real discover/preflight envelopes verify; tampered ones never do. CLI exit rule. |
| `test/verify-preflight-anchor.test.ts` | REAL loopback negatives (never anchored), propagated envelope failures, SIMULATED pure-core cases, determinism. |
| `test/verify-evidence-result.test.ts` | SIMULATED_REPLAY_CLOCK loopback `evidenceResult` envelopes (verified, not composed), SIMULATED single-mutation negatives, differential check against the server composer, determinism. |
| `test/capture-action.test.ts` | SIMULATED_REPLAY_CLOCK loopback preflight + resolve captures through `capture-action.ts`, the verify CLI exit rule, context-digest, efda0ca-shaped, late-preflight and refusal negatives, determinism. |
| `test/build-action-case.test.ts` | SIMULATED_REPLAY_CLOCK loopback captures through `build-action-case.ts`: positive case, gate parity with the verify CLI, rebuilt-settlement refusal, labels, privacy, no strengthening, determinism, isolation of the shipped collection. |

All tests run with a fake provider `fetchFn` that serves the checked-in Base
mainnet (`packages/mcp/test/fixtures/base-mainnet-l2-finalized-positive-*.json`,
and the earlier F1 x402 #1062 probe transaction under
`examples/historical-compat/authority/fixtures/F1-x402-1062-partial/`),
Solana mainnet (`packages/resolver-solana/test/fixtures/solana-mainnet-x402-real.json`),
Base Sepolia (`packages/adapter-erc4337/test/fixtures/base-sepolia-external-v06-userop.json`)
and Solana devnet (`packages/resolver-solana/test/fixtures/solana-devnet-before-probe.json`)
capture bytes. The only other answers are SIMULATED `null`s for the made-up
SYNTHETIC-SUBJECT hash. Global `fetch` throws. No live network call is made by
any test.

## Live vs replay semantics

- **Live (hosted):** the server's `createMultichainTool` asked ONE fixed public
  RPC source at `acquiredAt`, recorded each response as a capture
  (`contentDigest` binds provenance + exact result text + `acquiredAt`),
  evaluated it with the existing resolver, and returned a Core
  `network-evidence-fragment` whose evidence refs carry the exact result bytes
  as `nativeSource` (base64; only when ≤ 256 KiB).
- **Replay (here):** the harness takes those bytes, and ONLY those bytes. It
  makes no provider request. It rebuilds the resolver fixture and replays it
  at the **hosted `acquiredAt`** through the existing
  `validate*Fixture` → `replay*` → `evaluate*` → `build*Fixture` functions.

### Algorithm (fails closed at the first broken binding)

1. Strict parse: inert JSON only, exact keys, the envelope literals,
   `subject.networkId` ∈ the 4 live ids (`eip155:8453`, `eip155:84532`, Solana
   mainnet, Solana devnet), ≤ 450 000 bytes. `claimAssessment` is refused
   (adapter-local, out of scope).
2. Every present `nativeSource` is checked with Core `verifyNativeSourceDigest`.
3. The hosted fragment must decode as a Core fragment. Its canonical
   `nec-wire-json-v1` bytes are the comparison basis.
4. Subject/network/source bindings: the envelope `subject` = fragment subject,
   `source.networkId` = the subject network, and for EVM `source.chainId` = the
   CAIP-2 reference.
5. Captures ↔ refs: equal counts. Each envelope capture maps to exactly one ref
   by `contentDigest` (1:1). Ref provenance, `retrievedAt`,
   `metadata.rpcMethod/httpStatus` and the `nativeSource` profile must match.
6. Request params are rebuilt from the ref `locator` under a per-method
   allowlist: `eth_chainId`, `eth_getTransactionReceipt`, `eth_getBlockByHash`,
   `eth_getTransactionByHash` (EVM), and `getGenesisHash`, `getTransaction`,
   `getSignatureStatuses`, `getBlock` (Solana). The params must re-render to
   the exact hosted locator, and subject-bearing params must equal `subject.txId`.
7. Fixture → validate → replay (EVM: `includeTransaction: true`,
   `requireAllCapturesUsed: true`; Solana replay is ordered and always consumes
   every capture) → rebuild the fixture from the replayed acquisition and require
   canonical equality → evaluate.
8. Compare every recomputed capture `contentDigest`, then capture metadata
   (`rpcMethod`, `acquiredAt`, `httpStatus`, `resultBytes`), the acquisition
   projection (`transactionObserved`, `transactionLookupUsable`/`solanaProbe`,
   `blockObserved`, `consistent`), and finally the canonical fragment wire bytes.

`reproduced` (reason `byte_identical`) is returned only when **all** of step 8
matches. It is never returned for a partial match.

### Report

```ts
{ status: "reproduced" | "diverged" | "not_reproducible", reason,
  firstDiffPointer?,                // RFC 6901 pointer into the envelope
  hostedFragmentDigest,             // sha256:<hex> of the hosted canonical wire bytes, or null
  reproducedFragmentDigest,         // sha256:<hex> of the replayed canonical wire bytes, or null
  opStackSupplement? }
```

The digests are plain SHA-256 over the UTF-8 wire text, so `sha256sum` can
recompute them independently. The report has no clock or random input, so two
runs over the same envelope give byte-identical reports (tested).

- `not_reproducible`: the material is missing, or the input is outside this
  harness. Reasons: `envelope_invalid`, `unknown_schema`, `unsupported_network`,
  `claim_assessment_out_of_scope`, `hosted_fragment_invalid`,
  `native_source_absent`, `rpc_method_not_allowlisted`, `fixture_rejected`,
  `harness_error`.
- `diverged`: the material is present but a binding does not hold, e.g.
  `native_source_digest_mismatch`, `subject_binding_mismatch`,
  `capture_ref_count_mismatch`, `locator_subject_mismatch`, `replay_rejected`,
  `capture_content_digest_mismatch`, `acquisition_projection_mismatch`,
  `fragment_wire_mismatch` (see `ReproductionReason`).

**`native_source_absent` is a valid observation, not a defect.** Resolvers
attach `nativeSource` only when the result is ≤ `MAX_NATIVE_SOURCE_PAYLOAD_BYTES`
(256 KiB), which can happen with a large Solana `getTransaction`. Such an
envelope is honest but cannot be reproduced offline.
`fixture_rejected` is the same kind of limit. For example, the Solana fixture
validator refuses result text containing URL-like or credential-like strings.

### OP Stack supplement (`includeL2Finality`)

The `opStackFinality` supplement carries capture digests and params but **no
raw response bytes** (`packages/mcp/src/live-evm.ts:310-315`). It is therefore
**always** reported as `not_reproducible` (`opstack_supplement_without_raw_bytes`),
whatever its status. Its `observedAt` is a separate, later read and is not
required to equal the envelope `acquiredAt`. Only these fields are echoed:
`verdictClass` (the finality verdict if evaluated, otherwise its `toolStatus`),
`anchoredBlockHash` (the supplement fragment's own Core anchor,
`network.observedAt.blockId`; it is not re-derived), and
`withdrawalFinalization` / `ethereumSettlement` = `not_evaluated`. The main
fragment's reproduction is independent of the supplement.

## Non-claims

- **Reproduction ≠ independent source verification.** A `reproduced` report
  shows only that the bytes in the envelope deterministically yield the same
  Core fragment under the reproducing commit's evaluator. The provider is not
  re-asked, a second source is not consulted, and the bytes are not proven to
  be what the chain holds.
- **Source-reported finalized ≠ cryptographic finality.** Solana `finalized`
  commitment and the OP Stack finalized head are one RPC source's view.
- **No settlement.** Nothing here establishes protocol payment settlement,
  Ethereum settlement, withdrawal finalization or economic irreversibility.
- A missing receipt or transaction reproduces as `insufficient`, never as
  `contradicted`, and never as proof of nonexistence (tested).
- This is not a full `NetworkEvidenceResult`, Hub composition or claim
  assessment.

## Acquiring executable vs reproducing commit

A reproduction involves two different executables, and both must be recorded:

1. **Acquiring executable**: the exact deployed image or commit that served
   the envelope. MCP does not authenticate this. Pass it to the capture client
   as `--acquiring-sha` from the deployment record. It is stored as
   `acquiringExecutable: { sha, declaredBy: "operator", verifiedByThisClient: false }`.
2. **Reproducing commit**: the commit of this harness (`git rev-parse HEAD`).
   Pass it as `--reproducing-commit` to the reproduce CLI, which echoes it next
   to the capture's acquiring SHA.

`reproduced` across two different SHAs means the reproducing evaluator yields
the same bytes. It does not mean the two executables are identical.
`diverged` across different SHAs can be an evaluator change, not tampering.
Report both SHAs with every result.

A capture from a different executable SHA whose envelope fails strict parsing
(an unknown key, literal, schema or shape) is reported `not_reproducible`. This
applies to `reproduce.ts` and `verify-live-before.ts` alike. It is never handled
by loosening a parser. A new envelope shape needs its own reviewed change.

### Reproduce CLI exit rule (`reproduce.ts --capture`)

The CLI only parses arguments, reads the file and prints. The decision is the
exported `evaluateReproductionCapture(capture, reproducingCommit)`. It makes no
network request and reads no clock or randomness. It loads `capture-hosted.js`
only by a dynamic import, for `assessCaptureOutcomes` and `CAPTURE_CALLS`, so
the static import graph of `reproduce.ts` stays free of the MCP client. The CLI
exits 0 only when ALL of the following hold:

1. `calls` is a non-empty array of calls with a string `id`, a string `tool` and
   a boolean `isError`.
2. Every call outcome is in `EXPECTED_OUTCOMES` (`assessCaptureOutcomes`).
3. Every non-error `resolve_transaction_evidence` report is `reproduced`, and
   the envelope `/subject` equals `CAPTURE_CALLS[id].arguments.subject` for its
   call id. The arguments recorded in the capture are never used for this
   check, so a real Solana envelope filed under `base-mainnet-pinned` is not
   counted for Base.
4. Each id in `REQUIRED_REPRODUCED_CALLS` (`base-mainnet-pinned` and
   `solana-mainnet-pinned`) has such a reproduced, subject-bound report.

Everything else exits 1. An errored call yields no report. So does an expected
`source_failure` such as `MCP_MULTICHAIN_SOURCE_FAILED`, and a capture with
such a failure on a required id exits 1. The `synthetic-base-mainnet-subject`
call (`observed_insufficient`) and the `base-mainnet-pinned-l2-finality` call
are allowed but not required. The OP Stack supplement is always
`not_reproducible` and never counts as reproduced. The report keeps the schema
`ne-hosted-reproduction-report/v0.1` and gains two fields. `outcomes` lists the
`assessCaptureOutcomes` entries. `missingReproduced` lists the required ids
that lack a reproduced, subject-bound report. Each `reports` entry also carries
`subjectBound`. Two runs print byte-identical output (tested).

Exit 0 shows only that this commit's evaluator re-derives the same Core
fragments from the bytes in the capture. It is not independent source
verification, finality or settlement. It closes no gate row: GT-04 and GT-06
stay OPEN.

## BEFORE envelope verification (`verify-live-before.ts`)

Both functions are pure: no network, clock, filesystem or randomness. The same
input gives a byte-identical report (tested). `verified` is returned only when
every check holds. Otherwise the status is `diverged` (material present, a
binding fails) or `not_reproducible` (strict parse or Core decode failed). An
optional `{ expected: call.arguments }` also binds the envelope to what the
capture actually sent.

`verifyLiveDiscoveryEnvelope` (`ne-mcp-live-discovery/v0.1`):

1. Strict parse: inert JSON only, ≤ 180 000 bytes, exact keys and literals, 1–3
   candidates on distinct live networks (`LIVE_BEFORE_MAX_CANDIDATES`, pinned
   by test to the server's constant), each with its fixed profile id and
   environment.
2. Core `decodeNecWireJson("discovery-result")` (includes the self-digest),
   then `verifyDiscoverNetworksResultIntegrity`. The Core `generatedAt` must
   equal the envelope's.
3. Each candidate binds to exactly one Core match by `networkId`, with equal
   `classification`, snapshot `digest` and snapshot `id`.
4. `0 ≤ generatedAt − observedAt ≤ LIVE_BEFORE_MAX_AGE_MS` (180 s), using only
   the envelope's own timestamps.
5. `contextualVerification` is always `context_not_returned`. Discovery returns
   snapshot digests, not the complete snapshots and manifests, so Core
   contextual verification cannot run here. It is never reported as verified.

`verifyLivePreflightEnvelope` (`ne-mcp-live-preflight/v0.1`):

1. Strict parse, as above. A missing `capabilitySnapshot` or `resolverManifest`
   is `not_reproducible`.
2. `choiceSource` must be `caller`, and `probeSubject.networkId` must equal
   `selectedNetworkId`.
3. Core decode of `preflight`, `capabilitySnapshot` and `resolverManifest`.
   Then `verifyCapabilitySnapshot` and `verifyPreflightResult` run against the
   returned context. The result's request network, network, snapshot digest
   and resolver digest must be bound to that context.
4. With `expected`, the canonical Core request must equal the request the
   capture sent.

`returned_context_verified` means the context returned by the same server is
internally Core-consistent. It is not independent source verification, wallet
or execution readiness, finality or settlement.

The CLI (`--capture capture.json`) exits 0 only when every call outcome is in
`EXPECTED_OUTCOMES`, every BEFORE report is `verified`, AND each of
`discover-mainnet`, `discover-three-candidates` and
`preflight-base-mainnet-probe` produced a `verified` report from its own tool,
AND class coverage is met. An errored call yields no report, so a capture whose
discovery or preflight ended in an (expected) `source_failure`, for example
`MCP_LIVE_BEFORE_UNAVAILABLE`, exits 1. Each report is bound to the fixed
`CAPTURE_CALLS` arguments of its call id, not to the arguments the capture file
records, so a testnet discovery filed under `discover-mainnet` does not verify.
The ids still lacking a verified report are listed in `missingVerified`
(tested).

Class coverage is a separate exit condition, reported as
`classCoverage: { callId: "discover-three-candidates", required: ["conditional",
"eligible", "ineligible"], observed: [{ networkId, classification }, …], met }`.
`observed` lists the bound candidates of the verified Discovery report(s) of
that call id; `met` is true only when they are exactly one `conditional`, one
`eligible` and one `ineligible`. Coverage never changes a report's status: a
verified envelope with another class set stays `verified`, with `met: false`
and exit 1 (tested). A met coverage shows only that one server returned one
Core result with the three classes for these probes; the `ineligible` Base
Sepolia path is a made-up subject, not proof of nonexistence or of network
unavailability.

## Pre-execution anchor verification (`verify-preflight-anchor.ts`)

Anchor (c) asks one question. Is the `artifactDigest` of an integrity-valid
Core `PreflightResult` committed as the EIP-3009 nonce (`topics[2]`) of exactly
one `AuthorizationUsed(address,bytes32)` log, emitted by the caller's declared
`action.target`, in a reproduced AFTER fragment? If the owner accepts anchor
(c), this check makes the GT-02 pre-execution proof mechanical. The verifier
does not perform, sign, simulate or presuppose any transaction. It adds no MCP
tool and closes no gate row. GT-02 stays OPEN.

- `matchPreflightAnchor(preflight, fragment)` is pure. It uses no network,
  clock, filesystem or randomness, and it works on detached Core copies of
  both artifacts.
- `verifyPreflightAnchor({ preflightEnvelope, afterEnvelope })` has two
  preconditions: `verifyLivePreflightEnvelope` must return `verified` and
  `reproduceObservationEnvelope` must return `reproduced`. Any other report
  is propagated with its status and reason unchanged; `stage` says which
  verifier produced it. Both strict parsers run unchanged, on a detached copy
  of inert input (or on the original input, which they then refuse). The
  anchor check must examine exactly the fragment bytes that were reproduced.

### Frozen check order (first failure wins)

1. Core `verifyPreflightResultIntegrity`. Core recomputes the digest; it is
   never reimplemented here. Otherwise `diverged:preflight_integrity_failed`.
   Then the fragment must be a valid Core `NetworkEvidenceFragment`, otherwise
   `not_reproducible:after_fragment_invalid`. This is an input guard of the
   pure function; a reproduced envelope always passes it.
2. `preflight.request.networkId` must equal `fragment.subject.networkId`,
   otherwise `diverged:network_mismatch`.
3. The subject must be an EVM (`eip155`) transaction, otherwise
   `not_applicable:non_evm_subject`.
4. AuthorizationUsed candidates are `evm.log` effects of the subject
   transaction that are not removed, have exactly three topics, and have
   `topics[0]` = keccak256(`AuthorizationUsed(address,bytes32)`), computed at
   runtime. If there is none: `not_anchored:no_authorization_used_log`.
5. Emitter binding: `action.target` must be a lowercase EVM address equal to a
   candidate's emitter (`fields.address`), otherwise
   `insufficient:emitter_unbound`. **This is a convention the verifier
   imposes, not a Core or code fact.** EIP-3009 does not tie a nonce to any
   declared action.
6. Among the bound candidates, count those with `topics[2]` = `0x` +
   hex(`artifactDigest`). Exactly one continues to step 7. Zero gives
   `not_anchored:nonce_digest_mismatch`. More than one gives
   `ambiguous:nonce_digest_multiple_matches`.
7. If `request.account` is present, `topics[1]` must be that address
   left-padded to 32 bytes, otherwise `diverged:authorizer_mismatch`.
8. Consistency check only. The anchored log's `blockHash` must be the
   fragment's anchor block, and that block must carry a timestamp, otherwise
   `insufficient:anchor_block_time_unavailable`. A missing block time is never
   treated as consistent. Then `preflight.generatedAt` must be ≤ the block
   time, otherwise `diverged:clock_inconsistent`.

If every check holds: `anchored:preflight_digest_committed_as_nonce`. Three
details go beyond the task's wording, and each one fails closed: the fragment
guard in step 1, the candidate restrictions in step 4 (subject transaction,
not removed, three topics), and `anchor_block_time_unavailable` in step 8.
`ANCHOR_CHECK_ORDER` lists the same order in code, and a test checks that this
list matches it.

### Anchor report

```ts
{ status, reason, stage,          // stage: "preflight_envelope" | "after_envelope" | "anchor"
  preflightArtifactDigest,        // Core-validated, or the claimed digest when integrity failed, or null
  observedNonce,                  // topics[2] of the single identified log, else null
  afterFragmentDigest,            // sha256 of the fragment's canonical wire bytes (= reproducedFragmentDigest), or null
  fixedBeforeExecution,           // true only when status is "anchored"
  nonClaims }                     // ANCHOR_NON_CLAIMS
```

The non-claims state:

- `anchored` does not prove that the effects match the action, or
  settlement, finality or any economic consequence.
- The emitter binding is a convention of this verifier.
- The verifier never makes `efda0ca` or any other existing AFTER
  `fixedBeforeExecution`.
- A nonce that has the width of a sha256 digest is not a preimage match.
- The timestamp comparison is a consistency check, not a proof of ordering.
- Reproduction is not independent source verification.
- Accepting anchor (c) is an owner decision.

### What the tests show

REAL negatives. All of these come from envelopes produced over loopback with
a pinned clock, from checked-in real capture bytes. Each asserts
`fixedBeforeExecution: false` and the status that the frozen order actually
produces:

| AFTER envelope | Caller preflight | Report |
| --- | --- | --- |
| Base USDC `0xcf496b…5afb` (nonce `0x4a0189…d0cd`) | Base mainnet, target `0x4200…0015` | `insufficient:emitter_unbound` (the emitter is the USDC token) |
| Base `0x71c9e27a…625c` | Base mainnet, target `0x4200…0015` | `not_anchored:no_authorization_used_log` (the receipt has no logs) |
| Solana mainnet `4DYWUMEx…LF71` | Base mainnet | `diverged:network_mismatch` (step 2 runs before step 3) |
| Solana mainnet `4DYWUMEx…LF71` | Solana mainnet | `not_applicable:non_evm_subject` |
| Base `0x71c9e27a…625c` | Base Sepolia (real `0xde8916c8…ed45` probe) | `diverged:network_mismatch` |
| Base USDC `0xcf496b…5afb` (nonce `0x4a0189…d0cd`) | Base mainnet, test-authored, target the USDC token `0x8335…2913`, account copied from the log's `topics[1]`, generated after the block time | `not_anchored:nonce_digest_mismatch` (step 5 passed and step 6 ran on real bytes; the nonce is not this preflight's digest) |

No real `anchored` case exists. The only `anchored` report comes from the
SIMULATED pure-core material (made-up subject under `eip155:31337`, labelled
`countsForGate: false`). That material also covers: a one-bit-flip twin, a
duplicated log, an emitter different from the target, a policy edited with a
stale `artifactDigest`, a different authorizer, and a block time before
`generatedAt`. The envelope wrapper is never driven to `anchored`. Doing so
would need real bytes under a live network id or a looser parser, and both
are out of scope. Two runs give byte-identical reports, global `fetch` is
never called, and no clock is read during verification (tested).

## Served evidenceResult verification (`verify-evidence-result.ts`)

`verifyEvidenceResultEnvelope({ envelope, evidenceContext })` checks the
optional `evidenceResult` of ONE `resolve_transaction_evidence` envelope
against the caller's own `evidenceContext` (`request`, `preflight`,
`capabilitySnapshot`). It does not depend on the server's composer. Its imports
are limited to node built-ins, `@nec/core`, `@nec/resolver-evm`,
`@nec/resolver-solana`, `@nec/adapter-x402` (allowed, not needed),
`./reproduce.js` and `./verify-preflight-anchor.js`. It never imports the MCP
server package or its source (tested). It is pure: no network,
clock, filesystem or randomness. `Date.parse` reads only timestamps carried by
the inputs. `reproduce.ts` and `verify-preflight-anchor.ts` are unchanged and
not loosened: `reproduceObservationEnvelope` still refuses an envelope that
carries `evidenceResult` (`envelope_invalid` at `/evidenceResult`, tested).

### Check order (first failure wins)

1. `envelope`: inert JSON data and ≤ 450 000 bytes for the whole envelope,
   otherwise `not_reproducible:envelope_invalid`. No `evidenceResult` gives
   `not_applicable:evidence_result_absent`.
2. `after_envelope`: on a detached copy with `evidenceResult` removed,
   `reproduceObservationEnvelope` must return `reproduced`. Any other report is
   passed on unchanged, so `claimAssessment` stays
   `not_reproducible:claim_assessment_out_of_scope`.
3. `evidence_result`: exactly `{status: "composed", artifactType:
   "network-evidence-result", preExecutionBinding: "core_preflight_continuity",
   result, evidenceSnapshot, resolverManifest, nonClaims}` (non-empty string
   array) or exactly `{status: "not_composed", reason}` with `reason` in
   `transaction_not_observed`, `block_not_observed`, `acquisition_inconsistent`,
   `block_timestamp_absent`, `preflight_not_before_block`, `output_budget`.
   Anything else is `not_reproducible:evidence_result_invalid`.
4. `context`: Core decodes `request`, `preflight` and `capabilitySnapshot`
   (≤ 64 KiB, no other key, `request.preflight` required). A decode or
   integrity failure is `not_reproducible:context_invalid`; an AFTER-only
   (`efda0ca`-shaped) request lands here. Then `diverged:context_mismatch`
   unless the request subject is the envelope subject, `request.preflight`
   references this preflight, the capability snapshot and the preflight verify
   against the locally pinned `evmBeforeResolverManifest()` /
   `solanaBeforeResolverManifest()`, and the action and policy are the
   preflighted ones.
5. `composition`, not composed: the reason is recomputed from the reproduced
   acquisition flags, the reproduced fragment's block timestamp and the
   caller's `preflight.generatedAt` (`preflight.generatedAt < block time`).
   A match is `not_composed_reproduced`, a mismatch
   `diverged:not_composed_unjustified`. `output_budget` is always
   `not_composed_unchecked` and never verified.
6. `composition`, composed, in this order: the recomputation must say
   composable (`diverged:composed_unjustified`); the served `resolverManifest`
   must be the local pinned family manifest, digest first, then every field
   (`diverged:manifest_not_pinned`); `result` and `evidenceSnapshot` must
   Core-decode; `result.requestId`, `action`, `policy` and `request` must match
   the caller request (`diverged:context_mismatch`); Core
   `verifyNetworkEvidenceResult` must hold with `{policy: request.evidencePolicy,
   snapshot, resolver: pinned manifest, request, preflight, preflightContext:
   {resolver, capabilitySnapshot}}` (both `diverged:result_verification_failed`);
   `result.subject/network/evidence/conflicts/warnings` must canonically equal
   the reproduced fragment's, `result.generatedAt` and `snapshot.createdAt`
   must equal the envelope `acquiredAt`, `snapshot.evidence` must canonically
   equal the reproduced fragment's evidence table (no superset), and
   `snapshot.anchors` must be exactly one `subject_block` anchor built from
   the fragment's `network.observedAt` (networkId, blockNumber, blockId,
   timestamp) (`diverged:context_mismatch`). `snapshot.networkFingerprint`,
   `resolverManifestDigest` and `policyDigest` are bound by Core. Only the
   snapshot `id` label is not compared.
7. No strengthening (`diverged:dimension_not_supported_by_fragment`): a
   dimension present in the reproduced fragment must equal the result's. An
   absent one must be exactly `{applicability: "unknown", basis: [], evidence:
   [], reason}`, where `reason` is exactly `<code>: <message>` of a warning the
   fragment itself carries and that declares that dimension (so it is prefixed
   by that code, with no free text after it). `observedEffects` must equal
   the fragment's. Which warning declares which dimension is a convention of
   this verifier, mirrored from the resolvers: `EVM_DIMENSIONS_NOT_EVALUATED`
   (settlement, finality, and its own `metadata.dimensions`) and
   `SOLANA_SETTLEMENT_NOT_EVALUATED` (settlement).

All checks pass: `verified:composed_result_verified`.

Core does not check result dimensions against the manifest's
`supportedCapabilities` (tested, AT7). A settlement verdict pasted into a
served result is refused by Core only through its self-digest
(`semanticDigest: self-digest mismatch`). The same verdict rebuilt by Core with
consistent digests passes `verifyNetworkEvidenceResult`. Only step 7 refuses
it. In the same way, Core accepts a digest-consistent snapshot whose evidence
table is a superset of the result's (for example the OP Stack supplement's
refs appended) or whose anchors are moved or extended, because it checks
anchors only for validity and for cross-network refs (tested). Only the
snapshot bindings of step 6 refuse those. These are recorded Core observations,
not Core changes.

### Report

```ts
{ status,                  // verified | not_composed_reproduced | not_composed_unchecked | diverged | not_reproducible | not_applicable
  reason, stage,           // stage: envelope | after_envelope | evidence_result | context | composition
  firstDiffPointer?,       // RFC 6901; context paths start with /evidenceContext
  servedStatus,            // composed | not_composed | null
  expectedOutcome,         // composable | the recomputed not_composed reason | null
  hostedFragmentDigest, reproducedFragmentDigest, resultArtifactDigest,
  anchor,                  // matchPreflightAnchor(preflight, reproduced fragment), verbatim, or null
  fixedBeforeExecution,    // anchor.fixedBeforeExecution, else false
  nonClaims }              // EVIDENCE_RESULT_NON_CLAIMS
```

`anchor` is a separate field, produced by the existing preflight-anchor matcher
once the context is bound. `fixedBeforeExecution` comes only from it, and it is
false on every path that is not `anchored`. The verification status never
depends on it. Two runs give byte-identical reports, global `fetch` is never
called, and no clock is read during verification (tested).

### What `verified` means

`verified` means two things: the AFTER envelope reproduced at the reproducing
commit, and Core contextual verification holds for the served result under the
caller's context and the locally pinned family manifest. It is **not**
precedence, policy satisfaction, independent source verification, settlement
or finality. Core preflight continuity is not precedence, and the
`generatedAt < block time` check is a rejection check on reported times.

**No real composed or anchored case exists.** Every BEFORE in the tests is
`SIMULATED_REPLAY_CLOCK` with `fixedBeforeExecution: false`: the Base preflight
probes the earlier F1 x402 #1062 transaction at a pinned
`2026-10-09T15:00:00.000Z`, and the Solana preflight is a SIMULATED null probe at
`2026-05-10T20:00:00.000Z`. Neither is a genuine caller action fixed before
execution. Every anchor report in the tests is `not_anchored` (Base) or
`not_applicable` (Solana). The `efda0ca`-shaped AFTER-only context is refused
by the server (`MCP_EVIDENCE_CONTEXT_NO_PREFLIGHT`) and by this verifier
(`context_invalid`); it is never verified and never a BEFORE. **GT-02 stays
OPEN.** This verifier closes no gate row.

### GT-02 operator sequence (documentation only; nothing here was executed)

Every step marked **HUMAN GATE** needs its own explicit owner GO. No step was
run, simulated as real or authorized by this example.

1. **HUMAN GATE (product decision):** the owner selects the NEW exact action,
   its network and the caller who authors it. Nothing is chosen here.
2. The caller authors an original `ActionDescriptor` and `EvidencePolicy` (a
   `PreflightRequest`) before any execution.
3. **HUMAN GATE (hosted run, Q3; approved exact deployed commit):** the caller
   calls `preflight_live_network_evidence` on the approved endpoint and keeps
   `preflight` and `capabilitySnapshot` as returned. One invocation, one
   session, one call, with the caller's own request file
   (`{selectedNetworkId, probeSubject, request}`):

   ```sh
   tsx examples/hosted-reproduction/capture-action.ts --mode preflight --url https://<approved host>/mcp \
     --request preflight-arguments.json --out preflight-capture.json --acquiring-sha <approved deployed sha>
   ```

   The capture holds the caller-authored `PreflightRequest` (including any
   `account` and `metadata`). It is private by default and not publishable
   without review.
3a. Offline, before the irreversible step 5, at a recorded reproducing commit
   (`git rev-parse HEAD`): check the preflight capture against the caller's
   own request file and the locally pinned family manifest
   (`evmBeforeResolverManifest()` / `solanaBeforeResolverManifest()`), see
   "Action preflight check" below:

   ```sh
   tsx examples/hosted-reproduction/verify-action-preflight.ts --preflight-capture preflight-capture.json \
     --request preflight-arguments.json [--anchor-c-readiness]
   ```

   Exit 0 only when the capture is a non-error `preflight` action capture,
   `verifyLivePreflightEnvelope` verifies it against the request file (never
   against the arguments the capture records), and the served
   `resolverManifest` is exactly the pinned one. A drifted manifest that is
   still internally Core-consistent is refused here
   (`diverged:manifest_not_pinned`). With `--anchor-c-readiness` it also needs
   an `eip155` network, a lowercase `0x` address as `action.target` and, if
   declared, as `account`. Exit 0 is not authorization to execute, not
   precedence, not policy satisfaction and not wallet or gas readiness. The
   report always says `fixedBeforeExecution: false`; whether anchor (c) counts
   stays the owner decision of the next step. It closes no gate row.
4. Optional, **HUMAN GATE (owner decision whether anchor (c) counts):** commit
   the preflight `artifactDigest` as the EIP-3009 nonce of the action.
5. **HUMAN GATE (real transaction, signing, funding or spending):** the caller
   executes the action with its own wallet. Network Evidence never signs,
   funds or submits.
6. The caller builds the `EvidenceRequest` with the subject, the same action
   and policy, and `preflight: {requestId, digest}`.
7. **HUMAN GATE (hosted run, Q2/Q3; approved exact deployed commit):** the
   caller calls `resolve_transaction_evidence` with that `evidenceContext` and
   records the raw envelope with the acquiring SHA. One invocation, one
   session, one call:

   ```sh
   tsx examples/hosted-reproduction/capture-action.ts --mode resolve --url https://<approved host>/mcp \
     --network-id <caip-2 id> --tx-id <tx hash or signature> --context evidence-context.json \
     --out resolve-capture.json --acquiring-sha <approved deployed sha>
   ```

   The context content is not recorded. The capture keeps only
   `contextSha256`, a canonical-bytes digest, never a digest of the wire bytes.
   Keep `evidence-context.json` privately with the capture; step 8 needs it.
8. Offline, at a recorded reproducing commit (`git rev-parse HEAD`):
   `verifyEvidenceResultEnvelope` and `verifyPreflightAnchor` on the recorded
   envelopes, through the fail-closed CLI:

   ```sh
   tsx examples/hosted-reproduction/verify-evidence-result.ts --capture resolve-capture.json \
     --context evidence-context.json --preflight-capture preflight-capture.json [--require-anchored]
   ```

   Exit 0 only for `verified:composed_result_verified`. `--require-anchored`
   also needs anchor (c) `anchored`; whether that counts is the owner decision
   of step 4.
9. Offline, on the same inputs as step 8: Hub admission, Lens and ONE generic
   single-case NE Maps collection from the verified result, built only when the
   step-8 decision is `composed_result_verified` (see "Action case builder"
   below). It closes no gate row:

   ```sh
   tsx examples/hosted-reproduction/build-action-case.ts --capture resolve-capture.json \
     --context evidence-context.json --preflight-capture preflight-capture.json [--require-anchored] \
     --case-id <id> --created-at <ISO> --out case-collection.json
   ```

   The output is private by default. **HUMAN GATE (public publication or
   sensitive merge):** publishing any produced case.
10. **HUMAN GATE (owner):** the decision to mark GT-02 DONE. It stays OPEN here.

## Capture client

```sh
tsx examples/hosted-reproduction/capture-hosted.ts --url https://<host>/mcp --out capture.json \
  [--pacing-seconds 75] [--era modern|legacy] [--acquiring-sha <sha>]
tsx examples/hosted-reproduction/reproduce.ts --capture capture.json [--reproducing-commit <sha>]
tsx examples/hosted-reproduction/verify-live-before.ts --capture capture.json
```

- `--url` is **required**; there is no default. Only `https://` or loopback
  `http://` (127.0.0.1, localhost, [::1]) is accepted, without credentials,
  query or fragment.
- The `--url` path is written verbatim (as the parsed URL's normalised `href`)
  into the capture's `target` field. Never put a token or other secret in the
  path: publishing the capture publishes it.
- A 307 answer from `--url` is not followed: the capture fails and no request
  reaches the redirect target (loopback-tested; this client adds no redirect
  handling of its own, the MCP SDK transport already behaves so). Other 3xx
  codes are not tested.
- `--out` is required. An existing file is never overwritten.
- Pacing: for non-loopback targets, tool calls are spaced at least **75 s**
  apart (`MIN_PACING_SECONDS`; the hosted live budget is 8 calls/min). Lower
  values are refused before any request is sent.
- Fixed call list (not configurable; client version `0.3.0`), 14 calls:
  - `list_network_profiles`.
  - Real multichain AFTER: the pinned Base mainnet tx `0x71c9e27a…625c`
    without and with `includeL2Finality`, and the pinned Solana mainnet
    signature `4DYWUMEx…LF71`.
  - Testnet parity: the pinned Base Sepolia tx `0xde8916c8…ed45` and Solana
    devnet signature `4D3WXyMK…kFpJ`.
  - BEFORE/Discovery: `discover_live_network_evidence` over {Base mainnet,
    Solana mainnet} and over {Base Sepolia, Solana devnet}.
  - Three-class Discovery (`discover-three-candidates`): one
    `discover_live_network_evidence` call, same requirements, over the pinned
    Base mainnet tx, the pinned Solana mainnet signature and a made-up Base
    Sepolia hash (`SYNTHETIC_BASE_SEPOLIA_TX`). Labelled SYNTHETIC-SUBJECT on a
    live target ("not-found is not proof of nonexistence or of network
    unavailability") and SIMULATED on loopback. On loopback it gives Base
    mainnet `conditional`, Base Sepolia `ineligible` and Solana mainnet
    `eligible` in one Core result (11 provider reads).
  - A separate `preflight_live_network_evidence` with the caller choice
    `eip155:8453` on the pinned Base tx. Its request is labelled
    "capture-client-authored probe, no action executed, not the
    NEW-exact-action item" (in `request.metadata` and in the call `label`). It
    is not the NEW exact action.
  - Input refusals before any RPC: an `eip155:57057` subject (refused by the
    MCP input schema), a malformed Solana signature and `includeL2Finality` on
    a Solana subject (both `MCP_MULTICHAIN_INPUT`).
  - One well-formed, made-up Base mainnet hash, labelled SYNTHETIC-SUBJECT on
    a live target and SIMULATED on loopback.
- `EXPECTED_OUTCOMES` (frozen) gives each call id its allowed outcome set from
  a closed vocabulary (`classifyCallOutcome`): `observed`,
  `observed_insufficient` (the source did not return the transaction: absent,
  pruned or made up), `source_failure` (typed source/probe code),
  `input_refusal` (typed input code or the SDK input-schema refusal). Testnet
  resolves allow `observed`, `observed_insufficient` or `source_failure`.
  `observed_contradicted` and `unclassified` (rate limit, deadline, size,
  internal) are allowed for no call. The made-up subject allows only
  `observed_insufficient` or `source_failure`. `discover-three-candidates`
  allows `observed` or `source_failure`.
- `tools/list` is captured in both the legacy and modern protocol eras. The
  calls run in one era (`--era`, default modern), and the era actually
  negotiated is enforced. Calls in both eras need two runs.
- The client has no RPC egress of its own. It only talks MCP to `--url`.

### Budget arithmetic (one run, one call era)

| Quantity | Value |
| --- | --- |
| Tool calls | 14 (1 offline, 3 refused before admission, 10 live) |
| Live acquisitions (shared multichain admissions) | 14: 6 resolves + 2 × 2 + 3 Discovery subjects + 1 preflight |
| Max admissions in one 60 s window | 3 (the three-subject Discovery call) vs `MULTICHAIN_CALLS_PER_MINUTE = 8` |
| Max in flight from this client | 1 (calls and Discovery subjects are sequential) vs `MULTICHAIN_MAX_INFLIGHT = 2` |
| Minimum wall time | (14 − 1) × 75 s = 975 s (16 min 15 s), plus call time (each live call ≤ 35 s deadline) |
| Approximate public RPC reads | ≤ 68: Base mainnet 23 + ≤ 14 OP Stack reads, Solana mainnet 12, Base Sepolia 11, Solana devnet 8 (each made-up hash counted as not found: 3 reads) |
| HTTP ingress POSTs to `/mcp` before the first `tools/call` | 6 (`--era modern`), 7 (`--era legacy`) |
| Minimum HTTP ingress quota a target must allow | 7/min (`--era modern`), 8/min (`--era legacy`) |

With 75 s pacing every call starts in a fresh 60 s window, so the per-minute
live budget is never the limiting factor. A not-found subject makes fewer reads
(3 instead of 4 on Base). The loopback test drives the same pacing with a faked
`Date`.

**HTTP ingress is not paced before the first tool call.** The two `tools/list`
clients and the call client's handshake send their POSTs back to back:
`initialize`, `notifications/initialized` and `tools/list` (legacy era), then
`server/discover` and `tools/list` (modern era), then the call client's
handshake (`server/discover` for `--era modern`; `initialize` and
`notifications/initialized` for `--era legacy`). The loopback test pins this
exact sequence. The first `tools/call` follows with no sleep. A target must
therefore admit the pre-call POSTs plus that first call in one minute, which is
the minimum quota in the table. After that, the calls are ≥ 75 s apart, so
each later 60 s window holds at most one of them. These minimums assume no
other client shares the window. Non-POST requests are not counted; SEC-01
source does not charge a 405 refusal
(`packages/mcp/test/hosted-ingress-budget.test.ts` T3). Non-POST requests are
not measured here either, so a target that charges every request needs a higher
minimum. Concurrency needs are not measured here.

`docs/distribution/CLOUD_RUN_FREE_PREVIEW_RUNBOOK.md:250` records
`NE_MCP_RATE_LIMIT_PER_MINUTE=4` and `NE_MCP_MAX_CONCURRENT=1` for the beta
revision it describes. Both minimums above exceed that recorded 4/min. This
README makes no other claim about any deployed endpoint. Raising a quota or
changing the handshake pacing is not part of this example.

### Human gate (Q3)

Running the capture client against any non-loopback endpoint stays a separate,
human-gated step (Q3). This example, its tests and its README do not authorize
a deployment, a public endpoint or a campaign. All tests here run on loopback
only.

## Single action capture (`capture-action.ts`) and the verify CLI

Operator tooling for GT-02 steps 3, 7 and 8 (see the operator sequence above).
It closes no gate row. GT-02 stays OPEN. Running it against any non-loopback
endpoint is the same human-gated Q3 step as the capture client; every test
runs on loopback only.

```sh
tsx examples/hosted-reproduction/capture-action.ts --mode preflight --url <url> --request <file> --out <file> \
  [--era modern|legacy] [--acquiring-sha <sha>]
tsx examples/hosted-reproduction/capture-action.ts --mode resolve --url <url> --network-id <caip-2> --tx-id <id> \
  --context <file> --out <file> [--era modern|legacy] [--acquiring-sha <sha>]
tsx examples/hosted-reproduction/verify-evidence-result.ts --capture <resolve capture> --context <file> \
  [--preflight-capture <preflight capture>] [--require-anchored]
```

### Capture (`ne-hosted-action-capture/v0.1`)

- One invocation opens ONE MCP session and makes exactly ONE `tools/call`
  (tested by counting the POSTs). The input is the caller's file, never
  authored by this client. There is no pacing: the operator spaces
  invocations within the hosted budget.
- Target rules are the capture client's (`assertCaptureTarget`): `https://` or
  loopback `http://` only, no credentials, query or fragment. Refusals happen
  before any request (tested). `loopback` is derived from the `--url` hostname
  only. A non-loopback URL is not evidence of an authentic hosted server.
- A 307 answer is not followed (loopback-tested; the SDK transport fails and
  this client adds no redirect handling). The requested `--era` must be the
  negotiated era.
- `--acquiring-sha` follows the capture client's rule and is stored as
  `acquiringExecutable: { sha, declaredBy: "operator", verifiedByThisClient: false }`.
- `--out` is never overwritten. An existing file is refused before any
  request, and the write uses `wx`.
- Shape: `{schema, mode, target, loopback, callEra, protocolVersion,
  serverVersion, acquiringExecutable, client, privacy, call: {tool, arguments,
  contextSha256?, isError, structuredContent, content?}, nonClaims}`.
  `serverVersion` is server-reported and unauthenticated.
- `--mode preflight`: `preflight_live_network_evidence` with the request file
  (`{selectedNetworkId, probeSubject, request}`). `call.arguments` and the raw
  envelope are recorded verbatim. `privacy.containsCallerPreflightRequest` is
  true, and a non-claim states that the capture contains the caller-authored
  `PreflightRequest` (including any `account` and `metadata`), is private by
  default and is not publishable without review.
- `--mode resolve`: `resolve_transaction_evidence` with `{subject,
  evidenceContext}`. `call.arguments` records `{subject}` only. The
  evidenceContext is recorded ONLY as `call.contextSha256` = `sha256:` + hex
  SHA-256 over `@nec/core` `canonicalJsonBytes(evidenceContext)`
  (`nec-canonical-json-v1`): a canonical-bytes digest, never a digest of the
  wire bytes. A whitespace-only reformat of the context file keeps it. A
  test shows that the serialized capture contains none of the context's
  account, metadata, preflight or snapshot strings. The served envelope still
  carries the subject and the request's action and policy, so the capture is
  private by default too.
- No capture field asserts precedence: there is no `clientObservedAt` and no
  `fixedBeforeExecution`. No client clock is read into the capture.
- Exit: 0 when the tool returned a result; 1 when the written capture records
  `isError` (for example `MCP_EVIDENCE_CONTEXT_NO_PREFLIGHT`); 1 for every
  refusal before a request.
- `capture-hosted.ts` changed only by adding `MCP_EVIDENCE_CONTEXT_INVALID`,
  `MCP_EVIDENCE_CONTEXT_NO_PREFLIGHT`, `MCP_EVIDENCE_CONTEXT_CALLER_MANIFEST`
  and `MCP_EVIDENCE_CONTEXT_TOO_LARGE` to its input-refusal codes, so such a
  refusal classifies as `input_refusal`. `CAPTURE_CALLS` (14),
  `EXPECTED_OUTCOMES`, client `0.3.0` and `ne-hosted-capture/v0.1` are
  unchanged.

### Verify CLI (`verify-evidence-result.ts`)

The CLI reads its files and calls the unchanged pure verifiers. It makes no
network request. In order:

1. `--capture` must be a `resolve` action capture carrying a `contextSha256`,
   otherwise `capture_invalid`.
2. The canonical `contextSha256` of the `--context` file is recomputed. A
   mismatch exits 1 with `context_digest_mismatch` before any verification
   (`report: null`).
3. `verifyEvidenceResultEnvelope({ envelope: call.structuredContent,
   evidenceContext })`, report verbatim. Anything other than
   `verified:composed_result_verified` is `not_verified`.
4. With `--preflight-capture`: it must be a `preflight` action capture
   (`preflight_capture_invalid`). `verifyPreflightAnchor` runs on its envelope
   and on the AFTER envelope without `evidenceResult` (which
   `reproduceObservationEnvelope` would refuse). It must reach stage `anchor`
   with the same preflight `artifactDigest` and fragment digest as the
   context-bound anchor, otherwise `preflight_capture_unbound`.
5. With `--require-anchored`: the anchor (and the preflight-capture anchor,
   when given) must be `anchored`, otherwise `not_anchored`.

Exit 0 only for `composed_result_verified`. Every other reason, and any
unreadable file, exits 1. The printed report
(`ne-hosted-evidence-result-cli-report/v0.1`: `acquiringExecutable`,
`requireAnchored`, `contextSha256 {recorded, recomputed, match}`, `report`,
`preflightAnchor`, `exitCode`, `exitReason`) has no clock or path input, so
two runs print byte-identical output (tested).

### What the loopback tests show

All under `SIMULATED_REPLAY_CLOCK`, with a TEST-AUTHORED request and
`fixedBeforeExecution: false` throughout. The preflight runs at a pinned
`2026-10-09T15:00:00.000Z`, before the subject block
(`2026-10-09T15:24:33.000Z`). The resolve runs at `2026-10-09T15:42:11.665Z`.

- The preflight capture passes `verifyLivePreflightEnvelope` with `expected` =
  the request file.
- The resolve capture plus its context: CLI exit 0, `verified`, anchor
  `not_anchored`, `fixedBeforeExecution: false`.
- Exit 1 or refused: one changed context value (`context_digest_mismatch`);
  the `efda0ca`-shaped AFTER-only context (server
  `MCP_EVIDENCE_CONTEXT_NO_PREFLIGHT`, `isError` recorded, `input_refusal`);
  a preflight after the block time (`not_composed_reproduced:
  preflight_not_before_block`, never verified); `--require-anchored` on a
  `not_anchored` report; an existing `--out`; a credentialed or non-https URL
  before any request.

None of this is a genuine caller action fixed before execution. No real
composed or anchored hosted case exists.

## Action case builder (`build-action-case.ts`)

Operator tooling for GT-02 step 9 (see the operator sequence above). The
builder closes no gate row. GT-02 stays OPEN. Running it on a non-loopback
capture is downstream of the human-gated Q2/Q3 steps (3 and 7): it needs a
capture that only those steps can produce. Every test runs on loopback
captures only.

```sh
tsx examples/hosted-reproduction/build-action-case.ts --capture <resolve action capture> --context <file> \
  [--preflight-capture <file>] [--require-anchored] --case-id <id> --created-at <ISO> --out <file>
```

- `--case-id` (NE Maps case id rule) and `--created-at` (canonical UTC
  ISO-8601) are required. The only Lens `createdAt` is `--created-at`; no
  `Date` is read during the build.
- `--out` is never overwritten. An existing file is refused before any file is
  read or verified, and the write uses flag `wx`.
- Gate: `evaluateEvidenceResultCapture` from `verify-evidence-result.ts`, the
  verify CLI's own decision over parsed inputs (the CLI `main` now only parses
  arguments, reads files and prints; its output is unchanged). Only exitReason
  `composed_result_verified` builds. For every other exitReason
  (`capture_invalid`, `context_digest_mismatch`, `not_verified`,
  `preflight_capture_invalid`, `preflight_capture_unbound`, `not_anchored`
  with `--require-anchored`), the builder exits 1 with the identical exitReason
  and writes nothing. The printed report
  (`ne-hosted-action-case-build-report/v0.1`) carries the verify-CLI report
  verbatim as `verification`.
- Path after the gate, generic and family-agnostic: the served result wire →
  Core `decodeNecWireJson("network-evidence-result")` (its `artifactDigest`
  must be the verified one) → `@nec/hub` `normalizeNetworkEvidenceV01`
  (`nec_wire_json_v1`) → `@nec/lens` `buildLensCaseFromHubV01` →
  `projectLensBrowserSafeV01` → `validateLensBrowserSafeCaseV01` →
  `validateNeMapsCollectionV01`. The builder computes no verdict, evidence or
  edge. Propositions, assessments, availabilities and their order are
  Lens's. Its imports are node built-ins, `@nec/core`, `@nec/hub`,
  `@nec/lens`, `./verify-evidence-result.js` and `../ne-maps/collection.js`
  only. It never imports the MCP server or either capture client (tested).
- Labels: `loopback` is re-derived from `capture.target` by the same hostname
  test (127.0.0.1, localhost, [::1]). A mismatch with `capture.loopback` is
  refused (`loopback_label_mismatch`, exit 1, nothing written). A loopback
  capture is labelled "loopback replay (SIMULATED host), not a hosted
  observation". A non-loopback capture is labelled "operator-declared hosted
  capture; acquiringExecutable declaredBy operator, verifiedByThisClient
  false; a non-loopback URL is not evidence of an authentic hosted server".
  The capture `target` itself is never copied.
- `extensions.provenance` (strings only): `acquiringExecutable` (JSON text of
  the capture's value, verbatim), `contextSha256`, `resultArtifactDigest`,
  `anchor` (JSON text of `{status, reason}`), `fixedBeforeExecution` (the CLI
  report's value as a string), `anchorAcceptance: "owner decision (anchor
  (c))"`, `compositionRule: "as implemented by the serving composer; owner
  ratification is not asserted by this tool"` and `gateRow: "GT-02 stays OPEN;
  closure is an owner decision"`.
- The Lens limitations always include "Core preflight continuity is not
  precedence and not policy satisfaction" and the label. The collection
  `nonClaims` include `EVIDENCE_RESULT_NON_CLAIMS` verbatim.

The output is private by default. Publishing any produced case is a separate
**HUMAN GATE** (public publication or sensitive merge). The shipped
`examples/ne-maps/data/collection.json` is never touched (tested).

### What the loopback tests show

All under `SIMULATED_REPLAY_CLOCK`, with a TEST-AUTHORED request, over the
checked-in Base mainnet `0x71c9e27a…d625c` and F1 #1062 probe bytes, at the
same pinned times as `test/capture-action.test.ts`.

- Positive: exit 0. The output passes both validators. The Lens
  `sourceArtifactDigest` and `sourceSemanticDigest` equal the served result's.
  Execution keeps its Core verdict. Settlement and finality stay `unknown` with
  no assessment and an `EVM_DIMENSIONS_NOT_EVALUATED: ` reason.
  `fixedBeforeExecution` is `"false"` and the anchor is `not_anchored`.
- Gate parity for all six non-zero exitReasons. A SIMULATED rebuilt-settlement
  result (consistent Core digests, accepted by Core) is refused
  (`diverged:dimension_not_supported_by_fragment`) with no Hub call.
- The output contains none of the context's account, request or preflight
  metadata, or requestId strings. It contains no `fixedBeforeExecution` true
  and no authority or ranking field. Two runs are byte-identical, global
  `fetch` is never called and the `Date` spy is not hit.

None of this is a genuine caller action fixed before execution.

## Action preflight check (`verify-action-preflight.ts`)

Operator tooling for GT-02 step 3a (see the operator sequence above), run
offline before the irreversible step 5. It closes no gate row. GT-02 stays
OPEN. `verifyActionPreflightCapture({ capture, requestFile, anchorReadiness })`
is pure: no network, clock, filesystem or randomness. The only timestamps it
reads are those carried by its inputs. Its imports are node built-ins,
`@nec/core`, `@nec/resolver-evm`, `@nec/resolver-solana`,
`./verify-live-before.js` and `./verify-evidence-result.js` only. It never
imports the MCP server or either capture client (tested).

```sh
tsx examples/hosted-reproduction/verify-action-preflight.ts --preflight-capture <preflight action capture> \
  --request <the caller's request file> [--anchor-c-readiness]
```

Frozen check order (first failure wins):

1. `capture`: inert JSON data, `schema` equal to
   `ACTION_CAPTURE_SCHEMA_ACCEPTED`, `mode: "preflight"`, tool
   `preflight_live_network_evidence`, `isError: false`. Otherwise
   `not_reproducible:capture_invalid`.
2. `preflight_envelope`: `verifyLivePreflightEnvelope(call.structuredContent,
   { expected: <request file> })`, with the caller's own file and never
   `call.arguments`. Any non-verified status and reason is passed on
   verbatim. An absent or non-inert request file is passed as `null`, which
   that verifier refuses; it never skips the binding.
3. `pinned_manifest`: the served `resolverManifest` must equal the pinned
   family manifest (`evmBeforeResolverManifest()` for `eip155`,
   `solanaBeforeResolverManifest()` for `solana`), digest first, then
   canonical wire equality. Otherwise `diverged:manifest_not_pinned`. Then
   Core `verifyCapabilitySnapshot` and `verifyPreflightResult` must hold
   against the pinned manifest, otherwise `diverged:pinned_context_mismatch`.
4. `anchor_readiness`, only with `--anchor-c-readiness`, read from the
   Core-decoded served request that step 2 bound to the request file: a
   network that is not `eip155` gives `not_applicable:non_evm_subject`;
   `action.target` must be a lowercase `0x` + 40-hex address, otherwise
   `insufficient:anchor_target_not_bindable`; `account`, if present, likewise,
   otherwise `insufficient:anchor_account_not_bindable`.

All checks pass: `verified:preflight_capture_pinned`, or
`anchor_ready:anchor_c_bindable` with `--anchor-c-readiness`. Only these two
exit 0; every other report exits 1.

`verifyLivePreflightEnvelope` checks the served context against the manifest
returned by the same server, so a drifted manifest that is internally
Core-consistent passes it. Step 3 is the check that refuses it (tested with a
SIMULATED drifted manifest, snapshot and preflight rebuilt by Core).

The report (`ne-hosted-action-preflight-check/v0.1`) carries `status`,
`reason`, `stage`, `exitCode`, the propagated `preflightEnvelope`
status/reason/contextualVerification, `selectedNetworkId`, `preflightStatus`
(Core evidence readiness, echoed and never gated), the manifest family and
digests, `fixedBeforeExecution: false` always, and `nonClaims`. It never
prints an EIP-3009 nonce, an EIP-712 field, a transaction input or the
preflight artifact digest. It never echoes the requestId, account, action
or metadata. Exit 0 is not authorization to execute, not precedence, not
policy satisfaction and not wallet or gas readiness. `anchor_ready` is not
an anchor: whether anchor (c) counts is an owner decision.

### What the loopback tests show

All captures go through `capture-action.ts` to a loopback hosted-mode server
under `SIMULATED_REPLAY_CLOCK`, with TEST-AUTHORED requests over the
checked-in Base F1 #1062 probe and Solana mainnet bytes. Positive Base
capture: exit 0. A preflight with status `blocked` still exits 0, because
`preflightStatus` is never gated. A changed request field gives the
propagated `diverged:request_binding_mismatch`. A loopback resolve-mode
capture, and SIMULATED `isError` and wrong-schema edits of a copy, give
`capture_invalid`. A lowercase Base target is
`anchor_ready`, a checksummed one is `insufficient`, and a Solana capture is
`not_applicable`. The report contains none of the request's requestId,
account, action or metadata strings. Two runs are byte-identical, global
`fetch` is never called and the `Date` spy is not hit.

None of this is a genuine caller action fixed before execution.
