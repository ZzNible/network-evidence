# Network Evidence Suite v1 — source-only closeout (24 November 2026)

**Status: source-complete on `main`. This document is not a signed release
statement, tag, registry listing or hosted-service attestation.** No package,
fixture, resolver, Core, Hub, Lens or MCP behavior changes are made by this
closeout. The project owner elected not to block source completion on external
beta reports; none have been received or represented as successful tests.

## Exactly what was integrated

The public source integrates `@nec/core`, Hub, Lens, local-first MCP and a
**generic, multichain NE Maps** case atlas (not the separate Syscoin-specific
zkSYS Maps application). The atlas shows distinct claim-level conclusions,
relationships and guided reading steps. Its five examples include public
Base/Solana evidence, a labelled synthetic/local integrability example, and a
historical **zkSYS Genesis testnet** replay. A historical MOCK V8 proof is
not a verified ZK proof; missing Gateway, PoDA, ChainLock and independent
finality evidence remain `insufficient`, not silently upgraded.

- Product merge: [PR #13](https://github.com/ZzNible/network-evidence/pull/13)
  → `2ce1bd46c8cab20c2c620613d49032702f2ccaaa`, Git tree
  `a24654dc592ea20b45142e2a649aacfa33abd995`.
- Tested candidate: `62c4ac2408bbaec535ae4a0d2f89a958d655e927`,
  **exactly the same Git tree** as the product merge.
- Follow-up [PR #14](https://github.com/ZzNible/network-evidence/pull/14)
  → `bdfa5f14fbc1431d4d68c182dbb5cc3ed6f3ec8d`;
  documentation-only, not another product implementation.

## Reproducible qualification, with scope

- [Exact candidate CI 45298674684](https://github.com/ZzNible/network-evidence/actions/runs/45298674684):
  clean Node 22 install, typecheck, 127 test files (**1,859 PASS and one
  separately expected failure**), **51/51 NE Maps tests**, historical F4,
  demos, local MCP SDK and HTTP loopback checks, Maps collection byte identity,
  **10/10 real Chromium viewport/keyboard checks**.
- **Native macOS Safari 27.0.1**, operator-executed against the exact product
  merge SHA: **six of six** WebDriver scenarios passed (empty collection,
  examples, zkSYS Genesis Lens/Trail, F2 Lens/Trail). The driver checked
  rendered content, 1100 CSS-pixel viewport width, horizontal overflow,
  scrolling to the footer, and expected relations/steps. The owner supplied a
  report and two PNG screenshots; a separate review checked their bytes and
  SHA256 values. This is operator-generated evidence with local content
  verification, **not an independently attested Mac execution**.
  - Submitted archive SHA256:
    `85edf4a4d425fe1de0c71db161d850e74b57b22589b863634a48fde1631bafc9`
  - Genesis Lens PNG:
    `0e6aef02c8fe7cb31489d2b3eb5e0011fef1f9dea978c24fd8087629762b8ab9`
  - Genesis Trail PNG:
    `596bd73e0b822ee7c2b17babef11b3c3739f6f34b73cca4061dc72ad705d347e`

The original Safari session HTTP 500 and a local port-4177 conflict were
resolved before the successful full run. Those transient failures are not
evidence of a Maps render bug. The screenshots are viewport captures:
full-scroll reachability was checked by WebDriver, not visually documented
for every scrolled pixel.

## Deliberately unverified

**Zero external tester reports** were received for [issue #12](https://github.com/ZzNible/network-evidence/issues/12).
The owner's source-only closeout waives waiting for them; it does not establish
independent novice usability or a real external agent-client invocation.
Safari on iOS, exhaustive VoiceOver/WCAG, independent ZK verification,
economic settlement, ChainLock BLS attestation on the zkSYS case,
PoDA raw-data availability and public MCP service availability are **not
certified** by this closeout. A source-observation is not network finality.

## Distribution boundary and next authority

**The latest separately owner-signed source release remains
[v1.2.1](https://github.com/ZzNible/network-evidence/releases/tag/v1.2.1),
commit `7d8a9730a26ebd89a1ba2c4e2222a78bc76f5d9a`.**
It predates the merged NE Maps UI. This source-closeout change does **not**
produce a new signed release, release attachment, tag, npm package,
OCI image, registry entry or public hosted endpoint. OCI is outside the
NE v1 definition of finished.

A subsequent source release must independently verify its **final exact
commit, Git tree, source archive SHA256 and lockfile SHA256**, then bind
all four in a statement signed by the owner's already authenticated release
identity. A GitHub co-located manifest alone does not authenticate its
publisher. The owner must explicitly authorize that exact publication; no
private signing material belongs in Git or a ChatGPT session. See
[release reproduction](REPRODUCTION.md), [release history](../../RELEASE.md),
[quickstart](../START_HERE.md) and [case examples](../USE_CASES.md).

**Stop condition:** NE Suite v1 source is complete. Handle future reproduced
defects as bounded fixes, not as an indefinitely running beta or feature lane.
