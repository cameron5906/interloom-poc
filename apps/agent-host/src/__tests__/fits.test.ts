import { describe, it, expect } from "vitest";
import { computeAvailableVramMB } from "../models/routes.js";
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
