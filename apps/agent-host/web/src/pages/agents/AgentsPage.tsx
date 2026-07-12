import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Avatar, Badge, Button, StatusPill } from "@interloom/ui";
import type { HostAgent } from "@interloom/protocol";
import { agents as agentsApi, models as modelsApi } from "../../api/endpoints.js";
import { useAsync } from "../../hooks/useAsync.js";
import { usePoll } from "../../hooks/usePoll.js";
import { LoadError, Skeleton } from "../../components/States.js";
import { relativeTime } from "../../lib/format.js";
import { AgentEditor } from "./AgentEditor.js";
import { PreviewChat } from "./PreviewChat.js";
import type { AgentDraft } from "../../api/types.js";
import type { ActiveModel } from "../../api/types.js";
import "./agents.css";

const NEW_DRAFT: AgentDraft = {
  name: "",
  avatar: { emoji: "🤖", bg: "linear-gradient(135deg,#8b76ee,#6a5acd)" },
  persona: "",
  capabilityBlurb: "",
  params: { temperature: 0.7, contextLength: 4096 },
};

export function AgentsPage() {
  const list = useAsync((s) => agentsApi.list(s), []);
  const activePoll = usePoll<ActiveModel | null>((s) => modelsApi.active(s), 3000, true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creatingNew, setCreatingNew] = useState(false);
  const [liveDraft, setLiveDraft] = useState<AgentDraft>(NEW_DRAFT);

  const agents = list.data ?? [];
  const activeModel = activePoll.data ?? null;

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

  const modelActive = activeModel !== null;

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
    setLiveDraft(NEW_DRAFT);
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
              const isOnline = !!(a.model && activeModel?.filename === a.model.filename);
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
                      bg={a.avatar.bg}
                      size="md"
                      presence={a.model ? (isOnline ? "online" : "offline") : undefined}
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
                            Activate {a.model.filename}
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
        activeModel={activeModel}
        onSaved={handleSaved}
        onDeleted={handleDeleted}
        onDraftChange={setLiveDraft}
      />

      <PreviewChat
        agentId={selected?.agentId ?? null}
        draft={liveDraft}
        modelActive={modelActive}
        activeModel={activeModel}
      />
    </div>
  );
}
