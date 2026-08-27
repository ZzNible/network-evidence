# @nec/adapter-x402

x402 v2 EVM **payment-evidence assessment** adapter for NEC: a PURE protocol
layer that (1) maps a normalized x402 `exact`-scheme payment claim onto
frozen NEC contracts and (2) assesses generic network-resolver evidence for
an observed ERC-20 Transfer that exactly correlates to the claimed payment
transaction and matches the expected terms — without putting any x402
knowledge into `@nec/resolver-evm` or `@nec/core`.

## What this adapter does NOT conflate

Each link in this chain is a DIFFERENT thing. The adapter never collapses one
into another:

```
protocol claim            an x402 requirement + a claimed payment tx hash
  != network observation  what a resolver actually observed on-chain
  != successful execution a receipt status — about execution, not payment
  != matching Transfer    an observed log that matches the expectation
  != settlement           NOT provided by generic EVM evidence
  != finality             NOT provided by generic EVM evidence
```

- **Protocol claim**: `X402PaymentClaim` = expected terms (`requirement`) +
  the alleged payment transaction (`paymentTxHash`). x402/facilitator
  "success" fields are claims/context until independently correlated to
  network evidence; raw HTTP/x402 envelopes never enter core artifacts.
- **Network observation**: a frozen-core `NetworkEvidenceFragment`
  (exactly what `NetworkResolver.resolve` returns) — the PRIMARY input of
  `assessX402ExactPayment`.
- **Successful execution**: reported SEPARATELY (`evaluation.execution`) and
  never rewritten: a successful transaction to the wrong payee keeps
  execution `supported` while the payment proposition explicitly conflicts.
- **Matching observed Transfer**: the strongest positive result — nothing
  more:

  ```
  OBSERVED_CORRELATED_TRANSFER_MATCHES_EXPECTED_X402_PAYMENT_REQUIREMENT
  ```

It is NEVER called "verified settlement". A matching `Transfer` event does
NOT prove that the token contract is honest, that balances changed, that an
authorization signature was valid, that EIP-3009/Permit2 caused the
transfer, that a facilitator verified or settled anything, that the
transaction is final, or that the payment is economically irreversible.
Every assessment emits the fixed `X402_NON_CLAIMS` list stating exactly this.

## Scope claim (deliberately narrow)

| Dimension | Support |
| --- | --- |
| Protocol | x402 v2 ONLY (`x402Version: "2"`) |
| Network family | `eip155:<chainId>` (EVM) ONLY |
| Scheme | `exact` ONLY — no other scheme is claimed |
| Evidence | post-fact assessment of observed on-chain effects |

No facilitator, no /verify or /settle calls, no wallet, no keys, no signing,
no transaction submission, no network I/O, no clock, no randomness, no trust
scores, no policy decisions. `@nec/core` is consumed through its frozen
public contracts and THE one normative verdict state machine
(`composeVerdict`) — never redefined.

## Exact transaction binding (the correlation rule)

A claim names ONE transaction. Evidence may support the claim ONLY when it
is bound to THAT transaction:

1. The fragment subject MUST be `{type:"transaction"}`, carry the
   normalized x402 network id and the claimed `paymentTxHash`.
2. A Transfer observation carrying its own `transactionHash` MUST equal it.
   A log from transaction Y can NEVER support a claim about transaction X;
   violations are excluded from candidacy AND recorded as explicit material
   conflicts scoped to the payment proposition (never silent noise).
3. A Transfer observation without a hash may only count while the fragment
   subject itself is exactly correlated.

Right-token/wrong-terms transfers inside the claimed transaction (wrong
recipient, wrong amount, wrong bound payer) are surfaced as deterministic
claim-vs-network expectation conflicts — not silently converted into "no
match found". Other-token activity remains ordinary noise.

## Public API

```ts
// Claim layer: parse + normalize the protocol claim.
parseX402PaymentClaim(raw): X402PaymentClaim // {requirement, paymentTxHash}

// Pure protocol→NEC mapping. ZERO network claims:
buildX402PaymentCorrelation(claim, {requestId?, evidencePolicy?})
// -> { subject: {type:"transaction", networkId, txId},
//      action:  {kind:"x402.payment", target: payTo, value: amount,
//                fields:{asset, scheme, x402Version, payer?}},
//      request?: EvidenceRequest }        // only with policy+requestId

// PRIMARY assessment path (frozen NetworkResolver.resolve output):
assessX402ExactPayment(claim, fragment): X402PaymentEvaluation

// COMPATIBILITY form over complete NetworkEvidenceResult artifacts;
// delegates to the same internal evaluation path:
evaluateX402ExactSettlement(requirement, result)

// Interpretation + requirement primitives:
interpretObservedEffect(effect)          // ObservedEffect -> ERC-20 Transfer?
parseX402ExactPaymentRequirement(raw)
computeRequirementDigest(requirement)
```

`X402PaymentEvaluation` is an ADAPTER-LOCAL report shape — explicitly NOT a
`NetworkEvidenceResult`. It contains no reputation/trust scores and no
policy decisions. Key fields: `outcome` (THE x402 payment proposition,
composed by the frozen state machine), `execution` (separate generic
execution semantics), `matchingTransfers`, `transactionHashMismatches`,
`expectationConflictIds`, `claim`, `nonClaims`.

Fail-closed intake: untrusted claims/requirements are parsed strictly
(EIP-55 checksums verified on mixed-case addresses via a local dependency-
free keccak256; amounts compared as BigInt only); fragments/results are
fully validated through core before any field is read. Invalid input throws
controlled errors (`NecAdapterX402Error`, codes `X402_*`); malformed
evidence CONTENT classifies deterministically instead of throwing.

## Usage sketch

```ts
import {
  assessX402ExactPayment,
  buildX402PaymentCorrelation,
  parseX402PaymentClaim,
} from "@nec/adapter-x402";
import type { NetworkEvidenceFragment } from "@nec/core";

const claim = parseX402PaymentClaim({
  requirement: {
    x402Version: "2",
    scheme: "exact",
    network: "eip155:8453",
    asset: "0xcccc...",   // USDC on Base, lowercase or EIP-55
    payTo: "0xbbbb...",
    amount: "1000000",    // atomic units, decimal string
    // payer: "0xaaaa...", // bound only when the mechanism requires it
  },
  paymentTxHash: "0x7a7a...", // THE claimed payment transaction
});

const { subject, action, request } =
  buildX402PaymentCorrelation(claim, { requestId: "req_1", evidencePolicy });
// -> hand `request` to a network resolver; it returns a fragment:

const evaluation = assessX402ExactPayment(claim, resolverFragment);

evaluation.outcome.verdict;   // supported | contradicted | insufficient | ambiguous | undefined(unknown)
evaluation.execution.verdict; // separate generic execution semantics
evaluation.claim;             // strongest claim licensed by the outcome
evaluation.nonClaims;         // permanent non-claims (always emitted)
```

## Layout

```
src/keccak.ts       dependency-free keccak256 (Ethereum padding)
src/address.ts      EVM address validation + EIP-55 checksum + normalization
src/caip2.ts        CAIP-2 parsing restricted to eip155
src/amount.ts       atomic-units decimal amounts (BigInt semantics)
src/requirement.ts  x402 v2 exact requirement: parse, normalize, digest
src/interpret.ts    ObservedEffect -> Transfer-shaped observation
src/claim.ts        X402PaymentClaim + pure protocol->NEC correlation
src/evaluate.ts     fragment-first assessment over composeVerdict (+result wrapper)
```

JSON-safe outputs only (amounts travel as decimal strings), deterministic
and replayable: identical inputs produce identical assessments.
