import os from "os";
import type { GpuInfo, ContextPlan } from "@interloom/protocol";
import { kvBytes } from "./fit.js";
import type { GgufMeta } from "./gguf.js";

/**
 * Context plans (CONTRACTS §6 "Context plans"). Per ctx rung the daemon emits
 * the best-fitting plan plus the next honest fallback that unlocks the rung
 * when the best is not `fast`. Preference at equal ctx:
 *   f16+full_gpu > q8_0+full_gpu > f16+experts_cpu > q8_0+experts_cpu > spill
 * `experts_cpu` plans are offered only for MoE GGUFs (expert_count in header);
 * `q8_0` halves the KV cache; `nCpuMoe` (block_count) rides `experts_cpu` plans.
 * Rigs with no usable GPU capacity (no CUDA, no unified memory) get a
 * different ladder entirely: `offload: "cpu"` plans sized against RAM only,
 * since system RAM is the native run mode there, not a VRAM shortfall.
 */

const OVERHEAD_BYTES = 1.5 * 1024 * 1024 * 1024; // 1.5 GB runtime overhead
const MB = 1024 * 1024;
/** Conservative active/total ratio when the header lacks expert_used_count. */
const DEFAULT_MOE_ACTIVE_RATIO = 0.25;

type KvCache = "f16" | "q8_0";
type Offload = "full_gpu" | "experts_cpu" | "cpu";

interface Memory {
  vramBytes: number;
  ramBytes: number;
  spillCapBytes: number;
  isUnified: boolean;
}

function resolveMemory(gpus: GpuInfo[], unifiedMemoryMB?: number, systemRamMB?: number): Memory {
  const cuda = gpus.filter((g) => g.kind === "cuda");
  const arch = os.arch();
  const isUnified = arch === "arm64" && cuda.length === 0 && unifiedMemoryMB !== undefined;

  if (isUnified) {
    const pool = (unifiedMemoryMB as number) * MB;
    return { vramBytes: pool, ramBytes: pool, spillCapBytes: pool + 0.5 * pool, isUnified: true };
  }
  const vramMB = cuda.length > 0 ? Math.max(...cuda.map((g) => g.vramMB)) : 0;
  const vramBytes = vramMB * MB;
  const ramBytes = systemRamMB !== undefined ? systemRamMB * MB : os.totalmem();
  return { vramBytes, ramBytes, spillCapBytes: vramBytes + 0.5 * ramBytes, isUnified: false };
}

function ctxLabel(ctx: number): string {
  const k = ctx / 1024;
  return Number.isInteger(k) ? `${k}K` : `${Math.round(k)}K`;
}

function planLabel(ctx: number, kvCache: KvCache, offload: Offload): string {
  if (offload === "cpu") {
    return kvCache === "q8_0" ? `${ctxLabel(ctx)} · CPU · compressed KV` : `${ctxLabel(ctx)} · CPU`;
  }
  if (offload === "experts_cpu") {
    return kvCache === "q8_0"
      ? `${ctxLabel(ctx)} · experts + compressed KV`
      : `${ctxLabel(ctx)} · experts in system RAM`;
  }
  return kvCache === "q8_0" ? `${ctxLabel(ctx)} · compressed KV` : `${ctxLabel(ctx)} · full GPU`;
}

/** Active/total parameter ratio for the experts-on-CPU GPU estimate. */
function moeActiveRatio(meta: GgufMeta): number {
  if (
    meta.expertUsedCount !== undefined &&
    meta.expertCount !== undefined &&
    meta.expertCount > 0
  ) {
    return meta.expertUsedCount / meta.expertCount;
  }
  return DEFAULT_MOE_ACTIVE_RATIO;
}

function buildPlan(
  ctx: number,
  kvCache: KvCache,
  offload: Offload,
  weightsBytes: number,
  meta: GgufMeta,
  mem: Memory,
): ContextPlan {
  const kv = kvBytes(meta.blockCount, meta.kvHeads, meta.headDim, ctx) / (kvCache === "q8_0" ? 2 : 1);
  const kvRounded = Math.round(kv);

  if (offload === "cpu") {
    const ramNeed = weightsBytes + kv + OVERHEAD_BYTES;
    return {
      ctx,
      kvCache,
      offload,
      kvBytes: kvRounded,
      vramNeedMB: 0,
      ramNeedMB: Math.round(ramNeed / MB),
      fit: ramNeed <= mem.ramBytes ? "spill" : "no",
      label: planLabel(ctx, kvCache, offload),
    };
  }

  if (offload === "experts_cpu") {
    const ratio = moeActiveRatio(meta);
    const vramNeed = weightsBytes * ratio + kv + OVERHEAD_BYTES;
    const ramNeed = weightsBytes * (1 - ratio) + OVERHEAD_BYTES;
    const fits = mem.isUnified
      ? vramNeed + ramNeed <= mem.vramBytes
      : vramNeed <= mem.vramBytes && ramNeed <= mem.ramBytes;
    return {
      ctx,
      kvCache,
      offload,
      kvBytes: kvRounded,
      vramNeedMB: Math.round(vramNeed / MB),
      ramNeedMB: Math.round(ramNeed / MB),
      fit: fits ? "spill" : "no",
      label: planLabel(ctx, kvCache, offload),
      nCpuMoe: meta.blockCount,
    };
  }

  // full_gpu
  const total = weightsBytes + kv + OVERHEAD_BYTES;
  let fit: "fast" | "spill" | "no";
  if (total <= mem.vramBytes) fit = "fast";
  else if (total <= mem.spillCapBytes) fit = "spill";
  else fit = "no";
  return {
    ctx,
    kvCache,
    offload,
    kvBytes: kvRounded,
    vramNeedMB: Math.round(total / MB),
    ramNeedMB: Math.round(Math.max(0, total - mem.vramBytes) / MB),
    fit,
    label: planLabel(ctx, kvCache, offload),
  };
}

/**
 * Preference rank (lower = more preferred), encoding the CONTRACTS §6 ladder:
 *   f16+full_gpu(fast) > q8_0+full_gpu(fast) > f16+experts_cpu > q8_0+experts_cpu > full_gpu spill.
 * A full_gpu plan that only reaches `spill` drops below the experts_cpu plans —
 * experts-on-CPU keeps decode quick where full-GPU spill would be slow.
 */
function prefRank(plan: ContextPlan): number {
  if (plan.offload === "full_gpu") {
    if (plan.fit === "fast") return plan.kvCache === "f16" ? 0 : 1;
    return plan.kvCache === "f16" ? 4 : 5;
  }
  if (plan.offload === "cpu") return plan.kvCache === "f16" ? 6 : 7;
  return plan.kvCache === "f16" ? 2 : 3; // experts_cpu
}

/** Plans for a ctx rung on a rig with no usable GPU capacity: a single CPU
 * plan, falling back to compressed KV only when it unlocks a rung f16 misses. */
function plansForCpuCtx(
  ctx: number,
  weightsBytes: number,
  meta: GgufMeta,
  mem: Memory,
): ContextPlan[] {
  const f16 = buildPlan(ctx, "f16", "cpu", weightsBytes, meta, mem);
  if (f16.fit !== "no") return [f16];
  const q8 = buildPlan(ctx, "q8_0", "cpu", weightsBytes, meta, mem);
  return q8.fit !== "no" ? [q8] : [f16];
}

/** Plans for a single ctx rung: the ideal shape + the honest unlock fallback. */
function plansForCtx(
  ctx: number,
  weightsBytes: number,
  meta: GgufMeta,
  mem: Memory,
  isMoe: boolean,
): ContextPlan[] {
  const ideal = buildPlan(ctx, "f16", "full_gpu", weightsBytes, meta, mem);
  const alternatives: ContextPlan[] = [
    buildPlan(ctx, "q8_0", "full_gpu", weightsBytes, meta, mem),
    ...(isMoe
      ? [
          buildPlan(ctx, "f16", "experts_cpu", weightsBytes, meta, mem),
          buildPlan(ctx, "q8_0", "experts_cpu", weightsBytes, meta, mem),
        ]
      : []),
  ];

  // Ideal fully fits on the GPU — nothing to compromise.
  if (ideal.fit === "fast") return [ideal];

  // Otherwise surface the most-preferred alternative that improves on the ideal:
  // a fast option (compressed KV) or, for MoE, quick experts-in-RAM over slow spill.
  const usableAlts = alternatives
    .filter((p) => p.fit !== "no")
    .sort((a, b) => prefRank(a) - prefRank(b));
  const fallback = usableAlts.find((p) => prefRank(p) < prefRank(ideal));

  if (ideal.fit === "no") return fallback ? [fallback] : usableAlts.length ? [usableAlts[0]!] : [];
  return fallback ? [ideal, fallback] : [ideal];
}

export interface ContextPlanResult {
  plans: ContextPlan[];
  recommendedPlan: ContextPlan | null;
}

/**
 * Build the plan ladder across the candidate ctx rungs. `recommendedPlan` is the
 * highest-ctx `fast` plan, falling back to the highest-ctx `spill` plan.
 */
export function buildContextPlans(
  candidateCtxs: number[],
  weightsBytes: number,
  meta: GgufMeta,
  gpus: GpuInfo[],
  unifiedMemoryMB?: number,
  systemRamMB?: number,
): ContextPlanResult {
  const mem = resolveMemory(gpus, unifiedMemoryMB, systemRamMB);
  const isMoe = meta.expertCount !== undefined && meta.expertCount > 0;
  const hasCuda = gpus.some((g) => g.kind === "cuda");
  const cpuOnly = !hasCuda && unifiedMemoryMB === undefined;

  const plans: ContextPlan[] = [];
  for (const ctx of candidateCtxs) {
    plans.push(
      ...(cpuOnly
        ? plansForCpuCtx(ctx, weightsBytes, meta, mem)
        : plansForCtx(ctx, weightsBytes, meta, mem, isMoe)),
    );
  }

  // Recommend the highest-ctx fast plan; else the highest-ctx spill plan. At an
  // equal ctx, break ties toward the more-preferred (quicker) shape.
  const pick = (list: ContextPlan[]): ContextPlan | null =>
    list.length === 0
      ? null
      : list.reduce((a, b) =>
          b.ctx > a.ctx || (b.ctx === a.ctx && prefRank(b) < prefRank(a)) ? b : a,
        );

  const recommendedPlan =
    pick(plans.filter((p) => p.fit === "fast")) ?? pick(plans.filter((p) => p.fit === "spill"));

  return { plans, recommendedPlan };
}
