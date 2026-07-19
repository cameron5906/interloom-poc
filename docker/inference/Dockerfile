# syntax=docker/dockerfile:1
# Eris inference container — llama.cpp llama-server under a supervisor.
# Multi-arch CPU image (linux/amd64 + linux/arm64).
# GPU variant: see Dockerfile.cuda

# Pinned 2026-07-13 from ghcr.io/ggml-org/llama.cpp:server (Ubuntu 24.04 base).
# Verified via `llama-server --help`: --reasoning-format and --reasoning-budget both
# present, plus --mmproj, --jinja, --metrics, --split-mode, --tensor-split.
FROM ghcr.io/ggml-org/llama.cpp@sha256:ae4883b4bf0814bfe44cb8b4cdc5208412f61599200fb8482a96935cdacc184e

# Assumption: llama-server binary is at /app/llama-server in the base image.
# The base image entrypoint is overridden by CMD below.

ENV MODELS_DIR=/models

# jq drives the supervisor's v2 inference.json parsing (arrays of instances, gpus,
# tensorSplit) — sed/grep can't parse that cleanly.
RUN apt-get update \
    && apt-get install -y --no-install-recommends jq \
    && rm -rf /var/lib/apt/lists/*

COPY supervisor.sh /supervisor.sh
RUN chmod +x /supervisor.sh

VOLUME /models

# Port 8080 exposed for compose-internal access (agent-host → inference); additional
# instance ports (8081+) are opened per inference.json, no fixed EXPOSE needed for them.
EXPOSE 8080

# Reflects "supervisor process alive", not any one instance's port — per-instance
# health lives at http://inference:<port>/health and is polled by the daemon.
HEALTHCHECK --interval=10s --timeout=5s --start-period=5s --retries=3 \
    CMD test $(( $(date +%s) - $(stat -c %Y /tmp/supervisor-heartbeat 2>/dev/null || echo 0) )) -lt 30

ENTRYPOINT []
CMD ["/supervisor.sh"]
