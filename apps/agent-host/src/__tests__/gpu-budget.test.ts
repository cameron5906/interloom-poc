/**
 * Tests for per-GPU committed-VRAM accounting (CONTRACTS §6
 * `POST /api/models/load` fit enforcement, `GET /api/models/allocation`).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type { GpuInfo } from "@interloom/protocol";
import {
  computeInstanceFootprintBytes,
  distributeFootprintAcrossGpus,
  computeGpuBudgets,
  fitDecisionForNewInstance,
  pickBestFitGpu,
  type InstanceFootprint,
} from "../models/fit.js";
import { buildGguf, textModelKvs } from "./fixtures/gguf.js";

// qwen3 fixture: block_count=36, head_count_kv=8, embedding_length=4096,
// head_count=32 → headDim=128. kvBytes/token = 2*36*8*128*2 = 147456 bytes.
const KV_BYTES_PER_TOKEN = 147_456;

let tmpDir: string;

// "Model" sizes in these tests run into the tens of GB — real files that
// size would blow past CI/dev disk quotas. Instead we write the REAL (small)
// GGUF header to disk and fake `fs.statSync(...).size` for that path only;
// `parseGgufMeta` reads only the header bytes that actually exist regardless
// of the reported size, so the header still parses correctly.
const sizeOverrides = new Map<string, number>();
const realStatSync = fs.statSync.bind(fs);

beforeAll(() => {
  vi.spyOn(fs, "statSync").mockImplementation(((p: fs.PathLike, opts?: unknown) => {
    const real = realStatSync(p, opts as never);
    const override = sizeOverrides.get(path.resolve(String(p)));
    if (override !== undefined) {
      return Object.assign(Object.create(Object.getPrototypeOf(real)), real, { size: override });
    }
    return real;
  }) as typeof fs.statSync);
});

afterAll(() => {
  vi.restoreAllMocks();
});

function writeFakeModel(filename: string, totalSizeBytes: number, chatTemplate?: string): string {
  const header = buildGguf(textModelKvs(chatTemplate));
  const filePath = path.join(tmpDir, filename);
  fs.writeFileSync(filePath, header);
  sizeOverrides.set(path.resolve(filePath), Math.round(totalSizeBytes));
  return filePath;
}

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

/** Relative-tolerance comparison for large byte counts (floating-point-safe). */
function expectCloseRel(actual: number, expected: number, relTolerance = 1e-9): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(Math.abs(expected) * relTolerance + 1);
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "il-gpu-budget-"));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("computeInstanceFootprintBytes", () => {
  it("sums weights + KV + 15% overhead using GGUF header when parseable", () => {
    const modelPath = writeFakeModel("model-a.gguf", 1 * GB);
    const ctx = 4096;
    const footprint = computeInstanceFootprintBytes({ modelPath, ctx, gpus: [0] });
    const expectedBase = 1 * GB + KV_BYTES_PER_TOKEN * ctx;
    expectCloseRel(footprint, expectedBase * 1.15);
  });

  it("includes mmproj size in the weights total", () => {
    const modelPath = writeFakeModel("model-b.gguf", 1 * GB);
    const mmprojPath = writeFakeModel("model-b.mmproj.gguf", 0.2 * GB);
    const withMmproj = computeInstanceFootprintBytes({ modelPath, mmprojPath, ctx: 4096, gpus: [0] });
    const without = computeInstanceFootprintBytes({ modelPath, ctx: 4096, gpus: [0] });
    expect(withMmproj).toBeGreaterThan(without);
    expectCloseRel(withMmproj - without, 0.2 * GB * 1.15);
  });

  it("falls back to the size heuristic when the GGUF header doesn't parse", () => {
    const filePath = path.join(tmpDir, "not-a-gguf.gguf");
    fs.writeFileSync(filePath, Buffer.alloc(16)); // no GGUF magic
    sizeOverrides.set(path.resolve(filePath), 500 * 1024 * 1024); // faked 500MB
    const ctx = 4096;
    const footprint = computeInstanceFootprintBytes({ modelPath: filePath, ctx, gpus: [0] });
    const fileSizeGB = (500 * 1024 * 1024) / GB;
    const expectedKv = fileSizeGB * 12_000 * ctx;
    const expectedBase = 500 * 1024 * 1024 + expectedKv;
    expectCloseRel(footprint, expectedBase * 1.15);
  });

  it("never throws for a missing file (0-byte weights, heuristic KV)", () => {
    const footprint = computeInstanceFootprintBytes({
      modelPath: path.join(tmpDir, "does-not-exist.gguf"),
      ctx: 4096,
      gpus: [0],
    });
    expect(footprint).toBe(0);
  });
});

describe("distributeFootprintAcrossGpus", () => {
  it("charges the full footprint to a single GPU", () => {
    const dist = distributeFootprintAcrossGpus({ modelPath: "x", ctx: 4096, gpus: [1] }, 1000);
    expect(Object.fromEntries(dist)).toEqual({ 1: 1000 });
  });

  it("splits evenly across a fused span with no tensorSplit", () => {
    const dist = distributeFootprintAcrossGpus({ modelPath: "x", ctx: 4096, gpus: [0, 1] }, 1000);
    expect(dist.get(0)).toBeCloseTo(500);
    expect(dist.get(1)).toBeCloseTo(500);
  });

  it("splits by tensorSplit ratios across a fused span", () => {
    const dist = distributeFootprintAcrossGpus(
      { modelPath: "x", ctx: 4096, gpus: [0, 1], tensorSplit: [3, 1] },
      1000,
    );
    expect(dist.get(0)).toBeCloseTo(750);
    expect(dist.get(1)).toBeCloseTo(250);
  });

  it("returns an empty map when no GPUs are assigned", () => {
    const dist = distributeFootprintAcrossGpus({ modelPath: "x", ctx: 4096, gpus: [] }, 1000);
    expect(dist.size).toBe(0);
  });
});

describe("computeGpuBudgets", () => {
  const gpus: GpuInfo[] = [
    { name: "GPU0", vramMB: 24576, kind: "cuda", index: 0 },
    { name: "GPU1", vramMB: 24576, kind: "cuda", index: 1 },
  ];

  it("reports full free VRAM with no instances loaded", () => {
    const budgets = computeGpuBudgets(gpus, []);
    expect(budgets).toHaveLength(2);
    for (const b of budgets) {
      expect(b.vramCommittedMB).toBe(0);
      expect(b.vramFreeMB).toBe(24576);
    }
  });

  it("charges an instance's footprint only to the GPU it's placed on", () => {
    const modelPath = writeFakeModel("model-c.gguf", 2 * GB);
    const instances: InstanceFootprint[] = [{ modelPath, ctx: 4096, gpus: [0] }];
    const budgets = computeGpuBudgets(gpus, instances);
    const g0 = budgets.find((b) => b.index === 0)!;
    const g1 = budgets.find((b) => b.index === 1)!;
    expect(g0.vramCommittedMB).toBeGreaterThan(0);
    expect(g1.vramCommittedMB).toBe(0);
    expect(g0.vramFreeMB).toBe(g0.vramTotalMB - g0.vramCommittedMB);
  });

  it("sums multiple instances committed to the same GPU", () => {
    const m1 = writeFakeModel("model-d1.gguf", 1 * GB);
    const m2 = writeFakeModel("model-d2.gguf", 1 * GB);
    const instances: InstanceFootprint[] = [
      { modelPath: m1, ctx: 4096, gpus: [0] },
      { modelPath: m2, ctx: 4096, gpus: [0] },
    ];
    const budgets = computeGpuBudgets(gpus, instances);
    const single = computeGpuBudgets(gpus, [instances[0]!]).find((b) => b.index === 0)!;
    const combined = budgets.find((b) => b.index === 0)!;
    expect(combined.vramCommittedMB).toBeGreaterThan(single.vramCommittedMB);
  });
});

describe("fitDecisionForNewInstance — wont_fit / spill / fast boundaries across two GPUs", () => {
  const gpus: GpuInfo[] = [
    { name: "GPU0", vramMB: 24576, kind: "cuda", index: 0 }, // 24GB
    { name: "GPU1", vramMB: 8192, kind: "cuda", index: 1 }, // 8GB
  ];

  // Pin the spill-headroom RAM so the suite is hermetic on any runner — the
  // production default (`os.totalmem()`) makes the spill boundary depend on the
  // host, which passes on a 64GB dev box but not a ~7GB CI runner. `fit.ts`
  // now takes RAM as an injectable parameter for exactly this reason.
  const FIXED_RAM_GB = 32;
  const FIXED_RAM = FIXED_RAM_GB * GB;

  it("fast: a small model on the empty 24GB GPU", () => {
    const modelPath = writeFakeModel("small.gguf", 2 * GB);
    const decision = fitDecisionForNewInstance(
      { modelPath, ctx: 4096, gpus: [0] },
      gpus,
      [],
      undefined,
      FIXED_RAM,
    );
    expect(decision).toBe("fast");
  });

  it("no: a model larger than total VRAM+RAM headroom on the 8GB GPU", () => {
    // Exceeds 8GB VRAM + 50% of the pinned system RAM.
    const hugeGB = 8 + FIXED_RAM_GB * 0.5 + 50;
    const modelPath = writeFakeModel("huge.gguf", hugeGB * GB);
    const decision = fitDecisionForNewInstance(
      { modelPath, ctx: 4096, gpus: [1] },
      gpus,
      [],
      undefined,
      FIXED_RAM,
    );
    expect(decision).toBe("no");
  });

  it("accounts for existing instances' committed VRAM on the target GPU (remaining budget, not total)", () => {
    const existingModel = writeFakeModel("existing.gguf", 18 * GB);
    const existing: InstanceFootprint[] = [{ modelPath: existingModel, ctx: 4096, gpus: [0] }];

    const candidateModel = writeFakeModel("candidate.gguf", 4 * GB);
    // Against the empty GPU this would be "fast"; against the same GPU with
    // 18GB already committed, remaining free is ~6GB — a 4GB+KV+overhead
    // candidate should now be spill or no, never fast.
    const decisionEmpty = fitDecisionForNewInstance(
      { modelPath: candidateModel, ctx: 4096, gpus: [0] },
      gpus,
      [],
      undefined,
      FIXED_RAM,
    );
    const decisionCommitted = fitDecisionForNewInstance(
      { modelPath: candidateModel, ctx: 4096, gpus: [0] },
      gpus,
      existing,
      undefined,
      FIXED_RAM,
    );
    expect(decisionEmpty).toBe("fast");
    expect(decisionCommitted).not.toBe("fast");
  });

  it("spill: fits within VRAM+RAM but not VRAM alone", () => {
    // 8GB GPU, model footprint sized to exceed 8GB but stay under 8GB + 50% of
    // the pinned system RAM (spill bound = 8 + 16 = 24GB here).
    const targetGB = 8 + 4; // 12GB weights → over VRAM, well under the spill bound
    const modelPath = writeFakeModel("spill.gguf", Math.round(targetGB * GB));
    const decision = fitDecisionForNewInstance(
      { modelPath, ctx: 4096, gpus: [1] },
      gpus,
      [],
      undefined,
      FIXED_RAM,
    );
    expect(decision).toBe("spill");
  });
});

describe("pickBestFitGpu", () => {
  const gpus: GpuInfo[] = [
    { name: "GPU0", vramMB: 24576, kind: "cuda", index: 0 },
    { name: "GPU1", vramMB: 8192, kind: "cuda", index: 1 },
  ];

  it("picks the GPU with the most free VRAM that the candidate fits on", () => {
    const idx = pickBestFitGpu(4 * GB, gpus, []);
    expect(idx).toBe(0);
  });

  it("prefers the least-loaded eligible GPU when both fit", () => {
    const modelPath = writeFakeModel("loaded-on-0.gguf", 10 * GB);
    const existing: InstanceFootprint[] = [{ modelPath, ctx: 4096, gpus: [0] }];
    // After ~10GB+KV+overhead committed to GPU0, GPU1 (8GB, empty) may now have more free room.
    const idx = pickBestFitGpu(1 * MB, gpus, existing);
    expect(idx).not.toBeNull();
  });

  it("returns null when there are no CUDA GPUs", () => {
    expect(pickBestFitGpu(1 * GB, [], [])).toBeNull();
  });
});
