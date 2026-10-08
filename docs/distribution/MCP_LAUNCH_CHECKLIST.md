# MCP launch checklist (NOT YET LAUNCHED)

> **Status: nothing in this document is live.** No public HTTPS endpoint, domain,
> registry entry, Smithery listing, ChatGPT/Codex app or plugin, ARD descriptor
> or `llms.txt` exists for Network Evidence. Every value written
> `<NOT-FOR-PUBLICATION:…>` is a placeholder and must not be copied into any
> public artifact as-is.

Today the server is `@nec/mcp` v0: local, read-only, loopback-only
Streamable HTTP by default, no authentication. An opt-in hosted preview mode is
**prepared but NOT deployed** (lot NE-MCP-RENDER-PREP). See
[`packages/mcp/README.md`](../../packages/mcp/README.md) and
[`RENDER_DEPLOY_RUNBOOK.md`](RENDER_DEPLOY_RUNBOOK.md).

Legend:
- **[verified-local]** — checked in this repository during lot NE-MCP-V0.0.1
  (or NE-MCP-RENDER-PREP where marked **[prepared]**).
- **[prepared]** — code/docs exist and were tested locally; **not deployed**.
- **[deployed]** — exists on a real public host. Nothing is marked deployed.
- **[external — verify at launch]** — an external platform requirement. It was
  NOT verified in this lot (no external accounts or network calls were used).
  Re-check it against that platform's current official documentation before acting.
- **[HUMAN]** — needs an owner decision, account, legal text or identity.

## 0. What already exists (local)

- [x] [verified-local] Three read-only tools with explicit annotations
      `readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false`.
- [x] [verified-local] MCP TypeScript SDK v2 (`@modelcontextprotocol/server` 2.3.1,
      `@modelcontextprotocol/node` 2.1.1). Serves the 2025 era (`initialize`
      handshake) and the modern 2026-07-28 era.
- [x] [verified-local] Fail-closed input validation. Core strict JSON parse of
      the raw body. Body/candidate bounds. No stack traces in errors. No payload logging.
- [x] [verified-local] Raw JSON-RPC and official SDK-client protocol tests
      (`npx vitest run packages/mcp`, `npm run -s mcp:smoke`).
- [x] [prepared] Opt-in hosted mode: `NE_MCP_MODE=hosted` + exact validated
      `NE_MCP_PUBLIC_ORIGIN`, binds `0.0.0.0:$PORT`. Exact `Host`/`Origin`
      allowlist, `X-Forwarded-*` never read. Global rate/concurrency `429`.
      Mode-specific `/healthz` scope. Tested in `packages/mcp/test/hosted.test.ts`.
- [x] [prepared] Render runbook with exact settings, FAILED/STOP states and
      rollback: [`RENDER_DEPLOY_RUNBOOK.md`](RENDER_DEPLOY_RUNBOOK.md).
- [ ] [deployed] Nothing is deployed. Nothing below this line is done unless marked [prepared].

## 1. Remote HTTPS service (prerequisite for every listing)

- [ ] [HUMAN] Choose the operator, domain and hosting. Placeholder origin:
      `<NOT-FOR-PUBLICATION:HTTPS_ORIGIN>`. Placeholder MCP URL:
      `<NOT-FOR-PUBLICATION:HTTPS_ORIGIN>/mcp`.
- [x] [prepared] Code change: hosted mode with an exact `Host`/`Origin`
      allowlist for the public hostname (TLS terminated by the platform).
      Local mode still refuses non-loopback binds.
- [ ] Independent review of the hosted mode, then explicit approval to create
      the service (plan, name, workspace: [HUMAN]).
- [ ] Decide authentication. The tools are read-only and closed-world, so
      anonymous access may be acceptable. If not, add OAuth per the MCP
      authorization spec. [external — verify at launch]
- [x] [prepared] Global in-memory rate + concurrency limits (`429`, no client
      identity stored). 1 MiB body and 16-candidate bounds kept.
- [ ] Per-client quotas / edge protection, if required. [HUMAN]
- [ ] Logging policy for the hosted service. Keep v0's rule: no bodies,
      arguments or client identifiers. Document retention.
- [ ] Data handling. `get_reviewed_evidence_case` serves only the shipped,
      pinned collection (sha256 `e10250b3…fa49`). Discovery processes
      caller-supplied contexts in memory only, with no storage.
- [ ] Uptime/support owner and incident contact. [HUMAN]
- [ ] Re-run all gates on the exact deployed commit. Record the commit SHA in
      the canonical STATUS before any listing.

## 2. Official MCP Registry (remote server)

[external — verify at launch] against the registry's current publishing guide and `server.json` schema.

- [ ] Namespace. With GitHub authentication, the server name is
      `io.github.<owner>/<server>`. The publisher proves control of the GitHub
      account/org. For a custom-domain namespace, the domain-verification
      challenge (DNS or HTTP) must be completed. [HUMAN: owner account]
- [ ] Prepare `server.json` with a **remote** entry (no npm package: `@nec/mcp`
      is `private: true` and must stay unpublished). Draft shape:

      ```jsonc
      // NOT FOR PUBLICATION — placeholders; validate against the current official schema first
      {
        "$schema": "<NOT-FOR-PUBLICATION:CURRENT_SERVER_JSON_SCHEMA_URL>",
        "name": "<NOT-FOR-PUBLICATION:io.github.OWNER/network-evidence>",
        "description": "Read-only Network Evidence: fixed profiles, Core Discovery over caller-supplied contexts, reviewed historical/synthetic cases. No live observation.",
        "version": "<NOT-FOR-PUBLICATION:VERSION>",
        "remotes": [
          { "type": "streamable-http", "url": "<NOT-FOR-PUBLICATION:HTTPS_ORIGIN>/mcp" }
        ]
      }
      ```
- [ ] Publish with the official publisher CLI after the remote service passes
      §6 against the public URL. [external — verify at launch]
- [ ] The description must not claim live availability, monitoring,
      settlement or finality.

## 3. Smithery

[external — verify at launch]

- [ ] Confirm how Smithery currently lists an externally hosted Streamable
      HTTP server (URL-based listing vs. Smithery-hosted build), and what
      config/metadata file it requires.
- [ ] Do not let a third party build or host from this repository without a
      separate reviewed lot. v0 is loopback-only by design.
- [ ] Listing text: same constraints as §2.

## 4. ChatGPT apps / Codex plugin review

[external — verify at launch] against OpenAI's current submission guidelines.

- [ ] [HUMAN] Developer/organization identity verification on the submitting account.
- [ ] [HUMAN] Public **privacy policy** URL: `<NOT-FOR-PUBLICATION:PRIVACY_URL>`.
      It must state what the hosted server logs (target: no bodies, arguments
      or identifiers) and the retention period.
- [ ] [HUMAN] **Terms of use** URL: `<NOT-FOR-PUBLICATION:TERMS_URL>`.
- [ ] [HUMAN] **Support** contact: `<NOT-FOR-PUBLICATION:SUPPORT_CONTACT>`.
- [ ] **Domain verification challenge** for `<NOT-FOR-PUBLICATION:HTTPS_ORIGIN>`
      (token file or DNS record, as the platform requires).
- [ ] Tool metadata review: names, descriptions and annotations exactly as
      served by `tools/list`. All tools are read-only and closed-world, and
      none performs a write or an external action.
- [ ] Reviewer test cases (below), run against the public URL with recorded responses.

### Reviewer test cases (5 positive, 3 negative)

Inputs for the Discovery cases are the four public demo contexts produced
exactly as in `packages/mcp/test/helpers.ts` (`loadWireDemo()`). They are
synthetic demo probes plus one archived replay, and they are not live data.

| # | type | call | expected |
| --- | --- | --- | --- |
| P1 | positive | `list_network_profiles {}` | 5 profiles (base-mainnet, base-sepolia, solana-mainnet, solana-devnet, zksys-tanenbaum). Every `currentAvailability` is `not_assessed`. zkSYS is testnet with `historical_replay` only |
| P2 | positive | `discover_network_candidates` with the 4 demo contexts, requirements execution=required, finality=desired | base-mainnet `eligible`, base-sepolia `conditional`, solana-devnet `ineligible`, solana-mainnet `eligible`; `resultArtifactDigest` `sha256:d85c2fe5ff876acf3413a25986b6a78b2eaac7fc66cc998193e72deb14dee68b`; `liveObservation: false`; `networkChoice` "none …" |
| P3 | positive | P2 with `scope: { environments: ["testnet"] }` | only base-sepolia `conditional`, solana-devnet `ineligible`; others listed out of scope |
| P4 | positive | `get_reviewed_evidence_case { caseId: "f1" }` | `evidenceClass` `historical-reviewed-public-network-fixture`, label starts `HISTORICAL`, `currentAvailability: "unknown"`, envelope verbatim |
| P5 | positive | `get_reviewed_evidence_case { caseId: "synthetic-local-core-golden" }` | `evidenceClass` `synthetic-local-fixture`, label "SYNTHETIC / LOCAL FIXTURE — not a network observation" |
| N1 | negative | P2 but `candidates[0].network.chainId = 1` | `isError: true`, code `MCP_CANDIDATE_NETWORK_MISMATCH` |
| N2 | negative | P2 but solana-devnet `snapshot.evidenceCapabilities.execution.availability = "available"` (archived made to look live) | `isError: true`, code `MCP_WIRE_DECODE_FAILED`, cause "self-digest mismatch" |
| N3 | negative | `get_reviewed_evidence_case { caseId: "../../etc/passwd" }` | `isError: true` (schema enum), no file read, no path echoed |

## 5. ARD v0.91 proposal and `llms.txt`

- [ ] **ARD v0.91 — HUMAN_REQUIRED.** The authoritative ARD v0.91 text is not
      in this repository and was not consulted in this lot. No ARD descriptor
      is drafted here, to avoid inventing fields. Before drafting: obtain the
      v0.91 spec, map each required field to an existing fact (tools,
      annotations, endpoint, auth, data handling, non-claims), and leave any
      unmapped field explicitly unresolved.
- [ ] **`llms.txt`.** Publish only on the real origin, after §1. Draft outline
      (placeholders visibly not for publication):

      ```text
      # NOT FOR PUBLICATION — draft
      # Network Evidence
      > Read-only evidence tooling. BEFORE: what an exact network/deployment can support and what is observable with evidence. AFTER: what the network itself can independently support about one exact action. No live observation by the MCP server; no wallet, signing or submission; no network ranking.

      ## MCP
      - [MCP endpoint](<NOT-FOR-PUBLICATION:HTTPS_ORIGIN>/mcp): Streamable HTTP; tools list_network_profiles, discover_network_candidates, get_reviewed_evidence_case
      - [Runbook](<NOT-FOR-PUBLICATION:REPO_URL>/blob/<COMMIT>/packages/mcp/README.md)

      ## Boundaries
      - Current support != current availability; manifest membership != live availability; archived replay current availability unknown
      - zkSYS eip155:57057 is Tanenbaum testnet / replay only
      ```

## 6. Launch gate (all required, on the exact deployed commit)

- [ ] `npm ci`, `npm run -s typecheck`, `npm test`, `npm audit --audit-level=high`.
- [ ] Demo hashes unchanged (historical `c133914937ee…082d0`, core-hub-lens
      `90e0827f223b…0898`, discovery `de3da6d9b7b5…0260`).
- [ ] `npm run -s mcp:smoke -- --url <NOT-FOR-PUBLICATION:HTTPS_ORIGIN>/mcp` passes both eras.
- [ ] P1–P5 / N1–N3 recorded against the public URL.
- [ ] `packages/core/**` unchanged. F1/F2/F3 outputs byte-identical. Maps 4th synthetic case intact.
- [ ] Independent review sign-off, then an explicit human authorization for each
      remote action (DNS, deploy, registry publish, store submission).
