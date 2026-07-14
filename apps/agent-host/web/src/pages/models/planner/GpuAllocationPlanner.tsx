import { useMemo, useState } from "react";
import { Badge, Button, Card, EmptyState } from "@interloom/ui";
import type { GpuBudget, HostAgent, LoadedModel, LocalModel, ModelSettings } from "@interloom/protocol";
import { agents as agentsApi, models as modelsApi } from "../../../api/endpoints.js";
import { usePoll } from "../../../hooks/usePoll.js";
import { useAsync } from "../../../hooks/useAsync.js";
import { useToasts } from "../../../components/Toasts.js";
import { ApiError } from "../../../api/client.js";
import { mbToGB } from "../../../lib/format.js";
import { FitBadge, fmtCtx } from "../../../components/ModelLoadFlow/ContextSizePicker.js";
import { GpuBudgetBar } from "./GpuBudgetBar.js";
import type { GpuBarSegment } from "./GpuBudgetBar.js";
import { GpuBridgeConnector } from "./GpuBridgeConnector.js";
import { LoadModelWizard } from "./LoadModelWizard.js";
import { UnloadImpactModal } from "./UnloadImpactModal.js";
import { ModelSettingsToggle } from "./ModelSettingsToggle.js";
import { modelColor } from "./colors.js";
import "./planner.css";

/** Per-GPU segments for every loaded model, split evenly among co-resident
 * models on that GPU (CONTRACTS §6 doesn't expose a finer breakdown). */
function segmentsForGpu(gpuIndex: number, loaded: LoadedModel[]): GpuBarSegment[] {
  const onThisGpu = loaded.filter((m) => m.gpus.includes(gpuIndex));
  if (onThisGpu.length === 0) return [];
  const share = 1 / onThisGpu.length;
  return onThisGpu.map((model) => ({
    model,
    colorIndex: loaded.indexOf(model),
    shareOfCommitted: share,
  }));
}

export function GpuAllocationPlanner() {
  const toasts = useToasts();
  const allocationPoll = usePoll((s) => modelsApi.allocation(s), 2000, true);
  const localModelsAsync = useAsync((s) => modelsApi.local(s), []);
  const agentsAsync = useAsync((s) => agentsApi.list(s), []);
  const settingsAsync = useAsync((s) => modelsApi.settingsList(s), []);

  const [wizardOpen, setWizardOpen] = useState(false);
  const [unloadTarget, setUnloadTarget] = useState<LoadedModel | null>(null);
  const [unloading, setUnloading] = useState(false);

  const allocation = allocationPoll.data;
  const gpus: GpuBudget[] = allocation?.gpus ?? [];
  const loaded: LoadedModel[] = allocation?.loaded ?? [];
  const localModels: LocalModel[] = localModelsAsync.data ?? [];
  const allAgents: HostAgent[] = agentsAsync.data ?? [];
  const settingsList: ModelSettings[] = settingsAsync.data ?? [];

  const loadedPaths = useMemo(() => new Set(loaded.map((m) => m.path)), [loaded]);
  const candidates = useMemo(
    () => localModels.filter((m) => !loadedPaths.has(m.path)),
    [localModels, loadedPaths],
  );

  const gpusSorted = useMemo(() => [...gpus].sort((a, b) => a.index - b.index), [gpus]);

  const bridgeFor = (gpuA: GpuBudget, gpuB: GpuBudget): LoadedModel | null =>
    loaded.find((m) => m.gpus.length > 1 && m.gpus.includes(gpuA.index) && m.gpus.includes(gpuB.index)) ??
    null;

  const refreshAll = () => {
    allocationPoll.refresh();
    localModelsAsync.reload();
    agentsAsync.reload();
  };

  const agentsFor = (filename: string) => allAgents.filter((a) => a.model?.filename === filename);

  const confirmUnload = async () => {
    if (!unloadTarget) return;
    setUnloading(true);
    try {
      await modelsApi.unload(unloadTarget.path);
      toasts.success(`${unloadTarget.filename} unloaded`);
      setUnloadTarget(null);
      refreshAll();
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        toasts.error("That model wasn't loaded — refreshing.");
        setUnloadTarget(null);
        refreshAll();
      } else {
        toasts.error(
          err instanceof ApiError && err.isOffline ? "Daemon unreachable — can't unload." : "Unload failed.",
        );
      }
    } finally {
      setUnloading(false);
    }
  };

  const settingsFor = (filename: string) => settingsList.find((s) => s.filename === filename);

  const loading = allocationPoll.data === undefined;

  return (
    <section className="il-planner">
      <div className="il-planner__head">
        <div>
          <h2 className="il-section-label" style={{ margin: 0 }}>
            GPU allocation
          </h2>
          {allocation ? (
            <p className="il-planner__concurrency il-meta">
              {loaded.length === 0
                ? "No models loaded"
                : `${loaded.length} model${loaded.length === 1 ? "" : "s"} loaded — up to ${
                    allocation.maxConcurrentAgents
                  } agent${allocation.maxConcurrentAgents === 1 ? "" : "s"} can respond at once; agents sharing a model take turns`}
            </p>
          ) : null}
        </div>
        <Button size="sm" variant="primary" onClick={() => setWizardOpen(true)} disabled={loading}>
          + Load a model
        </Button>
      </div>

      {loading ? (
        <Card className="il-planner__loading">
          <span className="il-meta">Loading GPU allocation…</span>
        </Card>
      ) : gpus.length === 0 ? (
        <EmptyState
          title="No GPU detected"
          hint="This host is running in CPU mode — GPU allocation planning isn't available."
        />
      ) : (
        <>
          <div className="il-planner__gpus">
            {gpusSorted.map((gpu, i) => (
              <div key={gpu.index} className="il-planner__gpu-slot">
                <GpuBudgetBar gpu={gpu} segments={segmentsForGpu(gpu.index, loaded)} />
                {i < gpusSorted.length - 1
                  ? (() => {
                      const bridged = bridgeFor(gpu, gpusSorted[i + 1]!);
                      return bridged ? (
                        <GpuBridgeConnector model={bridged} colorIndex={loaded.indexOf(bridged)} />
                      ) : (
                        <div className="il-planner__gpu-gap" />
                      );
                    })()
                  : null}
              </div>
            ))}
          </div>

          {loaded.length === 0 ? (
            <EmptyState
              className="il-planner__empty"
              title="Nothing loaded yet"
              hint="Load a model onto your GPU(s) to bring its agents online."
              action={
                <Button size="sm" variant="primary" onClick={() => setWizardOpen(true)}>
                  Load a model
                </Button>
              }
            />
          ) : (
            <ul className="il-planner__loaded-list">
              {loaded.map((m) => {
                const agentsOnModel = agentsFor(m.filename);
                const thinkingCapable =
                  m.model?.capabilities?.thinking ??
                  localModels.find((lm) => lm.path === m.path)?.capabilities?.thinking ??
                  false;
                const settings = settingsFor(m.filename);
                return (
                  <li key={m.filename} className="il-planner__loaded-row">
                    <div className="il-planner__loaded-main">
                      <div className="il-planner__loaded-name">
                        <span
                          className="il-planner__loaded-dot"
                          style={{ background: modelColor(loaded.indexOf(m)) }}
                          aria-hidden
                        />
                        <span className="il-mono">{m.filename}</span>
                        <FitBadge fit={m.fit} />
                        {m.gpus.length > 1 ? <Badge variant="agent">FUSED</Badge> : null}
                        {m.health !== "ready" ? <Badge variant="warning">{m.health}</Badge> : null}
                      </div>
                      <div className="il-meta il-planner__loaded-sub">
                        {fmtCtx(m.ctx)} ctx · port {m.port} · GPU{m.gpus.length > 1 ? "s" : ""}{" "}
                        {m.gpus.join(" + ")}
                        {" · "}
                        {agentsOnModel.length} agent{agentsOnModel.length === 1 ? "" : "s"} on this model
                      </div>
                      {thinkingCapable ? (
                        <ModelSettingsToggle
                          filename={m.filename}
                          disableThinking={settings?.disableThinking ?? false}
                          loaded
                          onChanged={() => settingsAsync.reload()}
                        />
                      ) : null}
                    </div>
                    <Button size="sm" variant="secondary" onClick={() => setUnloadTarget(m)}>
                      Unload
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}

          {gpus.length > 0 ? (
            <div className="il-planner__totals il-meta">
              {mbToGB(gpus.reduce((s, g) => s + g.vramCommittedMB, 0))} /{" "}
              {mbToGB(gpus.reduce((s, g) => s + g.vramTotalMB, 0))} GB committed across{" "}
              {gpus.length} GPU{gpus.length === 1 ? "" : "s"}
            </div>
          ) : null}
        </>
      )}

      <LoadModelWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onLoaded={() => refreshAll()}
        candidates={candidates}
        gpus={gpus}
        allAgents={allAgents}
      />

      {unloadTarget ? (
        <UnloadImpactModal
          model={unloadTarget}
          allAgents={allAgents}
          loading={unloading}
          onClose={() => setUnloadTarget(null)}
          onConfirm={() => void confirmUnload()}
        />
      ) : null}
    </section>
  );
}
