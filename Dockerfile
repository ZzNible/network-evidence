# Network Evidence MCP hosted preview — Cloud Run / generic OCI, no external RPC.
# Build context MUST be the repository root (npm workspaces and pinned cases).
FROM node:22-alpine
WORKDIR /srv/network-evidence
COPY package.json package-lock.json ./
COPY packages ./packages
COPY examples ./examples
RUN npm ci --include=dev --no-audit --no-fund
ENV NODE_ENV=production
USER node
EXPOSE 8080
CMD ["npm", "run", "mcp:serve"]
