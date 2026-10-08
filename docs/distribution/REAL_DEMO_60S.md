# Real 60-second demo (screen recording script)

This is a script for a **hands-on screen recording of real commands**. It shows
two things only: the offline Discovery demo and the local NE Maps atlas. Both
run on a laptop from a repository checkout. Neither is a hosted service.

> A promotional animation is **not** this demo. If any animated or edited promo
> material is produced, label it as illustration. It must not be presented as
> a live product, a hosted endpoint or live network monitoring.

## Before recording

```sh
git rev-parse HEAD          # show the exact commit on screen
node -v                     # >= 20.12 (recorded on v22.23.2)
npm ci
```

Keep the terminal full-screen with a readable font. Do not edit, speed up or
splice command output. If a take fails, re-record it.

## Pinned outputs (verified for this lot, 2026-10-08, Node v22.23.2)

| command | stdout SHA-256 | pin |
| --- | --- | --- |
| `npm run -s demo:discovery` | `de3da6d9b7b5ca5c0b328dbf6e8c72948739ae84c5fc6f406b762b0fd7d20260` | `examples/discovery/EXPECTED_STDOUT.sha256` |
| `npm run -s maps:collection` | `3710879095dc909e85fd4a98d1ee2e1a70f153a18e3fc33b463c6075bac1bf89` | prints `NE_MAPS_COLLECTION_PASS cases=4 e10250b3…fa49  collection.json` |

Anyone can reproduce the hash on screen:

```sh
npm run -s demo:discovery | sha256sum
# de3da6d9b7b5ca5c0b328dbf6e8c72948739ae84c5fc6f406b762b0fd7d20260  -
```

## Shot list (~60 s)

**0–5 s — Title card (static text, not animated claims).**
"Network Evidence — offline Discovery demo + NE Maps. Local. Synthetic and
archived inputs. Not live network data."

**5–30 s — `npm run -s demo:discovery`.** Run it live and scroll slowly. Point
at these exact lines of authentic output:

```text
Network Evidence - public Discovery demo (deterministic, offline)
...
  solana-devnet    solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1          testnet  archived-replay
                   offline replay of packages/resolver-solana/test/fixtures/solana-devnet-before-probe.json; current availability unknown
...
  synthetic demo probes are frozen at 2026-10-08T06:00:00.000Z; they are demo inputs, not live network availability
...
  result artifactDigest            sha256:d85c2fe5ff876acf3413a25986b6a78b2eaac7fc66cc998193e72deb14dee68b
  Core verifyDiscoverNetworksResult true
...
[5] External choice - CALLER POLICY (example code in caller-policy.ts; not a @nec/discovery feature)
...
    settlement       not_applicable  not claimed by the Solana BEFORE v0.1 manifest: an observed finalized commitment is never settlement or economic irreversibility
...
NE did not execute, sign, fund or submit anything.
```

Then run the hash line above to show the output is the pinned one.

Voice-over / captions, factual only:
- "Four explicit candidates. Three are synthetic demo probes and one is an
  archived replay. None is live."
- "Core classifies each one. Network Evidence does not choose. The caller's
  own policy picks, and that policy is example code."
- "Archived replay keeps current availability unknown. Finality is not settlement."

**30–55 s — NE Maps.**

```sh
npm run maps:serve          # NE Maps: http://127.0.0.1:4177/
```

Open `http://127.0.0.1:4177/` in a browser (the address bar must show
`127.0.0.1`). Show:
- case 1–3 (F1/F2/F3): the reviewed **historical** exports. Open one Lens view
  and point at an `insufficient` / `unavailable` row and the limitations;
- case 4: **"Synthetic / local fixture — not a network observation"**. Show
  that label on screen.

Caption: "Maps renders a frozen, checksum-pinned collection. No network
lookup. No global verdict, score or ranking."

**55–60 s — End card (static).**
"Local demo. Synthetic and archived inputs. No hosted service. No live
monitoring. Nothing was signed, funded or submitted."

## Must not appear in the recording or its description

- any URL other than `127.0.0.1` / `localhost`, and no "try it live" link;
- the words "live", "real-time", "monitoring", "guaranteed", "settled" or
  "final" applied to this demo's data;
- any claim that a network *is currently* available or usable;
- any zkSYS mainnet reference (zkSYS `eip155:57057` is Tanenbaum testnet /
  replay only, and it is not part of this demo);
- an MCP endpoint, registry listing or plugin. Those do not exist yet; see
  [MCP_LAUNCH_CHECKLIST.md](MCP_LAUNCH_CHECKLIST.md).
