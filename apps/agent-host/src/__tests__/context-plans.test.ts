/**
 * Context-plan ladder math (CONTRACTS §6 "Context plans"). `os` is mocked for a
 * deterministic x64 rig with controllable system RAM; hardware is otherwise
 * driven by the passed gpus array.
 *
 * KV per token for the dense fixture (block 32 / kvHeads 8 / headDim 128):
 *   2 × 32 × 8 × 128 × 2 = 131072 bytes → 8 GiB at ctx 65536 (f16), 4 GiB q8_0.
 */

import { describe, it, expect } from "vitest";
import { buildContextPlans } from "../models/plans.js";
import type { GgufMeta } from "../models/gguf.js";
import type { GpuInfo } from "@interloom/protocol";

const GPU_24: GpuInfo[] = [{ name: "RTX 4090", vramMB: 24576, kind: "cuda" }];
const GB = 1024 ** 3;
const RAM_32 = 32 * 1024; // MB
const RAM_64 = 64 * 1024; // MB

const denseMeta: GgufMeta = {
  architecture: "llama",
  contextLength: 131072,
  blockCount: 32,
  kvHeads: 8,
  headDim: 128,
};

const moeMeta: GgufMeta = {
  architecture: "qwen3moe",
  contextLength: 131072,
  blockCount: 48,
  kvHeads: 8,
  headDim: 128,
  expertCount: 128,
  expertUsedCount: 8,
};

describe("buildContextPlans — dense", () => {
  it("emits a single fast plan per rung when weights fit comfortably", () => {
    const { plans, recommendedPlan } = buildContextPlans(
      [4096, 8192, 16384],
      4 * GB,
      denseMeta,
      GPU_24,
      undefined,
      RAM_32,
    );
    expect(plans.every((p) => p.fit === "fast")).toBe(true);
    expect(plans.every((p) => p.offload === "full_gpu" && p.kvCache === "f16")).toBe(true);
    // recommendedPlan = highest-ctx fast plan.
    expect(recommendedPlan?.ctx).toBe(16384);
    expect(recommendedPlan?.fit).toBe("fast");
    // No experts_cpu plans for dense models → never carry nCpuMoe.
    expect(plans.every((p) => p.nCpuMoe === undefined)).toBe(true);
  });

  it("falls back to q8_0 full_gpu when f16 spills, and q8_0 halves kvBytes", () => {
    // weights 16 GB + f16 KV 8 GB + 1.5 overhead = 25.5 > 24 → spill;
    // q8_0 KV 4 GB → 21.5 ≤ 24 → fast.
    const { plans, recommendedPlan } = buildContextPlans(
      [65536],
      16 * GB,
      denseMeta,
      GPU_24,
      undefined,
      RAM_32,
    );

    const f16 = plans.find((p) => p.kvCache === "f16");
    const q8 = plans.find((p) => p.kvCache === "q8_0");
    expect(f16?.fit).toBe("spill");
    expect(q8?.fit).toBe("fast");
    expect(f16 && q8 && f16.kvBytes === q8.kvBytes * 2).toBe(true);
    expect(q8?.label).toContain("compressed KV");
    // best is not fast → the unlocking fallback is emitted alongside it.
    expect(plans.map((p) => p.kvCache)).toEqual(["f16", "q8_0"]);
    expect(recommendedPlan?.kvCache).toBe("q8_0");
    expect(recommendedPlan?.fit).toBe("fast");
  });
});

describe("buildContextPlans — MoE experts_cpu", () => {
  it("offers an experts-in-RAM plan carrying nCpuMoe = block_count", () => {
    // 40 GB weights spill on full_gpu; experts-on-CPU is the quick fallback:
    // GPU need = 40×(8/128)+KV+1.5 ≪ 24, RAM need ≈ 40×0.9375+1.5 ≤ 64.
    const { plans, recommendedPlan } = buildContextPlans(
      [32768],
      40 * GB,
      moeMeta,
      GPU_24,
      undefined,
      RAM_64,
    );

    const experts = plans.find((p) => p.offload === "experts_cpu");
    expect(experts).toBeDefined();
    expect(experts?.fit).toBe("spill");
    expect(experts?.nCpuMoe).toBe(48);
    expect(experts?.ramNeedMB).toBeGreaterThan(experts?.vramNeedMB ?? 0);
    expect(experts?.label).toMatch(/experts in system RAM/i);
    // experts_cpu is the recommended spill plan — quicker than full-GPU spill.
    expect(recommendedPlan?.offload).toBe("experts_cpu");
    expect(recommendedPlan?.fit).toBe("spill");
  });

  it("uses the 0.25 conservative active ratio when expert_used_count is absent", () => {
    const noUsed: GgufMeta = { ...moeMeta };
    delete noUsed.expertUsedCount;
    // ctx 4096 keeps KV ~0.5 GB so the GPU need reflects the 0.25 weight ratio:
    // 40×0.25 + 0.5 + 1.5 = 12 GB → ~12288 MB.
    const { plans } = buildContextPlans([4096], 40 * GB, noUsed, GPU_24, undefined, RAM_64);
    const experts = plans.find((p) => p.offload === "experts_cpu");
    expect(experts).toBeDefined();
    expect(experts?.vramNeedMB).toBeGreaterThan(11 * 1024);
    expect(experts?.vramNeedMB).toBeLessThan(13 * 1024);
  });
});

describe("buildContextPlans — CPU-only rig (no GPU, no unified memory)", () => {
  const NO_GPU: GpuInfo[] = [];

  it("emits a single cpu plan per rung sized against RAM, never full_gpu", () => {
    // weights 2 GB + f16 KV (ctx 4096 ≈ 0.5 GB) + 1.5 overhead ≈ 4 GB ≤ 32 GB RAM.
    const { plans, recommendedPlan } = buildContextPlans(
      [4096],
      2 * GB,
      denseMeta,
      NO_GPU,
      undefined,
      RAM_32,
    );
    expect(plans).toHaveLength(1);
    expect(plans[0]?.offload).toBe("cpu");
    expect(plans[0]?.kvCache).toBe("f16");
    expect(plans[0]?.vramNeedMB).toBe(0);
    expect(plans[0]?.fit).toBe("spill");
    expect(plans[0]?.label).toContain("CPU");
    expect(plans.every((p) => p.offload !== "full_gpu" && p.offload !== "experts_cpu")).toBe(true);
    expect(recommendedPlan?.offload).toBe("cpu");
    expect(recommendedPlan?.fit).toBe("spill");
  });

  it("falls back to a q8_0 cpu plan only when it unlocks a rung f16 exceeds RAM", () => {
    // weights 24 GB: ctx 4096 fits f16 (24 + 0.5 + 1.5 = 26 ≤ 32); ctx 65536
    // f16 KV 8 GB spills RAM (24 + 8 + 1.5 = 33.5 > 32), q8_0 KV 4 GB unlocks
    // it (24 + 4 + 1.5 = 29.5 ≤ 32).
    const { plans, recommendedPlan } = buildContextPlans(
      [4096, 65536],
      24 * GB,
      denseMeta,
      NO_GPU,
      undefined,
      RAM_32,
    );
    expect(plans).toHaveLength(2);
    const small = plans.find((p) => p.ctx === 4096);
    const big = plans.find((p) => p.ctx === 65536);
    expect(small?.kvCache).toBe("f16");
    expect(small?.fit).toBe("spill");
    expect(big?.kvCache).toBe("q8_0");
    expect(big?.fit).toBe("spill");
    expect(big?.offload).toBe("cpu");
    // recommendedPlan = highest-ctx fitting cpu plan.
    expect(recommendedPlan?.ctx).toBe(65536);
    expect(recommendedPlan?.kvCache).toBe("q8_0");
  });

  it("reports fit: 'no' when neither f16 nor q8_0 fits in RAM", () => {
    // weights 40 GB: even q8_0 (40 + 0.25 + 1.5 = 41.75) exceeds 32 GB RAM.
    const { plans, recommendedPlan } = buildContextPlans(
      [4096],
      40 * GB,
      denseMeta,
      NO_GPU,
      undefined,
      RAM_32,
    );
    expect(plans).toHaveLength(1);
    expect(plans[0]?.fit).toBe("no");
    expect(plans[0]?.offload).toBe("cpu");
    expect(plans[0]?.kvCache).toBe("f16");
    expect(recommendedPlan).toBeNull();
  });

  it("never offers experts_cpu for a MoE GGUF when there is no GPU", () => {
    const { plans } = buildContextPlans([4096], 4 * GB, moeMeta, NO_GPU, undefined, RAM_32);
    expect(plans.every((p) => p.offload === "cpu")).toBe(true);
    expect(plans.every((p) => p.nCpuMoe === undefined)).toBe(true);
  });
});
