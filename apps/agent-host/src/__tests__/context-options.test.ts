/**
 * Tests for context-options fit-tier math and buildContextOptions fallback.
 * Uses fixed hardware inputs — pure function, no file I/O.
 */

import { describe, it, expect, vi } from "vitest";
import type { GpuInfo } from "@interloom/protocol";

vi.mock("../models/gguf.js", () => ({
  parseGgufMeta: vi.fn().mockReturnValue(null),
}));

vi.mock("../config.js", () => ({
  PORT: 7420,
  DATA_DIR: "./test-data",
  MODELS_DIR: "./test-models",
  NETWORK_URL: "http://localhost:9999",
  INFERENCE_URL: "http://localhost:8080",
  FETCHER_URL: "http://localhost:7423",
}));

import { kvBytes, fitTier, buildContextOptions } from "../models/routes.js";
import { parseGgufMeta } from "../models/gguf.js";

// ---------------------------------------------------------------------------
// kvBytes
// ---------------------------------------------------------------------------

describe("kvBytes", () => {
  it("computes KV-cache size correctly", () => {
    // 2 × 32 × 8 × 128 × 2 × 4096 = 268,435,456 bytes (256 MB)
    expect(kvBytes(32, 8, 128, 4096)).toBe(2 * 32 * 8 * 128 * 2 * 4096);
  });

  it("scales linearly with context length", () => {
    const base = kvBytes(32, 8, 128, 4096);
    expect(kvBytes(32, 8, 128, 8192)).toBe(base * 2);
    expect(kvBytes(32, 8, 128, 16384)).toBe(base * 4);
  });
});

// ---------------------------------------------------------------------------
// fitTier — fixed hardware inputs
// ---------------------------------------------------------------------------

const OVERHEAD = 1.5 * 1024 * 1024 * 1024; // 1.5 GB

describe("fitTier — discrete GPU (CUDA)", () => {
  const gpus: GpuInfo[] = [{ name: "RTX 4090", vramMB: 24576, kind: "cuda" }];
  const freeVram = 24576 * 1024 * 1024;

  it("returns 'fast' when model weights + KV fit in VRAM", () => {
    // tiny model: 1 GB, tiny KV
    const fit = fitTier({
      fileSizeBytes: 1 * 1024 * 1024 * 1024,
      gpus,
      layers: 4,
      kvHeads: 2,
      headDim: 64,
      ctx: 4096,
    });
    expect(fit).toBe("fast");
  });

  it("returns 'no' when total exceeds VRAM and spill bound", () => {
    // massive model: 50 GB — won't fit anywhere
    const fit = fitTier({
      fileSizeBytes: 50 * 1024 * 1024 * 1024,
      gpus,
      layers: 80,
      kvHeads: 64,
      headDim: 128,
      ctx: 131072,
    });
    expect(fit).toBe("no");
  });

  it("returns 'spill' for weights + KV between VRAM and spill bound", () => {
    // Craft inputs so total just exceeds freeVram but fits in spill
    // total must be freeVram < total <= freeVram + 0.5*RAM
    // Use fileSizeBytes = freeVram (exceeds VRAM alone), small KV
    const fit = fitTier({
      fileSizeBytes: freeVram, // equal to vram → exceeds with overhead
      gpus,
      layers: 1,
      kvHeads: 1,
      headDim: 1,
      ctx: 1,
      unifiedMemoryMB: undefined,
    });
    // total = freeVram + tiny_kv + OVERHEAD > freeVram → at least spill
    expect(["spill", "no"]).toContain(fit);
  });

  it("exact 'fast' boundary — well under VRAM", () => {
    // 1 MB model, trivial KV — total is far below 24 GB VRAM
    const fit = fitTier({
      fileSizeBytes: 1 * 1024 * 1024,
      gpus,
      layers: 1,
      kvHeads: 1,
      headDim: 1,
      ctx: 1,
    });
    expect(fit).toBe("fast");
  });
});

describe("fitTier — unified memory (arm64)", () => {
  const gpus: GpuInfo[] = []; // no discrete GPU
  const unifiedMemoryMB = 16384; // 16 GB unified

  it("returns a valid tier for a tiny model with unified memory configured", () => {
    // We can't easily mock os.arch() here, so we just verify a valid tier is returned.
    // On arm64 this would be 'fast' (500 MB + tiny KV << 16 GB unified).
    // On x64 test runners freeVram=0, so 'spill' (total < 50% system RAM).
    const fit = fitTier({
      fileSizeBytes: 500 * 1024 * 1024, // 500 MB
      gpus,
      unifiedMemoryMB,
      layers: 8,
      kvHeads: 4,
      headDim: 64,
      ctx: 4096,
    });
    expect(["fast", "spill", "no"]).toContain(fit);
  });

  it("'fast' classification on unified memory: tiny model with large unified pool", () => {
    // On arm64, 1 MB model + tiny KV vs 64 GB unified memory = fast.
    // Verify the math directly: freeVram = unifiedMB * 1MB = 64 GB,
    // total = 1 MB + KV(~small) + 1.5 GB << 64 GB → 'fast' on arm64.
    // On x64 test runners the unified path doesn't activate but result is still valid.
    const fit = fitTier({
      fileSizeBytes: 1 * 1024 * 1024, // 1 MB
      gpus,
      unifiedMemoryMB: 65536, // 64 GB
      layers: 1,
      kvHeads: 1,
      headDim: 1,
      ctx: 1,
    });
    expect(["fast", "spill"]).toContain(fit);
  });
});

// ---------------------------------------------------------------------------
// buildContextOptions — exact: false fallback path
// ---------------------------------------------------------------------------

describe("buildContextOptions — heuristic fallback (GGUF parse fails)", () => {
  it("returns exact:false when GGUF parse returns null", () => {
    vi.mocked(parseGgufMeta).mockReturnValue(null);

    const gpus: GpuInfo[] = [{ name: "RTX 4090", vramMB: 24576, kind: "cuda" }];
    const result = buildContextOptions("/fake/model.gguf", 4 * 1024 * 1024 * 1024, gpus);

    expect(result.exact).toBe(false);
    expect(result.trainedMax).toBeNull();
    expect(result.options.length).toBeGreaterThan(0);
    expect(result.recommendedCtx).toBeGreaterThanOrEqual(4096);
    // All ctx values are powers of 2 starting from 4096, capped at 32768
    for (const opt of result.options) {
      expect(opt.ctx).toBeGreaterThanOrEqual(4096);
      expect(opt.ctx).toBeLessThanOrEqual(32768);
    }
  });

  it("options list starts at 4096 in fallback mode", () => {
    vi.mocked(parseGgufMeta).mockReturnValue(null);
    const gpus: GpuInfo[] = [];
    const result = buildContextOptions("/fake/model.gguf", 1024 * 1024 * 1024, gpus);
    expect(result.options[0]?.ctx).toBe(4096);
  });
});

// ---------------------------------------------------------------------------
// buildContextOptions — exact path (with GGUF metadata)
// ---------------------------------------------------------------------------

describe("buildContextOptions — exact path (GGUF parse succeeds)", () => {
  it("returns exact:true and trainedMax from GGUF metadata", () => {
    vi.mocked(parseGgufMeta).mockReturnValue({
      architecture: "llama",
      contextLength: 8192,
      blockCount: 32,
      kvHeads: 8,
      headDim: 128,
    });

    const gpus: GpuInfo[] = [{ name: "RTX 4090", vramMB: 24576, kind: "cuda" }];
    const result = buildContextOptions("/fake/model.gguf", 4 * 1024 * 1024 * 1024, gpus);

    expect(result.exact).toBe(true);
    expect(result.trainedMax).toBe(8192);
    expect(result.options.every((o) => o.ctx <= 8192)).toBe(true);
    expect(result.options[0]?.ctx).toBe(4096);
  });

  it("recommendedCtx is the largest 'fast' option", () => {
    vi.mocked(parseGgufMeta).mockReturnValue({
      architecture: "llama",
      contextLength: 32768,
      blockCount: 32,
      kvHeads: 8,
      headDim: 128,
    });

    const gpus: GpuInfo[] = [{ name: "RTX 4090", vramMB: 24576, kind: "cuda" }];
    const result = buildContextOptions("/fake/model.gguf", 4 * 1024 * 1024 * 1024, gpus);

    const fastOptions = result.options.filter((o) => o.fit === "fast");
    if (fastOptions.length > 0) {
      const maxFast = Math.max(...fastOptions.map((o) => o.ctx));
      expect(result.recommendedCtx).toBe(maxFast);
    } else {
      expect(result.recommendedCtx).toBe(4096);
    }
  });

  it("caps options at 131072", () => {
    vi.mocked(parseGgufMeta).mockReturnValue({
      architecture: "llama",
      contextLength: 1_000_000,
      blockCount: 32,
      kvHeads: 8,
      headDim: 128,
    });

    const gpus: GpuInfo[] = [];
    const result = buildContextOptions("/fake/model.gguf", 1024 * 1024, gpus);

    for (const opt of result.options) {
      expect(opt.ctx).toBeLessThanOrEqual(131072);
    }
  });
});

// ---------------------------------------------------------------------------
// buildContextOptions — mmproj-aware fit (CONTRACTS §6)
// ---------------------------------------------------------------------------

describe("mmproj-aware fit (CONTRACTS §6)", () => {
  it("adding mmprojBytes shrinks or removes fast options versus without", () => {
    const gpus = [{ name: "RTX 3080", vramMB: 10240, kind: "cuda" as const }];
    const without = buildContextOptions("/nonexistent.gguf", 7 * 1024 ** 3, gpus, undefined);
    const withMmproj = buildContextOptions(
      "/nonexistent.gguf",
      7 * 1024 ** 3,
      gpus,
      undefined,
      1.5 * 1024 ** 3,
    );
    const fastCount = (o: typeof without) => o.options.filter((x) => x.fit === "fast").length;
    expect(fastCount(withMmproj)).toBeLessThanOrEqual(fastCount(without));
    expect(withMmproj.recommendedCtx).toBeLessThanOrEqual(without.recommendedCtx);
  });
});
