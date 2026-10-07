# @nec/lens

Public **source contract scaffold** for `lens-case/v0.1` targeted by Network Evidence Suite v1.1.0.

LOT 1 freezes the machine-facing TypeScript contract and function signatures only. LOT 2 implements:

- runtime validation;
- generic `HubNetworkEvidenceRecordV01 -> LensCaseV01` composition;
- deterministic serialization;
- conservative browser-safe projection.

Network Evidence assessments must retain the exact four verdicts and Core evidence bases. Missing/unavailable evidence remains missing/unavailable. Other evaluator vocabularies are never coerced into Network Evidence vocabulary. No global verdict, confidence, trust score, policy decision, wallet/signing/submission, or Core mutation is admitted.

See `../../docs/INTEGRABILITY_V1_1.md`.
