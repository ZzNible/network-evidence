/**
 * Anti-drift guard for docs/release/DEPENDENCY_ADVISORIES.md.
 *
 * The doc may report npm audit results only as dated, exact-SHA-bound
 * observations, including the unpublished local November 8 snapshot.
 * Current-tree documentation does not claim a result for a later commit.
 * Release authorization is separate from dependency auditing. The
 * lockfile versions and declared dependencies are still checked.
 *
 * Offline: reads repo files only; runs no npm command and makes no network call.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const REPO_ROOT = new URL("../../../", import.meta.url);
const DOC_PATH = "docs/release/DEPENDENCY_ADVISORIES.md";
const DOC_URL = new URL(DOC_PATH, REPO_ROOT);

const repoText = (path: string): string => readFileSync(new URL(path, REPO_ROOT), "utf8");
const repoJson = (path: string): any => JSON.parse(repoText(path)) as unknown;

const DOC = repoText(DOC_PATH);
const LINES = DOC.split("\n");

/** Exactly the dated source SHAs with recorded audit results. */
const OBSERVED_SHAS = [
  "64b412d01bd12c1a87c93699a4fbc9ee64e61967",
  "ed5273b2e28cf7438dcdade0a2d48a08ffa7f9ef",
  "b265008d685ca45ddfa48d2eb41528ef2fbdb160",
] as const;
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/;

const CURRENT_TREE_HEADING = "## Current tree (no audit result claimed)";

/** A line that reports a zero-vulnerability audit result. */
const ZERO_RESULT_PATTERNS: readonly RegExp[] = [
  /exited with code 0\b/i,
  /^\s*(?:critical|high|moderate|low|info|total)\s+0\s*$/i,
  /zero vulnerab/i,
  /\b0 vulnerabilit/i,
  /\bno vulnerabilit/i,
  /\bzero (?:advisor|vulnerable)/i,
];

/** A line that claims any `npm audit` result count. */
const AUDIT_COUNT_PATTERNS: readonly RegExp[] = [
  ...ZERO_RESULT_PATTERNS,
  /\b(?:critical|high|moderate|low|info|total)\s+\d+\b/i,
  /\b\d+\s+(?:vulnerab|advisor)/i,
  /\bfound \d+/i,
  /vulnerable package entries/i,
  /dependencies audited/i,
  /exited with code \d/i,
];

/** Index of the governing heading ("# " title or nearest preceding "## ") for each line. */
function headingOf(lineIndex: number): string {
  for (let i = lineIndex; i >= 0; i -= 1) {
    const line = LINES[i]!;
    if (line.startsWith("## ") || line.startsWith("# ")) return line;
  }
  return "";
}

/** Body lines of the "## " section whose heading equals `heading` exactly. */
function sectionLines(heading: string): string[] {
  const start = LINES.indexOf(heading);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  expect(LINES.filter((line) => line === heading), heading).toHaveLength(1);
  let end = LINES.length;
  for (let i = start + 1; i < LINES.length; i += 1) {
    if (LINES[i]!.startsWith("## ") || LINES[i]!.startsWith("# ")) {
      end = i;
      break;
    }
  }
  return LINES.slice(start + 1, end);
}

/** GitHub-style heading slug: lower-case, drop punctuation/symbols, spaces to hyphens. */
function slug(heading: string): string {
  return heading.replace(/^#+\s*/, "").trim().toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
}

describe("DEPENDENCY_ADVISORIES.md: audit results are dated, SHA-bound observations", () => {
  it("binds every zero-vulnerability statement to an ISO date and an exact observed SHA in its heading", () => {
    const zeroLines = LINES.map((line, index) => ({ line, index }))
      .filter(({ line }) => ZERO_RESULT_PATTERNS.some((re) => re.test(line)));
    expect(zeroLines.length).toBeGreaterThan(0);
    for (const { line, index } of zeroLines) {
      const heading = headingOf(index);
      const where = `line ${index + 1}: ${line} (heading: ${heading})`;
      expect(heading.startsWith("## "), where).toBe(true);
      expect(ISO_DATE.test(heading), where).toBe(true);
      expect(OBSERVED_SHAS.some((sha) => heading.includes(sha)), where).toBe(true);
    }
  });

  it("each observed SHA has exactly one dated observation section", () => {
    for (const sha of OBSERVED_SHAS) {
      const headings = LINES.filter((line) => line.startsWith("## ") && line.includes(sha));
      expect(headings, sha).toHaveLength(1);
      expect(ISO_DATE.test(headings[0]!), sha).toBe(true);
    }
  });

  it("the unscoped present-tense zero-vulnerability sentence is gone", () => {
    expect(DOC).not.toContain("npm audit reports zero vulnerable package entries");
    expect(DOC).not.toMatch(/reports zero vulnerab/i);
  });
});

describe("DEPENDENCY_ADVISORIES.md: current-tree section", () => {
  it("claims no npm audit result count", () => {
    const section = sectionLines(CURRENT_TREE_HEADING);
    expect(section.length).toBeGreaterThan(0);
    for (const line of section) {
      for (const re of AUDIT_COUNT_PATTERNS) expect(line, `${re}`).not.toMatch(re);
    }
    expect(CURRENT_TREE_HEADING).not.toMatch(ISO_DATE);
    for (const sha of OBSERVED_SHAS) expect(section.join("\n")).not.toContain(sha);
  });

  it("does not present a dated historical observation as current release approval", () => {
    const section = sectionLines(CURRENT_TREE_HEADING).join(" ");
    expect(section).toContain("exact historical commits");
    expect(section).toContain("final release source");
    expect(section).toContain("Release approval is a separate owner decision");
    expect(section).not.toMatch(/\b(?:lane commit|approval draft)\b/i);
  });

});

describe("DEPENDENCY_ADVISORIES.md: disposition-neutral, no advisory discussion", () => {
  it("names no advisory ID", () => {
    expect(DOC).not.toMatch(/GHSA-/i);
    expect(DOC).not.toMatch(/CVE-/i);
  });

  it("makes no exploitability/impact analysis and no fixed/accepted/irrelevant disposition", () => {
    const forbidden: readonly RegExp[] = [
      /exploitab/i,
      /\bimpact/i,
      /\bfixed\b/i,
      /\bremediated\b/i,
      /\bresolved\b/i,
      /\bmitigat/i,
      /\baccepted\b/i,
      /\baccept(?:s|ing)? the risk/i,
      /\binherited\b/i,
      /\birrelevant\b/i,
      /not affected/i,
      /false positive/i,
      /\bunreachable\b/i,
      /not reachable/i,
      /\bharmless\b/i,
      /\bsafe\b/i,
    ];
    for (const re of forbidden) expect(DOC, `${re}`).not.toMatch(re);
  });
});

describe("DEPENDENCY_ADVISORIES.md: named versions match the lockfile and manifests", () => {
  const lock = repoJson("package-lock.json") as { packages: Record<string, { version?: string }> };
  const rootPkg = repoJson("package.json") as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  it("every 'locked at' version equals node_modules/<name> in package-lock.json", () => {
    const locked = LINES.filter((line) => line.includes("locked at `")).map((line) => {
      const name = line.match(/`([^`]+)`/)![1]!;
      const version = line.match(/locked at `([^`]+)`/)![1]!;
      const declared = line.match(/declared `([^`]+)`/)?.[1];
      return { line, name, version, declared };
    });
    expect(locked.map((entry) => entry.name).sort()).toEqual(["@hono/node-server", "hono", "source-map-js", "vite", "vitest", "zod"]);
    const currentTree = sectionLines(CURRENT_TREE_HEADING);
    for (const bullet of [
      "- `zod` is locked at `4.6.7`;",
      "- `@hono/node-server` is locked at `2.1.6`;",
      "- `hono` is locked at `4.13.13`;",
    ]) expect(currentTree.filter((line) => line === bullet), bullet).toHaveLength(1);
    for (const { line, name, version, declared } of locked) {
      expect(lock.packages[`node_modules/${name}`]?.version, line).toBe(version);
      if (declared !== undefined) {
        expect(line, line).toMatch(/^- root `/);
        const range = rootPkg.devDependencies?.[name] ?? rootPkg.dependencies?.[name];
        expect(range, line).toBe(declared);
      }
    }
  });

  it("tinypool is absent from package-lock.json if the doc says so", () => {
    const claimsAbsent = /`tinypool` package is not present in the lockfile/.test(DOC);
    if (claimsAbsent) {
      const keys = Object.keys(lock.packages).filter((key) => key === "node_modules/tinypool" || key.endsWith("/node_modules/tinypool"));
      expect(keys).toEqual([]);
      expect(repoText("package-lock.json")).not.toContain("tinypool");
    }
  });

  it("the runtime-dependency list equals the third-party dependencies of the workspace manifests", () => {
    const lead = LINES.findIndex((line) => line.startsWith("Third-party runtime dependencies declared in the `dependencies` of the workspace package manifests"));
    expect(lead).toBeGreaterThanOrEqual(0);
    expect(LINES[lead]).toContain("the root `package.json` declares none");
    const named: string[] = [];
    let i = lead + 1;
    while (i < LINES.length && LINES[i]!.trim() === "") i += 1;
    for (; i < LINES.length; i += 1) {
      const bullet = LINES[i]!.match(/^- `([^`]+)`$/);
      if (bullet === null) break;
      named.push(bullet[1]!);
    }

    const packagesDir = new URL("packages/", REPO_ROOT);
    const manifests = readdirSync(packagesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `packages/${entry.name}/package.json`)
      .filter((path) => existsSync(new URL(path, REPO_ROOT)));
    expect(manifests.length).toBeGreaterThan(0);
    const thirdParty = new Set<string>();
    for (const path of manifests) {
      const manifest = repoJson(path) as { private?: unknown; dependencies?: Record<string, string> };
      expect(manifest.private, path).toBe(true);
      for (const dep of Object.keys(manifest.dependencies ?? {})) {
        if (!dep.startsWith("@nec/")) thirdParty.add(dep);
      }
    }
    expect(rootPkg.dependencies).toBeUndefined();
    expect(named.length).toBeGreaterThan(0);
    expect([...named].sort()).toEqual([...thirdParty].sort());
    expect(new Set(named).size).toBe(named.length);
    expect(DOC).toContain("All workspace package manifests are `\"private\": true`.");
  });
});

describe("README.md: the DEPENDENCY_ADVISORIES.md pointer claims no current-tree audit result", () => {
  it("the README bullet linking the doc has no '0 vulnerabilities' wording and states that no current-tree result is claimed", () => {
    const readme = repoText("README.md").split("\n");
    const linkLine = `- [${DOC_PATH}](${DOC_PATH})`;
    const at = readme.map((line, index) => ({ line, index }))
      .filter(({ line }) => line.includes(`](${DOC_PATH})`));
    expect(at).toHaveLength(1);
    expect(at[0]!.line.startsWith(linkLine)).toBe(true);
    // The bullet is the link line plus its indented continuation lines.
    const item = [at[0]!.line];
    for (let i = at[0]!.index + 1; i < readme.length && /^\s+\S/.test(readme[i]!); i += 1) item.push(readme[i]!);
    const text = item.join(" ").replace(/\s+/g, " ");
    expect(text).not.toMatch(/\b0 vulnerabilit/i);
    for (const re of ZERO_RESULT_PATTERNS) expect(text, `${re}`).not.toMatch(re);
    expect(text).not.toMatch(/remediat/i);
    expect(text).toContain("dated, commit-bound `npm audit` observations");
    expect(text).toContain("no `npm audit` result is claimed for the current tree");
  });
});
