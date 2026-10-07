# F1 real public partial x402 #1062

`F1-x402-1062-partial` is a byte-manifested, offline fixture pack for the real
public x402-foundation/x402 issue #1062 late-settlement case on Base mainnet.
Its class is `real_public_partial`: it exists to prove that an incomplete public
correlation stays insufficient.

The issue timeout is retained only as an `ISSUE_REPORTED_FACT` source claim. It
is a Hub documentary transcription of `PUBLIC_ISSUE` constants from the exact
frozen `case.ts`; it is not a direct, independently captured GitHub issue
response and is not a Network Evidence assessment. The exact reviewed Hub frozen
Network Evidence projection is copied without changes under `source/`; it is the
only F1 artifact used for Network Evidence verdict vocabulary. Its observed
transfer parties are not attested x402 authorization terms.

Full exact x402 same-action correlation is intentionally insufficient. The public
issue does not independently provide `payTo`, `payer`, an exact asset contract,
an atomic amount, or `x402Version`; this pack does not invent any of them.
Historical OP Stack finality is also insufficient under the frozen bounded
ruleset (`OP_ANCESTRY_DEPTH_EXCEEDED`), even though execution is supported.

No settlement, service-delivery, refund, retry, compensation, authorization, or
economic-policy conclusion is present or implied. There is no parser or adapter
for F1 in this milestone.

## Offline frozen provenance

The source of truth is Network Evidence commit
`d0917f637bda43627f38fcc1c02d5957d2802f4c`, case
`examples/x402-base-late-settlement-1062`. Exact frozen Git blob bytes are copied
at `source/network-evidence/README.md`, `source/network-evidence/case.ts`, and
`source/network-evidence/fixtures/` (the fixture manifest plus both raw
captures). The documentary index pins each local path, Git blob identity, and
SHA-256 value. The exact reviewed Hub F0 projection is copied at
`source/hub-frozen-ne-projection/05-network-evidence-result.json` with SHA-256
`724493778e217047a00b6ee18fc20177b3ab115f902ed773659336701be44e45`.
All checks are local and require no network access.

This pack contains no synthetic A2A/MCP artifact. Its Hub-owned documentary
index and expected semantics are explicitly labelled as such and do not create
Network Evidence authority.
