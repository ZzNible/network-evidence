# @nec/resolver-solana

Generic, post-fact Solana network evidence for NEC. It performs no wallet, key, signing, transaction-construction, submission, sponsor, facilitator, payment-policy, or x402 work.

## Scope

The v0.1 resolver validates the `solana:<32-character CAIP genesis reference>` by deriving it from the full `getGenesisHash` result, then performs bounded sequential reads: `getTransaction(signature, {commitment:"finalized",encoding:"json",maxSupportedTransactionVersion:0})`, `getSignatureStatuses([signature], {searchTransactionHistory:true})`, and, when a transaction is available, compact `getBlock(slot, {commitment:"finalized",transactionDetails:"none",rewards:false,maxSupportedTransactionVersion:0})`. There is no batching or silent retry. An explicit `fetchFn` is required.

Legacy and version-0 transactions are supported. Version-0 effective account keys are the complete static + loaded-writable + loaded-readonly space. ALT lookup counts must exactly match resolved loaded addresses; missing or partial ALT resolution fails closed. Every program/account index is range-checked.

Compiled top-level instructions are decoded locally. An actual-array `meta.innerInstructions` (including `[]`) supplies complete CPI-trace metadata; `null` or an absent field does not establish a complete trace and is preserved as `instructionTraceComplete: false`. Only discriminator `12` `TransferChecked` under canonical SPL Token or Token-2022 is emitted. Source, mint, destination, authority, u64 amount, decimals, deterministic instruction location, stack height when observed, and transaction signature are preserved. A failed transaction never emits a positive observed effect.

## Fixture and replay

`nec-resolver-solana-fixture-v1` stores schema version, acquisition time, endpoint-free source identity, network, signature, and ordered raw RPC result text (or controlled RPC error). Replay is strict and offline: requests must match the next capture, duplicates/unmatched/unused captures fail, and repeated replay is deterministic. Fixtures reject endpoint URLs, credentials, private paths, secret-like text, exotic objects, accessors, and malformed raw results.

## Claim boundary

Execution means only that this source returned `meta.err == null` for the exact signature. Finality requires mutually consistent finalized transaction, signature-status, error, slot, and containing-block observations. Its basis is `source_observation`, not `cryptographic_verification`. Solana finalized commitment is not a claim of economic irreversibility. Generic acquisition does not infer settlement and contains no x402 interpretation.
