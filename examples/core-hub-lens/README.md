# Core -> Hub -> Lens public demo

This example is the bounded Network Evidence Suite integration gate for one reviewed public ERC-4337 case.

Requirements: Node.js 20.12 or newer.

From the repository root:

```sh
npm ci
npm run -s demo:core-hub-lens
```

The command:

1. loads the checksum-pinned Base Sepolia v0.6 ERC-4337 fixture;
2. replays it through the public generic EVM resolver;
3. evaluates the exact UserOperation through the public ERC-4337 adapter;
4. equality-checks that fresh runtime result against the reviewed exact-fixture F2 Hub projection;
5. only if those checks pass, emits the existing browser-safe Lens case.

Expected high-level result:

```text
Core replay         consistent
UserOperation       supported
bundle execution    supported
finality            not established
Hub equality gate   passed
Lens proposition    supported
TARGET_CORE_MUTATIONS = 0
```

The output is deterministic JSON and includes the public fixture path and SHA-256, exact transaction/UserOperation identifiers, evidence basis, Hub authority SHA, unresolved Lens questions and the browser-safe Lens case.

This is an exact-fixture demonstration, not generic Hub ingestion, wallet, signing, submission, bundler attribution, settlement, finality or policy authority.

The embedded Lens case intentionally retains the reviewed imported F2 evaluator provenance. The CLI separately emits `hub.runtimeReplay.localRecomputation = performed` with the public fixture path/digest and fresh runtime result. The reviewed Lens case is not recomputed from Core output; it is emitted only after explicit equality checks verify that the fresh replay matches the exact reviewed F2 semantics. The private development SHA is provenance text only and is not required to run the demo.
