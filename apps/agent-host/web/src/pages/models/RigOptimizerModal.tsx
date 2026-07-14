import { useEffect, useMemo, useState } from "react";
import { Button, Modal } from "@interloom/ui";
import type { HostAgent, LocalModel, SystemInfo } from "@interloom/protocol";
import type { ActivateOptions, ContextOptions, ContextOption, ContextPlan } from "../../api/types.js";
import { models as modelsApi } from "../../api/endpoints.js";

interface RigOptimizerModalProps {
  model: LocalModel;
  rig: SystemInfo | null;
  allAgents: HostAgent[];
  loading: boolean;
  onClose: () => void;
  onConfirm: (opts: ActivateOptions) => void;
}

/** Fallback context rungs when `/api/models/context-options` is unavailable. */
const FALLBACK_OPTIONS: ContextOption[] = [
  { ctx: 4096, kvBytes: 0, fit: "fast" },
  { ctx: 8192, kvBytes: 0, fit: "fast" },
];

/**
 * The rig optimizer: pick how the model loads. When the daemon returns context
 * `plans` it renders a plan ladder with a VRAM budget bar; otherwise it degrades
 * to the plain context-rung radio picker (older daemon).
 */
export function RigOptimizerModal({
  model,
  rig,
  allAgents,
  loading,
  onClose,
  onConfirm,
}: RigOptimizerModalProps) {
  const goingOnline = allAgents.filter((a) => a.model?.filename === model.filename);
  const goingOffline = allAgents.filter((a) => a.model && a.model.filename !== model.filename);

  const [ctxData, setCtxData] = useState<ContextOptions | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [planIdx, setPlanIdx] = useState<number | null>(null);
  const [ctxValue, setCtxValue] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    modelsApi
      .contextOptions(model.path, ctrl.signal)
      .then((data) => {
        if (cancelled) return;
        setCtxData(data);
        if (data.plans && data.plans.length > 0) {
          const recIdx = data.recommendedPlan
            ? data.plans.findIndex(
                (p) =>
                  p.ctx === data.recommendedPlan!.ctx &&
                  p.kvCache === data.recommendedPlan!.kvCache &&
                  p.offload === data.recommendedPlan!.offload,
              )
            : -1;
          const firstFit = data.plans.findIndex((p) => p.fit !== "no");
          setPlanIdx(recIdx >= 0 ? recIdx : firstFit >= 0 ? firstFit : 0);
        } else {
          setCtxValue(data.recommendedCtx);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        setUnavailable(true);
        setCtxValue(8192);
      });
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [model.path]);

  const plans = ctxData?.plans;
  const options = ctxData?.options ?? (unavailable ? FALLBACK_OPTIONS : null);
  const capacityMB = rigCapacityMB(rig);

  const selectedPlan = plans && planIdx != null ? plans[planIdx] : undefined;
  const effectiveOpts: ActivateOptions | null = useMemo(() => {
    if (selectedPlan) {
      return {
        ctx: selectedPlan.ctx,
        kvCache: selectedPlan.kvCache,
        ...(selectedPlan.nCpuMoe != null ? { nCpuMoe: selectedPlan.nCpuMoe } : {}),
      };
    }
    if (ctxValue != null) return { ctx: ctxValue };
    return null;
  }, [selectedPlan, ctxValue]);

  const ready = plans ? selectedPlan != null && selectedPlan.fit !== "no" : options != null;

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
          <Button
            variant="primary"
            onClick={() => effectiveOpts && onConfirm(effectiveOpts)}
            disabled={loading || !ready || !effectiveOpts}
          >
            {loading ? "Activating…" : "Activate"}
          </Button>
        </div>
      }
    >
      <div className="il-impact-modal__body">
        <div className="il-impact-modal__section">
          <div className="il-ctx-picker__header">
            <span className="il-impact-modal__label">How it loads</span>
            {ctxData?.trainedMax ? (
              <span className="il-ctx-picker__trained-max il-mono il-meta">
                trained to {fmtCtx(ctxData.trainedMax)}
              </span>
            ) : null}
          </div>

          {model.mmprojPath ? (
            <p className="il-meta">Loads the paired vision projector — included in the figures below.</p>
          ) : null}

          {ctxData && !ctxData.exact ? (
            <p className="il-ctx-picker__estimated il-mono">estimated — model metadata unavailable</p>
          ) : null}
          {unavailable ? (
            <p className="il-ctx-picker__unavailable il-meta">Sizing unavailable — showing defaults.</p>
          ) : null}

          {plans && plans.length > 0 ? (
            <PlanLadder
              plans={plans}
              selectedIdx={planIdx}
              capacityMB={capacityMB}
              onSelect={setPlanIdx}
            />
          ) : options === null ? (
            <div className="il-ctx-picker__loading il-meta">Loading options…</div>
          ) : (
            <ContextRadio options={options} selected={ctxValue} onSelect={setCtxValue} />
          )}
        </div>

        <AgentImpact goingOnline={goingOnline} goingOffline={goingOffline} />
      </div>
    </Modal>
  );
}

function PlanLadder({
  plans,
  selectedIdx,
  capacityMB,
  onSelect,
}: {
  plans: ContextPlan[];
  selectedIdx: number | null;
  capacityMB: number | null;
  onSelect: (i: number) => void;
}) {
  // Group by ctx rung (highest first) so each rung reads as one decision.
  const rungs = useMemo(() => {
    const byCtx = new Map<number, Array<{ plan: ContextPlan; idx: number }>>();
    plans.forEach((plan, idx) => {
      const list = byCtx.get(plan.ctx) ?? [];
      list.push({ plan, idx });
      byCtx.set(plan.ctx, list);
    });
    return [...byCtx.entries()].sort((a, b) => b[0] - a[0]);
  }, [plans]);

  return (
    <div className="il-planladder">
      {rungs.map(([ctx, entries]) => (
        <div key={ctx} className="il-planrung">
          <div className="il-planrung__ctx il-mono">{fmtCtx(ctx)}</div>
          <div className="il-planrung__plans">
            {entries.map(({ plan, idx }) => (
              <PlanRow
                key={`${plan.kvCache}-${plan.offload}`}
                plan={plan}
                selected={selectedIdx === idx}
                capacityMB={capacityMB}
                onSelect={() => plan.fit !== "no" && onSelect(idx)}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function PlanRow({
  plan,
  selected,
  capacityMB,
  onSelect,
}: {
  plan: ContextPlan;
  selected: boolean;
  capacityMB: number | null;
  onSelect: () => void;
}) {
  const disabled = plan.fit === "no";
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      className={[
        "il-planrow",
        selected ? "il-planrow--sel" : "",
        disabled ? "il-planrow--disabled" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      onClick={onSelect}
    >
      <div className="il-planrow__top">
        <span className="il-planrow__label">{plan.label}</span>
        <PlanFit fit={plan.fit} offload={plan.offload} />
      </div>
      <BudgetBar plan={plan} capacityMB={capacityMB} />
      <div className="il-planrow__notes">
        {plan.kvCache === "q8_0" ? (
          <span className="il-planrow__note">
            compressed context memory — near-lossless, fits ~2× more
          </span>
        ) : null}
        {plan.offload === "experts_cpu" ? (
          <span className="il-planrow__note">
            keeps the busy parts on GPU, parks experts in system RAM
          </span>
        ) : null}
        {plan.offload === "cpu" ? (
          <span className="il-planrow__note">runs in system RAM — CPU generation on this rig</span>
        ) : plan.fit === "spill" ? (
          <span className="il-planrow__note il-planrow__note--warn">
            exceeds VRAM — offloads to system RAM, expect slower generation
          </span>
        ) : null}
      </div>
    </button>
  );
}

function BudgetBar({ plan, capacityMB }: { plan: ContextPlan; capacityMB: number | null }) {
  const kvMB = plan.kvBytes / (1024 * 1024);
  const needMB = plan.offload === "cpu" ? plan.ramNeedMB : plan.vramNeedMB;
  const weightsMB = Math.max(0, needMB - kvMB);
  if (!capacityMB) {
    return (
      <div className="il-budget__caption il-meta">
        needs ≈ {fmtGB(plan.vramNeedMB)} GB VRAM · {fmtGB(plan.ramNeedMB)} GB RAM
      </div>
    );
  }
  const scale = Math.max(capacityMB, needMB) * 1.05;
  const wPct = (weightsMB / scale) * 100;
  const kPct = (kvMB / scale) * 100;
  const capPct = (capacityMB / scale) * 100;
  const over = needMB > capacityMB;

  return (
    <div className="il-budget">
      <div className="il-budget__track">
        <div className="il-budget__seg il-budget__seg--weights" style={{ width: `${wPct}%` }} />
        <div className="il-budget__seg il-budget__seg--kv" style={{ width: `${kPct}%` }} />
        <div className="il-budget__cap" style={{ left: `${capPct}%` }} title="your VRAM" />
      </div>
      <div className="il-budget__caption il-meta">
        model + overhead {fmtGB(weightsMB)} + context {fmtGB(kvMB)} GB
        {over
          ? plan.offload === "cpu"
            ? " · over your RAM"
            : " · over your VRAM"
          : ` of ${fmtGB(capacityMB)} GB`}
      </div>
    </div>
  );
}

function ContextRadio({
  options,
  selected,
  onSelect,
}: {
  options: ContextOption[];
  selected: number | null;
  onSelect: (ctx: number) => void;
}) {
  return (
    <div className="il-ctx-picker__list" role="radiogroup" aria-label="Context size">
      {options.map((opt) => {
        const isNo = opt.fit === "no";
        const isSel = selected === opt.ctx;
        return (
          <button
            key={opt.ctx}
            type="button"
            role="radio"
            aria-checked={isSel}
            disabled={isNo}
            className={[
              "il-ctx-picker__row",
              isSel ? "il-ctx-picker__row--sel" : "",
              isNo ? "il-ctx-picker__row--disabled" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            onClick={() => !isNo && onSelect(opt.ctx)}
          >
            <span className="il-ctx-picker__ctx-label il-mono">{fmtCtx(opt.ctx)}</span>
            {opt.kvBytes > 0 ? (
              <span className="il-ctx-picker__kv il-meta il-mono">{fmtGB(opt.kvBytes / (1024 * 1024))} GB KV</span>
            ) : null}
            <span className="il-ctx-picker__fit-wrap">
              <PlanFit fit={opt.fit} />
            </span>
            {opt.fit === "spill" && isSel ? (
              <span className="il-ctx-picker__spill-note">
                exceeds VRAM — offloads to system RAM, expect slower generation; may fail to load
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

function PlanFit({
  fit,
  offload,
}: {
  fit: "fast" | "spill" | "no";
  offload?: ContextPlan["offload"];
}) {
  if (offload === "cpu" && fit !== "no") {
    return <span className="il-ctx-fit il-ctx-fit--cpu">CPU</span>;
  }
  const label = fit === "fast" ? "fast" : fit === "spill" ? "spill" : "won't load";
  return <span className={`il-ctx-fit il-ctx-fit--${fit}`}>{label}</span>;
}

function AgentImpact({
  goingOnline,
  goingOffline,
}: {
  goingOnline: HostAgent[];
  goingOffline: HostAgent[];
}) {
  return (
    <>
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
                {a.model ? <span className="il-meta"> · on {a.model.filename}</span> : null}
              </li>
            ))}
          </ul>
          <p className="il-impact-modal__note">
            Their mentions will queue in their instance inboxes and drain when you reactivate their
            model.
          </p>
        </div>
      ) : null}
    </>
  );
}

function rigCapacityMB(rig: SystemInfo | null): number | null {
  const gpu = rig?.gpus?.[0];
  if (gpu && gpu.kind !== "none" && gpu.vramMB > 0) return gpu.vramMB;
  if (rig?.unifiedMemoryMB && rig.unifiedMemoryMB > 0) return rig.unifiedMemoryMB;
  if (rig?.systemRamMB && rig.systemRamMB > 0) return rig.systemRamMB;
  return null;
}

function fmtGB(mb: number): string {
  return (mb / 1024).toFixed(1);
}

function fmtCtx(ctx: number): string {
  if (ctx >= 1024 && ctx % 1024 === 0) return `${ctx / 1024}K`;
  if (ctx >= 1000) return `${Math.round(ctx / 1000)}K`;
  return String(ctx);
}
