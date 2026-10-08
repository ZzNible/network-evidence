# Public Discovery demo

A small, deterministic, offline walk through the public `@nec/discovery` flow
over Base and Solana, mainnet and testnet, in one request.

Requirements: Node.js 20.12 or newer.

From the repository root:

```sh
npm ci
npm run -s demo:discovery
```

The stdout is stable. Its SHA-256 is pinned in
[`EXPECTED_STDOUT.sha256`](EXPECTED_STDOUT.sha256) and checked by
`npx vitest run examples/discovery`.

## Flow

1. **Requirements.** `execution` is required and `finality` is desired. The
   `requestId` and `generatedAt` values are explicit; no clock is read.
2. **Explicit candidate contexts** ([`inputs.ts`](inputs.ts)). Each context
   is built with a public resolver BEFORE export. Each candidate has an
   explicit `mainnet`/`testnet` presentation label.

   | candidate        | network                                   | label   | input                                                   |
   | ---------------- | ----------------------------------------- | ------- | ------------------------------------------------------- |
   | `base-mainnet`   | `eip155:8453`                             | mainnet | synthetic demo probe (EVM + OP Stack finality paths)    |
   | `base-sepolia`   | `eip155:84532`                            | testnet | synthetic demo probe, no finality observation           |
   | `solana-mainnet` | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | mainnet | synthetic demo probe (all post-action read paths)       |
   | `solana-devnet`  | `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` | testnet | offline replay of the checksum-pinned archived fixture |

3. **`discoverNetworks`** ([`run.ts`](run.ts)) applies the scope, validates
   every candidate through the Core binding gate, and returns a result that
   Core built and verified.
4. **Core classifications.** Candidates are ordered by presentation id. The
   order expresses no preference.

   | candidate        | classification | why (Core evaluation)                              |
   | ---------------- | -------------- | -------------------------------------------------- |
   | `base-mainnet`   | eligible       | execution and finality satisfied                   |
   | `base-sepolia`   | conditional    | desired finality `unknown`                         |
   | `solana-devnet`  | ineligible     | archived replay: required execution `unknown`      |
   | `solana-mainnet` | eligible       | execution and finality satisfied                   |

5. **External choice.** The caller chooses with its own policy, in
   [`caller-policy.ts`](caller-policy.ts). This is example caller code, not a
   `@nec/discovery` feature. The policy takes the first `eligible` candidate
   in the caller's preference list
   (`solana-devnet, base-sepolia, solana-mainnet, base-mainnet`). It skips
   `solana-devnet` (ineligible) and `base-sepolia` (conditional) and chooses
   `solana-mainnet`. `base-mainnet` stays listed as an eligible alternative.
6. **Evidence preflight.** The chosen candidate goes through its
   resolver-specific public preflight function,
   `deriveSolanaBeforePreflightResult`. It uses the same frozen foundation
   that was given to discovery. The status is `ready`, settlement is
   `not_applicable`, and Core `verifyPreflightResult` passes.
7. **Out of scope.** Executing the action happens later and outside Network
   Evidence. Post-action Resolution is a separate step and is not part of
   this demo. The final stdout line says that NE did not execute, sign, fund
   or submit anything.

## Boundaries

- Network Evidence does not choose or rank networks. Candidate order is
  presentation-id order only.
- Synthetic probe inputs are demo inputs, not live network availability.
  There is no hosted monitoring and no live probing. The demo does no network
  I/O; the CLI replaces `fetch` with a throwing guard.
- Archived replay keeps current availability `unknown`.
- `environment` (`mainnet`/`testnet`) is presentation/scope metadata. It may
  narrow the candidate scope (`scope.environments`), but it never changes a
  Core classification or evidence truth. Relabelling without changing scope
  leaves the Core result bytes identical; the tests check this.
- Finality is not settlement. A Solana `finalized` observation does not
  establish economic irreversibility. OP Stack L2 finality does not establish
  withdrawal, output-root or dispute-game settlement.
- zkSYS is not in this demo. Its current scope is Tanenbaum testnet/replay
  semantics only, and there is no zkSYS mainnet profile.
- There are no transactions, signing, funding, wallets or secrets.
