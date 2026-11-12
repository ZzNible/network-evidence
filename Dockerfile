# Network Evidence MCP hosted preview — Cloud Run / generic OCI, no external RPC.
# Build context MUST be the repository root (npm workspaces and pinned cases).
# Immutable multi-architecture Node 22 Alpine image index (amd64 + arm64).
FROM node:22-alpine@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202
WORKDIR /srv/network-evidence
COPY package.json package-lock.json ./
COPY LICENSE README.md SECURITY_BOUNDARIES.md ./
# Distribute only public-facing runtime/reproduction notices, not internal runbooks.
COPY docs/release/REPRODUCTION.md ./docs/release/REPRODUCTION.md
COPY docs/distribution/MCP_PRIVACY_POLICY.md ./docs/distribution/MCP_PRIVACY_POLICY.md
COPY packages ./packages
COPY examples ./examples
# Restrictive source archives (0600/0700) must still be readable by USER node.
# Keep root ownership: the runtime may read source but cannot change it.
RUN npm ci --include=dev --no-audit --no-fund && chmod -R a+rX /srv/network-evidence
ENV NODE_ENV=production
USER node
EXPOSE 8080
CMD ["npm", "run", "mcp:serve"]
