# Core -> Hub -> Lens public demo

This example is the bounded Network Evidence Suite integration gate for one reviewed public ERC-4337 case.

Requirements: Node.js 20.12 or newer.

From the repository root:

```sh
npm ci
npm run demo:core-hub-lens
```

The command:

1. loads the checksum-pinned Base Sepolia v0.6 ERC-4337 fixture;
2. replays it through the public generic EVM resolver;
3. evaluates the exact UserOperation through the public ERC-4337 adapter;
4. binds that runtime result to the reviewed F2 Hub reference;
5. emits the browser-safe Lens case.

Expected high-level result:

```text
Core replay         consistent
UserOperation       supported
bundle execution    supported
finality            not established
Hub binding         passed
Lens proposition    supported
TARGET_CORE_MUTATIONS = 0
```

The output is deterministic JSON and includes the public fixture path and SHA-256, exact transaction/UserOperation identifiers, evidence basis, Hub authority SHA, unresolved Lens questions and the browser-safe Lens case.

This is an exact-fixture demonstration, not generic Hub ingestion, wallet, signing, submission, bundler attribution, settlement, finality or policy authority.

The embedded Lens case intentionally retains the reviewed imported F2 evaluator provenance. The CLI also emits hub.runtimeBinding.localRecomputation = performed with the public fixture path/digest and runtime result, so an external reader can distinguish the reviewed source provenance from the fresh local replay. The private development SHA is provenance text only and is not required to run the demo.
