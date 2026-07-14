import type { GpuBudget, LoadedModel } from "@interloom/protocol";
import { mbToGB } from "../../../lib/format.js";
import { modelColor } from "./colors.js";

export interface GpuBarSegment {
  model: LoadedModel;
  /** Index of this model within the full `loaded` list — drives its stable color. */
  colorIndex: number;
  /** Share of THIS gpu's committed VRAM attributed to this model, 0..1. */
  shareOfCommitted: number;
  /** Marks a not-yet-loaded candidate in a before/after preview (load wizard's
   * resource impact panel) — rendered with a dashed outline instead of a solid fill. */
  isPreview?: boolean;
}

/**
 * One GPU's budget bar (CONTRACTS §6 `GpuBudget`): committed vs free VRAM,
 * with a segment per loaded model placed here. The daemon doesn't expose a
 * per-model-per-GPU MB breakdown, so when multiple models share a GPU their
 * segments split the committed width evenly — an honest approximation, not a
 * precise accounting (noted via the segment's title tooltip).
 */
export function GpuBudgetBar({ gpu, segments }: { gpu: GpuBudget; segments: GpuBarSegment[] }) {
  const committedFrac = gpu.vramTotalMB > 0 ? gpu.vramCommittedMB / gpu.vramTotalMB : 0;
  const freeFrac = 1 - committedFrac;
  const tone = freeFrac < 0.1 ? "danger" : freeFrac < 0.25 ? "warning" : "accent";

  return (
    <div className="il-gpubar" data-gpu-index={gpu.index}>
      <div className="il-gpubar__head">
        <span className="il-gpubar__name">
          <span className="il-gpubar__index">GPU {gpu.index}</span> {gpu.name}
        </span>
        <span className={`il-gpubar__free il-gpubar__free--${tone} il-mono`}>
          {mbToGB(gpu.vramFreeMB)} GB free
        </span>
      </div>

      <div className="il-gpubar__track" role="img" aria-label={`${gpu.name} VRAM allocation`}>
        <div className="il-gpubar__committed" style={{ width: `${Math.min(100, committedFrac * 100)}%` }}>
          {segments.map((seg, i) => (
            <div
              key={seg.model.filename + i}
              className={`il-gpubar__segment${seg.model.gpus.length > 1 ? " il-gpubar__segment--fused" : ""}${
                seg.isPreview ? " il-gpubar__segment--preview" : ""
              }`}
              style={{
                width: `${seg.shareOfCommitted * 100}%`,
                background: modelColor(seg.colorIndex),
              }}
              title={`${seg.model.filename} · ${mbToGB(gpu.vramCommittedMB * seg.shareOfCommitted)} GB on this GPU${
                seg.model.gpus.length > 1 ? " · fused across GPUs " + seg.model.gpus.join(" + ") : ""
              }${seg.isPreview ? " · not loaded yet — preview" : ""}`}
            />
          ))}
        </div>
      </div>

      <div className="il-gpubar__meta il-meta">
        {mbToGB(gpu.vramCommittedMB)} / {mbToGB(gpu.vramTotalMB)} GB committed
      </div>
    </div>
  );
}
