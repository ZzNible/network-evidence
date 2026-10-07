# @nec/hub

Minimal public Hub runtime for Network Evidence Suite v1.1 integrability.

```ts
import { normalizeNetworkEvidenceV01 } from "@nec/hub";

const fromObject = normalizeNetworkEvidenceV01({
  kind: "network_evidence_result",
  result,
});

const fromWire = normalizeNetworkEvidenceV01({
  kind: "nec_wire_json_v1",
  wireType: "network-evidence-result",
  wire,
});
```

Both paths delegate validation/decoding to `@nec/core` and emit
`hub-network-evidence-record/v0.1`. The Hub retains a detached, fully validated
Core result; it does not reinterpret, score, correlate, fetch, store, sign, or
submit anything.

Object input is validated by Core, then Core wire round-tripped solely to detach
it from caller mutation. Wire input is decoded by Core directly. Invalid or
unsupported input fails closed by throwing.

`TARGET_CORE_MUTATIONS = 0`.
