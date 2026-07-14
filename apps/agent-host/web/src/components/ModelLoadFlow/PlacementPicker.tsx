import type { GpuBudget } from "@interloom/protocol";
import { FitBadge } from "./ContextSizePicker.js";
import type { LoadPlacement } from "./useGuardedModelLoad.js";

export type PlacementChoice =
  | { kind: "auto" }
  | { kind: "explicit"; gpuIndex: number }
  | { kind: "fused" };

export function placementChoiceToBody(
  choice: PlacementChoice,
  gpus: GpuBudget[],
): LoadPlacement | undefined {
  if (choice.kind === "auto") return undefined;
  if (choice.kind === "explicit") return { gpus: [choice.gpuIndex] };
  const allIndices = gpus.map((g) => g.index);
  return { gpus: allIndices, tensorSplit: allIndices.map(() => 1 / allIndices.length) };
}

/**
 * Client-side fit estimate for an explicit/fused placement choice. The
 * daemon doesn't take a placement param on `context-options`, so this
 * combines allocation math (free VRAM per GPU) with the model's on-disk size
 * as a weights proxy plus the selected context's KV bytes — the same two
 * data sources CONTRACTS §6 names for the planner's "live fit preview".
 * Always labelled "estimated" since the daemon's own enforcement at POST
 * /load time is the real source of truth (409s are still handled).
 */
export function estimatePlacementFit(
  choice: PlacementChoice,
  gpus: GpuBudget[],
  requiredMB: number,
): "fast" | "spill" | "no" {
  const indices =
    choice.kind === "explicit" ? [choice.gpuIndex] : choice.kind === "fused" ? gpus.map((g) => g.index) : [];
  if (indices.length === 0) return "fast"; // auto — daemon enforces, no client guess needed
  const freeMB = indices.reduce((sum, i) => sum + (gpus.find((g) => g.index === i)?.vramFreeMB ?? 0), 0);
  const totalMB = indices.reduce((sum, i) => sum + (gpus.find((g) => g.index === i)?.vramTotalMB ?? 0), 0);
  if (requiredMB <= freeMB) return "fast";
  if (requiredMB <= totalMB * 1.6) return "spill";
  return "no";
}

export function PlacementPicker({
  gpus,
  choice,
  onChange,
  requiredMB,
}: {
  gpus: GpuBudget[];
  choice: PlacementChoice;
  onChange: (choice: PlacementChoice) => void;
  /** Estimated VRAM footprint (weights + KV) for the selected context, in MB. */
  requiredMB: number;
}) {
  if (gpus.length <= 1) return null;

  return (
    <div className="il-placement-picker" role="radiogroup" aria-label="GPU placement">
      <button
        type="button"
        role="radio"
        aria-checked={choice.kind === "auto"}
        className={`il-placement-picker__row${choice.kind === "auto" ? " il-placement-picker__row--sel" : ""}`}
        onClick={() => onChange({ kind: "auto" })}
      >
        <span className="il-placement-picker__label">Auto — best fit</span>
        <span className="il-meta">daemon picks the single best-fit GPU</span>
      </button>
      {gpus.map((g) => {
        const sel = choice.kind === "explicit" && choice.gpuIndex === g.index;
        const fit = estimatePlacementFit({ kind: "explicit", gpuIndex: g.index }, gpus, requiredMB);
        return (
          <button
            key={g.index}
            type="button"
            role="radio"
            aria-checked={sel}
            className={`il-placement-picker__row${sel ? " il-placement-picker__row--sel" : ""}`}
            onClick={() => onChange({ kind: "explicit", gpuIndex: g.index })}
          >
            <span className="il-placement-picker__label">
              GPU {g.index} — {g.name}
            </span>
            <span className="il-placement-picker__fit">
              <span className="il-meta">estimated</span>
              <FitBadge fit={fit} />
            </span>
          </button>
        );
      })}
      <button
        type="button"
        role="radio"
        aria-checked={choice.kind === "fused"}
        className={`il-placement-picker__row${choice.kind === "fused" ? " il-placement-picker__row--sel" : ""}`}
        onClick={() => onChange({ kind: "fused" })}
      >
        <span className="il-placement-picker__label">
          ⛓ Span all {gpus.length} GPUs (fused)
        </span>
        <span className="il-placement-picker__fit">
          <span className="il-meta">estimated</span>
          <FitBadge fit={estimatePlacementFit({ kind: "fused" }, gpus, requiredMB)} />
        </span>
      </button>
    </div>
  );
}
