import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  evaluateTransactionAcquisition,
  replayTransactionAcquisition,
} from "@nec/resolver-evm";
import {
  assessErc4337UserOperation,
  ENTRY_POINT_PROFILES,
} from "@nec/adapter-erc4337";

import { buildDemoResult } from "../run.js";
import {
  F2_REFERENCE,
  F2_REFERENCE_SHA256,
  buildF2Case,
  parseF2Reference,
  projectF2BrowserSafe,
} from "../hub/f2.mjs";

const NETWORK = "eip155:84532";
const BUNDLE_TX = "0xde8916c81ef6a7b36ddf9f7b44d1ca096e4db4818eddfd5e16eda8a7c292ed45";
const USER_OP_HASH = "0x5f1e12031272034de5460796bd5cabe903a8ee6845fcab5fde18c4de632acfcf";
const SENDER = "0xfef5b40ab4c543137262253dbaf7843bd9b3e5b6";
const REPEATED_SENDER = "0x9272f8c4b4f26a79701dd2272f7e0c82fb3cded2";
const CREATED_AT = "2026-10-06T20:30:00.000Z";

async function evaluate(selector: { userOpHash?: string; sender?: string }) {
  const fixtureBytes = await readFile(new URL("../../../packages/adapter-erc4337/test/fixtures/base-sepolia-external-v06-userop.json", import.meta.url));
  const raw = JSON.parse(fixtureBytes.toString("utf8")) as unknown;
  const acquisition = await replayTransactionAcquisition(raw, { includeTransaction: true });
  const fragment = evaluateTransactionAcquisition(acquisition).fragment;
  const evaluation = assessErc4337UserOperation({
    network: NETWORK,
    bundleTransactionHash: BUNDLE_TX,
    entryPoint: ENTRY_POINT_PROFILES["v0.6"],
    entryPointProfile: "v0.6",
    userOperation: selector,
  }, fragment);

  const referenceBytes = await readFile(new URL("../fixtures/01-frozen-network-evidence-reference.json", import.meta.url));
  const reference = parseF2Reference({
    artifactName: F2_REFERENCE,
    bytes: referenceBytes,
    expectedSha256: F2_REFERENCE_SHA256,
  });
  const lens = projectF2BrowserSafe(buildF2Case(
    reference,
    { namespace: "network-evidence-public-demo-test", createdAt: CREATED_AT },
    selector,
  ));
  const lensAssessment = JSON.parse(JSON.stringify(lens.propositions))
    .find((proposition: { propositionId?: string }) => proposition.propositionId === "p-userop-execution")
    ?.assessments?.[0];

  return { core: evaluation.outcome.verdict, lens: lensAssessment?.value };
}

describe("Core -> Hub -> Lens public demo integration", () => {
  it("pins deterministic CLI output", async () => {
    const a = JSON.stringify(await buildDemoResult(), null, 2) + "\n";
    const b = JSON.stringify(await buildDemoResult(), null, 2) + "\n";
    expect(a).toBe(b);

    const expected = (await readFile(new URL("../EXPECTED_OUTPUT.sha256", import.meta.url), "utf8")).trim();
    expect(createHash("sha256").update(a).digest("hex")).toBe(expected);
  });

  it.each([
    ["supported", { userOpHash: USER_OP_HASH, sender: SENDER }, "supported"],
    ["insufficient", { userOpHash: "0x" + "00".repeat(32), sender: SENDER }, "insufficient"],
    ["contradicted", { userOpHash: USER_OP_HASH, sender: REPEATED_SENDER }, "contradicted"],
    ["ambiguous", { sender: REPEATED_SENDER }, "ambiguous"],
    ["sender-only unique", { sender: SENDER }, "supported"],
  ] as const)("%s runtime verdict matches Lens", async (_name, selector, expected) => {
    const result = await evaluate(selector);
    expect(result.core).toBe(expected);
    expect(result.lens).toBe(expected);
  });
});
