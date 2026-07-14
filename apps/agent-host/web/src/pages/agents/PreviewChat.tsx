import { useEffect, useRef, useState } from "react";
import { Avatar, Button, TextArea, TypingDots } from "@interloom/ui";
import type { LoadedModel, LocalModel } from "@interloom/protocol";
import { streamPreview } from "../../api/preview.js";
import type { PreviewMessage } from "../../api/preview.js";
import type { AgentDraft } from "../../api/types.js";
import { useToasts } from "../../components/Toasts.js";
import { ApiError } from "../../api/client.js";
import { downscaleToDataUrl } from "../../lib/image.js";
import { parseThinkSegments } from "../../lib/think.js";
import { draftAvatarImageUrl } from "../../lib/character.js";
import { useGuardedModelLoad } from "../../components/ModelLoadFlow/useGuardedModelLoad.js";
import { SpillConfirmDialog } from "../../components/ModelLoadFlow/SpillConfirmDialog.js";

interface PreviewChatProps {
  agentId: string | null;
  draft: AgentDraft;
  /** Loaded-list world (CONTRACTS §6) — an agent's model is either in this set or it isn't. */
  loadedModels: LoadedModel[];
  localModels: LocalModel[];
  onModelLoaded: () => void;
}

interface ChatTurn {
  role: "user" | "assistant";
  content: string;
  images?: string[];
  /** Tags the agent's self-introduction exchange so re-pings can clear only these (CONTRACTS §6). */
  origin?: "auto-intro";
}

interface StartStreamOptions {
  origin?: "auto-intro";
  personaOverride?: string;
}

const INTRO_USER_PROMPT = "You've just been configured. Briefly introduce yourself to the team.";
const INTRO_DEBOUNCE_MS = 1200;
const CANNED_TYPING_MS = 1000;

/** Persona + identity preamble for the auto-intro re-ping (CONTRACTS §6 "Intro re-ping"). */
function buildIntroPersona(draft: AgentDraft): string {
  const lines: string[] = [];
  lines.push(
    draft.title ? `You are ${draft.name} the ${draft.title}.` : `Your name is ${draft.name}.`,
  );
  if (draft.specialties && draft.specialties.length > 0) {
    lines.push(`Your specialties: ${draft.specialties.join(", ")}.`);
  }
  const gender = draft.gender ?? draft.avatar.character?.gender;
  if (gender) {
    lines.push(`You present as ${gender}.`);
  }
  return `${draft.persona}\n\n${lines.join("\n")}`;
}

type CannedKind = "no-model" | "not-loaded" | null;

/**
 * Right-rail live preview. Streams the CURRENT unsaved persona against a
 * loaded model instance. When the agent has no model, or its model isn't
 * among the loaded set, the chat shows an animated in-character canned
 * message with an inline guarded "Load model" action instead of a bare
 * disabled state (deliverable 3). Handles 400 model_required and 409
 * model_not_active by driving the same guarded load flow, then auto-retries
 * whatever preview message triggered it.
 */
export function PreviewChat({ agentId, draft, loadedModels, localModels, onModelLoaded }: PreviewChatProps) {
  const toasts = useToasts();
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [awaitingFirst, setAwaitingFirst] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, setPendingMessages] = useState<PreviewMessage[] | null>(null);
  const [attachments, setAttachments] = useState<string[]>([]);
  const [pendingAttach, setPendingAttach] = useState(0);
  const [cannedPhase, setCannedPhase] = useState<"typing" | "shown">("typing");
  const abortRef = useRef<(() => void) | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const currentAgentRef = useRef(agentId);
  const introKeyRef = useRef<string | null>(null);
  const introTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cannedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadedEntry = draft.model ? loadedModels.find((m) => m.filename === draft.model!.filename) : undefined;
  const noModel = !draft.model;
  const modelLoaded = !!loadedEntry;
  const disabled = noModel || !modelLoaded || agentId === null;

  const { loading: loadFlowLoading, spillConfirm, attemptLoad, confirmSpillAndRetry, cancelSpillConfirm } =
    useGuardedModelLoad(() => {
      onModelLoaded();
      setPendingMessages((pending) => {
        if (pending) startStream(pending);
        return null;
      });
    });

  // Reset the conversation when switching agents.
  useEffect(() => {
    currentAgentRef.current = agentId;
    setTurns([]);
    setError(null);
    setAttachments([]);
    setPendingMessages(null);
    abortRef.current?.();
    setStreaming(false);
    setAwaitingFirst(false);
    introKeyRef.current = null;
    if (introTimerRef.current) clearTimeout(introTimerRef.current);
  }, [agentId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, awaitingFirst, cannedPhase]);

  useEffect(() => () => abortRef.current?.(), []);

  // Canned-message animation: whenever the pane renders in a no-model/
  // not-loaded state with an empty conversation, run a ~1s typing beat
  // before the message appears — same cadence as a real reply.
  const cannedKind: CannedKind =
    agentId !== null && turns.length === 0 && !awaitingFirst
      ? noModel
        ? "no-model"
        : !modelLoaded
          ? "not-loaded"
          : null
      : null;

  useEffect(() => {
    if (cannedTimerRef.current) clearTimeout(cannedTimerRef.current);
    if (!cannedKind) return;
    setCannedPhase("typing");
    cannedTimerRef.current = setTimeout(() => setCannedPhase("shown"), CANNED_TYPING_MS);
    return () => {
      if (cannedTimerRef.current) clearTimeout(cannedTimerRef.current);
    };
  }, [cannedKind, agentId]);

  const visionReady = Boolean(draft.model?.capabilities?.vision && loadedEntry?.mmprojPath);
  const headerAvatarUrl = draftAvatarImageUrl(draft.avatar);

  const startStream = (messages: PreviewMessage[], opts?: StartStreamOptions) => {
    if (!agentId) return;
    setError(null);
    setStreaming(true);
    setAwaitingFirst(true);

    let assistant = "";
    const origin = opts?.origin;

    abortRef.current = streamPreview(
      agentId,
      {
        messages,
        personaOverride: opts?.personaOverride ?? draft.persona,
        temperature: draft.params.temperature,
      },
      {
        onDelta: (delta) => {
          setAwaitingFirst(false);
          assistant += delta;
          setTurns((prev) => {
            const copy = [...prev];
            const last = copy[copy.length - 1];
            if (last && last.role === "assistant") {
              copy[copy.length - 1] = { ...last, content: assistant };
            } else {
              copy.push({ role: "assistant", content: assistant, origin });
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
          if (apiErr.status === 400 && body?.error === "vision_not_supported") {
            setError(
              "This agent's loaded model can't see images — load the vision build (with its projector) to use attachments.",
            );
            return;
          }
          if (apiErr.status === 409 && body?.error === "model_not_active") {
            const filename = body?.model?.filename;
            const localPath = body?.path;
            if (filename && localPath) {
              setPendingMessages(messages);
              void attemptLoad(localPath, filename);
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

  // Intro re-ping: a debounced self-introduction whenever name/title/gender/
  // specialties/persona change — visual-only tweaks don't trigger it.
  useEffect(() => {
    const gender = draft.gender ?? draft.avatar.character?.gender;
    const eligible =
      !!agentId && modelLoaded && !!draft.model && draft.name.trim().length > 0 && !!gender;

    if (!eligible) {
      introKeyRef.current = null;
      return;
    }

    const introKey = JSON.stringify({
      name: draft.name,
      title: draft.title,
      gender,
      specialties: draft.specialties,
      persona: draft.persona,
    });

    const isFirstEncounter = introKeyRef.current === null;
    const changed = introKeyRef.current !== introKey;
    introKeyRef.current = introKey;

    if (isFirstEncounter || !changed) return;

    if (introTimerRef.current) clearTimeout(introTimerRef.current);
    introTimerRef.current = setTimeout(() => {
      abortRef.current?.();
      setTurns((prev) => [
        ...prev.filter((t) => t.origin !== "auto-intro"),
        { role: "user", content: INTRO_USER_PROMPT, origin: "auto-intro" },
      ]);
      startStream(
        [{ role: "user", content: INTRO_USER_PROMPT }],
        { origin: "auto-intro", personaOverride: buildIntroPersona(draft) },
      );
    }, INTRO_DEBOUNCE_MS);

    return () => {
      if (introTimerRef.current) clearTimeout(introTimerRef.current);
    };
  }, [
    agentId,
    modelLoaded,
    draft.model,
    draft.name,
    draft.title,
    draft.gender,
    draft.specialties,
    draft.persona,
    draft.avatar.character?.gender,
  ]);

  const attach = async (file: File | undefined) => {
    if (!file) return;
    const forAgent = agentId;
    setPendingAttach((n) => n + 1);
    try {
      const dataUrl = await downscaleToDataUrl(file);
      if (currentAgentRef.current === forAgent) {
        setAttachments((prev) => [...prev, dataUrl]);
      }
    } catch {
      toasts.error("Could not read that image.");
    } finally {
      setPendingAttach((n) => Math.max(0, n - 1));
    }
  };

  const send = () => {
    const text = input.trim();
    if ((!text && attachments.length === 0) || pendingAttach > 0 || streaming || disabled || !agentId) return;

    const nextTurns: ChatTurn[] = [
      ...turns,
      { role: "user", content: text, ...(attachments.length > 0 ? { images: attachments } : {}) },
    ];
    setTurns(nextTurns);
    setInput("");
    setAttachments([]);

    const messages: PreviewMessage[] = nextTurns.map((t) => ({
      role: t.role,
      content: t.content,
      ...(t.images ? { images: t.images } : {}),
    }));
    startStream(messages);
  };

  /** The inline "Load model" action under the canned not-loaded bubble. */
  const loadFromCanned = () => {
    if (!draft.model) return;
    const local = localModels.find((m) => m.filename === draft.model!.filename);
    if (!local) {
      toasts.error("That model isn't installed on this host — download it from the Models page first.");
      return;
    }
    void attemptLoad(local.path, local.filename);
  };

  const composerPlaceholder = noModel
    ? "Assign a model to preview"
    : !modelLoaded
      ? "Load the model to preview"
      : agentId === null
        ? "Save the agent first"
        : "Message this agent…";

  return (
    <>
      <aside className="il-preview" aria-label="Live preview">
        <header className="il-preview__head">
          <span className="il-preview__title">Live preview</span>
          <Avatar
            name={draft.name || "Agent"}
            isAgent
            emoji={draft.avatar.emoji}
            bg={draft.avatar.character ? `#${draft.avatar.character.backgroundColor}` : draft.avatar.bg}
            imageUrl={headerAvatarUrl}
            size="sm"
          />
        </header>

        <div className="il-preview__body il-scroll-fade" ref={scrollRef}>
          {turns.length === 0 && !awaitingFirst ? (
            agentId === null ? (
              <div className="il-preview__empty">
                <div className="il-preview__empty-title">Save to preview</div>
                <p>Create the agent first, then chat with it here to test the persona.</p>
              </div>
            ) : cannedKind ? (
              <div className="il-preview__turns">
                <div className="il-preview__agent-turn">
                  <Avatar
                    name={draft.name || "Agent"}
                    isAgent
                    emoji={draft.avatar.emoji}
                    bg={draft.avatar.character ? `#${draft.avatar.character.backgroundColor}` : draft.avatar.bg}
                    imageUrl={headerAvatarUrl}
                    size="sm"
                  />
                  {cannedPhase === "typing" ? (
                    <div className="il-preview__bubble il-preview__bubble--typing">
                      <TypingDots />
                    </div>
                  ) : (
                    <div className="il-preview__canned">
                      <div className="il-preview__bubble">
                        {cannedKind === "no-model"
                          ? "I don't have a model yet — pick one for me in the editor and I'll be ready to chat."
                          : `My model (${draft.model?.filename}) isn't loaded right now. Load it and I'll wake right up.`}
                      </div>
                      {cannedKind === "not-loaded" ? (
                        <Button
                          size="sm"
                          variant="primary"
                          className="il-preview__canned-action"
                          onClick={loadFromCanned}
                          disabled={loadFlowLoading}
                        >
                          {loadFlowLoading ? "Loading…" : "Load model"}
                        </Button>
                      ) : null}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="il-preview__empty">
                <div className="il-preview__empty-title">Try your persona</div>
                <p>Send a message to see how {draft.name || "your agent"} responds — live, on your GPU.</p>
              </div>
            )
          ) : (
            <div className="il-preview__turns">
              {turns.map((t, i) =>
                t.role === "user" ? (
                  <div key={i} className="il-preview__user">
                    {t.images?.length ? (
                      <span className="il-preview__thumbs">
                        {t.images.map((src, j) => (
                          <img key={j} src={src} alt="" className="il-preview__thumb" />
                        ))}
                      </span>
                    ) : null}
                    {t.content}
                  </div>
                ) : (
                  <div key={i} className="il-preview__agent-turn">
                    <Avatar
                      name={draft.name || "Agent"}
                      isAgent
                      emoji={draft.avatar.emoji}
                      bg={draft.avatar.character ? `#${draft.avatar.character.backgroundColor}` : draft.avatar.bg}
                      imageUrl={headerAvatarUrl}
                      size="sm"
                    />
                    <div className="il-preview__bubble">
                      {parseThinkSegments(t.content).map((seg, j) =>
                        seg.kind === "think" ? (
                          <ThinkBlock key={j} text={seg.text} open={seg.open} />
                        ) : (
                          <span key={j}>{seg.text}</span>
                        ),
                      )}
                    </div>
                  </div>
                ),
              )}
              {awaitingFirst ? (
                <div className="il-preview__agent-turn">
                  <Avatar
                    name={draft.name || "Agent"}
                    isAgent
                    emoji={draft.avatar.emoji}
                    bg={draft.avatar.character ? `#${draft.avatar.character.backgroundColor}` : draft.avatar.bg}
                    imageUrl={headerAvatarUrl}
                    size="sm"
                  />
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
            {visionReady ? (
              <label className="il-preview__attach" title="Attach an image">
                <input
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={(e) => {
                    void attach(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />
                📎{pendingAttach > 0 ? "…" : ""}
                {attachments.length > 0 ? ` ${attachments.length}` : ""}
              </label>
            ) : null}
            <span className="il-meta">preview runs on your GPU</span>
            <Button
              size="sm"
              variant="primary"
              onClick={send}
              disabled={
                disabled ||
                streaming ||
                pendingAttach > 0 ||
                (!input.trim() && attachments.length === 0)
              }
            >
              {streaming ? "…" : "Send"}
            </Button>
          </div>
        </div>
      </aside>

      {spillConfirm ? (
        <SpillConfirmDialog
          request={spillConfirm}
          loading={loadFlowLoading}
          onCancel={cancelSpillConfirm}
          onConfirm={() => void confirmSpillAndRetry()}
        />
      ) : null}
    </>
  );
}

function ThinkBlock({ text, open }: { text: string; open?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="il-think">
      <button className="il-think__toggle" onClick={() => setExpanded((v) => !v)}>
        {open ? "thinking…" : `thought for ${Math.max(1, Math.round(text.length / 400))}s`}{" "}
        {expanded ? "▾" : "▸"}
      </button>
      {expanded ? <pre className="il-think__body">{text}</pre> : null}
    </div>
  );
}
