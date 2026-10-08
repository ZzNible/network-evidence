/**
 * `npm run -s mcp:smoke` — real MCP protocol smoke over loopback Streamable
 * HTTP with the official SDK client (@modelcontextprotocol/client).
 *
 *   npm run -s mcp:smoke                                  # in-process server on 127.0.0.1:<ephemeral>
 *   npm run -s mcp:smoke -- --url http://127.0.0.1:4178/mcp   # against `npm run mcp:serve`
 *
 * For each protocol era (legacy initialize handshake, modern 2026-07-28):
 * connect -> tools/list -> positive and negative tools/call. Discovery inputs
 * are the public demo's SYNTHETIC probes + one ARCHIVED replay, labelled as
 * such; they are not live data. Exits 1 on any unexpected outcome.
 */

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import { startNeMcpHttpServer } from "../src/http.js";
import { clone, loadWireDemo } from "./helpers.js";

const lines: string[] = [];
let failures = 0;
const out = (line = "") => lines.push(line);
function check(label: string, ok: boolean): void {
  out(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
}

function errorCode(result: { content?: unknown }): string | null {
  const first = (result.content as { type: string; text?: string }[] | undefined)?.[0];
  if (first?.type !== "text" || first.text === undefined) return null;
  try {
    return (JSON.parse(first.text) as { error?: { code?: string } }).error?.code ?? null;
  } catch {
    return null;
  }
}

const urlIndex = process.argv.indexOf("--url");
const external = urlIndex === -1 ? undefined : process.argv[urlIndex + 1];
const local = external === undefined ? await startNeMcpHttpServer({ port: 0 }) : undefined;
const mcpUrl = external ?? local!.mcpUrl;
const demo = await loadWireDemo();

out(`Network Evidence MCP v0 smoke — ${mcpUrl}`);
out("Discovery inputs: public demo contexts (base-*/solana-mainnet = SYNTHETIC demo probes; solana-devnet = ARCHIVED replay). Not live data.");

for (const mode of ["legacy", "auto"] as const) {
  const client = new Client({ name: "ne-mcp-smoke", version: "0" }, { versionNegotiation: { mode } });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl)));
  out();
  out(`[${mode}] era=${client.getProtocolEra()} protocolVersion=${client.getNegotiatedProtocolVersion()} server=${JSON.stringify(client.getServerVersion())}`);
  try {
    const { tools } = await client.listTools();
    for (const tool of tools) out(`  tool ${tool.name} annotations=${JSON.stringify(tool.annotations)}`);
    check("exactly 3 tools", tools.length === 3);
    check(
      "every tool readOnlyHint=true destructiveHint=false openWorldHint=false",
      tools.every((t) => t.annotations?.readOnlyHint === true && t.annotations.destructiveHint === false && t.annotations.openWorldHint === false),
    );

    const profiles = (await client.callTool({ name: "list_network_profiles", arguments: {} })).structuredContent as any;
    out(`  profiles: ${profiles.profiles.map((p: any) => `${p.profileId}=${p.networkId}[${p.environment}]`).join(" ")}`);
    check(
      "every profile capability currentAvailability=not_assessed",
      profiles.profiles.every((p: any) => p.capabilities.every((c: any) => c.currentAvailability === "not_assessed")),
    );

    const discovery = await client.callTool({ name: "discover_network_candidates", arguments: demo.wire as any });
    const d = discovery.structuredContent as any;
    out(`  discovery resultArtifactDigest=${d.coreVerification.resultArtifactDigest}`);
    for (const c of d.candidates) {
      out(`    ${c.id.padEnd(15)} ${c.networkId.padEnd(42)} ${c.classification.padEnd(12)} observationKind=${c.suppliedSnapshot.declaredObservationKind} sources=${c.suppliedSnapshot.evidenceSourceIds.join(",")}`);
    }
    check("discovery ok, liveObservation=false, re-verified by Core", !discovery.isError && d.liveObservation === false && d.coreVerification.reverifiedAtMcpBoundary === true);

    for (const caseId of ["f1", "synthetic-local-core-golden"]) {
      const c = (await client.callTool({ name: "get_reviewed_evidence_case", arguments: { caseId } })).structuredContent as any;
      out(`  case ${caseId}: ${c.evidenceClass} liveObservation=${c.liveObservation} currentAvailability=${c.currentAvailability}`);
      out(`    label: ${c.label}`);
    }

    const mismatch = clone(demo.wire) as any;
    mismatch.candidates[0].network.chainId = 1;
    const r1 = await client.callTool({ name: "discover_network_candidates", arguments: mismatch });
    check(`negative: network != snapshot.network -> ${errorCode(r1)}`, r1.isError === true && errorCode(r1) === "MCP_CANDIDATE_NETWORK_MISMATCH");

    const archivedLive = clone(demo.wire) as any;
    archivedLive.candidates.find((c: any) => c.id === "solana-devnet").snapshot.evidenceCapabilities.execution.availability = "available";
    const r2 = await client.callTool({ name: "discover_network_candidates", arguments: archivedLive });
    check(`negative: archived replay relabelled 'available' -> ${errorCode(r2)}`, r2.isError === true && errorCode(r2) === "MCP_WIRE_DECODE_FAILED");

    const relabel = clone(demo.wire) as any;
    relabel.candidates.find((c: any) => c.id === "base-sepolia").environment = "mainnet";
    const r3 = await client.callTool({ name: "discover_network_candidates", arguments: relabel });
    check(`negative: base-sepolia labelled mainnet -> ${errorCode(r3)}`, r3.isError === true && errorCode(r3) === "MCP_ENVIRONMENT_LABEL_CONFLICT");

    const r4 = await client.callTool({ name: "get_reviewed_evidence_case", arguments: { caseId: "../../etc/passwd" } });
    check("negative: path-like caseId rejected by schema", r4.isError === true);
  } finally {
    await client.close();
  }
}

await local?.close();
out();
out(failures === 0 ? "SMOKE OK — no network I/O beyond loopback; nothing signed, funded or submitted." : `SMOKE FAILED (${failures})`);
process.stdout.write(`${lines.join("\n")}\n`);
process.exit(failures === 0 ? 0 : 1);
