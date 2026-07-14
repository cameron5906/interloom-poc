/**
 * Fit-verdict fixtures (CONTRACTS §6 Models). System RAM is supplied via
 * `systemRamMB` (the same value the rig strip shows) so the math is deterministic
 * across runners; the verdict logic is otherwise pure.
 *
 * Formulas under test (GB):
 *   fast  — weightsHi + 1.5 (overhead) + 1.0 (KV8K) ≤ usable GPU
 *   spill (MoE) — weightsHi × max(active/total, 0.15) + 2.5 ≤ GPU
 *                 AND weightsHi × (1 − ratio) + 1.5 ≤ RAM
 *   spill (dense) — weightsHi + 2.5 ≤ GPU + 0.5 × RAM
 *   cpu   — cpu_viability favorable AND weightsHi + 2 ≤ RAM (no GPU path fit)
 *   no    — otherwise
 */

import { describe, it, expect } from "vitest";
import { computeRegistryFit } from "../models/registryFit.js";
import type { CatalogModel, GpuInfo } from "@interloom/protocol";

const RAM_32 = 32 * 1024; // MB
const RAM_64 = 64 * 1024; // MB

function makeModel(opts: {
  totalB: number | null;
  activeB: number;
  weightsRange: number[];
  vramFull: number;
  cpuViability?: string;
}): CatalogModel {
  return {
    id: "fixture",
    architecture: {
      parameters_total_b: opts.totalB,
      parameters_active_b: opts.activeB,
    },
    hardware: {
      estimated_q4_weight_size_gb: opts.weightsRange,
      recommended_vram_gb_full_offload: opts.vramFull,
      cpu_viability: opts.cpuViability ?? "good",
    },
  } as unknown as CatalogModel;
}

const GPU_24: GpuInfo[] = [{ name: "RTX 4090", vramMB: 24576, kind: "cuda" }];
const NO_GPU: GpuInfo[] = [];

describe("computeRegistryFit", () => {
  it("dense model that fits fully on the GPU → fast", () => {
    const m = makeModel({ totalB: 4, activeB: 4, weightsRange: [2.5, 3.2], vramFull: 6 });
    const fit = computeRegistryFit(m, { gpus: GPU_24, systemRamMB: RAM_32 });
    expect(fit.verdict).toBe("fast");
    expect(fit.note).toContain("24GB GPU");
  });

  it("dense model too big for GPU and spill → no", () => {
    const m = makeModel({ totalB: 70, activeB: 70, weightsRange: [42, 45], vramFull: 48, cpuViability: "poor" });
    const fit = computeRegistryFit(m, { gpus: GPU_24, systemRamMB: RAM_32 });
    expect(fit.verdict).toBe("no");
    expect(fit.note).toContain("beyond this rig");
  });

  it("MoE model earns spill via experts-on-CPU with an experts-in-RAM note", () => {
    // total 35B / active 3B, weightsHi 24GB. GPU need ≈ 24×0.15+2.5 = 6.1 ≤ 24;
    // RAM need ≈ 24×0.85+1.5 = 21.9 ≤ 32.
    const m = makeModel({ totalB: 35, activeB: 3, weightsRange: [20, 24], vramFull: 24, cpuViability: "good_with_fast_ram" });
    const fit = computeRegistryFit(m, { gpus: GPU_24, systemRamMB: RAM_32 });
    expect(fit.verdict).toBe("spill");
    expect(fit.note).toMatch(/experts in system RAM/i);
    expect(fit.note).toMatch(/estimate/i);
  });

  it("dense mid-size model spills into system RAM → spill", () => {
    // weightsHi 30 > 24 GPU, but 30+2.5 = 32.5 ≤ 24 + 0.5×32 = 40.
    const m = makeModel({ totalB: 32, activeB: 32, weightsRange: [28, 30], vramFull: 32 });
    const fit = computeRegistryFit(m, { gpus: GPU_24, systemRamMB: RAM_32 });
    expect(fit.verdict).toBe("spill");
  });

  it("CPU-only rig with a small, CPU-friendly model → cpu", () => {
    const m = makeModel({ totalB: 4, activeB: 4, weightsRange: [2.5, 3.2], vramFull: 6, cpuViability: "excellent" });
    const fit = computeRegistryFit(m, { gpus: NO_GPU, systemRamMB: RAM_32 });
    expect(fit.verdict).toBe("cpu");
    expect(fit.note).toContain("32GB RAM");
  });

  it("no GPU and a model too big for RAM → no", () => {
    const m = makeModel({ totalB: 70, activeB: 70, weightsRange: [42, 45], vramFull: 48, cpuViability: "usable" });
    const fit = computeRegistryFit(m, { gpus: NO_GPU, systemRamMB: RAM_32 });
    expect(fit.verdict).toBe("no");
  });

  it("uses the supplied systemRamMB (the rig-strip figure) as the RAM denominator", () => {
    // Same MoE model earns experts-spill at 64 GB RAM but nothing fits at 4 GB.
    const m = makeModel({ totalB: 35, activeB: 3, weightsRange: [20, 24], vramFull: 24, cpuViability: "poor" });
    const fit = computeRegistryFit(m, { gpus: GPU_24, systemRamMB: RAM_64 });
    expect(fit.verdict).toBe("spill");
    const tight = computeRegistryFit(m, { gpus: GPU_24, systemRamMB: 4 * 1024 });
    expect(tight.verdict).toBe("no");
  });
});
