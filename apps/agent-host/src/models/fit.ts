import os from "os";
import type { GpuInfo } from "@interloom/protocol";

export function computeAvailableVramMB(
  gpus: GpuInfo[],
  unifiedMemoryMB?: number,
): number {
  const discreteGpus = gpus.filter((g) => g.kind === "cuda");
  if (discreteGpus.length > 0) {
    return Math.max(...discreteGpus.map((g) => g.vramMB));
  }
  if (unifiedMemoryMB !== undefined) {
    return unifiedMemoryMB;
  }
  return 8192;
}

// ---------------------------------------------------------------------------
// Context-options computation (CONTRACTS §6)
// ---------------------------------------------------------------------------

export interface FitTierInput {
  fileSizeBytes: number;
  gpus: GpuInfo[];
  unifiedMemoryMB?: number;
  layers: number;
  kvHeads: number;
  headDim: number;
  ctx: number;
}

/**
 * Compute KV-cache bytes for a given context length.
 * Formula: 2 × layers × kv_heads × head_dim × 2 bytes × ctx
 */
export function kvBytes(layers: number, kvHeads: number, headDim: number, ctx: number): number {
  return 2 * layers * kvHeads * headDim * 2 * ctx;
}

/**
 * Classify a context size into a fit tier against the host hardware.
 *
 * fast  — model weights + KV ≤ free VRAM
 * spill — model weights + KV ≤ VRAM + 50% system RAM
 * no    — too large to load
 *
 * Unified memory (arm64, no discrete GPU): the "VRAM" is treated as system
 * RAM as well, so free VRAM equals unifiedMemoryMB and spill bound adds
 * 50% of that same pool — both come from the same physical memory.
 */
export function fitTier(input: FitTierInput): "fast" | "spill" | "no" {
  const {
    fileSizeBytes,
    gpus,
    unifiedMemoryMB,
    layers,
    kvHeads,
    headDim,
    ctx,
  } = input;

  const OVERHEAD_BYTES = 1.5 * 1024 * 1024 * 1024; // 1.5 GB runtime overhead
  const kv = kvBytes(layers, kvHeads, headDim, ctx);
  const total = fileSizeBytes + kv + OVERHEAD_BYTES;

  const arch = os.arch();
  const isUnified = arch === "arm64" && !gpus.some((g) => g.kind === "cuda");

  let freeVramBytes: number;
  let spillBoundBytes: number;

  if (isUnified && unifiedMemoryMB !== undefined) {
    freeVramBytes = unifiedMemoryMB * 1024 * 1024;
    // On unified memory, "system RAM" is the same pool — spill adds 50% of it
    spillBoundBytes = freeVramBytes + 0.5 * freeVramBytes;
  } else {
    const discreteGpus = gpus.filter((g) => g.kind === "cuda");
    const vramMB =
      discreteGpus.length > 0
        ? Math.max(...discreteGpus.map((g) => g.vramMB))
        : 0;
    freeVramBytes = vramMB * 1024 * 1024;
    const totalRamBytes = os.totalmem();
    spillBoundBytes = freeVramBytes + 0.5 * totalRamBytes;
  }

  if (total <= freeVramBytes) return "fast";
  if (total <= spillBoundBytes) return "spill";
  return "no";
}
