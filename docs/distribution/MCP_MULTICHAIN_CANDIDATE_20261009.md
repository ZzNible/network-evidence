# Network Evidence MCP — multichain AFTER and live BEFORE/Discovery candidate (NOT DEPLOYED)

**2026-10-09 | branch:** `work/ne-mcp-multichain-20261009`
**Scope decision:** [MCP thin native-I/O mapping](https://github.com/ZzNible/syscoin-zksys-nec-knowledge-base/blob/main/product/NETWORK_EVIDENCE_MCP_AGENT_IO_MAPPING_V0_1.md).
**Status:** an isolated **AFTER plus live BEFORE/Discovery slice of the future one MCP COMPLETE product**. It is not the complete product and MUST NOT be advertised, merged or publicly deployed as a replacement for the 3-tool offline demo before the canonical COMPLETE gate passes.

## Exact available operations in this branch

- The existing **three offline tools** retain their original behavior when `NE_MCP_MULTICHAIN_ENABLED` is unset.
- **Only with** `NE_MCP_MODE=hosted` and `NE_MCP_MULTICHAIN_ENABLED=1`: expose two read-only tools: `resolve_transaction_evidence` (AFTER) and `discover_live_network_evidence` (live BEFORE/Discovery); the AFTER tool accepting exactly one Core `SubjectRef` transaction `{type:"transaction",networkId,txId}`.
- Four fixed active network identities: Base mainnet (`eip155:8453`), Base Sepolia (`eip155:84532`), Solana mainnet (`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`), Solana devnet (`solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`). **No active zkSYS Tanenbaum profile**, no zkSYS RPC reads. Archived Tanenbaum replay is preserved in the original source suite; the already-deployed offline demo still has its explicitly historical five-profile inventory.
- No dynamic URLs or methods: Base `https://mainnet.base.org` and `https://sepolia.base.org` only for `eth_chainId`, receipt and containing block. Solana `https://api.mainnet-beta.solana.com` and `https://api.devnet.solana.com` only for `getGenesisHash`, transaction, signature status and block. Strict prevalidated arguments per method, no redirects, no arbitrary RPC headers, signing, accounts or submission.
- Source/acquisition normalization and **all network verdicts** come from unchanged `@nec/resolver-evm`, `@nec/resolver-solana` and the existing `@nec/core` wire validator. The MCP wrapper adds only bounded transport metadata, with `artifactType=network-evidence-fragment` and the exact Core artifact; **it never creates a full `NetworkEvidenceResult`** when evidence policy/preflight/context is missing.
- Shared process-local 8 successful admission slots per minute / 2 concurrent acquisitions across BOTH families; inner EVM adapter also has its own 8/min guard. Response bounds: Base 128 KB per RPC, Solana 800 KB per RPC, whole MCP envelope 450 KB; per RPC time limits Base 6 seconds, Solana 8 seconds. Public rollout also needs global quota controls when scaling past one instance, provider rate-limit confirmation, Cloud Run billing protections and adversarial review.
- Every request is a **single** source observation, not an independent cryptographic proof or network consensus. No Core confidence score. EVM inclusion/receipt ≠ OP Stack L2 finality or withdrawal finalization. Solana source-reported `finalized` ≠ cryptographic verification or x402 settlement. A pruned/null response is unavailable/insufficient evidence, not a contradiction of existence.

## Evidence and verification (local candidate only)

1. `npm run -s typecheck` PASS.
2. `npx vitest run packages/mcp/test`: 9 files / 87 tests PASS. Test both legacy and modern MCP clients, no zkSYS in active inventory, exact subject binding, null transaction, malformed RPC, redirects, body limits and shared budget.
3. `npm run -s mcp:smoke`: **old 3-tool offline mode PASS**.
4. `npm test`: 81 files / 1,448 tests PASS; `npm audit --audit-level=high`: zero vulnerabilities.
5. **REAL RPC reads executed from VM, not Cloud Run**: Base mainnet historical reviewed tx `0x8e01aace01ced4155b30d636b547727becdbb8a700f9b7f54ed02c4d629ae696` returned chain identity, receipt and block (3 captures), coherent, execution and data binding supported; finality/settlement NOT evaluated. Solana mainnet reviewed signature `4DYWUMExSrMNxYLjUuH9G8feN4fmYXm4ToCx7gGaAEjJRf2QNrE8LsvoFSGhXwQJrchhgrnGpUFwjxrci9PRLF71` returned genesis/transaction/status/block (4 captures), coherent, execution/data binding/source-reported finalized supported, settlement NOT evaluated.
6. A **locally hosted MCP SDK client with real external RPC egress** called both exact actions successfully and verified the opt-in AFTER tool, the four active profiles and the unchanged original tools. This is **not a deployed remote Cloud Run test**.

## Independent review and unclosed rollout risks

- Claude Opus read-only review of the candidate code returned **GATE=PASS for an UNDEPLOYED candidate**, identifying two MAJOR deployment conditions: **(M1)** the 8/minute budget is *per process*, not globally distributed, requiring verified one-instance Cloud Run settings or a global quota before opening the public service; **(M2)** public listing/README/tool copy must not conflate a source-reported Solana \`finalized\` verdict with cryptographic or economic finality. This review is not an authorization to release.
- Meaningful MINOR fixes after review: explicitly allowlist Solana source output keys, reject noncanonical EVM hash before quota, bind output network/subject and capture digests back to the Core fragment, preserve bounded-size error in the direct fetch guard, and replace fragile substring-filtered truth boundaries with explicit truthful live-mode text. All were unit-tested; **final exact-commit reviewer gate remains required before public release**.
- Additional testnet checks: Solana devnet pinned genesis with a null transaction (insufficient outcome) and a Base Sepolia chainId mismatch that stops before receipt acquisition.
- Neither Cloud Run nor the MCP official registry nor Anthropic directory was changed.


## Live BEFORE/Discovery integration (same UNDEPLOYED MCP candidate)

- Opt-in hosted-only read-only tool: discover_live_network_evidence. Inputs are Core DiscoveryRequirements, requestId and 1–2 distinct exact transaction SubjectRefs on the pinned Base/Solana profiles. The complete request, identifier grammar and transaction/signature formats are validated before any egress; no caller-supplied RPC destination.
- Shares the same 8-per-minute / 2-concurrent **process-local** live acquisition budget with the AFTER tool. EVM now also retrieves eth_getTransactionByHash, a strictly allowlisted fourth read, to back the generic EVM BEFORE transaction/data-binding capability. EVM transaction usability comes from a fully parsed, subject-and-receipt-coherent resolver acquisition, not merely a non-null response.
- Solana uses the resolver's existing solanaProbeObservationFromAcquisition, preserving independent path outcomes for genesis identity, transaction, signature status and finalized block. A confirmed status, missing status, missing block or partial/incoherent data is not promoted to finalized/available.
- The output contains native Core capability snapshots and their evidence digests, a Core-built and independently reverified discovery-result, source IDs and observed timestamps, without new Core verdict schemas, scoring, ranking, choosing or signing.
- Real live Base mainnet and Solana mainnet probe reads from the VM: requiring execution and desiring finality yielded Base conditional (generic EVM does not evaluate finality) and Solana eligible based **only on its source-reported finalized commitment**. Historical case subject IDs were used to trigger *new live* RPC acquisitions, not replayed as fresh proof.
- Additional tests: null Base receipt, mismatched EVM transaction binding, Solana confirmed/null status/missing block, invalid or duplicate network subjects before egress, quota preservation and legacy/modern MCP SDK. No Core, Hub, Lens or resolver package changes.

**Still NOT MCP COMPLETE and NOT publicly deployed:** missing live protocol-claim adapters, OP Stack L2 finality adapter, genuinely fully bound Core NetworkEvidenceResult to Hub/Lens/Maps, separate preflight/choice and useful availability/failure responses, global abuse budgets, independent final security review, documented remote third-party reproduction, revised public descriptions/privacy and explicit rollout authorization.

## Unfinished before MCP COMPLETE

- First live BEFORE/Discovery from 1–2 exact, caller-supplied Base or Solana transaction subjects now exists, but arbitrary probe discovery, per-candidate failure output, separate external choice/preflight and live capability monitoring remain unfinished.
- Exact structured protocol claims (x402 EVM, ERC-4337 and x402 SVM) and independent effect correlation.
- OP Stack L2 finality linked through its own existing evaluator; never equate it to settlement.
- Only with a genuine complete bound Core context: `NetworkEvidenceResult` → Hub → Lens → generic NE Maps; partial fragment must be rejected by Hub.
- Base Sepolia / Solana devnet full exact-action real tests with unsupported/pruned/partial failures and provider quota limits, public ingress/egress controls, independent final review, privacy/docs/registry update, owner approval.

**STOP RULE:** no Cloud Run deployment, registry update, Anthropic catalog publication, signing, transfer, spending, new Core contract or background worker from this candidate. The public `network-evidence-mcp` remains a three-tool offline demo until ALL COMPLETE gates pass.
