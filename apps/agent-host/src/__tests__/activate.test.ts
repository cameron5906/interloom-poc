/**
 * `POST /api/models/activate` inference.json field writes + input validation
 * (CONTRACTS §6 activate params, §7 inference.json additive fields).
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import Fastify from "fastify";
import type { GpuInfo } from "@interloom/protocol";

const { TMP } = await vi.hoisted(async () => {
  const os = await import("os");
  const path = await import("path");
  // os.tmpdir() is always absolute — env fallbacks can yield ".", and a relative
  // TMP breaks modelPath equality asserts (the route stores resolved paths).
  return { TMP: path.join(os.tmpdir(), `il-activate-${Date.now()}-${Math.random().toString(36).slice(2)}`) };
});

vi.mock("../config.js", () => ({
  PORT: 7420,
  DATA_DIR: TMP,
  MODELS_DIR: path.join(TMP, "models"),
  NETWORK_URL: "http://network.test",
  INFERENCE_URL: "http://inference.test",
  FETCHER_URL: "http://fetcher.test",
  UPDATER_URL: "http://updater.test",
  HOST_VERSION: "dev",
}));

import { registerModelsRoutes } from "../models/routes.js";

const MODELS_DIR = path.join(TMP, "models");
const MODEL_PATH = path.join(MODELS_DIR, "test-model.gguf");

const SYS = async (): Promise<{ gpus: GpuInfo[]; unifiedMemoryMB?: number }> => ({ gpus: [] });

function healthOkFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((url: string | URL) => {
      if (String(url).endsWith("/health")) return Promise.resolve(new Response(null, { status: 200 }));
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    }),
  );
}

/** The v2 inference.json the multi-instance supervisor reads (CONTRACTS §6/§7). */
function readInferenceConfig(): { v: number; instances: Record<string, unknown>[] } {
  const p = path.join(MODELS_DIR, ".interloom", "inference.json");
  return JSON.parse(fs.readFileSync(p, "utf8")) as { v: number; instances: Record<string, unknown>[] };
}

/** The activate wrapper now routes through the guarded multi-instance load, which
 * enforces the file exists — write a small placeholder at the model path. */
function writeModelFile() {
  fs.writeFileSync(MODEL_PATH, Buffer.alloc(64 * 1024, 1));
}

function makeApp() {
  const app = Fastify();
  registerModelsRoutes(app, SYS);
  return app;
}

beforeEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(MODELS_DIR, { recursive: true });
});

afterAll(() => {
  vi.unstubAllGlobals();
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe("activate — inference.json writes", () => {
  it("carries kvCache and nCpuMoe onto the loaded instance when provided", async () => {
    writeModelFile();
    healthOkFetch();
    const app = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/models/activate",
      payload: { path: MODEL_PATH, ctx: 32768, kvCache: "q8_0", nCpuMoe: 48 },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: "ready" });

    // Activate is the sole-model compat wrapper over the multi-instance load —
    // the plan flags ride onto the single v2 instance (the supervisor turns
    // kvCache → --cache-type-k/v and nCpuMoe → --n-cpu-moe).
    const cfg = readInferenceConfig();
    expect(cfg.v).toBe(2);
    expect(cfg.instances).toHaveLength(1);
    const inst = cfg.instances[0]!;
    expect(inst["modelPath"]).toBe(MODEL_PATH);
    expect(inst["ctx"]).toBe(32768);
    expect(inst["kvCache"]).toBe("q8_0");
    expect(inst["nCpuMoe"]).toBe(48);
    expect(inst["port"]).toBe(8080);
  });

  it("omits the plan fields entirely when absent (today's behavior)", async () => {
    writeModelFile();
    healthOkFetch();
    const app = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/models/activate",
      payload: { path: MODEL_PATH },
    });
    expect(res.statusCode).toBe(200);

    const cfg = readInferenceConfig();
    const inst = cfg.instances[0]!;
    expect(inst["modelPath"]).toBe(MODEL_PATH);
    expect("kvCache" in inst).toBe(false);
    expect("nCpuMoe" in inst).toBe(false);
  });
});

describe("activate — input validation", () => {
  it("rejects an invalid kvCache value", async () => {
    healthOkFetch();
    const app = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/models/activate",
      payload: { path: MODEL_PATH, kvCache: "q4_0" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects nCpuMoe below 1, above 999, or non-integer", async () => {
    healthOkFetch();
    const app = makeApp();
    for (const nCpuMoe of [0, 1000, 12.5]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/models/activate",
        payload: { path: MODEL_PATH, nCpuMoe },
      });
      expect(res.statusCode).toBe(400);
    }
  });
});
