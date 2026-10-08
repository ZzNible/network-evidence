/**
 * @nec/discovery — public Discovery orchestrator above @nec/core.
 *
 * Explicit candidates -> optional presentation scope -> Core binding gate ->
 * Core composeDiscoveryMatch -> Core-built, Core-verified
 * DiscoverNetworksResult. The caller chooses externally; there is no
 * ranking, scoring or recommendation, and no network I/O.
 */

export { NecDiscoveryError } from "./errors.js";
export type { NecDiscoveryErrorCode } from "./errors.js";

export { DISCOVERY_ENVIRONMENTS, discoverNetworks } from "./discover.js";
export type {
  AppliedDiscoveryScope,
  DiscoverNetworksInput,
  DiscoverNetworksOutcome,
  DiscoveryCandidateContext,
  DiscoveryCandidateOutcome,
  DiscoveryEnvironment,
  DiscoveryScope,
} from "./discover.js";
