/**
 * Tests for the per-model settings store (CONTRACTS §6, DATA_DIR/model-settings.json).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

let tmpDataDir: string;

beforeEach(() => {
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "il-model-settings-"));
  vi.resetModules();
  vi.doMock("../config.js", () => ({
    PORT: 7420,
    DATA_DIR: tmpDataDir,
    MODELS_DIR: "./test-models",
    NETWORK_URL: "http://localhost:9999",
    INFERENCE_URL: "http://inference:8080",
    FETCHER_URL: "http://localhost:7423",
  }));
});

afterEach(() => {
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
  vi.doUnmock("../config.js");
});

describe("model settings store", () => {
  it("listModelSettings returns [] when no file exists", async () => {
    const { listModelSettings } = await import("../models/settingsStore.js");
    expect(listModelSettings()).toEqual([]);
  });

  it("patchModelSettings creates a new entry", async () => {
    const { patchModelSettings, getModelSettings } = await import("../models/settingsStore.js");
    const result = patchModelSettings("qwen.gguf", { disableThinking: true });
    expect(result).toEqual({ filename: "qwen.gguf", disableThinking: true });
    expect(getModelSettings("qwen.gguf")).toEqual({ filename: "qwen.gguf", disableThinking: true });
  });

  it("patchModelSettings merges into an existing entry", async () => {
    const { patchModelSettings } = await import("../models/settingsStore.js");
    patchModelSettings("qwen.gguf", { disableThinking: true });
    const result = patchModelSettings("qwen.gguf", { disableThinking: false });
    expect(result).toEqual({ filename: "qwen.gguf", disableThinking: false });
  });

  it("isThinkingDisabled is true only when explicitly set", async () => {
    const { patchModelSettings, isThinkingDisabled } = await import("../models/settingsStore.js");
    expect(isThinkingDisabled("unknown.gguf")).toBe(false);
    patchModelSettings("qwen.gguf", { disableThinking: true });
    expect(isThinkingDisabled("qwen.gguf")).toBe(true);
    patchModelSettings("llama.gguf", {});
    expect(isThinkingDisabled("llama.gguf")).toBe(false);
  });

  it("persists across module reloads (round-trip through the file)", async () => {
    const store1 = await import("../models/settingsStore.js");
    store1.patchModelSettings("qwen.gguf", { disableThinking: true });

    vi.resetModules();
    vi.doMock("../config.js", () => ({
      PORT: 7420,
      DATA_DIR: tmpDataDir,
      MODELS_DIR: "./test-models",
      NETWORK_URL: "http://localhost:9999",
      INFERENCE_URL: "http://inference:8080",
      FETCHER_URL: "http://localhost:7423",
    }));
    const store2 = await import("../models/settingsStore.js");
    expect(store2.getModelSettings("qwen.gguf")).toEqual({ filename: "qwen.gguf", disableThinking: true });
  });

  it("listModelSettings returns every stored entry", async () => {
    const { patchModelSettings, listModelSettings } = await import("../models/settingsStore.js");
    patchModelSettings("a.gguf", { disableThinking: true });
    patchModelSettings("b.gguf", { disableThinking: false });
    const list = listModelSettings();
    expect(list).toHaveLength(2);
    expect(list.map((s) => s.filename).sort()).toEqual(["a.gguf", "b.gguf"]);
  });
});
