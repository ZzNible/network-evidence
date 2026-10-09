# Network Evidence MCP — Public Connector Guide

**Public remote MCP:** `https://network-evidence-mcp-jrkc26rjga-ew.a.run.app/mcp`  
**Read-only health check:** [`/health`](https://network-evidence-mcp-jrkc26rjga-ew.a.run.app/health)  
**Official MCP Registry:** `io.github.ZzNible/network-evidence`, registry listing **v0.0.2**  
**Server-reported runtime version:** **0.0.1** (the registry listing version is separate from the software's runtime version)  
**Access:** anonymous Streamable HTTP; no OAuth or API key

Network Evidence MCP provides a narrow, deterministic interface over the public Network Evidence open-source project. Its guiding question is: **What does the underlying network itself independently support about this exact action?**

## The three tools

| Tool | What it does | Important evidence limitation |
| --- | --- | --- |
| `list_network_profiles` | Lists five fixed resolver network profiles (Base mainnet, Base Sepolia, Solana mainnet, Solana devnet, zkSYS Tanenbaum testnet) and their **declared** capabilities. | A declared profile is **not evidence of current availability**, RPC health, or support at the moment of use. |
| `discover_network_candidates` | Runs Network Evidence Core Discovery deterministically on complete, explicit network / resolver manifest / capability snapshot contexts and requirements supplied by the caller. Reports eligible, conditional, or ineligible classifications and provenance. | The server obtains **no fresh observations**, never fills missing snapshots, and does **not** rank or recommend networks. |
| `get_reviewed_evidence_case` | Returns one shipped, checksum-pinned case by ID: `f1`, `f2`, `f3` (reviewed **historical** evidence), or `synthetic-local-core-golden` (**synthetic** example). | Historical or synthetic fixtures are **not** current network evidence. Missing evidence and unresolved claims remain unresolved. |

The endpoint does **not** connect to blockchains, monitor transactions, query RPC services, evaluate live settlement/finality, use wallets or keys, sign or submit anything, or provide financial or policy recommendations. Evidence from a block inclusion alone is not universal finality.

## Using the connector

In a client supporting remote Streamable HTTP MCP, add a new server using:

```text
Name: Network Evidence MCP
Transport: Streamable HTTP
URL: https://network-evidence-mcp-jrkc26rjga-ew.a.run.app/mcp
Authentication: None
Custom request headers: None
```

Then verify tool discovery shows exactly the three names above. For a first test, call `list_network_profiles` with an **empty object** (`{}`). All returned current-support/current-availability fields are explicitly not assessed.

For `discover_network_candidates`, you must supply a **complete** validated input including `requestId`, `generatedAt`, `requirements` and `candidates`; each candidate needs `id`, `environment`, `network`, `manifest` and `snapshot`. Review the implementation and examples in [the MCP package source on GitHub](https://github.com/ZzNible/network-evidence/tree/work/ne-mcp-cloudrun-prep-20261008/packages/mcp) before constructing structured inputs.

The service enforces request validation, a bounded body size, a 16-candidate limit, and a global rate limit configured at 60 MCP requests/minute. It is hosted on Google Cloud Run in `europe-west1`, configured to scale down when idle; availability and cold-start latency are **not** production-level guarantees.

## Source, release and provenance

- [Open-source repository](https://github.com/ZzNible/network-evidence)
- [Network Evidence Suite source release v1.1.0](https://github.com/ZzNible/network-evidence/releases/tag/v1.1.0), a **different** version/release from this MCP registry listing.
- [MCP implementation and technical documentation](https://github.com/ZzNible/network-evidence/tree/work/ne-mcp-cloudrun-prep-20261008/packages/mcp)
- [MCP registry manifest](https://github.com/ZzNible/network-evidence/blob/work/ne-mcp-cloudrun-prep-20261008/server.json)

## Privacy and support

- [Privacy notice](MCP_PRIVACY_POLICY.md): describes caller-supplied request processing, application logs, Google Cloud logging, retention and rights.
- [Support and bug reports](https://github.com/ZzNible/network-evidence/issues). This is a **public issue tracker**: do not post secrets or personal/confidential data. For sensitive reports, ask for a private contact method without including the sensitive details.

**Status:** publicly accessible read-only preview. It is not a live monitoring product, not a general-purpose trust score, and does not give advice about which blockchain to use.
