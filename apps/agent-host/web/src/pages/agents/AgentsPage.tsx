import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Avatar, Badge, Button, StatusPill } from "@interloom/ui";
import type { FrontierProvider, HostAgent, LoadedModel, LocalModel } from "@interloom/protocol";
import { agents as agentsApi, models as modelsApi } from "../../api/endpoints.js";
import { useAsync } from "../../hooks/useAsync.js";
import { usePoll } from "../../hooks/usePoll.js";
import { LoadError, Skeleton } from "../../components/States.js";
import { relativeTime } from "../../lib/format.js";
import { draftAvatarImageUrl } from "../../lib/character.js";
import { AgentEditor } from "./AgentEditor.js";
import { PreviewChat } from "./PreviewChat.js";
import { EMPTY_AGENT_DRAFT } from "../../api/types.js";
import type { AgentDraft } from "../../api/types.js";
import "./agents.css";

export function AgentsPage() {
  const list = useAsync((s) => agentsApi.list(s), []);
  // Loaded-list world (CONTRACTS §6 multi-instance loading) — an agent is
  // online iff its model is among the loaded set, not iff it equals "the"
  // active model. Local models are fetched once here and shared down so the
  // editor's model picker and the preview chat's quick-load button don't each
  // run their own copy.
  const loadedPoll = usePoll<LoadedModel[]>((s) => modelsApi.loaded(s), 2500, true);
  const localModelsAsync = useAsync<LocalModel[]>((s) => modelsApi.local(s), []);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creatingNew, setCreatingNew] = useState(false);
  const [liveDraft, setLiveDraft] = useState<AgentDraft>(EMPTY_AGENT_DRAFT);
  const [liveRuntime, setLiveRuntime] = useState<{
    runtime: "hosted" | "frontier";
    frontierProvider: FrontierProvider;
  }>({ runtime: "hosted", frontierProvider: "anthropic" });

  const agents = list.data ?? [];
  const loadedModels = loadedPoll.data ?? [];
  const localModels = localModelsAsync.data ?? [];

  // Auto-select the first agent once loaded (unless the user is creating one).
  useEffect(() => {
    if (!creatingNew && selectedId === null && agents.length > 0) {
      setSelectedId(agents[0]!.agentId);
    }
  }, [agents, selectedId, creatingNew]);

  const selected: HostAgent | null =
    creatingNew || selectedId === null
      ? null
      : (agents.find((a) => a.agentId === selectedId) ?? null);

  const handleSaved = useCallback(
    (saved: HostAgent) => {
      setCreatingNew(false);
      setSelectedId(saved.agentId);
      list.reload();
    },
    [list],
  );

  const handleDeleted = useCallback(
    (id: string) => {
      setSelectedId((cur) => (cur === id ? null : cur));
      setCreatingNew(false);
      list.reload();
    },
    [list],
  );

  const startNew = () => {
    setCreatingNew(true);
    setSelectedId(null);
    setLiveDraft(EMPTY_AGENT_DRAFT);
  };

  return (
    <div className="il-agents">
      <aside className="il-agents__list il-scroll-fade">
        <div className="il-agents__list-head">
          <span className="il-section-label" style={{ margin: 0 }}>
            Agents
          </span>
          <Button size="sm" variant="secondary" onClick={startNew}>
            + New
          </Button>
        </div>

        {list.loading && list.initialLoad ? (
          <div className="il-agents__list-body">
            {[0, 1, 2].map((i) => (
              <div key={i} className="il-agents__row">
                <Skeleton width={32} height={32} radius={9} />
                <div style={{ flex: 1 }}>
                  <Skeleton width={110} height={13} />
                  <Skeleton width={70} height={10} />
                </div>
              </div>
            ))}
          </div>
        ) : list.error ? (
          <div style={{ padding: 12 }}>
            <LoadError error={list.error} onRetry={list.reload} compact />
          </div>
        ) : agents.length === 0 && !creatingNew ? (
          <div className="il-agents__list-empty">
            <p>No agents yet.</p>
            <Button size="sm" variant="primary" onClick={startNew}>
              Create your first agent
            </Button>
          </div>
        ) : (
          <ul className="il-agents__list-body">
            {creatingNew ? (
              <li>
                <button className="il-agents__row il-agents__row--active">
                  <Avatar name="New agent" isAgent emoji="✨" size="md" />
                  <div className="il-agents__row-main">
                    <span className="il-agents__row-name">New agent</span>
                    <span className="il-meta">unsaved draft</span>
                  </div>
                </button>
              </li>
            ) : null}
            {agents.map((a) => {
              const isOnline = !!(a.model && loadedModels.some((m) => m.filename === a.model!.filename));
              return (
                <li key={a.agentId}>
                  <button
                    className={`il-agents__row${
                      !creatingNew && a.agentId === selectedId ? " il-agents__row--active" : ""
                    }`}
                    onClick={() => {
                      setCreatingNew(false);
                      setSelectedId(a.agentId);
                    }}
                  >
                    <Avatar
                      name={a.name}
                      isAgent
                      emoji={a.avatar.emoji}
                      bg={a.avatar.character ? `#${a.avatar.character.backgroundColor}` : a.avatar.bg}
                      imageUrl={draftAvatarImageUrl(a.avatar)}
                      size="md"
                      presence={a.model ? (isOnline ? "online" : "offline") : undefined}
                      badge={a.runtime === "frontier" ? "frontier" : undefined}
                    />
                    <div className="il-agents__row-main">
                      <span className="il-agents__row-name">
                        <span className="il-agents__row-name-text">{a.name}</span>
                        <Badge variant="agent">AGENT</Badge>
                      </span>
                      <span className="il-meta">
                        {a.registered ? `synced ${relativeTime(a.syncedAt)}` : "unregistered"}
                      </span>
                      {a.model && !isOnline ? (
                        <span className="il-agents__offline-hint">
                          <Link to="/models" className="il-agents__offline-link">
                            Load {a.model.filename}
                          </Link>{" "}
                          to bring online
                        </span>
                      ) : null}
                    </div>
                    <StatusPill
                      tone={isOnline ? "success" : a.model ? "neutral" : "neutral"}
                      live={isOnline}
                    >
                      {isOnline ? "online" : a.model ? "offline" : "no model"}
                    </StatusPill>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </aside>

      <AgentEditor
        key={creatingNew ? "new" : (selectedId ?? "none")}
        agent={selected}
        loadedModels={loadedModels}
        localModels={localModels}
        localModelsLoading={localModelsAsync.loading && localModelsAsync.initialLoad}
        onSaved={handleSaved}
        onDeleted={handleDeleted}
        onDraftChange={setLiveDraft}
        onRuntimeChange={setLiveRuntime}
      />

      <PreviewChat
        agentId={selected?.agentId ?? null}
        draft={liveDraft}
        runtime={liveRuntime.runtime}
        frontierProvider={liveRuntime.frontierProvider}
        loadedModels={loadedModels}
        localModels={localModels}
        onModelLoaded={() => loadedPoll.refresh()}
      />
    </div>
  );
}
