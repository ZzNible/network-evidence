# NE Maps — minimal v1 atlas

This directory is the bounded generic/multichain Maps surface for the three stable Network Evidence Suite v1 cases.

It is deliberately a presentation layer:

- exactly three reviewed browser-safe Lens case projections;
- no resolver, RPC acquisition, signing, submission, wallet or policy path;
- no graph engine and no generic case abstraction;
- no global verdict, confidence or ranking;
- no chain-specific product logic;
- `TARGET_CORE_MUTATIONS = 0`.

## Cases

1. Base mainnet x402 partial case — supported execution/data binding, insufficient OP Stack finality and x402 correlation, settlement unavailable.
2. Base Sepolia ERC-4337 v0.6 exact UserOperation — supported exact selection, with the already-reviewed selector outcomes for supported / insufficient / contradicted / ambiguous; finality and bundler provenance unavailable.
3. Solana mainnet x402-SVM partial case — supported execution/payment/source-observed RPC-finalized dimension, insufficient historical x402 correlation, settlement unavailable.

The source export is pinned to:

- `ZzNible/agent-evidence-hub` `autonomy/authority-v1` at `586a81a39c8da4d3a0dc0e879b605aabfd3f8d1d`;
- public Suite repo `ZzNible/network-evidence` at `e536ca1c63465ebb2de46c855a01bac71e4dc768`.

`data/cases.json` contains the frozen browser-safe projections plus navigation metadata. Display labels and Trail ordering are presentation metadata, not evidence.

## Run

From the repository root:

~~~sh
npm run maps:serve
~~~

Open `http://127.0.0.1:4177/`.

Each case has three deterministic handoffs:

- **Lens** — propositions, assessments, basis and limitations;
- **Trail** — ordered presentation of the case propositions, without inventing causal edges;
- **Exact action** — the source-backed transaction/UserOperation identity and exported case relations.

No external network lookup is performed by Maps.
