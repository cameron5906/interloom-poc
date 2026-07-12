import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Avatar, Button, Modal, TextArea, TypingDots } from "@interloom/ui";
import { streamPreview } from "../../api/preview.js";
import { models as modelsApi } from "../../api/endpoints.js";
import type { PreviewMessage } from "../../api/preview.js";
import type { AgentDraft, ActiveModel } from "../../api/types.js";
import { useToasts } from "../../components/Toasts.js";
import { ApiError } from "../../api/client.js";

interface PreviewChatProps {
  agentId: string | null;
  draft: AgentDraft;
  modelActive: boolean;
  activeModel: ActiveModel | null;
}

interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

/**
 * Right-rail live preview. Streams the CURRENT unsaved persona against the
 * active local model. Handles 400 model_required (picker hint) and
 * 409 model_not_active (offers activation then retries).
 */
export function PreviewChat({ agentId, draft, modelActive, activeModel }: PreviewChatProps) {
  const toasts = useToasts();
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [awaitingFirst, setAwaitingFirst] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activationModal, setActivationModal] = useState<{
    modelPath: string;
    modelFilename: string;
    pendingMessages: PreviewMessage[];
  } | null>(null);
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

  const noModel = !draft.model;
  const disabled = noModel || !modelActive || agentId === null;

  const startStream = (messages: PreviewMessage[]) => {
    if (!agentId) return;
    setError(null);
    setStreaming(true);
    setAwaitingFirst(true);

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

          const apiErr = err as ApiError & { status?: number; body?: unknown };
          const body = apiErr.body as { error?: string; model?: { filename?: string }; path?: string | null } | undefined;

          if (apiErr.status === 400 && body?.error === "model_required") {
            setError("This agent has no model assigned. Select a model in the editor first.");
            return;
          }
          if (apiErr.status === 409 && body?.error === "model_not_active") {
            const filename = body?.model?.filename;
            const localPath = body?.path;
            if (filename && localPath) {
              setActivationModal({ modelPath: localPath, modelFilename: filename, pendingMessages: messages });
              return;
            }
            if (filename && !localPath) {
              setError("Model file not found locally — download it from the Models page first.");
              return;
            }
          }

          setError(err.message);
        },
      },
    );
  };

  const send = () => {
    const text = input.trim();
    if (!text || streaming || disabled || !agentId) return;

    const nextTurns: ChatTurn[] = [...turns, { role: "user", content: text }];
    setTurns(nextTurns);
    setInput("");

    const messages: PreviewMessage[] = nextTurns.map((t) => ({ role: t.role, content: t.content }));
    startStream(messages);
  };

  const handleActivate = async () => {
    if (!activationModal) return;
    const { modelPath, modelFilename, pendingMessages } = activationModal;
    setActivationModal(null);
    try {
      const result = await modelsApi.activate(modelPath);
      if (result.status === "ready") {
        toasts.success(`${modelFilename} is now active`);
        startStream(pendingMessages);
      } else {
        toasts.error("Model failed to load — can't preview.");
      }
    } catch (err) {
      toasts.error(
        err instanceof ApiError && err.isOffline
          ? "Daemon unreachable — can't activate."
          : "Activation failed.",
      );
    }
  };

  let disabledReason: React.ReactNode = null;
  if (agentId === null) {
    disabledReason = (
      <>
        <div className="il-preview__empty-title">Save to preview</div>
        <p>Create the agent first, then chat with it here to test the persona.</p>
      </>
    );
  } else if (noModel) {
    disabledReason = (
      <>
        <div className="il-preview__empty-title">No model selected</div>
        <p>Assign a model to this agent in the editor to enable preview.</p>
      </>
    );
  } else if (!modelActive) {
    disabledReason = (
      <>
        <div className="il-preview__empty-title">No model is active</div>
        <p>
          Preview runs on your own GPU. Activate{" "}
          {draft.model ? (
            <strong>{draft.model.filename}</strong>
          ) : (
            "a local model"
          )}{" "}
          to chat with {draft.name || "this agent"}.
        </p>
        <Link className="il-preview__link" to="/models">
          Activate a model →
        </Link>
      </>
    );
  }

  const composerPlaceholder = noModel
    ? "Assign a model to preview"
    : !modelActive
      ? "Activate a model to preview"
      : agentId === null
        ? "Save the agent first"
        : "Message this agent…";

  return (
    <>
      <aside className="il-preview" aria-label="Live preview">
        <header className="il-preview__head">
          <span className="il-preview__title">Live preview</span>
          <Avatar name={draft.name || "Agent"} isAgent emoji={draft.avatar.emoji} bg={draft.avatar.bg} size="sm" />
        </header>

        <div className="il-preview__body il-scroll-fade" ref={scrollRef}>
          {turns.length === 0 && !awaitingFirst ? (
            <div className="il-preview__empty">
              {disabledReason ?? (
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
            placeholder={composerPlaceholder}
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

      {activationModal ? (
        <ActivateForPreviewModal
          modelFilename={activationModal.modelFilename}
          draftModelFilename={draft.model?.filename}
          onClose={() => setActivationModal(null)}
          onActivate={handleActivate}
          activeModel={activeModel}
        />
      ) : null}
    </>
  );
}

function ActivateForPreviewModal({
  modelFilename,
  draftModelFilename,
  activeModel,
  onClose,
  onActivate,
}: {
  modelFilename: string;
  draftModelFilename?: string;
  activeModel: ActiveModel | null;
  onClose: () => void;
  onActivate: () => void;
}) {
  return (
    <Modal
      open
      onClose={onClose}
      title={<span>Activate model to preview?</span>}
      footer={
        <div className="il-preview-activate__actions">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onActivate}>
            Activate {modelFilename}
          </Button>
        </div>
      }
    >
      <div className="il-preview-activate__body">
        <p>
          This agent runs on <strong>{draftModelFilename ?? modelFilename}</strong>, but the
          currently active model is{" "}
          {activeModel ? <strong>{activeModel.filename}</strong> : "none"}.
        </p>
        <p>
          Activating <strong>{modelFilename}</strong> will swap the inference server to that
          model. Agents on the current model will go offline temporarily.
        </p>
      </div>
    </Modal>
  );
}
