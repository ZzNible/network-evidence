# v1.1 generic integrability fixture plan

LOT 1 prepares the proof fixture but intentionally does not implement the Hub/Lens/Maps pipeline yet.

LOT 2 will extract one **synthetic/local** `NetworkEvidenceResult` from the already-reviewed Core golden world instead of inventing new network semantics:

- source world: the independent literal golden vector in `packages/core/test/golden.test.ts` (`goldenResultContent()` + `goldenContext()`);
- LOT 2 will extract/materialize that already-reviewed world into a public synthetic/local fixture rather than depend on private test helpers at runtime;
- expected semantic digest: `sha256:ee7263927cf3470ecd524f6321287bd056b3f444e5285a5d355a07d8440bc1ef`;
- expected artifact digest: `sha256:5569171adbbe7a31dd82c363134e21532e5ad0bd7b8f2cf80e97ad4a49f29f7d`.

Coverage deliberately includes:

- execution `supported` on `source_observation`;
- one observed ERC-20 transfer effect;
- data binding `not_applicable`;
- settlement `unknown`;
- finality `unknown` / not established;
- no policy/confidence score.

LOT 2 must materialize both the object and `nec-wire-json-v1` form through existing Core APIs, then prove:

```text
Core result
-> @nec/hub validation/record
-> @nec/lens generic case
-> browser-safe Lens projection
-> ne-maps-case/v0.1 envelope
```

The proof passes only if the new case reaches Maps without modifying Core or adding case-specific logic to `examples/ne-maps/app.js`.
