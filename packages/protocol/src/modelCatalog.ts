import { z } from "zod";

/**
 * Curated model catalog (CONTRACTS §4 "Curated model catalog"). This mirrors the
 * Local LLM Atlas v2 export format VERBATIM — snake_case field names preserved —
 * because the registry file format IS the exporter's output format; there is no
 * transform layer to drift out of sync. `apps/network` serves the vendored files
 * through these schemas at `GET /registry/models`; `apps/agent-host` and
 * `apps/instance` proxy/consume the same shape downstream.
 *
 * Validation posture: strict enough to catch a corrupt or truncated export
 * (missing/mistyped required fields fail to parse), tolerant of additive
 * exporter evolution (unknown object keys pass through via `.passthrough()`,
 * and fields the atlas is likely to grow new values for — capability `level`,
 * `full_window_local_feasibility`, `cpu_viability`, `enthusiast_hardware_tier`,
 * category strings, gguf `status` — are typed `z.string()` rather than a closed
 * enum). Known values for the ones with a documented vocabulary are still
 * exported as `KNOWN_*` const arrays below so consumers can special-case them
 * without the schema rejecting a value the atlas hasn't been told about yet.
 */

/** Documented `links.gguf[].status` values (taxonomy.json `gguf_status`). Not
 * enforced as an enum — a future exporter value should still parse — but
 * consumers wanting a closed switch can check membership against this list. */
export const KNOWN_GGUF_STATUSES = [
  "official",
  "community_verified",
  "community",
  "discovery",
] as const;

const CatalogCapabilityDetail = z
  .object({
    /** e.g. "native", "native_toggleable", "prompted", "none" — open string,
     * see taxonomy.json `capability_levels` for the documented vocabulary. */
    level: z.string(),
    notes: z.string(),
    formats: z.array(z.string()).optional(),
  })
  .passthrough();
export type CatalogCapabilityDetail = z.infer<typeof CatalogCapabilityDetail>;

/** The five capability categories every model in the atlas reports on today.
 * Keyed object (not a record) so a truncated/corrupt export that drops one of
 * these fails validation; `.passthrough()` still admits a future sixth
 * category without rejecting the whole document. */
const CatalogCapabilities = z
  .object({
    structured_output: CatalogCapabilityDetail,
    tool_use: CatalogCapabilityDetail,
    thinking: CatalogCapabilityDetail,
    vision: CatalogCapabilityDetail,
    audio: CatalogCapabilityDetail,
  })
  .passthrough();
export type CatalogCapabilities = z.infer<typeof CatalogCapabilities>;

const CatalogArchitecture = z
  .object({
    type: z.string(),
    /** Total stored parameters; null when the publisher only labels an
     * effective/active class (e.g. Gemma's "E4B" naming). */
    parameters_total_b: z.number().nullable(),
    parameters_active_b: z.number(),
    modalities: z.array(z.string()),
    notes: z.string(),
  })
  .passthrough();
export type CatalogArchitecture = z.infer<typeof CatalogArchitecture>;

const CatalogContextWindow = z
  .object({
    default_or_advertised_tokens: z.number(),
    native_trained_tokens: z.number().nullable(),
    extended_max_tokens: z.number().nullable(),
    max_output_tokens: z.number().nullable(),
    extension_method: z.string().nullable(),
    recommended_local_start_tokens: z.number(),
    /** Editorial feasibility label, e.g. "possible_but_unusual" — open string,
     * new labels are expected as more models are catalogued. */
    full_window_local_feasibility: z.string(),
    notes: z.string(),
    confidence: z.string(),
  })
  .passthrough();
export type CatalogContextWindow = z.infer<typeof CatalogContextWindow>;

const CatalogHardware = z
  .object({
    /** [low, high] GB range for a Q4 GGUF of this model. Left as a plain
     * number array rather than a 2-tuple — the exporter owns the cardinality,
     * this schema just needs numbers. */
    estimated_q4_weight_size_gb: z.array(z.number()),
    recommended_system_ram_gb: z.number(),
    recommended_vram_gb_full_offload: z.number(),
    cpu_viability: z.string(),
    enthusiast_hardware_tier: z.string(),
    notes: z.string(),
    estimate_basis: z.string(),
  })
  .passthrough();
export type CatalogHardware = z.infer<typeof CatalogHardware>;

const CatalogGgufLink = z
  .object({
    url: z.string(),
    publisher: z.string(),
    status: z.string(),
  })
  .passthrough();
export type CatalogGgufLink = z.infer<typeof CatalogGgufLink>;

const CatalogLinks = z
  .object({
    base_model: z.string(),
    gguf: z.array(CatalogGgufLink),
  })
  .passthrough();
export type CatalogLinks = z.infer<typeof CatalogLinks>;

const CatalogSource = z
  .object({
    url: z.string(),
    supports: z.array(z.string()),
  })
  .passthrough();
export type CatalogSource = z.infer<typeof CatalogSource>;

/** A single curated model entry (Local LLM Atlas v2 `models[]`). */
export const CatalogModel = z
  .object({
    id: z.string(),
    name: z.string(),
    family: z.string(),
    publisher: z.string(),
    release_date: z.string().nullable(),
    architecture: CatalogArchitecture,
    /** Open use-case/tier tags (e.g. "tiny", "coding", "cpu-offload") — the
     * atlas grows this vocabulary as new models are added. */
    categories: z.array(z.string()),
    characterization: z.string(),
    capabilities: CatalogCapabilities,
    context_window: CatalogContextWindow,
    hardware: CatalogHardware,
    links: CatalogLinks,
    sources: z.array(CatalogSource),
  })
  .passthrough();
export type CatalogModel = z.infer<typeof CatalogModel>;

/** The Local LLM Atlas v2 catalog document (`models.json`), verbatim. */
export const ModelCatalog = z
  .object({
    schema_version: z.string(),
    catalog_name: z.string(),
    generated_at: z.string(),
    scope: z
      .object({
        inclusion_rules: z.array(z.string()),
        exclusions: z.array(z.string()),
      })
      .passthrough(),
    context_methodology: z
      .object({
        important_rule: z.string(),
        /** Free-form field-name → explanation map; new methodology fields
         * are additive documentation, not structural. */
        fields: z.record(z.string(), z.string()),
        deployment_factors: z.array(z.string()),
      })
      .passthrough(),
    models: z.array(CatalogModel),
  })
  .passthrough();
export type ModelCatalog = z.infer<typeof ModelCatalog>;

/** The atlas's companion legend (`taxonomy.json`) — capability levels, gguf
 * status, hardware tiers, and context-field interpretation, all documented as
 * free-form key → explanation maps so new taxonomy entries need no schema
 * change. */
export const CatalogTaxonomy = z
  .object({
    version: z.string(),
    generated_at: z.string(),
    capability_levels: z.record(z.string(), z.string()),
    gguf_status: z.record(z.string(), z.string()),
    hardware_tiers: z.record(z.string(), z.string()),
    context_interpretation: z.record(z.string(), z.string()),
  })
  .passthrough();
export type CatalogTaxonomy = z.infer<typeof CatalogTaxonomy>;

/** `GET /registry/models` response shape (CONTRACTS §4). */
export const ModelRegistryDoc = z.object({
  v: z.literal(1),
  taxonomy: CatalogTaxonomy,
  catalog: ModelCatalog,
});
export type ModelRegistryDoc = z.infer<typeof ModelRegistryDoc>;

const HF_REPO_URL = /^https?:\/\/huggingface\.co\/([^/?]+)\/([^/?]+)\/?$/;

/**
 * Parses a catalog model's `links.gguf[].url` entries into "org/repo" ids —
 * the join key against `ModelRef.repoId`. Consumers compare case-insensitively.
 * URLs that aren't a plain two-segment Hugging Face repo path (search links,
 * collections, etc. — used for `status: "discovery"` entries that have no
 * single canonical repo) are skipped rather than guessed at.
 */
export function catalogGgufRepoIds(model: Pick<CatalogModel, "links">): string[] {
  const repoIds: string[] = [];
  for (const link of model.links.gguf) {
    const match = HF_REPO_URL.exec(link.url.trim());
    if (match && match[1] && match[2]) {
      repoIds.push(`${match[1]}/${match[2]}`);
    }
  }
  return repoIds;
}
