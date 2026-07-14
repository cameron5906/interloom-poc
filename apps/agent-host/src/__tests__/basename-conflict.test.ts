/**
 * Tests for the `/api/models/load` basename-collision guard (CONTRACTS §6):
 * every routing key downstream of load (findInstanceByFilename, loadedFilenames,
 * agent<->model binding) keys on FILENAME, not full path, so two loaded models
 * may never share a basename. A path whose filename matches an already-loaded
 * instance at a DIFFERENT path -> 409 {error:"filename_conflict"}. Loading the
 * SAME path again (an update-in-place) is unaffected.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

let tmpModelsDir: string;
let tmpDataDir: string;

beforeEach(() => {
  tmpModelsDir = fs.mkdtempSync(path.join(os.tmpdir(), "il-models-"));
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "il-data-"));
  vi.resetModules();
  vi.doMock("../config.js", () => ({
    PORT: 7420,
    DATA_DIR: tmpDataDir,
    MODELS_DIR: tmpModelsDir,
    NETWORK_URL: "http://localhost:9999",
    INFERENCE_URL: "http://inference:8080",
    FETCHER_URL: "http://localhost:7423",
  }));
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async (url: string) => {
      // Only pollInstanceHealth calls fetch in this test — always report ready.
      if (typeof url === "string" && url.includes("/health")) {
        return { ok: true, status: 200 };
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
});

afterEach(() => {
  fs.rmSync(tmpModelsDir, { recursive: true, force: true });
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
  vi.doUnmock("../config.js");
  vi.unstubAllGlobals();
});

async function buildApp(): Promise<FastifyInstance> {
  const { registerModelsRoutes } = await import("../models/routes.js");
  const app = Fastify({ logger: false });
  registerModelsRoutes(app, async () => ({ gpus: [], unifiedMemoryMB: 999_999 }));
  await app.ready();
  return app;
}

function writeFakeModel(subdir: string, filename: string): string {
  const dir = path.join(tmpModelsDir, subdir);
  fs.mkdirSync(dir, { recursive: true });
  const full = path.join(dir, filename);
  // Not a real GGUF header — buildContextOptions/computeInstanceFootprintBytes
  // fall back to the size-based heuristic gracefully (parseGgufMeta -> null).
  fs.writeFileSync(full, Buffer.alloc(1024, 1));
  return full;
}

describe("POST /api/models/load — basename-collision guard", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
  });

  it("loading a second path with the same basename as an already-loaded (different path) instance returns 409 filename_conflict", async () => {
    app = await buildApp();

    const pathA = writeFakeModel("repo-a", "model.gguf");
    const pathB = writeFakeModel("repo-b", "model.gguf"); // same basename, different dir

    const first = await app.inject({
      method: "POST",
      url: "/api/models/load",
      payload: { path: pathA },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: "/api/models/load",
      payload: { path: pathB },
    });
    expect(second.statusCode).toBe(409);
    expect(JSON.parse(second.body)).toEqual({ error: "filename_conflict" });

    // Registry still holds only the first instance — the conflicting load never wrote.
    const loaded = await app.inject({ method: "GET", url: "/api/models/loaded" });
    expect(JSON.parse(loaded.body)).toHaveLength(1);
  });

  it("re-loading the SAME path (update-in-place) is not a conflict with itself", async () => {
    app = await buildApp();
    const pathA = writeFakeModel("repo-a", "model.gguf");

    const first = await app.inject({
      method: "POST",
      url: "/api/models/load",
      payload: { path: pathA },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: "/api/models/load",
      payload: { path: pathA, ctx: 8192 },
    });
    expect(second.statusCode).toBe(200);

    const loaded = await app.inject({ method: "GET", url: "/api/models/loaded" });
    const rows = JSON.parse(loaded.body) as Array<{ ctx: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ctx).toBe(8192);
  });

  it("different basenames never conflict", async () => {
    app = await buildApp();
    const pathA = writeFakeModel("repo-a", "alpha.gguf");
    const pathB = writeFakeModel("repo-b", "beta.gguf");

    const first = await app.inject({ method: "POST", url: "/api/models/load", payload: { path: pathA } });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({ method: "POST", url: "/api/models/load", payload: { path: pathB } });
    expect(second.statusCode).toBe(200);

    const loaded = await app.inject({ method: "GET", url: "/api/models/loaded" });
    expect(JSON.parse(loaded.body)).toHaveLength(2);
  });
});

describe("findBasenameConflict (pure)", () => {
  it("flags a same-basename different-path instance, exempts the same path", async () => {
    vi.resetModules();
    vi.doMock("../config.js", () => ({
      PORT: 7420,
      DATA_DIR: tmpDataDir,
      MODELS_DIR: tmpModelsDir,
      NETWORK_URL: "http://localhost:9999",
      INFERENCE_URL: "http://inference:8080",
      FETCHER_URL: "http://localhost:7423",
    }));
    const { findBasenameConflict } = await import("../models/loaded.js");
    const instances = [
      { id: "a", modelPath: "/models/repo-a/model.gguf", ctx: 4096, port: 8080, gpus: [] },
    ];
    expect(findBasenameConflict("/models/repo-b/model.gguf", instances)?.id).toBe("a");
    expect(findBasenameConflict("/models/repo-a/model.gguf", instances)).toBeUndefined();
    expect(findBasenameConflict("/models/repo-a/other.gguf", instances)).toBeUndefined();
  });
});
