import fs from "fs";
import os from "os";
import type { GpuInfo, GpuBudget } from "@interloom/protocol";
import { parseGgufMeta } from "./gguf.js";

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

// ---------------------------------------------------------------------------
// Per-GPU committed-VRAM accounting (CONTRACTS §6 `POST /api/models/load`,
// `GET /api/models/allocation`) — multiple loaded instances can share a host,
// each pinned to its own GPU(s), and the load endpoint must enforce fit
// against the REMAINING budget on those GPUs, not "is there any GPU at all
// with enough total VRAM" (that's what `fitTier`/`computeAvailableVramMB`
// above answer, for the single-model context-options / curated-fit surfaces).
// ---------------------------------------------------------------------------

const RUNTIME_OVERHEAD_FRACTION = 0.15;

/** Enough to compute one loaded/candidate instance's VRAM footprint. */
export interface InstanceFootprint {
  modelPath: string;
  mmprojPath?: string | null;
  ctx: number;
  gpus: number[];
  tensorSplit?: number[];
}

function safeFileSizeBytes(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

/**
 * Total VRAM footprint of one instance: weights (+ mmproj) + KV cache + ~15%
 * runtime overhead. Uses the GGUF header when parseable; falls back to the
 * same size-based KV heuristic as the context-options endpoint when it isn't
 * (unparseable header, missing file, etc. — never throws).
 */
export function computeInstanceFootprintBytes(inst: InstanceFootprint): number {
  const weightsBytes =
    safeFileSizeBytes(inst.modelPath) + (inst.mmprojPath ? safeFileSizeBytes(inst.mmprojPath) : 0);
  const meta = parseGgufMeta(inst.modelPath);
  let kv: number;
  if (meta) {
    kv = kvBytes(meta.blockCount, meta.kvHeads, meta.headDim, inst.ctx);
  } else {
    const fileSizeGB = weightsBytes / (1024 * 1024 * 1024);
    kv = fileSizeGB * 12_000 * inst.ctx;
  }
  return (weightsBytes + kv) * (1 + RUNTIME_OVERHEAD_FRACTION);
}

/**
 * Split an instance's total footprint across the GPU(s) it's pinned to. A
 * single-GPU instance charges its full footprint to that GPU; a fused span
 * (tensor-split across multiple GPUs) divides by the split ratios (even
 * split when `tensorSplit` is absent or mismatched in length).
 */
export function distributeFootprintAcrossGpus(
  inst: InstanceFootprint,
  totalBytes: number,
): Map<number, number> {
  const out = new Map<number, number>();
  if (inst.gpus.length === 0) return out;
  if (inst.gpus.length === 1) {
    out.set(inst.gpus[0]!, totalBytes);
    return out;
  }
  const ratios =
    inst.tensorSplit && inst.tensorSplit.length === inst.gpus.length
      ? inst.tensorSplit
      : inst.gpus.map(() => 1);
  const sum = ratios.reduce((a, b) => a + b, 0) || 1;
  inst.gpus.forEach((g, i) => out.set(g, totalBytes * ((ratios[i] ?? 1) / sum)));
  return out;
}

/**
 * Per-GPU committed/free VRAM budget given the currently loaded instances
 * (CONTRACTS §6 `GET /api/models/allocation`). GPUs without a detected
 * `index` fall back to their array position so callers that haven't wired
 * `system.ts`'s index detection yet still get a usable (if less precise) view.
 */
export function computeGpuBudgets(gpus: GpuInfo[], instances: InstanceFootprint[]): GpuBudget[] {
  const committedBytes = new Map<number, number>();
  for (const inst of instances) {
    const total = computeInstanceFootprintBytes(inst);
    const dist = distributeFootprintAcrossGpus(inst, total);
    for (const [idx, bytes] of dist) {
      committedBytes.set(idx, (committedBytes.get(idx) ?? 0) + bytes);
    }
  }

  return gpus
    .filter((g) => g.kind === "cuda")
    .map((g, i) => {
      const idx = g.index ?? i;
      const committedMB = Math.round((committedBytes.get(idx) ?? 0) / (1024 * 1024));
      return {
        index: idx,
        name: g.name,
        vramTotalMB: g.vramMB,
        vramCommittedMB: committedMB,
        vramFreeMB: Math.max(0, g.vramMB - committedMB),
      };
    });
}

export type LoadFitDecision = "fast" | "spill" | "no";

/**
 * Fit decision for a CANDIDATE instance against the REMAINING per-GPU budget
 * (existing loaded instances' committed VRAM subtracted first) — the
 * server-side enforcement behind `POST /api/models/load` (CONTRACTS §6):
 * `no` → 409 `wont_fit`; `spill` (without `confirmSpill`) → 409 `needs_confirm`.
 *
 * On unified memory (arm64, no discrete GPU) or when the candidate has no
 * GPU placement yet, falls back to whole-pool accounting against
 * `unifiedMemoryMB` (mirrors `fitTier`'s unified-memory branch above).
 *
 * `systemRamBytes` is the spill-headroom denominator for the discrete-GPU
 * branch — injectable so callers (and hermetic tests) can pin it; production
 * callers omit it and get `os.totalmem()`. Feed it from `SystemInfo.systemRamMB`
 * when you have a server-truthed figure.
 */
export function fitDecisionForNewInstance(
  candidate: InstanceFootprint,
  gpus: GpuInfo[],
  existingInstances: InstanceFootprint[],
  unifiedMemoryMB?: number,
  systemRamBytes: number = os.totalmem(),
): LoadFitDecision {
  const arch = os.arch();
  const isUnified = arch === "arm64" && !gpus.some((g) => g.kind === "cuda");
  const totalBytes = computeInstanceFootprintBytes(candidate);

  if (isUnified || candidate.gpus.length === 0) {
    const usedByOthers = existingInstances.reduce(
      (sum, i) => sum + computeInstanceFootprintBytes(i),
      0,
    );
    const poolBytes = (unifiedMemoryMB ?? 8192) * 1024 * 1024;
    const freeBytes = Math.max(0, poolBytes - usedByOthers);
    if (totalBytes <= freeBytes) return "fast";
    const spillBound = freeBytes + 0.5 * poolBytes;
    if (totalBytes <= spillBound) return "spill";
    return "no";
  }

  const budgets = computeGpuBudgets(gpus, existingInstances);
  const dist = distributeFootprintAcrossGpus(candidate, totalBytes);
  const totalRamBytes = systemRamBytes;
  let fits = true;
  let spillOk = true;
  for (const [idx, bytes] of dist) {
    const budget = budgets.find((b) => b.index === idx);
    const freeBytes = (budget?.vramFreeMB ?? 0) * 1024 * 1024;
    if (bytes > freeBytes) fits = false;
    const spillBoundBytes = freeBytes + 0.5 * totalRamBytes;
    if (bytes > spillBoundBytes) spillOk = false;
  }
  if (fits) return "fast";
  if (spillOk) return "spill";
  return "no";
}

/**
 * Best-fit single-GPU placement for a candidate when the caller omits
 * `placement` (CONTRACTS §6: "Placement omitted → daemon picks the best-fit
 * single GPU"). Picks the GPU with the most free VRAM (after existing
 * instances' commitments) that the candidate actually fits on (`fast`);
 * falls back to the GPU with the most free VRAM at all (so a `spill`/`no`
 * verdict still has a placement to report back to the caller).
 */
export function pickBestFitGpu(
  candidateFootprintBytes: number,
  gpus: GpuInfo[],
  existingInstances: InstanceFootprint[],
): number | null {
  const budgets = computeGpuBudgets(gpus, existingInstances);
  if (budgets.length === 0) return null;
  const fastCandidates = budgets.filter((b) => b.vramFreeMB * 1024 * 1024 >= candidateFootprintBytes);
  const pool = fastCandidates.length > 0 ? fastCandidates : budgets;
  return pool.reduce((best, b) => (b.vramFreeMB > best.vramFreeMB ? b : best)).index;
}
