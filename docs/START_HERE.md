# Start here — your first Network Evidence result in five minutes

**Network Evidence (NE)** helps an agent distinguish what an exact blockchain action **actually shows** from what an application **claims**. Results record evidence sources and explicit limits; a successful transaction is **not** automatically settlement or finality.

This quickstart needs **Node.js 22**, npm and Git. The first example works **offline after installation**, with public, checksum-pinned example data. No wallet, API key, RPC account, signing or transaction is needed.

## 1 — See a verified example without an agent

In a terminal:

```bash
git clone https://github.com/ZzNible/network-evidence.git
cd network-evidence
npm ci
npm run -s demo:core-hub-lens
```

The last command checks a recorded **Base Sepolia ERC-4337** example through Core → Hub → Lens. It replays a public fixture; it does **not** fetch a fresh transaction or claim that an event is finalized. On normal broadband, this is intended as a short first run; the five-minute goal depends on Node/npm/network speed.

**What to look for:** a successful local verification with source-bound evidence and its limitations. This is an *evidence example*, not a wallet/payment workflow. The exact result can be reproduced without credentials.

## 2 — Connect an agent (same machine)

In terminal A, from the same checkout:

```bash
npm run -s mcp:serve
```

The server listens on `http://127.0.0.1:4178/mcp` and reports health at `http://127.0.0.1:4178/healthz`. In terminal B, verify the real MCP protocol:

```bash
npm run -s mcp:smoke -- --url http://127.0.0.1:4178/mcp
```

Then choose **one** agent client (one that runs on the *same machine* as the server):

**Claude Code (CLI):**

```bash
claude mcp add --transport http ne-local http://127.0.0.1:4178/mcp
claude mcp list
```

**Cursor:** in `~/.cursor/mcp.json` (merge into your existing `mcpServers` if you already use one):

```json
{
  "mcpServers": {
    "ne-local": {
      "url": "http://127.0.0.1:4178/mcp"
    }
  }
}
```

**VS Code with Copilot:** open **Chat: Open Customizations → MCP Servers → Add Server**, choose **HTTP**, enter `http://127.0.0.1:4178/mcp`, and confirm trust. Workspace-root `.mcp.json` is another option on supported versions; use current Copilot configuration guidance rather than the legacy `.vscode/mcp.json` path.

Now ask your agent:

> Use Network Evidence's `get_reviewed_evidence_case` tool with case ID `f2`. Explain what is supported, what is unknown, and the stated limitations. Do not substitute an online search.

**Important:** this default local server intentionally exposes **three offline, read-only tools**. It does **not** independently access live RPC or expose the three separately hosted/opt-in live tools. Connecting an agent is not proof that the user has a hosted service.

## 3 — View the same kind of evidence in NE Maps

Stop the local MCP server or open another terminal; run:

```bash
npm run -s maps:serve
```

Open `http://127.0.0.1:4177/` to explore the generic case atlas. Labels such as *unknown*, *unavailable* and *insufficient* are intentional. NE Maps does not upgrade an observation into finality or settlement.

## Troubleshooting and trust boundaries

- **Connection refused?** Keep `npm run -s mcp:serve` running in terminal A; check `http://127.0.0.1:4178/healthz`. Another process may be using port 4178.
- **Agent is on another computer or in a cloud workspace?** Its `127.0.0.1` is **not yours**. This guide deliberately does not expose an unauthenticated server to the Internet. A future public MCP endpoint requires a separately verified and approved deployment.
- **Only three tools listed?** That is correct for the local offline default. Do not expect the six-tool historical beta to be available at an archived URL.
- **What if a result says `supported`?** It only supports the *exact dimension* evaluated, with the stated evidence basis. Contract execution is not protocol settlement, OP Stack withdrawal finalization or physical-world truth.
- **Security:** v1.2.0 was published source-only with a known moderate transitive Hono advisory. Do not run that release as an Internet-exposed server. Check the newest signed release and dependency advisories before using a later patched version.

More details: [MCP server and limits](../packages/mcp/README.md) · [Reproducibility and provenance](release/REPRODUCTION.md) · [Source releases](https://github.com/ZzNible/network-evidence/releases) · [Security boundaries](../SECURITY_BOUNDARIES.md).

Client documentation checked when this guide was prepared: [Claude Code](https://code.claude.com/docs/en/mcp), [Cursor](https://cursor.com/docs/mcp), [VS Code Copilot](https://code.visualstudio.com/docs/agents/reference/mcp-configuration). Client interfaces and paths can change; the service's HTTP protocol is independently exercised by `mcp:smoke`, but the example vendor UIs are not claimed to have been manually tested in this release.
