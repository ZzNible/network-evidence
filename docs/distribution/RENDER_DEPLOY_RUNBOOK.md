# Render deploy runbook — Network Evidence MCP hosted preview (PREPARED, NOT DEPLOYED)

> **Status: prepared only.** No Render service, workspace, plan, domain, DNS
> record or public URL exists or was created for this. Nothing here was run
> against Render. Every `<…>` value is a placeholder chosen by a human at
> deploy time. Do not copy a placeholder into a public artifact, and do not
> guess the hostname: copy it from the Render dashboard after creation.
>
> The hosted mode is an **anonymous, read-only preview**. It is not a reviewed,
> secure production service: no authentication, global (not per-client) limits
> only. Independent review and explicit human approval are required before
> creating the service and again before any directory/registry listing.

Code: `packages/mcp` hosted mode (`NE_MCP_MODE=hosted`). Behaviour and
variables: [`packages/mcp/README.md`](../../packages/mcp/README.md#hosted-preview-mode-opt-in-not-deployed).

Legend: **[verified-local]** checked in this repository; **[external — verify]**
a Render fact from the task brief or general platform knowledge, NOT checked
against Render in this lot; **[HUMAN]** owner decision.

## 0. Human decisions required before step 1

| decision | status |
| --- | --- |
| Approve creating a public, anonymous, read-only preview at all | [HUMAN] open |
| Render workspace / owner account | [HUMAN] open |
| Service name (determines the `onrender.com` hostname) | [HUMAN] open |
| Plan. The Free plan spins down after 15 min idle (cold starts), so it is unsuitable for reliable directory usage [external — verify] | [HUMAN] open |
| Exact commit SHA to deploy (must have passed §2 on that SHA) | [HUMAN] open |
| Custom domain (optional; needs DNS + `NE_MCP_CUSTOM_ORIGIN`) | [HUMAN] open, not required |
| Health check path (see §3, default: unset) | [HUMAN] open |
| Privacy text covering platform-level logs (Render's edge may log client IPs; this server does not) | [HUMAN] open |

## 1. Platform facts this design relies on [external — verify]

- A Render Web Service must listen on `0.0.0.0` and on the port in the `PORT`
  environment variable that Render sets.
- Render terminates HTTPS at its edge and forwards plain HTTP to the service.
  The service assumes the forwarded `Host` header is the public hostname. The
  first public `/healthz` (§5) confirms or refutes this.
- The `<service>.onrender.com` hostname is assigned when the service is
  created. It is not known in advance and must not be invented.
- The service never reads `X-Forwarded-*`/`Forwarded`. A caller can set them,
  so they carry no trust.

## 2. Pre-deploy gates on the exact commit (local, [verified-local] commands)

```sh
git rev-parse HEAD                          # record; this is <DEPLOY_SHA>
git status --short                          # must be empty
npm ci
npm run -s typecheck
npm test                                    # all files/tests pass
npm audit --audit-level=high                # exit 0
npm run -s mcp:smoke                        # ends "SMOKE OK"
npx vitest run packages/mcp                 # includes test/hosted.test.ts
npm run -s demo:historical-compat | sha256sum   # c133914937ee2970777823c002ccdd99a0dcb72823ce22f4c4965df43fe082d0
npm run -s demo:core-hub-lens     | sha256sum   # 90e0827f223bbc2131fee438ad343946c6265c5e5ed8565ef466a0afa7cb0898
npm run -s demo:discovery         | sha256sum   # de3da6d9b7b5ca5c0b328dbf6e8c72948739ae84c5fc6f406b762b0fd7d20260
npm run -s maps:collection                  # verifies the pinned collection
npm run -s demo:integrability               # verifies the integrability fixture
git rev-parse HEAD:packages/core            # b8ed923c9f43d17365f224e3f03f3df3135c5e87
```

Any mismatch: **STOP**. Do not deploy.

### Local hosted rehearsal (optional, binds 0.0.0.0 on this machine)

`mcp.example.org` is an RFC 2606 documentation name, used only to simulate the
forwarded `Host`:

```sh
NE_MCP_MODE=hosted NE_MCP_PUBLIC_ORIGIN=https://mcp.example.org PORT=18417 npm run mcp:serve
# expected stdout:
# Network Evidence MCP v0 [hosted preview v0: anonymous, read-only, offline; not a reviewed production service] listening on 0.0.0.0:18417; accepted public origin(s): https://mcp.example.org; endpoint /mcp, health /healthz

curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18417/healthz -H 'Host: mcp.example.org'          # 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18417/healthz                                     # 403 (loopback Host)
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18417/healthz -H 'Host: evil.example' -H 'X-Forwarded-Host: mcp.example.org'   # 403
```

## 3. Render service settings (to enter by a human; nothing created yet)

| setting | value |
| --- | --- |
| Service type | Web Service |
| Runtime / language | Node |
| Repository | `https://github.com/ZzNible/network-evidence` (public) |
| Branch / commit | [HUMAN] the branch containing `<DEPLOY_SHA>`; deploy that exact commit |
| Region | Frankfurt |
| Root directory | *(empty: repository root; npm workspaces need the root lockfile)* |
| Build command | `npm ci --include=dev` |
| Start command | `npm run mcp:serve` |
| Auto-Deploy | **Off** (manual deploys only, pending explicit approval of each deploy) |
| Plan | [HUMAN] (see §0, Free plan unsuitable for directory usage) |
| Name | [HUMAN] |
| Health check path | leave **unset** for the first deploy (port detection only). The hosted Host guard answers `403` to any `Host` other than the configured hostname. Whether Render's internal health checker sends that `Host` is NOT verified. Setting `/healthz` is a [HUMAN] decision after §5 succeeds. **Never** widen Host validation to make a health check pass. |

Environment variables:

| key | value |
| --- | --- |
| `NE_MCP_MODE` | `hosted` |
| `NE_MCP_PUBLIC_ORIGIN` | `https://<SERVICE-HOSTNAME>.onrender.com`, the exact hostname Render shows after creation; lowercase, no trailing slash, no path |
| `NODE_VERSION` | `22` (rehearsed locally on Node v22.23.2; `engines` requires ≥ 20.12) [external — verify the variable name and accepted format] |
| `NE_MCP_CUSTOM_ORIGIN` | *(unset unless a custom domain is approved and verified)* |
| `NE_MCP_MAX_CONCURRENT` | *(unset → 8)* |
| `NE_MCP_RATE_LIMIT_PER_MINUTE` | *(unset → 240, global across all callers)* |
| `PORT` | **do not set**. Render provides it [external — verify] |
| `NE_MCP_HOST`, `NE_MCP_PORT` | **do not set**. Hosted mode refuses them |

### Observed runtime dependencies (lockfile at this commit)

- The server runs from TypeScript source through **`tsx` 4.23.12** (root
  devDependency `^4.23.0`, with esbuild 0.28.2). The build must install
  devDependencies, hence `npm ci --include=dev`. Without them the start fails
  with `tsx: not found`.
- MCP SDK runtime: `@modelcontextprotocol/server` 2.3.1 (with
  `@modelcontextprotocol/core` 2.3.1), `@modelcontextprotocol/node` 2.1.1 (with
  `@hono/node-server` 1.19.17 and `hono`), `zod` 4.6.5. Plus workspace packages
  `@nec/core`, `@nec/discovery`, `@nec/lens`, `@nec/resolver-*`.
- `@modelcontextprotocol/client` 2.3.1 is dev-only (smoke/tests).
- The one data file read at startup is `examples/ne-maps/data/collection.json`,
  pinned at sha256 `e10250b3f4714883f54c96003f1cdb5f1c2ed36cb7bd18dcf3f94b194139fa49`.
  It is resolved relative to the package source, so the full repository
  checkout must be deployed (Root directory empty). A mismatch aborts startup
  with `startup failed (reviewed case store: … does not match the pinned …)`.

## 4. Deploy sequence (each step needs explicit human authorization)

1. Create the Web Service with §3 settings, **Auto-Deploy Off**. Note the
   assigned hostname exactly as displayed.
2. If Render starts a build/deploy at creation before `NE_MCP_PUBLIC_ORIGIN`
   is set, it is **expected to FAIL** (exit 1, see §6). The service fails
   closed. Do not work around it.
3. Set `NE_MCP_MODE=hosted` and `NE_MCP_PUBLIC_ORIGIN=https://<assigned hostname>`.
4. Manual deploy of `<DEPLOY_SHA>`. Expected log line:
   `Network Evidence MCP v0 [hosted preview v0: anonymous, read-only, offline; not a reviewed production service] listening on 0.0.0.0:<PORT>; accepted public origin(s): https://<assigned hostname>; endpoint /mcp, health /healthz`
5. Run §5. On any failure → §7 rollback and STOP.
6. Record in the canonical STATUS: deployed SHA, service name, region, plan,
   hostname, date, and §5 outputs. Listing anywhere remains a separate
   approval (see `MCP_LAUNCH_CHECKLIST.md` §2–§6).

## 5. Post-deploy smoke (against the real hostname, once it exists)

```sh
HOST=<assigned hostname>                     # copy from Render, e.g. the *.onrender.com name
curl -s https://$HOST/healthz                # 200; "mode":"hosted"; scope "hosted preview v0: …"; networkIo "none"
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://$HOST/mcp \
  -H 'Origin: https://evil.example' -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'     # 403
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://$HOST/mcp \
  -H 'content-type: text/plain' -d '{}'                   # 415
npm run -s mcp:smoke -- --url https://$HOST/mcp          # both eras; ends "SMOKE OK"
```

Then record the launch-checklist reviewer cases P1–P5 / N1–N3 against
`https://$HOST/mcp`.

## 6. FAILED / STOP states

| observed | meaning | action |
| --- | --- | --- |
| `Network Evidence MCP v0: NE_MCP_PUBLIC_ORIGIN is required in hosted mode (exact https origin)`, exit 1 | origin not set | FAILED (expected before step 3). Set it, manual redeploy |
| `… NE_MCP_PUBLIC_ORIGIN must be an exact canonical origin (lowercase https://host, no path, query, fragment or trailing slash)` | e.g. trailing `/` or uppercase | fix the value; never add a path |
| `… NE_MCP_PUBLIC_ORIGIN must not contain a wildcard` / `must use https://` / `must not be a localhost-class or special-use hostname` / `must be a DNS hostname, not an IP address` | unsafe value | STOP; use the exact assigned hostname |
| `… hosted mode requires PORT (set by the hosting platform)` | no `PORT` injected | STOP; not running as a Render Web Service. Do not hard-code a port |
| `… hosted mode binds 0.0.0.0:$PORT only; --host/--port/NE_MCP_HOST/NE_MCP_PORT are refused` | extra bind variables set | remove them |
| `… NE_MCP_PUBLIC_ORIGIN / NE_MCP_CUSTOM_ORIGIN are set but NE_MCP_MODE is not "hosted"; refusing to guess the mode` | mode flag missing | set `NE_MCP_MODE=hosted` (or this is the intended kill switch, §7) |
| `… NE_MCP_MODE must be "local" (default) or "hosted"` | typo (case-sensitive) | fix |
| `… maxConcurrent (NE_MCP_MAX_CONCURRENT) must be an integer in 1..64` (or the rate variant) | limit out of bounds | fix or unset |
| log shows `listening on http://127.0.0.1:4178/mcp` | started in LOCAL mode (no hosted variables) | FAILED: Render cannot reach a loopback bind. STOP, set hosted variables |
| `… startup failed (reviewed case store: …)` | pinned data mismatch or invalid collection | STOP: wrong or modified commit |
| build log `tsx: not found` | devDependencies not installed | build command must be `npm ci --include=dev` |
| public `/healthz` → `403 {"…":"Forbidden: Host not allowed"}` | `NE_MCP_PUBLIC_ORIGIN` ≠ actual hostname, or the platform does not forward the public `Host` | STOP. Correct the variable to the exact hostname. If it already matches, record as HUMAN_REQUIRED. **Never** widen or wildcard the allowlist |
| Render health check failing with 403 | internal checker uses a different `Host` | STOP; unset the health check path; HUMAN decision |
| smoke prints `SMOKE FAILED (n)` or any P/N case deviates | behaviour differs from the reviewed commit | rollback (§7), STOP |
| `429 Too Many Requests: global server limit reached` during smoke | global budget/concurrency reached (possibly by other callers) | wait `Retry-After` and retry once. Raising limits is a HUMAN decision |
| first request after idle is slow / times out on Free plan | spin-down cold start | expected on Free; not acceptable for directory listing |

## 7. Rollback / kill switch [external — verify the dashboard wording]

- **Fastest fail-closed stop:** delete `NE_MCP_MODE` (keep `NE_MCP_PUBLIC_ORIGIN`)
  and redeploy. The process then refuses to start (`… set but NE_MCP_MODE is not
  "hosted" …`), so nothing is served.
- Or **Suspend** the service in the Render dashboard, or roll back to the
  previous successful deploy from the service's deploy history.
- Nothing in Git needs reverting: no push, tag or release is part of this
  runbook. The tagged release `v1.1.0` is unaffected.
- After any rollback: record the reason and SHA in the canonical STATUS.

## 8. What this preview does and does not do

- Three tools, unchanged: fixed profiles (never live, `not_assessed`), Core
  Discovery over caller-supplied contexts (no ranking, no live observation),
  pin-checked historical F1–F3 plus the synthetic Maps case (replay current
  availability `unknown`).
- No outbound network I/O, wallet, signing, transaction execution, live
  settlement or arbitrary file paths. Request body ≤ 1 MiB; ≤ 16 candidates.
- Logs: one line per request (method, route, status, duration). No IPs,
  headers, bodies, arguments or identifiers. Render's own platform logs are
  outside this code. Their retention must be covered by the privacy text [HUMAN].
