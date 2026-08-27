# @nec/adapter-erc4337

ERC-4337 **UserOperation evidence assessment** adapter for NEC: a PURE
protocol layer that (1) maps an exact expected-UserOperation claim onto
frozen NEC contracts and (2) assesses generic network-resolver evidence for
ONE EntryPoint bundle transaction that exactly identifies the expected
UserOperation (expected sender, exact `userOpHash` when known, success) —
and, when an exact expected ERC-1155 burn is supplied, correlates that
exact burn effect — without putting any ERC-4337 or Nevermined knowledge
into `@nec/resolver-evm` or `@nec/core`.

## What this adapter does NOT conflate

Each link in this chain is a DIFFERENT thing. The adapter never collapses
one into another:

```
bundle transaction          the EntryPoint bundle tx (receipt subject)
  != UserOperation          identified ONLY by its UserOperationEvent
  != UserOperation success  the event's own canonical success word
   != matching burn effect   an observed TransferSingle OR TransferBatch member with to == zero
  != L2 block finality      NOT provided by generic EVM evidence
  != withdrawal finalization / economic irreversibility   NEVER claimed
```

Concretely, proven by tests:

1. A successful bundle receipt with NO usable `UserOperationEvent` yields
   INSUFFICIENT — never SUPPORTED.
2. In a bundle containing two UserOperations, selecting one sender/hash can
   never borrow success from the other.
3. A supplied `userOpHash` mismatch is never ignored.
4. A sender mismatch on the hash-selected event is never ignored.
5. `success=false` in the selected event CONTRADICTS the proposition even
   when the bundle receipt reports success.
6. An unrelated well-formed UserOperationEvent beside an exactly identified
   target does not break the target.
7. Duplicate exact candidates fail closed as AMBIGUOUS — the first log is
   never arbitrarily chosen.

## Pinned event semantics (v0.1)

```
UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)
  topic0  0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f
  topic1  userOpHash    topic2  sender    topic3  paymaster
  data    nonce, success, actualGasCost, actualGasUsed   (4 x uint256)
```

The current (uint256-nonce) signature is pinned; tests derive both topic0
constants from the canonical signatures with a local dependency-free
keccak256 and prove they match the pins.

```
TransferSingle(address,address,address,uint256,uint256)
  topic0  0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62
  topic1  operator   topic2  from   topic3  to
  data    id, value                                       (2 x uint256)
```

Burn semantics FOR THIS PROFILE: `to == 0x…0000`. `from == zero` is MINT
semantics and is never classified as a burn. `TransferBatch` is FIRST-CLASS
in v0.1:

```
TransferBatch(address,address,address,uint256[],uint256[])
  topic0  0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb
  topic1  operator   topic2  from   topic3  to
  data    (uint256[] ids, uint256[] values)   strict dynamic ABI
```

Each batch member is projected DETERMINISTICALLY with a stable identity
`${carrierEffectId}#${memberIndex}` and is NEVER silently summed with sibling
members. A malformed relevant batch fails closed (excluded + material
conflict), never partially interpreted.

## Scope claim (deliberately narrow)

| Dimension | Support |
| --- | --- |
| Protocol | ERC-4337 EntryPoint `UserOperationEvent` interpretation |
| Network family | `eip155:<chainId>` (EVM) ONLY |
| Profile | success-only (`requireSuccess=false` fails closed) |
| Effects | optional exact ERC-1155 `TransferSingle` **or** `TransferBatch` burn (unified exact-burn evaluation across both carriers) |
| Evidence | post-fact assessment of observed on-chain effects |

No bundler, no wallet, no keys, no signing, no transaction submission, no
paymaster policy decisions, no network I/O, no clock, no randomness, no
confidence scores, no trust scores. `@nec/core` is consumed through its
frozen public contracts and THE one normative verdict state machine
(`composeVerdict`) — never redefined.

## Exact bundle binding (the correlation rule)

A claim names ONE bundle transaction and ONE EntryPoint. Evidence may
support the claim only when bound to THAT execution:

1. The fragment subject MUST be `{type:"transaction"}`, carry the claim's
   CAIP-2 network id and the claimed `bundleTransactionHash`.
2. An observation carrying its own `transactionHash` MUST equal it. A log
   from transaction Y can NEVER support a claim about transaction X;
   violations are excluded AND recorded as explicit material conflicts
   scoped to the proposition (never silent noise).
3. An observation without a hash may only count while the fragment subject
   itself is exactly correlated.
4. Only events emitted by the CLAIMED EntryPoint become candidates; shaped
   logs from other emitters are counted + warned, never candidates.

## Fail-closed semantics

- **Selection**: with `userOpHash`, exact-match selection; duplicates =>
  AMBIGUOUS. Without it, sender-match selection; multiple equally matching
  candidates => AMBIGUOUS, never first-match.
- **Malformed relevant evidence fails closed** (the APEL lesson): an effect
  whose topic0 equals a pinned topic — or whose carrier is too broken to
  classify at all — is NEVER treated as unrelated noise and NEVER becomes a
  clean negative. It becomes an explicit material conflict scoped to the
  proposition => AMBIGUOUS wherever competing interpretations remain.
- **Removed logs** (`removed=true`, reorg orphans) are excluded from
  candidacy in BOTH directions: never positive, never negative.
- **Burn correlation**: only a usable burn satisfying contract + from +
  `to == zero` + tokenId + value simultaneously satisfies the expectation.
  A burn from the expected account ON the expected contract differing in
  tokenId/value is a clean CONTRADICTION. Wrong-contract / wrong-from /
  nonzero-to / mint observations are near-miss noise: they can never
  satisfy and never refute (another account's activity does not contradict
  THIS account's claim). Absence of any burn yields INSUFFICIENT — a
  missing effect is never silently excused and never invented into a
  contradiction.

Outcome mapping: SUPPORTED = unique successful op (+ exact burn when
expected) inside the exactly-correlated bundle; CONTRADICTED = clean,
evaluable negatives (failed/mismatched selected op, refuted burn, wrong
network, contradicted carried dimension); INSUFFICIENT = required evidence
absent; AMBIGUOUS = competing interpretations (duplicates, malformed
relevant evidence, provider disputes).

## Finality boundary (explicit)

ERC-4337 UserOperation success != L2 block finality != withdrawal
finalization != economic irreversibility. This package never evaluates and
never asserts finality; compose it separately through the frozen OP Stack
resolver if a policy requires it. Every assessment emits
`ERC4337_FINALITY_NOT_ESTABLISHED` and the fixed non-claims list including
`L2_BLOCK_FINALITY_NOT_ESTABLISHED` and `WITHDRAWAL_FINALIZATION_NOT_ESTABLISHED`.

## Nevermined boundary

This is a GENERIC ERC-4337 adapter — not a Nevermined adapter. Real
Nevermined redemption bundles on Base were used only to VALIDATE the
fixtures:

- facilitator returns the bundle transaction hash; current responses do NOT
  expose a `userOpHash`;
- planId is used directly as the ERC-1155 token id by Nevermined contracts —
  this normalization belongs ABOVE the package; callers here supply
  `expectedTokenId` directly;
- the on-chain burn profile applies ONLY when the claimed effect is actually
  expected on chain. Postgres-only credit-ledger paths are OUT OF SCOPE:
  nothing here observes database state;
- protected-content release safety is OUT OF SCOPE (see
  `PROTECTED_CONTENT_RELEASE_NOT_ESTABLISHED`).

## Public API

```ts
// Claim layer: parse + normalize the exact expectation.
parseErc4337Claim(raw): Erc4337Claim
// {network, chainId, bundleTransactionHash, entryPoint,
//  userOperation:{userOpHash?, sender, requireSuccess:true},
//  expectedEffect?:{kind:"erc1155-burn", contract, from, tokenId, value}}

computeErc4337ClaimDigest(claim)         // proposition scope identity

// Pure protocol→NEC mapping. ZERO network claims:
buildErc4337Correlation(claim, {requestId?, evidencePolicy?})
// -> {subject:{type:"transaction",...}, action:{kind:"erc4337.userOperation",...},
//     request?: EvidenceRequest}          // only with policy+requestId

// PRIMARY assessment path (frozen NetworkResolver.resolve output):
assessErc4337UserOperation(claim, fragment): Erc4337Evaluation

// COMPATIBILITY form over complete NetworkEvidenceResult artifacts;
// delegates to the same internal evaluation path:
evaluateErc4337Bundle(claim, result)

// Interpretation primitives (generic ObservedEffect -> pinned shapes):
interpretUserOperationEventEffect(effect)
interpretTransferSingleEffect(effect)
interpretTransferBatchEffect(effect)     // strict dynamic ABI; deterministic members

// Pinned constants + primitives:
USER_OPERATION_EVENT_TOPIC0 / TRANSFER_SINGLE_TOPIC0 (+ signatures)
TRANSFER_BATCH_TOPIC0 / TRANSFER_BATCH_SIGNATURE          // both pinned + derived
ENTRY_POINT_V0_7_OBSERVED_ON_BASE        // informational, never enforced
keccak256 / keccak256Hex, parseCaip2EvmNetwork, parseUint256Decimal,
normalizeEvmAddressStrict, eip55ChecksumAddress

// TransferBatch observation shapes (re-exported types):
//   TransferBatchObservation, TransferBatchMemberObservation,
//   TransferBatchInterpretation
// Each member carries memberId = `${carrierEffectId}#${memberIndex}` and is
// projected independently (no cross-member summation).
```

`Erc4337Evaluation` is an ADAPTER-LOCAL report shape — explicitly NOT a
`NetworkEvidenceResult`. It contains no settlement authority, no refund /
release liability, no reputation/trust scores and no policy decisions. Key
fields: `outcome` (THE ERC-4337 proposition, composed by the frozen state
machine), `execution` (separate generic bundle-execution semantics),
`selectedUserOperation`, `matchingBurns`, `conflictingBurns`,
`excludedCandidates`, `transactionHashMismatches`, `claimLabel`,
`nonClaims`.

Fail-closed intake: untrusted claims are parsed strictly (EIP-55 checksums
verified on mixed-case addresses via local keccak256; amounts compared as
BigInt only; unknown fields rejected); fragments/results are fully
validated through core before any field is read. Invalid input throws
controlled errors (`NecAdapterErc4337Error`, codes `ERC4337_*`); malformed
evidence CONTENT classifies deterministically instead of throwing.

## Real fixture (offline replay)

`test/fixtures/base-mainnet-redeem-bundle.json` is a deterministic
acquisition fixture (existing `nec-resolver-evm-fixture-v1` capture format)
of the primary Base mainnet credit-redemption bundle
`0x79549bcf07ac093eabc682e472c59e1c22858f9af14f77d0a0074fd11d3e578b`
(block 45309460), reacquired read-only from a public RPC through the frozen
`@nec/resolver-evm` pipeline (chainId + receipt + block + transaction
captures, byte-exact raw result text, no credentials, no endpoint URLs).
Tests replay it OFFLINE — no live network — and assert the independent
facts:

- exactly one relevant `UserOperationEvent` emitted by
  `0x0000000071727de22e5e9d8baf0edac6f37da032`:
  `userOpHash 0x94e3b302718e1f594c903cdb8237741c02edf12495cc78b34e30b9cfcfe5ae31`,
  sender `0xf64dd2892370f6d75aa1bd0f10da312235a06a1e`, success true;
- exactly one NFT1155Credits burn on
  `0xb2f9bb43f768e0d4adca49ce708acbE577bC2d64`:
  `from 0xf64dd2892370f6d75aa1bd0f10da312235a06a1e -> 0x0`,
  tokenId `107134729016282785317688751027026876438402324055584221042936325851129895197441`,
  value `1`.

A secondary real fixture (`base-mainnet-purchase-bundle.json`,
`0x2d0423f4e962f6d6c45d29db57b8d0444bcfcebb6e3ef512c351238d2451ff3a`)
contains TWO UserOperations plus a real MINT `TransferSingle` and proves
bundle-vs-UserOperation selection and mint-vs-burn separation against raw
chain data.

### Real `TransferBatch` fixture (offline replay)

`test/fixtures/ethereum-mainnet-transferbatch-real.json` is a deterministic
acquisition fixture (existing `nec-resolver-evm-fixture-v1` capture format)
of a real, public Ethereum-mainnet (`eip155:1`) transaction
`0xa18c7de72da745bfc667b24ea79d7fb793cec4ad9e469b7d69aa6840b0b61ea4`,
reacquired read-only from a public RPC through the FROZEN `@nec/resolver-evm`
pipeline (chainId + receipt + block captures, byte-exact raw result text, no
credentials, no endpoint URLs). It validates generic real-network
`TransferBatch` interpretation and does NOT require an ERC-4337
`UserOperation` in the same transaction, and must NOT be forced into the
combined UserOperation proposition.

Independently re-established facts (re-derived from RAW receipt material):

- chain id `1`; receipt execution status `success`;
- block hash `0xf034ba52501bf0e9161d5ae898bd5dfbb1d6c28420792d0639a9a31110447724`;
- emitter `0x019e1afe1de8fa2321782d32eea58d4b98b3a90e`;
- operator `0x79b26eb18b4c9209c866c25b0e6e37dc5d4b2b`;
- `from` `0xbfe3270664ff9bfedc9910561eccac5a45b9b23e` (operator != from);
- `to` `0x0000…0000` (burn);
- `ids [7,7,11,11,11,11]`, `values [1,1,1,1,1,1]`; log index `0x215`.

> **Brief data note (evidence integrity).** The canonical writer brief lists
> this transaction's block as `25824427`, but that number does NOT correspond
> to the brief's own block hash above. The real on-chain block carrying this
> hash is `25819051` (`0x189f7ab`). The fixture records the REAL canonical
> number bound to the real block hash; the brief's `25824427` is a
> transcription error in the source material and is NOT asserted.

Narrow non-claims of this fixture (it proves only a real canonical
`TransferBatch`-shaped network observation):

- it does NOT establish ERC-1155 contract honesty/conformance (the token
  contract could emit arbitrary events);
- it does NOT establish UserOperation causality, Nevermined linkage, service
  completion, settlement, L2 finality or economic irreversibility;
- it is not forced into any ERC-4337 UserOperation proposition.

### Duplicate exact burns across carriers fail closed (ambiguous)

Exact-burn correlation and duplicate detection treat `TransferSingle` and
`TransferBatch` members UNIFORMLY. When more than one usable exact burn
(contract + from + `to == zero` + tokenId + value) satisfies the expectation
— whether single+single, single+batch, or **batch member + batch member**
across two separate `TransferBatch` carriers — the assessment emits
`ERC4337_DUPLICATE_EXACT_BURNS` (a material conflict scoped to the
proposition) and the verdict becomes `ambiguous`. The first match is NEVER
arbitrarily chosen; ALL exact candidates are surfaced deterministically in
`matchingBurns`.

### No partial summation

Partial burns whose values would sum to the expected amount are NEVER
aggregated into a single match. Each member/transfer is evaluated on its own
exact (contract, from, tokenId, value) predicate.

### Correlation strength and causal boundary

The strongest supported proposition is `correlationStrength: "same_bundle_only"`
— a CONJUNCTION of observations over ONE bound bundle transaction. Co-observation
of a selected successful `UserOperation` and a matching burn-shaped effect in
the SAME bundle transaction is NOT evidence that the UserOperation caused the
burn, service completion, settlement, finality or economic irreversibility.
`CAUSAL_ATTRIBUTION_NOT_ESTABLISHED` is emitted on EVERY assessment.

## Layout

```
src/keccak.ts       dependency-free keccak256 (Ethereum padding)
src/address.ts      EVM address validation + EIP-55 checksum + normalization
src/caip2.ts        CAIP-2 parsing restricted to eip155
src/amount.ts       exact uint256 decimal quantities (BigInt semantics)
src/events.ts       pinned UserOperationEvent / TransferSingle semantics
src/interpret.ts    ObservedEffect -> pinned-shape observations (total fns)
src/claim.ts        Erc4337Claim parse/normalize/digest + NEC correlation
src/evaluate.ts     fragment-first assessment over composeVerdict (+result wrapper)
```

JSON-safe outputs only (amounts travel as decimal strings), deterministic
and replayable: identical inputs produce identical assessments.
