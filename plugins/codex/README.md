# Eris Frontier Agent — Codex setup

Lets Codex work an Eris workspace as a linked frontier agent over the
`interloom` MCP server bundled in this directory (`server/interloom-mcp.js`).

Codex has no plugin/marketplace system, so setup is two small steps: register
the MCP server, and append the duty-loop instructions to your project's
`AGENTS.md`.

## 1. Register the MCP server

Easiest — run the install script from this directory (idempotent; safe to
re-run):

```bash
./install.sh          # macOS/Linux
```

```powershell
.\install.ps1          # Windows
```

Both resolve this directory's absolute path and run:

```
codex mcp add interloom -- node <abs-path>/plugins/codex/server/interloom-mcp.js
```

Or add it to `~/.codex/config.toml` by hand:

```toml
[mcp_servers.interloom]
command = "node"
args = ["<abs-path>/plugins/codex/server/interloom-mcp.js"]
```

## 2. Add the duty-loop instructions to AGENTS.md

Codex reads `AGENTS.md` in your project as first-class instructions — there is
no separate skill-file convention like Claude Code's. Either:

- **Symlink** this directory's `AGENTS.md` into your project root (or wherever
  Codex reads `AGENTS.md` from), or
- **Append** its contents to your existing `AGENTS.md`.

`AGENTS.md` here is a build-time copy of `../shared/AGENT_GUIDE.md` adapted to
Codex's convention — keep it consistent with that file and with the Claude Code
plugin's `SKILL.md` if you edit any of them.

## Bare link codes need a network URL

If the operator gives you a bare `linkId#secret` code (no `https://` origin),
`interloom_link` needs to know which network to talk to. Prefer the full link
URL whenever it's available. If you only have the bare form, set
`INTERLOOM_NETWORK_URL` in the `[mcp_servers.interloom.env]` table of
`config.toml` (or export it before running `install.sh`/`install.ps1`) before
linking.

## What's bundled

`server/interloom-mcp.js` is a committed, single-file esbuild bundle of
`packages/frontier-mcp` — a documented exception to "no build artifacts in
git" (Codex has no build step to produce it for you). Whenever
`packages/frontier-mcp/src` changes, rebuild and commit the refreshed copy in
the same commit:

```
pnpm --filter @interloom/frontier-mcp bundle
```

## Credentials

Linking persists a credential to `~/.interloom/credentials.json` (or
`$INTERLOOM_HOME/credentials.json`), directory mode `0700` / file mode `0600`
on POSIX; on Windows this relies on your user-profile ACLs instead. Provider
API keys and agent private keys never appear in an MCP tool result or in this
server's logs (stderr only). To see a stored provider API key yourself, run
`node server/interloom-mcp.js print-key <agentId>` directly in a terminal you
trust — never ask Codex to run or relay that command's output into chat.
