/**
 * `npm run mcp:serve` — start the local, read-only Network Evidence MCP v0.
 *
 *   --port <n>  | NE_MCP_PORT   (default 4178; 0 = ephemeral)
 *   --host <h>  | NE_MCP_HOST   (default 127.0.0.1; loopback names only)
 *
 * The process replaces global `fetch` with a throwing guard: this server
 * performs no outbound network I/O by construction.
 */

import { DEFAULT_HOST, DEFAULT_PORT, NeMcpConfigError, startNeMcpHttpServer } from "./http.js";

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_PORT;
  if (!/^\d{1,5}$/.test(raw)) throw new NeMcpConfigError("port must be a decimal integer");
  return Number(raw);
}

globalThis.fetch = (() => {
  throw new Error("Network Evidence MCP v0 performs no outbound network I/O");
}) as typeof fetch;

try {
  const server = await startNeMcpHttpServer({
    host: argValue("--host") ?? process.env.NE_MCP_HOST ?? DEFAULT_HOST,
    port: parsePort(argValue("--port") ?? process.env.NE_MCP_PORT),
    log: (line) => process.stderr.write(`${line}\n`),
  });
  process.stdout.write(
    `Network Evidence MCP v0 (local, read-only, offline) listening on ${server.mcpUrl}  health: ${server.url}/healthz\n`,
  );
  const stop = () => {
    void server.close().then(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
} catch (error) {
  const message = error instanceof NeMcpConfigError ? error.message : `startup failed (${error instanceof Error ? error.message : "unknown"})`;
  process.stderr.write(`Network Evidence MCP v0: ${message}\n`);
  process.exit(1);
}
