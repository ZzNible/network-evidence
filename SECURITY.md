# Security policy

NE is a **source-only, read-only network evidence toolkit**. There is no independently verified public NE v1 hosted MCP endpoint. Public releases include signed source archives and checksum manifests.

## Supported release

`v1.2.1` is the current signed source checkpoint as of 13 November 2026. Earlier `v1.2.0` had a Hono advisory addressed in `v1.2.1`. A date-specific clean dependency audit does **not** establish that a server is secure for anonymous hosting.

## Private vulnerability reporting

**Do not post exploit details, secrets, private RPC responses, personal data or credentials in public Issues or PRs.**

If GitHub shows **Report a vulnerability** under the repository Security tab, use that private reporting form. Otherwise open a public Issue **requesting a private reporting channel without including sensitive details**. No response-time SLA, bounty program or maintainer email address is promised.

Provide affected commit/version, minimal reproduction, source provenance, observed impact, and whether local offline mode or a separately deployed mode is affected. Do not include wallets, seed phrases or tokens.

See [security boundaries](SECURITY_BOUNDARIES.md) and [signed releases](https://github.com/ZzNible/network-evidence/releases).
