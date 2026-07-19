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
COPY packages/link-client/package.json packages/link-client/
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
    pnpm --filter @interloom/link-client build && \
    pnpm --filter @interloom/agent-host-portal build && \
    pnpm --filter @interloom/agent-host build

# ── Stage 4: nvidia-smi provider ──────────────────────────────────────────────
# node:22-slim ships no nvidia-smi. The NVIDIA container runtime injects the
# driver libraries (libnvidia-ml) at container start but not the binary itself,
# so /api/system would report no GPUs. CUDA base images do not ship the binary
# either (it belongs to the driver's utils package), so install it from the
# Ubuntu restricted pool. NVML is backward compatible: this binary loads the
# newer injected driver library at runtime. amd64 only — arm64 hosts run CPU
# inference today and WSL hosts are probed at /usr/lib/wsl/lib/nvidia-smi.
FROM ubuntu:22.04 AS nvidia-smi
ARG TARGETARCH
RUN mkdir -p /out && \
    if [ "$TARGETARCH" = "amd64" ]; then \
      apt-get update && \
      apt-get install -y --no-install-recommends nvidia-utils-535 && \
      cp /usr/bin/nvidia-smi /out/nvidia-smi; \
    fi

# ── Stage 5: runtime ──────────────────────────────────────────────────────────
# glibc base (not alpine): GPU telemetry needs a glibc-linked nvidia-smi and the
# NVIDIA runtime's injected driver libraries, neither of which runs on musl.
FROM node:22-slim AS runner
RUN corepack enable && corepack prepare pnpm@10.13.1 --activate
WORKDIR /repo

# nvidia-smi binary for GPU telemetry (amd64; empty dir elsewhere); the driver
# library is injected at runtime.
COPY --from=nvidia-smi /out/ /usr/bin/

# Manifests needed for workspace-layout install
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/keys/package.json        packages/keys/
COPY packages/ui/package.json          packages/ui/
COPY apps/agent-host/package.json      apps/agent-host/
COPY apps/agent-host/web/package.json  apps/agent-host/web/

# Install real (non-symlinked) node_modules in workspace layout (prod only).
RUN pnpm install --frozen-lockfile --prod --filter @interloom/agent-host...

# Built artefacts from builder
COPY --from=builder /repo/packages/protocol/dist   packages/protocol/dist
COPY --from=builder /repo/packages/keys/dist        packages/keys/dist
COPY --from=builder /repo/apps/agent-host/dist      apps/agent-host/dist

# Portal SPA — static.ts resolves __dirname (dist/) + ../web/dist
COPY --from=builder /repo/apps/agent-host/web/dist  apps/agent-host/web/dist

WORKDIR /repo/apps/agent-host

ARG VERSION=dev
ENV NODE_ENV=production \
    PORT=7420 \
    DATA_DIR=/data \
    MODELS_DIR=/models \
    NETWORK_URL=https://interloom-net.tryeris.com \
    INFERENCE_URL=http://inference:8080 \
    FETCHER_URL=http://model-fetcher:7423 \
    HOST_VERSION=$VERSION \
    UPDATER_URL=http://updater:7424

VOLUME /data
VOLUME /models
EXPOSE 7420

CMD ["node", "dist/index.js"]
