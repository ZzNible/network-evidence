/**
 * Anti-drift guard for the served live Discovery bounds (NE-L030 D-4, D-5/N-4)
 * stated in packages/mcp/README.md (Reads and Deadline bullets) and in
 * docs/distribution/CLOUD_RUN_FREE_PREVIEW_RUNBOOK.md §12. The per-read timeout
 * sums are derived from the exported constants and the allowed distinct-profile
 * mixes; they are arithmetic upper bounds, not observations.
 *
 * No provider, network or Cloud Run state is read: only repository text.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LIVE_BEFORE_MAX_CANDIDATES } from "../src/live-before.js";
import { LIVE_EVM_RPC_TIMEOUT_MS } from "../src/live-evm.js";
import { LIVE_MULTICHAIN_NETWORK_IDS, LIVE_TOOL_DEADLINE_MS } from "../src/live-multichain.js";
import { SOLANA_READ_TIMEOUT_MS } from "../src/live-solana.js";

const REPO_ROOT = new URL("../../../", import.meta.url);
const repoText = (path: string): string => readFileSync(new URL(path, REPO_ROOT), "utf8");
const README = repoText("packages/mcp/README.md");
const RUNBOOK = repoText("docs/distribution/CLOUD_RUN_FREE_PREVIEW_RUNBOOK.md");
const LIVE_BEFORE_LINES = repoText("packages/mcp/src/live-before.ts").split("\n");

/** At most 4 sequential provider reads per resolved subject (resolver-evm/src/acquire.ts, resolver-solana/src/acquire.ts). */
const READS_PER_SUBJECT = 4;
/** Pinned three-candidate call (live-before-three-candidates.test.ts ONE_CALL_READS): reads per subject. */
const PINNED_READS = [
  { networkId: "eip155:8453", reads: 4 },
  { networkId: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", reads: 4 },
  { networkId: "eip155:84532", reads: 3 },
] as const;

type Family = "evm" | "solana";
const family = (networkId: string): Family => {
  if (networkId.startsWith("eip155:")) return "evm";
  if (networkId.startsWith("solana:")) return "solana";
  throw new Error(`unexpected live network ${networkId}`);
};
const READ_TIMEOUT_MS: Record<Family, number> = { evm: LIVE_EVM_RPC_TIMEOUT_MS, solana: SOLANA_READ_TIMEOUT_MS };
const seconds = (ms: number): string => `${ms / 1000} s`;

/** Every allowed Discovery subject set: 1..LIVE_BEFORE_MAX_CANDIDATES distinct fixed profiles. */
function allowedMixes(): string[][] {
  const ids = [...LIVE_MULTICHAIN_NETWORK_IDS];
  const mixes: string[][] = [];
  for (let mask = 1; mask < 1 << ids.length; mask++) {
    const mix = ids.filter((_, i) => (mask & (1 << i)) !== 0);
    if (mix.length <= LIVE_BEFORE_MAX_CANDIDATES) mixes.push(mix);
  }
  return mixes;
}
const mixSumMs = (mix: readonly string[]): number =>
  mix.reduce((total, id) => total + READS_PER_SUBJECT * READ_TIMEOUT_MS[family(id)], 0);

/** One markdown bullet, from its first line up to the next bullet, heading or blank line, whitespace-normalised. */
function bullet(text: string, start: string): string {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => line.startsWith(start));
  expect(at, start).toBeGreaterThanOrEqual(0);
  expect(lines.filter((line) => line.startsWith(start)), start).toHaveLength(1);
  const body = [lines[at]!];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() === "" || /^\s*- /.test(line) || line.startsWith("#")) break;
    body.push(line);
  }
  return body.join(" ").replace(/\s+/g, " ");
}

describe("live Discovery bounds in the README and runbook equal the exported constants", () => {
  const mixes = allowedMixes();
  const worstMs = Math.max(...mixes.map(mixSumMs));
  const worstMixes = mixes.filter((mix) => mixSumMs(mix) === worstMs);
  const pinnedMs = PINNED_READS.reduce((total, s) => total + s.reads * READ_TIMEOUT_MS[family(s.networkId)], 0);
  const pinnedReads = PINNED_READS.reduce((total, s) => total + s.reads, 0);

  it("derives the pinned 11-read sum (74 s) and the worst allowed 12-read sum (88 s, 1 EVM + 2 Solana)", () => {
    expect(LIVE_BEFORE_MAX_CANDIDATES).toBe(3);
    expect(PINNED_READS.length).toBe(LIVE_BEFORE_MAX_CANDIDATES);
    expect(pinnedReads).toBe(11);
    expect(pinnedMs).toBe(74_000);
    expect(worstMs).toBe(88_000);
    expect(worstMixes.length).toBeGreaterThan(0);
    for (const mix of worstMixes) {
      expect(mix).toHaveLength(LIVE_BEFORE_MAX_CANDIDATES);
      expect(mix.filter((id) => family(id) === "evm"), mix.join()).toHaveLength(1);
      expect(mix.filter((id) => family(id) === "solana"), mix.join()).toHaveLength(2);
    }
    // The shared whole-call deadline binds before either per-read sum.
    expect(LIVE_TOOL_DEADLINE_MS).toBeLessThan(pinnedMs);
    expect(LIVE_TOOL_DEADLINE_MS).toBeLessThan(worstMs);
  });

  it("README Reads and Deadline bullets state those bounds and LIVE_TOOL_DEADLINE_MS", () => {
    const reads = bullet(README, "- **Reads:**");
    expect(reads).toContain(`at most ${READS_PER_SUBJECT} provider reads per subject, ${READS_PER_SUBJECT * LIVE_BEFORE_MAX_CANDIDATES} per call`);
    expect(reads).toContain(`The pinned case reads ${pinnedReads}`);

    const deadline = bullet(README, "- **Deadline:**");
    const worstMix = worstMixes[0]!;
    const evm = worstMix.filter((id) => family(id) === "evm").length;
    const solana = worstMix.filter((id) => family(id) === "solana").length;
    for (const part of [
      `${seconds(LIVE_TOOL_DEADLINE_MS)} whole-call deadline is shared by all subjects`,
      `(${seconds(LIVE_EVM_RPC_TIMEOUT_MS)} EVM, ${seconds(SOLANA_READ_TIMEOUT_MS)} Solana) sum to more`,
      `${seconds(pinnedMs)} for the pinned ${pinnedReads} reads`,
      `${seconds(worstMs)} for the worst allowed ${READS_PER_SUBJECT * LIVE_BEFORE_MAX_CANDIDATES}`,
      `(${evm} EVM + ${solana} Solana)`,
      "`MCP_LIVE_DEADLINE_EXCEEDED` and no partial result",
    ]) expect(deadline, part).toContain(part);
    expect(deadline).not.toContain("80 s");
  });

  it("runbook §12 Discovery subject cap equals LIVE_BEFORE_MAX_CANDIDATES, with anchors that resolve", () => {
    expect(RUNBOOK).not.toContain("up to 2 subjects");
    const caps = [...RUNBOOK.matchAll(/`discover_live_network_evidence`: up to (\d+) subjects/g)];
    expect(caps).toHaveLength(1);
    expect(Number(caps[0]![1])).toBe(LIVE_BEFORE_MAX_CANDIDATES);

    const cap = bullet(RUNBOOK, "  - `discover_live_network_evidence`: up to");
    expect(cap).toContain("(`LIVE_BEFORE_MAX_CANDIDATES`, `mcp/src/live-before.ts:25,137`)");
    expect(cap).toContain("not a new Cloud Run observation");
    expect(cap).toContain(`at most ${seconds(worstMs)}`);
    expect(LIVE_BEFORE_LINES[25 - 1]).toContain("export const LIVE_BEFORE_MAX_CANDIDATES = ");
    expect(LIVE_BEFORE_LINES[137 - 1]).toContain("input.subjects.length > LIVE_BEFORE_MAX_CANDIDATES");
    expect(cap).toContain("one after another (`mcp/src/live-before.ts:160-163`)");
    expect(LIVE_BEFORE_LINES[160 - 1]).toContain("for (const subject of subjects)");
    expect(LIVE_BEFORE_LINES[163 - 1]).toContain("await resolve({ subject, call })");

    const shared = bullet(RUNBOOK, "- **Whole-call deadline (source update NE-L014, not deployed).**");
    expect(shared).toContain("shares it across every subject (`mcp/src/live-before.ts:159`)");
    expect(shared).not.toContain("both subjects");
    expect(LIVE_BEFORE_LINES[159 - 1]).toContain("startLiveCall(resolve, signal)");
  });
});
