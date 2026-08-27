# @nec/adapter-x402-svm

A pure post-fact protocol adapter for x402 v2 `exact` on `solana:*`. It performs no network I/O, wallet/key/signing work, transaction construction or submission, simulation, `/verify`, `/settle`, facilitator runtime, or sponsor implementation.

## Payment proposition

The adapter consumes generic `@nec/resolver-solana` evidence and an exact normalized requirement bound to one claimed Solana signature. It recognizes only canonical `TransferChecked` effects from SPL Token or Token-2022, across a complete normalized top-level + CPI trace. `meta.innerInstructions: []` is explicit complete-empty CPI metadata; `null` or an absent field is incomplete trace evidence, so even one observed qualifying transfer remains insufficient for exactly-one payment. Destination is the canonical Associated Token Account PDA derived from `payTo`, the relevant token program, and mint under `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL`.

Exactly one individual transfer must have the correct token program, mint and ATA and an amount `>=` the required atomic amount. Overpayment qualifies; underpayment does not. Split transfers are never summed. Additional unrelated instructions do not invalidate one qualifying effect. Authority and source need not equal `extra.feePayer`; fee payer is protocol context, not token-payment authority or proof.

Successful execution is required. Finality is carried separately from the resolver and never launders a wrong payment effect. The adapter never infers protocol settlement from Solana finality.

## Boundaries and non-claims

Sponsor Acceptance Policy—fee-payer isolation, ALT visibility before signing, signer integrity, simulation, compute limits, allowlists, memo enforcement, and sponsor willingness—is not the network payment outcome. Optional memo/recent-blockhash/last-valid-height fields are normalized context/construction hints and do not silently strengthen the proposition. `SettlementResponse` is a protocol artifact, not Solana finality.

Every assessment preserves: `FACILITATOR_VERIFY_OUTCOME_NOT_ESTABLISHED`, `FACILITATOR_SETTLE_OUTCOME_NOT_ESTABLISHED`, `PROTOCOL_SUCCESS_CLAIM_NOT_ESTABLISHED`, `SETTLEMENT_RESPONSE_NOT_FINALITY`, `SPONSOR_ACCEPTANCE_POLICY_NOT_NETWORK_FACT`, `FEE_PAYER_ISOLATION_NOT_A_PAYMENT_OUTCOME`, and `ECONOMIC_IRREVERSIBILITY_NOT_ESTABLISHED`. When resolver finality is supported it remains visible as source-observed network finality; facilitator/settlement outcomes remain unestablished.

The committed historical mainnet transaction is generic network evidence. Its later/current matching requirement is only `STRONG_BUT_ONE_FIELD_MISSING`: contemporaneous historical PaymentRequirements, PaymentPayload, VerifyResponse, and SettlementResponse are not public and are never synthesized.
