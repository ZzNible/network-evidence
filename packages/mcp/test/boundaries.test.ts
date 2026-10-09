/**
 * Static boundary checks over the MCP package source: no outbound I/O
 * primitives, no process spawning, no wallet/signing/submission vocabulary,
 * no choice/ranking keys, and no Core reimplementation hooks.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const files = readdirSync(SRC).filter((name) => name.endsWith(".ts"));
const sources = new Map(files.map((name) => [name, readFileSync(`${SRC}${name}`, "utf8")]));

describe("@nec/mcp source boundaries", () => {
  it("has the expected small module set", () => {
    expect(files.sort()).toEqual([
      "cases.ts",
      "cli.ts",
      "discover.ts",
      "errors.ts",
      "hosted.ts",
      "http.ts",
      "index.ts",
      "limits.ts",
      "live-before.ts",
      "live-claim.ts",
      "live-evm.ts",
      "live-multichain.ts",
      "live-preflight.ts",
      "live-solana.ts",
      "profiles.ts",
      "tools.ts",
    ]);
  });

  it("contains no outbound network, process or dynamic-code primitives", () => {
    const forbidden = [
      /\bfetch\s*\(/,
      /node:https/,
      /^import (?!type )[^;]*"node:net"/m,
      /node:dgram/,
      /node:child_process/,
      /\bhttp\.request\b|\brequest\s+as\s+httpRequest\b|\bhttpRequest\(/,
      /\bWebSocket\b/,
      /\beval\s*\(/,
      /new Function\(/,
      /writeFile|appendFile|mkdir|unlink|rmSync/,
    ];
    for (const [name, text] of sources) {
      for (const pattern of forbidden) expect(`${name}: ${pattern.test(text)}`).toBe(`${name}: false`);
    }
  });

  it("keeps opt-in RPC limited to fixed Base origins and read methods", () => {
    const live = sources.get("live-evm.ts")!;
    expect(live).toContain("https://mainnet.base.org");
    expect(live).toContain("https://sepolia.base.org");
    expect(live).toContain('"eth_chainId", "eth_getTransactionReceipt", "eth_getBlockByHash"');
    expect(live).not.toMatch(/process\.env|source\.transport\.url\s*=|eval\s*\(/);
    expect(sources.get("cli.ts")).toContain("NE_MCP_MULTICHAIN_ENABLED");
    const sol = sources.get("live-solana.ts")!;
    expect(sol).toContain("https://api.mainnet-beta.solana.com");
    expect(sol).toContain("https://api.devnet.solana.com");
    for (const m of ["getGenesisHash", "getTransaction", "getSignatureStatuses", "getBlock"]) expect(sol).toContain(m);
    expect(sources.get("live-multichain.ts")).toContain("MULTICHAIN_CALLS_PER_MINUTE = 8");
    expect(sources.get("live-multichain.ts")).toContain("MULTICHAIN_MAX_INFLIGHT = 2");
  });

  it("reads exactly one fixed data file and never a caller-supplied path", () => {
    const readers = [...sources].filter(([, text]) => /readFileSync/.test(text)).map(([name]) => name);
    expect(readers).toEqual(["cases.ts"]);
    const cases = sources.get("cases.ts")!;
    expect(cases).toMatch(/REVIEWED_COLLECTION_PATH = "examples\/ne-maps\/data\/collection\.json"/);
    expect(cases.match(/readFileSync\(/g)).toHaveLength(2);
  });

  it("does not reimplement Core classification or carry choice / wallet semantics", () => {
    const all = [...sources.values()].join("\n");
    expect(all).not.toMatch(/composeDiscoveryMatch\(/);
    expect(all).toMatch(/discoverNetworks\(/);
    expect(all).not.toMatch(/\b(signTransaction|sendTransaction|sendRawTransaction|privateKey|mnemonic|walletClient)\b/);
    expect(all).not.toMatch(/["'](rank|score|best|recommendation|recommended)["']\s*:/);
  });

  it("binds 127.0.0.1 by default; 0.0.0.0 exists only as the hosted-mode bind constant", () => {
    const http = sources.get("http.ts")!;
    expect(http).toMatch(/DEFAULT_HOST = "127\.0\.0\.1"/);
    expect(http).not.toMatch(/0\.0\.0\.0/);
    // Code literal (quoted) only; prose comments may name the address.
    const holders = [...sources].filter(([, text]) => /["'`]0\.0\.0\.0["'`]/.test(text)).map(([name]) => name);
    expect(holders).toEqual(["hosted.ts"]);
    const hosted = sources.get("hosted.ts")!;
    expect(hosted.match(/["'`]0\.0\.0\.0["'`]/g)).toHaveLength(1);
    expect(hosted).toMatch(/export const HOSTED_BIND_HOST = "0\.0\.0\.0";/);
  });

  it("never reads X-Forwarded-* or other proxy-supplied identity headers", () => {
    const all = [...sources.values()].join("\n");
    expect(all).not.toMatch(/["'`](x-forwarded-[a-z]+|forwarded|x-real-ip|cf-connecting-ip|true-client-ip)["'`]|headers\.forwarded|remoteAddress|remotePort/i);
  });
});
