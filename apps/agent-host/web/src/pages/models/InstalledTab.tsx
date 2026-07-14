import { useState } from "react";
import { Badge, Button, CapabilityBadges, EmptyState } from "@interloom/ui";
import type { LoadedModel, LocalModel, SystemInfo } from "@interloom/protocol";
import type { ActivateOptions } from "../../api/types.js";
import { agents as agentsApi } from "../../api/endpoints.js";
import { useAsync } from "../../hooks/useAsync.js";
import { useToasts } from "../../components/Toasts.js";
import { LoadError, Skeleton } from "../../components/States.js";
import { bytesToGB } from "../../lib/format.js";
import { ApiError } from "../../api/client.js";
import { fmtCtx, fmtKv } from "../../components/ModelLoadFlow/ContextSizePicker.js";
import { useGuardedModelLoad } from "../../components/ModelLoadFlow/useGuardedModelLoad.js";
import { SpillConfirmDialog } from "../../components/ModelLoadFlow/SpillConfirmDialog.js";
import { models as modelsApi } from "../../api/endpoints.js";
import { UnloadImpactModal } from "./planner/UnloadImpactModal.js";
import { RemoveModelModal } from "./RemoveModelModal.js";
import { RigOptimizerModal } from "./RigOptimizerModal.js";

interface InstalledTabProps {
  rig: SystemInfo | null;
  localModels: LocalModel[];
  /** Loaded-list world (CONTRACTS §6) — a model is either in this set or it isn't; N can be loaded at once. */
  loadedModels: LoadedModel[];
  onGoToCatalog: () => void;
  onRefresh: () => void;
}

/**
 * Per-model primary action is the guarded LOAD flow (CONTRACTS §6
 * `POST /api/models/load`), not the legacy force-swap `/activate` — loading is
 * additive, so picking a model here never silently evicts another loaded model.
 * The rig-optimizer picks the context plan (ctx + KV-cache precision + MoE
 * offload) and those plan parameters ride the load body; the guarded hook then
 * handles the 409 fit outcomes (wont_fit / needs_confirm+spill / filename
 * conflict). A row already in the loaded set shows a "LOADED" badge and an
 * Unload action instead.
 */
export function InstalledTab({ rig, localModels, loadedModels, onGoToCatalog, onRefresh }: InstalledTabProps) {
  const toasts = useToasts();
  const [optimizeTarget, setOptimizeTarget] = useState<LocalModel | null>(null);
  const [unloadTarget, setUnloadTarget] = useState<LoadedModel | null>(null);
  const [unloading, setUnloading] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<LocalModel | null>(null);

  const agentList = useAsync((s) => agentsApi.list(s), []);
  const allAgents = agentList.data ?? [];

  const guarded = useGuardedModelLoad(() => {
    setOptimizeTarget(null);
    onRefresh();
  });

  const loadWithPlan = (model: LocalModel, opts: ActivateOptions) => {
    void guarded.attemptLoad(model.path, model.filename, {
      ...(opts.ctx != null ? { ctx: opts.ctx } : {}),
      ...(opts.kvCache != null ? { kvCache: opts.kvCache } : {}),
      ...(opts.nCpuMoe != null ? { nCpuMoe: opts.nCpuMoe } : {}),
    });
  };

  const confirmUnload = async () => {
    if (!unloadTarget) return;
    setUnloading(true);
    try {
      await modelsApi.unload(unloadTarget.path);
      toasts.success(`${unloadTarget.filename} unloaded`);
      setUnloadTarget(null);
      onRefresh();
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        toasts.error("That model wasn't loaded — refreshing.");
        setUnloadTarget(null);
        onRefresh();
      } else {
        toasts.error(
          err instanceof ApiError && err.isOffline ? "Daemon unreachable — can't unload." : "Unload failed.",
        );
      }
    } finally {
      setUnloading(false);
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
        hint="Pick a model from the catalog that fits your rig, then download and load it here."
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
          const loadedEntry = loadedModels.find((lm) => lm.path === m.path);
          const isLoaded = !!loadedEntry;
          const agentsOnThisModel = allAgents.filter((a) => a.model?.filename === m.filename);

          return (
            <div
              key={m.path}
              className={`il-installed__row${isLoaded ? " il-installed__row--loaded" : ""}`}
            >
              <div className="il-installed__main">
                <div className="il-installed__name">
                  <span className="il-mono il-installed__filename">{m.filename}</span>
                  {isLoaded ? <Badge variant="success">LOADED</Badge> : null}
                  <CapabilityBadges capabilities={m.capabilities} size="sm" />
                </div>
                <div className="il-meta">
                  {bytesToGB(m.sizeBytes)} GB
                  {isLoaded && loadedEntry?.ctx ? (
                    <span className="il-installed__ctx-suffix il-mono"> @ {fmtCtx(loadedEntry.ctx)} ctx</span>
                  ) : null}
                </div>
                {m.mmprojPath ? (
                  <div className="il-meta">vision projector paired ({fmtKv(m.mmprojBytes ?? 0).slice(1)})</div>
                ) : m.capabilities?.vision ? (
                  <div className="il-meta">vision projector missing — re-download from Search to enable vision</div>
                ) : null}
                {isLoaded && agentsOnThisModel.length > 0 ? (
                  <div className="il-installed__agents-online il-meta">
                    {agentsOnThisModel.length} agent{agentsOnThisModel.length === 1 ? "" : "s"} online on this model
                  </div>
                ) : null}
              </div>
              <div className="il-installed__row-actions">
                {isLoaded ? (
                  <Button size="sm" variant="secondary" onClick={() => setUnloadTarget(loadedEntry)}>
                    Unload
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => setOptimizeTarget(m)}
                    disabled={guarded.loading}
                  >
                    Load
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setRemoveTarget(m)}
                  className="il-installed__remove-btn"
                >
                  Remove
                </Button>
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
          loading={guarded.loading}
          onClose={() => setOptimizeTarget(null)}
          onConfirm={(opts) => loadWithPlan(optimizeTarget, opts)}
        />
      ) : null}

      {guarded.spillConfirm ? (
        <SpillConfirmDialog
          request={guarded.spillConfirm}
          loading={guarded.loading}
          onCancel={guarded.cancelSpillConfirm}
          onConfirm={() => void guarded.confirmSpillAndRetry()}
        />
      ) : null}

      {unloadTarget ? (
        <UnloadImpactModal
          model={unloadTarget}
          allAgents={allAgents}
          loading={unloading}
          onClose={() => setUnloadTarget(null)}
          onConfirm={() => void confirmUnload()}
        />
      ) : null}

      {removeTarget ? (
        <RemoveModelModal
          model={removeTarget}
          loadedModels={loadedModels}
          onClose={() => setRemoveTarget(null)}
          onUnloaded={onRefresh}
          onRemoved={() => {
            setRemoveTarget(null);
            onRefresh();
          }}
        />
      ) : null}
    </>
  );
}
