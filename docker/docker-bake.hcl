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

# CI can build each arch on its own native runner instead of one QEMU-emulated
# multi-platform bake. Setting ARCH narrows every target to that single
# platform; left unset (local/dev bakes, and any single-runner invocation)
# every target still builds both, unchanged.
variable "ARCH" {
  default = ""
}

# Paired with ARCH: per-arch CI jobs push straight to Docker Hub by digest,
# not by tag — a merge job applies :latest/:VERSION once both arch digests
# exist (docker buildx imagetools create). Left unset, targets fall back to the
# original tag-and-push behavior gated by `docker buildx bake --push`.
variable "DIGEST_PUSH" {
  default = ""
}

function "platforms" {
  params = []
  result = ARCH == "" ? ["linux/amd64", "linux/arm64"] : ["linux/${ARCH}"]
}

function "tags" {
  params = [image]
  result = DIGEST_PUSH == "1" ? [] : (VERSION == "dev" ? ["${DOCKER_ORG}/${image}:${TAG}"] : ["${DOCKER_ORG}/${image}:${TAG}", "${DOCKER_ORG}/${image}:${VERSION}"])
}

function "cuda_tags" {
  params = []
  result = DIGEST_PUSH == "1" ? [] : (VERSION == "dev" ? ["${DOCKER_ORG}/interloom-inference:${TAG}-cuda"] : ["${DOCKER_ORG}/interloom-inference:${TAG}-cuda", "${DOCKER_ORG}/interloom-inference:${VERSION}-cuda"])
}

# Digest-push output overrides the default tag-based exporter: no name-canonical
# tag races between the two arch jobs writing the same ":latest" concurrently —
# each pushes an untagged, digest-addressed image and the merge job tags once.
function "output" {
  params = [image]
  result = DIGEST_PUSH == "1" ? ["type=image,name=${DOCKER_ORG}/${image},push-by-digest=true,name-canonical=true,push=true"] : []
}

# Registry-backed BuildKit cache: each image's build cache lives beside it as a
# ":buildcache" tag. Reads are anonymous-safe (the repos are public), so local
# bakes transparently reuse whatever CI last cached. Writes only happen when
# PUSH_CACHE=1 (CI runs with Docker Hub credentials) — credential-less runs
# never attempt a cache push and can't fail on it. mode=max persists
# intermediate builder stages (the pnpm fetch/build layers that dominate a cold
# bake) rather than just the final image layers.
#
# Cache refs are arch-scoped (":buildcache-<arch>") whenever ARCH is set so
# per-arch CI jobs don't clobber each other's cache; unset ARCH (local bakes)
# keeps the original shared ref.
function "cache_from" {
  params = [image]
  result = ARCH == "" ? ["type=registry,ref=${DOCKER_ORG}/${image}:buildcache"] : ["type=registry,ref=${DOCKER_ORG}/${image}:buildcache-${ARCH}"]
}

function "cache_to" {
  params = [image]
  result = PUSH_CACHE != "1" ? [] : (ARCH == "" ? ["type=registry,ref=${DOCKER_ORG}/${image}:buildcache,mode=max,image-manifest=true,oci-mediatypes=true"] : ["type=registry,ref=${DOCKER_ORG}/${image}:buildcache-${ARCH},mode=max,image-manifest=true,oci-mediatypes=true"])
}

target "_common" {
  attest = ["type=provenance,mode=max", "type=sbom"]
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
  platforms  = platforms()
  tags       = tags("interloom-agent-host")
  output     = output("interloom-agent-host")
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
  platforms  = platforms()
  tags       = tags("interloom-inference")
  output     = output("interloom-inference")
  cache-from = cache_from("interloom-inference")
  cache-to   = cache_to("interloom-inference")
}

# inference-cuda is amd64-only and therefore built by the amd64 release lane
# separately from the multi-arch default group. It needs no GPU at build time.
target "inference-cuda" {
  inherits   = ["_common"]
  context    = "docker/inference"
  dockerfile = "Dockerfile.cuda"
  platforms  = ["linux/amd64"]
  tags       = cuda_tags()
  output     = output("interloom-inference")
  cache-from = ["type=registry,ref=${DOCKER_ORG}/interloom-inference:buildcache-cuda-amd64"]
  cache-to   = PUSH_CACHE != "1" ? [] : ["type=registry,ref=${DOCKER_ORG}/interloom-inference:buildcache-cuda-amd64,mode=max,image-manifest=true,oci-mediatypes=true"]
}

target "model-fetcher" {
  inherits   = ["_common"]
  context    = "docker/model-fetcher"
  dockerfile = "Dockerfile"
  platforms  = platforms()
  tags       = tags("interloom-model-fetcher")
  output     = output("interloom-model-fetcher")
  cache-from = cache_from("interloom-model-fetcher")
  cache-to   = cache_to("interloom-model-fetcher")
}

target "host-updater" {
  inherits   = ["_common"]
  context    = "."
  dockerfile = "docker/host-updater/Dockerfile"
  platforms  = platforms()
  tags       = tags("interloom-host-updater")
  output     = output("interloom-host-updater")
  cache-from = cache_from("interloom-host-updater")
  cache-to   = cache_to("interloom-host-updater")
}
