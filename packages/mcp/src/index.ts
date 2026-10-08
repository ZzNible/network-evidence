/**
 * @nec/mcp — local, read-only MCP server v0 over public Network Evidence code.
 *
 * Three tools, no router: list_network_profiles, discover_network_candidates,
 * get_reviewed_evidence_case. Streamable HTTP at /mcp, health at /healthz (local) or /health (hosted);
 * loopback-only by default, plus an explicit opt-in hosted preview mode (exact
 * public origin, 0.0.0.0:$PORT). No network I/O, no wallet/signing/funding/
 * submission, no ranking or network choice. Not published; not deployed.
 */

export { NeMcpConfigError, NeMcpError, toSafeToolError } from "./errors.js";
export type { NeMcpErrorCode, SafeToolError } from "./errors.js";

export { fixedProfileEnvironments, networkProfilesInventory, PROFILES_SCHEMA, TRUTH_BOUNDARIES } from "./profiles.js";
export type { NetworkProfileEntry, NetworkProfilesInventory } from "./profiles.js";

export { DISCOVERY_QUALIFICATION, DISCOVERY_SCHEMA, MAX_DISCOVERY_CANDIDATES, runDiscoverNetworkCandidates } from "./discover.js";
export type { DiscoverToolCandidate, DiscoverToolInput, DiscoverToolOutput } from "./discover.js";

export {
  CASE_SERVER_NON_CLAIMS,
  loadReviewedCaseStore,
  REVIEWED_CASE_SCHEMA,
  REVIEWED_COLLECTION_PATH,
  REVIEWED_COLLECTION_SHA256,
} from "./cases.js";
export type { EvidenceClass, ReviewedCaseOutput, ReviewedCaseStore } from "./cases.js";

export { createNeMcpServer, READ_ONLY_ANNOTATIONS, SERVER_NAME, SERVER_VERSION, TOOL_NAMES } from "./tools.js";

export {
  DEFAULT_HOST,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_PORT,
  HEALTH_SCOPE,
  LOOPBACK_HOSTS,
  MAX_MAX_BODY_BYTES,
  startNeMcpHttpServer,
  validateHttpOptions,
} from "./http.js";
export type { NeMcpHttpOptions, NeMcpHttpServer, ValidatedHttpOptions } from "./http.js";

export { HOSTED_BIND_HOST, hostedAllowlist, resolveServeConfig, validateHostedOrigin } from "./hosted.js";
export type { HostedAllowlist, NeMcpHostedOptions, NeMcpMode, ResolvedServeConfig } from "./hosted.js";

export { GlobalAbuseLimiter, HOSTED_DEFAULT_LIMITS, LOCAL_DEFAULT_LIMITS, resolveLimits } from "./limits.js";
export type { NeMcpLimits } from "./limits.js";
