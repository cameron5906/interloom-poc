#!/usr/bin/env pwsh
$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverPath = Join-Path $scriptDir "server/interloom-mcp.js"

if (-not (Test-Path $serverPath)) {
    Write-Error "interloom-mcp bundle not found at $serverPath`nrun: pnpm --filter @interloom/frontier-mcp bundle"
    exit 1
}

if (-not (Get-Command codex -ErrorAction SilentlyContinue)) {
    Write-Error "codex CLI not found on PATH -- install it first, then re-run this script"
    exit 1
}

$existing = & codex mcp list 2>$null
if ($existing -match '^interloom') {
    Write-Host "interloom MCP server is already registered with codex -- nothing to do"
    Write-Host "(to relink after moving this checkout: codex mcp remove interloom, then re-run this script)"
    exit 0
}

& codex mcp add interloom -- node $serverPath
Write-Host "registered interloom MCP server with codex (node $serverPath)"
