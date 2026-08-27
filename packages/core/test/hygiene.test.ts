import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Purity hygiene: core evaluators must not touch the clock, randomness,
 * network, filesystem, or environment. This test scans every source file
 * for forbidden runtime surfaces. (node:crypto and node:fs usage here is
 * in the TEST process, not in src.)
 */
describe("core purity", () => {
  const files = [
    "canonical-json.ts",
    "digest.ts",
    "digests.ts",
    "ordering.ts",
    "limits.ts",
    "types.ts",
    "errors.ts",
    "validate.ts",
    "applicability.ts",
    "verdict.ts",
    "conflict.ts",
    "capabilities.ts",
    "discovery.ts",
    "preflight.ts",
    "native.ts",
    "result.ts",
    "wire.ts",
    "internal.ts",
    "index.ts",
  ];

  const forbidden: Array<[RegExp, string]> = [
    [/\bDate\.now\b/, "clock access (Date.now)"],
    [/\bnew Date\s*\(/, "clock access (new Date)"],
    [/\bMath\.random\b/, "randomness (Math.random)"],
    [/\bcrypto\.randomUUID\b/, "randomness (crypto.randomUUID)"],
    [/\bfetch\s*\(/, "network access (fetch)"],
    [/\brequire\s*\(/, "CJS require"],
    [/\bprocess\.env\b/, "environment access"],
    [/node:(fs|http|https|net|dns|tls)\b/, "filesystem/network modules"],
  ];

  for (const file of files) {
    it(`has no I/O or nondeterminism surface in ${file}`, () => {
      const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
      for (const [pattern, label] of forbidden) {
        expect(source, `${file} contains ${label}`).not.toMatch(pattern);
      }
    });
  }

  it("documents the semantic/artifact digest split as declared profile decisions", () => {
    const digests = readFileSync(new URL("../src/digests.ts", import.meta.url), "utf8");
    expect(digests).toMatch(/semanticDigest/);
    expect(digests).toMatch(/artifactDigest/);
    expect(digests).toMatch(/EXCLUDES/);
    expect(readFileSync(new URL("../src/result.ts", import.meta.url), "utf8")).toMatch(
      /semanticDigest/,
    );
  });
});
