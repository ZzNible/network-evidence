import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { LIVE_TOOL_NAMES } from "../src/tools.js";

function liveEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NE_MCP_MULTICHAIN_ENABLED: "1", NE_MCP_PORT: "0" };
  delete env.NE_MCP_MODE;
  delete env.NE_MCP_PUBLIC_ORIGIN;
  delete env.NE_MCP_CUSTOM_ORIGIN;
  delete env.NE_MCP_HOST;
  delete env.PORT;
  return env;
}

function cli(env: NodeJS.ProcessEnv) {
  return spawn(process.execPath, ["--import", "tsx", "packages/mcp/src/cli.ts"], {
    cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("real local MCP CLI live opt-in", () => {
  it("starts six tools on ephemeral loopback with explicit env flag and no RPC reads", async () => {
    const child = cli(liveEnvironment());
    let stdout = "";
    let stderr = "";
    try {
      const url = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("local live CLI startup timeout")), 18000);
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
          const start = stdout.indexOf("listening on ");
          if (start !== -1) {
            const tail = stdout.slice(start + "listening on ".length);
            const endpoint = tail.split(" ")[0];
            if (endpoint?.startsWith("http://127.0.0.1:") && endpoint.endsWith("/mcp")) {
              clearTimeout(timer);
              resolve(endpoint);
            }
          }
        });
        child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
        child.once("error", (error) => { clearTimeout(timer); reject(error); });
        child.once("exit", (code) => {
          clearTimeout(timer);
          reject(new Error("CLI exited before ready: " + code + " " + stderr.slice(0, 200)));
        });
      });
      const healthUrl = url.slice(0, -4) + "/healthz";
      const health = await (await fetch(healthUrl)).json() as Record<string, unknown>;
      expect(health).toMatchObject({
        mode: "local", liveObservation: true, networkIo: "bounded_evm_solana_rpc",
        readOnly: true,
      });
      expect(new Set(health.tools as string[])).toEqual(new Set(LIVE_TOOL_NAMES));
    } finally {
      if (child.exitCode === null) child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) { resolve(); return; }
        const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 3500);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
      });
    }
  }, 29000);

  it("rejects a non-loopback CLI override without starting a service", async () => {
    const child = cli({ ...liveEnvironment(), NE_MCP_HOST: "0.0.0.0" });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("bad host CLI startup timeout")); }, 15000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", (code) => { clearTimeout(timer); resolve(code); });
    });
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/loopback/);
  }, 20000);
});
