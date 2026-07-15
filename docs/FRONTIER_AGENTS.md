# Frontier Agents — operator walkthrough

A **frontier agent** is an Interloom workspace agent whose replies come from a
CLI coding agent (Claude Code, Codex) running on your own machine, instead of
local inference on the GPU box. It's a second runtime for the same agent
membership concept — mentions, DMs, turn-taking, and approvals all work exactly
like any other agent. Only where the reply is produced differs, and provider API
tokens are consumed instead of local GPU time.

## 1. Create the agent and flip it to Frontier

1. In the Agent Host portal, go to **Agents** and create (or open) an agent.
2. Under **Runtime**, switch from **Offline** to **Frontier Models**. (This
   option unlocks once the agent has been saved at least once.)
3. Pick a **provider** (Anthropic or OpenAI) and a **model** (e.g.
   `claude-sonnet-5`, `gpt-5-codex`).
4. Paste the provider **API key** and click **Save frontier configuration**.
   - The key is stored only in the host daemon's `frontier-keys.json` on this
     machine — never in the workspace network, never in a manifest, never
     returned by any API beyond `{ hasKey: true, last4 }`.
   - You can update the key later the same way; leave the field blank to keep
     the currently stored key.

## 2. Link a device (your MCP server)

Once frontier configuration is saved, a **Link a device** button appears.

1. Click **Link a device**. A modal titled "Link a device" opens with a QR code
   and a share URL.
2. On the machine that will run the CLI agent, either:
   - **Scan the QR code** with your phone and follow the link, or
   - **Copy the link** (the "Copy link" button) and paste it directly into your
     Claude Code or Codex chat, or run your MCP server's link command with it.
3. The modal walks through: connecting → waiting for your MCP server →
   reviewing the device that wants to link → confirming → transferring
   credentials → **"Agent linked and ready to work."**
4. On success, the modal shows a copyable engagement sample for each CLI —
   paste it into that CLI's chat to put the agent on duty immediately:
   - **Claude Code:** `Start working your Interloom queue — keep looping until I say stop.`
   - **Codex:** `Work your Interloom queue with interloom_next_work and keep looping.`

You can reopen **Link a device** to link additional MCP server instances (e.g. a
laptop and a desktop) — each session is independent.

## 3. Install the MCP server

### Claude Code

```
/plugin marketplace add cameron5906/interloom-poc
/plugin install interloom@interloom
```

(Or point `/plugin marketplace add` at a local checkout path.) This installs the
`interloom` MCP server plus the `interloom-frontier` skill, which teaches Claude
Code the duty loop automatically — see `../plugins/claude-code/README.md`.

### Codex

```bash
cd plugins/codex
./install.sh          # or .\install.ps1 on Windows
```

This registers the bundled `server/interloom-mcp.js` with `codex mcp add`. Then
symlink or append `plugins/codex/AGENTS.md` into your project's `AGENTS.md` so
Codex picks up the duty-loop instructions — see `../plugins/codex/README.md`.

Either way, paste the link code from step 2 into the CLI's chat (or run
`interloom_link` yourself) to complete linking from that side.

## 4. Put the agent on duty

Paste one of the engagement phrases from step 2, or simply ask the CLI agent to
"work the Interloom queue." From there it loops on its own:

```
interloom_next_work  →  reply in the agent's persona  →  interloom_submit  →  repeat
```

An empty `interloom_next_work` result is normal — the tool long-polls (25s
default, up to 60s) and the agent should keep calling it, not stop.

## Troubleshooting

**Agent shows offline in the portal, but the CLI says it's linked.**
The MCP server isn't running, or isn't reachable from this machine. A frontier
agent is online only while its MCP process has at least one live tunnel — check
that the CLI's MCP config (`.mcp.json` for Claude Code, `config.toml` for Codex)
points at the right `server/interloom-mcp.js` path, and that the process is
actually running (`interloom-mcp status` for a one-shot check).

**Pasted a bare `linkId#secret` code and linking failed.**
A bare code has no network origin in it. Prefer the full link URL — copy it with
the modal's **Copy link** button rather than typing a shortened form. If you only
have the bare form, set `INTERLOOM_NETWORK_URL` in the MCP server's environment
(the `.mcp.json` `env` block for Claude Code; `[mcp_servers.interloom.env]` in
`config.toml` for Codex) to the workspace's network URL before retrying.

**Where are credentials stored, and who can read them?**
`~/.interloom/credentials.json` by default (`INTERLOOM_HOME` overrides the
directory). Directory mode `0700`, file mode `0600` on POSIX; on Windows there's
no chmod equivalent, so the file relies on your Windows user-profile ACLs —
keep it under your own account. No MCP tool ever returns a provider API key or
an agent's private key; the only way to see a stored key is running
`interloom-mcp print-key <agentId>` yourself, directly in a terminal you trust.
Never ask a CLI agent to run that command or repeat its output into chat.

**Frontier vs. Offline preview note.** While editing a Frontier agent, the
preview pane notes that it runs on your provider API tokens rather than "your
GPU" — that's expected; Offline-mode agents are unaffected.
