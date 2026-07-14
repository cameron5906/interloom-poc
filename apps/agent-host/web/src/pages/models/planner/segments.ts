import type { LoadedModel } from "@interloom/protocol";
import type { GpuBarSegment } from "./GpuBudgetBar.js";

/** Per-GPU segments for every loaded model, split evenly among co-resident
 * models on that GPU (CONTRACTS §6 doesn't expose a finer breakdown). Shared
 * by the planner's live GPU bars and the load wizard's before/after preview
 * so both read the same "current state" the same way. */
export function segmentsForGpu(gpuIndex: number, loaded: LoadedModel[]): GpuBarSegment[] {
  const onThisGpu = loaded.filter((m) => m.gpus.includes(gpuIndex));
  if (onThisGpu.length === 0) return [];
  const share = 1 / onThisGpu.length;
  return onThisGpu.map((model) => ({
    model,
    colorIndex: loaded.indexOf(model),
    shareOfCommitted: share,
  }));
}
