interface InferenceMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Loose inbound shape (message arrays cross the wire as unknown/string-role). */
type LooseMessage = { role: string; content: string };

/**
 * Normalize a chat sequence for strict chat templates (Gemma-2 and friends
 * raise "Conversation roles must alternate user/assistant" — multi-party
 * chat naturally produces consecutive `user` turns from different speakers).
 *
 * - all system turns are merged into a single leading system message
 * - consecutive same-role turns are merged (joined with a blank line)
 * - the first non-system turn is forced to `user` (a neutral bridge is
 *   inserted when history happens to start with the agent's own turn)
 */
export function normalizeMessages(messages: unknown[]): InferenceMessage[] {
  const valid = (messages as LooseMessage[]).filter(
    (m): m is InferenceMessage =>
      !!m && (m.role === "system" || m.role === "user" || m.role === "assistant"),
  );
  const system = valid.filter((m) => m.role === "system");
  const rest = valid.filter((m) => m.role !== "system");

  const out: InferenceMessage[] = [];
  if (system.length > 0) {
    out.push({ role: "system", content: system.map((m) => m.content).join("\n\n") });
  }

  for (const m of rest) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      last.content = `${last.content}\n\n${m.content}`;
    } else {
      out.push({ ...m });
    }
  }

  const firstTurn = out.find((m) => m.role !== "system");
  if (firstTurn && firstTurn.role === "assistant") {
    const idx = out.indexOf(firstTurn);
    out.splice(idx, 0, { role: "user", content: "(conversation in progress)" });
  }

  return out;
}
