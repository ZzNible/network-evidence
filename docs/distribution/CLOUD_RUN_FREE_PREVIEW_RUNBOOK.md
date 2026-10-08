# Cloud Run FREE candidate — Network Evidence MCP v0 (PREPARED, NOT DEPLOYED)

**Current state:** local container-tested preparation ONLY. No Google project, service, billing account, registry image, DNS change or deployment was made by this lot. The existing Render Free preview and private ChatGPT plugin remain unchanged. This is a cost-aware, **anonymous read-only preview**, not a production-hosting approval or registry listing.

## 0. Fixed boundaries

- Base: `0652616ecd27cd8079d3de272e561a7ac4067581` (previous Render preview, independently reviewed), no changes to `packages/**`, `examples/**` or the tagged `v1.1.0` release.
- `packages/core` tree remains `b8ed923c9f43d17365f224e3f03f3df3135c5e87`.
- Exactly three MCP tools, unchanged: `list_network_profiles`, `discover_network_candidates`, `get_reviewed_evidence_case`. Offline, caller-supplied snapshots, F1–F3 historical, F4 synthetic; nothing is live and nothing invokes an RPC.
- Explicit `NE_MCP_MODE=hosted` and **exact** `NE_MCP_PUBLIC_ORIGIN=https://<assigned-host>` are required. The Host/Origin guard must not be widened or disabled.
- The root Dockerfile is for source-builds from the repository root, on **this isolated Cloud Run branch** only. Render uses a Node build and is unaffected; no remote branch is published here.

## 1. Costs and operator permission (HUMAN REQUIRED)

**Do NOT run any commands in §4 without explicit human authorization.** Verify a Google Cloud project that the owner controls, active Cloud Billing, and permission to enable Cloud Run, Cloud Build and Artifact Registry APIs. No Google Cloud connector or authenticated `gcloud` is currently available on the VM. The operator must complete Google login/OAuth himself; do not ask for or handle passwords, billing numbers, API keys or service-account JSON.

Recommended limited trial: **request-based billing**, 1 vCPU, 512 MiB, min instances 0, max instances 1, concurrency 4, no databases or VPC connectors, region `europe-west1` (Belgium). The free monthly Cloud Run request-based tier includes 2 million requests, 180,000 vCPU-seconds and 360,000 GiB-seconds (account-wide, subject to price-zone rules); it is **not a promise of a 0-euro bill**. API charges can include Cloud Build, Artifact Registry image storage, data egress, and usage beyond quotas. Confirm current prices for the selected region and all resources before deployment. Set a small billing budget with several alerts and manually review usage; **an alert-only budget is not a hard spending cap**. Max instances=1 reduces but does not eliminate the potential bill. Do not enable min instances 1 just to keep the MCP awake without measuring ongoing idle cost.

Official documentation (verify again at deploy time):
- https://cloud.google.com/run/pricing
- https://docs.cloud.google.com/run/docs/configuring/min-instances
- https://docs.cloud.google.com/run/docs/configuring/max-instances
- https://docs.cloud.google.com/run/docs/configuring/billing-settings
- https://docs.cloud.google.com/run/docs/deploying-source-code
- https://docs.cloud.google.com/billing/docs/how-to/budgets
- https://docs.cloud.google.com/run/docs/authenticating/public

## 2. Local gates (already demonstrated; rerun on the exact deploy commit)

```sh
git status --porcelain                    # must be empty
git rev-parse HEAD:packages/core          # b8ed923c9f43d17365f224e3f03f3df3135c5e87
npm ci && npm run -s typecheck && npm test
npm audit --audit-level=high
npm run -s mcp:smoke
docker build --pull=false -t ne-mcp-cloudrun-local:trial .
# Demonstrate the full MCP handshake against container via loopback Host simulation (see §3).
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

Local Docker checks on 2026-10-08 passed: 1 vCPU / 512 MiB constrained container cold boot to `/healthz` in 1,745 ms, approximately 117.7 MiB observed memory use during the test, HTTP 200 for MCP initialize and real four-candidate Discovery, exact pinned Core digest (`sha256:d85c2fe5ff876acf3413a25986b6a78b2eaac7fc66cc998193e72deb14dee68b`), and foreign `Host` refused with HTTP 403. These are LOCAL observations, NOT Google Cloud Run CPU, memory billing, or edge cold-start measurements.

Use `mcp.example.org` **only for local tests or the deliberately private bootstrap**. Do not make the service publicly invokable before replacing this placeholder with its actual assigned Cloud Run HTTPS origin.

## 4. Deploy procedure (NOT EXECUTED — requires separate human approval)

1. Confirm billing, project ID, region, Cloud Build + Artifact Registry + Cloud Run costs; establish `gcloud` authentication using the standard Google browser consent. Confirm that the exact code commit and the CLI project match the authorized values. Use `gcloud run deploy --source .` from the repo root with the branch's Dockerfile. This operation builds an image, stores it in Artifact Registry and **creates billable resources**, even if the service is private.
2. First create a **private, non-invokable** service with canonical placeholder origin, as the public `run.app` URL is not known yet. Keeping authentication required is important. Command template (substitute an actual project and recheck documented flags):
```sh
gcloud run deploy network-evidence-mcp-preview \
  --source . --project="<CONFIRMED_PROJECT_ID>" --region=europe-west1 \
  --cpu=1 --memory=512Mi --concurrency=4 \
  --min-instances=0 --max=1 --max-instances=1 \
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
gcloud run services update network-evidence-mcp-preview \
  --project="<CONFIRMED_PROJECT_ID>" --region=europe-west1 \
  --update-env-vars=NE_MCP_PUBLIC_ORIGIN=https://<ACTUAL_CLOUD_RUN_HOST>
```
5. Only after separate explicit approval to expose an anonymous public preview, allow unauthenticated requests (for example by disabling the Cloud Run Invoker IAM check per official docs), then run remote smoke. Do not share or reconfigure the ChatGPT plugin yet. On an unauthorized/incorrect Host or Origin, the application must return 403.
6. Remote validation: GET `<ACTUAL_URL>/healthz` 200; MCP initialize (legacy and modern); exactly three tools; F1 historical `liveObservation:false`, F4 synthetic; Discovery demo digest `sha256:d85c2fe5ff876acf3413a25986b6a78b2eaac7fc66cc998193e72deb14dee68b`; negatives and guards. Run idle-then-cold-start timing (first-byte and total) at least twice; compare with Render Free's observed 42.465 s cold vs ~0.11 s warm. **Do not claim Google cold-start performance from local Docker startup (~1.1 s)**. Check Render and Cloud Run bills/usage independently.
7. If any mandatory check fails, disable public IAM invocations first (without weakening the app guard); review/rollback the revision. Do not repoint the existing private ChatGPT plugin until the new endpoint has passed all tests, and only after human consent.

## 5. Why we are not deploying right now

No confirmed Google Cloud project/billing access is available to this session. This lot has **zero provider-side mutations**; a local working Docker image is the only new runtime artifact. It is legitimate for the owner to decide not to create a billing account; Render Free can remain a functional but cold-start-prone private preview. No public catalog/registry submission is authorized.
