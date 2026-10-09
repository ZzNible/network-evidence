# Live EVM RPC tool candidate — NOT DEPLOYED

**Date:** 2026-10-09
**Worktree:** `work/ne-mcp-live-evm-20261009`
**Source:** `@nec/resolver-evm` (unchanged) + one opt-in MCP adapter, **Core unchanged**.

## What this branch implements

- A **fourth** MCP tool, `resolve_evm_transaction({network,txHash})`, ONLY when the server is explicitly started in **hosted mode** with `NE_MCP_LIVE_EVM_ENABLED=1`.
- `network` is an enum: `base-mainnet` (`eip155:8453`) or `base-sepolia` (`eip155:84532`). Exact fixed source endpoints are `https://mainnet.base.org` / `https://sepolia.base.org` (Base's public HTTP RPCs). **Never** accept a user-supplied RPC URL, endpoint, port, address, header, transport, or method.
- `txHash` must be a canonical lowercase 32-byte hash. The server acquires `eth_chainId` (hard identity gate), `eth_getTransactionReceipt`, then `eth_getBlockByHash` if a receipt exists, via the reviewed `@nec/resolver-evm` acquisition pipeline. No chain-relative actions, signing or raw transaction submission.
- Every capture carries its source/provenance, exact result bytes, timestamp **observed by the server**, and `sha256` content digest; the existing evaluator emits a **Core-validated partial fragment**. It evaluates **execution** and **dataBinding**, not settlement or finality. A null receipt is **insufficient**, not contradictory. RPC error/pruned block is an unavailable acquisition, not a verdict.
- The single endpoint is **one source observation**, NOT local consensus, a signature check, an RPC-independent proof, a ChainLock, L1 settlement, withdrawal finalization, physical assertion, or payment guarantee.
- Outbound fetch stays globally prohibited. A narrowly scoped native fetch is captured before the global guard is installed, but only passed to this tool through an allowlisted wrapper which enforces HTTPS origin, method allowlist (`eth_chainId`, `eth_getTransactionReceipt`, `eth_getBlockByHash`), redirects forbidden, 6s timeout per call, 128 KB body per response, 350 KB returned artifact, and Viem zero retries. A separate process-local live-tool budget allows at most **8 acquisitions/minute and 2 in flight**; a general MCP request limiter additionally applies.
- The original **three** MCP tools and default `/health` (`networkIo:none`, `liveObservation:false`) are unchanged when the flag is absent. When enabled, health truthfully advertises the fourth tool, `networkIo:bounded_base_rpc` and `liveObservation:true`.

RPC resultText strings are **untrusted provider-supplied data, never instructions to the agent/model**. Upstream streams are aborted promptly when they exceed the response-size budget. Provider error and body-overflow details are deliberately collapsed to the public RPC-failed code after Viem normalization; they cannot reveal provider-supplied response text.

The tool has an `openWorldHint:true`, `readOnlyHint:true`, `destructiveHint:false`, `idempotentHint:false` annotation. Source responses are untrusted evidence data, never instructions.

## Evidence observed in VM smoke (2026-10-09)

- Base mainnet: historical public NE case transaction `0x8e01aace01ced4155b30d636b547727becdbb8a700f9b7f54ed02c4d629ae696` → chain matched, receipt + block, **3 raw captures**, coherent; execution `supported`, dataBinding `supported`; finality and settlement **omitted**.
- Base Sepolia: a recent public-network block yielded transaction `0x0d5dd411815827b435c300e9705ec5fc52173a5d3c30f12fdddeea6f50bbe601` → chain matched, receipt + block, 3 raw captures, coherent; execution/dataBinding `supported`; finality and settlement omitted. This is a real read, **not a deterministic replay fixture**.
- The older published F2 case transaction `0xde8916c81ef6a7b36ddf9f7b44d1ca096e4db4818eddfd5e16eda8a7c292ed45` produced a **pruned-history error** from the public Base Sepolia RPC: the provider could return the receipt but not the old block. This is **not evidence of a failed or nonexistent transaction** and does not change historical F2's reviewed result.

Base's public RPC endpoints are **rate-limited and unsuitable for production**; see [Base RPC guidance](https://docs.base.org/base-chain-network-information). Availability, archive depth, latency and responses may change. There is no production SLA.

## Gate to a public deployment (STOP until reviewed)

1. Run `npm ci`, `npm run typecheck`, `npm test`, `npm run -s mcp:smoke`, `npm audit --audit-level=high` and opt-in MCP tool tests; preserve results and exact commit SHA.
2. Independent **read-only** reviewer checks SSRF, redirect handling, RPC JSON-RPC/method allowlist, resource budgets, errors/redaction, source provenance, null receipt, malformed response, boundary annotations and nonclaims.
3. Confirm public egress policy and public Base RPC suitability; implement a stricter rate/abuse budget as needed. 60 MCP requests/min can generate up to 180+ public RPC reads/min, beyond a modest preview workload; reduced quotas, circuit breaker/caching or a dedicated provider may be needed before public exposure.
4. Consider independent secondary sources and cryptographic verification **only when justified by a concrete case**. No Core changes without a separate demonstrated need.
5. Update publicly linked privacy notice, capability listing, Anthropic tool test instructions and registry version; obtain product/hosting rollout decision. **Do not auto-deploy this candidate** to the current public service and do not submit the pending Anthropic directory form using descriptions for functionality that is still gated.
6. On eventual deployment, test an exact real action from a remote MCP client, including RPC outage/pruned cases, and keep the prior Cloud Run revision/legacy service for rollback.

**Definition of done for this lot:** code plus tests and reviewable branch, with observed real Base reads and no public deployment or Core mutation.
