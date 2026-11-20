# Follow one historical zkSYS Genesis transaction

This example follows five records from a public testnet transaction through Genesis, a Gateway index and Tanenbaum NEVM. It answers a narrow question: **which relationships do these exact archived sources support?**

The result is **six supported source observations or deterministic joins, and five insufficient claims**. The proof transaction uses **V8 MOCK TYPE 3**. A successful receipt does not mean that a real ZK proof was cryptographically verified. Syscoin PoDA publication, ChainLock finality, the historical active verifier and a destination withdrawal remain unverified.

## Try it locally

Prerequisites: Node.js 22 and Python 3.12. From the repository root:

```bash
npm ci
python3 -I examples/zksys-genesis-f4/replay.py
npm run -s maps:serve
```

The replay makes no RPC or explorer calls. After dependency installation it works from the bundled archive and writes its result to a fresh temporary directory. Expected final marker:

```text
F4_OFFLINE_REPLAY_MATCHES_MAPS_MCP 6_supported 5_insufficient 11_tamper_rejected
```

Open [the five-step Trail](http://127.0.0.1:4177/#/case/zksys-genesis-20261118/trail) on the same machine. **Trail** follows the five records; **Lens** shows the separately assessed claims, including the five `insufficient` results; **Exact action** gives each transaction, network and archive source. The green `supported` badge applies only to the sentence beside it. It is not a global verdict about settlement, finality or real ZK verification.

## The five exact records

| Step | Source and network | Exact transaction | Block | What remains unproven |
| --- | --- | --- | --- | --- |
| 1. Genesis execution | Public RPC, `eip155:57057` | `0xa018d61db50752eeda10c6d52b51fd1741cc8eb41db46d9b972677539d5fef0b` | 10968 | Receipt success does not establish PoDA, finality or destination effects. |
| 2. Edge batch 10436 recorded | Public Gateway index, `eip155:57001` | `0x321f5184dea2ff8026bc84b01df304c8936b139e64b25774ffd326853b2391d9` | 31362 | An indexer observation is not independent Gateway consensus. |
| 3. Gateway batch 9448 committed | NEVM public RPC, `eip155:5700` | `0x4661a9f890147e1ceb4dc8647eeba801ec206d4a318b299083c291b89f9820f3` | 1009176 | Range 31360–31362 and commitment are observed; a real ZK proof is not verified. |
| 4. Mock proof step accepted | NEVM public RPC, `eip155:5700` | `0xc82091801f6b0947db4bed5fb2400e07313e2730b0c37d389d2b3c5dba9fdde0` | 1009179 | **MOCK V8 TYPE 3**, not independent cryptographic verification of a real ZK proof. |
| 5. Batch execution recorded | NEVM public RPC, `eip155:5700` | `0x6498e1f4bd29000890343b377d9790b2a63db10e03d3d25fcd5ea1f9ed4f29e6` | 1009182 | Matching batch commitments do not establish a user withdrawal or ChainLock finality. |

The sixth supported claim is the separate **height-to-reported-batch lookup** for Genesis block 10968 and batch 10436. Both RPC spellings returned matching values. This lookup is height based, not a cryptographic binding to the block hash. Trail order is navigation metadata, not proof of a complete causal chain.

## Inspect or independently reproduce the bytes

- `ORIGINAL_PUBLIC_CAPTURE.zip`: 19 source responses, captured on 20 November 2026. Exact SHA-256: `a223831d3a304737e0f9e5004b25ebc1e8f18a754679b13a4770e506462384d8`.
- The archive's `capture/REPORT.json` lists each request URL, method, timestamp and response digest. Its original `CAPTURE_SCOPE.txt` records the initial private acquisition status; it does not classify a cryptographic proof.
- `verify.py`: Python standard-library offline verifier. It verifies archive integrity, strict JSON parsing, chain/transaction/block identities, event emitters, batch ranges, commitments and mock proof encoding, then rejects 11 deliberate corruptions.
- `build.ts`: consumes the exact pinned verifier report plus original Genesis receipt, transaction and block, constructs the existing Core result, then Hub and Lens. It makes no network calls and changes no Core code.
- `replay.py`: checks that the regenerated Lens and exact action match the frozen Maps/MCP case. The verifier report SHA-256 is `c32b4fedb97d5e8366afc75604b4fae996129415c8f4f38612feef0929fad1fb`.

To run the source verifier alone, without Node dependencies:

```bash
python3 -I examples/zksys-genesis-f4/verify.py examples/zksys-genesis-f4/ORIGINAL_PUBLIC_CAPTURE.zip
```

## Use the same case through local MCP

Start the [same-machine MCP](../../packages/mcp/README.md), then call its existing tool:

```json
{"name":"get_reviewed_evidence_case","arguments":{"caseId":"zksys-genesis-20261118"}}
```

It returns the same pinned envelope as Maps, with `liveObservation: false`, `currentAvailability: "unknown"` and evidence class `historical-source-bound-public-testnet-fixture`. No wallet, API key or live transaction is needed.

## Interpretation and scope

The six external evaluations use only `source_observation` or `deterministic_derivation`. They are case-level Lens claims, not new Core dimensions. Core execution and narrow data binding are supported; Core settlement and finality remain `unknown`. The five positive claims in Lens are assessed `insufficient` because the capture does not supply the required independent evidence. The replay does not retrieve PoDA bytes, query the historical verifier, verify ChainLocks, verify a real ZK proof or observe a withdrawal.

Historical sources do not establish present availability. Native Safari, uncoached novice comprehension and third-party MCP GUI compatibility require separate observation; automated tests do not establish these outcomes.
