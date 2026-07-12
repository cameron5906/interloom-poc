# Interloom Agent Host buildx bake file.
# Usage:
#   docker buildx bake -f docker/docker-bake.hcl              # build all host images
#   docker buildx bake -f docker/docker-bake.hcl inference    # build single target
#   docker buildx bake -f docker/docker-bake.hcl --push       # build + push to Docker Hub

variable "DOCKER_ORG" {
  default = "cameron59061"
}

variable "TAG" {
  default = "latest"
}

group "default" {
  targets = [
    "agent-host",
    "inference",
    "model-fetcher",
  ]
}

target "agent-host" {
  context    = "."
  dockerfile = "apps/agent-host/Dockerfile"
  platforms  = ["linux/amd64", "linux/arm64"]
  tags       = ["${DOCKER_ORG}/interloom-agent-host:${TAG}"]
}

target "inference" {
  context    = "docker/inference"
  dockerfile = "Dockerfile"
  platforms  = ["linux/amd64", "linux/arm64"]
  tags       = ["${DOCKER_ORG}/interloom-inference:${TAG}"]
}

# inference-cuda is excluded from the default group intentionally — it requires a CUDA-capable
# builder and is amd64-only. Push it separately:
#   docker buildx bake -f docker/docker-bake.hcl inference-cuda --push
target "inference-cuda" {
  context    = "docker/inference"
  dockerfile = "Dockerfile.cuda"
  platforms  = ["linux/amd64"]
  tags       = ["${DOCKER_ORG}/interloom-inference:${TAG}-cuda"]
}

target "model-fetcher" {
  context    = "docker/model-fetcher"
  dockerfile = "Dockerfile"
  platforms  = ["linux/amd64", "linux/arm64"]
  tags       = ["${DOCKER_ORG}/interloom-model-fetcher:${TAG}"]
}
