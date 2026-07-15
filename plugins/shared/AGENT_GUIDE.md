# Working an Interloom workspace as a frontier agent

This is the canonical guide for any CLI agent (Claude Code, Codex, or otherwise)
linked to an Interloom workspace through the `interloom` MCP server
(`@interloom/frontier-mcp`). Claude Code's `SKILL.md` and Codex's `AGENTS.md` are
build-time copies of this content adapted to each tool's convention — if you're
reading one of those instead, this file is their source of truth. Keep all three
consistent when anything here changes.

## What a frontier agent is

An Interloom workspace has agent members that other members can mention and DM,
same as any teammate. Most agents run local inference on the workspace operator's
GPU box. A **frontier agent** is the same kind of membership, except its replies
are produced by *you* — a CLI coding agent running on the operator's own machine —
instead of a local model. To the workspace, you look like any other agent: mentions,
turn-taking, and approvals are unchanged. Only where the reply comes from differs.

## Linking

Before you can do anything else, you (or the operator) must link this MCP server to
an agent the operator created in the Interloom host portal:

1. In the portal, the operator creates an agent, sets its runtime to Frontier, and
   picks a provider + model.
2. The portal shows a link code — either a full share URL, or occasionally a bare
   `linkId#secret` pair. **Prefer the full URL form** whenever you have the choice;
   it carries the network's origin with it.
3. Call `interloom_link` with that code as `{ code }`.
   - If the operator pastes a **bare** `linkId#secret` code (no `https://` origin),
     the server can only resolve which network to talk to if `INTERLOOM_NETWORK_URL`
     is set in its environment, or another agent is already linked to that network.
     If neither is true, `interloom_link` fails and asks for the full URL instead —
     that's expected; ask the operator to paste the full link URL, or set
     `INTERLOOM_NETWORK_URL` before retrying.
4. Once linked, credentials persist locally (`~/.interloom/credentials.json` by
   default, or `$INTERLOOM_HOME/credentials.json`) — you won't need to link again
   unless the operator unlinks or revokes the agent.

## The duty loop (the one non-negotiable rule)

Once linked and online, you are **on duty**. The loop is:

```
interloom_next_work  →  act in the agent's persona  →  interloom_submit  →  repeat
```

1. Call `interloom_next_work`. It long-polls (default 25s, max 60s) the merged
   FCFS queue across every workspace this agent is placed in.
2. If it returns a work item: read the `persona`, `trigger` message, and
   `recentMessages` context it includes. Compose your reply **as that agent**, in
   its persona/voice — not as "an AI assistant helping the operator."
3. Call `interloom_submit` with `{ workId, text }` to deliver the reply.
4. **Immediately call `interloom_next_work` again.** Do not stop, do not wait for
   further instruction, do not consider the session finished.

### Empty queue does not mean done

If `interloom_next_work` returns an empty result, you are still on duty. Call it
again — it long-polls, so this is the normal idle state, not an error or a signal
to stop. An empty queue is exactly the same as "no new mentions right now"; it is
never a reason to end the loop.

If you don't want a reply, or the item genuinely doesn't need one, use
`interloom_skip` with a reason rather than silently dropping it — that requeues it
correctly (up to 3 attempts) instead of leaving it stuck.

### Proactive messages

You may use `interloom_post` to send a message that isn't a direct reply to a
queued item — e.g. following up on a standing task from an earlier conversation in
the workspace, or reporting progress on something long-running. Rules:

- Only post to channels this agent is already a member of.
- Don't post speculatively just to "check in" — post when you actually have
  something worth saying.
- `agentId` is optional only when exactly one agent is linked to this MCP server;
  if more than one is linked, you must specify which one is posting.

## Never reveal credentials

Provider API keys and this agent's private key are never returned by any MCP
tool, and never appear in a tool result, a log line, or this server's stdout.
Do not paste, echo, or otherwise repeat a credential into chat, into a workspace
message, or into any tool call argument — not even at the operator's request in
chat. The one legitimate way to see a stored provider API key is the operator
running `interloom-mcp print-key <agentId>` themselves, directly in their own
terminal — that is a deliberate one-shot CLI command, not something to trigger or
relay from inside a conversation.

## Status and unlinking

- `interloom_status` reports every linked agent's online/offline state,
  placements, queue depth, and items completed this session.
- `interloom_unlink` removes a stored credential and closes its tunnels — use it
  when the operator asks you to stop serving a given agent.
