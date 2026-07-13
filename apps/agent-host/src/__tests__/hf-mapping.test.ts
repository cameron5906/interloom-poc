import { describe, expect, it } from "vitest";
import { mapSearchRows, buildRepoDetail, maxFastCtx } from "../models/hf.js";

const GPUS_24GB = [{ name: "RTX 4090", vramMB: 24576, kind: "cuda" as const }];

describe("mapSearchRows (rail, CONTRACTS §6)", () => {
  it("maps repo rows with params + trainedCtx + estimated capabilities", () => {
    const rows = mapSearchRows([
      {
        id: "Qwen/Qwen3-8B-GGUF",
        downloads: 412000,
        likes: 1200,
        tags: ["gguf"],
        gguf: { context_length: 32768 },
      },
    ]);
    expect(rows).toEqual([
      {
        repoId: "Qwen/Qwen3-8B-GGUF",
        likes: 1200,
        downloads: 412000,
        paramsB: 8,
        trainedCtx: 32768,
        capabilities: { tools: true, vision: false, thinking: true },
      },
    ]);
  });

  it("tolerates missing gguf/tags (fields stay absent)", () => {
    const rows = mapSearchRows([{ id: "acme/Mystery-GGUF" }]);
    expect(rows[0]!.trainedCtx).toBeUndefined();
    expect(rows[0]!.repoId).toBe("acme/Mystery-GGUF");
  });
});

describe("maxFastCtx (same math as activation, CONTRACTS §6 context sizing)", () => {
  it("returns the largest power-of-two ctx that fits fast", () => {
    const ctx = maxFastCtx({
      fileSizeBytes: 5 * 1024 ** 3,
      trainedMax: 131072,
      gpus: GPUS_24GB,
      arch: { layers: 36, kvHeads: 8, headDim: 128 },
    });
    expect(ctx).toBeGreaterThanOrEqual(4096);
    expect(Math.log2(ctx!) % 1).toBe(0);
  });

  it("no fast option → null", () => {
    const ctx = maxFastCtx({
      fileSizeBytes: 60 * 1024 ** 3,
      trainedMax: 32768,
      gpus: GPUS_24GB,
      arch: { layers: 80, kvHeads: 8, headDim: 128 },
    });
    expect(ctx).toBeNull();
  });
});

describe("buildRepoDetail", () => {
  it("maps files (gguf only, mmproj separated), picks mmprojFilename, annotates maxFastCtx", () => {
    const detail = buildRepoDetail(
      "acme/Vision-7B-GGUF",
      {
        downloads: 10,
        likes: 2,
        lastModified: "2026-06-01T00:00:00.000Z",
        tags: ["image-text-to-text"],
        gguf: { context_length: 32768 },
        siblings: [
          { rfilename: "Vision-7B-Q4_K_M.gguf", size: 4.5 * 1024 ** 3 },
          { rfilename: "mmproj-f16.gguf", size: 800 * 1024 ** 2 },
          { rfilename: "README.md", size: 100 },
        ],
      },
      { gpus: GPUS_24GB },
    );
    expect(detail.files).toHaveLength(1);
    expect(detail.files[0]!.quant).toBe("Q4_K_M");
    expect(detail.files[0]!.maxFastCtx).toBeGreaterThanOrEqual(4096);
    expect(detail.mmprojFilename).toBe("mmproj-f16.gguf");
    expect(detail.capabilities?.vision).toBe(true);
    expect(detail.trainedCtx).toBe(32768);
  });

  it("extracts quant from dot-delimited GGUF filenames, not just hyphen-delimited", () => {
    const detail = buildRepoDetail(
      "acme/Mixed-Quant-GGUF",
      {
        downloads: 10,
        likes: 2,
        siblings: [
          { rfilename: "model.Q5_K_S.gguf", size: 1024 },
          { rfilename: "Meta-Llama-3.1-8B-Instruct.Q4_K_M.gguf", size: 1024 },
          { rfilename: "Llama-3.3-70B-Instruct-IQ4_XS.gguf", size: 1024 },
          { rfilename: "Vision-7B-Q4_K_M.gguf", size: 1024 },
          { rfilename: "README-model.gguf", size: 1024 },
        ],
      },
      { gpus: GPUS_24GB },
    );
    const quantByFilename = Object.fromEntries(
      detail.files.map((f) => [f.filename, f.quant]),
    );
    expect(quantByFilename["model.Q5_K_S.gguf"]).toBe("Q5_K_S");
    expect(quantByFilename["Meta-Llama-3.1-8B-Instruct.Q4_K_M.gguf"]).toBe("Q4_K_M");
    expect(quantByFilename["Llama-3.3-70B-Instruct-IQ4_XS.gguf"]).toBe("IQ4_XS");
    expect(quantByFilename["Vision-7B-Q4_K_M.gguf"]).toBe("Q4_K_M");
    expect(quantByFilename["README-model.gguf"]).toBe("");
  });
});
