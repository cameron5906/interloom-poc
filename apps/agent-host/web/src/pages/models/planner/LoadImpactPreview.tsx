import { useMemo } from "react";
import type { GpuBudget, LoadedModel, LocalModel } from "@interloom/protocol";
import { mbToGB } from "../../../lib/format.js";
import type { PlacementChoice } from "../../../components/ModelLoadFlow/PlacementPicker.js";
import { GpuBudgetBar } from "./GpuBudgetBar.js";
import type { GpuBarSegment } from "./GpuBudgetBar.js";
import { segmentsForGpu } from "./segments.js";

interface AffectedGpuState {
  gpu: GpuBudget;
  before: GpuBudget;
  beforeSegments: GpuBarSegment[];
  after: GpuBudget;
  afterSegments: GpuBarSegment[];
  addedMB: number;
}

/**
 * Best-fit single-GPU pick mirroring the daemon's `pickBestFitGpu` (CONTRACTS
 * §6 "placement omitted → daemon picks the best-fit single GPU"): the GPU
 * with the most free VRAM that the candidate actually fits on, falling back
 * to the GPU with the most free VRAM at all. Client-side estimate only — the
 * daemon's own decision at load time is authoritative.
 */
function pickPreviewGpu(gpus: GpuBudget[], requiredMB: number): number | null {
  if (gpus.length === 0) return null;
  const fitting = gpus.filter((g) => g.vramFreeMB >= requiredMB);
  const pool = fitting.length > 0 ? fitting : gpus;
  return pool.reduce((best, g) => (g.vramFreeMB > best.vramFreeMB ? g : best)).index;
}

/** Distribute the candidate's estimated VRAM footprint across the GPU(s) the
 * current placement choice would use — mirrors `placementChoiceToBody`'s even
 * tensor-split for "fused". */
function distributeRequiredMB(
  placement: PlacementChoice,
  gpus: GpuBudget[],
  requiredMB: number,
): Map<number, number> {
  const out = new Map<number, number>();
  if (placement.kind === "explicit") {
    out.set(placement.gpuIndex, requiredMB);
    return out;
  }
  if (placement.kind === "fused") {
    const n = gpus.length || 1;
    for (const g of gpus) out.set(g.index, requiredMB / n);
    return out;
  }
  const idx = pickPreviewGpu(gpus, requiredMB);
  if (idx !== null) out.set(idx, requiredMB);
  return out;
}

/**
 * Rescale the "before" segments into the grown committed bar and append a
 * preview segment for the candidate model. Existing segments already sum to
 * 1 of the OLD committed MB; scaling each by oldCommitted/newCommitted and
 * giving the new segment addedMB/newCommitted keeps the sum at 1.
 */
function afterStateForGpu(
  gpu: GpuBudget,
  beforeSegments: GpuBarSegment[],
  addedMB: number,
  previewModel: LocalModel,
  previewColorIndex: number,
): { gpu: GpuBudget; segments: GpuBarSegment[] } {
  if (addedMB <= 0) return { gpu, segments: beforeSegments };
  const oldCommitted = gpu.vramCommittedMB;
  const newCommitted = oldCommitted + addedMB;
  const rescaled = beforeSegments.map((seg) => ({
    ...seg,
    shareOfCommitted: newCommitted > 0 ? (seg.shareOfCommitted * oldCommitted) / newCommitted : 0,
  }));
  const previewSegment: GpuBarSegment = {
    model: {
      path: previewModel.path,
      filename: previewModel.filename,
      ctx: 0,
      port: 0,
      gpus: [gpu.index],
      fit: "fast",
      health: "loading",
    } as LoadedModel,
    colorIndex: previewColorIndex,
    shareOfCommitted: newCommitted > 0 ? addedMB / newCommitted : 0,
    isPreview: true,
  };
  return {
    gpu: {
      ...gpu,
      vramCommittedMB: newCommitted,
      vramFreeMB: Math.max(0, gpu.vramTotalMB - newCommitted),
    },
    segments: [...rescaled, previewSegment],
  };
}

/**
 * Before → after preview of the GPU allocator state for the model + context
 * currently selected in the load wizard. Reuses the same `GpuBudgetBar` the
 * main planner view renders so the preview reads as "the allocator, but
 * showing what happens next" rather than a bespoke chart. `requiredMB` is the
 * daemon's own weights + KV-cache estimate for the selected context
 * (CONTRACTS §6 context-sizing) — this component only visualizes it, never
 * re-derives it.
 */
export function LoadImpactPreview({
  gpus,
  loaded,
  model,
  requiredMB,
  placement,
  exact,
}: {
  gpus: GpuBudget[];
  loaded: LoadedModel[];
  model: LocalModel;
  requiredMB: number;
  placement: PlacementChoice;
  exact: boolean;
}) {
  const affected = useMemo<AffectedGpuState[]>(() => {
    const distribution = distributeRequiredMB(placement, gpus, requiredMB);
    const previewColorIndex = loaded.length;
    const rows: AffectedGpuState[] = [];
    for (const gpu of [...gpus].sort((a, b) => a.index - b.index)) {
      const addedMB = distribution.get(gpu.index) ?? 0;
      if (addedMB <= 0) continue;
      const beforeSegments = segmentsForGpu(gpu.index, loaded);
      const { gpu: afterGpu, segments: afterSegments } = afterStateForGpu(
        gpu,
        beforeSegments,
        addedMB,
        model,
        previewColorIndex,
      );
      rows.push({
        gpu,
        before: gpu,
        beforeSegments,
        after: afterGpu,
        afterSegments,
        addedMB,
      });
    }
    return rows;
  }, [gpus, loaded, model, requiredMB, placement]);

  if (gpus.length === 0) {
    return (
      <div className="il-load-preview">
        <div className="il-load-preview__head">
          <span className="il-field__label">Resource impact</span>
          {!exact ? <span className="il-meta">estimated</span> : null}
        </div>
        <p className="il-meta">
          ≈ {mbToGB(requiredMB)} GB total footprint — no discrete GPU detected on this host.
        </p>
      </div>
    );
  }

  if (affected.length === 0) return null;

  return (
    <div className="il-load-preview">
      <div className="il-load-preview__head">
        <span className="il-field__label">Resource impact</span>
        {!exact ? <span className="il-meta">estimated</span> : null}
      </div>
      <div className="il-load-preview__gpus">
        {affected.map((row) => (
          <div className="il-load-preview__gpu" key={row.gpu.index}>
            <div className="il-load-preview__gpu-name il-mono">
              GPU {row.gpu.index} · {row.gpu.name}
            </div>
            <div className="il-load-preview__state">
              <span className="il-load-preview__state-tag">now</span>
              <GpuBudgetBar gpu={row.before} segments={row.beforeSegments} />
            </div>
            <div className="il-load-preview__divider" aria-hidden>
              ↓ after loading {model.filename}
            </div>
            <div className="il-load-preview__state">
              <span className="il-load-preview__state-tag il-load-preview__state-tag--after">after</span>
              <GpuBudgetBar gpu={row.after} segments={row.afterSegments} />
            </div>
            <div className="il-load-preview__delta il-meta">
              +{mbToGB(row.addedMB)} GB for {model.filename}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
