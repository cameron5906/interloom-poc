# stage-images.ps1 — Local staging script for Interloom Docker images.
#
# Default behavior: builds all targets for the local arch (no push).
# Pass -Push to also push to Docker Hub (requires docker login).
#
# The bake file targets linux/amd64 and linux/arm64 (except inference-cuda: amd64 only).
# Multi-arch builds require a docker buildx builder with multi-platform support.
# For local --load (single-arch), set --set '*.platform=linux/amd64' (or arm64).
#
# Usage:
#   .\docker\stage-images.ps1                    # build to local cache (verify only)
#   .\docker\stage-images.ps1 -Push              # build + push
#   .\docker\stage-images.ps1 -Target network    # single target

param(
  [switch]$Push,
  [string]$Target = "",
  [string]$DockerOrg = "cameron5906",
  [string]$Tag = "local"
)

$ErrorActionPreference = "Stop"
$BakeFile = Join-Path $PSScriptRoot "docker-bake.hcl"
$RepoRoot = Split-Path $PSScriptRoot -Parent

Set-Location $RepoRoot

# Detect local platform for single-arch verify builds
$arch = docker version --format '{{.Server.Arch}}' 2>$null
if ($arch -eq "aarch64" -or $arch -eq "arm64") {
  $LocalPlatform = "linux/arm64"
} else {
  $LocalPlatform = "linux/amd64"
}

Write-Host ""
Write-Host "Interloom image staging"
Write-Host "  Bake file : $BakeFile"
Write-Host "  DOCKER_ORG: $DockerOrg"
Write-Host "  TAG       : $Tag"
Write-Host "  Platform  : $LocalPlatform (local verify)"
Write-Host ""

$env:DOCKER_ORG = $DockerOrg
$env:TAG        = $Tag

$BaseArgs = @(
  "buildx", "bake",
  "-f", $BakeFile
)

if ($Target -ne "") {
  $BaseArgs += $Target
}

if ($Push) {
  Write-Host "Building and pushing all targets (multi-arch)..."
  & docker @BaseArgs "--push"
} else {
  Write-Host "Building single-arch verify (load to local daemon)..."
  # --load only works with single platform; use --set to override platforms
  & docker @BaseArgs "--set", "*.platform=$LocalPlatform", "--load"
  Write-Host ""
  Write-Host "Single-arch verify build complete."
  Write-Host ""
  Write-Host "To push multi-arch images to Docker Hub:"
  Write-Host "  docker login"
  Write-Host "  .\docker\stage-images.ps1 -Push -DockerOrg $DockerOrg -Tag $Tag"
}
