import { useState } from "react";
import { Badge, Button, CapabilityBadges, EmptyState } from "@interloom/ui";
import type { LocalModel, SystemInfo } from "@interloom/protocol";
import type { ActivateOptions, ActiveModel } from "../../api/types.js";
import { models as modelsApi, agents as agentsApi } from "../../api/endpoints.js";
import { useAsync } from "../../hooks/useAsync.js";
import { useToasts } from "../../components/Toasts.js";
import { LoadError, Skeleton } from "../../components/States.js";
import { bytesToGB } from "../../lib/format.js";
import { ApiError } from "../../api/client.js";
import { RemoveModelModal } from "./RemoveModelModal.js";
import { RigOptimizerModal } from "./RigOptimizerModal.js";

interface InstalledTabProps {
  rig: SystemInfo | null;
  localModels: LocalModel[];
  activeModel: ActiveModel | null;
  onGoToCatalog: () => void;
  onRefresh: () => void;
}

export function InstalledTab({ rig, localModels, activeModel, onGoToCatalog, onRefresh }: InstalledTabProps) {
  const toasts = useToasts();
  const [loadingPath, setLoadingPath] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<LocalModel | null>(null);
  const [optimizeTarget, setOptimizeTarget] = useState<LocalModel | null>(null);

  const agentList = useAsync((s) => agentsApi.list(s), []);
  const allAgents = agentList.data ?? [];

  const activate = async (model: LocalModel, opts: ActivateOptions) => {
    setLoadingPath(model.path);
    try {
      const result = await modelsApi.activate(model.path, opts);
      if (result.status === "ready") {
        toasts.success(`${model.filename} is now serving inference`);
        onRefresh();
      } else if (result.status === "error") {
        toasts.error(result.error ?? "Model failed to load.");
      }
    } catch (err) {
      toasts.error(
        err instanceof ApiError && err.isOffline
          ? "Daemon unreachable — can't activate."
          : "Activation failed.",
      );
    } finally {
      setLoadingPath(null);
    }
  };

  if (agentList.loading && agentList.initialLoad && localModels.length === 0) {
    return (
      <div className="il-installed">
        {[0, 1].map((i) => (
          <div key={i} className="il-installed__row">
            <Skeleton width={220} height={15} />
            <Skeleton width={90} height={28} radius={7} />
          </div>
        ))}
      </div>
    );
  }

  if (agentList.error) return <LoadError error={agentList.error} onRetry={agentList.reload} />;

  if (localModels.length === 0) {
    return (
      <EmptyState
        title="No models installed yet"
        hint="Pick a model from the catalog that fits your rig, then download and activate it here."
        action={
          <Button size="sm" variant="primary" onClick={onGoToCatalog}>
            Browse the catalog
          </Button>
        }
      />
    );
  }

  return (
    <>
      <div className="il-installed">
        {localModels.map((m) => {
          const isActive = activeModel?.filename === m.filename;
          const isLoading = loadingPath === m.path;
          const agentsOnThisModel = allAgents.filter((a) => a.model?.filename === m.filename);

          return (
            <div
              key={m.path}
              className={`il-installed__row${isActive ? " il-installed__row--active" : ""}`}
            >
              <div className="il-installed__main">
                <div className="il-installed__name">
                  <span className="il-mono il-installed__filename">{m.filename}</span>
                  {isActive ? <Badge variant="success">ACTIVE</Badge> : null}
                  <CapabilityBadges capabilities={m.capabilities} size="sm" />
                </div>
                <div className="il-meta">
                  {bytesToGB(m.sizeBytes)} GB
                  {isActive && activeModel?.ctx ? (
                    <span className="il-installed__ctx-suffix il-mono"> @ {fmtCtx(activeModel.ctx)} ctx</span>
                  ) : null}
                </div>
                {m.mmprojPath ? (
                  <div className="il-meta">vision projector paired ({fmtKv(m.mmprojBytes ?? 0).slice(1)})</div>
                ) : m.capabilities?.vision ? (
                  <div className="il-meta">vision projector missing — re-download from Search to enable vision</div>
                ) : null}
                {isActive && agentsOnThisModel.length > 0 ? (
                  <div className="il-installed__agents-online il-meta">
                    {agentsOnThisModel.length} agent{agentsOnThisModel.length === 1 ? "" : "s"} online on this model
                  </div>
                ) : null}
                {isLoading ? (
                  <div className="il-installed__loading">
                    <div
                      className="il-installed__loading-bar"
                      role="progressbar"
                      aria-label="Loading model into inference server"
                    />
                    <span className="il-meta">Loading model into inference server…</span>
                  </div>
                ) : null}
              </div>
              <div className="il-installed__row-actions">
                {isActive ? (
                  <span className="il-installed__serving">Serving</span>
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setOptimizeTarget(m)}
                    disabled={isLoading}
                  >
                    {isLoading ? "Activating…" : "Activate"}
                  </Button>
                )}
                {!isActive ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setRemoveTarget(m)}
                    disabled={isLoading}
                    className="il-installed__remove-btn"
                  >
                    Remove
                  </Button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      {optimizeTarget ? (
        <RigOptimizerModal
          model={optimizeTarget}
          rig={rig}
          allAgents={allAgents}
          loading={loadingPath === optimizeTarget.path}
          onClose={() => setOptimizeTarget(null)}
          onConfirm={(opts) => {
            const m = optimizeTarget;
            setOptimizeTarget(null);
            activate(m, opts);
          }}
        />
      ) : null}

      {removeTarget ? (
        <RemoveModelModal
          model={removeTarget}
          activeModel={activeModel}
          onClose={() => setRemoveTarget(null)}
          onRemoved={() => {
            setRemoveTarget(null);
            onRefresh();
          }}
        />
      ) : null}
    </>
  );
}

/** Format a context token count as "8k", "16k", "128k", etc. */
function fmtCtx(ctx: number): string {
  if (ctx >= 1024 && ctx % 1024 === 0) return `${ctx / 1024}k`;
  if (ctx >= 1000) return `${Math.round(ctx / 1000)}k`;
  return String(ctx);
}

/** Format KV cache bytes as "+2.1 GB" or "+512 MB". */
function fmtKv(bytes: number): string {
  if (bytes >= 1024 ** 3) return `+${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `+${Math.round(bytes / 1024 ** 2)} MB`;
  return `+${Math.round(bytes / 1024)} KB`;
}
