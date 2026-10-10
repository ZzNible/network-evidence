/**
 * @nec/mcp — local, read-only MCP server v0 over public Network Evidence code.
 *
 * Three offline tools by default. This UNDEPLOYED candidate adds three
 * hosted-only opt-in EVM + Solana source-evidence tools (AFTER, BEFORE/Discovery
 * and caller-selected native evidence preflight), with optional protocol claim
 * and Base-only OP Stack L2 finality on AFTER.
 * Streamable HTTP at
 * /mcp; loopback-only by default. No signing/funding/submission/ranking.
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

export { createNeMcpServer, READ_ONLY_ANNOTATIONS, SERVER_NAME, SERVER_VERSION, TOOL_NAMES, LIVE_TOOL_NAMES } from "./tools.js";
export { createMultichainTool, LIVE_MULTICHAIN_TOOL, LIVE_MULTICHAIN_NETWORK_IDS } from "./live-multichain.js";
export { createLiveBeforeTool, LIVE_BEFORE_TOOL_NAME, LIVE_BEFORE_SCHEMA } from "./live-before.js";
export { createLivePreflightTool, LIVE_PREFLIGHT_TOOL_NAME, LIVE_PREFLIGHT_SCHEMA } from "./live-preflight.js";
export { CLAIM_PROTOCOLS, prepareLiveClaim, resolveWithOptionalClaim } from "./live-claim.js";
export { restrictedBaseRpcFetch } from "./live-evm.js";
export { restrictedSolanaRpcFetch } from "./live-solana.js";

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
