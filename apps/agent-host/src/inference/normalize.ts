type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface InferenceMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[];
  toolCalls?: unknown[];
  toolCallId?: string;
}

/** Loose inbound shape (message arrays cross the wire as unknown/string-role). */
type LooseMessage = {
  role: string;
  content: string | ContentPart[];
  toolCalls?: unknown[];
  toolCallId?: string;
};

function toParts(content: string | ContentPart[]): ContentPart[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

function textOf(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n\n");
}

/** A tool-role turn or an assistant turn carrying tool calls is atomic: it
 * never merges with a neighboring same-role turn, on either side. */
function isAtomic(m: { role: string; toolCalls?: unknown[] }): boolean {
  return m.role === "tool" || Array.isArray(m.toolCalls);
}

/**
 * Normalize a chat sequence for strict chat templates (Gemma-2 and friends
 * raise "Conversation roles must alternate user/assistant" — multi-party
 * chat naturally produces consecutive `user` turns from different speakers).
 *
 * - all system turns are merged into a single leading system message (text)
 * - consecutive same-role turns are merged: text+text joins with a blank
 *   line; anything involving content parts merges as a parts array
 * - the first non-system turn is forced to `user` (a neutral bridge is
 *   inserted when history happens to start with the agent's own turn)
 */
export function normalizeMessages(messages: unknown[]): InferenceMessage[] {
  const valid = (messages as LooseMessage[]).filter(
    (m): m is InferenceMessage =>
      !!m &&
      (m.role === "system" || m.role === "user" || m.role === "assistant" || m.role === "tool") &&
      (typeof m.content === "string" || Array.isArray(m.content)),
  );
  const system = valid.filter((m) => m.role === "system" && !isAtomic(m));
  const rest = valid.filter((m) => !(m.role === "system" && !isAtomic(m)));

  const out: InferenceMessage[] = [];
  if (system.length > 0) {
    out.push({ role: "system", content: system.map((m) => textOf(m.content)).join("\n\n") });
  }

  for (const m of rest) {
    const last = out[out.length - 1];
    if (last && last.role === m.role && !isAtomic(last) && !isAtomic(m)) {
      if (typeof last.content === "string" && typeof m.content === "string") {
        last.content = `${last.content}\n\n${m.content}`;
      } else {
        last.content = [...toParts(last.content), ...toParts(m.content)];
      }
    } else {
      out.push({ ...m });
    }
  }

  const firstTurn = out.find((m) => m.role !== "system");
  if (firstTurn && !isAtomic(firstTurn) && firstTurn.role === "assistant") {
    const idx = out.indexOf(firstTurn);
    out.splice(idx, 0, { role: "user", content: "(conversation in progress)" });
  }

  return out;
}
