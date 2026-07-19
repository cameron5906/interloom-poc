#!/bin/sh
# stage-images.sh — Local staging script for Eris Docker images.
#
# Default: builds all targets for local arch (no push), loaded into local daemon.
# Pass --push to build multi-arch and push to Docker Hub (requires docker login).
#
# The bake file targets linux/amd64 + linux/arm64 (inference-cuda: amd64 only).
# For --load (single-arch verify), platforms are overridden to the detected local arch.
#
# Usage:
#   ./docker/stage-images.sh                       # local verify build
#   ./docker/stage-images.sh --push               # build multi-arch + push
#   ./docker/stage-images.sh --target network     # single target
#   DOCKER_ORG=myorg TAG=v1.0.0 ./docker/stage-images.sh --push

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
BAKE_FILE="${SCRIPT_DIR}/docker-bake.hcl"

PUSH=0
TARGET=""
DOCKER_ORG="${DOCKER_ORG:-cameron59061}"
TAG="${TAG:-local}"

while [ $# -gt 0 ]; do
  case "$1" in
    --push)    PUSH=1 ;;
    --target)  TARGET="$2"; shift ;;
    --org)     DOCKER_ORG="$2"; shift ;;
    --tag)     TAG="$2"; shift ;;
    *)         echo "Unknown option: $1"; exit 1 ;;
  esac
  shift
done

# Detect local platform
ARCH="$(uname -m)"
case "$ARCH" in
  arm64|aarch64) LOCAL_PLATFORM="linux/arm64" ;;
  *)             LOCAL_PLATFORM="linux/amd64" ;;
esac

cd "$REPO_ROOT"

printf '\nEris image staging\n'
printf '  Bake file : %s\n' "$BAKE_FILE"
printf '  DOCKER_ORG: %s\n' "$DOCKER_ORG"
printf '  TAG       : %s\n' "$TAG"
printf '  Platform  : %s (local verify)\n\n' "$LOCAL_PLATFORM"

export DOCKER_ORG TAG

BASE_ARGS="-f $BAKE_FILE"
if [ -n "$TARGET" ]; then
  BASE_ARGS="$BASE_ARGS $TARGET"
fi

if [ "$PUSH" = "1" ]; then
  printf 'Building and pushing all targets (multi-arch)...\n'
  # shellcheck disable=SC2086
  docker buildx bake $BASE_ARGS --push
else
  printf 'Building single-arch verify (load to local daemon)...\n'
  # shellcheck disable=SC2086
  docker buildx bake $BASE_ARGS \
    --set "*.platform=${LOCAL_PLATFORM}" \
    --load

  printf '\nSingle-arch verify build complete.\n\n'
  printf 'To push multi-arch images to Docker Hub:\n'
  printf '  docker login\n'
  printf '  DOCKER_ORG=%s TAG=%s ./docker/stage-images.sh --push\n\n' "$DOCKER_ORG" "$TAG"
fi
