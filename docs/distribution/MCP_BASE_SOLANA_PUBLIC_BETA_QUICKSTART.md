# Network Evidence MCP — public Base + Solana beta for agents

**Status:** PUBLIC READ-ONLY BETA — not MCP COMPLETE v1.  
**Remote MCP endpoint:** https://network-evidence-mcp-beta-jrkc26rjga-ew.a.run.app/mcp  
**Read-only health:** https://network-evidence-mcp-beta-jrkc26rjga-ew.a.run.app/health  
**Public source:** [GitHub main](https://github.com/ZzNible/network-evidence/tree/main) at merge commit df0cfde4387aaed86417c216315acaba32962087; deployed executable SHA f12f2ca484cf81336ff486a9e531b63b7b07db5c (only documentation changed since this executable). Original [source PR #3](https://github.com/ZzNible/network-evidence/pull/3) is closed as superseded, not a live draft.  
**Live scope:** Base mainnet/Sepolia and Solana mainnet/devnet; no live zkSYS Tanenbaum or unrelated networks.

Canonical question: **What does the underlying network itself independently support about this exact action?**

This server returns source-observed evidence, not independent cryptographic consensus or settlement proof. Base OP Stack L2 block finality is **not** Ethereum withdrawal finalization, and Solana RPC-reported finalized commitment is **not** an independent cryptographic proof of finality or x402 settlement.

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

**Shared beta request budget:** Four HTTP /mcp admissions per 60 seconds across ALL anonymous clients on one Node process. Cloud Run is capped at one instance and one concurrent request. Modern MCP connection + tools/list + one tools/call consumes several admissions. Legacy 2025 clients may issue a GET /mcp that returns 405 **but still consumes one** of those admissions. Respect HTTP 429 and Retry-After; do not retry in a tight loop or assume a per-user quota. There is no uptime or throughput SLA.

**RPC and evidence:** Fixed server-controlled Base/Solana origins, allowed methods and bounded response sizes/timeouts. AFTER emits a network-evidence-fragment via native Core validation, not an automatically complete NetworkEvidenceResult. Source observation, inclusion, execution, effects, settlement, physical/economic consequences, L2 block finality and cryptographic verification are separate statements. Optional caller-supplied x402, ERC-4337 or x402-SVM terms are not authenticated by the server.

**Missing real full-result requirement:** A full new-action NetworkEvidenceResult -> Hub -> Lens -> NE Maps case needs an authentic original ActionDescriptor/EvidenceRequest, EvidencePolicy and all bound snapshots/manifests. An observed transaction cannot substitute for those original terms, and a fragment alone is rejected by Hub. Full live Core/Hub/Lens case acceptance is **not yet demonstrated** for this beta. Do not call the hosted product MCP COMPLETE v1 until that proof exists.

**Privacy:** Tool inputs are in-memory at the server; Base/Solana read-only public RPC providers can receive queried public transaction identifiers and operation types. Application logs omit request bodies and tool arguments, but Google Cloud infrastructure may retain request metadata. [Privacy notice](MCP_PRIVACY_POLICY.md).

## Independent verification and support

- [Independent non-VM real MCP client](https://github.com/ZzNible/network-evidence/actions/runs/38073037540): six tools, truthful read-only annotations and profile call PASS.
- [Exact deployed executable check](https://github.com/ZzNible/network-evidence/actions/runs/38076904284): 89 test files / 1,558 PASS, typecheck, Core/Hub/Lens deterministic integration, npm audit 0 vulnerabilities.
- [Detailed beta source and rollback runbook](https://github.com/ZzNible/network-evidence/blob/work/ne-mcp-multichain-20261009/docs/distribution/CLOUD_RUN_FREE_PREVIEW_RUNBOOK.md).
- [Public support and issue reporting](https://github.com/ZzNible/network-evidence/issues). Do not post sensitive information in public issues.

The existing official MCP Registry listing io.github.ZzNible/network-evidence **v0.0.2 remains the offline three-tool server**. This public six-tool beta is intentionally separate, and it has **NOT** been accepted into the public ChatGPT or Claude directories. Source Suite v1.1.0 is a separate tagged source release; its existence does not certify this public beta as MCP COMPLETE.

**Early agent testers wanted:** see [GitHub issue #7](https://github.com/ZzNible/network-evidence/issues/7). Connect via Claude, ChatGPT, Codex or another MCP client; call one exact public Base/Solana action; report client/protocol version, exact network, timestamp, sanitized output or error code and whether provenance/nonClaims were understandable. No wallets, keys or funds required. We also need one real past non-sensitive action with genuine original expected terms and evidence policy fixed before execution to complete the Core→Hub→Lens live case, never reconstructed from a transaction.
