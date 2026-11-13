# Start here — first evidence on your own machine

**Network Evidence (NE)** helps an agent distinguish what an exact blockchain action **actually shows** from what an application **claims**. Results record evidence sources and explicit limits; a successful transaction is **not** automatically settlement or finality.

Use **Node.js 22**, npm and Git. The first example works **offline after installation** on pinned public historical data; no wallet, RPC key, transaction or live blockchain lookup. Five minutes is a usability **target**, not an independently measured fresh-install time.

Latest signed source release: [v1.2.1](https://github.com/ZzNible/network-evidence/releases/tag/v1.2.1). That tag pins the immutable release source; the `main` documentation may include subsequent onboarding corrections absent from the old tag.

## 1 — See a verified example without an agent

In a terminal:

```bash
git clone https://github.com/ZzNible/network-evidence.git
cd network-evidence
npm ci
npm run -s demo:core-hub-lens
```

The last command checks a recorded **Base Sepolia ERC-4337** example through Core → Hub → Lens. It replays a public fixture; it does **not** fetch a fresh transaction or claim that an event is finalized. On normal broadband, this is intended as a short first run; the five-minute goal depends on Node/npm/network speed.

**Expected summary:** Core replay consistent; UserOperation supported; Hub equality gate passed; **finality not established**. The result and its provenance are described in the [exact-case demo guide](../examples/core-hub-lens/README.md). This is a historical fixture, not a live transaction or wallet/payment workflow.

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

**Codex CLI (actual agent call tested with CLI 0.166.0):**

```bash
codex mcp add ne-local --url http://127.0.0.1:4178/mcp
codex mcp list
```

Remove the optional saved configuration later with `codex mcp remove ne-local`. This uses the locally running server and does not connect to an NE hosted service.

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

**VS Code / Copilot (GUI not independently tested):** in the **Copilot** harness, choose **Chat: Open Customizations -> MCP Servers -> Add Server** and select a destination such as **Copilot Global** or workspace-root `.mcp.json` when offered. For a shared workspace, create `.mcp.json` at the root with the **portable** Copilot schema:

```json
{
  "mcpServers": {
    "ne-local": {
      "type": "http",
      "url": "http://127.0.0.1:4178/mcp",
      "tools": ["*"]
    }
  }
}
```

For user-wide configuration, the same `mcpServers` format belongs in `~/.copilot/mcp-config.json` (or `$COPILOT_HOME/mcp-config.json`). Do **not** use the older workspace `.vscode/mcp.json` `servers` format for new Copilot setups: it targets the deprecated Local harness and can require explicit forwarding/migration. The [current official configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration) explains both formats. For remote/Dev Containers, make sure `127.0.0.1` reaches the server from the **agent execution host**.


**Client verification scope:** actual local tool calls were tested using Claude Code and Codex **CLI**; the Cursor and VS Code **GUI workflows have not been independently tested**. A successful configuration or protocol smoke does not establish that a particular GUI agent used the tool.

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
- **Security:** v1.2.0 contained a transitive Hono advisory. The separately signed **v1.2.1** source updates Hono to 4.13.18; GitHub and npm advisories were zero after re-indexing on 13 November 2026. This is a dated dependency check, **not** a production-hosting security certification.

- **Old official MCP Registry entry?** The official listing for remote version `0.0.2` was marked **deprecated on 14 November 2026**, because its older Cloud Run endpoint was unavailable (HTTP 500/503 when checked). That historical URL **is not** an installation method for local v1.2.1. Do not confuse registry presence with a verified working endpoint.

More details: [MCP server and limits](../packages/mcp/README.md) · [Reproducibility and provenance](release/REPRODUCTION.md) · [Case examples](USE_CASES.md) · [Source releases](https://github.com/ZzNible/network-evidence/releases) · [Security boundaries](../SECURITY_BOUNDARIES.md).

Client documentation checked when this guide was prepared: [Claude Code](https://code.claude.com/docs/en/mcp), [Cursor](https://cursor.com/docs/mcp), [VS Code Copilot](https://code.visualstudio.com/docs/agents/reference/mcp-configuration). Client interfaces and paths can change; the service's HTTP protocol is independently exercised by `mcp:smoke`, but the example vendor UIs are not claimed to have been manually tested in this release.
