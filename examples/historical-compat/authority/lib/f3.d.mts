export const TARGET_CORE_MUTATIONS: 0;
export const F3_ADAPTER_VERSION: string;
export const F3_POLICY_VERSION: string;
export const F3_CASE_ID: string;
export const F3_REFERENCE: string;
export const F3_REFERENCE_SHA256: string;
export const F3_PAYMENT_LABEL: string;

export function parseF3Reference(input: {
  artifactName: string;
  bytes: Uint8Array;
  expectedSha256: string;
}): any;

export function buildF3Case(reference: any, metadata: { namespace: string; createdAt: string }): any;

export function projectF3BrowserSafe(revision: any, policyVersion?: string): any;
export function serializeF3CaseRevision(revision: any): string;
