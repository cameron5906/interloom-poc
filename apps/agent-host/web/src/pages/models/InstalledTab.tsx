import { useEffect, useState } from "react";
import { Badge, Button, CapabilityBadges, EmptyState, Modal } from "@interloom/ui";
import type { LocalModel, HostAgent } from "@interloom/protocol";
import type { ActiveModel, ContextOptions, ContextOption } from "../../api/types.js";
import { models as modelsApi, agents as agentsApi } from "../../api/endpoints.js";
import { useAsync } from "../../hooks/useAsync.js";
import { useToasts } from "../../components/Toasts.js";
import { LoadError, Skeleton } from "../../components/States.js";
import { bytesToGB } from "../../lib/format.js";
import { ApiError } from "../../api/client.js";
import { RemoveModelModal } from "./RemoveModelModal.js";

interface InstalledTabProps {
  localModels: LocalModel[];
  activeModel: ActiveModel | null;
  onGoToRecommended: () => void;
  onRefresh: () => void;
}

export function InstalledTab({ localModels, activeModel, onGoToRecommended, onRefresh }: InstalledTabProps) {
  const toasts = useToasts();
  const [loadingPath, setLoadingPath] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<LocalModel | null>(null);
  const [impactTarget, setImpactTarget] = useState<LocalModel | null>(null);

  const agentList = useAsync((s) => agentsApi.list(s), []);
  const allAgents = agentList.data ?? [];

  const activate = async (model: LocalModel, ctx?: number) => {
    setLoadingPath(model.path);
    try {
      const result = await modelsApi.activate(model.path, ctx);
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

  const handleActivateClick = (model: LocalModel) => {
    setImpactTarget(model);
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
        hint="Download a recommended model to run agents on your own hardware."
        action={
          <Button size="sm" variant="primary" onClick={onGoToRecommended}>
            Browse recommended
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
                    onClick={() => handleActivateClick(m)}
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

      {impactTarget ? (
        <ActivationImpactModal
          model={impactTarget}
          allAgents={allAgents}
          loading={loadingPath === impactTarget.path}
          onClose={() => setImpactTarget(null)}
          onConfirm={(ctx) => {
            const m = impactTarget;
            setImpactTarget(null);
            activate(m, ctx);
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

/** Fallback options when the endpoint is unavailable. */
const FALLBACK_OPTIONS: ContextOption[] = [
  { ctx: 4096, kvBytes: 0, fit: "fast" },
  { ctx: 8192, kvBytes: 0, fit: "fast" },
];

function ActivationImpactModal({
  model,
  allAgents,
  loading,
  onClose,
  onConfirm,
}: {
  model: LocalModel;
  allAgents: HostAgent[];
  loading: boolean;
  onClose: () => void;
  onConfirm: (ctx: number) => void;
}) {
  const goingOnline = allAgents.filter((a) => a.model?.filename === model.filename);
  const goingOffline = allAgents.filter((a) => a.model && a.model.filename !== model.filename);

  const [ctxData, setCtxData] = useState<ContextOptions | null>(null);
  const [ctxUnavailable, setCtxUnavailable] = useState(false);
  const [selectedCtx, setSelectedCtx] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();

    modelsApi.contextOptions(model.path, ctrl.signal).then((data) => {
      if (cancelled) return;
      setCtxData(data);
      setSelectedCtx(data.recommendedCtx);
    }).catch((err) => {
      if (cancelled) return;
      if (err instanceof DOMException && err.name === "AbortError") return;
      setCtxUnavailable(true);
      setSelectedCtx(8192);
    });

    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [model.path]);

  const options = ctxData?.options ?? (ctxUnavailable ? FALLBACK_OPTIONS : null);
  const trainedMax = ctxData?.trainedMax;
  const exact = ctxData?.exact ?? true;

  const effectiveCtx = selectedCtx ?? ctxData?.recommendedCtx ?? 8192;

  return (
    <Modal
      open
      onClose={onClose}
      title={<span>Activate {model.filename}?</span>}
      footer={
        <div className="il-impact-modal__actions">
          <Button variant="secondary" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => onConfirm(effectiveCtx)} disabled={loading || options === null}>
            {loading ? "Activating…" : "Activate"}
          </Button>
        </div>
      }
    >
      <div className="il-impact-modal__body">
        {/* Context size picker */}
        <div className="il-impact-modal__section">
          <div className="il-ctx-picker__header">
            <span className="il-impact-modal__label">Context size</span>
            {trainedMax ? (
              <span className="il-ctx-picker__trained-max il-mono il-meta">
                model supports up to {fmtCtx(trainedMax)}
              </span>
            ) : null}
          </div>

          {model.mmprojPath ? (
            <p className="il-meta">
              loads vision projector ({fmtKv(model.mmprojBytes ?? 0).slice(1)}) — included in the fit
              figures below
            </p>
          ) : null}

          {!exact && (
            <p className="il-ctx-picker__estimated il-mono">
              estimated — model metadata unavailable
            </p>
          )}

          {ctxUnavailable && (
            <p className="il-ctx-picker__unavailable il-meta">
              Sizing unavailable — showing defaults.
            </p>
          )}

          {options === null ? (
            <div className="il-ctx-picker__loading il-meta">Loading context options…</div>
          ) : (
            <div className="il-ctx-picker__list" role="radiogroup" aria-label="Context size">
              {options.map((opt) => {
                const isNo = opt.fit === "no";
                const isSelected = selectedCtx === opt.ctx;
                return (
                  <button
                    key={opt.ctx}
                    type="button"
                    role="radio"
                    aria-checked={isSelected}
                    disabled={isNo}
                    className={[
                      "il-ctx-picker__row",
                      isSelected ? "il-ctx-picker__row--sel" : "",
                      isNo ? "il-ctx-picker__row--disabled" : "",
                    ].join(" ").trim()}
                    onClick={() => !isNo && setSelectedCtx(opt.ctx)}
                  >
                    <span className="il-ctx-picker__ctx-label il-mono">{fmtCtx(opt.ctx)}</span>
                    {opt.kvBytes > 0 ? (
                      <span className="il-ctx-picker__kv il-meta il-mono">{fmtKv(opt.kvBytes)} KV</span>
                    ) : null}
                    <span className="il-ctx-picker__fit-wrap">
                      <FitBadge fit={opt.fit} />
                    </span>
                    {opt.fit === "spill" && isSelected ? (
                      <span className="il-ctx-picker__spill-note">
                        exceeds VRAM — offloads to system RAM, expect slower generation; may fail to load
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Agent impact */}
        {goingOnline.length > 0 ? (
          <div className="il-impact-modal__section il-impact-modal__section--spaced">
            <div className="il-impact-modal__label il-impact-modal__label--online">
              {goingOnline.length} agent{goingOnline.length === 1 ? "" : "s"} will come online
            </div>
            <ul className="il-impact-modal__list">
              {goingOnline.map((a) => (
                <li key={a.agentId} className="il-impact-modal__item">
                  <span className="il-impact-modal__dot il-impact-modal__dot--on" />
                  {a.name}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="il-meta il-impact-modal__none il-impact-modal__section--spaced">
            No agents are assigned to this model yet.
          </p>
        )}

        {goingOffline.length > 0 ? (
          <div className="il-impact-modal__section il-impact-modal__section--spaced">
            <div className="il-impact-modal__label il-impact-modal__label--offline">
              {goingOffline.length} agent{goingOffline.length === 1 ? "" : "s"} will go offline
            </div>
            <ul className="il-impact-modal__list">
              {goingOffline.map((a) => (
                <li key={a.agentId} className="il-impact-modal__item">
                  <span className="il-impact-modal__dot il-impact-modal__dot--off" />
                  {a.name}
                  {a.model ? (
                    <span className="il-meta"> · on {a.model.filename}</span>
                  ) : null}
                </li>
              ))}
            </ul>
            <p className="il-impact-modal__note">
              Their mentions will queue in their instance inboxes and drain when you reactivate
              their model.
            </p>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

function FitBadge({ fit }: { fit: "fast" | "spill" | "no" }) {
  if (fit === "fast") {
    return <span className="il-ctx-fit il-ctx-fit--fast">fast</span>;
  }
  if (fit === "spill") {
    return (
      <span className="il-ctx-fit il-ctx-fit--spill" title="exceeds VRAM — offloads to system RAM, expect slower generation; may fail to load">
        spill
      </span>
    );
  }
  return <span className="il-ctx-fit il-ctx-fit--no">won't load</span>;
}
