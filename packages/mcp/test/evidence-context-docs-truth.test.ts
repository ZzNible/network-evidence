/**
 * NE-L041 anti-drift guard: evidenceContext documentation truthfulness
 * (NE-L038 findings F1-F4) in packages/mcp/README.md and the public
 * public source contract docs/distribution/MCP_PUBLIC_CONTRACT.md.
 *
 *  F1  the preflight-before-block check compares a caller-authorable
 *      preflight.generatedAt with the source-reported block timestamp; it is
 *      not a server-clock check and establishes no provenance.
 *  F2  output_budget applies without a concurrent claim; with a claim an
 *      over-cap assembled envelope is refused whole (MCP_MULTICHAIN_TOO_LARGE).
 *  F3  a refused context takes no live RPC admission and no provider read, but
 *      is still charged one HTTP /mcp admission.
 *  F4  draft §6 states what of the context is (not) forwarded, echoed, logged.
 *
 * It also pins every packages/mcp/README.md line range cited by a test file
 * or the draft, so the doc edits cannot silently move a cited line.
 * Repository text only: no provider, network or server is used.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = new URL("../../../", import.meta.url);
const ROOT_PATH = fileURLToPath(REPO_ROOT);
const repoText = (path: string): string => readFileSync(new URL(path, REPO_ROOT), "utf8");
const README = repoText("packages/mcp/README.md");
const README_LINES = README.split("\n");
const DRAFT = repoText("docs/distribution/MCP_PUBLIC_CONTRACT.md");
const DRAFT_LINES = DRAFT.split("\n");

/** Text from a heading line up to the next `## ` heading. */
function sectionFrom(text: string, heading: string): string {
  const start = text.indexOf(heading);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  expect(text.indexOf(heading, start + 1), heading).toBe(-1);
  const end = text.indexOf("\n## ", start + heading.length);
  return end === -1 ? text.slice(start) : text.slice(start, end);
}

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

const EVIDENCE_CONTEXT_SECTION = sectionFrom(README, "## Hosted AFTER with an optional `evidenceContext`");
const DRAFT_S1 = sectionFrom(DRAFT, "## 1. Status and non-claims");
const DRAFT_S6 = sectionFrom(DRAFT, "## 6. Privacy-notice delta");

/** README lines that test files or the draft cite by number; their text must not move. */
const PINNED_README_RANGES: Readonly<Record<string, readonly string[]>> = {
  // Cited by distribution-draft.test.ts and draft §5 (Discovery budget bullets).
  "486-503": [
    "- **Admissions:** each subject takes one shared admission",
    "  (`MULTICHAIN_CALLS_PER_MINUTE` 8 per minute, 2 in flight, never refunded),",
    "  and each Base subject also takes one inner EVM admission (8 per minute). Two",
    "  three-subject calls fit in one window. The budget is checked per subject and",
    "  not reserved up front, so a third call reads its first two subjects and then",
    "  fails `MCP_MULTICHAIN_RATE_LIMIT` with no result.",
    "- **Reads:** at most 4 provider reads per subject, 12 per call. The pinned case",
    "  reads 11 (3 for the absent probe).",
    "- **Deadline:** one 35 s whole-call deadline is shared by all subjects. Per-read bounds (6 s",
    "  EVM, 8 s Solana) sum to more: 74 s for the pinned 11 reads, 88 s for the worst allowed 12",
    "  (1 EVM + 2 Solana). A stalled call ends with `MCP_LIVE_DEADLINE_EXCEEDED` and no partial result.",
    "- **Source failures:** a failed source for any subject fails the whole call",
    "  (`MCP_LIVE_BEFORE_UNAVAILABLE`). This includes foreign chain-id bytes and",
    "  provider HTTP 503/429. A provider 429 is never this server's rate-limit code.",
    "- **HTTP ingress:** one call is one HTTP `/mcp` admission, whatever the subject",
    "  count. Ingress 429 (rate/concurrency), 413 (body over the 1 MiB default) and",
    "  408 (5 s body read) are unchanged. The output stays under",
    "  `LIVE_BEFORE_MAX_OUTPUT_BYTES` (180,000).",
  ],
  // Cited by evidence-context-economics.test.ts as the place the F2 exception qualifies.
  "560-561": [
    "- **Budget:** no extra RPC read, admission or quota. A composed result that",
    "  would not fit becomes `not_composed`/`output_budget`. The final assembled",
  ],
};

const README_CITATION = /packages\/mcp\/README\.md:(\d+)(?:-(\d+))?/g;

/** Every *.test.ts under packages/ and examples/, skipping node_modules and dot directories. */
function testFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...testFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) found.push(path);
  }
  return found;
}

/**
 * NE-L046 completeness rule, pure in (§1 lines, file set): the members of
 * `files` that no §1 line containing SIMULATED_REPLAY_CLOCK names in backticks.
 */
function unnamedSimulatedFiles(s1Lines: readonly string[], files: readonly string[]): string[] {
  const simulated = s1Lines.filter((line) => line.includes("SIMULATED_REPLAY_CLOCK"));
  return files.filter((file) => !simulated.some((line) => line.includes(`\`${file}\``)));
}

/** Files excluded from the completeness set: they only guard the draft's wording. */
const SIMULATED_SCAN_EXCLUDED = ["packages/mcp/test/evidence-context-docs-truth.test.ts", "packages/mcp/test/distribution-draft.test.ts"];

/** S: every *.test.ts under packages/**\/test and examples/**\/test containing SIMULATED_REPLAY_CLOCK, minus the exclusions (repo-relative, sorted). */
function simulatedReplayTestFiles(): string[] {
  return [...testFiles(join(ROOT_PATH, "packages")), ...testFiles(join(ROOT_PATH, "examples"))]
    .map((file) => relative(ROOT_PATH, file).split(sep).join("/"))
    .filter((file) => file.split("/").slice(0, -1).includes("test"))
    .filter((file) => !SIMULATED_SCAN_EXCLUDED.includes(file))
    .filter((file) => repoText(file).includes("SIMULATED_REPLAY_CLOCK"))
    .sort();
}

/** The six SIMULATED_REPLAY_CLOCK test files the NE-L046 §1 line names (not on the NE-P3 line). */
const NE_L046_SIMULATED_FILES = [
  "packages/mcp/test/evidence-context-economics.test.ts",
  "examples/hosted-reproduction/test/verify-evidence-result.test.ts",
  "examples/hosted-reproduction/test/capture-action.test.ts",
  "examples/hosted-reproduction/test/build-action-case.test.ts",
  "examples/hosted-reproduction/test/verify-action-preflight.test.ts",
  "examples/hosted-reproduction/test/action-chain-solana.test.ts",
];

describe("evidenceContext docs stay truthful (NE-L038 F1-F4)", () => {
  it("F1: the README evidenceContext section names the exact comparison and no server-clock provenance", () => {
    expect(EVIDENCE_CONTEXT_SECTION).not.toContain("server-clock");
    expect(EVIDENCE_CONTEXT_SECTION).not.toMatch(/server[- ]clock/i);
    const nonClaims = bullet(EVIDENCE_CONTEXT_SECTION, "- **Non-claims:**");
    for (const part of [
      "preflight continuity is not precedence",
      "The composer compares `preflight.generatedAt`, which is caller-authorable unless it came from the hosted `preflight_live_network_evidence` tool, with the source-reported block timestamp.",
      "An earlier value is a necessary rejection check only; its provenance is not established, and it is not proof that the action or policy existed before execution.",
      "an authentic AFTER is never recast as a BEFORE",
    ]) expect(nonClaims, part).toContain(part);
  });

  it("F3: a refused context takes no live RPC admission and no provider read but one HTTP /mcp admission (README and draft §5)", () => {
    expect(README).not.toContain("takes no budget");
    expect(README).not.toContain("no budget for refused contexts");
    const validated = bullet(EVIDENCE_CONTEXT_SECTION, "- **Validated before any read:**");
    for (const part of [
      "A refused context makes no provider read (row F18)",
      "takes no live RPC admission of `MULTICHAIN_CALLS_PER_MINUTE`",
      "like any parsed request it is charged one HTTP `/mcp` admission",
    ]) expect(validated, part).toContain(part);

    const draftBullet = DRAFT_LINES.filter((line) => line.startsWith("- `EVIDENCE_CONTEXT_MAX_BYTES`: "));
    expect(draftBullet).toHaveLength(1);
    expect(draftBullet[0]).not.toContain("budget charge");
    for (const part of [
      "refused with `MCP_EVIDENCE_CONTEXT_TOO_LARGE` before any RPC read",
      "A refused context takes no live RPC admission (`MULTICHAIN_CALLS_PER_MINUTE`) and no provider read",
      "like any parsed request it is charged one HTTP `/mcp` admission (`packages/mcp/src/http.ts:271`)",
    ]) expect(draftBullet[0], part).toContain(part);

    // The cited source lines still hold what the bullet says.
    const http = repoText("packages/mcp/src/http.ts").split("\n");
    expect(http[271 - 1]).toContain("admission.charge()");
    const liveResult = repoText("packages/mcp/src/live-result.ts").split("\n");
    expect(liveResult[38 - 1]).toContain("export const EVIDENCE_CONTEXT_MAX_BYTES");
    expect(liveResult[200 - 1]).toContain("> EVIDENCE_CONTEXT_MAX_BYTES");
  });

  it("F2: the README Budget bullet limits output_budget to calls without a concurrent claim", () => {
    const budget = bullet(EVIDENCE_CONTEXT_SECTION, "- **Budget:**");
    for (const part of [
      "The `output_budget` fallback applies without a concurrent `claim`.",
      "With a `claim`, the composer's own check (`src/live-result.ts`) measures the envelope without `claimAssessment`",
      "an over-cap assembled envelope that passed that check is refused whole with `MCP_MULTICHAIN_TOO_LARGE` and nothing is returned, not `output_budget`",
      "`test/evidence-context-economics.test.ts`",
      "never truncated",
    ]) expect(budget, part).toContain(part);
    // The code paths the bullet describes: the composer measures without the claim, the claim path refuses whole.
    expect(repoText("packages/mcp/src/live-result.ts"))
      .toContain("Buffer.byteLength(JSON.stringify({ ...observation, evidenceResult: composed })) > MULTICHAIN_RESULT_MAX_BYTES");
    expect(repoText("packages/mcp/src/live-claim.ts")).toContain('throw new NeMcpError("MCP_MULTICHAIN_TOO_LARGE"');
    expect(existsSync(new URL("packages/mcp/test/evidence-context-economics.test.ts", REPO_ROOT))).toBe(true);
  });

  it("F4: public contract §6 has one evidenceContext bullet (not forwarded, echoed fields, not echoed, not logged); the notice revision is scoped", () => {
    const bullets = DRAFT_S6.split("\n").filter((line) => line.startsWith("- **`evidenceContext`"));
    expect(bullets).toHaveLength(1);
    for (const part of [
      "is never sent to the RPC providers",
      "The served `evidenceResult` echoes the `requestId`, the request digest, the complete expected action and the policy id, version and digest.",
      "It does not echo the `account`, the request or preflight `metadata`, or the content of the supplied preflight or capability snapshot.",
      "Nothing of the context is logged.",
      "`MCP_PRIVACY_POLICY.md` was updated for source/deployment scope; actual hosted revision privacy and retention still require revalidation.",
    ]) expect(bullets[0], part).toContain(part);
    expect(DRAFT_S6).toContain("`MCP_PRIVACY_POLICY.md` was updated on 2026-11-08");
    // The notice sentence the bullet relies on is still there (read only).
    const notice = repoText("docs/distribution/MCP_PRIVACY_POLICY.md").split("\n");
    const sensitiveContextBoundary = notice.filter((line) => line.includes("a caller-originated complete Core request and policy"));
    expect(sensitiveContextBoundary).toHaveLength(1);
    expect(sensitiveContextBoundary[0]).toContain("are not sent to these providers");
  });

  it("draft §1 SIMULATED_REPLAY_CLOCK sentence names the two NE-P3 test files and the NE-L003 SIMULATED label", () => {
    const lines = DRAFT_S1.split("\n").filter((line) => line.includes("SIMULATED_REPLAY_CLOCK"));
    // NE-L046: exactly two §1 lines (the NE-P3 line first, then the operator-tooling line).
    expect(lines).toHaveLength(2);
    expect(lines[0]).not.toContain("Every BEFORE in the offline `evidenceContext` tests is");
    for (const file of ["packages/mcp/test/live-result-tool.test.ts", "examples/ne-maps/test/live-result-case-flow.test.ts"]) {
      expect(lines[0], file).toContain(`\`${file}\``);
      expect(repoText(file), file).toContain("SIMULATED_REPLAY_CLOCK");
    }
    expect(lines[0]).toContain("the two NE-P3 offline `evidenceContext` tests");
    expect(lines[0]).toContain("`packages/mcp/test/live-result.test.ts`");
    expect(lines[0]).toContain("labels its Solana probe SIMULATED");
    expect(repoText("packages/mcp/test/live-result.test.ts")).toContain("probe is SIMULATED");
    expect(lines[0]).toContain("GT-02 stays OPEN");
  });

  it("NE-L046: the second §1 SIMULATED_REPLAY_CLOCK line names the six other files, TEST-AUTHORED, the Solana null probe and GT-02 OPEN", () => {
    const lines = DRAFT_S1.split("\n").filter((line) => line.includes("SIMULATED_REPLAY_CLOCK"));
    expect(lines).toHaveLength(2);
    const nep3 = lines.filter((line) => line.includes("the two NE-P3 offline `evidenceContext` tests"));
    expect(nep3).toHaveLength(1);
    const added = lines.filter((line) => line !== nep3[0]);
    expect(added).toHaveLength(1);
    const line = added[0]!;
    for (const part of [
      "SIMULATED_REPLAY_CLOCK", "fixedBeforeExecution:false", "TEST-AUTHORED", "GT-02 stays OPEN",
      "test-derived SIMULATED null probe", "a served Solana preflight appears only as a negative",
    ]) expect(line, part).toContain(part);
    for (const file of NE_L046_SIMULATED_FILES) expect(line, file).toContain(`\`${file}\``);
    // Every file the new line names exists and contains SIMULATED_REPLAY_CLOCK (new line only).
    const named = [...line.matchAll(/`([^`\s]+\.test\.ts)`/g)].map((match) => match[1]!);
    expect([...named].sort()).toEqual([...NE_L046_SIMULATED_FILES].sort());
    for (const file of named) {
      expect(existsSync(new URL(file, REPO_ROOT)), file).toBe(true);
      expect(repoText(file), file).toContain("SIMULATED_REPLAY_CLOCK");
    }
    expect(repoText("examples/hosted-reproduction/test/action-chain-solana.test.ts"))
      .toContain("A served Solana preflight is only ever a NEGATIVE");
  });

  it("NE-L046: every SIMULATED_REPLAY_CLOCK test file is named on a §1 SIMULATED_REPLAY_CLOCK line; a new unnamed file is reported", () => {
    const s1 = DRAFT_S1.split("\n");
    const files = simulatedReplayTestFiles();
    expect(files).toHaveLength(8);
    expect(files).toEqual([
      "examples/hosted-reproduction/test/action-chain-solana.test.ts",
      "examples/hosted-reproduction/test/build-action-case.test.ts",
      "examples/hosted-reproduction/test/capture-action.test.ts",
      "examples/hosted-reproduction/test/verify-action-preflight.test.ts",
      "examples/hosted-reproduction/test/verify-evidence-result.test.ts",
      "examples/ne-maps/test/live-result-case-flow.test.ts",
      "packages/mcp/test/evidence-context-economics.test.ts",
      "packages/mcp/test/live-result-tool.test.ts",
    ]);
    expect(unnamedSimulatedFiles(s1, files)).toEqual([]);
    // Negative: an added, unnamed file is reported as missing.
    const extra = "examples/hosted-reproduction/test/zz-new.test.ts";
    expect(unnamedSimulatedFiles(s1, [...files, extra])).toEqual([extra]);
    // A name only counts on a SIMULATED_REPLAY_CLOCK line.
    expect(unnamedSimulatedFiles([`- \`${extra}\``], [extra])).toEqual([extra]);
    expect(unnamedSimulatedFiles([`- SIMULATED_REPLAY_CLOCK \`${extra}\``], [extra])).toEqual([]);
  });

  it("every cited packages/mcp/README.md line range is pinned and its text is unchanged", () => {
    const cited = new Set<string>();
    const files = [...testFiles(join(ROOT_PATH, "packages")), ...testFiles(join(ROOT_PATH, "examples"))];
    // Non-vacuous: the two files known to cite README lines are among those scanned.
    for (const known of ["packages/mcp/test/distribution-draft.test.ts", "packages/mcp/test/evidence-context-economics.test.ts"]) {
      expect(files, known).toContain(join(ROOT_PATH, known));
    }
    const sources = files.map((file) => readFileSync(file, "utf8"));
    sources.push(DRAFT);
    for (const text of sources) {
      for (const match of text.matchAll(README_CITATION)) cited.add(match[2] === undefined ? match[1]! : `${match[1]}-${match[2]}`);
    }
    // A new citation must be pinned here before it can be relied on.
    expect([...cited].sort()).toEqual(Object.keys(PINNED_README_RANGES).sort());
    for (const [range, expected] of Object.entries(PINNED_README_RANGES)) {
      const [from, to] = range.split("-").map(Number) as [number, number];
      expect(to - from + 1, range).toBe(expected.length);
      expect(README_LINES.slice(from - 1, to).map((line) => line.trimEnd()), range).toEqual(expected);
    }
  });
});
