/**
 * Tests for GET /api/models/active — verifies the ctx field is present in the
 * response (Fix 1: active model omitted ctx, causing silent degradation in the
 * portal overview pill, installed-tab suffix, and prompt-budget cap).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

vi.mock("../config.js", () => ({
  PORT: 7420,
  DATA_DIR: "./test-data",
  MODELS_DIR: "./test-models",
  NETWORK_URL: "http://localhost:9999",
  INFERENCE_URL: "http://localhost:8080",
  FETCHER_URL: "http://localhost:7423",
}));

vi.mock("../telemetry/collector.js", () => ({
  addRequestLogEntry: vi.fn(),
  recordTokensPerSec: vi.fn(),
}));

vi.mock("../settings.js", () => ({
  getHfStatus: vi.fn().mockReturnValue({ connected: false }),
  connectHfToken: vi.fn(),
  disconnectHfToken: vi.fn(),
  getHfToken: vi.fn().mockReturnValue(null),
}));

let mockActiveModel: { path: string; filename: string; ctx: number } | null = null;

vi.mock("../models/active.js", () => ({
  getActiveModel: async () => mockActiveModel,
  getConfiguredModelFilename: () => mockActiveModel?.filename ?? null,
  readInferenceCtx: () => mockActiveModel?.ctx ?? 4096,
  findLocalModelPath: vi.fn().mockReturnValue(null),
}));

vi.mock("../models/gguf.js", () => ({
  parseGgufMeta: vi.fn().mockReturnValue(null),
}));

describe("GET /api/models/active — ctx field", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    mockActiveModel = null;

    app = Fastify({ logger: false });

    const { registerModelsRoutes } = await import("../models/routes.js");
    registerModelsRoutes(app, async () => ({ gpus: [], unifiedMemoryMB: undefined }));
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    vi.resetModules();
  });

  it("returns null when no model is active", async () => {
    mockActiveModel = null;

    const res = await app.inject({ method: "GET", url: "/api/models/active" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toBeNull();
  });

  it("returns path, filename, and ctx when a model is active", async () => {
    mockActiveModel = { path: "/models/qwen.gguf", filename: "qwen.gguf", ctx: 8192 };

    const res = await app.inject({ method: "GET", url: "/api/models/active" });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body) as { path: string; filename: string; ctx: number };
    expect(body.path).toBe("/models/qwen.gguf");
    expect(body.filename).toBe("qwen.gguf");
    expect(body.ctx).toBe(8192);
  });

  it("ctx field is a number (not missing or undefined)", async () => {
    mockActiveModel = { path: "/models/llama.gguf", filename: "llama.gguf", ctx: 4096 };

    const res = await app.inject({ method: "GET", url: "/api/models/active" });
    const body = JSON.parse(res.body) as { ctx?: unknown };
    expect(typeof body.ctx).toBe("number");
  });
});
