/**
 * Anti-drift guard for docs/distribution/MCP_PUBLIC_CONTRACT.md
 * (public source contract). Its machine-readable blocks and marked
 * tables must equal what the code serves and exports: tools/list of the hosted
 * live-mode server in both SDK eras, the active profile inventory, the
 * exported limits and the fixed CAPTURE_CALLS. Its wording is held to the
 * non-claim boundaries.
 *
 * No provider is reachable: the live tool's fetch and global fetch both throw
 * and are counted at zero.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { CAPTURE_CALLS, EXPECTED_OUTCOMES } from "../../../examples/hosted-reproduction/capture-hosted.js";
import { startNeMcpHttpServer } from "../src/http.js";
import { HOSTED_DEFAULT_LIMITS, MAX_REQUESTS_PER_MINUTE_CEILING } from "../src/limits.js";
import * as liveBefore from "../src/live-before.js";
import * as liveClaim from "../src/live-claim.js";
import * as liveEvm from "../src/live-evm.js";
import * as liveMultichain from "../src/live-multichain.js";
import { createMultichainTool } from "../src/live-multichain.js";
import * as livePreflight from "../src/live-preflight.js";
import * as liveResult from "../src/live-result.js";
import * as liveSolana from "../src/live-solana.js";
import { activeNetworkProfilesInventory } from "../src/profiles.js";
import { simulatedHostFetch } from "./helpers.js";

const REPO_ROOT = new URL("../../../", import.meta.url);
const repoText = (path: string): string => readFileSync(new URL(path, REPO_ROOT), "utf8");
const DOC = repoText("docs/distribution/MCP_PUBLIC_CONTRACT.md");
const LINES = DOC.split("\n");

const ORIGIN = "https://mcp.example.org";
const HOST = "mcp.example.org";

/** Exactly one ```json ne-distribution:<tag> block, parsed. */
function block(tag: string): unknown {
  const found = [...DOC.matchAll(new RegExp("^```json ne-distribution:" + tag + "\\n([\\s\\S]*?)\\n```$", "gm"))];
  expect(found, tag).toHaveLength(1);
  return JSON.parse(found[0]![1]!) as unknown;
}

/** Lines between `<!-- name:start -->` and `<!-- name:end -->`. */
function section(name: string): string[] {
  const start = LINES.indexOf(`<!-- ${name}:start -->`);
  const end = LINES.indexOf(`<!-- ${name}:end -->`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  expect(end, name).toBeGreaterThan(start);
  return LINES.slice(start + 1, end);
}

/** Body rows of the single markdown table in a marked section, as trimmed cells. */
function tableRows(name: string): string[][] {
  return section(name).filter((line) => line.startsWith("|")).slice(2)
    .map((line) => line.slice(1, -1).split("|").map((cell) => cell.trim()));
}

const profileRows = (profiles: readonly any[]) =>
  profiles.map((p) => ({ profileId: p.profileId, networkId: p.networkId, environment: p.environment, family: p.family }));

/** Every packages/mcp/src/live-*.ts module, by file name. */
const LIVE_MODULES: Readonly<Record<string, object>> = {
  "live-before.ts": liveBefore, "live-claim.ts": liveClaim, "live-evm.ts": liveEvm,
  "live-multichain.ts": liveMultichain, "live-preflight.ts": livePreflight, "live-result.ts": liveResult,
  "live-solana.ts": liveSolana,
};
const BOUND_NAME = /_(MS|BYTES|PER_MINUTE|CONCURRENT|INFLIGHT|CANDIDATES|READS|DEPTH)$/;
/** Bound exports kept out of the limits block; each needs a file:line showing it is off the served path. */
const EXCLUDED_BOUNDS: Readonly<Record<string, string>> = {};

/** `name=number` for every number written right after a constant's whole name in `text` that is not its exported value. */
function numberMismatches(text: string, exported: Readonly<Record<string, number>>): string[] {
  const wrong: string[] = [];
  for (const [name, value] of Object.entries(exported)) {
    for (const match of text.matchAll(new RegExp(`\\b${name}\\W{1,4}(\\d+(?:[_,]\\d+)*)`, "g"))) {
      if (Number(match[1]!.replace(/[_,]/g, "")) !== value) wrong.push(`${name}=${match[1]}`);
    }
  }
  return wrong;
}

const realFetch = globalThis.fetch;
let globalFetchAttempts = 0;
beforeAll(() => {
  globalThis.fetch = (async () => {
    globalFetchAttempts += 1;
    throw new Error("network I/O is forbidden in public-contract tests");
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("MCP COMPLETE v1 public source contract stays equal to the served surface", () => {
  it("the tool block equals tools/list of the hosted live-mode server in both SDK eras, and the profile block equals the served inventory", async () => {
    const tools = block("tools") as unknown[];
    const profiles = block("profiles");
    expect(tools).toHaveLength(6);
    let providerFetches = 0;
    const providerFetch = (async () => {
      providerFetches += 1;
      throw new Error("no provider is reachable in public-contract tests");
    }) as typeof fetch;
    const server = await startNeMcpHttpServer({
      host: "127.0.0.1", port: 0, hosted: { publicOrigin: ORIGIN }, liveEvidence: createMultichainTool(providerFetch),
    });
    try {
      for (const mode of ["legacy", "auto"] as const) {
        const client = new Client({ name: `distribution-draft-${mode}`, version: "1" }, { versionNegotiation: { mode } });
        await client.connect(new StreamableHTTPClientTransport(new URL(ORIGIN + "/mcp"), { fetch: simulatedHostFetch(server.port, HOST) }));
        try {
          expect(client.getProtocolEra()).toBe(mode === "legacy" ? "legacy" : "modern");
          const served = (await client.listTools()).tools;
          for (const tool of served) expect(tool.annotations?.title).toBe(tool.title);
          expect(served.map((tool) => ({
            name: tool.name,
            title: tool.title,
            annotations: {
              readOnlyHint: tool.annotations?.readOnlyHint,
              destructiveHint: tool.annotations?.destructiveHint,
              idempotentHint: tool.annotations?.idempotentHint,
              openWorldHint: tool.annotations?.openWorldHint,
            },
          }))).toEqual(tools);
          const listed = await client.callTool({ name: "list_network_profiles", arguments: {} });
          expect(listed.isError).toBeFalsy();
          expect(profileRows((listed.structuredContent as any).profiles)).toEqual(profiles);
        } finally { await client.close(); }
      }
    } finally { await server.close(); }
    expect(providerFetches).toBe(0);
    expect(globalFetchAttempts).toBe(0);
  });

  it("the profile block equals activeNetworkProfilesInventory() and has no eip155:57057", () => {
    const profiles = block("profiles") as { networkId: string }[];
    expect(profileRows(activeNetworkProfilesInventory().profiles)).toEqual(profiles);
    expect(profiles.map((p) => p.networkId)).not.toContain("eip155:57057");
    expect(JSON.stringify(profiles)).not.toMatch(/57057|zksys/i);
  });

  it("every numeric limit equals its exported constant; HTTP admissions are the configurable NE_MCP_RATE_LIMIT_PER_MINUTE", () => {
    const exported: Record<string, number> = {
      MULTICHAIN_CALLS_PER_MINUTE: liveMultichain.MULTICHAIN_CALLS_PER_MINUTE,
      MULTICHAIN_MAX_INFLIGHT: liveMultichain.MULTICHAIN_MAX_INFLIGHT,
      LIVE_TOOL_DEADLINE_MS: liveMultichain.LIVE_TOOL_DEADLINE_MS,
      MULTICHAIN_RESULT_MAX_BYTES: liveMultichain.MULTICHAIN_RESULT_MAX_BYTES,
      LIVE_BEFORE_MAX_AGE_MS: liveBefore.LIVE_BEFORE_MAX_AGE_MS,
      LIVE_OPSTACK_MAX_ANCESTRY_DEPTH: liveEvm.LIVE_OPSTACK_MAX_ANCESTRY_DEPTH,
      LIVE_BEFORE_MAX_CANDIDATES: liveBefore.LIVE_BEFORE_MAX_CANDIDATES,
      LIVE_BEFORE_MAX_OUTPUT_BYTES: liveBefore.LIVE_BEFORE_MAX_OUTPUT_BYTES,
      LIVE_PREFLIGHT_MAX_INPUT_BYTES: livePreflight.LIVE_PREFLIGHT_MAX_INPUT_BYTES,
      LIVE_PREFLIGHT_MAX_OUTPUT_BYTES: livePreflight.LIVE_PREFLIGHT_MAX_OUTPUT_BYTES,
      LIVE_EVM_MAX_CALLS_PER_MINUTE: liveEvm.LIVE_EVM_MAX_CALLS_PER_MINUTE,
      LIVE_EVM_MAX_CONCURRENT: liveEvm.LIVE_EVM_MAX_CONCURRENT,
      LIVE_EVM_RPC_TIMEOUT_MS: liveEvm.LIVE_EVM_RPC_TIMEOUT_MS,
      LIVE_EVM_MAX_RPC_BYTES: liveEvm.LIVE_EVM_MAX_RPC_BYTES,
      LIVE_EVM_MAX_RESULT_BYTES: liveEvm.LIVE_EVM_MAX_RESULT_BYTES,
      LIVE_OPSTACK_MAX_RPC_READS: liveEvm.LIVE_OPSTACK_MAX_RPC_READS,
      SOLANA_READ_TIMEOUT_MS: liveSolana.SOLANA_READ_TIMEOUT_MS,
      SOLANA_RESPONSE_MAX_BYTES: liveSolana.SOLANA_RESPONSE_MAX_BYTES,
      EVIDENCE_CONTEXT_MAX_BYTES: liveResult.EVIDENCE_CONTEXT_MAX_BYTES,
    };
    expect(block("limits")).toEqual({
      ...exported,
      HTTP_MCP_ADMISSIONS_PER_MINUTE: {
        configurableBy: "NE_MCP_RATE_LIMIT_PER_MINUTE",
        hostedDefault: HOSTED_DEFAULT_LIMITS.maxRequestsPerMinute,
        min: 1,
        max: MAX_REQUESTS_PER_MINUTE_CEILING,
      },
    });
    expect(repoText("packages/mcp/src/hosted.ts")).toContain('maxRequestsPerMinute: optionalDecimal(env, "NE_MCP_RATE_LIMIT_PER_MINUTE")');
    // Any number written right after a constant name (whole name) anywhere in the draft must be that constant.
    expect(numberMismatches(DOC, exported)).toEqual([]);
    // Committed mutation proof: the same check goes RED on 'LIVE_BEFORE_MAX_CANDIDATES: 2' anywhere in the draft
    // or as the limits-block value, and ignores longer names that only contain it.
    expect(numberMismatches(DOC + "\nLIVE_BEFORE_MAX_CANDIDATES: 2\n", exported)).toEqual(["LIVE_BEFORE_MAX_CANDIDATES=2"]);
    const blockEntry = `"LIVE_BEFORE_MAX_CANDIDATES": ${liveBefore.LIVE_BEFORE_MAX_CANDIDATES},`;
    expect(DOC).toContain(blockEntry);
    expect(numberMismatches(DOC.replace(blockEntry, '"LIVE_BEFORE_MAX_CANDIDATES": 2,'), exported))
      .toEqual(["LIVE_BEFORE_MAX_CANDIDATES=2"]);
    expect(numberMismatches("X_LIVE_BEFORE_MAX_CANDIDATES: 2\nLIVE_BEFORE_MAX_CANDIDATES_X: 2\n", exported)).toEqual([]);
    // Each limit has its own §5 bullet.
    for (const name of Object.keys(block("limits") as object)) {
      expect(LINES.filter((line) => line.startsWith(`- \`${name}\`: `)), name).toHaveLength(1);
    }
  });

  it("every exported live-*.ts bound is in the limits block or explicitly excluded, and the Discovery per-call bound is stated", () => {
    const files = readdirSync(new URL("../src/", import.meta.url)).filter((file) => /^live-.*\.ts$/.test(file)).sort();
    // P3: the composer is served through resolve_transaction_evidence (tools.ts -> live-claim.ts -> live-result.ts),
    // so it has no exemption: every live-*.ts module and its bounds are on the served path.
    expect(repoText("packages/mcp/src/tools.ts")).toContain('from "./live-claim.js"');
    expect(repoText("packages/mcp/src/live-claim.ts")).toContain('from "./live-result.js"');
    expect(files).toContain("live-result.ts");
    expect(files).toEqual(Object.keys(LIVE_MODULES).sort());
    const limits = block("limits") as Record<string, unknown>;
    const bounds = Object.values(LIVE_MODULES).flatMap((module) =>
      Object.entries(module).filter(([name, value]) => typeof value === "number" && BOUND_NAME.test(name)));
    expect(bounds.length).toBeGreaterThan(0);
    for (const [name, value] of bounds) {
      if (Object.hasOwn(EXCLUDED_BOUNDS, name)) {
        expect(EXCLUDED_BOUNDS[name], name).toMatch(/packages\/mcp\/src\/[\w.-]+\.ts:\d+/);
        expect(limits, name).not.toHaveProperty(name);
      } else {
        expect(limits[name], name).toBe(value);
      }
    }
    for (const name of Object.keys(EXCLUDED_BOUNDS)) expect(bounds.map(([bound]) => bound), name).toContain(name);
    const perCall = LINES.filter((line) => line.startsWith("- Per `discover_live_network_evidence` call (bound"));
    expect(perCall).toHaveLength(1);
    for (const part of [
      "packages/mcp/README.md:486-503", "≤`LIVE_BEFORE_MAX_CANDIDATES` shared admissions", "one inner EVM admission per Base subject",
      "≤12 provider reads", "checked per subject and not reserved", "one HTTP `/mcp` admission",
    ]) expect(perCall[0], part).toContain(part);
  });

  it("RC1-RC8: 5 positive and 3 negative cases, each naming a CAPTURE_CALLS id or an existing fixture", () => {
    const rows = tableRows("reviewer-cases");
    expect(rows.map((row) => row[0])).toEqual(["RC1", "RC2", "RC3", "RC4", "RC5", "RC6", "RC7", "RC8"]);
    expect(rows.map((row) => row[1])).toEqual([...Array(5).fill("positive"), ...Array(3).fill("negative")]);
    const calls = new Map(CAPTURE_CALLS.map((call) => [call.id, call]));
    for (const row of rows) {
      expect(row).toHaveLength(5);
      const [rc, type, tool, evidence] = row as [string, string, string, string];
      const refs = [...evidence.matchAll(/`(capture|fixture):([^`]+)`/g)];
      expect(refs.length, rc).toBeGreaterThan(0);
      for (const ref of refs) {
        const [kind, id] = [ref[1]!, ref[2]!];
        if (kind === "fixture") {
          expect(existsSync(new URL(id, REPO_ROOT)), `${rc} ${id}`).toBe(true);
          continue;
        }
        const call = calls.get(id);
        expect(call, `${rc} ${id}`).toBeDefined();
        expect(tool, rc).toContain(`\`${call!.tool}\``);
        // Positive cases may end observed; negative cases never can.
        if (type === "positive") expect(EXPECTED_OUTCOMES[id], rc).toContain("observed");
        else expect(EXPECTED_OUTCOMES[id], rc).not.toContain("observed");
      }
    }
    expect(DOC).toContain(`the ${CAPTURE_CALLS.length} \`CAPTURE_CALLS\``);
  });

  it("RC5 cites the three-class discover-three-candidates call", () => {
    const rc5 = tableRows("reviewer-cases").find((row) => row[0] === "RC5");
    expect(rc5, "RC5").toBeDefined();
    expect(rc5![3]).toContain("`capture:discover-three-candidates`");
  });

  it("every reviewer-cases row naming ineligible is SYNTHETIC-SUBJECT and not proof of nonexistence", () => {
    const ineligible = tableRows("reviewer-cases").filter((row) => row.join(" ").includes("ineligible"));
    // At least one row, so the rule cannot pass vacuously.
    expect(ineligible.length).toBeGreaterThan(0);
    for (const row of ineligible) {
      expect(row.join(" "), row[0]).toContain("SYNTHETIC-SUBJECT");
      expect(row.join(" "), row[0]).toContain("not proof of nonexistence");
    }
  });

  it("no reviewer-cases row presents verifier classCoverage as tool output", () => {
    for (const row of tableRows("reviewer-cases")) expect(row.join(" "), row[0]).not.toContain("classCoverage");
  });

  it("the cited packages/mcp/README.md:486-503 range holds the Discovery budget bullets and LIVE_BEFORE_MAX_OUTPUT_BYTES", () => {
    const cited = [...DOC.matchAll(/packages\/mcp\/README\.md:(\d+)-(\d+)/g)];
    // Moved by exactly the ten ne-failure-modes lines P3 added above it (five codes, row F18).
    expect(cited.map((match) => match[0])).toEqual(["packages/mcp/README.md:486-503"]);
    const [from, to] = [Number(cited[0]![1]), Number(cited[0]![2])];
    const range = repoText("packages/mcp/README.md").split("\n").slice(from - 1, to);
    expect(range).toHaveLength(to - from + 1);
    expect(range[0]).toMatch(/^- \*\*Admissions:\*\* /);
    for (const head of ["Admissions", "Reads", "Deadline", "Source failures", "HTTP ingress"]) {
      expect(range.filter((line) => line.startsWith(`- **${head}:** `)), head).toHaveLength(1);
    }
    expect(range.join("\n")).toContain("LIVE_BEFORE_MAX_OUTPUT_BYTES");
  });

  it("this public contract has no owner approval matrix or secret placeholders", () => {
    expect(DOC).not.toContain("NOT" + "-FOR-PUBLICATION:");
    expect(DOC).not.toContain("[HUMAN" + ":");
    expect(DOC).not.toContain("## 9. Coverage gate");
    expect(DOC).toContain("source observation, not independent cryptographic finality");
  });
});
