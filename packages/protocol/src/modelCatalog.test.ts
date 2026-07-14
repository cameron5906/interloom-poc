import { describe, expect, it } from "vitest";
import { CatalogModel, catalogGgufRepoIds, ModelCatalog, ModelRegistryDoc } from "./modelCatalog.js";

function makeModel(overrides: Record<string, unknown> = {}) {
  return {
    id: "test-model-4b",
    name: "Test Model 4B",
    family: "Test Family",
    publisher: "Test Publisher",
    release_date: "2026-01-01",
    architecture: {
      type: "dense",
      parameters_total_b: 4.0,
      parameters_active_b: 4.0,
      modalities: ["text"],
      notes: "A dense text model.",
    },
    categories: ["tiny", "general"],
    characterization: "A small general-purpose model.",
    capabilities: {
      structured_output: { level: "native", notes: "Good JSON." },
      tool_use: { level: "native", notes: "Native tool calling.", formats: ["json"] },
      thinking: { level: "none", notes: "No reasoning mode." },
      vision: { level: "none", notes: "Text only." },
      audio: { level: "none", notes: "Text only." },
    },
    context_window: {
      default_or_advertised_tokens: 32768,
      native_trained_tokens: 32768,
      extended_max_tokens: null,
      max_output_tokens: null,
      extension_method: null,
      recommended_local_start_tokens: 8192,
      full_window_local_feasibility: "practical",
      notes: "Fits comfortably.",
      confidence: "high",
    },
    hardware: {
      estimated_q4_weight_size_gb: [2.5, 3.2],
      recommended_system_ram_gb: 8,
      recommended_vram_gb_full_offload: 6,
      cpu_viability: "excellent",
      enthusiast_hardware_tier: "entry",
      notes: "Runs on a modern CPU.",
      estimate_basis: "Editorial estimate.",
    },
    links: {
      base_model: "https://huggingface.co/test-org/test-model-4b",
      gguf: [
        {
          url: "https://huggingface.co/test-quantizer/test-model-4b-GGUF",
          publisher: "Test Quantizer",
          status: "community_verified",
        },
      ],
    },
    sources: [
      {
        url: "https://huggingface.co/test-org/test-model-4b",
        supports: ["context", "tool_use"],
      },
    ],
    ...overrides,
  };
}

function makeCatalog(models: unknown[] = [makeModel()]) {
  return {
    schema_version: "2.0.0",
    catalog_name: "Test Atlas",
    generated_at: "2026-07-13",
    scope: {
      inclusion_rules: ["Hosted on Hugging Face."],
      exclusions: ["Obsolete generations."],
    },
    context_methodology: {
      important_rule: "Hardware does not change the trained ceiling.",
      fields: {
        default_or_advertised_tokens: "The primary context value.",
      },
      deployment_factors: ["Weight quantization changes memory, not the limit."],
    },
    models,
  };
}

function makeTaxonomy() {
  return {
    version: "2.0.0",
    generated_at: "2026-07-13",
    capability_levels: { native: "Explicitly supported." },
    gguf_status: { official: "Published by the original organization." },
    hardware_tiers: { entry: "CPU or 4-8GB VRAM." },
    context_interpretation: { model_limit: "Maximum tokens advertised." },
  };
}

describe("CatalogModel", () => {
  it("parses a valid model entry", () => {
    const result = CatalogModel.safeParse(makeModel());
    expect(result.success).toBe(true);
  });

  it("rejects a model missing a required capability category", () => {
    const model = makeModel();
    const capabilities = model.capabilities as Record<string, unknown>;
    delete capabilities["audio"];
    const result = CatalogModel.safeParse(model);
    expect(result.success).toBe(false);
  });

  it("rejects a model with a non-numeric parameter count", () => {
    const model = makeModel({
      architecture: { ...makeModel().architecture, parameters_active_b: "four" },
    });
    expect(CatalogModel.safeParse(model).success).toBe(false);
  });

  it("accepts a null parameters_total_b (effective-class publishers like Gemma E4B)", () => {
    const model = makeModel({
      architecture: { ...makeModel().architecture, parameters_total_b: null },
    });
    expect(CatalogModel.safeParse(model).success).toBe(true);
  });

  it("passes through unknown top-level fields the exporter may add later", () => {
    const model = makeModel({ future_field: { anything: true } });
    const result = CatalogModel.safeParse(model);
    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>)["future_field"]).toEqual({ anything: true });
  });

  it("passes through an unknown capability level string instead of rejecting it", () => {
    const model = makeModel();
    (model.capabilities as Record<string, unknown>)["tool_use"] = {
      level: "some_future_level_the_atlas_hasnt_told_us_about",
      notes: "still parses",
    };
    expect(CatalogModel.safeParse(model).success).toBe(true);
  });
});

describe("ModelCatalog + ModelRegistryDoc", () => {
  it("parses a two-model catalog", () => {
    const catalog = makeCatalog([makeModel(), makeModel({ id: "test-model-9b", name: "Test Model 9B" })]);
    const result = ModelCatalog.safeParse(catalog);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.models).toHaveLength(2);
  });

  it("rejects a truncated catalog missing the models array", () => {
    const catalog = makeCatalog();
    delete (catalog as Record<string, unknown>)["models"];
    expect(ModelCatalog.safeParse(catalog).success).toBe(false);
  });

  it("parses the full registry document (v: 1, taxonomy, catalog)", () => {
    const doc = {
      v: 1 as const,
      taxonomy: makeTaxonomy(),
      catalog: makeCatalog(),
    };
    const result = ModelRegistryDoc.safeParse(doc);
    expect(result.success).toBe(true);
  });

  it("rejects a version other than the pinned literal 1", () => {
    const doc = { v: 2, taxonomy: makeTaxonomy(), catalog: makeCatalog() };
    expect(ModelRegistryDoc.safeParse(doc).success).toBe(false);
  });
});

describe("catalogGgufRepoIds", () => {
  it("parses a plain org/repo Hugging Face URL", () => {
    const model = makeModel();
    expect(catalogGgufRepoIds(model as CatalogModel)).toEqual(["test-quantizer/test-model-4b-GGUF"]);
  });

  it("tolerates a trailing slash", () => {
    const model = makeModel({
      links: {
        base_model: "https://huggingface.co/test-org/test-model-4b",
        gguf: [{ url: "https://huggingface.co/test-quantizer/test-model-4b-GGUF/", publisher: "x", status: "official" }],
      },
    });
    expect(catalogGgufRepoIds(model as CatalogModel)).toEqual(["test-quantizer/test-model-4b-GGUF"]);
  });

  it("skips a discovery search URL that has no single canonical repo", () => {
    const model = makeModel({
      links: {
        base_model: "https://huggingface.co/test-org/test-model-4b",
        gguf: [
          {
            url: "https://huggingface.co/models?search=test-model-4b-GGUF",
            publisher: "Hugging Face search",
            status: "discovery",
          },
        ],
      },
    });
    expect(catalogGgufRepoIds(model as CatalogModel)).toEqual([]);
  });

  it("skips a collections URL (three path segments, not a repo)", () => {
    const model = makeModel({
      links: {
        base_model: "https://huggingface.co/test-org/test-model-4b",
        gguf: [
          {
            url: "https://huggingface.co/collections/test-quantizer/test-collection",
            publisher: "Test Quantizer",
            status: "community",
          },
        ],
      },
    });
    expect(catalogGgufRepoIds(model as CatalogModel)).toEqual([]);
  });

  it("returns multiple repoIds when a model has several gguf links", () => {
    const model = makeModel({
      links: {
        base_model: "https://huggingface.co/test-org/test-model-4b",
        gguf: [
          { url: "https://huggingface.co/test-org/test-model-4b-GGUF", publisher: "a", status: "official" },
          { url: "https://huggingface.co/test-quantizer/test-model-4b-GGUF", publisher: "b", status: "community_verified" },
        ],
      },
    });
    expect(catalogGgufRepoIds(model as CatalogModel)).toEqual([
      "test-org/test-model-4b-GGUF",
      "test-quantizer/test-model-4b-GGUF",
    ]);
  });
});
