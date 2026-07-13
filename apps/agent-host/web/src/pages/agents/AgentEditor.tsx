import { useEffect, useMemo, useRef, useState } from "react";
import { Button, CapabilityBadges, Input, StatusPill, TextArea } from "@interloom/ui";
import type { HostAgent, LocalModel } from "@interloom/protocol";
import type { AgentDraft, ActiveModel } from "../../api/types.js";
import { agents as agentsApi, models as modelsApi } from "../../api/endpoints.js";
import { useAsync } from "../../hooks/useAsync.js";
import { useToasts } from "../../components/Toasts.js";
import { AvatarPicker } from "./AvatarPicker.js";
import { MarketplacePreview } from "./MarketplacePreview.js";
import { CONTEXT_PRESETS } from "../../lib/constants.js";
import { relativeTime, bytesToGB } from "../../lib/format.js";
import { ApiError } from "../../api/client.js";

interface AgentEditorProps {
  agent: HostAgent | null;
  activeModel: ActiveModel | null;
  onSaved: (saved: HostAgent) => void;
  onDeleted: (id: string) => void;
  onDraftChange: (draft: AgentDraft) => void;
}

type SyncState = "idle" | "saving" | "syncing" | "synced";

function toDraft(agent: HostAgent | null): AgentDraft {
  if (!agent) {
    return {
      name: "",
      avatar: { emoji: "🤖", bg: "linear-gradient(135deg,#8b76ee,#6a5acd)" },
      persona: "",
      capabilityBlurb: "",
      params: { temperature: 0.7, contextLength: 4096 },
    };
  }
  return {
    name: agent.name,
    avatar: agent.avatar,
    persona: agent.persona,
    capabilityBlurb: agent.capabilityBlurb,
    params: agent.params,
    model: agent.model,
  };
}

export function AgentEditor({ agent, activeModel, onSaved, onDeleted, onDraftChange }: AgentEditorProps) {
  const toasts = useToasts();
  const [draft, setDraft] = useState<AgentDraft>(() => toDraft(agent));
  const [syncState, setSyncState] = useState<SyncState>("idle");
  const [registering, setRegistering] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const localModels = useAsync((s) => modelsApi.local(s), []);

  // Reset the form whenever the selected agent changes.
  useEffect(() => {
    setDraft(toDraft(agent));
    setSyncState("idle");
  }, [agent]);

  // Keep the parent (preview + marketplace card) in sync with edits.
  useEffect(() => {
    onDraftChange(draft);
  }, [draft, onDraftChange]);

  useEffect(
    () => () => {
      if (syncTimer.current) clearTimeout(syncTimer.current);
    },
    [],
  );

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(toDraft(agent)), [draft, agent]);
  const registered = agent?.registered ?? false;
  const canSave = draft.name.trim().length > 0;
  const hasModel = !!draft.model;

  const patch = (partial: Partial<AgentDraft>) => setDraft((d) => ({ ...d, ...partial }));

  const flashSynced = () => {
    setSyncState("synced");
    if (syncTimer.current) clearTimeout(syncTimer.current);
    syncTimer.current = setTimeout(() => setSyncState("idle"), 2600);
  };

  const save = async () => {
    if (!canSave) return;
    setSyncState("saving");
    try {
      let saved: HostAgent;
      if (agent) {
        if (registered) setSyncState("syncing");
        saved = await agentsApi.update(agent.agentId, draft);
      } else {
        saved = await agentsApi.create(draft);
      }
      onSaved(saved);
      if (registered) flashSynced();
      else setSyncState("idle");
      toasts.success(agent ? "Agent saved" : "Agent created");
    } catch (err) {
      setSyncState("idle");
      toasts.error(
        err instanceof ApiError && err.isOffline ? "Daemon unreachable — save failed." : "Save failed.",
      );
    }
  };

  const publish = async () => {
    if (!canSave) return;
    if (!hasModel) {
      toasts.error("Assign a model before publishing.");
      return;
    }
    setRegistering(true);
    if (!agent) {
      try {
        const created = await agentsApi.create(draft);
        const registeredAgent = await agentsApi.register(created.agentId);
        onSaved(registeredAgent);
        flashSynced();
        toasts.success("Published to the Interloom network");
      } catch (err) {
        toasts.error(
          err instanceof ApiError && err.isOffline ? "Daemon unreachable." : "Publish failed.",
        );
      } finally {
        setRegistering(false);
      }
      return;
    }

    setSyncState("syncing");
    try {
      if (dirty) await agentsApi.update(agent.agentId, draft);
      const registeredAgent = await agentsApi.register(agent.agentId);
      onSaved(registeredAgent);
      flashSynced();
      toasts.success("Published to the Interloom network");
    } catch (err) {
      setSyncState("idle");
      toasts.error(
        err instanceof ApiError && err.isOffline ? "Daemon unreachable." : "Publish failed.",
      );
    } finally {
      setRegistering(false);
    }
  };

  const remove = async () => {
    if (!agent) return;
    setDeleting(true);
    try {
      await agentsApi.remove(agent.agentId);
      onDeleted(agent.agentId);
      toasts.success("Agent deleted");
    } catch (err) {
      toasts.error(
        err instanceof ApiError && err.isOffline ? "Daemon unreachable." : "Delete failed.",
      );
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="il-editor il-scroll-fade">
      <div className="il-editor__inner">
        <div className="il-editor__topbar">
          <h2 className="il-editor__heading">{agent ? "Edit agent" : "New agent"}</h2>
          <div className="il-editor__sync">
            {syncState === "syncing" ? (
              <StatusPill tone="warning" live>
                Syncing…
              </StatusPill>
            ) : syncState === "synced" ? (
              <StatusPill tone="success">Synced</StatusPill>
            ) : registered ? (
              <StatusPill tone="success" live>
                Registered · synced {relativeTime(agent?.syncedAt)}
              </StatusPill>
            ) : (
              <StatusPill tone="neutral">Not published</StatusPill>
            )}
          </div>
        </div>

        <Field label="Name" htmlFor="ag-name">
          <Input
            id="ag-name"
            placeholder="e.g. Ruby the Reviewer"
            value={draft.name}
            onChange={(e) => patch({ name: e.target.value })}
          />
        </Field>

        <Field label="Avatar">
          <AvatarPicker
            name={draft.name}
            emoji={draft.avatar.emoji}
            bg={draft.avatar.bg}
            onChange={(avatar) => patch({ avatar })}
          />
        </Field>

        <Field label="Persona" hint="The system prompt that shapes how your agent behaves.">
          <TextArea
            className="il-editor__persona"
            rows={7}
            placeholder='You are a meticulous code reviewer who explains the "why" behind every suggestion…'
            value={draft.persona}
            onChange={(e) => patch({ persona: e.target.value })}
          />
        </Field>

        <Field label="Capability blurb" hint="Shown on your marketplace card — one line.">
          <Input
            placeholder="Reviews PRs and explains trade-offs in plain language."
            maxLength={120}
            value={draft.capabilityBlurb}
            onChange={(e) => patch({ capabilityBlurb: e.target.value })}
          />
        </Field>

        <Field
          label="Model"
          hint="Required to preview and publish. Drafting without a model is fine."
          htmlFor="ag-model"
        >
          <ModelPicker
            selected={draft.model?.filename ?? null}
            localModels={localModels.data ?? []}
            activeModel={activeModel}
            loading={localModels.loading && localModels.initialLoad}
            onChange={(m) =>
              patch({
                model: m
                  ? { filename: m.filename, displayName: m.filename, sizeBytes: m.sizeBytes, capabilities: m.capabilities }
                  : undefined,
              })
            }
          />
          {!hasModel ? (
            <div className="il-field__note">
              Preview and Publish to Network are locked until a model is selected.
            </div>
          ) : null}
        </Field>

        <div className="il-editor__params">
          <Field label={`Temperature · ${draft.params.temperature.toFixed(2)}`}>
            <input
              type="range"
              className="il-slider"
              min={0}
              max={1.5}
              step={0.05}
              value={draft.params.temperature}
              onChange={(e) =>
                patch({ params: { ...draft.params, temperature: Number(e.target.value) } })
              }
            />
            <div className="il-slider__scale il-meta">
              <span>precise</span>
              <span>creative</span>
            </div>
          </Field>

          <ContextBudgetField
            draft={draft}
            activeModel={activeModel}
            agentModelFilename={draft.model?.filename ?? null}
            patch={patch}
          />
        </div>

        <MarketplacePreview draft={draft} live={registered} />

        <div className="il-editor__actions">
          <div className="il-editor__actions-left">
            {registered ? (
              <Button variant="primary" onClick={save} disabled={!dirty || !canSave || syncState === "saving"}>
                {syncState === "saving" || syncState === "syncing" ? "Saving…" : "Save & sync"}
              </Button>
            ) : (
              <>
                <Button
                  variant="accent"
                  onClick={publish}
                  disabled={!canSave || !hasModel || registering}
                  title={!hasModel ? "Select a model to publish" : undefined}
                >
                  {registering ? "Publishing…" : "Publish to Network"}
                </Button>
                {agent ? (
                  <Button variant="secondary" onClick={save} disabled={!dirty || !canSave}>
                    Save draft
                  </Button>
                ) : (
                  <Button variant="secondary" onClick={save} disabled={!canSave}>
                    Save draft
                  </Button>
                )}
              </>
            )}
          </div>
          {agent ? (
            <Button variant="secondary" onClick={remove} disabled={deleting} className="il-editor__delete">
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function capSuffix(caps: import("@interloom/protocol").ModelCapabilities | undefined): string {
  if (!caps) return "";
  const parts = [
    caps.tools ? "tools" : null,
    caps.vision ? "vision" : null,
    caps.thinking ? "thinking" : null,
  ].filter(Boolean);
  return parts.length > 0 ? ` · ${parts.join(", ")}` : "";
}

function ModelPicker({
  selected,
  localModels,
  activeModel,
  loading,
  onChange,
}: {
  selected: string | null;
  localModels: LocalModel[];
  activeModel: ActiveModel | null;
  loading: boolean;
  onChange: (model: LocalModel | null) => void;
}) {
  if (loading) {
    return <div className="il-model-picker il-meta">Loading installed models…</div>;
  }
  if (localModels.length === 0) {
    return (
      <div className="il-model-picker il-model-picker--empty">
        No models installed yet.{" "}
        <a href="/models" className="il-model-picker__link">
          Install a model
        </a>{" "}
        to enable preview and publish.
      </div>
    );
  }
  return (
    <div className="il-model-picker">
      <select
        id="ag-model"
        className="il-model-picker__select"
        value={selected ?? ""}
        onChange={(e) => {
          const m = localModels.find((lm) => lm.filename === e.target.value) ?? null;
          onChange(m);
        }}
      >
        <option value="">— Select a model —</option>
        {localModels.map((m) => (
          <option key={m.path} value={m.filename}>
            {m.filename} · {bytesToGB(m.sizeBytes)} GB
            {capSuffix(m.capabilities)}
            {activeModel?.filename === m.filename ? " · active" : ""}
          </option>
        ))}
      </select>
      <CapabilityBadges
        capabilities={localModels.find((m) => m.filename === selected)?.capabilities}
        size="sm"
      />
    </div>
  );
}

function ContextBudgetField({
  draft,
  activeModel,
  agentModelFilename,
  patch,
}: {
  draft: AgentDraft;
  activeModel: ActiveModel | null;
  agentModelFilename: string | null;
  patch: (p: Partial<AgentDraft>) => void;
}) {
  const agentModelIsActive =
    agentModelFilename != null && activeModel?.filename === agentModelFilename;
  const loadedCtx = agentModelIsActive ? (activeModel?.ctx ?? null) : null;

  const presets = CONTEXT_PRESETS.filter((p) => loadedCtx == null || p.value <= loadedCtx);

  const ctxLabel = loadedCtx != null ? fmtCtxLabel(loadedCtx) : null;

  const fieldLabel = ctxLabel
    ? `Prompt budget (within the model's ${ctxLabel} window)`
    : "Prompt budget (within the model's context window)";

  const cappedValue = loadedCtx != null
    ? Math.min(draft.params.contextLength, loadedCtx)
    : draft.params.contextLength;

  return (
    <Field label={fieldLabel}>
      <div className="il-segmented" role="group" aria-label="Prompt budget">
        {presets.map((opt) => (
          <button
            key={opt.value}
            type="button"
            className={`il-segmented__btn${
              cappedValue === opt.value ? " il-segmented__btn--sel" : ""
            }`}
            onClick={() => patch({ params: { ...draft.params, contextLength: opt.value } })}
            aria-pressed={cappedValue === opt.value}
          >
            {opt.label}
          </button>
        ))}
      </div>
      {!agentModelIsActive ? (
        <div className="il-field__hint" style={{ marginTop: 6 }}>
          Capped by the context size chosen at activation.
        </div>
      ) : null}
    </Field>
  );
}

function fmtCtxLabel(ctx: number): string {
  if (ctx >= 1024 && ctx % 1024 === 0) return `${ctx / 1024}k`;
  if (ctx >= 1000) return `${Math.round(ctx / 1000)}k`;
  return String(ctx);
}

function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="il-field">
      <label className="il-field__label" htmlFor={htmlFor}>
        {label}
      </label>
      {hint ? <div className="il-field__hint">{hint}</div> : null}
      {children}
    </div>
  );
}
