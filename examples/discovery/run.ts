/**
 * Public, deterministic, offline Discovery demo.
 *
 *   requirements
 *     -> explicit candidate contexts (Base mainnet / Base Sepolia /
 *        Solana mainnet / Solana devnet, explicit mainnet/testnet labels)
 *     -> @nec/discovery scope + validation
 *     -> Core classifications (eligible / conditional / ineligible)
 *     -> EXTERNAL caller policy chooses a candidate (./caller-policy.ts)
 *     -> resolver-specific evidence preflight for the chosen candidate
 *
 * Later execution is outside Network Evidence; post-action Resolution is a
 * separate step and is not part of this demo. Run: `npm run -s demo:discovery`.
 */

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import {
  computeEvidencePolicyDigest,
  verifyDiscoverNetworksResult,
  verifyPreflightResult,
} from "@nec/core";
import type { DiscoveryRequirements, EvidencePolicy, PolicyDimension, PreflightRequest, PreflightResult } from "@nec/core";
import { discoverNetworks } from "@nec/discovery";
import type { DiscoverNetworksInput, DiscoverNetworksOutcome, DiscoveryEnvironment } from "@nec/discovery";
import {
  deriveOpStackBeforePreflightResult,
  OPSTACK_FINALITY_DOES_NOT_ESTABLISH,
  opStackBeforeResolverManifest,
} from "@nec/resolver-opstack";
import type { OpStackBeforeFoundation } from "@nec/resolver-opstack";
import {
  deriveSolanaBeforePreflightResult,
  SOLANA_FINALITY_DOES_NOT_ESTABLISH,
  solanaBeforeResolverManifest,
} from "@nec/resolver-solana";
import type { SolanaBeforeFoundation } from "@nec/resolver-solana";

import { CALLER_POLICY_DESCRIPTION, chooseFirstEligibleByCallerPreference } from "./caller-policy.js";
import type { CallerChoice } from "./caller-policy.js";
import { loadDemoInputs, SYNTHETIC_OBSERVED_AT } from "./inputs.js";
import type { DemoInputs } from "./inputs.js";

// ---------------------------------------------------------------------------
// Frozen request (explicit values; no clock is read)
// ---------------------------------------------------------------------------

export const DEMO_REQUEST_ID = "disc-demo-cross-family";
export const DEMO_GENERATED_AT = "2026-10-08T09:00:00.000Z";

export const DEMO_REQUIREMENTS: DiscoveryRequirements = {
  requirements: [
    { capability: "execution", strength: "required" },
    { capability: "finality", strength: "desired" },
  ],
};

type DemoCandidateId = keyof DemoInputs;

/** Caller-supplied order (deliberately unsorted) and explicit presentation labels. */
export const DEMO_CANDIDATES: readonly { readonly id: DemoCandidateId; readonly environment: DiscoveryEnvironment }[] = [
  { id: "solana-mainnet", environment: "mainnet" },
  { id: "base-sepolia", environment: "testnet" },
  { id: "solana-devnet", environment: "testnet" },
  { id: "base-mainnet", environment: "mainnet" },
];

/** The caller's OWN preference list, consumed only by ./caller-policy.ts. */
export const CALLER_PREFERENCE: readonly DemoCandidateId[] = ["solana-devnet", "base-sepolia", "solana-mainnet", "base-mainnet"];

const PREFLIGHT_REQUIRED: PolicyDimension[] = ["execution"];
const PREFLIGHT_DESIRED: PolicyDimension[] = ["finality"];

// ---------------------------------------------------------------------------
// Resolver-specific preflight dispatch (public resolver exports only)
// ---------------------------------------------------------------------------

interface PreflightBinding {
  readonly functionName: string;
  readonly packageName: string;
  readonly finalityDoesNotEstablish: readonly string[];
  readonly derive: (foundation: unknown, request: PreflightRequest) => PreflightResult;
}

const PREFLIGHT_BY_RESOLVER: ReadonlyMap<string, PreflightBinding> = new Map([
  [
    opStackBeforeResolverManifest().id,
    {
      functionName: "deriveOpStackBeforePreflightResult",
      packageName: "@nec/resolver-opstack",
      finalityDoesNotEstablish: OPSTACK_FINALITY_DOES_NOT_ESTABLISH,
      derive: (foundation, request) => deriveOpStackBeforePreflightResult(foundation as OpStackBeforeFoundation, request),
    },
  ],
  [
    solanaBeforeResolverManifest().id,
    {
      functionName: "deriveSolanaBeforePreflightResult",
      packageName: "@nec/resolver-solana",
      finalityDoesNotEstablish: SOLANA_FINALITY_DOES_NOT_ESTABLISH,
      derive: (foundation, request) => deriveSolanaBeforePreflightResult(foundation as SolanaBeforeFoundation, request),
    },
  ],
]);

function evidencePolicy(): EvidencePolicy {
  const content = {
    id: "demo-caller-evidence-policy",
    version: "1",
    requiredDimensions: PREFLIGHT_REQUIRED,
    desiredDimensions: PREFLIGHT_DESIRED,
  };
  return { ...content, digest: computeEvidencePolicyDigest(content) };
}

// ---------------------------------------------------------------------------
// Demo flow
// ---------------------------------------------------------------------------

export interface DiscoveryDemo {
  readonly inputs: DemoInputs;
  readonly input: DiscoverNetworksInput;
  readonly outcome: DiscoverNetworksOutcome;
  readonly resultVerified: boolean;
  readonly choice: CallerChoice;
  readonly preflight: {
    readonly binding: PreflightBinding;
    readonly request: PreflightRequest;
    readonly result: PreflightResult;
    readonly verified: boolean;
    readonly snapshotMatchesDiscovery: boolean;
  } | null;
}

/** Build the discovery input from frozen inputs; `environments` overrides labels (tests only). */
export function buildDiscoveryInput(
  inputs: DemoInputs,
  environments: Partial<Record<DemoCandidateId, DiscoveryEnvironment>> = {},
): DiscoverNetworksInput {
  return {
    requestId: DEMO_REQUEST_ID,
    generatedAt: DEMO_GENERATED_AT,
    requirements: DEMO_REQUIREMENTS,
    candidates: DEMO_CANDIDATES.map(({ id, environment }) => {
      const { network, manifest, snapshot } = inputs[id].foundation;
      return { id, environment: environments[id] ?? environment, network, manifest, snapshot };
    }),
    scope: { environments: ["mainnet", "testnet"] },
  };
}

export async function buildDiscoveryDemo(): Promise<DiscoveryDemo> {
  const inputs = await loadDemoInputs();
  const input = buildDiscoveryInput(inputs);

  // @nec/discovery: scope + validation + Core classification + Core build/verify.
  const outcome = discoverNetworks(input);
  const resultVerified = verifyDiscoverNetworksResult(outcome.result, outcome.verificationContext);

  // EXTERNAL caller policy (example code; not an NE feature).
  const choice = chooseFirstEligibleByCallerPreference(outcome.candidates, CALLER_PREFERENCE);
  if (choice.chosenId === null) return { inputs, input, outcome, resultVerified, choice, preflight: null };

  // Resolver-specific evidence preflight for the chosen candidate, over the
  // SAME frozen foundation that was supplied to discovery.
  const chosen = outcome.candidates.find((candidate) => candidate.id === choice.chosenId)!;
  const binding = PREFLIGHT_BY_RESOLVER.get(chosen.resolver.id);
  if (binding === undefined) throw new Error(`no public preflight function for resolver ${chosen.resolver.id}`);
  const foundation = inputs[chosen.id as DemoCandidateId].foundation;
  const request: PreflightRequest = {
    schemaVersion: "0.1",
    requestId: `pf-demo-${chosen.id}`,
    networkId: chosen.networkId,
    action: { kind: "demo.described-action" },
    evidencePolicy: evidencePolicy(),
  };
  const result = binding.derive(foundation, request);
  const verified = verifyPreflightResult(result, { resolver: foundation.manifest, capabilitySnapshot: foundation.snapshot });
  const snapshotMatchesDiscovery =
    result.capabilitySnapshot?.id === chosen.match.capabilitySnapshot.id &&
    result.capabilitySnapshot?.digest === chosen.match.capabilitySnapshot.digest;
  return {
    inputs,
    input,
    outcome,
    resultVerified,
    choice,
    preflight: { binding, request, result, verified, snapshotMatchesDiscovery },
  };
}

// ---------------------------------------------------------------------------
// Stable human-readable stdout contract
// ---------------------------------------------------------------------------

function pad(value: string, width: number): string {
  return value.length >= width ? `${value} ` : value.padEnd(width);
}

export function renderDiscoveryDemo(demo: DiscoveryDemo): string {
  const { inputs, input, outcome, choice, preflight } = demo;
  const lines: string[] = [];
  const out = (line = ""): void => {
    lines.push(line);
  };

  out("Network Evidence - public Discovery demo (deterministic, offline)");
  out();
  out("[1] Requirements (caller-supplied)");
  out(`  requestId    ${input.requestId}`);
  out(`  generatedAt  ${input.generatedAt} (explicit value; no clock is read)`);
  for (const requirement of input.requirements.requirements) {
    out(`  ${pad(requirement.strength, 12)} ${requirement.capability}`);
  }
  out();
  out("[2] Explicit candidate contexts (caller-supplied order; environment is a presentation label only)");
  for (const candidate of input.candidates) {
    const demoInput = inputs[candidate.id as DemoCandidateId];
    out(`  ${pad(candidate.id, 16)} ${pad(candidate.network.networkId, 48)} ${pad(candidate.environment, 8)} ${demoInput.inputKind}`);
    out(`  ${" ".repeat(16)} ${demoInput.note}`);
  }
  out(`  synthetic demo probes are frozen at ${SYNTHETIC_OBSERVED_AT}; they are demo inputs, not live network availability`);
  out();
  out("[3] @nec/discovery scope + validation");
  out(`  scope.environments   ${outcome.scope.environments?.join(", ") ?? "(none)"}`);
  out(`  scope.candidateIds   ${outcome.scope.candidateIds?.join(", ") ?? "(none)"}`);
  out(`  in scope             ${outcome.scope.inScopeCandidateIds.join(", ") || "(none)"}`);
  out(`  out of scope         ${outcome.scope.outOfScopeCandidateIds.join(", ") || "(none)"}`);
  out("  every supplied candidate passed the Core network/manifest/snapshot binding gate");
  out();
  out("[4] Core classifications (Core composeDiscoveryMatch; built and verified by Core)");
  out("  ordering: deterministic by candidate presentation id (UTF-16 code-unit order); the order expresses no preference");
  out(`  result artifactDigest            ${outcome.result.artifactDigest}`);
  out(`  Core verifyDiscoverNetworksResult ${demo.resultVerified}`);
  for (const candidate of outcome.candidates) {
    out(`  - ${candidate.id}`);
    out(`      network         ${candidate.networkId}`);
    out(`      environment     ${candidate.environment} (presentation only)`);
    out(`      resolver        ${candidate.resolver.id}@${candidate.resolver.version}`);
    out(
      `      observation     ${String(candidate.match.network.metadata?.observationKind ?? "(not stated)")} (resolver metadata); demo input: ${inputs[candidate.id as DemoCandidateId].inputKind}`,
    );
    out(`      classification  ${candidate.match.classification}`);
    for (const evaluation of candidate.match.evaluations) {
      const { capability, strength } = evaluation.requirement;
      out(`      ${pad(strength, 9)} ${pad(capability, 10)} ${pad(evaluation.status, 12)} ${evaluation.reason ?? "(no reason)"}`);
    }
  }
  out();
  out("[5] External choice - CALLER POLICY (example code in caller-policy.ts; not a @nec/discovery feature)");
  out(`  ${CALLER_POLICY_DESCRIPTION}`);
  out(`  caller preference list: ${CALLER_PREFERENCE.join(", ")}`);
  for (const [i, step] of choice.steps.entries()) {
    out(`  ${i + 1}. ${pad(step.candidateId, 16)} ${pad(step.classification, 12)} ${pad(step.decision, 12)} ${step.note}`);
  }
  out(`  chosen by caller policy: ${choice.chosenId ?? "(none)"}`);
  out("  all alternatives and their Core classifications remain listed in [4]");
  out();
  out("[6] Resolver-specific evidence preflight for the caller-chosen candidate");
  if (preflight === null) {
    out("  skipped: the caller policy chose no candidate");
  } else {
    const { binding, request, result } = preflight;
    out(`  function           ${binding.functionName} (${binding.packageName})`);
    out(`  requestId          ${request.requestId}`);
    out(`  network            ${request.networkId}`);
    out(`  action             ${request.action.kind} (described only; nothing is built, signed or submitted)`);
    out(
      `  evidencePolicy     required=${request.evidencePolicy.requiredDimensions.join(",")} desired=${(request.evidencePolicy.desiredDimensions ?? []).join(",")}`,
    );
    out(`  evidence context   the same frozen ${inputs[choice.chosenId as DemoCandidateId].inputKind} foundation supplied to discovery`);
    out(`  snapshot matches discovery match ${preflight.snapshotMatchesDiscovery}`);
    out(`  status             ${result.status}`);
    for (const [dimension, check] of Object.entries(result.evidenceReadiness)) {
      out(`    ${pad(dimension, 16)} ${pad(check.status, 15)} ${check.reason ?? "(no reason)"}`);
    }
    out(`  blockers           ${result.blockers.map((blocker) => blocker.code).join(", ") || "(none)"}`);
    out(`  artifactDigest     ${result.artifactDigest}`);
    out(`  Core verifyPreflightResult ${preflight.verified}`);
    out(`  finality here does not establish: ${binding.finalityDoesNotEstablish.join(", ")}`);
  }
  out();
  out("[7] Boundaries");
  out("  - synthetic demo probe inputs are not live network availability; no hosted monitoring or live probing");
  out("  - archived replay keeps current availability unknown");
  out("  - environment labels are presentation only and never change a Core classification");
  out("  - finality is not settlement; Solana finalized does not establish economic irreversibility");
  out("  - OP Stack L2 finality does not establish withdrawal, output-root or dispute-game settlement");
  out("  - zkSYS: current scope is Tanenbaum testnet/replay semantics only; there is no zkSYS mainnet profile");
  out("  - later execution is outside Network Evidence; post-action Resolution is separate and not part of this demo");
  out();
  out("NE did not execute, sign, fund or submit anything.");
  return `${lines.join("\n")}\n`;
}

export async function runDiscoveryDemo(): Promise<string> {
  return renderDiscoveryDemo(await buildDiscoveryDemo());
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  // The demo is offline: any network attempt fails loudly.
  globalThis.fetch = (() => {
    throw new Error("network I/O is forbidden in the Discovery demo");
  }) as typeof fetch;
  process.stdout.write(await runDiscoveryDemo());
}
