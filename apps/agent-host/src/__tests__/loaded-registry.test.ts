/**
 * Tests for the multi-instance model registry (CONTRACTS §6): v1/v2 read
 * compat, port assignment (incl. freed-port reuse), and the loaded-set view.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

let tmpModelsDir: string;

beforeEach(() => {
  tmpModelsDir = fs.mkdtempSync(path.join(os.tmpdir(), "il-models-"));
  vi.resetModules();
  vi.doMock("../config.js", () => ({
    PORT: 7420,
    DATA_DIR: "./test-data",
    MODELS_DIR: tmpModelsDir,
    NETWORK_URL: "http://localhost:9999",
    INFERENCE_URL: "http://inference:8080",
    FETCHER_URL: "http://localhost:7423",
  }));
});

afterEach(() => {
  fs.rmSync(tmpModelsDir, { recursive: true, force: true });
  vi.doUnmock("../config.js");
});

function writeInferenceJson(contents: unknown): void {
  const dir = path.join(tmpModelsDir, ".interloom");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "inference.json"), JSON.stringify(contents), "utf8");
}

describe("readInstances — v1/v2 compat", () => {
  it("returns [] when inference.json doesn't exist", async () => {
    const { readInstances } = await import("../models/loaded.js");
    expect(readInstances()).toEqual([]);
  });

  it("reads a v1 single-object shape (no `v` key) as one legacy instance on port 8080", async () => {
    writeInferenceJson({ modelPath: "/models/qwen.gguf", ctx: 8192 });
    const { readInstances } = await import("../models/loaded.js");
    const instances = readInstances();
    expect(instances).toHaveLength(1);
    expect(instances[0]).toMatchObject({
      id: "legacy",
      modelPath: "/models/qwen.gguf",
      ctx: 8192,
      port: 8080,
    });
  });

  it("v1 shape without ctx defaults to 4096", async () => {
    writeInferenceJson({ modelPath: "/models/llama.gguf" });
    const { readInstances } = await import("../models/loaded.js");
    expect(readInstances()[0]?.ctx).toBe(4096);
  });

  it("v1 shape carries mmprojPath through", async () => {
    writeInferenceJson({ modelPath: "/models/vision.gguf", ctx: 4096, mmprojPath: "/models/vision.mmproj.gguf" });
    const { readInstances } = await import("../models/loaded.js");
    expect(readInstances()[0]?.mmprojPath).toBe("/models/vision.mmproj.gguf");
  });

  it("reads a v2 shape with multiple instances", async () => {
    writeInferenceJson({
      v: 2,
      instances: [
        { id: "a", modelPath: "/models/a.gguf", ctx: 4096, port: 8080, gpus: [0] },
        { id: "b", modelPath: "/models/b.gguf", ctx: 8192, port: 8081, gpus: [1] },
      ],
    });
    const { readInstances } = await import("../models/loaded.js");
    const instances = readInstances();
    expect(instances).toHaveLength(2);
    expect(instances.map((i) => i.port)).toEqual([8080, 8081]);
  });

  it("returns [] for malformed JSON", async () => {
    const dir = path.join(tmpModelsDir, ".interloom");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "inference.json"), "{not json", "utf8");
    const { readInstances } = await import("../models/loaded.js");
    expect(readInstances()).toEqual([]);
  });

  it("returns [] for a v2 shape with a non-array instances field", async () => {
    writeInferenceJson({ v: 2, instances: "oops" });
    const { readInstances } = await import("../models/loaded.js");
    expect(readInstances()).toEqual([]);
  });
});

describe("writeInstances", () => {
  it("round-trips through readInstances as v2", async () => {
    const { readInstances, writeInstances } = await import("../models/loaded.js");
    writeInstances([
      { id: "x", modelPath: "/models/x.gguf", ctx: 4096, port: 8080, gpus: [0] },
    ]);
    const raw = JSON.parse(
      fs.readFileSync(path.join(tmpModelsDir, ".interloom", "inference.json"), "utf8"),
    ) as { v: number; instances: unknown[] };
    expect(raw.v).toBe(2);
    expect(raw.instances).toHaveLength(1);
    expect(readInstances()).toHaveLength(1);
  });
});

describe("nextPort — deterministic 8080+N with freed-port reuse", () => {
  it("assigns 8080 when nothing is loaded", async () => {
    const { nextPort } = await import("../models/loaded.js");
    expect(nextPort([])).toBe(8080);
  });

  it("assigns the next sequential port when 8080 is taken", async () => {
    const { nextPort } = await import("../models/loaded.js");
    const existing = [{ id: "a", modelPath: "a", ctx: 4096, port: 8080, gpus: [] }];
    expect(nextPort(existing)).toBe(8081);
  });

  it("reuses a freed port instead of always growing", async () => {
    const { nextPort } = await import("../models/loaded.js");
    // 8080 and 8082 loaded, 8081 was freed (its instance was unloaded)
    const existing = [
      { id: "a", modelPath: "a", ctx: 4096, port: 8080, gpus: [] },
      { id: "c", modelPath: "c", ctx: 4096, port: 8082, gpus: [] },
    ];
    expect(nextPort(existing)).toBe(8081);
  });

  it("skips every occupied port in a contiguous run", async () => {
    const { nextPort } = await import("../models/loaded.js");
    const existing = [8080, 8081, 8082].map((port, i) => ({
      id: `${i}`,
      modelPath: `${i}`,
      ctx: 4096,
      port,
      gpus: [],
    }));
    expect(nextPort(existing)).toBe(8083);
  });
});

describe("inferenceHostBase / instanceBaseUrl", () => {
  it("strips the port from INFERENCE_URL, keeping protocol+host", async () => {
    const { inferenceHostBase, instanceBaseUrl } = await import("../models/loaded.js");
    expect(inferenceHostBase()).toBe("http://inference");
    expect(instanceBaseUrl(8080)).toBe("http://inference:8080");
    expect(instanceBaseUrl(8081)).toBe("http://inference:8081");
  });
});

describe("loadedFilenames / findInstanceByFilename / findInstanceByPath", () => {
  it("builds the loaded-set of filenames from multiple instances", async () => {
    writeInferenceJson({
      v: 2,
      instances: [
        { id: "a", modelPath: "/models/a.gguf", ctx: 4096, port: 8080, gpus: [0] },
        { id: "b", modelPath: "/models/dir/b.gguf", ctx: 4096, port: 8081, gpus: [1] },
      ],
    });
    const { readInstances, loadedFilenames, findInstanceByFilename, findInstanceByPath } = await import(
      "../models/loaded.js"
    );
    const instances = readInstances();
    expect(loadedFilenames(instances)).toEqual(new Set(["a.gguf", "b.gguf"]));
    expect(findInstanceByFilename("b.gguf", instances)?.port).toBe(8081);
    expect(findInstanceByFilename("missing.gguf", instances)).toBeUndefined();
    expect(findInstanceByPath("/models/a.gguf", instances)?.id).toBe("a");
  });
});
