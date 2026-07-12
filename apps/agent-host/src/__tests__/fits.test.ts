import { describe, it, expect } from "vitest";
import { annotateWithFits, computeAvailableVramMB } from "../models/routes.js";
import type { GpuInfo } from "@interloom/protocol";

describe("computeAvailableVramMB", () => {
  it("returns the max VRAM from CUDA GPUs when present", () => {
    const gpus: GpuInfo[] = [
      { name: "RTX 3090", vramMB: 24576, kind: "cuda" },
      { name: "RTX 3080", vramMB: 10240, kind: "cuda" },
    ];
    expect(computeAvailableVramMB(gpus)).toBe(24576);
  });

  it("returns unifiedMemoryMB on arm64 with no discrete GPU", () => {
    const gpus: GpuInfo[] = [];
    expect(computeAvailableVramMB(gpus, 65536)).toBe(65536);
  });

  it("falls back to 8192 CPU when no GPU and no unified memory", () => {
    expect(computeAvailableVramMB([], undefined)).toBe(8192);
  });

  it("prefers discrete GPU over unified memory", () => {
    const gpus: GpuInfo[] = [{ name: "RTX 4090", vramMB: 24576, kind: "cuda" }];
    expect(computeAvailableVramMB(gpus, 65536)).toBe(24576);
  });
});

describe("annotateWithFits", () => {
  it("marks models fitting within available VRAM as fits=true", () => {
    const gpus: GpuInfo[] = [{ name: "RTX 4090", vramMB: 24576, kind: "cuda" }];
    const annotated = annotateWithFits(gpus);
    for (const model of annotated) {
      if (model.minVramMB <= 24576) {
        expect(model.fits).toBe(true);
      } else {
        expect(model.fits).toBe(false);
      }
    }
  });

  it("marks all models fits=false when VRAM is 0", () => {
    const gpus: GpuInfo[] = [{ name: "GTX 1050", vramMB: 0, kind: "cuda" }];
    const annotated = annotateWithFits(gpus);
    for (const model of annotated) {
      expect(model.fits).toBe(false);
    }
  });

  it("uses CPU fallback 8192 when no GPU", () => {
    const annotated = annotateWithFits([]);
    const maxFitVram = Math.max(
      ...annotated.filter((m) => m.fits).map((m) => m.minVramMB),
    );
    expect(maxFitVram).toBeLessThanOrEqual(8192);
  });

  it("uses unified memory on arm64", () => {
    const annotated = annotateWithFits([], 65536);
    const sparkModel = annotated.find((m) => m.minVramMB === 55552);
    expect(sparkModel?.fits).toBe(true);
  });
});
