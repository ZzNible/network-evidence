# Contributing to Network Evidence

Thank you for helping developers reproduce evidence about exact network actions. NE v1 is intentionally **finish-first**, not a new payment, wallet, policy or ranking system.

## Reproducible issue first

1. Read [Start here](docs/START_HERE.md), [case examples](docs/USE_CASES.md) and [security boundaries](SECURITY_BOUNDARIES.md).
2. State the exact source SHA, fixture/network identity, expected and observed behavior, with no private credentials.
3. Separate network observations, deterministic derivations, local verification, claims and unknowns.
4. Supply a minimal public reproduction before proposing a broad abstraction. Missing evidence is not necessarily an error.

## Run the baseline locally

~~~bash
npm ci
npm run -s typecheck
npm test -- --reporter=dot
npm run -s mcp:smoke
npm run -s maps:collection
~~~

Node.js 22 was the published qualification environment. No wallet, RPC key or live transaction is required by the offline examples.

Do **not** weaken evidence guards, invent confidence percentages, mutate Core to suit one adapter, infer settlement from block inclusion, or equate a confirmation count with universal finality. The maintainer may decline out-of-scope features.

Report potential vulnerabilities privately using [SECURITY.md](SECURITY.md), not public exploit issues.
