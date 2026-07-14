/**
 * `POST /api/models/activate` inference.json field writes + input validation
 * (CONTRACTS §6 activate params, §7 inference.json additive fields).
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import Fastify from "fastify";
import type { GpuInfo } from "@interloom/protocol";

const { TMP } = vi.hoisted(() => {
  const base = process.env["TMPDIR"] ?? process.env["TEMP"] ?? process.env["TMP"] ?? ".";
  return { TMP: `${base}/il-activate-${Date.now()}-${Math.random().toString(36).slice(2)}` };
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

function readInferenceConfig(): Record<string, unknown> {
  const p = path.join(MODELS_DIR, ".interloom", "inference.json");
  return JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
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
  it("writes cacheTypeK/cacheTypeV (both = kvCache) and nCpuMoe when provided", async () => {
    healthOkFetch();
    const app = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/models/activate",
      payload: { path: MODEL_PATH, ctx: 32768, kvCache: "q8_0", nCpuMoe: 48 },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: "ready" });

    const cfg = readInferenceConfig();
    expect(cfg["cacheTypeK"]).toBe("q8_0");
    expect(cfg["cacheTypeV"]).toBe("q8_0");
    expect(cfg["nCpuMoe"]).toBe(48);
    expect(cfg["ctx"]).toBe(32768);
  });

  it("omits the new fields entirely when absent (today's behavior)", async () => {
    healthOkFetch();
    const app = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/models/activate",
      payload: { path: MODEL_PATH },
    });
    expect(res.statusCode).toBe(200);

    const cfg = readInferenceConfig();
    expect(cfg["modelPath"]).toBe(MODEL_PATH);
    expect("cacheTypeK" in cfg).toBe(false);
    expect("cacheTypeV" in cfg).toBe(false);
    expect("nCpuMoe" in cfg).toBe(false);
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
