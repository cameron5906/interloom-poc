/**
 * Registry proxy cache behavior + endpoint (CONTRACTS §6 Models). Config is
 * mocked so DATA_DIR is a throwaway temp dir; fetch is stubbed per case.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import Fastify from "fastify";
import type { GpuInfo } from "@interloom/protocol";

const { TMP } = vi.hoisted(() => {
  const base = process.env["TMPDIR"] ?? process.env["TEMP"] ?? process.env["TMP"] ?? ".";
  return { TMP: `${base}/il-registry-${Date.now()}-${Math.random().toString(36).slice(2)}` };
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

import {
  refreshRegistry,
  getRegistry,
  loadRegistryCache,
  __resetRegistryForTest,
} from "../models/registry.js";
import { registerModelsRoutes } from "../models/routes.js";

function validDoc() {
  return {
    v: 1,
    taxonomy: {
      version: "2",
      generated_at: "2026-07-13T00:00:00Z",
      capability_levels: { native: "Built in." },
      gguf_status: { official: "Publisher release." },
      hardware_tiers: { entry: "Entry rigs." },
      context_interpretation: { advertised: "Marketed max." },
    },
    catalog: {
      schema_version: "2",
      catalog_name: "Test Atlas",
      generated_at: "2026-07-13T00:00:00Z",
      scope: { inclusion_rules: [], exclusions: [] },
      context_methodology: { important_rule: "Honest.", fields: {}, deployment_factors: [] },
      models: [
        {
          id: "test-4b",
          name: "Test 4B",
          family: "Test",
          publisher: "Test",
          release_date: "2026-01-01",
          architecture: {
            type: "dense",
            parameters_total_b: 4,
            parameters_active_b: 4,
            modalities: ["text"],
            notes: "",
          },
          categories: ["tiny"],
          characterization: "Small model.",
          capabilities: {
            structured_output: { level: "native", notes: "" },
            tool_use: { level: "native", notes: "" },
            thinking: { level: "none", notes: "" },
            vision: { level: "none", notes: "" },
            audio: { level: "none", notes: "" },
          },
          context_window: {
            default_or_advertised_tokens: 32768,
            native_trained_tokens: 32768,
            extended_max_tokens: null,
            max_output_tokens: null,
            extension_method: null,
            recommended_local_start_tokens: 8192,
            full_window_local_feasibility: "practical",
            notes: "",
            confidence: "high",
          },
          hardware: {
            estimated_q4_weight_size_gb: [2.5, 3.2],
            recommended_system_ram_gb: 8,
            recommended_vram_gb_full_offload: 6,
            cpu_viability: "excellent",
            enthusiast_hardware_tier: "entry",
            notes: "",
            estimate_basis: "",
          },
          links: {
            base_model: "https://huggingface.co/test/test-4b",
            gguf: [
              { url: "https://huggingface.co/test/test-4b-GGUF", publisher: "Test", status: "official" },
            ],
          },
          sources: [{ url: "https://huggingface.co/test/test-4b", supports: ["context"] }],
        },
      ],
    },
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const SYS = async (): Promise<{ gpus: GpuInfo[]; unifiedMemoryMB?: number }> => ({
  gpus: [{ name: "RTX 4090", vramMB: 24576, kind: "cuda" }],
});

beforeEach(() => {
  __resetRegistryForTest();
  fs.rmSync(TMP, { recursive: true, force: true });
});

afterAll(() => {
  vi.unstubAllGlobals();
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe("registry cache behavior", () => {
  it("fetch ok → served source is 'network' and the cache file is persisted", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, validDoc())));
    await refreshRegistry({ force: true });

    const served = getRegistry();
    expect(served?.source).toBe("network");
    expect(served?.doc.catalog.models[0]?.id).toBe("test-4b");
    expect(typeof served?.fetchedAt).toBe("string");
    expect(fs.existsSync(path.join(TMP, "registry-cache.json"))).toBe(true);
  });

  it("fetch fail after a cache exists → served source is 'cache'", async () => {
    // Prime the persisted cache with a good fetch.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, validDoc())));
    await refreshRegistry({ force: true });

    // New process: drop in-memory state, load only the persisted cache.
    __resetRegistryForTest();
    loadRegistryCache();
    expect(getRegistry()?.source).toBe("cache");

    // A failed refresh keeps the last-good cache and stays 'cache'.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    await refreshRegistry({ force: true });
    const served = getRegistry();
    expect(served?.source).toBe("cache");
    expect(served?.doc.catalog.models[0]?.id).toBe("test-4b");
  });

  it("never fetched, no cache → getRegistry is null and the endpoint 503s", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    __resetRegistryForTest();
    loadRegistryCache(); // no file present
    expect(getRegistry()).toBeNull();

    const app = Fastify();
    registerModelsRoutes(app, SYS);
    const res = await app.inject({ method: "GET", url: "/api/models/registry" });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toEqual({ error: "registry_unavailable" });
  });

  it("endpoint returns source, doc, and a fit map after a good fetch", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, validDoc())));
    await refreshRegistry({ force: true });

    const app = Fastify();
    registerModelsRoutes(app, SYS);
    const res = await app.inject({ method: "GET", url: "/api/models/registry" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.source).toBe("network");
    expect(body.doc.catalog.models[0].id).toBe("test-4b");
    expect(body.fit["test-4b"].verdict).toBe("fast");
    expect(typeof body.fit["test-4b"].note).toBe("string");
  });
});
