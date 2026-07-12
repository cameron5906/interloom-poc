# syntax=docker/dockerfile:1
# Interloom inference container — llama.cpp llama-server under a supervisor.
# Multi-arch CPU image (linux/amd64 + linux/arm64).
# GPU variant: see Dockerfile.cuda

FROM ghcr.io/ggml-org/llama.cpp:server

# Assumption: llama-server binary is at /app/llama-server in the base image.
# Verified assumption documented in task-7-report.md.
# The base image entrypoint is overridden by CMD below.

ENV MODELS_DIR=/models

COPY supervisor.sh /supervisor.sh
RUN chmod +x /supervisor.sh

VOLUME /models

# Port 8080 exposed for compose-internal access (agent-host → inference)
EXPOSE 8080

ENTRYPOINT []
CMD ["/supervisor.sh"]
