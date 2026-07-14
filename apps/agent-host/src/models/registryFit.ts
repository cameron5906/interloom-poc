import os from "os";
import type { GpuInfo, CatalogModel } from "@interloom/protocol";

/**
 * Registry fit verdicts (CONTRACTS §6 Models, spec `RegistryFit`).
 *
 * Classifies each curated catalog model against the detected hardware from the
 * catalog `hardware` block (hi-end Q4 weight size, RAM/VRAM recommendations,
 * cpu viability) and `architecture` (total/active parameters for MoE). The
 * verdict + a short honest note render verbatim in the portal marketplace.
 *
 * Memory model (GB throughout):
 *   fast  — weightsHi + OVERHEAD + KV8K ≤ usable GPU/unified memory
 *   spill — dense: weightsHi + OVERHEAD + KV8K ≤ GPU + 50% system RAM
 *           MoE:   experts-on-CPU shape fits — GPU holds active weights
 *                  (weightsHi × max(active/total, 0.15) + OVERHEAD + KV8K) and
 *                  system RAM holds the rest (labelled an estimate)
 *   cpu   — no GPU path fits but cpu_viability is favorable and
 *           weightsHi + 2GB ≤ system RAM
 *   no    — otherwise
 */

const OVERHEAD_GB = 1.5; // runtime overhead — same 1.5 GB constant fit.ts uses
const KV8K_GB = 1.0; // modest KV headroom for a ~8k context window
const CPU_RAM_HEADROOM_GB = 2; // weightsHi + 2 GB ≤ RAM to call it cpu-friendly
const MOE_MIN_GPU_RATIO = 0.15; // floor for the active/total shrink on GPU

const FAVORABLE_CPU_VIABILITY = new Set([
  "excellent",
  "good",
  "good_with_fast_ram",
  "usable",
]);

export type FitVerdict = "fast" | "spill" | "cpu" | "no";

export interface RegistryFit {
  verdict: FitVerdict;
  note: string;
}

export interface FitHardware {
  gpus: GpuInfo[];
  unifiedMemoryMB?: number;
  /** Total system RAM in MB (from `GET /api/system`); falls back to os.totalmem. */
  systemRamMB?: number;
}

interface Memory {
  /** Usable GPU (or unified) memory in GB; 0 when there is no usable GPU. */
  gpuGB: number;
  /** System RAM in GB (== gpuGB on unified-memory rigs — one physical pool). */
  ramGB: number;
  isUnified: boolean;
}

function resolveMemory(hw: FitHardware): Memory {
  const cuda = hw.gpus.filter((g) => g.kind === "cuda");
  const arch = os.arch();
  const isUnified = arch === "arm64" && cuda.length === 0 && hw.unifiedMemoryMB !== undefined;

  if (isUnified) {
    const gb = (hw.unifiedMemoryMB as number) / 1024;
    return { gpuGB: gb, ramGB: gb, isUnified: true };
  }
  const gpuGB = cuda.length > 0 ? Math.max(...cuda.map((g) => g.vramMB)) / 1024 : 0;
  const ramGB =
    hw.systemRamMB !== undefined ? hw.systemRamMB / 1024 : os.totalmem() / (1024 * 1024 * 1024);
  return { gpuGB, ramGB, isUnified: false };
}

/** Hi-end Q4 weight size in GB from the catalog `estimated_q4_weight_size_gb` range. */
function weightsHiGB(model: CatalogModel): number {
  const range = model.hardware.estimated_q4_weight_size_gb;
  if (!Array.isArray(range) || range.length === 0) {
    return model.hardware.recommended_vram_gb_full_offload;
  }
  return Math.max(...range);
}

function memoryLabel(mem: Memory): string {
  return mem.isUnified
    ? `${Math.round(mem.gpuGB)}GB unified memory`
    : `${Math.round(mem.gpuGB)}GB GPU`;
}

export function computeRegistryFit(model: CatalogModel, hw: FitHardware): RegistryFit {
  const mem = resolveMemory(hw);
  const weightsHi = weightsHiGB(model);
  const totalB = model.architecture.parameters_total_b;
  const activeB = model.architecture.parameters_active_b;
  const isMoe = totalB !== null && totalB > 0 && activeB > 0 && activeB < totalB;

  // fast — hi-end Q4 weights + overhead + a modest KV allowance fit the GPU.
  if (mem.gpuGB > 0 && weightsHi + OVERHEAD_GB + KV8K_GB <= mem.gpuGB) {
    return {
      verdict: "fast",
      note: mem.isUnified
        ? `Fits fully in your ${Math.round(mem.gpuGB)}GB unified memory`
        : `Fits fully on your ${Math.round(mem.gpuGB)}GB GPU`,
    };
  }

  // spill (MoE) — experts on CPU: GPU holds the active slice, RAM holds the rest.
  if (isMoe && mem.gpuGB > 0) {
    const ratio = Math.max(activeB / (totalB as number), MOE_MIN_GPU_RATIO);
    const gpuNeed = weightsHi * ratio + OVERHEAD_GB + KV8K_GB;
    const ramNeed = weightsHi * (1 - ratio) + OVERHEAD_GB;
    const ramFits = mem.isUnified
      ? gpuNeed + ramNeed <= mem.gpuGB
      : gpuNeed <= mem.gpuGB && ramNeed <= mem.ramGB;
    if (ramFits) {
      return {
        verdict: "spill",
        note: `Runs with experts in system RAM — decode stays quick, needs ~${Math.round(
          ramNeed,
        )}GB RAM (estimate)`,
      };
    }
  }

  // spill (dense or MoE that didn't take the experts path) — VRAM + 50% RAM.
  if (mem.gpuGB > 0 && weightsHi + OVERHEAD_GB + KV8K_GB <= mem.gpuGB + 0.5 * mem.ramGB) {
    return {
      verdict: "spill",
      note: `Partly offloads to system RAM from your ${memoryLabel(mem)} — expect slower generation`,
    };
  }

  // cpu — no GPU path fits, but the model is CPU-friendly and RAM holds it.
  if (
    FAVORABLE_CPU_VIABILITY.has(model.hardware.cpu_viability) &&
    weightsHi + CPU_RAM_HEADROOM_GB <= mem.ramGB
  ) {
    return {
      verdict: "cpu",
      note: `CPU-friendly on your ${Math.round(mem.ramGB)}GB RAM`,
    };
  }

  // no — beyond this rig.
  return {
    verdict: "no",
    note: `Needs ~${Math.round(
      model.hardware.recommended_vram_gb_full_offload,
    )}GB of GPU or unified memory — beyond this rig`,
  };
}

/** Fit map keyed by catalog model id (CONTRACTS §6 registry endpoint `fit`). */
export function computeRegistryFits(
  models: CatalogModel[],
  hw: FitHardware,
): Record<string, RegistryFit> {
  const out: Record<string, RegistryFit> = {};
  for (const model of models) {
    out[model.id] = computeRegistryFit(model, hw);
  }
  return out;
}
