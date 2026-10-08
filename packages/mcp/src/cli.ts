/**
 * `npm run mcp:serve` — start the read-only Network Evidence MCP v0.
 *
 * Local mode (default; unchanged):
 *   --port <n>  | NE_MCP_PORT   (default 4178; 0 = ephemeral)
 *   --host <h>  | NE_MCP_HOST   (default 127.0.0.1; loopback names only)
 *
 * Hosted mode (opt-in, for a separately approved deployment only):
 *   NE_MCP_MODE=hosted  NE_MCP_PUBLIC_ORIGIN=https://<exact host>  PORT=<n>
 *   [NE_MCP_CUSTOM_ORIGIN=https://<exact custom host>]
 *   binds 0.0.0.0:$PORT; refuses to start on missing or unsafe configuration.
 *
 * Both modes: [NE_MCP_MAX_CONCURRENT] [NE_MCP_RATE_LIMIT_PER_MINUTE].
 *
 * The process replaces global `fetch` with a throwing guard: this server
 * performs no outbound network I/O by construction.
 */

import { DEFAULT_HOST, DEFAULT_PORT, HEALTH_SCOPE, NeMcpConfigError, startNeMcpHttpServer } from "./http.js";
import { resolveServeConfig } from "./hosted.js";

globalThis.fetch = (() => {
  throw new Error("Network Evidence MCP v0 performs no outbound network I/O");
}) as typeof fetch;

try {
  const config = resolveServeConfig(process.argv.slice(2), process.env, { host: DEFAULT_HOST, port: DEFAULT_PORT });
  const server = await startNeMcpHttpServer({
    host: config.host,
    port: config.port,
    ...(config.hosted === undefined ? {} : { hosted: config.hosted }),
    ...(config.limits === undefined ? {} : { limits: config.limits }),
    log: (line) => process.stderr.write(`${line}\n`),
  });
  if (server.mode === "hosted") {
    process.stdout.write(
      `Network Evidence MCP v0 [${HEALTH_SCOPE.hosted}] listening on ${server.host}:${server.port}; ` +
        `accepted public origin(s): ${[config.hosted!.publicOrigin, config.hosted!.customOrigin].filter(Boolean).join(", ")}; endpoint /mcp, health /healthz\n`,
    );
  } else {
    process.stdout.write(
      `Network Evidence MCP v0 (local, read-only, offline) listening on ${server.mcpUrl}  health: ${server.url}/healthz\n`,
    );
  }
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
