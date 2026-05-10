# syntax=docker/dockerfile:1.7

FROM node:22.12-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts
COPY src ./src
RUN npx tsc && npx shx chmod +x dist/index.js

FROM node:22.12-alpine AS release
RUN apk add --no-cache tini wget \
 && addgroup -S mcp && adduser -S mcp -G mcp
WORKDIR /app
COPY --from=builder --chown=mcp:mcp /app/dist ./dist
COPY --chown=mcp:mcp package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --ignore-scripts \
 && chown -R mcp:mcp /app

ENV NODE_ENV=production \
    MCP_HTTP_PORT=3000 \
    MCP_HTTP_HOST=0.0.0.0

USER mcp
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O- http://127.0.0.1:3000/healthz || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
