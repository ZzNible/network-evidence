# @nec/resolver-evm

Generic EVM **evidence pipeline** for NEC (v0.1): the first production vertical
slice from a configured evidentiary source to normalized, replayable
observations, through pure evaluation into a `NetworkEvidenceFragment` — plus
a BEFORE-side foundation that turns already-acquired capability-probe
observations into manifest-bound support/availability artifacts for discovery
and preflight.

Evidence infrastructure only. No signing, no wallet ownership, no private
keys, no transaction submission, no execution authority, no x402/payment
interpretation. `@nec/core` is consumed, never redefined.

## Architecture (explicit boundaries)

```text
1. SOURCE CONFIGURATION   EvmRpcSourceDescriptor — controlled sources only;
                          a request never carries an arbitrary RPC URL;
                          secrets live transiently in the descriptor and can
                          never enter artifacts or fixtures.
2. SOURCE ADAPTER         ONE Viem public client per descriptor; batching and
                          retries disabled; fallback([...]) never used, so
                          provenance is always exact.
3. RAW CAPTURE            EvmRpcCapture — byte-exact raw `result` text of one
                          JSON-RPC exchange plus full provenance; Viem's
                          normalization cannot silently destroy evidence.
4. NORMALIZATION          strict parsers derive every typed value (bigint via
                          BigInt, canonical lowercase hex) exclusively from
                          captured text; unknown provider fields survive as
                          bounded JSON-safe `extras`.
5. CONSISTENCY CHECKS     structural malformation fails closed immediately;
                          semantic incoherence between returned values is
                          captured as failed checks (future conflicts).
6. PURE EVALUATION        evaluateTransactionAcquisition turns ONE acquisition
                          into per-dimension proposition verdicts, observed
                          effects, scoped conflicts and warnings via THE core
                          composer — and projects them onto a partial,
                          fail-closed-validated NetworkEvidenceFragment.
```

## Evidence path

```text
configured source
  -> acquisition / capture / normalization / replay   (acquireTransactionObservation)
  -> pure evaluation                                  (evaluateTransactionAcquisition)
  -> NetworkEvidenceFragment
```

Evaluation answers only what one generic single-source acquisition can ground:
execution and dataBinding. Settlement and finality are deliberately omitted
from the fragment in every scenario (never projected as placeholders), and a
null receipt is absence of observation — never proof of non-execution.

## BEFORE foundation

Separately from transaction evidence, the BEFORE side derives frozen
`@nec/core` artifacts from ALREADY-ACQUIRED capability-probe observations
(pure derivation, no I/O):

```text
BEFORE
  -> evmBeforeResolverManifest      THE support authority (static, digest-bound)
  -> deriveEvmBeforeFoundation      CapabilitySnapshot + discovery candidate data
  -> deriveEvmBeforePreflightResult evidence readiness (ready/blocked/unknown/not_applicable)
```

SUPPORT (what this resolver implementation knows how to evaluate) is manifest
authority and never probe-derived; AVAILABILITY (whether the required evidence
source is usable right now) is volatile probe outcome backed by concrete
EvidenceRefs. A source outage changes availability, never support.

## Read model

```text
txHash -> eth_chainId            (identity gate; mismatch fails closed)
       -> eth_getTransactionReceipt
       -> eth_getBlockByHash(receipt.blockHash)      [when mined]
       [-> eth_getTransactionByHash on request]      (coherence evidence)
       -> consistency checks -> frozen normalized observation
```

Viem primitives perform all JSON-RPC mechanics (`client.request`, http
transport); formatted actions are deliberately bypassed for evidence reads
because they convert provider-null results (absence!) into thrown
exceptions.

## Determinism

- Time comes only from the supplied `now`; no clock or randomness reads.
- Raw results travel as exact text — no integer precision loss is possible.
- Duplicate JSON keys in provider bodies fail closed (strict parser).
- Replaying a fixture twice reproduces byte-identical observations.

## Offline replay

Fixtures store provenance + subject + time + raw captures — never URLs,
keys or credentials. Replay serves captures through an in-memory responder
matched by `(method, canonical params)`: unmatched requests and unused
captures fail closed, and the global fetch is never referenced.

## Consistency invariants

`CHAIN_ID_MATCHES_SOURCE`, `RECEIPT_TX_HASH_MATCHES_SUBJECT`,
`RECEIPT_BLOCK_HASH_MATCHES_BLOCK`, `RECEIPT_BLOCK_NUMBER_MATCHES_BLOCK`,
`TRANSACTION_COHERENT_WITH_RECEIPT`, `LOG_BLOCK_COHERENT`,
`LOG_TRANSACTION_COHERENT`, `LOG_NOT_REMOVED`. Agreement between RPC values
is correlation, never cryptographic proof.
