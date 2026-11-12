/**
 * Public source snapshot guard (not a publication approval).
 * The owner-only approval material must remain in the protected private source.
 * This does not certify that every other file is safe for public disclosure.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../../../", import.meta.url);
const CONTRACT = new URL("docs/distribution/MCP_PUBLIC_CONTRACT.md", ROOT);
const OWNER_APPROVAL = new URL("docs/distribution/MCP_COMPLETE_V1_" + "APPROVAL_DRAFT.md", ROOT);

describe("NE public snapshot evidence/approval separation", () => {
  it("does not distribute the owner-only approval document", () => {
    expect(existsSync(OWNER_APPROVAL)).toBe(false);
    expect(existsSync(CONTRACT)).toBe(true);
  });

  it("keeps tool declarations separate from publication approval and finance/finality claims", () => {
    const contract = readFileSync(CONTRACT, "utf8");
    expect(contract).toContain("Source behavior, not a release approval.");
    expect(contract).toContain("not independent cryptographic finality.");
    expect(contract).toContain("does not establish an authenticated or cryptographically anchored BEFORE.");
    expect(contract).not.toMatch(/<NOT-FOR-PUBLICATION:|\[HUMAN:/);
    expect(contract).not.toContain("Cloud Run revision");
    expect(contract).not.toContain("owner-delegated ruling");
    expect(contract).not.toContain("## 9. Coverage gate");
  });

  it("describes exactly six read-only tools and four fixed profiles without a zkSYS-live claim", () => {
    const text = readFileSync(CONTRACT, "utf8");
    const getBlock = (tag: string) => {
      const re = new RegExp("^\x60\x60\x60json ne-distribution:" + tag + "\\n([\\s\\S]*?)\\n\x60\x60\x60$", "gm");
      const blocks = [...text.matchAll(re)];
      expect(blocks, tag).toHaveLength(1);
      return JSON.parse(blocks[0]![1]!) as unknown;
    };
    const tools = getBlock("tools") as { name: string; annotations: { readOnlyHint: boolean } }[];
    const profiles = getBlock("profiles") as { networkId: string }[];
    expect(tools).toHaveLength(6);
    expect(tools.every((tool) => tool.annotations.readOnlyHint)).toBe(true);
    expect(profiles).toHaveLength(4);
    expect(profiles.some((profile) => profile.networkId === "eip155:57057")).toBe(false);
  });
});
