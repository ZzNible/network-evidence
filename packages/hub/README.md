# @nec/hub

Public **source contract scaffold** for the minimal Hub layer targeted by Network Evidence Suite v1.1.0.

LOT 1 freezes types only. It intentionally does **not** implement normalization yet.

Accepted future inputs are either a Core `NetworkEvidenceResult` object or the Core `nec-wire-json-v1` `network-evidence-result` representation. LOT 2 must validate/decode with `@nec/core` and return `hub-network-evidence-record/v0.1` containing the complete validated Core result unchanged.

This package is not a hosted service, ingestion platform, database, A2A/MCP framework, wallet, signer, submission layer, policy engine, or confidence/trust scorer. `TARGET_CORE_MUTATIONS = 0`.

See `../../docs/INTEGRABILITY_V1_1.md`.
