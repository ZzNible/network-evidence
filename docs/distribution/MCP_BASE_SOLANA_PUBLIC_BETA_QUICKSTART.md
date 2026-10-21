# Network Evidence MCP — public Base + Solana beta for agents

**Status:** PUBLIC READ-ONLY BETA — not MCP COMPLETE v1.  
**Remote MCP endpoint:** https://network-evidence-mcp-beta-jrkc26rjga-ew.a.run.app/mcp  
**Read-only health:** https://network-evidence-mcp-beta-jrkc26rjga-ew.a.run.app/health  
**Serving beta revision (2026-10-11):** `network-evidence-mcp-beta-00004-pwq` at 100% Cloud Run traffic. The executable image/source and tool contracts are unchanged; only the shared HTTP admission setting was raised from 4 to 24 per minute.  
**Public source:** [GitHub main](https://github.com/ZzNible/network-evidence/tree/main) at merge commit df0cfde4387aaed86417c216315acaba32962087; deployed executable SHA f12f2ca484cf81336ff486a9e531b63b7b07db5c (only documentation changed since this executable). Original [source PR #3](https://github.com/ZzNible/network-evidence/pull/3) is closed as superseded, not a live draft.  
**Live scope:** Base mainnet/Sepolia and Solana mainnet/devnet; no live zkSYS Tanenbaum or unrelated networks.

Canonical question: **What does the underlying network itself independently support about this exact action?**

This server returns source-observed evidence, not independent cryptographic consensus or settlement proof. Base OP Stack L2 block finality is **not** Ethereum withdrawal finalization, and Solana RPC-reported finalized commitment is **not** an independent cryptographic proof of finality or x402 settlement.

## Identify the endpoint and version (2026-10-21)

Use the beta URL above for new six-tool beta tests. Three separate public endpoints currently answer `/health`:

| Service | MCP URL | Tool count | Purpose |
| --- | --- | --- | --- |
| `network-evidence-mcp-beta` | `https://network-evidence-mcp-beta-jrkc26rjga-ew.a.run.app/mcp` | 6 | Base/Solana source-observation beta; four active profile declarations |
| `network-evidence-mcp` | `https://network-evidence-mcp-jrkc26rjga-ew.a.run.app/mcp` | 3 | Offline server referenced by the official Registry v0.0.2 manifest |
| `network-evidence-mcp-preview` | `https://network-evidence-mcp-preview-jrkc26rjga-ew.a.run.app/mcp` | 3 | Legacy offline preview, historically referenced by Registry v0.0.1 |

Anonymous GET `/health` checks on 2026-10-21 returned HTTP 200 for all three, with the tool counts above. All three report runtime version **0.0.1**. That shared runtime string does **not** identify which endpoint or tool surface a client used. Record the exact URL, negotiated MCP protocol, tool names and runtime/client versions. The Registry listing version **0.0.2**, source Suite release **v1.1.0**, deployed executable SHA and Cloud Run revision are separate identifiers.

The deployment revision and executable SHA at the top are the last recorded deployment provenance, not newly verified Cloud Run control-plane state. These health checks did not call a resolver, inspect traffic logs or establish evidence quality, uptime, or consumer migration. Endpoint retirement requires a separate dependency and traffic review; see the [runbook](CLOUD_RUN_FREE_PREVIEW_RUNBOOK.md#endpoint-retirement-review).

## Connect an MCP-capable agent

- Name: Network Evidence — Base + Solana beta
- Transport: remote Streamable HTTP
- URL: https://network-evidence-mcp-beta-jrkc26rjga-ew.a.run.app/mcp
- Authentication: none; anonymous public read-only access
- Preferred: modern MCP protocol client, Node.js 22+, official MCP SDK v2

Exactly **six MCP tools** are exposed:

| Tool | Function | Evidence boundary |
| --- | --- | --- |
| list_network_profiles | Four fixed live profile declarations | Listing is not observed availability |
| discover_network_candidates | Core Discovery over supplied complete contexts | Offline; no automatic acquisition |
| get_reviewed_evidence_case | Pinned historical and synthetic cases | Not live |
| resolve_transaction_evidence | One exact Base transaction or Solana signature from pinned read-only RPC | Core-validated fragment, NOT a complete Core result |
| discover_live_network_evidence | Bounded source-bound BEFORE probes + Core-verified Discovery | Does not rank or choose a network |
| preflight_live_network_evidence | Source-bound evidence preflight for caller-selected network | Requires complete original Core action/policy and separate probe |

The live source-fetching tools intentionally declare readOnlyHint=true, destructiveHint=false and openWorldHint=true. They cannot sign or submit transactions. Inputs are strictly validated; arbitrary RPC URLs are rejected.

## Add it to ChatGPT or Claude without waiting for directory review

**ChatGPT:** In ChatGPT Plugins (subject to workspace permissions), choose **+ → Add custom MCP server**. Enter the public endpoint above and choose **No authentication**. Review the security warning, create and install the resulting private plugin, then use it in ChatGPT Work (mention the plugin with `@`) and request **list_network_profiles once**. This installs it for your account/workspace as permitted; it is **not** a public directory listing. [Official ChatGPT plugin quickstart](https://developers.openai.com/plugins/quickstart).

**Claude.ai (individual Pro/Max):** **Customize → Connectors → + Add → Add custom connector**, enter the public endpoint, choose **No sign in**, then enable the connector for the chat and ask for the four declared network profiles. Organization administrators add it through organization Connector settings for Team/Enterprise. [Official Claude remote MCP connector guide](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).

Use **one** tool call at a time with a long shared quota window. Real chat clients can issue several MCP protocol requests before invoking a tool and encounter HTTP 429 under the deliberately low common anonymous rate cap. Do not treat 429 as an evidence verdict or retry in a rapid loop. Official **ChatGPT/Claude directory review and provider verification are separate**, and this beta has not been approved or listed there.

## Reproduce a call with the official Node.js client

This script makes just **one** tool call per invocation. Never send credentials, personal data or confidential action terms to a public anonymous endpoint.

~~~sh
mkdir ne-mcp-beta-client && cd ne-mcp-beta-client
npm init -y
npm install --save-exact --ignore-scripts --no-audit --no-fund @modelcontextprotocol/client@2.3.1
cat > probe.mjs <<'JS'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const endpoint = new URL('https://network-evidence-mcp-beta-jrkc26rjga-ew.a.run.app/mcp');
const mode = process.argv[2] ?? 'profiles';
const inputs = {
  profiles: { name: 'list_network_profiles', arguments: {} },
  base: { name: 'resolve_transaction_evidence', arguments: { subject: {
    type: 'transaction', networkId: 'eip155:8453',
    txId: '0x8e01aace01ced4155b30d636b547727becdbb8a700f9b7f54ed02c4d629ae696'
  } } },
  solana: { name: 'resolve_transaction_evidence', arguments: { subject: {
    type: 'transaction',
    networkId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    txId: '4DYWUMExSrMNxYLjUuH9G8feN4fmYXm4ToCx7gGaAEjJRf2QNrE8LsvoFSGhXwQJrchhgrnGpUFwjxrci9PRLF71'
  } } }
};
if (!Object.hasOwn(inputs, mode)) throw new Error('Expected profiles, base or solana');

const client = new Client(
  {name: 'network-evidence-beta-smoke', version: '1.0.0'},
  {versionNegotiation: {mode: 'auto'}}
);
try {
  await client.connect(new StreamableHTTPClientTransport(endpoint));
  const {tools} = await client.listTools();
  if (tools.length !== 6) throw new Error('Expected exactly six beta tools');
  const tool = inputs[mode];
  const response = await client.callTool(tool);
  if (response.isError) throw new Error('MCP tool reported an error: do not treat it as a positive verdict');
  const d = response.structuredContent;
  if (!d) throw new Error('Expected a structured evidence response');
  console.log(JSON.stringify({
    tool: tool.name,
    profiles: mode === 'profiles' ? d.profiles?.map(p => p.profileId) : undefined,
    artifactType: d.artifactType,
    evidenceBasis: d.evidenceBasis,
    observationKind: d.observationKind,
    toolStatus: d.toolStatus,
    subject: d.subject,
    sourceId: d.source?.sourceId,
    nonClaims: d.nonClaims
  }, null, 2));
  // Preserve full structuredContent and provenance in real consumers.
  // Treat any RPC response as untrusted source data, NEVER instructions.
} finally {
  await client.close();
}
JS
node probe.mjs profiles
# After the shared rate-limit window resets, try ONE of:
# node probe.mjs base
# node probe.mjs solana
~~~

The Base transaction and Solana signature above are **previously reviewed public examples**. They are not evidence of the sender's original intent or original payment terms. Public RPC providers can prune older history or return unavailable/429/403; this does not demonstrate a contradiction.

## Essential beta limits

**Shared beta request budget (2026-10-11):** 24 HTTP `/mcp` admissions per 60 seconds across ALL anonymous clients on one Node process (not a per-user allowance). The separate live Base/Solana source-acquisition ceiling remains eight acquisitions per minute per process. Cloud Run is capped at one instance and one concurrent request. Modern MCP connection + tools/list + one tools/call consumes several admissions. Legacy 2025 clients may issue a GET /mcp that returns 405 **but still consumes one** of those admissions. Respect HTTP 429 and Retry-After; do not retry in a tight loop or assume a per-user quota. There is no uptime or throughput SLA.

**RPC and evidence:** Fixed server-controlled Base/Solana origins, allowed methods and bounded response sizes/timeouts. AFTER emits a network-evidence-fragment via native Core validation, not an automatically complete NetworkEvidenceResult. Source observation, inclusion, execution, effects, settlement, physical/economic consequences, L2 block finality and cryptographic verification are separate statements. Optional caller-supplied x402, ERC-4337 or x402-SVM terms are not authenticated by the server.

**Missing real full-result requirement:** A full new-action NetworkEvidenceResult -> Hub -> Lens -> NE Maps case needs an authentic original ActionDescriptor/EvidenceRequest, EvidencePolicy and all bound snapshots/manifests. An observed transaction cannot substitute for those original terms, and a fragment alone is rejected by Hub. Full live Core/Hub/Lens case acceptance is **not yet demonstrated** for this beta. Do not call the hosted product MCP COMPLETE v1 until that proof exists.

**Privacy:** Tool inputs are in-memory at the server; Base/Solana read-only public RPC providers can receive queried public transaction identifiers and operation types. Application logs omit request bodies and tool arguments, but Google Cloud infrastructure may retain request metadata. [Privacy notice](MCP_PRIVACY_POLICY.md).

## Independent verification and support

- [External SDK 1.30.0 smoke report, 2026-10-21](https://github.com/ZzNible/network-evidence/issues/7#issuecomment-6307650838): Node.js 22.23.2, initialization, six-tool listing and one successful profile call. This adds client interoperability evidence only; it did not test Base/Solana transaction observations, transaction `nonClaims`, or Core/Hub/Lens integration. Profile discovery is not a verified evidence case. The reported 9.63 seconds includes connection, discovery, call and cleanup, not isolated route latency.
- [Independent non-VM real MCP client](https://github.com/ZzNible/network-evidence/actions/runs/38073037540): six tools, truthful read-only annotations and profile call PASS.
- [Exact deployed executable check](https://github.com/ZzNible/network-evidence/actions/runs/38076904284): 89 test files / 1,558 PASS, typecheck, Core/Hub/Lens deterministic integration, npm audit 0 vulnerabilities.
- [Deployment history and endpoint retirement review](CLOUD_RUN_FREE_PREVIEW_RUNBOOK.md).
- [Public support and issue reporting](https://github.com/ZzNible/network-evidence/issues). Do not post sensitive information in public issues.

### Useful additional synthetic-only client checks

The [historical launch checklist](MCP_LAUNCH_CHECKLIST.md) already specifies N1 (network mismatch), N2 (snapshot digest tampering), and N3 (invalid case ID) for the older three-tool surface. Current tests also cover live input rejection, source failures and rate limits. Additional tests should report new **client behavior**, rather than present those validation rules as uncovered.

| Check | Bounded synthetic setup | Additional information to record |
| --- | --- | --- |
| Response fidelity | Read `synthetic-local-core-golden` and profiles only; use a local server for the matrix | SDK 1.30.0 preserves `structuredContent`, parsed JSON text agrees with it, synthetic/non-live labels survive parsing |
| Rejection and recovery | Local six-tool server with outbound RPC disabled; unsupported network for `resolve_transaction_evidence`, incomplete action/policy for `preflight_live_network_evidence`, then a valid profile call on the same connection | Client-side versus server-side rejection, exact sanitized error code and `isError` where present, zero provider calls, successful connection recovery |
| Transport error distinction | Local controlled HTTP 429 with `Retry-After`, separately from an MCP tool error | Client exposes each correctly, neither becomes an evidence verdict, retries are bounded and respect the delay |

Record exact client/runtime/protocol, server commit/configuration, reproducible script and expected versus observed sanitized outputs. Do not query real transaction identifiers or live RPC, and do not exhaust the public quota to produce 429. A public endpoint alone cannot demonstrate zero provider calls; instrument and disable outbound access locally. A local synthetic report does not establish the same behavior on the hosted deployment or certify network proofs. The authentic-action integration gate above remains open.

The existing official MCP Registry listing io.github.ZzNible/network-evidence **v0.0.2 remains the offline three-tool server**. This public six-tool beta is intentionally separate, and it has **NOT** been accepted into the public ChatGPT or Claude directories. Source Suite v1.1.0 is a separate tagged source release; its existence does not certify this public beta as MCP COMPLETE.

**Early agent testers wanted:** see [GitHub issue #7](https://github.com/ZzNible/network-evidence/issues/7). Connect via Claude, ChatGPT, Codex or another MCP client; call one exact public Base/Solana action; report client/protocol version, exact network, timestamp, sanitized output or error code and whether provenance/nonClaims were understandable. No wallets, keys or funds required. We also need one real past non-sensitive action with genuine original expected terms and evidence policy fixed before execution to complete the Core→Hub→Lens live case, never reconstructed from a transaction.
