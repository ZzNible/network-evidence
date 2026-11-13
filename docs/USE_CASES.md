# Four evidence cases you can inspect

NE distinguishes **what exact network evidence supports** from assumptions made by apps and agents. The four cases in the generic NE Maps atlas are reviewed historical or synthetic fixtures, **not** fresh network lookups.

## Open the cases

With Node.js 22, from the repository root:

~~~bash
npm ci
npm run -s maps:serve
~~~

Open http://127.0.0.1:4177/ on the **same machine**. No wallet, API key or live RPC is needed.

| Case | Supported by the reviewed fixture | Not established |
| --- | --- | --- |
| **Base mainnet x402 partial** | Specific execution and data-binding observations | Full x402 correlation, OP Stack finality and settlement |
| **Base Sepolia ERC-4337 v0.6** | Exact UserOperation selection and reviewed selector outcomes | Bundler provenance and finality |
| **Solana mainnet x402-SVM partial** | Specific execution/payment observations; source-reported RPC-finalized dimension | Historical x402 correlation and settlement; the RPC signal is not an independent finality proof |
| **Synthetic / local integrability** | Local Core -> Hub -> Lens consistency and one synthetic effect | **Not a real on-chain observation.** Settlement and finality remain unknown |

See the [source-bound NE Maps inventory](../examples/ne-maps/README.md). Lens, Trail and exact-action views are presentation handoffs, not new consensus checks.

## Reproduce an exact historical action

~~~bash
npm run -s demo:core-hub-lens
~~~

This replays a checksum-pinned public Base Sepolia ERC-4337 UserOperation, compares the recomputed local result to the reviewed Hub projection, and then emits a Lens case. Expected summary: Core replay consistent; UserOperation supported; Hub equality gate passed; **finality not established**.

## Ask a local agent

~~~bash
npm run -s mcp:serve
~~~

Connect a same-machine MCP client to `http://127.0.0.1:4178/mcp` using [Start here](START_HERE.md), then ask:

> Call `get_reviewed_evidence_case` with `caseId=f2`. List supported propositions, evidence basis and limitations. Is it live? Is finality established?

The server returns an **offline historical fixture**; it does not fetch new RPC evidence, sign, submit, rank, fund or attest real-world outcomes.

`supported`, `contradicted`, `insufficient` and `ambiguous` apply to exact propositions, not whole applications. Execution, observed effects, settlement and finality are separate claims.

[Signed releases](https://github.com/ZzNible/network-evidence/releases/latest) | [Security boundaries](../SECURITY_BOUNDARIES.md)
