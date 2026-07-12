import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Avatar, Button, TextArea, TypingDots } from "@interloom/ui";
import { streamPreview } from "../../api/preview.js";
import type { PreviewMessage } from "../../api/preview.js";
import type { AgentDraft } from "../../api/types.js";

interface PreviewChatProps {
  agentId: string | null;
  draft: AgentDraft;
  /** Whether a model is loaded on the inference server; gates the composer. */
  modelActive: boolean;
}

interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

/**
 * Right-rail live preview. Streams the CURRENT unsaved persona against the
 * active local model. Sends `personaOverride` so edits preview instantly
 * without saving. Disabled with a helpful hint when no model is active or the
 * agent is unsaved (no id to preview against yet).
 */
export function PreviewChat({ agentId, draft, modelActive }: PreviewChatProps) {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [awaitingFirst, setAwaitingFirst] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<(() => void) | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Reset the conversation when switching agents.
  useEffect(() => {
    setTurns([]);
    setError(null);
    abortRef.current?.();
    setStreaming(false);
    setAwaitingFirst(false);
  }, [agentId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, awaitingFirst]);

  useEffect(() => () => abortRef.current?.(), []);

  const disabled = !modelActive || agentId === null;

  const send = () => {
    const text = input.trim();
    if (!text || streaming || disabled || !agentId) return;

    const nextTurns: ChatTurn[] = [...turns, { role: "user", content: text }];
    setTurns(nextTurns);
    setInput("");
    setError(null);
    setStreaming(true);
    setAwaitingFirst(true);

    const messages: PreviewMessage[] = nextTurns.map((t) => ({ role: t.role, content: t.content }));
    let assistant = "";

    abortRef.current = streamPreview(
      agentId,
      { messages, personaOverride: draft.persona, temperature: draft.params.temperature },
      {
        onDelta: (delta) => {
          setAwaitingFirst(false);
          assistant += delta;
          setTurns((prev) => {
            const copy = [...prev];
            const last = copy[copy.length - 1];
            if (last && last.role === "assistant") {
              copy[copy.length - 1] = { role: "assistant", content: assistant };
            } else {
              copy.push({ role: "assistant", content: assistant });
            }
            return copy;
          });
        },
        onDone: () => {
          setStreaming(false);
          setAwaitingFirst(false);
        },
        onError: (err) => {
          setStreaming(false);
          setAwaitingFirst(false);
          setError(err.message);
        },
      },
    );
  };

  return (
    <aside className="il-preview" aria-label="Live preview">
      <header className="il-preview__head">
        <span className="il-preview__title">Live preview</span>
        <Avatar name={draft.name || "Agent"} isAgent emoji={draft.avatar.emoji} bg={draft.avatar.bg} size="sm" />
      </header>

      <div className="il-preview__body il-scroll-fade" ref={scrollRef}>
        {turns.length === 0 && !awaitingFirst ? (
          <div className="il-preview__empty">
            {disabled ? (
              !modelActive ? (
                <>
                  <div className="il-preview__empty-title">No model is active</div>
                  <p>
                    Preview runs on your own GPU. Activate a local model to chat with{" "}
                    {draft.name || "this agent"}.
                  </p>
                  <Link className="il-preview__link" to="/models">
                    Activate a model →
                  </Link>
                </>
              ) : (
                <>
                  <div className="il-preview__empty-title">Save to preview</div>
                  <p>Create the agent first, then chat with it here to test the persona.</p>
                </>
              )
            ) : (
              <>
                <div className="il-preview__empty-title">Try your persona</div>
                <p>Send a message to see how {draft.name || "your agent"} responds — live, on your GPU.</p>
              </>
            )}
          </div>
        ) : (
          <div className="il-preview__turns">
            {turns.map((t, i) =>
              t.role === "user" ? (
                <div key={i} className="il-preview__user">
                  {t.content}
                </div>
              ) : (
                <div key={i} className="il-preview__agent-turn">
                  <Avatar name={draft.name || "Agent"} isAgent emoji={draft.avatar.emoji} bg={draft.avatar.bg} size="sm" />
                  <div className="il-preview__bubble">{t.content}</div>
                </div>
              ),
            )}
            {awaitingFirst ? (
              <div className="il-preview__agent-turn">
                <Avatar name={draft.name || "Agent"} isAgent emoji={draft.avatar.emoji} bg={draft.avatar.bg} size="sm" />
                <div className="il-preview__bubble il-preview__bubble--typing">
                  <TypingDots />
                </div>
              </div>
            ) : null}
          </div>
        )}
        {error ? <div className="il-preview__error">{error}</div> : null}
      </div>

      <div className="il-preview__composer">
        <TextArea
          rows={2}
          placeholder={disabled ? "Activate a model to preview" : "Message this agent…"}
          value={input}
          disabled={disabled || streaming}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="il-preview__composer-foot">
          <span className="il-meta">preview runs on your GPU</span>
          <Button size="sm" variant="primary" onClick={send} disabled={disabled || streaming || !input.trim()}>
            {streaming ? "…" : "Send"}
          </Button>
        </div>
      </div>
    </aside>
  );
}
