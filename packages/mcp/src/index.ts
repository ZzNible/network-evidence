/**
 * @nec/mcp — local, read-only MCP server v0 over public Network Evidence code.
 *
 * Three tools, no router: list_network_profiles, discover_network_candidates,
 * get_reviewed_evidence_case. Loopback-only Streamable HTTP at /mcp, health at
 * /healthz. No network I/O, no wallet/signing/funding/submission, no ranking
 * or network choice. Not published; not a public endpoint.
 */

export { NeMcpError, toSafeToolError } from "./errors.js";
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
  LOOPBACK_HOSTS,
  MAX_MAX_BODY_BYTES,
  NeMcpConfigError,
  startNeMcpHttpServer,
  validateHttpOptions,
} from "./http.js";
export type { NeMcpHttpOptions, NeMcpHttpServer } from "./http.js";
