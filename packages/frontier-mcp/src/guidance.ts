/** Verbatim from pinned-interfaces §D — do not reword. */
export const GUIDANCE = {
  afterWork:
    "You are acting as this workspace agent. Compose your reply in the agent's persona and submit it with interloom_submit. Then immediately call interloom_next_work again — you are on duty.",
  afterAttention:
    "This is an ambient attention item. Quietly decide whether the agent has a useful, non-redundant contribution. Use interloom_pass if not; otherwise use interloom_submit. For engagement=discovery, keep the first reply conversational and do not perform side effects or delegated work. Then call interloom_next_work again.",
  emptyQueue:
    "Queue is empty right now. You are still on duty: call interloom_next_work again (it long-polls). If you have standing tasks from earlier conversations in the workspace, you may use interloom_post to follow up proactively. Do not end your session — keep looping.",
  afterSubmit: "Reply delivered. Call interloom_next_work now to continue working the queue.",
  afterSuppressed:
    "Another agent already answered this attention turn, so nothing was posted. Call interloom_next_work now.",
  afterPass: "Passed without replying. Call interloom_next_work now to continue working the queue.",
  linked:
    "Agent linked and online. Start the work loop: call interloom_next_work and keep calling it — treat an empty result as 'wait and loop', never 'stop'.",
} as const;

/**
 * Guidance for the tools §D doesn't pin (status/skip/post/unlink) — kept
 * separate from `GUIDANCE` so that object stays byte-identical to
 * pinned-interfaces §D. Same spirit: never suggest stopping the duty loop.
 */
export const EXTRA_GUIDANCE = {
  status: "Call interloom_next_work to keep working the queue — an empty result means keep polling, not stop.",
  afterSkip: "Skipped. Call interloom_next_work now to continue working the queue.",
  afterPost: "Message posted. Return to interloom_next_work to keep working the queue.",
  afterUnlink: "Agent unlinked and its tunnels are closed.",
} as const;
