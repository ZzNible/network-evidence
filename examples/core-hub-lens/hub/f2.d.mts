export const TARGET_CORE_MUTATIONS: 0;
export const F2_ADAPTER_VERSION: string;
export const F2_POLICY_VERSION: string;
export const F2_CASE_ID: string;
export const F2_REFERENCE: string;
export const F2_REFERENCE_SHA256: string;
export const F2_SUPPORTED_LABEL: string;

export function parseF2Reference(input: {
  artifactName: string;
  bytes: Uint8Array;
  expectedSha256: string;
}): any;

export function buildF2Case(
  reference: any,
  metadata: { namespace: string; createdAt: string },
  selector: { userOpHash?: string; sender?: string },
): any;

export function projectF2BrowserSafe(revision: any, policyVersion?: string): any;
export function serializeF2CaseRevision(revision: any): string;
