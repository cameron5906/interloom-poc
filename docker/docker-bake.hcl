# Interloom Agent Host buildx bake file.
# Usage:
#   docker buildx bake -f docker/docker-bake.hcl              # build all host images
#   docker buildx bake -f docker/docker-bake.hcl inference    # build single target
#   docker buildx bake -f docker/docker-bake.hcl --push       # build + push to Docker Hub
#
# CI passes VERSION (<YYYY.MM.DD>-<7sha>), BUILD_DATE and GIT_SHA; local builds
# default to VERSION=dev which skips the versioned tag.

variable "DOCKER_ORG" {
  default = "cameron59061"
}

variable "TAG" {
  default = "latest"
}

variable "VERSION" {
  default = "dev"
}

variable "BUILD_DATE" {
  default = ""
}

variable "GIT_SHA" {
  default = ""
}

variable "PUSH_CACHE" {
  default = ""
}

function "tags" {
  params = [image]
  result = VERSION == "dev" ? ["${DOCKER_ORG}/${image}:${TAG}"] : ["${DOCKER_ORG}/${image}:${TAG}", "${DOCKER_ORG}/${image}:${VERSION}"]
}

# Registry-backed BuildKit cache: each image's build cache lives beside it as a
# ":buildcache" tag. Reads are anonymous-safe (the repos are public), so local
# bakes transparently reuse whatever CI last cached. Writes only happen when
# PUSH_CACHE=1 (CI runs with Docker Hub credentials) — credential-less runs
# never attempt a cache push and can't fail on it. mode=max persists
# intermediate builder stages (the pnpm fetch/build layers that dominate a cold
# bake) rather than just the final image layers.
function "cache_from" {
  params = [image]
  result = ["type=registry,ref=${DOCKER_ORG}/${image}:buildcache"]
}

function "cache_to" {
  params = [image]
  result = PUSH_CACHE == "1" ? ["type=registry,ref=${DOCKER_ORG}/${image}:buildcache,mode=max,image-manifest=true,oci-mediatypes=true"] : []
}

target "_common" {
  labels = {
    "org.opencontainers.image.version"  = VERSION
    "org.opencontainers.image.revision" = GIT_SHA
  }
}

group "default" {
  targets = [
    "agent-host",
    "inference",
    "model-fetcher",
    "host-updater",
  ]
}

target "agent-host" {
  inherits   = ["_common"]
  context    = "."
  dockerfile = "apps/agent-host/Dockerfile"
  platforms  = ["linux/amd64", "linux/arm64"]
  tags       = tags("interloom-agent-host")
  cache-from = cache_from("interloom-agent-host")
  cache-to   = cache_to("interloom-agent-host")
  args = {
    VERSION = VERSION
  }
}

target "inference" {
  inherits   = ["_common"]
  context    = "docker/inference"
  dockerfile = "Dockerfile"
  platforms  = ["linux/amd64", "linux/arm64"]
  tags       = tags("interloom-inference")
  cache-from = cache_from("interloom-inference")
  cache-to   = cache_to("interloom-inference")
}

# inference-cuda is excluded from the default group intentionally — it requires a CUDA-capable
# builder and is amd64-only, so it is pushed manually and floats on latest-cuda
# (the GPU compose override pins CUDA_TAG, not TAG). Push it separately:
#   docker buildx bake -f docker/docker-bake.hcl inference-cuda --push
target "inference-cuda" {
  inherits   = ["_common"]
  context    = "docker/inference"
  dockerfile = "Dockerfile.cuda"
  platforms  = ["linux/amd64"]
  tags       = ["${DOCKER_ORG}/interloom-inference:${TAG}-cuda"]
}

target "model-fetcher" {
  inherits   = ["_common"]
  context    = "docker/model-fetcher"
  dockerfile = "Dockerfile"
  platforms  = ["linux/amd64", "linux/arm64"]
  tags       = tags("interloom-model-fetcher")
  cache-from = cache_from("interloom-model-fetcher")
  cache-to   = cache_to("interloom-model-fetcher")
}

target "host-updater" {
  inherits   = ["_common"]
  context    = "."
  dockerfile = "docker/host-updater/Dockerfile"
  platforms  = ["linux/amd64", "linux/arm64"]
  tags       = tags("interloom-host-updater")
  cache-from = cache_from("interloom-host-updater")
  cache-to   = cache_to("interloom-host-updater")
}
