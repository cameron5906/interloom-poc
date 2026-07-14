import { useEffect, useMemo, useState } from "react";
import { Button, Modal } from "@interloom/ui";
import type { GpuBudget, HostAgent, LoadedModel, LocalModel } from "@interloom/protocol";
import type { ContextOptions } from "../../../api/types.js";
import { models as modelsApi } from "../../../api/endpoints.js";
import { ContextSizePicker, FitBadge, fmtCtx } from "../../../components/ModelLoadFlow/ContextSizePicker.js";
import {
  PlacementPicker,
  estimatePlacementFit,
  placementChoiceToBody,
} from "../../../components/ModelLoadFlow/PlacementPicker.js";
import type { PlacementChoice } from "../../../components/ModelLoadFlow/PlacementPicker.js";
import { SpillConfirmDialog } from "../../../components/ModelLoadFlow/SpillConfirmDialog.js";
import { useGuardedModelLoad } from "../../../components/ModelLoadFlow/useGuardedModelLoad.js";
import { bytesToGB } from "../../../lib/format.js";

interface LoadModelWizardProps {
  open: boolean;
  onClose: () => void;
  onLoaded: (model: LoadedModel) => void;
  /** Installed models not currently loaded — the pickable set. */
  candidates: LocalModel[];
  gpus: GpuBudget[];
  /** Every configured agent — used to preview which agents come online for the selected model. */
  allAgents: HostAgent[];
  /** Preselect a model (skips the pick step) — used when opened from a specific row. */
  preselectedPath?: string;
}

/**
 * Full guarded load wizard: pick model → context → placement → live fit
 * preview → confirm. This is the Planner's "Load a model" entry point
 * (CONTRACTS §6 `POST /api/models/load`); the lighter-weight quick-load used
 * from preview chat / the agent editor shares the same
 * `useGuardedModelLoad` guard logic without the full step sequence. Loading
 * is additive (CONTRACTS §6 multi-instance loading) — the impact preview
 * only ever names agents coming ONLINE on the selected model, never agents
 * going offline, since a load never evicts another loaded instance.
 */
export function LoadModelWizard({
  open,
  onClose,
  onLoaded,
  candidates,
  gpus,
  allAgents,
  preselectedPath,
}: LoadModelWizardProps) {
  const [path, setPath] = useState<string | null>(preselectedPath ?? null);
  const [ctxData, setCtxData] = useState<ContextOptions | null>(null);
  const [ctxUnavailable, setCtxUnavailable] = useState(false);
  const [selectedCtx, setSelectedCtx] = useState<number | null>(null);
  const [placement, setPlacement] = useState<PlacementChoice>({ kind: "auto" });

  const { loading, spillConfirm, attemptLoad, confirmSpillAndRetry, cancelSpillConfirm } =
    useGuardedModelLoad((loaded) => {
      onLoaded(loaded);
      onClose();
    });

  const model = useMemo(() => candidates.find((m) => m.path === path) ?? null, [candidates, path]);
  const onlineAgents = useMemo(
    () => (model ? allAgents.filter((a) => a.model?.filename === model.filename) : []),
    [allAgents, model],
  );

  useEffect(() => {
    if (!open) return;
    setPath(preselectedPath ?? null);
    setPlacement({ kind: "auto" });
    setCtxData(null);
    setCtxUnavailable(false);
    setSelectedCtx(null);
  }, [open, preselectedPath]);

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    const ctrl = new AbortController();
    modelsApi
      .contextOptions(path, ctrl.signal)
      .then((data) => {
        if (cancelled) return;
        setCtxData(data);
        setSelectedCtx(data.recommendedCtx);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        setCtxUnavailable(true);
        setSelectedCtx(8192);
      });
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [path]);

  if (!open) return null;

  const options = ctxData?.options ?? (ctxUnavailable ? [{ ctx: 8192, kvBytes: 0, fit: "fast" as const }] : null);
  const selectedOption = options?.find((o) => o.ctx === selectedCtx) ?? null;

  const requiredMB = model
    ? model.sizeBytes / 1024 ** 2 + (selectedOption?.kvBytes ?? 0) / 1024 ** 2
    : 0;

  const effectiveFit =
    placement.kind === "auto"
      ? (selectedOption?.fit ?? "fast")
      : estimatePlacementFit(placement, gpus, requiredMB);

  const canSubmit = !!model && !!selectedCtx && effectiveFit !== "no" && !loading;

  const submit = () => {
    if (!model || !selectedCtx) return;
    void attemptLoad(model.path, model.filename, {
      ctx: selectedCtx,
      placement: placementChoiceToBody(placement, gpus),
    });
  };

  return (
    <>
      <Modal
        open={open && !spillConfirm}
        onClose={onClose}
        title={<span>{model ? `Load ${model.filename}` : "Load a model"}</span>}
        footer={
          <div className="il-load-wizard__actions">
            <Button variant="secondary" onClick={onClose} disabled={loading}>
              Cancel
            </Button>
            <Button variant="primary" onClick={submit} disabled={!canSubmit}>
              {loading ? "Loading…" : "Load model"}
            </Button>
          </div>
        }
      >
        <div className="il-load-wizard__body">
          {!preselectedPath ? (
            <div className="il-field">
              <label className="il-field__label" htmlFor="lw-model">
                Model
              </label>
              <select
                id="lw-model"
                className="il-model-picker__select"
                value={path ?? ""}
                onChange={(e) => setPath(e.target.value || null)}
              >
                <option value="">— Select an installed model —</option>
                {candidates.map((m) => (
                  <option key={m.path} value={m.path}>
                    {m.filename} · {bytesToGB(m.sizeBytes)} GB
                  </option>
                ))}
              </select>
              {candidates.length === 0 ? (
                <div className="il-field__note">
                  Every installed model is already loaded. Download another from the tabs below, or
                  unload one first.
                </div>
              ) : null}
            </div>
          ) : null}

          {model ? (
            <>
              <div className="il-field">
                <div className="il-ctx-picker__header">
                  <span className="il-impact-modal__label">Context size</span>
                  {ctxData?.trainedMax ? (
                    <span className="il-ctx-picker__trained-max il-mono il-meta">
                      model supports up to {fmtCtx(ctxData.trainedMax)}
                    </span>
                  ) : null}
                </div>
                {!ctxData?.exact && ctxData ? (
                  <p className="il-ctx-picker__estimated il-mono">estimated — model metadata unavailable</p>
                ) : null}
                {options === null ? (
                  <div className="il-ctx-picker__loading il-meta">Loading context options…</div>
                ) : (
                  <ContextSizePicker
                    options={options}
                    selected={selectedCtx}
                    onSelect={setSelectedCtx}
                  />
                )}
              </div>

              {gpus.length > 1 ? (
                <div className="il-field">
                  <label className="il-field__label">Placement</label>
                  <PlacementPicker
                    gpus={gpus}
                    choice={placement}
                    onChange={setPlacement}
                    requiredMB={requiredMB}
                  />
                </div>
              ) : null}

              <div className="il-load-wizard__preview">
                <span className="il-field__label">Fit preview</span>
                <span className="il-load-wizard__preview-badge">
                  <FitBadge fit={effectiveFit} />
                  {placement.kind !== "auto" ? <span className="il-meta"> estimated</span> : null}
                </span>
                {effectiveFit === "no" ? (
                  <p className="il-ctx-picker__spill-note il-ctx-picker__spill-note--no">
                    won&apos;t fit — try a smaller context, a different placement, or free VRAM by
                    unloading a model
                  </p>
                ) : null}
              </div>

              {onlineAgents.length > 0 ? (
                <div className="il-impact-modal__section">
                  <div className="il-impact-modal__label il-impact-modal__label--online">
                    {onlineAgents.length} agent{onlineAgents.length === 1 ? "" : "s"} will come online
                  </div>
                  <ul className="il-impact-modal__list">
                    {onlineAgents.map((a) => (
                      <li key={a.agentId} className="il-impact-modal__item">
                        <span className="il-impact-modal__dot il-impact-modal__dot--on" />
                        {a.name}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="il-meta il-impact-modal__none">No agents are assigned to this model yet.</p>
              )}
            </>
          ) : null}
        </div>
      </Modal>

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
