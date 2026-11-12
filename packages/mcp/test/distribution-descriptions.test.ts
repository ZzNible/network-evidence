/**
 * NE-L048 anti-drift guard for the `ne-distribution:descriptions` block of
 * docs/distribution/MCP_PUBLIC_CONTRACT.md (public, source contract). The block must be byte-equal to the tool descriptions served
 * by `tools/list` of the hosted live-mode server in both SDK eras, every
 * numeric bound written in them must be built from its exported constant, and
 * the required non-claims must be exact substrings of the served text.
 *
 * Docs + test only: no source file is edited. No provider is reachable: the
 * live tool's fetch and global fetch both throw and are counted at zero.
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { MAX_DISCOVERY_CANDIDATES } from "../src/discover.js";
import { startNeMcpHttpServer } from "../src/http.js";
import { LIVE_BEFORE_MAX_CANDIDATES, LIVE_BEFORE_TOOL_NAME } from "../src/live-before.js";
import { LIVE_OPSTACK_MAX_ANCESTRY_DEPTH } from "../src/live-evm.js";
import { LIVE_MULTICHAIN_TOOL, createMultichainTool } from "../src/live-multichain.js";
import { LIVE_PREFLIGHT_TOOL_NAME } from "../src/live-preflight.js";
import { simulatedHostFetch } from "./helpers.js";

const REPO_ROOT = new URL("../../../", import.meta.url);
const DOC = readFileSync(new URL("docs/distribution/MCP_PUBLIC_CONTRACT.md", REPO_ROOT), "utf8");

const ORIGIN = "https://mcp.example.org";
const HOST = "mcp.example.org";

type Descriptions = Readonly<Record<string, string>>;

/** Exactly one ```json ne-distribution:descriptions block, parsed. */
function descriptionsBlock(): Descriptions {
  const found = [...DOC.matchAll(/^```json ne-distribution:descriptions\n([\s\S]*?)\n```$/gm)];
  expect(found, "descriptions block").toHaveLength(1);
  return JSON.parse(found[0]![1]!) as Descriptions;
}

/** Served order of the hosted live-mode server. */
const LIVE_TOOL_ORDER = [
  "list_network_profiles", "discover_network_candidates", "get_reviewed_evidence_case",
  LIVE_PREFLIGHT_TOOL_NAME, LIVE_BEFORE_TOOL_NAME, LIVE_MULTICHAIN_TOOL,
] as const;

const NUMERIC_TOKEN = /\b\d+(?:\.\.\d+|-\d+|-ancestor)\b/g;
/** The only numeric bound tokens allowed in the served descriptions, each in its own tool, built from the exports. */
const EXPECTED_TOKENS: Readonly<Record<string, string>> = {
  discover_network_candidates: `1..${MAX_DISCOVERY_CANDIDATES}`,
  [LIVE_BEFORE_TOOL_NAME]: `1-${LIVE_BEFORE_MAX_CANDIDATES}`,
  [LIVE_MULTICHAIN_TOOL]: `${LIVE_OPSTACK_MAX_ANCESTRY_DEPTH}-ancestor`,
};

const REQUIRED_NON_CLAIMS: Readonly<Record<string, readonly string[]>> = {
  [LIVE_MULTICHAIN_TOOL]: [
    "NOT Ethereum settlement or withdrawal finalization",
    "neither is protocol settlement, cryptographic finality, or a full Core NetworkEvidenceResult",
    "Preflight continuity is NOT precedence",
    "Caller-supplied protocol terms are NOT independently authenticated",
  ],
  [LIVE_PREFLIGHT_TOOL_NAME]: ["Readiness is evidence acquisition only"],
  [LIVE_BEFORE_TOOL_NAME]: ["not global uptime, settlement, cryptographic finality or a network recommendation"],
  discover_network_candidates: ["does NOT choose, rank or recommend a network"],
  list_network_profiles: ["Listing is NOT an actual availability probe"],
};

/** Pure checker over a {toolName: description} object; returns every violation (empty = accepted). */
function descriptionProblems(descriptions: Descriptions): string[] {
  const problems: string[] = [];
  const names = Object.keys(descriptions);
  if (JSON.stringify(names) !== JSON.stringify(LIVE_TOOL_ORDER)) problems.push(`tool set/order: ${names.join(", ")}`);
  const tokensOf = (name: string): string[] => [...(descriptions[name] ?? "").matchAll(NUMERIC_TOKEN)].map((match) => match[0]);
  const allTokens = LIVE_TOOL_ORDER.flatMap((name) => tokensOf(name));
  const expectedAll = LIVE_TOOL_ORDER.flatMap((name) => (Object.hasOwn(EXPECTED_TOKENS, name) ? [EXPECTED_TOKENS[name]!] : []));
  if (JSON.stringify(allTokens) !== JSON.stringify(expectedAll)) problems.push(`numeric tokens: ${allTokens.join(", ")}`);
  for (const name of LIVE_TOOL_ORDER) {
    const expected = Object.hasOwn(EXPECTED_TOKENS, name) ? [EXPECTED_TOKENS[name]!] : [];
    if (JSON.stringify(tokensOf(name)) !== JSON.stringify(expected)) problems.push(`${name} numeric tokens: ${tokensOf(name).join(", ")}`);
  }
  for (const [name, phrases] of Object.entries(REQUIRED_NON_CLAIMS)) {
    for (const phrase of phrases) {
      if (!(descriptions[name] ?? "").includes(phrase)) problems.push(`${name} lacks: ${phrase}`);
    }
  }
  const profiles = descriptions.list_network_profiles ?? "";
  if (/Tanenbaum|57057/.test(profiles)) problems.push("list_network_profiles names Tanenbaum or 57057");
  for (const name of names) {
    if ((descriptions[name] ?? "").includes("MCP COMPLETE")) problems.push(`${name} contains MCP COMPLETE`);
  }
  return problems;
}

interface ServedEra {
  readonly era: string;
  readonly descriptions: Descriptions;
  readonly subjectsMaxItems: unknown;
}

const realFetch = globalThis.fetch;
let globalFetchAttempts = 0;
let providerFetches = 0;
const liveServed: ServedEra[] = [];
const offlineServed: { era: string; names: string[]; profilesDescription: string }[] = [];

async function listToolsBothEras(port: number): Promise<{ era: string; tools: any[] }[]> {
  const out: { era: string; tools: any[] }[] = [];
  for (const mode of ["legacy", "auto"] as const) {
    const client = new Client({ name: `distribution-descriptions-${mode}`, version: "1" }, { versionNegotiation: { mode } });
    await client.connect(new StreamableHTTPClientTransport(new URL(ORIGIN + "/mcp"), { fetch: simulatedHostFetch(port, HOST) }));
    try {
      const era = client.getProtocolEra();
      expect(era).toBe(mode === "legacy" ? "legacy" : "modern");
      out.push({ era: String(era), tools: (await client.listTools()).tools as any[] });
    } finally { await client.close(); }
  }
  return out;
}

beforeAll(async () => {
  globalThis.fetch = (async () => {
    globalFetchAttempts += 1;
    throw new Error("network I/O is forbidden in distribution-descriptions tests");
  }) as typeof fetch;
  const throwingFetch = (async () => {
    providerFetches += 1;
    throw new Error("no provider is reachable in distribution-descriptions tests");
  }) as typeof fetch;

  const live = await startNeMcpHttpServer({
    host: "127.0.0.1", port: 0, hosted: { publicOrigin: ORIGIN }, liveEvidence: createMultichainTool(throwingFetch),
  });
  try {
    for (const { era, tools } of await listToolsBothEras(live.port)) {
      const before = tools.find((tool) => tool.name === LIVE_BEFORE_TOOL_NAME);
      liveServed.push({
        era,
        descriptions: Object.fromEntries(tools.map((tool) => [tool.name as string, tool.description as string])),
        subjectsMaxItems: before?.inputSchema?.properties?.subjects?.maxItems,
      });
    }
  } finally { await live.close(); }

  const offline = await startNeMcpHttpServer({ host: "127.0.0.1", port: 0, hosted: { publicOrigin: ORIGIN } });
  try {
    for (const { era, tools } of await listToolsBothEras(offline.port)) {
      offlineServed.push({
        era,
        names: tools.map((tool) => tool.name as string),
        profilesDescription: String(tools.find((tool) => tool.name === "list_network_profiles")?.description),
      });
    }
  } finally { await offline.close(); }
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("NE-L048: approval draft tool descriptions equal tools/list and the exported bounds", () => {
  it("the descriptions block is byte-equal to tools/list of the hosted live-mode server in both SDK eras, with no fetch", () => {
    const block = descriptionsBlock();
    expect(liveServed.map((served) => served.era)).toEqual(["legacy", "modern"]);
    for (const served of liveServed) {
      expect(Object.keys(served.descriptions), served.era).toEqual([...LIVE_TOOL_ORDER]);
      expect(Object.keys(block), served.era).toEqual(Object.keys(served.descriptions));
      for (const name of LIVE_TOOL_ORDER) {
        expect(typeof served.descriptions[name], `${served.era} ${name}`).toBe("string");
        expect(block[name], `${served.era} ${name}`).toBe(served.descriptions[name]);
      }
    }
    expect(providerFetches).toBe(0);
    expect(globalFetchAttempts).toBe(0);
  });

  it("numeric bounds are exactly the three exported-constant tokens, each in its own tool; discover_live subjects maxItems is LIVE_BEFORE_MAX_CANDIDATES", () => {
    expect(EXPECTED_TOKENS).toEqual({
      discover_network_candidates: `1..${MAX_DISCOVERY_CANDIDATES}`,
      discover_live_network_evidence: `1-${LIVE_BEFORE_MAX_CANDIDATES}`,
      resolve_transaction_evidence: `${LIVE_OPSTACK_MAX_ANCESTRY_DEPTH}-ancestor`,
    });
    for (const served of liveServed) {
      const tokens = LIVE_TOOL_ORDER.flatMap((name) => [...served.descriptions[name]!.matchAll(NUMERIC_TOKEN)].map((match) => match[0]));
      expect(tokens, served.era).toEqual([
        `1..${MAX_DISCOVERY_CANDIDATES}`, `1-${LIVE_BEFORE_MAX_CANDIDATES}`, `${LIVE_OPSTACK_MAX_ANCESTRY_DEPTH}-ancestor`,
      ]);
      for (const [name, token] of Object.entries(EXPECTED_TOKENS)) {
        expect(served.descriptions[name], `${served.era} ${name}`).toContain(token);
      }
      expect(served.subjectsMaxItems, served.era).toBe(LIVE_BEFORE_MAX_CANDIDATES);
      expect(descriptionProblems(served.descriptions), served.era).toEqual([]);
    }
    expect(descriptionProblems(descriptionsBlock())).toEqual([]);
  });

  it("required non-claims are exact served substrings; no Tanenbaum/57057 in live list_network_profiles; no MCP COMPLETE", () => {
    for (const served of liveServed) {
      for (const [name, phrases] of Object.entries(REQUIRED_NON_CLAIMS)) {
        for (const phrase of phrases) expect(served.descriptions[name], `${served.era} ${name}`).toContain(phrase);
      }
      expect(served.descriptions.list_network_profiles).not.toMatch(/Tanenbaum|57057/);
      for (const name of LIVE_TOOL_ORDER) expect(served.descriptions[name], name).not.toContain("MCP COMPLETE");
      // The allowed phrase stays allowed.
      expect(served.descriptions[LIVE_PREFLIGHT_TOOL_NAME]).toContain("COMPLETE original Core PreflightRequest");
    }
  });

  it("mutation sensitivity: the same checker rejects copies with 9-ancestor, '1-4 ', 1..17 or one required non-claim removed", () => {
    const served = liveServed[1]!.descriptions;
    const mutate = (name: string, from: string, to: string): Descriptions => {
      const original = served[name]!;
      expect(original, `${name} has ${from}`).toContain(from);
      const changed = original.replace(from, to);
      expect(changed, `${name} mutated`).not.toBe(original);
      return { ...served, [name]: changed };
    };
    const mutants: Readonly<Record<string, Descriptions>> = {
      "9-ancestor": mutate(LIVE_MULTICHAIN_TOOL, `${LIVE_OPSTACK_MAX_ANCESTRY_DEPTH}-ancestor`, "9-ancestor"),
      "1-4 ": mutate(LIVE_BEFORE_TOOL_NAME, `1-${LIVE_BEFORE_MAX_CANDIDATES} `, "1-4 "),
      "1..17": mutate("discover_network_candidates", `1..${MAX_DISCOVERY_CANDIDATES}`, "1..17"),
      "non-claim removed": mutate(LIVE_MULTICHAIN_TOOL, "Preflight continuity is NOT precedence", ""),
    };
    expect(descriptionProblems(served)).toEqual([]);
    for (const [label, copy] of Object.entries(mutants)) {
      expect(descriptionProblems(copy).length, label).toBeGreaterThan(0);
    }
  });

  it("a server without liveEvidence serves exactly 3 tools with the OFFLINE list_network_profiles description, which the draft does not copy", () => {
    expect(offlineServed.map((served) => served.era)).toEqual(["legacy", "modern"]);
    const block = descriptionsBlock();
    for (const served of offlineServed) {
      expect(served.names, served.era).toEqual(["list_network_profiles", "discover_network_candidates", "get_reviewed_evidence_case"]);
      expect(served.profilesDescription, served.era).toContain("OFFLINE");
      expect(served.profilesDescription, served.era).toContain("historical replay only");
      expect(Object.values(block)).not.toContain(served.profilesDescription);
      expect(DOC).not.toContain(served.profilesDescription);
    }
    expect(providerFetches).toBe(0);
    expect(globalFetchAttempts).toBe(0);
  });
});
