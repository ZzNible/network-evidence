/**
 * EXAMPLE CALLER POLICY — not part of Network Evidence.
 *
 * `@nec/discovery` never chooses, ranks or scores networks. This file is the
 * kind of logic an integrator writes on its own side, after reading the
 * Core classifications. Replace it with your own policy.
 *
 * The policy here is deliberately trivial: walk the caller's own preference
 * list in order and take the first candidate Core classified `eligible`.
 * `conditional` and `ineligible` candidates are skipped by THIS policy;
 * another caller may accept `conditional` candidates.
 */

import type { DiscoveryCandidateOutcome } from "@nec/discovery";

export const CALLER_POLICY_DESCRIPTION =
  "caller policy (example code, not NE): choose the first `eligible` candidate in the caller-provided preference list";

export interface CallerPolicyStep {
  readonly candidateId: string;
  readonly classification: string;
  readonly decision: "chosen" | "skipped" | "not-reached";
  readonly note: string;
}

export interface CallerChoice {
  /** The chosen presentation id, or null when no listed candidate is eligible. */
  readonly chosenId: string | null;
  readonly steps: readonly CallerPolicyStep[];
}

export function chooseFirstEligibleByCallerPreference(
  candidates: readonly DiscoveryCandidateOutcome[],
  preference: readonly string[],
): CallerChoice {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const steps: CallerPolicyStep[] = [];
  let chosenId: string | null = null;
  for (const id of preference) {
    const candidate = byId.get(id);
    if (candidate === undefined) throw new Error(`caller preference names unknown candidate ${JSON.stringify(id)}`);
    const classification = candidate.match.classification;
    if (chosenId !== null) {
      steps.push({ candidateId: id, classification, decision: "not-reached", note: "a preferred eligible candidate was already chosen" });
    } else if (classification === "eligible") {
      chosenId = id;
      steps.push({ candidateId: id, classification, decision: "chosen", note: "first eligible entry in the caller preference list" });
    } else {
      steps.push({ candidateId: id, classification, decision: "skipped", note: "this caller policy accepts eligible only" });
    }
  }
  return { chosenId, steps };
}
