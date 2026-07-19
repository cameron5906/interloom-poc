import { useEffect, useMemo, useRef, useState } from "react";
import { Avatar, Button, CapabilityBadges, Flipper, Input, Modal, StatusPill, TextArea } from "@interloom/ui";
import type {
  AgentGender,
  FrontierProvider,
  HostAgent,
  LoadedModel,
  LocalModel,
  PlacementStatus,
} from "@interloom/protocol";
import type { AgentDraft, CatalogModel, FrontierConfigBody, MaskedFrontierConfig } from "../../api/types.js";
import { EMPTY_AGENT_DRAFT } from "../../api/types.js";
import { FrontierLinkModal } from "./FrontierLinkModal.js";
import {
  agents as agentsApi,
  placements as placementsApi,
  models as modelsApi,
} from "../../api/endpoints.js";
import { useAsync } from "../../hooks/useAsync.js";
import { CONTEXT_PRESETS } from "../../lib/constants.js";
import { useToasts } from "../../components/Toasts.js";
import { CharacterCustomizer } from "./CharacterCustomizer/index.js";
import { SpecialtiesInput } from "./SpecialtiesInput.js";
import { CascadeWarningModal } from "./CascadeWarningModal.js";
import { MarketplacePreview } from "./MarketplacePreview.js";
import { catalogModelForPath, repoIdFromLocalPath } from "../models/catalog/catalogHelpers.js";
import { relativeTime, bytesToGB } from "../../lib/format.js";
import {
  rollCharacter,
  withGender,
  draftAvatarImageUrl,
  avatarUploadPending,
  svgFor,
  renderPng,
} from "../../lib/character.js";
import { GenderPicker } from "./CharacterCustomizer/GenderPicker.js";
import { signatureChanged } from "../../lib/signature.js";
import { ApiError } from "../../api/client.js";
import { useGuardedModelLoad } from "../../components/ModelLoadFlow/useGuardedModelLoad.js";
import { SpillConfirmDialog } from "../../components/ModelLoadFlow/SpillConfirmDialog.js";

interface AgentEditorProps {
  agent: HostAgent | null;
  /** Loaded-list world (CONTRACTS §6) — replaces the old single `activeModel`. */
  loadedModels: LoadedModel[];
  localModels: LocalModel[];
  localModelsLoading: boolean;
  onSaved: (saved: HostAgent) => void;
  onDeleted: (id: string) => void;
  onDraftChange: (draft: AgentDraft) => void;
  /** Live runtime-tab state for the sibling preview pane (CONTRACTS §14) —
   * kept OUT of `AgentDraft` deliberately: it's edit-time UI state (which tab
   * is open, which provider is picked), not something the generic draft
   * save/publish calls should ever persist (that stays the dedicated
   * frontier-config endpoint's job, never the plain agent PATCH/POST). */
  onRuntimeChange: (info: { runtime: "hosted" | "frontier"; frontierProvider: FrontierProvider }) => void;
}

type SyncState = "idle" | "saving" | "syncing" | "synced";

function toDraft(agent: HostAgent | null): AgentDraft {
  if (!agent) return EMPTY_AGENT_DRAFT;
  return {
    name: agent.name,
    avatar: agent.avatar,
    persona: agent.persona,
    capabilityBlurb: agent.capabilityBlurb,
    title: agent.title,
    gender: agent.gender,
    specialties: agent.specialties,
    params: agent.params,
    model: agent.model,
  };
}

/**
 * New drafts start with a character already rolled (gender "other" — the
 * open pack) so the avatar is alive from the first keystroke; existing
 * agents keep exactly what was saved (no surprise re-rolls of a published
 * look). CONTRACTS §12.
 */
function initialDraft(agent: HostAgent | null): AgentDraft {
  const draft = toDraft(agent);
  if (agent) return draft;
  const rolled = rollCharacter(draft.name.trim() || "agent", "other");
  return {
    ...draft,
    gender: rolled.gender,
    avatar: { ...draft.avatar, character: rolled, bg: `#${rolled.backgroundColor}` },
  };
}

export function AgentEditor({
  agent,
  loadedModels,
  localModels,
  localModelsLoading,
  onSaved,
  onDeleted,
  onDraftChange,
  onRuntimeChange,
}: AgentEditorProps) {
  const toasts = useToasts();
  const [draft, setDraft] = useState<AgentDraft>(() => initialDraft(agent));
  const [syncState, setSyncState] = useState<SyncState>("idle");
  const [registering, setRegistering] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [customizerOpen, setCustomizerOpen] = useState(false);
  const [characterOverridden, setCharacterOverridden] = useState(() => !!agent?.avatar.character);
  const [cascade, setCascade] = useState<PlacementStatus[] | null>(null);
  const [cascadeConfirming, setCascadeConfirming] = useState(false);
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevNameRef = useRef(draft.name);
  const uploadedCharacterRef = useRef(agent?.avatar.character);

  // Offline (local model) vs. Frontier (external CLI agent via MCP) runtime
  // (CONTRACTS §14). The flipper defaults to Offline; Frontier stays
  // disabled-with-tooltip until the agent has been saved once, since the
  // frontier config endpoints 404 for an agent id that doesn't exist yet.
  const [runtimeTab, setRuntimeTab] = useState<"hosted" | "frontier">(
    agent?.runtime === "frontier" ? "frontier" : "hosted",
  );
  const [frontierProvider, setFrontierProvider] = useState<FrontierProvider>("anthropic");
  const [frontierModel, setFrontierModel] = useState("");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [apiKeyTouched, setApiKeyTouched] = useState(false);
  const [savingFrontier, setSavingFrontier] = useState(false);
  const [linkModalOpen, setLinkModalOpen] = useState(false);
  const seededFrontierAgentId = useRef<string | null>(null);

  const frontierConfig = useAsync<MaskedFrontierConfig | null>(
    (s) => (agent ? agentsApi.frontierGet(agent.agentId, s) : Promise.resolve(null)),
    [agent?.agentId],
  );

  // Seed the frontier form from the stored config once per agent — never
  // re-seed on a background refetch, or an in-progress edit would vanish.
  useEffect(() => {
    if (!agent) {
      setFrontierProvider("anthropic");
      setFrontierModel("");
      setApiKeyInput("");
      setApiKeyTouched(false);
      seededFrontierAgentId.current = null;
      return;
    }
    if (frontierConfig.data && seededFrontierAgentId.current !== agent.agentId) {
      setFrontierProvider(frontierConfig.data.provider ?? "anthropic");
      setFrontierModel(frontierConfig.data.model ?? "");
      setApiKeyInput("");
      setApiKeyTouched(false);
      seededFrontierAgentId.current = agent.agentId;
    }
  }, [agent, frontierConfig.data]);

  // Curated catalog (theirs) — used to label installed models with their
  // catalog name and to enrich the published ModelRef. `localModels` and
  // `loadedModels` arrive as props (multi-instance loaded set, CONTRACTS §6).
  const registry = useAsync((s) => modelsApi.registry(s), []);
  const catalogModels = registry.data?.doc.catalog.models ?? [];

  // Reset the form whenever the selected agent changes.
  useEffect(() => {
    setDraft(initialDraft(agent));
    setSyncState("idle");
    setCharacterOverridden(!!agent?.avatar.character);
    uploadedCharacterRef.current = agent?.avatar.character;
    prevNameRef.current = agent?.name ?? "";
    setRuntimeTab(agent?.runtime === "frontier" ? "frontier" : "hosted");
  }, [agent]);

  // Keep the parent (preview + marketplace card) in sync with edits.
  useEffect(() => {
    onDraftChange(draft);
  }, [draft, onDraftChange]);

  // The live preview pane needs the runtime tab + provider to swap its
  // "runs on your GPU" copy for a token-cost note in Frontier mode.
  useEffect(() => {
    onRuntimeChange({ runtime: runtimeTab, frontierProvider });
  }, [runtimeTab, frontierProvider, onRuntimeChange]);

  useEffect(
    () => () => {
      if (syncTimer.current) clearTimeout(syncTimer.current);
    },
    [],
  );

  // Renaming re-seeds the character only while the user hasn't overridden pieces (CONTRACTS §12).
  useEffect(() => {
    if (draft.name === prevNameRef.current) return;
    prevNameRef.current = draft.name;
    if (draft.avatar.character && !characterOverridden) {
      const rerolled = rollCharacter(draft.name.trim() || "agent", draft.avatar.character.gender);
      setDraft((d) => ({
        ...d,
        gender: rerolled.gender,
        avatar: { ...d.avatar, character: rerolled, bg: `#${rerolled.backgroundColor}` },
      }));
    }
  }, [draft.name]);

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(toDraft(agent)), [draft, agent]);
  const registered = agent?.registered ?? false;
  const canSave = draft.name.trim().length > 0;
  const hasModel = !!draft.model;
  const isFrontier = runtimeTab === "frontier";
  const frontierReady = agent?.runtime === "frontier" && !!agent?.frontier;

  const patch = (partial: Partial<AgentDraft>) => setDraft((d) => ({ ...d, ...partial }));

  // Gender is a first-class identity control (CONTRACTS §12): flipping it
  // re-rolls the look within the new pack — unless the user has customized
  // pieces, in which case the choices stick and only the pack retags.
  const changeGender = (gender: AgentGender) => {
    const character = draft.avatar.character;
    if (character && characterOverridden) {
      patch({ gender, avatar: { ...draft.avatar, character: withGender(character, gender) } });
      return;
    }
    const rolled = rollCharacter(draft.name.trim() || character?.seed || "agent", gender);
    setCharacterOverridden(false);
    patch({ gender, avatar: { ...draft.avatar, character: rolled, bg: `#${rolled.backgroundColor}` } });
  };

  // Legacy agents saved before characters existed have none — give them one
  // the moment the customizer opens instead of gating on a gender pick.
  const openCustomizer = () => {
    if (!draft.avatar.character) changeGender(draft.gender ?? "other");
    setCustomizerOpen(true);
  };

  const flashSynced = () => {
    setSyncState("synced");
    if (syncTimer.current) clearTimeout(syncTimer.current);
    syncTimer.current = setTimeout(() => setSyncState("idle"), 2600);
  };

  const maybeUploadAvatar = async (agentId: string) => {
    const character = draft.avatar.character;
    if (!character) return;
    if (!avatarUploadPending(draft.avatar, uploadedCharacterRef.current)) return;
    try {
      const png = await renderPng(svgFor(character));
      const { imageUrl } = await agentsApi.uploadAvatar(agentId, png);
      uploadedCharacterRef.current = character;
      patch({ avatar: { ...draft.avatar, imageUrl } });
    } catch {
      toasts.error("Saved, but the avatar image failed to upload.");
    }
  };

  const placementsForAgent = async (agentId: string): Promise<PlacementStatus[]> => {
    try {
      const all = await placementsApi.list();
      return all.filter((p) => !p.revoked && p.voucher.payload.agentId === agentId);
    } catch {
      return [];
    }
  };

  const doSave = async () => {
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
      await maybeUploadAvatar(saved.agentId);
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

  const save = async () => {
    if (!canSave) return;
    if (agent && registered) {
      const avatarPending = avatarUploadPending(draft.avatar, uploadedCharacterRef.current);
      if (signatureChanged(agent, draft, avatarPending)) {
        const impacted = await placementsForAgent(agent.agentId);
        if (impacted.length > 0) {
          setCascade(impacted);
          return;
        }
      }
    }
    await doSave();
  };

  const confirmCascade = async () => {
    setCascadeConfirming(true);
    await doSave();
    setCascadeConfirming(false);
    setCascade(null);
  };

  /** Saves provider/model/apiKey via the dedicated frontier endpoint
   * (CONTRACTS §6) — never through the generic draft PATCH, since the API
   * key and per-agent keypair live only in `frontier-keys.json`, not
   * `agents.json`. Unconditionally flips the agent to `runtime: "frontier"`
   * server-side, so this refetches the full agent afterward. */
  const saveFrontierConfig = async () => {
    if (!agent) return;
    if (frontierModel.trim().length === 0) return;
    setSavingFrontier(true);
    try {
      const body: FrontierConfigBody = { provider: frontierProvider, model: frontierModel.trim() };
      if (apiKeyTouched) body.apiKey = apiKeyInput;
      await agentsApi.frontierSet(agent.agentId, body);
      const fresh = await agentsApi.get(agent.agentId);
      onSaved(fresh);
      frontierConfig.reload();
      setApiKeyInput("");
      setApiKeyTouched(false);
      toasts.success("Frontier configuration saved");
    } catch (err) {
      toasts.error(
        err instanceof ApiError && err.isOffline
          ? "Daemon unreachable — save failed."
          : "Failed to save frontier configuration.",
      );
    } finally {
      setSavingFrontier(false);
    }
  };

  const publish = async () => {
    if (!canSave) return;
    if (isFrontier ? !frontierReady : !hasModel) {
      toasts.error(
        isFrontier
          ? "Save your frontier configuration before publishing."
          : "Assign a model before publishing.",
      );
      return;
    }
    setRegistering(true);
    if (!agent) {
      try {
        const created = await agentsApi.create(draft);
        await maybeUploadAvatar(created.agentId);
        const registeredAgent = await agentsApi.register(created.agentId);
        onSaved(registeredAgent);
        flashSynced();
        toasts.success("Published to the Eris network");
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
      await maybeUploadAvatar(agent.agentId);
      const registeredAgent = await agentsApi.register(agent.agentId);
      onSaved(registeredAgent);
      flashSynced();
      toasts.success("Published to the Eris network");
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

        <Field label="Character" hint="The name seeds the look — customize any piece, or shuffle within the pack.">
          <div className="il-avatar-field">
            <Avatar
              name={draft.name || "Agent"}
              isAgent
              emoji={draft.avatar.emoji}
              bg={draft.avatar.character ? `#${draft.avatar.character.backgroundColor}` : draft.avatar.bg}
              imageUrl={draftAvatarImageUrl(draft.avatar)}
              size="lg"
              badge={runtimeTab === "frontier" ? "frontier" : undefined}
            />
            <GenderPicker value={draft.gender} onChange={changeGender} />
            <Button variant="secondary" size="sm" onClick={openCustomizer}>
              Customize
            </Button>
          </div>
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

        <Field label="Title" hint='Renders as "Name the Title" on your marketplace card.'>
          <Input
            placeholder="e.g. Archivist"
            maxLength={60}
            value={draft.title ?? ""}
            onChange={(e) => patch({ title: e.target.value || undefined })}
          />
        </Field>

        <Field
          label="Capability blurb"
          hint="A one-liner describing what your agent does — shown on marketplace cards and workspace member cards, independent of the title."
        >
          <Input
            placeholder="e.g. Reviews pull requests and explains the reasoning behind every suggestion"
            maxLength={140}
            value={draft.capabilityBlurb}
            onChange={(e) => patch({ capabilityBlurb: e.target.value })}
          />
        </Field>

        <Field label="Specialties" hint="Up to 8 — shown as chips on your marketplace card.">
          <SpecialtiesInput
            value={draft.specialties ?? []}
            onChange={(specialties) => patch({ specialties })}
          />
        </Field>

        <Field label="Runtime" hint="Offline runs a model on this machine. Frontier pulls work into a CLI agent (Claude Code, Codex) running on your own machine.">
          <Flipper
            aria-label="Agent runtime"
            value={runtimeTab}
            onChange={setRuntimeTab}
            options={[
              { value: "hosted", label: "Offline Models" },
              {
                value: "frontier",
                label: "Frontier Models",
                disabled: !agent,
                disabledReason: "Save the agent once to unlock Frontier mode",
              },
            ]}
          />
        </Field>

        {runtimeTab === "hosted" ? (
          <Field
            label="Model"
            hint="Required to preview and publish. Drafting without a model is fine."
            htmlFor="ag-model"
          >
            <ModelPicker
              selected={draft.model?.filename ?? null}
              localModels={localModels}
              loadedModels={loadedModels}
              catalogModels={catalogModels}
              loading={localModelsLoading}
              onChange={(m) =>
                patch({
                  model: m
                    ? buildModelRef(m, catalogModels)
                    : undefined,
                })
              }
            />
            {draft.model ? (
              <ModelStatusLine
                filename={draft.model.filename}
                loadedModels={loadedModels}
                localModels={localModels}
              />
            ) : null}
            {!hasModel ? (
              <div className="il-field__note">
                Preview and Publish to Network are locked until a model is selected.
              </div>
            ) : (
              <div className="il-field__hint" style={{ marginTop: 6 }}>
                Context is set when you load the model — configure it on the{" "}
                <a href="/models" className="il-model-picker__link">
                  Models page
                </a>
                .
              </div>
            )}
          </Field>
        ) : (
          <FrontierConfigFields
            provider={frontierProvider}
            model={frontierModel}
            apiKeyInput={apiKeyInput}
            hasKey={frontierConfig.data?.hasKey ?? false}
            last4={frontierConfig.data?.last4 ?? null}
            saving={savingFrontier}
            ready={frontierReady}
            onProviderChange={setFrontierProvider}
            onModelChange={setFrontierModel}
            onApiKeyChange={(v) => {
              setApiKeyInput(v);
              setApiKeyTouched(true);
            }}
            onSave={() => void saveFrontierConfig()}
            onOpenLinkModal={() => setLinkModalOpen(true)}
          />
        )}

        {runtimeTab === "hosted" ? (
          <div className="il-editor__params il-editor__params--single">
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
              loadedModels={loadedModels}
              agentModelFilename={draft.model?.filename ?? null}
              patch={patch}
            />
          </div>
        ) : null}

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
                  disabled={!canSave || (isFrontier ? !frontierReady : !hasModel) || registering}
                  title={
                    isFrontier
                      ? !frontierReady
                        ? "Save your frontier configuration to publish"
                        : undefined
                      : !hasModel
                        ? "Select a model to publish"
                        : undefined
                  }
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

      <Modal
        open={customizerOpen && !!draft.avatar.character}
        onClose={() => setCustomizerOpen(false)}
        title="Customize character"
        className="il-modal__card--wide"
      >
        {draft.avatar.character ? (
          <CharacterCustomizer
            character={draft.avatar.character}
            onChange={(character, overridden) => {
              setCharacterOverridden(overridden);
              patch({
                avatar: { ...draft.avatar, character, bg: `#${character.backgroundColor}` },
              });
            }}
          />
        ) : null}
      </Modal>

      <CascadeWarningModal
        open={!!cascade}
        agentName={draft.name || "This agent"}
        placements={cascade ?? []}
        confirming={cascadeConfirming}
        onConfirm={confirmCascade}
        onCancel={() => setCascade(null)}
      />

      {agent ? (
        <FrontierLinkModal
          open={linkModalOpen}
          onClose={() => setLinkModalOpen(false)}
          agentId={agent.agentId}
        />
      ) : null}
    </div>
  );
}

const FRONTIER_MODEL_SUGGESTIONS: Record<FrontierProvider, string[]> = {
  anthropic: ["claude-fable-5", "claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5"],
  openai: ["gpt-5-codex", "gpt-5"],
};

/** Provider/model/API-key form for the Frontier runtime (CONTRACTS §6/§14).
 * Saves through its own dedicated endpoint (never the generic draft PATCH) —
 * the API key never rides `AgentDraft`. "Link a device" only appears once
 * the config has actually been persisted (`ready`). */
function FrontierConfigFields({
  provider,
  model,
  apiKeyInput,
  hasKey,
  last4,
  saving,
  ready,
  onProviderChange,
  onModelChange,
  onApiKeyChange,
  onSave,
  onOpenLinkModal,
}: {
  provider: FrontierProvider;
  model: string;
  apiKeyInput: string;
  hasKey: boolean;
  last4: string | null;
  saving: boolean;
  ready: boolean;
  onProviderChange: (provider: FrontierProvider) => void;
  onModelChange: (model: string) => void;
  onApiKeyChange: (value: string) => void;
  onSave: () => void;
  onOpenLinkModal: () => void;
}) {
  const canSave = model.trim().length > 0 && !saving;

  return (
    <Field
      label="Frontier configuration"
      hint="Runs this agent through an external CLI agent (Claude Code, Codex) on your own machine instead of a local model. Saving switches this agent to the Frontier runtime."
    >
      <div className="il-frontier-config">
        <div className="il-frontier-config__row">
          <label className="il-field__label" htmlFor="ag-frontier-provider">
            Provider
          </label>
          <select
            id="ag-frontier-provider"
            className="il-frontier-config__select"
            value={provider}
            onChange={(e) => onProviderChange(e.target.value as FrontierProvider)}
          >
            <option value="anthropic">Anthropic</option>
            <option value="openai">OpenAI</option>
          </select>
        </div>

        <div className="il-frontier-config__row">
          <label className="il-field__label" htmlFor="ag-frontier-model">
            Model
          </label>
          <Input
            id="ag-frontier-model"
            list="ag-frontier-model-suggestions"
            placeholder="e.g. claude-sonnet-5"
            value={model}
            onChange={(e) => onModelChange(e.target.value)}
          />
          <datalist id="ag-frontier-model-suggestions">
            {FRONTIER_MODEL_SUGGESTIONS[provider].map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </div>

        <div className="il-frontier-config__row">
          <label className="il-field__label" htmlFor="ag-frontier-key">
            API key
          </label>
          <Input
            id="ag-frontier-key"
            type="password"
            autoComplete="off"
            placeholder={hasKey ? `•••• ${last4}` : "Paste the provider API key"}
            value={apiKeyInput}
            onChange={(e) => onApiKeyChange(e.target.value)}
          />
          {!hasKey ? (
            <div className="il-field__hint" style={{ marginTop: 4 }}>
              No key stored yet — the agent isn't linked to an MCP server until you save one.
            </div>
          ) : null}
        </div>

        <div className="il-frontier-config__actions">
          <Button variant="secondary" size="sm" onClick={onSave} disabled={!canSave}>
            {saving ? "Saving…" : "Save frontier configuration"}
          </Button>
          {ready ? (
            <Button variant="accent" size="sm" onClick={onOpenLinkModal}>
              Link a device
            </Button>
          ) : null}
        </div>

        {!ready ? (
          <div className="il-field__note">Not linked yet — save the configuration to enable linking.</div>
        ) : null}
      </div>
    </Field>
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

/** Build a ModelRef from a local file, enriched with the curated display name
 * and origin repoId when the file traces back to a catalog GGUF repo. */
function buildModelRef(
  m: LocalModel,
  catalogModels: CatalogModel[],
): import("@interloom/protocol").ModelRef {
  const catalog = catalogModelForPath(catalogModels, m.path);
  const repoId = repoIdFromLocalPath(m.path) ?? undefined;
  return {
    filename: m.filename,
    displayName: catalog?.name ?? m.filename,
    sizeBytes: m.sizeBytes,
    capabilities: m.capabilities,
    ...(repoId ? { repoId } : {}),
  };
}

function ModelPicker({
  selected,
  localModels,
  loadedModels,
  catalogModels,
  loading,
  onChange,
}: {
  selected: string | null;
  localModels: LocalModel[];
  loadedModels: LoadedModel[];
  catalogModels: CatalogModel[];
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
        {localModels.map((m) => {
          const catalog = catalogModelForPath(catalogModels, m.path);
          const label = catalog ? catalog.name : m.filename;
          return (
            <option key={m.path} value={m.filename}>
              {label} · {bytesToGB(m.sizeBytes)} GB
              {capSuffix(m.capabilities)}
              {loadedModels.some((lm) => lm.path === m.path) ? " · loaded" : ""}
            </option>
          );
        })}
      </select>
      <CapabilityBadges
        capabilities={localModels.find((m) => m.filename === selected)?.capabilities}
        size="sm"
      />
    </div>
  );
}

/** Status line + guarded load affordance next to the model picker (deliverable 3). */
function ModelStatusLine({
  filename,
  loadedModels,
  localModels,
}: {
  filename: string;
  loadedModels: LoadedModel[];
  localModels: LocalModel[];
}) {
  const toasts = useToasts();
  const loadedEntry = loadedModels.find((m) => m.filename === filename);
  const localEntry = localModels.find((m) => m.filename === filename);
  const { loading, spillConfirm, attemptLoad, confirmSpillAndRetry, cancelSpillConfirm } =
    useGuardedModelLoad();

  const quickLoad = async () => {
    if (!localEntry) {
      toasts.error("This model isn't installed on this host yet.");
      return;
    }
    await attemptLoad(localEntry.path, localEntry.filename);
  };

  return (
    <>
      <div className="il-model-status">
        {loadedEntry ? (
          <StatusPill tone="success" live>
            Loaded · {fmtCtxLabel(loadedEntry.ctx)} ctx
          </StatusPill>
        ) : localEntry ? (
          <>
            <StatusPill tone="neutral">Not loaded</StatusPill>
            <Button size="sm" variant="secondary" onClick={() => void quickLoad()} disabled={loading}>
              {loading ? "Loading…" : "Load model"}
            </Button>
          </>
        ) : (
          <StatusPill tone="warning">Not installed on this host</StatusPill>
        )}
      </div>

      {spillConfirm ? (
        <SpillConfirmDialog
          request={spillConfirm}
          loading={loading}
          onCancel={cancelSpillConfirm}
          onConfirm={() => void confirmSpillAndRetry()}
        />
      ) : null}
    </>
  );
}

function ContextBudgetField({
  draft,
  loadedModels,
  agentModelFilename,
  patch,
}: {
  draft: AgentDraft;
  loadedModels: LoadedModel[];
  agentModelFilename: string | null;
  patch: (p: Partial<AgentDraft>) => void;
}) {
  const loadedEntry =
    agentModelFilename != null ? loadedModels.find((m) => m.filename === agentModelFilename) : undefined;
  const agentModelIsActive = !!loadedEntry;
  const loadedCtx = loadedEntry?.ctx ?? null;

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
