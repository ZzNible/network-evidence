# F3 — Solana mainnet x402 partial case

This is the third bounded real public/offline-reproducible NE Suite v1 case.

Source network evidence is the checksum-pinned Solana mainnet fixture in public `ZzNible/network-evidence` at commit `e536ca1c63465ebb2de46c855a01bac71e4dc768`.

The reviewed runtime semantics are deliberately split:

- Solana transaction execution: `supported`.
- Exact observed TransferChecked payment outcome against the reviewed fixture requirement context: `supported`.
- Solana Network Evidence finality dimension: `supported` from source-observed RPC `finalized` evidence only.
- Generic economic irreversibility: **not established**.
- Historical x402 artifact-to-transaction correlation: `insufficient` because the pinned public adapter documentation states that contemporaneous historical `PaymentRequirements`, `PaymentPayload`, `VerifyResponse`, and `SettlementResponse` are not public. This is an operator-reviewed documentation limit, not proof that such artifacts never existed.
- Settlement: unavailable / not inferred.

The requirement context is reviewed fixture context, not a claim that historical x402 request/settlement bytes were recovered.

The complete public Core replay is frozen in `source/04-frozen-core-runtime.json`; the integration runner requires exact deep equality before constructing Lens. The final deterministic Core -> Hub -> Lens output is pinned and enforced by `03-expected-demo-output.sha256`.

This fixture adds no network fetch, wallet, signing, submission, custody, policy decision, trust score, generic Hub ingestion, or Network Evidence core mutation. `TARGET_CORE_MUTATIONS = 0`.
