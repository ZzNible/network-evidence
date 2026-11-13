# Network Evidence

**What does the blockchain itself actually support about this exact action?**

Network Evidence (NE) gives AI agents and developers **read-only, reproducible network evidence** instead of treating an application claim or one RPC response as proof of settlement or finality. Works with exact Base and Solana cases, and clearly labels what is supported, contradicted, insufficient or ambiguous. It never signs, funds or submits a transaction.

**[Start here: first evidence in five minutes](docs/START_HERE.md)** · [Latest signed source release](https://github.com/ZzNible/network-evidence/releases/latest) · [Local MCP setup](packages/mcp/README.md) · [NE Maps cases](examples/ne-maps/)

### Try a real evidence pipeline locally

```bash
git clone https://github.com/ZzNible/network-evidence.git
cd network-evidence
npm ci
npm run -s demo:core-hub-lens
```

This first run **replays a reviewed public Base Sepolia ERC-4337 case**; it does not require a wallet, API key, or an online blockchain query. To let an agent read a reviewed case, run `npm run -s mcp:serve` and connect a **same-machine** MCP client to `http://127.0.0.1:4178/mcp`. The default local server exposes **three offline tools**, not the three extra live-source tools from the separately opt-in hosted implementation. See the [step-by-step agent guide](docs/START_HERE.md).

**Release boundary:** v1.2.0 is a verified **source-only** release, not an operating public MCP endpoint. Its transitive Hono dependency had a disclosed moderate security advisory; do not deploy it on the public Internet. A security-patched source revision requires separate qualification and publication.

NE handles two related questions: **Discovery** (what an exact network may support and what is presently observable) and **Resolution** (what the network independently supports about an exact action). A listed capability does not prove that it currently works. Execution, observed effects, settlement and finality must be assessed separately. Every claim retains its evidence basis; absent evidence is a result.

## Historical Base + Solana MCP beta (October 2026)

**Previously observed six-tool Base + Solana read-only beta:** see its
[dated client and verification guide](docs/distribution/MCP_BASE_SOLANA_PUBLIC_BETA_QUICKSTART.md).
**Availability check 2026-11-11 (Europe/Brussels; 2026-11-10 UTC):** anonymous GET and HEAD requests to
the three historical public `/health` endpoints returned **HTTP 503
(`Google Frontend`)** from the owner Ubuntu host. This is a dated
observation, **not** a diagnosis of IAM, revision, billing, or root cause.
No current hosted beta availability or deployment of NE Suite v1 is
attested here. **Do not connect an agent based on health status alone:**
wait for an updated operator-published requalification and privacy notice.

**Historical endpoint, not currently verified as operational:**

- **MCP endpoint:** https://network-evidence-mcp-beta-jrkc26rjga-ew.a.run.app/mcp
- **Last recorded live profile declarations:** Base mainnet / Base Sepolia, Solana mainnet / Solana devnet. Profile listing is not proof of current RPC availability.
- **Read-only RPC observations:** exact public transaction/signature, native Core fragment, provenance and explicit non-claims; source-reported block-finality signals are **not** cryptographic settlement proof.
- **Beta configuration last recorded 2026-10-11, not reverified here:** shared
24 HTTP `/mcp` admissions per 60 seconds/process (not per user), eight
live-RPC acquisitions/minute/process, and one maximum Cloud Run instance and
concurrent request. These historical limits do not establish today's settings.
No SLA, wallet, signing or submission.
- **Different product identities:** source Suite release v1.1.0 is a source release; official MCP Registry v0.0.2 **last documented the older offline three-tool endpoint** (not rechecked today). All three public endpoint health responses **reported** runtime `0.0.1` on 2026-10-21; use the exact URL and tool surface to identify the server. See the [endpoint/version table and client-test boundaries](docs/distribution/MCP_BASE_SOLANA_PUBLIC_BETA_QUICKSTART.md#identify-the-endpoint-and-version-2026-10-21). The beta is neither MCP COMPLETE v1 nor a public ChatGPT/Claude directory listing.

[Historical Base/Solana agent setup (operator requalification required)](docs/distribution/MCP_BASE_SOLANA_PUBLIC_BETA_QUICKSTART.md) · [Privacy and RPC provider disclosure](docs/distribution/MCP_PRIVACY_POLICY.md) · [GitHub Issues](https://github.com/ZzNible/network-evidence/issues).

This source capsule contains `@nec/core`, `@nec/resolver-evm`,
`@nec/adapter-x402`, `@nec/resolver-opstack`, `@nec/adapter-erc4337`,
`@nec/resolver-solana`, `@nec/adapter-x402-svm`, `@nec/resolver-zksys`,
`@nec/hub`, `@nec/lens`, `@nec/discovery`, and `@nec/mcp`.
The Solana resolver is generic post-fact Solana network evidence; the x402 SVM
adapter is x402 v2 exact-SVM interpretation above that generic Solana evidence.
The ERC-4337 package is a narrow evidence-correlation adapter above generic EVM
evidence.

The zkSYS resolver is a thin zkSYS Tanenbaum BEFORE profile for pure historical
replay v0.1. Support does not imply current availability; archived replay gives
current availability `unknown`. It adds only a narrow provider-reported block
height-to-batch/range capability. It does not establish block-hash-to-batch
membership, Gateway settlement, data or PoDA availability, proof verification,
Syscoin inclusion, or finality. It is not wallet, signing, funding, paymaster,
or submission infrastructure. Package manifests retain `private: true` to
prevent accidental npm publication.

Base BEFORE parity uses the generic EVM BEFORE foundation plus a minimal OP
Stack overlay in `@nec/resolver-opstack`. There are two explicit profiles:
Base mainnet `eip155:8453` (labelled mainnet) and Base Sepolia `eip155:84532`
(labelled testnet). The labels are presentation only and are never evidence.
The overlay adds one capability, OP Stack L2 block `finality`, whose
availability comes only from probe observations. It never claims settlement
and never infers withdrawal or output-root finalization. Replaying the pinned
archived fixtures gives current availability `unknown`. See
[`packages/resolver-opstack/README.md`](packages/resolver-opstack/README.md#before-overlay-base-mainnet--base-sepolia).

Solana BEFORE support lives in `@nec/resolver-solana`. There are two explicit
genesis-bound profiles: Solana mainnet `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`
(labelled mainnet) and Solana devnet `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`
(labelled testnet). Each pins the full `getGenesisHash` result, and the labels
are presentation only. The manifest claims `execution`, `observedEffects`,
`dataBinding` and `finality`, never `settlement`. Availability comes only from
probe observations of the post-action read path. A Solana `finalized`
commitment is a source observation. It never establishes settlement or
economic irreversibility. Replaying the pinned archived mainnet and devnet
fixtures gives current availability `unknown`. See
[`packages/resolver-solana/README.md`](packages/resolver-solana/README.md#before-foundation-solana-mainnet--devnet).

`@nec/discovery` is a thin public Discovery orchestrator above Core. A caller
supplies requirements and explicit candidates (presentation id, explicit
`mainnet`/`testnet` label, and an already-derived network, manifest and
snapshot). It can filter by exact candidate id and by environment. Core
`composeDiscoveryMatch` classifies each candidate, and Core builds and verifies
the deterministic `DiscoverNetworksResult`. Environment selects scope only and
never changes a classification. There is no network I/O, ranking, scoring or
network choice. See [`packages/discovery/README.md`](packages/discovery/README.md).
A deterministic, offline integration demo runs with
`npm run -s demo:discovery`. It covers Base and Solana, mainnet and testnet,
an external caller choice, and an evidence preflight for the chosen
candidate. See [`examples/discovery/README.md`](examples/discovery/README.md).

This repository intentionally has fresh history. Its selected package content
comes from frozen source snapshots, but private Git history is not imported.
It is licensed under [Apache-2.0](LICENSE).

## Reproducible Core -> Hub -> Lens demo

A zero-secret public integration path is included for the reviewed Base Sepolia
ERC-4337 v0.6 case.

Requires Node.js 20.12 or newer.

~~~sh
git clone https://github.com/ZzNible/network-evidence.git
cd network-evidence
npm ci
npm run -s demo:core-hub-lens
~~~

The command replays a checksum-pinned public fixture through
@nec/resolver-evm, evaluates the exact UserOperation through
@nec/adapter-erc4337, equality-checks that fresh runtime result against the
reviewed exact-fixture F2 Hub projection, then emits the existing browser-safe
Lens case.

The demo is exact-fixture and deterministic. It does not add wallet/signing/
submission, bundler attribution, settlement, finality, confidence scoring or
policy authority. See examples/core-hub-lens/README.md and
examples/core-hub-lens/PROVENANCE.md.

## Minimal NE Maps atlas

`examples/ne-maps/` presents a versioned `ne-maps-case-collection/v0.1` — the three stable Suite v1 cases plus the clearly labelled synthetic/local integrability case — as a small generic/multichain evidence atlas. It validates the collection fail-closed and consumes pinned browser-safe Lens projections; it does not resolve network evidence or add a graph engine, policy layer or stronger claim. Each case exposes Lens, Trail and exact-action handoffs while preserving `supported`, `contradicted`, `insufficient`, `ambiguous` and `unavailable` states when present.

~~~sh
npm run maps:serve
~~~

Then open `http://127.0.0.1:4177/`. `TARGET_CORE_MUTATIONS = 0`.

## Release and reproducibility

**Release checkpoint (13 November 2026):** [Network Evidence Suite v1.2.0](https://github.com/ZzNible/network-evidence/releases/tag/v1.2.0), tagged on 13 November 2026. Check [latest releases](https://github.com/ZzNible/network-evidence/releases/latest) for subsequent versions. It includes the source tree, an owner-signed provenance statement, a detached signature and an exact source archive. No npm package or hosted service was published. The prior v1.1.0 release (8 October 2026) is preserved.

- [First evidence / agent quickstart](docs/START_HERE.md) — offline evidence, local MCP and browser-based NE Maps.
- [RELEASE.md](RELEASE.md) — historical release context and source inventory; dated checkpoints inside are not a current service-status claim.
- [docs/release/REPRODUCTION.md](docs/release/REPRODUCTION.md) — independent, exact-source verification.
- [docs/INTEGRABILITY_V1_1.md](docs/INTEGRABILITY_V1_1.md) — Hub/Lens/Maps contracts and BEFORE/Discovery.
- [docs/release/DEPENDENCY_ADVISORIES.md](docs/release/DEPENDENCY_ADVISORIES.md) — dated, commit-bound `npm audit` observations and locked dependency versions; no `npm audit` result is claimed for the current tree.
- [SECURITY_BOUNDARIES.md](SECURITY_BOUNDARIES.md) — trust and privacy boundaries.
