# syntax=docker/dockerfile:1
# Build context: repo root

# ── Stage 1: base with pnpm ───────────────────────────────────────────────────
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.13.1 --activate

# ── Stage 2: fetch deps ───────────────────────────────────────────────────────
FROM base AS fetch
WORKDIR /repo
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/keys/package.json        packages/keys/
COPY packages/ui/package.json          packages/ui/
COPY apps/agent-host/package.json      apps/agent-host/
COPY apps/agent-host/web/package.json  apps/agent-host/web/
RUN pnpm fetch

# ── Stage 3: install + build ──────────────────────────────────────────────────
FROM fetch AS builder
WORKDIR /repo
COPY packages/ packages/
COPY apps/agent-host/ apps/agent-host/
COPY tsconfig.base.json turbo.json ./
RUN pnpm install --frozen-lockfile --offline
RUN pnpm --filter @interloom/protocol build && \
    pnpm --filter @interloom/keys build && \
    pnpm --filter @interloom/ui build && \
    pnpm --filter @interloom/agent-host-portal build && \
    pnpm --filter @interloom/agent-host build

# ── Stage 4: runtime ──────────────────────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app

COPY --from=builder /repo/apps/agent-host/dist ./dist
COPY --from=builder /repo/apps/agent-host/package.json ./
COPY --from=builder /repo/apps/agent-host/node_modules ./node_modules
# Workspace packages needed at runtime
COPY --from=builder /repo/packages/protocol/dist ./node_modules/@interloom/protocol/dist
COPY --from=builder /repo/packages/protocol/package.json ./node_modules/@interloom/protocol/
COPY --from=builder /repo/packages/keys/dist ./node_modules/@interloom/keys/dist
COPY --from=builder /repo/packages/keys/package.json ./node_modules/@interloom/keys/

# Portal SPA — static.ts resolves __dirname (dist/) + ../../web/dist
# __dirname=/app/dist → path.resolve('/app/dist', '../../web/dist') = '/web/dist'
COPY --from=builder /repo/apps/agent-host/web/dist /web/dist

ENV NODE_ENV=production \
    PORT=7420 \
    DATA_DIR=/data \
    MODELS_DIR=/models \
    NETWORK_URL=https://interloom-net.tryeris.com \
    INFERENCE_URL=http://inference:8080 \
    FETCHER_URL=http://model-fetcher:7423

VOLUME /data
VOLUME /models
EXPOSE 7420

CMD ["node", "dist/index.js"]
