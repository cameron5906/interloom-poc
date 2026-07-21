# syntax=docker/dockerfile:1
# Eris host-updater sidecar. Needs the docker CLI + compose plugin to
# operate the host-owner stack through the mounted docker socket.
FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2
RUN apk add --no-cache docker-cli docker-cli-compose
WORKDIR /app
COPY docker/host-updater/lib.mjs docker/host-updater/server.mjs ./
ENV PORT=7424 \
    HOST_CONFIG_DIR=/host-config \
    NETWORK_URL=https://interloom-net.tryeris.com
EXPOSE 7424
CMD ["node", "server.mjs"]
