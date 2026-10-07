# Historical compatibility provenance

Hub/Lens source authority:

- repository: `ZzNible/agent-evidence-hub`
- branch: `autonomy/authority-v1`
- commit: `586a81a39c8da4d3a0dc0e879b605aabfd3f8d1d`
- review state: CLEAN (149/149 tests; 13 fixture dirs / 54 pinned files)

Every file under `authority/` except the three `lib/*.d.mts` type declarations
is a byte-for-byte copy of the same path in that commit. Git blob identity and
SHA-256 were checked for each exported file:

| Authority path | Git blob | SHA-256 |
| --- | --- | --- |
| `lib/h1.mjs` | `6139f59f6503cd06958d09640482049361e35dbf` | `a9eb3c6e9688267d2dbba56f193cf33fcef92215e75938165f98a03f6678b9a8` |
| `lib/f1.mjs` | `258f8ab5ef13061cd2f06e1bf843b597ba747d92` | `30dfd899f8cd5d4db0bc4eb8dadb382f577e6616492e2de498386d617b9439ff` |
| `lib/f2.mjs` | `f5598588b332153a0faedb63d40c2f369bf3b6a9` | `9773f0d4ca423d189ab09fd1acd1c5d11ee1813490fc1daf2412c4285986411a` |
| `lib/f3.mjs` | `e8ec566b71353a7c40dce3b5087f221b4477d60f` | `360352dc646ef3d50a3294129d84ff2d73927fa716cebb0b379219edf6736fbf` |
| `fixtures/F1-x402-1062-partial/MANIFEST.sha256` | `3ea7d93fa525fb4dd7ec19a958c06c7cb77a3410` | `6663fd8ffd938d7dad99655cd08a6612de705173fe3c08443d318fac9e834b06` |
| `fixtures/F1-x402-1062-partial/README.md` | `a69999b1a2eb2d8f4cb5810bf359f5e176413b22` | `69726fea235fff249bc07c6cdc7d4e4a6d61edefbfad09a72dbb7cc5bbd07f7e` |
| `fixtures/F1-x402-1062-partial/01-public-issue-claim.json` | `410b9387662b61cca7ad49a7219d3f589cba2931` | `1fe2ccda2beeec6763a0bc8ee931a88d2df835555b6f013fa056dd20f254a590` |
| `fixtures/F1-x402-1062-partial/02-frozen-network-evidence-reference.json` | `eb0cced8d82b778bb169343d3e839ae082261b1f` | `cc965df544794ee3723a98a17bd65d8bc9b3c738b6b7f8fbb91d82586ad7b548` |
| `fixtures/F1-x402-1062-partial/03-expected-lens-semantics.json` | `8f8a28b17a4396cdcb8b5bd2cde692581b08fe6b` | `965148764f609996366aa95f5645705f7566d53f37cc92871333cdc22472facc` |
| `fixtures/F1-x402-1062-partial/source/hub-frozen-ne-projection/05-network-evidence-result.json` | `c1dc7c40b62a16ee1ad5b74a982e93f2cd450f83` | `724493778e217047a00b6ee18fc20177b3ab115f902ed773659336701be44e45` |
| `fixtures/F1-x402-1062-partial/source/network-evidence/fixtures/base-mainnet-x402-1062-usdc-transfer.fixture.json` | `b4b1547dabbd57c15ac25964b8fe145c8f06c18a` | `5f25e8140cfb4e0d6ab2440ba4854e42f7e390169b947a54d519c0cec546e813` |
| `fixtures/F1-x402-1062-partial/source/network-evidence/fixtures/base-mainnet-x402-1062-finality.fixture.json` | `66bdf74c4d07451f2851ff87d89fd556daa1e876` | `2aaa1c1cb48fb3dfdf4e9fc1d840ca9d26b007467cb45c21054c9149696446e9` |
| `fixtures/F2-erc4337-base-sepolia-v06/MANIFEST.sha256` | `f5e7b3b4f8726ef0379194e037089b5a34fd1378` | `84ff825ab91719d82dc315d3dec2363dcf1f3525d403475a93ea569bbb1a36ac` |
| `fixtures/F2-erc4337-base-sepolia-v06/README.md` | `d5291eecf605fd41291e3d1cf12091a661a9f9e7` | `0ceb883802e0d3b4529f2abcbb148664047ee75dd459da954fe80491b2c3977a` |
| `fixtures/F2-erc4337-base-sepolia-v06/01-frozen-network-evidence-reference.json` | `10f7f8a4907a0596a5ee88dc63464454d1371299` | `33cb0a2e85e0380a898364e7c4d02e072f7d13fe0e5818643b98d40bf9f2a39d` |
| `fixtures/F2-erc4337-base-sepolia-v06/02-expected-lens-semantics.json` | `0e22c49972fa4c8e11290ff25968f25098fc8d3a` | `676a07b1426a0bd9be3a1ef47255b9b364c6c524742343fa0e002bd67e986d5b` |
| `fixtures/F3-solana-mainnet-x402-partial/MANIFEST.sha256` | `a69ccd5049df903012f5ff72ffecebbb4a98ab3c` | `93ec76e661c33e0038d1df193781d1491bf60c03d45c9fcb67fa9517b569c571` |
| `fixtures/F3-solana-mainnet-x402-partial/README.md` | `c5108073b3531f3a8c2dcc0839ddec6c7c12700e` | `79856c85fafd9722f63c726cb10092486db8458104a8cfd566fd549487940ac3` |
| `fixtures/F3-solana-mainnet-x402-partial/01-frozen-network-evidence-reference.json` | `301cd9952ff98c7cd892dfc69b22e0b382109131` | `ddb7ea558b383e2d02634fe79aa0e241e8055815b5dcf0c852fe592d3d8eb047` |
| `fixtures/F3-solana-mainnet-x402-partial/02-expected-lens-semantics.json` | `219730b6eec2dd9f4b3734f1788e28d7110afc39` | `4700932cf1756c57ad98c5fb9ef368ab8f69688a5c8625221a5d0fdff4a1b677` |
| `fixtures/F3-solana-mainnet-x402-partial/03-expected-demo-output.sha256` | `d212d440d488798c4a30bcf9fb7c66df90120257` | `c33e6202afa07bbc73f7237ee7691d3d28d8f1887c955c7d0a923bda0d97ca13` |
| `fixtures/F3-solana-mainnet-x402-partial/source/04-frozen-core-runtime.json` | `d1c8dfe6732be169bc9e4d660735ff763b4c99e9` | `ce2f4eb570df3f2ebb264127e5a570746cb677cb68165c76dbbcf5ef1e9d21ff` |

`lib/h1.mjs`, `lib/f2.mjs` and the F2 reference are also byte-identical to the
existing public copies in `examples/core-hub-lens/` (asserted by test); that
frozen v1.0.0 demo export is left unchanged.

## Exported subset

Each authority fixture `MANIFEST.sha256` is copied verbatim; every exported file
matches its manifest entry. Only files consumed by the compatibility path or its
tests are exported. Intentionally not exported (still digest-pinned by the
verbatim F1 manifest and by `02-frozen-network-evidence-reference.json`):

- `fixtures/F1-x402-1062-partial/source/network-evidence/README.md`
- `fixtures/F1-x402-1062-partial/source/network-evidence/case.ts`
- `fixtures/F1-x402-1062-partial/source/network-evidence/fixtures/MANIFEST.sha256`

The F1 raw captures are public Base mainnet JSON-RPC responses. F3 additionally
binds public files already present in this repository
(`packages/resolver-solana/test/fixtures/solana-mainnet-x402-real.json`,
`packages/adapter-x402-svm/test/adapter.test.ts`,
`packages/adapter-x402-svm/README.md`); F2 binds
`packages/adapter-erc4337/test/fixtures/base-sepolia-external-v06-userop.json`.
Their SHA-256 values are checked before replay.

## Reviewed projection

The reviewed browser projections compared against are the F1/F2/F3 `lens`
entries of `examples/ne-maps/data/cases.json` (SHA-256
`eef096d0e774bef6ce2b9c111218b52be19d00613c75eb538ce8f936ccf580e1`), exported
from the same authority commit with construction metadata
`namespace = ne-maps-v1`, `createdAt = 2026-10-07T00:00:00.000Z`. Running the
authority adapters at 586a81a with that metadata reproduces those entries
exactly.

The F3 authority Core -> Hub -> Lens demo output digest
`4881790d6d496533cae41527aefb6d01e941c4c52a294775593eda4de8d64833` is
reproduced byte-for-byte from the fresh public replay plus the promoted adapter.

The authority repository is private development history; these identifiers
are provenance text only and are not required to run anything here.
