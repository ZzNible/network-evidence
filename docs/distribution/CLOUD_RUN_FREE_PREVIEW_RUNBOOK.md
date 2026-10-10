# Cloud Run deployment runbook — Network Evidence MCP v0 (PUBLIC, BOUNDED)

**CURRENT (2026-10-09):** public endpoint `https://network-evidence-mcp-jrkc26rjga-ew.a.run.app/mcp` on service **`network-evidence-mcp`**, region `europe-west1`, revision `network-evidence-mcp-00003-989` (**observed read-only in Cloud Run on 2026-10-09**). Earlier rollout reused the **identical immutable image digest** of the old preview (`sha256:bd1157db86fd6720e0d5e71e282d8590082f4882211578cb1f6628e8b1ed8d22`), without rebuilding or changing Core. New host is in the exact `NE_MCP_PUBLIC_ORIGIN` allowlist. Anonymous GET `/health` HTTP 200; both MCP SDK protocol eras passed three tools, five network profiles, Core Discovery digest `sha256:d85c2fe5ff876acf3413a25986b6a78b2eaac7fc66cc998193e72deb14dee68b`, and negative cases. Foreign Origin was rejected in private test. Concurrency 4, min instances 0, max 1, 1 vCPU/512 MiB, MCP admission limit 60/min **per Node process, not across instances**. Google Billing Cloud Run scoped monthly 2 EUR spend cap is configured but not a guarantee against overage or auxiliary services. Official Registry `io.github.ZzNible/network-evidence` version **0.0.2 ACTIVE** points to this new endpoint ([OIDC publication run](https://github.com/ZzNible/network-evidence/actions/runs/37905012273)). Private ChatGPT workspace plugin `0.1.2`, Codex, and Claude Code migrated; real tool calls checked for the latter two. **Claude directory browser draft must still be updated manually**. This MCP remains an offline, read-only preview, not live monitoring or a production SLA.

**LEGACY ROLLBACK:** Old Cloud Run service `network-evidence-mcp-preview`, revision `00003-v99`, remains publicly active at `https://network-evidence-mcp-preview-jrkc26rjga-ew.a.run.app/mcp`; official Registry `0.0.1` points there. Do not remove this service until the Anthropic submission and other consumers have migrated. Render Free is a secondary rollback. **Commands below referencing `network-evidence-mcp-preview` describe the original preview deployment, not the current target.**

## 0. Fixed boundaries

- Base: `0652616ecd27cd8079d3de272e561a7ac4067581` (previous Render preview, independently reviewed), no changes to `packages/**`, `examples/**` or the tagged `v1.1.0` release.
- `packages/core` tree remains `b8ed923c9f43d17365f224e3f03f3df3135c5e87`.
- Exactly three MCP tools, unchanged: `list_network_profiles`, `discover_network_candidates`, `get_reviewed_evidence_case`. Offline, caller-supplied snapshots, F1–F3 historical, F4 synthetic; nothing is live and nothing invokes an RPC.
- Explicit `NE_MCP_MODE=hosted` and **exact** `NE_MCP_PUBLIC_ORIGIN=https://<assigned-host>` are required. The Host/Origin guard must not be widened or disabled.
- The root Dockerfile is for source-builds from the repository root, on **this isolated Cloud Run branch** only. Render uses a Node build and is unaffected. Publishing or promoting this branch is separate from publishing a functional remote MCP endpoint.

## 1. Costs and operator permission (HUMAN REQUIRED)

**Future deployments or exposure changes require explicit human authorization.** Verify a Google Cloud project that the owner controls, active Cloud Billing, and permission to enable Cloud Run, Cloud Build and Artifact Registry APIs. At preparation time no Google Cloud connector or authenticated `gcloud` was available on the VM. The operator subsequently authenticated `ne-gcloud` on 2026-10-08 and Cloud Billing reported `billingEnabled=true`; this does not establish any spend cap or guarantee a zero-euro bill. Do not ask for or handle passwords, billing numbers, API keys or service-account JSON.

Recommended limited trial: **request-based billing**, 1 vCPU, 512 MiB, min instances 0, max instances 1, concurrency 4, no databases or VPC connectors, region `europe-west1` (Belgium). The free monthly Cloud Run request-based tier includes 2 million requests, 180,000 vCPU-seconds and 360,000 GiB-seconds (account-wide, subject to price-zone rules); it is **not a promise of a 0-euro bill**. Potential charges include Cloud Run above free quotas, Cloud Build minutes, Artifact Registry image storage (including retained old images), Cloud Storage build/source staging, Cloud Logging ingestion beyond free allotments, and network egress. Confirm current prices and quotas for the selected region and every resource before deployment. Configure both a small account/project-wide budget with alerts and, if offered for this first-party account, a **Cloud Run-specific monthly Spend cap enforcement budget** (currently Google Cloud Billing preview). This enforcement applies to Cloud Run in the selected project, not Cloud Build, Artifact Registry, Cloud Storage, Cloud Logging, or other services. It can be delayed and overages are still billed, so it is NOT a guarantee of a hard total account cap. Alert-only budgets have no enforcement at all. Manually inspect billing after every test. Max instances=1 reduces but does not eliminate potential costs. Do not set min instances 1 without first estimating ongoing idle charges.

Official documentation (verify again at deploy time):
- https://cloud.google.com/run/pricing
- https://docs.cloud.google.com/run/docs/configuring/min-instances
- https://docs.cloud.google.com/run/docs/configuring/max-instances
- https://docs.cloud.google.com/run/docs/configuring/billing-settings
- https://docs.cloud.google.com/run/docs/deploying-source-code
- https://docs.cloud.google.com/billing/docs/how-to/budgets
- https://docs.cloud.google.com/billing/docs/how-to/budgets-spend-caps
- https://docs.cloud.google.com/run/docs/container-contract
- https://docs.cloud.google.com/run/docs/authenticating/public

## 2. Local gates (already demonstrated; rerun on the exact deploy commit)

```sh
git status --porcelain                    # must be empty
git rev-parse HEAD:packages/core          # b8ed923c9f43d17365f224e3f03f3df3135c5e87
npm ci && npm run -s typecheck && npm test
npm audit --audit-level=high
npm run -s mcp:smoke
docker build --pull=false -t ne-mcp-cloudrun-local:trial .
# Demonstrate the full MCP handshake against container via loopback Host simulation (see section 3).
# This VM is ARM64, so this local Docker artifact MUST NOT be pushed as a Cloud Run image.
# Cloud Run requires linux/amd64; source deployment rebuilds there via Cloud Build.
# Before an approved deployment, verify its amd64 build and boot; do not use --image with the local ARM64 artifact.
```

The local container must load the pinned `examples/ne-maps/data/collection.json` at startup. A checksum mismatch must stop startup. No remote fetch/RPC should occur at runtime.

## 3. Local rehearsal (NO provider access or deployment)

```sh
docker rm -f ne-mcp-cloudrun-local-trial >/dev/null 2>&1 || true
docker run --rm -d --name ne-mcp-cloudrun-local-trial \
  -e NE_MCP_MODE=hosted \
  -e NE_MCP_PUBLIC_ORIGIN=https://mcp.example.org \
  -e PORT=8080 \
  -p 127.0.0.1:18080:8080 ne-mcp-cloudrun-local:trial

curl -fsS http://127.0.0.1:18080/healthz -H 'Host: mcp.example.org'
# expected HTTP 200, hosted preview, tools [3]
curl -sS -o /dev/null -w '%{http_code}\n' \
  http://127.0.0.1:18080/healthz -H 'Host: evil.example'
# expected 403
docker rm -f ne-mcp-cloudrun-local-trial
```

Local Docker checks on 2026-10-08 passed **on ARM64 only**: 1 vCPU / 512 MiB constrained container cold boot to `/healthz` in 1,745 ms, approximately 117.7 MiB observed memory during the test, HTTP 200 for MCP initialize and real four-candidate Discovery, exact pinned Core digest (`sha256:d85c2fe5ff876acf3413a25986b6a78b2eaac7fc66cc998193e72deb14dee68b`), and foreign `Host` refused with HTTP 403. These are LOCAL observations, NOT a test of Google's required linux/amd64 image, Cloud Run CPU/memory billing, or edge cold-start timings. The linux/amd64 image built by Cloud Build must pass the same checks before public access. The current Dockerfile uses the moving `node:22-alpine` tag: capture the resolved multi-arch base-image digest as part of the approved deployment's audit record and consider pinning it separately before production.

Use `mcp.example.org` **only for local tests or the deliberately private bootstrap**. Do not make the service publicly invokable before replacing this placeholder with its actual assigned Cloud Run HTTPS origin.

## 4. Deployment sequence (executed for this authorized preview; retained for reproducing/rollback)

1. Confirm billing, project ID, region, Cloud Build + Artifact Registry + Cloud Run costs; establish `gcloud` authentication using the standard Google browser consent. Confirm that the exact code commit and the CLI project match the authorized values. Use `gcloud run deploy --source .` from the repo root with the branch's Dockerfile. This operation builds an image, stores it in Artifact Registry and **creates billable resources**, even if the service is private.
2. First create a **private service requiring IAM authentication** (not anonymously invokable; principals authorized with `roles/run.invoker` could still call it) with canonical placeholder origin, as the public `run.app` URL is not known yet. Keeping authentication required is important. Command template (substitute an actual project and recheck documented flags):
```sh
gcloud run deploy network-evidence-mcp-preview \
  --source . --project="<CONFIRMED_PROJECT_ID>" --region=europe-west1 \
  --cpu=1 --memory=512Mi --concurrency=4 \
  --min-instances=0 --max-instances=1 \
  --cpu-throttling --cpu-boost --no-allow-unauthenticated \
  --ingress=all --port=8080 \
  --set-env-vars=NE_MCP_MODE=hosted,NE_MCP_PUBLIC_ORIGIN=https://mcp.example.org
```
   If the bootstrap is not private or does not report a ready service, STOP. Never deploy with local mode or an open Host wildcard.
3. Read the actual assigned HTTPS URL, verify that it is an exact lowercase HTTPS origin with no slash/path; do not guess:
```sh
gcloud run services describe network-evidence-mcp-preview \
  --project="<CONFIRMED_PROJECT_ID>" --region=europe-west1 \
  --format='value(status.url)'
```
4. Still **private**, update exactly `NE_MCP_PUBLIC_ORIGIN` to that URL (creates a new revision). Confirm readiness and inspect logs. Do not remove other settings; use `--update-env-vars`:
```sh
ACTUAL_URL="$(gcloud run services describe network-evidence-mcp-preview \
  --project="<CONFIRMED_PROJECT_ID>" --region=europe-west1 \
  --format='value(status.url)')"
# Refuse empty, non-HTTPS, non-run.app and path-bearing values.
case "$ACTUAL_URL" in https://*.run.app) ;; *) echo 'Unexpected Cloud Run URL: STOP' >&2; exit 1 ;; esac
# Confirm the exact assigned host, lowercase canonical spelling and intended project.
gcloud run services update network-evidence-mcp-preview \
  --project="<CONFIRMED_PROJECT_ID>" --region=europe-west1 \
  --update-env-vars="NE_MCP_PUBLIC_ORIGIN=$ACTUAL_URL"
```
5. **STOP GATE before public exposure:** while the service still requires IAM authentication, compare its currently deployed `NE_MCP_PUBLIC_ORIGIN` against the exact `status.url` from step 3 using `gcloud run services describe --format=json`; verify the HTTPS host has no wildcard/placeholder or mismatch, no other env overrides, the live revision is READY, and the deployment image supports linux/amd64. A permitted operator can perform a private authenticated smoke using Google Cloud's documented authenticated invocation/proxy procedure; ordinary anonymous calls MUST fail at this stage. If any check fails, STOP. Only after a **separate explicit authorization to enable anonymous preview**, grant the invoker role to all users:
```sh
gcloud run services add-iam-policy-binding network-evidence-mcp-preview \
  --project="<CONFIRMED_PROJECT_ID>" --region=europe-west1 \
  --member=allUsers --role=roles/run.invoker
```
If the project disallows public `allUsers` IAM bindings, STOP and obtain a separate review before considering the alternative `--no-invoker-iam-check` documented by Google; do not silently switch mechanisms. Do not share or repoint the existing private ChatGPT plugin yet. An incorrect `Host` or supplied `Origin` must return HTTP 403 at the application layer.
6. Remote validation: GET `<ACTUAL_URL>/healthz` 200; MCP initialize (legacy and modern); exactly three tools; F1 historical `liveObservation:false`, F4 synthetic; Discovery demo digest `sha256:d85c2fe5ff876acf3413a25986b6a78b2eaac7fc66cc998193e72deb14dee68b`; negatives and guards. Run idle-then-cold-start timing (first-byte and total) at least twice; compare with the operator's 2026-10-08 measured Render Free response: 42.465 s on a wake-up and ~0.11 s warm. **Do not claim Cloud Run cold-start performance from the ARM64 local Docker startup (1.745 s under 1 vCPU/512 MiB).** Check Render and Cloud Run bills/usage independently.
7. If any mandatory check fails, revoke anonymous access **first**, without weakening the app guard, using:
```sh
gcloud run services remove-iam-policy-binding network-evidence-mcp-preview \
  --project="<CONFIRMED_PROJECT_ID>" --region=europe-west1 \
  --member=allUsers --role=roles/run.invoker
```
Verify the binding is absent and unauthenticated requests fail. If a different authorized mechanism was used, reverse that mechanism instead. Review/rollback the revision. Do not repoint the existing private ChatGPT plugin until the new endpoint passes all tests and the owner explicitly approves the change.

## 5. Verified current public state and next integration gates (2026-10-08)

- **Verified control plane:** Cloud Run europe-west1 revision 00003-v99 Ready=True and 100% traffic; ingress all; public allUsers roles/run.invoker binding verified. Authless GET /health 200; /healthz 404 at Google edge by reserved-path design. Runtime 1 vCPU, 512 MiB, concurrency 4, min instances 0, max instances 1, global MCP rate limit 60/min.
- **Verified external MCP:** authenticated private SDK and anonymously accessible public SDK calls in BOTH protocol eras 2025-11-25 / 2026-07-28 returned all three read-only tools and five fixed profiles. Real Core Discovery replay digest was byte-identical to reviewed fixture; F1 historical and F4 synthetic labels and liveObservation:false preserved. Rejections for invalid metadata/candidate inputs PASS. A foreign Origin received HTTP 403; an incorrect Host on the public HTTPS endpoint was rejected at Google edge with 404. The Cloud Run proxy rewrites Host, so it cannot independently attest the app Host guard (that guard passed locally).
- **Cause of prior apparent outage:** [official Cloud Run known issues](https://docs.cloud.google.com/run/docs/known-issues) states that some paths ending in z are reserved. /healthz was blocked BEFORE the application while /mcp worked. The additive hosted /health alias solves this without broadening the Host/Origin allowlist or changing Core.
- **Cost controls independently read from Cloud Billing:** Cloud Run monthly spend-cap budget of 2 EUR is CONFIGURED, scoped to this exact project and the Cloud Run billing service ID 152E-C115-5142, with 50/80/100% notifications. A separate billing-account-wide 5 EUR alerts-only budget exists at 50/90/100%. Caps can lag and do not cover Cloud Build, Artifact Registry, storage, logs or other services. Cloud Billing Budget API was enabled for read-only confirmation. No new budget was created.
- **Next bounded tasks, not admitted automatically:** verify idle cold-start latency against Render; point the existing private ChatGPT/Codex connector to Cloud Run only after connector-level smoke; then consider official MCP registry listing with provenance/docs. No production SLO, uptime guarantee, live network observation or fully uncapped spending is claimed. Keep Render as rollback.

## 6. Read-only Cloud Run control-plane and budget audit — 2026-10-09

This section records observations on the *already-public three-tool OFFLINE service*, not a review or deployment of the live Base/Solana PR #3 code. Cloud Run, IAM, and Billing were inspected with read-only CLI commands; no policy, service, billing setting, traffic split, deployment, image, plugin, or registry was modified.

### Observed in Google Cloud, not inferred from source

- Service `network-evidence-mcp`, region `europe-west1`, latest created/ready revision `network-evidence-mcp-00003-989`, Ready=True, **100% traffic** on that revision; `ingress=all`.
- Active revision annotation `autoscaling.knative.dev/maxScale=1` (**revision-level**, not independently established at service-level). 4 concurrent HTTP requests per instance; 1 vCPU, 512 MiB, request timeout **300 seconds**, one container on port 8080; image reference includes a SHA256 digest. Min-instances annotation was not present in the returned revision fields; do not claim a newly verified min=0 setting from this omission alone.
- Environment names/selected benign values: `NE_MCP_MODE=hosted`, `NE_MCP_RATE_LIMIT_PER_MINUTE=60`. **No `NE_MCP_MULTICHAIN_ENABLED=1` observed** in the deployed revision: the public service remains OFFLINE with the original 3 tools. The candidate's source-level 8/min, 2-in-flight live budget is **per Node process** and not remotely deployed.
- Cloud Run service IAM: `allUsers` has `roles/run.invoker`, confirming **anonymous public invocation**. Host/Origin guards and application body/error sanitization passed separate local tests; a Cloud Run IAM public grant does NOT mean every ingress safety gate has been externally penetration-tested.
- Cloud Billing project: `billingEnabled=true`; a **2 EUR monthly budget scoped to this project and Cloud Run billing service** has a spend-cap configuration, and a separate **5 EUR billing-account alert-only budget** exists. Current cap activation/lift state and current accrued charges were **NOT independently checked**; neither amount is an absolute account-wide ceiling. The spend-cap scope does not cover Cloud Build, Artifact Registry, Cloud Storage, general logs or other services.

### Provider, quota, privacy, and actual release blocker

- Application inbound budgets (60/min deployed offline; draft 8/min and 2 in-flight live) use **in-memory per-process counters**. Cloud Run's revision-level max=1 is not an atomic shared quota. Google documents temporary over-scaling and the simultaneous operation of old/new revision instances during deployments. A service-level max can reduce risk but is still not a hard distributed rate limit. No distributed cross-instance counter, external provider usage entitlement, or global hard provider spend ceiling was demonstrated.
- The authenticated/public entrypoint is anonymous; there is no per-client quota. The application logs only method/route/status/duration, **but Cloud Run automatically produces request logs**. Platform retention, access to request metadata, log exclusions and the actual public RPC provider's handling/retention of queried transaction IDs were **not verified**. Never advertise zero logging, confidential transaction queries or privacy guarantees.
- The Solana public mainnet/devnet RPC endpoints are shared/rate-limited and **not intended as production infrastructure** according to official Solana documentation. Specific provider burst, retention and historical availability SLOs are not guaranteed. Existing bounded reads + defensive `429` handling are necessary, not proof of provider readiness. A Solana SDK-only signatures-bearing `getBlock` result over the fixed 6,000-signature ceiling is SOURCE UNAVAILABLE, never proof that the requested signature is absent.
- Cloud Run's 2 EUR spend cap can respond **after** usage accrues and does not cover unrelated services; its enforcement can interrupt even the current offline endpoint. A 300-second platform request timeout is the current observed setting, not a suitable approved live-risk budget by itself.
- **Release gate decision (no automatic work):** maintain the public **3-tool OFFLINE** preview. For an owner-approved limited trial, explicitly review *service-level* max=1, one revision/100% traffic, low in-flight reads, shorter request timeout, bounded provider error paths, budget/alert monitoring, privacy/log retention and acceptable possible overages; recognize that this still lacks a guaranteed globally shared quota. If strict cross-instance/billing guarantees are a requirement, design and verify an atomic external quota mechanism as a **separate owner-approved architectural decision**, not an automatic NE v1 feature. Verify a dedicated provider plan before claiming reliable public-live uptime. Never silently expose the SDK-only Solana block-membership path.
- Next product acceptance gates remain real outside-client clean checkout, original per-action Core `EvidenceRequest`/policy/manifest/snapshot, explicit unavailable/ambiguous behavior, exact final release SHA security review and **owner authorization for live publication and spending**. No chain expansion, Core mutation, wallet/signing/transaction submission or settlement claims.

Official references: [Cloud Run maximum instances](https://docs.cloud.google.com/run/docs/configuring/max-instances) · [Cloud Run instance scaling caveats](https://docs.cloud.google.com/run/docs/about-instance-autoscaling) · [Cloud Billing spend-cap limitations](https://docs.cloud.google.com/billing/docs/how-to/budgets-spend-caps) · [Cloud Run logging](https://docs.cloud.google.com/run/docs/logging) · [Solana public RPC limits](https://solana.com/docs/references/clusters).

## 7. Owner-authorized PRIVATE Base/Solana live canary — 2026-10-09

**Owner consent:** explicit permission for a *limited live trial* following discussion of the RPC/provider quota and Cloud Run cost risks. We implemented only an **IAM-private canary**, not permissionless public publication. This is an operational observation, **not a release certification**. Source branch `work/ne-mcp-multichain-20261009` at verified commit `948e31cecfb9a18b5b78ffacdc34f4aa936420df`, source code/tests as in prior 89 files / 1,557 tests PASS; this deployment adds no repository code change. The previous public offline preview was NOT redeployed.

### Exactly what was deployed and verified

- Separate Cloud Run service `network-evidence-mcp-live-canary` in `europe-west1`, built from the canonical PR #3 candidate at SHA `948e31cecfb9a18b5b78ffacdc34f4aa936420df`; service never received an anonymous IAM grant. Two-step deployment: first build private with `NE_MCP_MULTICHAIN_ENABLED` absent and a placeholder origin, verify **private IAM and HTTP 403 anonymously**; *only then* update to the service's actual canonical Cloud Run HTTPS origin and opt in `NE_MCP_MULTICHAIN_ENABLED=1` on a second revision. Current private ready revision: `network-evidence-mcp-live-canary-00002-vqx`, 100% service traffic; **no public registry/plugin mapping changed**.
- **Actual Cloud control-plane gates checked:** `allUsers` and `allAuthenticatedUsers` absent from invoker IAM; service-level AND revision-level max instances **1**; `min-instances=0` explicitly configured (no minimum idle worker); 1 vCPU / 512 MiB, concurrency **1**, request timeout **45 seconds**. Separate newly created runtime service account with no additional project-level role grants and no keys. Hosted MCP ingress **8 requests/minute per process**, 1 HTTP request concurrent; native shared live acquisition budget **8/minute, 2 in-flight per process**. These are **not** globally atomic limits; overscaling, revision overlap and extra cloud charges remain theoretically possible.
- **Actual private IAM/client checks:** anonymous GET /health returned **403** before app; with a valid owner IAM identity, /health returned HTTP 200 and exactly **6 tools** (3 existing offline + `resolve_transaction_evidence`, `discover_live_network_evidence`, `preflight_live_network_evidence`), `liveObservation:true`, `networkIo:bounded_evm_solana_rpc`. Foreign Origin `https://attacker.example.net` was rejected 403 by the app guard. Both **2025-11-25 legacy** tools/list and **2026-07-28 modern** server/discover and tools/list passed against the authenticated remote canary. Modern calls require their specified `params._meta`; sending raw tools/list without that metadata legitimately fails 400 and is not a server defect.
- **Real source-backed tool calls from the private Cloud Run service, not the VM:** one known public Base mainnet transaction at `eip155:8453` and one reviewed public Solana mainnet signature at `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`. Both native `resolve_transaction_evidence` calls returned HTTP 200, exactly matching requested `subject`, source network and fragment subject, with **4 real RPC captures per network**, `execution:supported`, `dataBinding:supported`. Base generic finality was **not evaluated**. Solana `finality:supported` carries **source_observation only**, not cryptographic or independently verified economic finality. No wallet, signing, transaction submission, gas, funding or actual settlement was performed.
- **Public isolation rechecked afterward:** the existing official `network-evidence-mcp` service still returned GET /health HTTP 200 with **three offline tools**, `liveObservation:false` and `networkIo:none`; the public Cloud Run service/registry/Claude directory were not modified. The live canary is IAM-private and will **not** be added to public catalogs or pointed to by ChatGPT/Codex connectors without a separate explicitly approved release.

### What this proves, and what it does not

The actual hosted MCP can serve **both Base and Solana from live read-only RPCs** in an authorized, low-traffic environment. Solana is **NOT removed**. Solana's official public endpoints are shared and explicitly not for production workloads: they may change rate limits or issue 429/403 and do not provide a production SLA. A dedicated/private provider, adequate fallback or explicit low-traffic risk acceptance is an **infrastructure decision**, not a change to the Solana adapter or network support. An unavailable public RPC must be surfaced as unavailable/insufficient evidence, never evidence that Solana itself failed. Public source-observed `finalized` is not an independently executed consensus verifier.

**Risks still open:** Cloud Run and native rate caps remain per process; `max=1` and IAM privacy reduce exposure, not guarantee zero overscale. The shared **2 EUR Cloud Run spend-cap configuration** also applies to existing services and is neither instantaneous nor comprehensive; Cloud Build, Artifact Registry, storage, egress and logs may cost extra, and **actual accrued pilot cost was not queried**. Provider quotas and logging/retention policies have not been independently certified. The full per-action original Core `EvidenceRequest`/policy/manifest/snapshot, complete Core `NetworkEvidenceResult` → Hub/Lens and final exact SHA independent release review remain unfinished. **No public live rollout is implied by successful canary tests.**

**Stop rule:** keep private canary at min 0 (no permanent worker); no additional deployments or consumers in this lot. Future owner decision: private/dedicated Solana RPC or explicitly accepted best-effort public endpoint, cross-instance quota semantics and when/if to enable publicly accessible live tools. The original public three-tool offline MCP is the safe fallback.

## 8. Public Base + Solana beta — owner approved 2026-10-10

**New owner decision superseding the 2026-10-09 private-only stop rule FOR THIS ONE SEPARATE BETA SERVICE ONLY:** publish a limited, anonymous, read-only MCP beta for Base mainnet/Sepolia and Solana mainnet/devnet. Do NOT overwrite the historical official 3-tool offline preview, change the Registry listing or silently claim NE Suite v1 completeness.

**Public MCP beta endpoint:** `https://network-evidence-mcp-beta-jrkc26rjga-ew.a.run.app/mcp` (stateless MCP over Streamable HTTP; POST and current SDK negotiation, GET /mcp is not a browsing homepage). Optional health: `https://network-evidence-mcp-beta-jrkc26rjga-ew.a.run.app/health`.

### Release provenance and observed controls

- Source is **the exact publicly accessible GitHub PR #3 branch commit** `24f1c23d7a86c306e41bb5fd056d16181d0d2dc6` checked out freshly from origin, not the current `main` branch. Source was built into a pinned Cloud Run image digest; the later documentation commit does NOT represent new executable code in that image. PR #3 remains OPEN/DRAFT and **is not merged**. An official Registry `server.json` still points at the existing 3-tool OFFLINE endpoint, NOT this beta.
- Dedicated Google Cloud Run service `network-evidence-mcp-beta`, region `europe-west1`; observed ready live revision `network-evidence-mcp-beta-00002-d5z` at **100% traffic**. Anonymous `allUsers` **roles/run.invoker** was granted **only on this beta service** after the source/host/IAM/security/chain gates passed. It has a dedicated runtime service account with no project-level application roles, 1 vCPU / 512Mi memory, min 0, **max 1 configured both at service and revision level**, HTTP concurrency **1**, timeout **45 s**, exact allowed HTTPS origin, `NE_MCP_MULTICHAIN_ENABLED=1`.
- Application admission: **4 HTTP MCP requests/minute per Node process**, max **1 in-flight** per process; live source acquisition has its own budget (**8 acquisitions/minute and 2 concurrent per process**, additionally constrained by HTTP concurrency 1). A single client can exhaust the small shared public budget. Neither Cloud Run max=1 nor these in-memory counters guarantee globally atomic limits or zero overages. No per-client auth, account tracking, fee payment, signature, wallet, chain transaction submission or uptime SLA.
- The project has an observed **2 EUR Cloud Run configured spend cap** and a separate **5 EUR alerts-only** budget. They are not a hard all-services monetary ceiling; Cloud Build, Artifact Registry and other costs are not necessarily included. Do not promise a zero-cost public beta or provider SLA. Actual accrued cost was NOT measured in this release.
- Source provider endpoints are bounded and allowlisted. Public Solana RPC services are SHARED/best-effort and may return 429/403 or omit older data. Failed acquisition is `unavailable`/insufficient, **not** evidence that Solana is unsupported or failed. Privacy: Google Cloud logs request metadata; public RPC providers' logging, retention and SLA were not verified. Avoid sending sensitive/private subjects; this is a public beta.

### Verified acceptance gates, 2026-10-10

- Independent clean **fresh GitHub clone of the exact source SHA**: `npm ci` PASS; strict TypeScript PASS; **89 files / 1,557 tests PASS**; `demo:integrability -- --verify` PASS; original offline MCP SDK smoke PASS; npm audit 0 vulnerabilities. The original historical F1/F2/F3 source/proof authority was not rewritten.
- Independent read-only Claude Opus **RELEASE_BETA_GATE=PASS** for the inspected HTTP, limits, source boundary, MCP tool dispatch and Dockerfile **with explicit caveats**: no complete independent review of all live-before/preflight/claim/resolver modules, no global per-tool deadline linked to remote disconnect, unpinned base image and dependency runtime weight, anonymous shared-budget DoS, possible provider throttling and Cloud Run/IP logging. This is a bounded beta safety gate, **not full NE Suite v1 certification**.
- Before granting public IAM: authenticated private `/health` showed 6 read-only tools; real remote Base mainnet and Solana mainnet exact transaction/source identity calls yielded source-observed `execution:supported` and `dataBinding:supported`, 4 source captures each; official MCP client SDK modern `2026-07-28` and raw legacy `2025-11-25` both PASS.
- **After granting anonymous IAM:** GET `/health` HTTP 200 with 6 read-only tools and liveObservation true; anonymous `tools/list` plus **real Base + Solana read-only `resolve_transaction_evidence`** calls HTTP 200 with exact subject/source binding and explicitly `source_observation` basis; forged browser Origin HTTP 403. Independent post-script Cloud Run describe/IAM recheck PASS, service+revision max1 and budget settings intact. The existing official public `network-evidence-mcp` remains **3 tools OFFLINE**, and `network-evidence-mcp-live-canary` remains IAM-PRIVATE.
- All results are **network-source observations and deterministic derivations**. Base generic finality is not evaluated. Solana RPC `finalized` does NOT establish independent cryptographic finality, L1 settlement, economic irreversibility or merchant payment completion. The opt-in SDK-only Solana block-signature membership check does NOT silently upgrade the MCP's historical basic fragment. A full Core `NetworkEvidenceResult` → Hub/Lens/Maps is **NOT automatically produced** without the real actor's request/expected action, policy and complete per-action resolver snapshot/manifest.

### Exact rollback and release holds

To instantly remove anonymous access to this beta **only**:

```bash
G=/home/nils/.local/bin/ne-gcloud
P=$("$G" config get-value project)
"$G" run services remove-iam-policy-binding network-evidence-mcp-beta \
  --member=allUsers --role=roles/run.invoker \
  --project="$P" --region=europe-west1
```

A future public-beta update requires fresh exact-SHA tests, a final review, explicit scope and verified live rollout. No automatic transfer from this beta to `main`, official MCP Registry, Claude Directory, ChatGPT connector, or main public Cloud Run endpoint. For wider load: evaluate dedicated/private Solana RPC, true distributed quota and monitoring as explicitly funded/approved infrastructure decisions—not requirements to remove Solana or claim universal finality.

## 9. Post-launch anonymous client interoperability spot check — 2026-10-10

This is a **read-only operational verification of the existing public beta**, not a source security sign-off, new deployment, Registry promotion, or MCP-complete acceptance. The live beta executable remains the previously reviewed `24f1c23d7a86c306e41bb5fd056d16181d0d2dc6` and Cloud Run revision `network-evidence-mcp-beta-00002-d5z`.

- **Confirmed modern client success:** from Ubuntu Node `v22.23.2`, the separately instantiated official `@modelcontextprotocol/client@2.3.1` (Streamable HTTP transport, `versionNegotiation: { mode: "modern" }`) connected **anonymously to the public beta** and reported `era=modern`, `protocolVersion=2026-07-28`, and exactly six tools: `list_network_profiles`, `discover_network_candidates`, `get_reviewed_evidence_case`, `preflight_live_network_evidence`, `discover_live_network_evidence`, `resolve_transaction_evidence`. This check performed discovery/listing only; it did not call a live resolver, execute a transaction, test another internet host, or prove Hub/Lens completeness.
- **Discovery wire cross-check:** an instrumented official SDK probe observed `POST server/discover` returning **HTTP 200, application/json** from BOTH the live beta and the official offline service. Both exposed the expected modern discovery result keys including `supportedVersions`, `capabilities`, `resultType`, `ttlMs`, `cacheScope`, and `_meta`; both negotiated `2026-07-28`. The historical 3-tool offline service was not changed.
- **Independent Inspector control:** `@modelcontextprotocol/inspector@2.10.1 --cli --protocol-era modern --method tools/list` passed against the **official offline** endpoint (three tools). Against the **beta**, Inspector attempts in a busy rolling admission window got HTTP `429`; Cloud Run request logs include `POST 200`, `POST 202`, then `GET /mcp 429` and `POST /mcp 429` at 08:48:10Z. In a separate beta test after 70 seconds idle, Inspector got one `POST /mcp 200` at 08:51:07Z but then **timed out after 25 seconds**, with no second HTTP request in the inspected window. This residual Inspector failure is **unresolved** and cannot be attributed solely to quota or asserted to be a protocol-server defect. Prior attempts without an idle window also surfaced a misleading version-negotiation failure or 429. Do **not** claim Inspector compatibility with the beta until a complete `tools/list` succeeds.
- **Operational boundary:** live beta admissions are intentionally **4 HTTP /mcp requests per minute per Node process** with no per-client reservation; a multi-request inspection/handshake can deplete the shared allowance even without using a live RPC tool. Cloud Run max-one-instance and the configured 2 EUR Cloud Run spend cap plus 5 EUR alerts-only budget were independently rechecked; **actual accrued billing was not determined**. Provider-side Solana RPC 429/403 is a separate issue from this **application-side HTTP 429**.
- **Next bounded gate:** reproduce an Inspector/client end-to-end tools/list and one harmless offline tool call from a clean independent third-party runtime, then inspect the exact protocol/transport traces only if that remains relevant. Do not enlarge the anonymous quota, rewrite MCP/core, merge PR #3/#4, update `main`/Registry/directory, redeploy Cloud Run, or strengthen observed finality/settlement claims on this evidence alone. No transactions, signing, wallet access, provider purchase, or persistent worker were used in this spot check.
