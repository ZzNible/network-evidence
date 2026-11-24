# NE Maps — minimal v1 atlas

This directory is the bounded generic/multichain Maps surface. It renders any conforming `ne-maps-case-collection/v0.1` of `ne-maps-case/v0.1` envelopes, each wrapping one browser-safe `lens-case/v0.1` projection.

It is deliberately a presentation layer:

- any number of conforming cases (1–64), validated fail-closed by `collection.js` before rendering;
- no case-id, chain or case-count logic in `app.js`;
- no resolver, RPC acquisition, signing, submission, wallet or policy path;
- no graph engine;
- no global verdict, confidence or ranking;
- no chain-specific product logic;
- `TARGET_CORE_MUTATIONS = 0`.

## Cases in `data/collection.json`

1. Base mainnet x402 partial case — supported execution/data binding, insufficient OP Stack finality and x402 correlation, settlement unavailable.
2. Base Sepolia ERC-4337 v0.6 exact UserOperation — supported exact selection, with the already-reviewed selector outcomes for supported / insufficient / contradicted / ambiguous; finality and bundler provenance unavailable.
3. Solana mainnet x402-SVM partial case — supported execution/payment/source-observed RPC-finalized dimension, insufficient historical x402 correlation, settlement unavailable.
4. **Synthetic / local fixture — not a network observation.** The LOT 2 integrability proof (Core golden literals -> `@nec/hub` -> `@nec/lens` -> `lens-browser/v0.1`): execution supported, one observed ERC-20 effect, data binding not applicable, settlement and finality unknown. Its EVM-shaped identifiers are fixture literals.

5. zkSYS Genesis historical public testnet source trail: five network steps; the test verifier accepts a V8 MOCK TYPE 3 proof, NOT independently verified real ZK proof. Gateway event is a public index, and PoDA/ChainLock remain insufficient. No live RPC or wallet needed.

Cases 1–3 come from the frozen reviewed export pinned to:

- `ZzNible/agent-evidence-hub` `autonomy/authority-v1` at `586a81a39c8da4d3a0dc0e879b605aabfd3f8d1d`;
- public Suite repo `ZzNible/network-evidence` at `e536ca1c63465ebb2de46c855a01bac71e4dc768`.

`data/cases.json` is that frozen reviewed export (legacy `ne-maps/v0.1`, unchanged). Maps no longer loads it directly: `build-collection.ts` derives `data/collection.json` from it and from the LOT 2 fixture, carrying every nested Lens projection unchanged and moving only legacy presentation fields into the versioned envelope (`extensions.trailContextNote`, `extensions.reviewedSelectorOutcomes`, `extensions.provenance`). Display labels and Trail ordering are presentation metadata, not evidence.

F4 is frozen as data/f4-reviewed.json + data/F4_REVIEWED.sha256. Its five navigation steps are source-bound external Lens assessments (not Core settlement/finality verdicts); original source digest is in provenance. The generic Maps app.js remains unchanged, and MCP reads the same pinned collection.

## Adding a case

Append an `ne-maps-case/v0.1` envelope (`schemaVersion`, lowercase URL-safe `id`, `display { networkLabel, title, shape }`, `exactAction { networkId, id, ... }` with string values, `trailPropositionOrder` of existing proposition ids, browser-safe `lens`, optional `extensions`) to the collection. No `app.js` change is needed. Unknown extension keys are tolerated but not rendered; forbidden authority/ranking keys (`caseVerdict`, `confidence`, `trustScore`, `score`, `policyDecision`, `rank`, `ranking`) are rejected anywhere. Validate in Node with the public Lens validator:

~~~ts
import { validateLensBrowserSafeCaseV01 } from "@nec/lens";
import { validateNeMapsCollectionV01 } from "./collection.js";
validateNeMapsCollectionV01(collection, { validateLens: (lens) => validateLensBrowserSafeCaseV01(lens) });
~~~

The checked-in collection is reproduced and byte-checked by:

~~~sh
npm run maps:collection     # verify data/collection.json + data/COLLECTION.sha256
npx tsx examples/ne-maps/build-collection.ts --write   # deliberate regeneration; review changed bytes
~~~

## Case workspace vs reviewed examples (merged source-only)

The default browser landing page `#/` / `#/mine` is now **My cases**. It is intentionally empty until the integrating application supplies its own `data/my-collection.json` with the same strict `ne-maps-case-collection/v0.1` format. This second file is **optional** (absence means zero application cases); a present but malformed file yields an explicit validation failure, visibly marked as rejected. The generic collection contract still requires 1–64 cases, so an empty document is not treated as valid.

The five reviewed historical/synthetic cases remain unchanged under the separate **Examples** tab at `#/examples` in the public demo. Integrators may omit `data/collection.json` entirely; the app-owned collection still loads, and Examples shows an explicit empty state on HTTP 404. Malformed or otherwise inaccessible reviewed data fails closed. The old `#/case/{id}/{lens|trail|action}` deep links still target the examples; `#/mine/{id}/{view}` only resolves from the app-owned collection. Duplicate case IDs across the two sources are not silently merged. The demo does not provide persistence, upload, accounts or a live ingest API. The local input path `data/my-collection.json` is git-ignored by default; never force-add confidential projections to the public demo repository.

**Lens** displays declared relation endpoints, relation type, basis and limits in directional relationship cards alongside the complete set of propositions. **Trail** displays an ordered, numbered reading sequence of existing propositions, **including all exported per-proposition assessments, evidence bases and limitations**, not a verified chronological or causal chain; omitted Lens-only context is signposted. The Trail order comes from Maps presentation metadata, not Hub. For scope, architecture, test and release gates, see [the case/Lens/Trail specification](../../docs/NE_MAPS_CASES_LENS_TRAIL_V1_SPEC.md). This source-only UI was merged in [PR #13](https://github.com/ZzNible/network-evidence/pull/13); it does not add an NE Core assertion, signed release, live observation, or hosted deployment.

## Native macOS Safari: operator-gated QA

Chromium CDP CI covers 320/390/1440px layouts, real keyboard Tab/Enter transitions and full-page scrolling. This does **not** certify native Safari, Safari on iOS, VoiceOver or usability with an independent developer.

A native Safari WebDriver smoke is available at test/safari-native-qa.py. It uses Apple's **/usr/bin/safaridriver** (not Playwright WebKit or a substituted Chromium session), Python's standard library and a local-only NE Maps HTTP server. It tests six historical/empty views, source-labelled rendering, actual macOS Safari window width, horizontal overflow, ability to reach the footer, and writes PNG screenshots plus a SHA-bound report.

**Gate observed, 24 Nov 2026:** the public macOS-15 GitHub-hosted runner has Safari 27.2, but /usr/bin/safaridriver --enable requested an interactive macOS password and exited with code 1. No Safari session was created; the attempted CI is [here](https://github.com/ZzNible/network-evidence/actions/runs/45296818668). Running it with elevated privileges noninteractively was **not** authorized or attempted. The Safari job was removed from automatic CI so a permissions failure cannot mask product QA. The Python test is only syntax-checked automatically.

To qualify with **real Safari on an owner-approved Mac**, run the source merged in [PR #13](https://github.com/ZzNible/network-evidence/pull/13). The **tested code snapshot** is the squash-merge commit 2ce1bd46c8cab20c2c620613d49032702f2ccaaa; later documentation-only commits must not silently replace the source under test. This command is for **macOS Terminal, not Ubuntu**.

First open **Safari → Settings → Advanced** and enable the developer features if hidden. Then open **Safari → Settings → Developer** and enable **Allow remote automation** (Safari 27 may call it **Allow remote automation and external agents**). Apple also documents the one-time /usr/bin/safaridriver --enable alternative; it may request an interactive Mac administrator authorization. Enter any requested password only into your own Mac prompt, never in a message or CI secret. Do not disable SIP or the browser security model.

Then paste this single block into your Mac terminal:

~~~bash
bash <<'BASH'
set -euo pipefail
sha=2ce1bd46c8cab20c2c620613d49032702f2ccaaa
root="$(mktemp -d "${TMPDIR:-/tmp}/ne-maps-safari-XXXXXXXX")"
repo="$root/repo"
out="$HOME/ne-maps-safari-qa-${sha:0:8}"
echo "QA working folder: $root"
echo "QA output folder: $out"

test "$(uname -s)" = Darwin
test -x /usr/bin/safaridriver
/usr/bin/safaridriver --version
command -v node
node --version
test "$(node -p 'process.versions.node.split(".")[0]')" = 22
python3 --version

git clone --quiet https://github.com/ZzNible/network-evidence.git "$repo"
cd "$repo"
git checkout --quiet --detach "$sha"
test "$(git rev-parse HEAD)" = "$sha"
test -z "$(git status --porcelain --untracked-files=all)"
npm ci --no-audit --no-fund
npm run -s maps:collection

mkdir -p "$out"
npm run -s maps:serve > "$out/maps-server.log" 2>&1 &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true' EXIT
ready=0
for i in $(seq 1 40); do
  if curl -fsS --max-time 2 http://127.0.0.1:4177/ui-navigation.js 2>/dev/null |
     grep -Fq "parseCaseHash"; then
    ready=1
    break
  fi
  sleep 0.5
done
test "$ready" = 1

GITHUB_SHA="$sha" NE_SAFARI_QA_OUT="$out" \
  python3 -B examples/ne-maps/test/safari-native-qa.py 2>&1 |
  tee "$out/console.log"
(cd "$out" && shasum -a 256 -c SHA256SUMS.txt)
python3 - "$out/REPORT.json" "$sha" <<'PY'
import json, sys
with open(sys.argv[1]) as file:
    report = json.load(file)
assert report["commitSha"] == sys.argv[2], "SHA mismatch"
assert report["browserName"].lower() == "safari", "Not Safari"
assert len(report["scenarios"]) == 6, "Incomplete scenarios"
print("SAFARI_REPORT_SOURCE_BOUND_PASS", report["commitSha"])
PY
test -z "$(git status --porcelain --untracked-files=all)"
tar -czf "$HOME/Desktop/ne-maps-safari-qa-${sha:0:8}.tar.gz" -C "$out" .
echo "SAFARI_QA_ARTIFACT=$HOME/Desktop/ne-maps-safari-qa-${sha:0:8}.tar.gz"
BASH
~~~

**PASS evidence required:** a SAFARI_NATIVE_SESSION line with the true Safari version; six SAFARI_NATIVE_PASS lines and SAFARI_NATIVE_QA_PASS 6/6; SAFARI_REPORT_SOURCE_BOUND_PASS; screenshot checksums OK; REPORT.json, two native PNG screenshots and logs inside the ne-maps-safari-qa-2ce1bd46.tar.gz archive on Desktop. Send the archive or report back for assessment. The test uses Safari **on macOS**, not Safari on iOS or VoiceOver, and does not itself establish beginner usability.

**Failure:** if the Mac denies WebDriver automation, stop and report the exact error. If Node 22 is missing, install or select Node 22 using your existing version manager *before* re-running (for example nvm use 22 if installed). Do not replace the tested SHA, force browser permissions, expose the local port publicly or put personal keys in screenshots.

## Run

From the repository root:

~~~sh
npm run maps:serve
~~~

Open `http://127.0.0.1:4177/`.

Each case has three deterministic handoffs:

- **Lens** — propositions, assessments, basis and limitations;
- **Trail** — Maps-authored network-action ordering of existing case propositions, without inventing causal edges; Lens-only context omissions are explicit;
- **Exact action** — the source-backed transaction/UserOperation identity and exported case relations.

No external network lookup is performed by Maps.
