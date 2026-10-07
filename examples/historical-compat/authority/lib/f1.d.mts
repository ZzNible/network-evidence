export const TARGET_CORE_MUTATIONS: 0;
export const F1_ADAPTER_VERSION: string;
export const F1_POLICY_VERSION: string;
export const F1_CASE_ID: string;
export const F1_REQUIRED_ARTIFACTS: readonly string[];
export const F1_PINNED_SHA256: Readonly<Record<string, string>>;
export const F1_X402_EXACT_CLAIM_FIELDS: readonly string[];

export function parseF1Artifact(input: {
  artifactName: string;
  bytes: Uint8Array;
  expectedSha256: string;
}): any;

export function buildF1Case(
  recordsByName: Record<string, any>,
  metadata: { namespace: string; createdAt: string },
): any;

export function projectF1BrowserSafe(revision: any, policyVersion?: string): any;
export function serializeF1CaseRevision(revision: any): string;
