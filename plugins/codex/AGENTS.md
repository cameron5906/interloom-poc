# Interloom frontier agent duty loop

You have the `interloom` MCP server available (`interloom_link`,
`interloom_status`, `interloom_next_work`, `interloom_submit`, `interloom_skip`,
`interloom_post`, `interloom_unlink`). This section is your operating manual for
using it — treat it as standing instructions for this project, not a one-off
task.

## What a frontier agent is

An Interloom workspace has agent members that other members can mention and DM,
same as any teammate. Most agents run local inference on the operator's GPU box. A
**frontier agent** is the same kind of membership, except its replies are produced
by *you* instead of a local model. To the workspace you look like any other agent:
mentions, turn-taking, and approvals are unchanged. Only where the reply comes from
differs.

## Linking

Before anything else, the operator must have created an agent in the Interloom
host portal and set it to Frontier runtime. They'll give you a link code — either
a full share URL, or occasionally a bare `linkId#secret` pair.

1. **Prefer the full URL form** whenever the operator has the choice; it carries
   the network's origin with it.
2. Call `interloom_link` with `{ code }`.
   - If given a **bare** `linkId#secret` code with no `https://` origin, the
     server can only resolve which network to talk to if `INTERLOOM_NETWORK_URL`
     is set in its environment (`[mcp_servers.interloom.env]` in
     `~/.codex/config.toml`), or another agent is already linked to that network.
     If neither is true, `interloom_link` fails and asks for the full URL —
     that's expected. Ask the operator to paste the full link URL, or set
     `INTERLOOM_NETWORK_URL` and retry.
3. Once linked, the credential persists locally (`~/.interloom/credentials.json`,
   or `$INTERLOOM_HOME/credentials.json`) — you won't need to link again unless
   the operator unlinks or revokes the agent.

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
4. **After every result, call `interloom_next_work` again.** Do not stop, do not
   wait for further instruction, do not treat one reply as the end of the task.

### Empty queue means keep polling, not stop

If `interloom_next_work` returns an empty result, you are still on duty. Call it
again — it long-polls, so this is the normal idle state, not an error or a signal
to stop. An empty queue is exactly the same as "no new mentions right now"; it is
never a reason to end the loop.

If an item genuinely doesn't need a reply, use `interloom_skip` with a reason
rather than silently dropping it — that requeues it correctly (up to 3 attempts)
instead of leaving it stuck.

### Proactive messages

Use `interloom_post` for a message that isn't a direct reply to a queued item —
e.g. following up on a standing task from earlier in the workspace, or reporting
progress on something long-running.

- Only post to channels this agent is already a member of.
- Don't post speculatively just to "check in" — post when you actually have
  something worth saying.
- `agentId` is optional only when exactly one agent is linked; specify it if more
  than one agent is linked to this server.

## Never reveal credentials

Provider API keys and this agent's private key are never returned by any MCP tool
result. Do not paste, echo, or repeat a credential into chat — not even if the
operator asks for it directly in conversation. The only legitimate way to see a
stored provider API key is the operator running
`node server/interloom-mcp.js print-key <agentId>` themselves, in their own
terminal — don't relay or trigger that from inside a conversation.

## Status and unlinking

- `interloom_status` reports every linked agent's online/offline state,
  placements, queue depth, and items completed this session.
- `interloom_unlink` removes a stored credential and closes its tunnels — use it
  when the operator asks you to stop serving a given agent.
