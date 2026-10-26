# Network Evidence MCP — offline preview or opt-in fixed read-only Base/Solana RPC beta.
# Build context MUST be the repository root (npm workspaces and pinned cases).
FROM node:22.23.4-alpine3.24@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914
WORKDIR /srv/network-evidence
COPY package.json package-lock.json ./
COPY packages ./packages
COPY examples ./examples
RUN npm ci --include=dev --no-audit --no-fund
ENV NODE_ENV=production
USER node
EXPOSE 8080
CMD ["npm", "run", "mcp:serve"]
