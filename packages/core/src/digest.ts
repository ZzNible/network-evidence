import { createHash } from "node:crypto";

import { canonicalJsonBytes, CANONICAL_JSON_PROFILE } from "./canonical-json.js";
import { NecDigestError } from "./errors.js";
import type { Digest } from "./types.js";

/**
 * `nec-digest-v1` — INTERNAL digest profile for NEC.
 *
 * - Algorithm: SHA-256 (via node:crypto). No pluggable algorithms: unknown
 *   algorithms fail closed.
 * - Domain separation: the preimage is
 *
 *       "nec-digest-v1\n" + domain + "\n" + byteLength + "\n" + payload
 *
 *   where `payload` is the canonical-JSON bytes (`nec-canonical-json-v1`)
 *   for JSON inputs, or raw caller-supplied bytes for `digestBytes`.
 *   The length line prevents concatenation ambiguity between payloads.
 * - Output format: `sha256:<64 lowercase hex characters>`.
 *
 * A digest is deterministic integrity/correlation only. It is NOT a
 * signature, attestation, or trust statement (open decision in NEC v0.1).
 */

export const DIGEST_PROFILE = "nec-digest-v1";

/** Explicit, versioned digest domains. Domain separation is mandatory. */
export const DIGEST_DOMAINS = {
  evidenceRef: "evidence-ref",
  evidencePolicy: "evidence-policy",
  evidenceRequest: "evidence-request",
  resolverManifest: "resolver-manifest",
  evidenceSnapshot: "evidence-snapshot",
  networkEvidenceResultSemantic: "network-evidence-result-semantic",
  networkEvidenceResultArtifact: "network-evidence-result-artifact",
  capabilitySnapshot: "capability-snapshot",
  discoveryResult: "discovery-result",
  preflightResult: "preflight-result",
  nativeSourcePayload: "native-source-payload",
} as const;

export type DigestDomain = (typeof DIGEST_DOMAINS)[keyof typeof DIGEST_DOMAINS] | (string & {});

const DOMAIN_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

const PREIMAGE_HEADER = `${DIGEST_PROFILE}\n`;

function assertDomain(domain: DigestDomain): void {
  if (typeof domain !== "string" || !DOMAIN_PATTERN.test(domain)) {
    throw new NecDigestError(
      "NEC_DIGEST_INVALID_DOMAIN",
      `invalid digest domain ${JSON.stringify(String(domain))}; must match ${String(DOMAIN_PATTERN)}`,
    );
  }
}

/** Digest of raw bytes under an explicit domain. */
export function digestBytes(domain: DigestDomain, bytes: Uint8Array): Digest {
  assertDomain(domain);
  const header = `${PREIMAGE_HEADER}${domain}\n${bytes.length}\n`;
  const hash = createHash("sha256");
  hash.update(header, "utf8");
  hash.update(bytes);
  return `sha256:${hash.digest("hex")}`;
}

/** Digest of a value canonicalized under `nec-canonical-json-v1`. */
export function digestCanonicalJson(domain: DigestDomain, value: unknown): Digest {
  return digestBytes(domain, canonicalJsonBytes(value));
}

/** True iff `value` has the exact NEC v0.1 digest shape. Unknown prefixes fail closed. */
export function isDigest(value: unknown): value is Digest {
  return typeof value === "string" && DIGEST_PATTERN.test(value);
}

export { CANONICAL_JSON_PROFILE };
