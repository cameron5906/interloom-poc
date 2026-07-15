#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
server_path="$script_dir/server/interloom-mcp.js"

if [ ! -f "$server_path" ]; then
  echo "interloom-mcp bundle not found at $server_path" >&2
  echo "run: pnpm --filter @interloom/frontier-mcp bundle" >&2
  exit 1
fi

if ! command -v codex >/dev/null 2>&1; then
  echo "codex CLI not found on PATH — install it first, then re-run this script" >&2
  exit 1
fi

if codex mcp list 2>/dev/null | grep -q '^interloom'; then
  echo "interloom MCP server is already registered with codex — nothing to do"
  echo "(to relink after moving this checkout: codex mcp remove interloom, then re-run this script)"
  exit 0
fi

codex mcp add interloom -- node "$server_path"
echo "registered interloom MCP server with codex (node $server_path)"
