# Cloud Run FREE candidate — Network Evidence MCP v0 (PRIVATE; HEALTH FIX READY)

**Current state (2026-10-08):** A billing-enabled private Cloud Run service exists in europe-west1 at revision network-evidence-mcp-preview-00002-mpd. A genuine authenticated MCP initialize to POST /mcp returned HTTP 200 through the official gcloud proxy. GET /healthz returned Google 404 because Cloud Run reserves some paths ending in z, not because all routes are broken. The additive hosted-only GET/HEAD /health alias is now validated locally, pending redeployment. **Do not grant anonymous access before the new image is tested privately.** Render Free and the NE v1.1.0 release are unchanged.

## 0. Fixed boundaries

- Base: `0652616ecd27cd8079d3de272e561a7ac4067581` (previous Render preview, independently reviewed), no changes to `packages/**`, `examples/**` or the tagged `v1.1.0` release.
- `packages/core` tree remains `b8ed923c9f43d17365f224e3f03f3df3135c5e87`.
- Exactly three MCP tools, unchanged: `list_network_profiles`, `discover_network_candidates`, `get_reviewed_evidence_case`. Offline, caller-supplied snapshots, F1–F3 historical, F4 synthetic; nothing is live and nothing invokes an RPC.
- Explicit `NE_MCP_MODE=hosted` and **exact** `NE_MCP_PUBLIC_ORIGIN=https://<assigned-host>` are required. The Host/Origin guard must not be widened or disabled.
- The root Dockerfile is for source-builds from the repository root, on **this isolated Cloud Run branch** only. Render uses a Node build and is unaffected. Publishing or promoting this branch is separate from publishing a functional remote MCP endpoint.

## 1. Costs and operator permission (HUMAN REQUIRED)

**Do NOT run any commands in §4 without explicit human authorization.** Verify a Google Cloud project that the owner controls, active Cloud Billing, and permission to enable Cloud Run, Cloud Build and Artifact Registry APIs. At preparation time no Google Cloud connector or authenticated `gcloud` was available on the VM. The operator subsequently authenticated `ne-gcloud` on 2026-10-08 and Cloud Billing reported `billingEnabled=true`; this does not establish any spend cap or guarantee a zero-euro bill. Do not ask for or handle passwords, billing numbers, API keys or service-account JSON.

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

## 4. Deploy/publication procedure (private bootstrap performed; public gate NOT passed)

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

## 5. Current Google state and mandatory STOP gate (2026-10-08)

- **Observed control plane:** project billing enabled; Cloud Run service `network-evidence-mcp-preview` in `europe-west1`, revision `00002-mpd` Ready=True, traffic 100%; ingress `all`; Cloud Run v2 `defaultUriDisabled` not set; IAM policy contains **no `allUsers` invoker binding**. Runtime: 1 vCPU / 512 MiB / concurrency 4 / max instances 1, request-based CPU allocation. Image digest recorded by the Cloud Run service; verify source provenance again before publication.
- **Observed routing:** Google Cloud Run returns its frontend HTTP 404 for /healthz, while /mcp and /health anonymously return HTTP 403 as expected for a private service. Through the official gcloud run services proxy, genuine MCP initialize POST /mcp returned HTTP 200 in 0.106 s and answered protocol 2025-11-25. The hosted-only /health alias passes local tests and awaits deployment. Do not interpret /healthz 404 as MCP route failure.
- **Root cause confirmed by documentation and path contrast:** [Google Cloud Run known issues](https://docs.cloud.google.com/run/docs/known-issues) reserves some paths ending in z. Use /health for Cloud Run; retain /healthz for local and Render compatibility. Previous speculation about global Google frontend registration faults was unsupported for this service.
- **Cost controls independently read from Cloud Billing:** Cloud Run monthly spend-cap budget of 2 EUR is CONFIGURED, scoped to this exact project and the Cloud Run billing service ID 152E-C115-5142, with 50/80/100% notifications. A separate billing-account-wide 5 EUR alerts-only budget exists at 50/90/100%. Caps can lag and do not cover Cloud Build, Artifact Registry, storage, logs or other services. Cloud Billing Budget API was enabled for read-only confirmation. No new budget was created.
- **Next publication gate:** deploy this reviewed candidate to the SAME private service, confirm new ready revision and authenticated GET /health 200, both MCP protocol eras, exactly 3 tools, true Discovery digest, Host/Origin rejection and provenance, then cautiously expose the authorized public read-only preview. Keep min instances 0, max instances 1 and avoid paid add-ons; observe cold-start and costs. Do not repoint the private ChatGPT plugin or submit to public MCP registries before full remote validation.
