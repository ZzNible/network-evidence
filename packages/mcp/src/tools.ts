/**
 * The three public tools and the per-request McpServer factory.
 *
 * No generic router: exactly `list_network_profiles`,
 * `discover_network_candidates` and `get_reviewed_evidence_case`. All three
 * are read-only, non-destructive, idempotent and closed-world (no external
 * system is touched), declared explicitly in their annotations.
 */

import { McpServer } from "@modelcontextprotocol/server";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/server";
import { CAPABILITY_NAMES } from "@nec/core";
import * as z from "zod";

import type { ReviewedCaseStore } from "./cases.js";
import { MAX_DISCOVERY_CANDIDATES, runDiscoverNetworkCandidates } from "./discover.js";
import { toSafeToolError } from "./errors.js";
import { networkProfilesInventory } from "./profiles.js";

export const SERVER_NAME = "network-evidence-mcp";
export const SERVER_VERSION = "0.0.1";

export const TOOL_NAMES = ["list_network_profiles", "discover_network_candidates", "get_reviewed_evidence_case"] as const;

/** Explicit boolean hints for every tool. */
export const READ_ONLY_ANNOTATIONS: ToolAnnotations = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

export const SERVER_INSTRUCTIONS = [
  "Network Evidence MCP v0 — local, read-only, offline.",
  "BEFORE asks what an exact network/deployment can support and what is currently observable/usable WITH EVIDENCE; AFTER asks what the network itself can independently support about one exact action.",
  "This server performs no network I/O and never observes a network. list_network_profiles reports declared resolver support only (current support/availability: not_assessed). discover_network_candidates runs Core Discovery over contexts YOU supply; its outcome depends only on those snapshots, and it never chooses a network. get_reviewed_evidence_case returns shipped historical or synthetic fixture cases; none is live evidence.",
  "No wallet, signing, funding, gas, transaction submission, settlement or live finality claims.",
].join("\n");

/** The hosted preview is remote, but still reads no live network data. */
export const HOSTED_SERVER_INSTRUCTIONS = SERVER_INSTRUCTIONS.replace(
  "Network Evidence MCP v0 — local, read-only, offline.",
  "Network Evidence MCP v0 — hosted preview, anonymous, read-only, offline; not a production service.",
);

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const capabilityName = z.enum(CAPABILITY_NAMES as unknown as [string, ...string[]]);
const environment = z.enum(["mainnet", "testnet"]);
const id = z.string().min(1).max(256);
const networkIdList = z.array(z.string().min(1).max(128)).max(64);
const jsonObject = z.record(z.string(), z.unknown());

const requirementsSchema = z
  .object({
    requirements: z
      .array(
        z
          .object({
            capability: capabilityName.describe("Closed Core capability vocabulary."),
            strength: z.enum(["required", "desired"]),
          })
          .strict(),
      )
      .max(CAPABILITY_NAMES.length * 2)
      .describe("Required unsatisfied/unknown => ineligible; desired unsatisfied/unknown => conditional (Core semantics)."),
    networkAllowlist: networkIdList.optional().describe("Core request semantics: unlisted candidates are reported ineligible."),
    networkDenylist: networkIdList.optional().describe("Core request semantics: listed candidates are reported ineligible."),
    metadata: jsonObject.optional(),
  })
  .strict()
  .describe("Core DiscoveryRequirements (validated by @nec/core).");

const networkSchema = z
  .looseObject({
    networkId: z.string().describe("CAIP-2 style network id, e.g. eip155:84532 or solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1."),
    observedAt: jsonObject.describe("NetworkAnchor: { timestamp?, blockNumber? (decimal string), blockId? }."),
  })
  .describe(
    "Core NetworkFingerprint in nec-wire-json-v1 form. MUST be canonically identical to snapshot.network (full fingerprint equality; same networkId alone is insufficient).",
  );

const manifestSchema = z
  .looseObject({
    id: z.string(),
    version: z.string(),
    digest: z.string().describe("sha256:<64 hex>; verified by @nec/core."),
    networkFamilies: z.array(z.string()),
    implementation: jsonObject,
    supportedCapabilities: z.array(z.string()),
    sourceRequirements: z.array(jsonObject),
  })
  .describe("The COMPLETE Core ResolverManifest behind snapshot.resolver (nec-wire-json-v1).");

const snapshotSchema = z
  .looseObject({
    schemaVersion: z.literal("0.1"),
    id: z.string(),
    generatedAt: z.string(),
    network: jsonObject,
    evidenceCapabilities: jsonObject,
    executionCapabilities: jsonObject,
    evidence: z.array(jsonObject),
    resolver: jsonObject,
    artifactDigest: z.string(),
  })
  .describe(
    "The COMPLETE Core CapabilitySnapshot for exactly this network, in nec-wire-json-v1 form (every blockNumber is a canonical decimal STRING). Produce it with a public resolver BEFORE derivation (e.g. deriveOpStackBeforeFoundation(...).snapshot) and encodeNecWireJson('capability-snapshot', ...).",
  );

const discoverInputSchema = z
  .object({
    requestId: id.describe("Becomes DiscoverNetworksResult.requestId (NEC identifier grammar, e.g. 'disc-1')."),
    generatedAt: z
      .string()
      .max(64)
      .describe("Explicit result time, exactly YYYY-MM-DDTHH:mm:ss.sssZ. The server reads no clock."),
    requirements: requirementsSchema,
    candidates: z
      .array(
        z
          .object({
            id: id.describe("Opaque presentation id (NEC identifier grammar), unique in the request."),
            environment: environment.describe(
              "Presentation-only label; never evidence. Must not contradict the fixed profile for a listed network (e.g. zkSYS eip155:57057 is testnet only).",
            ),
            network: networkSchema,
            manifest: manifestSchema,
            snapshot: snapshotSchema,
          })
          .strict(),
      )
      .min(1)
      .max(MAX_DISCOVERY_CANDIDATES)
      .describe(
        `1..${MAX_DISCOVERY_CANDIDATES} EXPLICIT, complete, already-derived candidate contexts. No default or demo candidates exist.`,
      ),
    scope: z
      .object({
        candidateIds: z.array(id).min(1).max(MAX_DISCOVERY_CANDIDATES).optional().describe("Exact presentation ids."),
        environments: z.array(environment).min(1).max(2).optional(),
      })
      .strict()
      .optional()
      .describe("Optional presentation scope; removes candidates from the result, never changes a classification."),
  })
  .strict();

const profileCapabilitySchema = z.object({
  capability: z.string(),
  declaredByResolverManifest: z.boolean(),
  currentSupport: z.literal("not_assessed"),
  currentAvailability: z.literal("not_assessed"),
});

const profilesOutputSchema = z.object({
  schema: z.literal("ne-mcp-network-profiles/v0.1"),
  liveObservation: z.literal(false),
  inventoryOrder: z.string(),
  profiles: z.array(
    z.object({
      profileId: z.string(),
      label: z.string(),
      networkId: z.string(),
      chainId: z.number().nullable(),
      genesisHash: z.string().nullable(),
      environment,
      family: z.enum(["opstack", "solana", "zksys"]),
      source: z.string(),
      resolverManifest: z.object({ id: z.string(), version: z.string(), digest: z.string(), package: z.string().nullable() }),
      acceptedObservationKinds: z.array(z.enum(["probe", "historical_replay"])),
      capabilities: z.array(profileCapabilitySchema),
      currentStatus: z.literal("not_assessed"),
      doesNotEstablish: z.array(z.string()),
      notes: z.array(z.string()),
    }),
  ),
  truthBoundaries: z.array(z.string()),
  howToAssess: z.string(),
});

const discoverOutputSchema = z.object({
  schema: z.literal("ne-mcp-discovery/v0.1"),
  liveObservation: z.literal(false),
  networkChoice: z.string(),
  qualification: z.array(z.string()),
  coreVerification: z.object({
    builtAndVerifiedBy: z.string(),
    reverifiedAtMcpBoundary: z.literal(true),
    resultArtifactDigest: z.string(),
    wireProfile: z.string(),
  }),
  candidates: z.array(
    z.object({
      id: z.string(),
      environment,
      environmentLabelSource: z.literal("caller"),
      networkId: z.string(),
      resolver: z.object({ id: z.string(), version: z.string(), digest: z.string() }),
      classification: z.enum(["eligible", "conditional", "ineligible"]),
      suppliedSnapshot: z.object({
        id: z.string(),
        artifactDigest: z.string(),
        generatedAt: z.string(),
        networkObservedAt: z.string().nullable(),
        declaredObservationKind: z.string().nullable(),
        evidenceSourceIds: z.array(z.string()),
      }),
    }),
  ),
  scope: z.object({
    candidateIds: z.array(z.string()).nullable(),
    environments: z.array(environment).nullable(),
    inScopeCandidateIds: z.array(z.string()),
    outOfScopeCandidateIds: z.array(z.string()),
  }),
  verificationContextRefs: z.object({
    capabilitySnapshots: z.array(z.object({ id: z.string(), digest: z.string() })),
    resolverManifests: z.array(z.object({ id: z.string(), version: z.string(), digest: z.string() })),
  }),
  coreResult: jsonObject.describe("THE Core DiscoverNetworksResult (nec-wire-json-v1)."),
});

const caseOutputSchema = z.object({
  schema: z.literal("ne-mcp-reviewed-case/v0.1"),
  caseId: z.string(),
  evidenceClass: z.enum(["historical-reviewed-public-network-fixture", "synthetic-local-fixture"]),
  label: z.string(),
  liveObservation: z.literal(false),
  currentAvailability: z.literal("unknown"),
  source: z.object({
    path: z.string(),
    sha256: z.string(),
    pinnedBy: z.array(z.string()),
    collectionSchemaVersion: z.string(),
    validatedBy: z.array(z.string()),
  }),
  caseProvenance: jsonObject,
  collectionNonClaims: z.array(z.string()),
  serverNonClaims: z.array(z.string()),
  envelope: jsonObject.describe("The shipped ne-maps-case/v0.1 envelope, verbatim (browser-safe Lens projection)."),
});

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

function ok(structured: object): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(structured) }],
    structuredContent: structured as Record<string, unknown>,
  };
}

function toolError(error: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: toSafeToolError(error) }) }],
    isError: true,
  };
}

export interface NeMcpServerDeps {
  readonly cases: ReviewedCaseStore;
  readonly mode?: "local" | "hosted";
}

/** Fresh McpServer with exactly the three tools (one per request; stateless). */
export function createNeMcpServer(deps: NeMcpServerDeps): McpServer {
  const instructions = deps.mode === "hosted" ? HOSTED_SERVER_INSTRUCTIONS : SERVER_INSTRUCTIONS;
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions });
  const caseIds = deps.cases.caseIds as unknown as [string, ...string[]];

  server.registerTool(
    "list_network_profiles",
    {
      title: "List fixed Network Evidence profiles",
      description:
        "Returns the FIXED public profile inventory (Base mainnet eip155:8453, Base Sepolia eip155:84532, Solana mainnet, Solana devnet, zkSYS Tanenbaum testnet eip155:57057 replay-only) with each resolver manifest's DECLARED capabilities and the truth boundaries. Nothing is observed: every currentSupport/currentAvailability is 'not_assessed'. Profile membership is not live availability. Takes no arguments.",
      inputSchema: z.object({}).strict(),
      outputSchema: profilesOutputSchema,
      annotations: { ...READ_ONLY_ANNOTATIONS, title: "List fixed Network Evidence profiles" },
    },
    async () => {
      try {
        return ok(networkProfilesInventory());
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "discover_network_candidates",
    {
      title: "Core Discovery over explicit candidate contexts",
      description:
        `Runs the real @nec/discovery discoverNetworks (classification by @nec/core only) over 1..${MAX_DISCOVERY_CANDIDATES} EXPLICIT, complete, already-derived candidate contexts you supply (network + ResolverManifest + CapabilitySnapshot in nec-wire-json-v1 form) and Core DiscoveryRequirements. Returns the Core-built, Core-verified DiscoverNetworksResult with digests and per-candidate eligible/conditional/ineligible copied from Core. The outcome depends ONLY on the supplied snapshots; this server observes nothing and does NOT choose, rank or recommend a network. Any resolver-specific evidence preflight is external to this tool. Invalid or incoherent contexts fail closed with a coded error.`,
      inputSchema: discoverInputSchema,
      outputSchema: discoverOutputSchema,
      annotations: { ...READ_ONLY_ANNOTATIONS, title: "Core Discovery over explicit candidate contexts" },
    },
    async (args) => {
      try {
        return ok(runDiscoverNetworkCandidates(args));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "get_reviewed_evidence_case",
    {
      title: "Read one shipped reviewed NE Maps case",
      description:
        `Returns ONE case by exact id (${deps.cases.caseIds.join(", ")}) from the shipped, checksum-pinned examples/ne-maps/data/collection.json: the browser-safe Lens envelope verbatim (all limitations, unavailable/unknown states and nonClaims preserved), its source provenance and an explicit label. f1/f2/f3 are HISTORICAL reviewed exports of past public-network observations; synthetic-local-core-golden is a SYNTHETIC fixture, not a network observation. No case is live evidence.`,
      inputSchema: z
        .object({ caseId: z.enum(caseIds).describe("Exact case id; no paths, no prefixes, no fuzzy matching.") })
        .strict(),
      outputSchema: caseOutputSchema,
      annotations: { ...READ_ONLY_ANNOTATIONS, title: "Read one shipped reviewed NE Maps case" },
    },
    async ({ caseId }) => {
      try {
        return ok(deps.cases.get(caseId));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  return server;
}
