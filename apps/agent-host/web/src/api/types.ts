/**
 * Response shapes for the Agent Host daemon API (CONTRACTS §6) that are not
 * already exported by `@interloom/protocol`. Payload types that ARE in the
 * protocol package (SystemInfo, DownloadJob, LocalModel, HostAgent,
 * TelemetryFrame, PlacementStatus, …) are imported directly from it. The
 * curated model registry (§4/§6) is the Local LLM Atlas v2 document served
 * verbatim (snake_case preserved); its shapes are declared here as the portal
 * convention (the daemon defines them independently against the same contract).
 */

/** `GET /api/keys` — the host keypair public half. */
export interface HostKeys {
  pubKey: string;
  createdAt: string;
}

/** The bound operator identity (CONTRACTS §6 "Operator binding"). */
export interface OperatorIdentity {
  identityKey: string;
  displayName: string;
  avatarSha?: string;
  /** Convenience field the daemon resolves once at bind time — not part of
   * the pinned wire shape, safe to ignore if absent. */
  avatarUrl?: string;
  boundAt: string;
}

/** `GET /api/operator` — whether this host is bound to a network identity.
 * `staleGrant` (bound only) means the network revoked this identity's grants
 * since binding (a revoke-all bumped its session_epoch) — re-registers now
 * 403 until the operator reconnects. */
export type OperatorState =
  | { bound: false }
  | { bound: true; operator: OperatorIdentity; staleGrant?: boolean };

/** `POST /api/operator/link/start` — everything the portal needs to open `/authorize`. */
export interface OperatorLinkStart {
  networkUrl: string;
  hostPubKey: string;
  nonce: string;
}

// --- Curated model registry (CONTRACTS §4/§6, Local LLM Atlas v2 verbatim) ---

/**
 * One capability entry on a catalog model. `level` is one of the taxonomy's
 * `capability_levels` keys, but the schema is tolerant of new levels (the
 * atlas may grow) so it is typed as a plain string.
 */
export interface CatalogCapability {
  level: string;
  notes?: string;
  formats?: string[];
}

/** The five capabilities every catalog model carries (any may be `level:"none"`). */
export interface CatalogCapabilities {
  structured_output?: CatalogCapability;
  tool_use?: CatalogCapability;
  thinking?: CatalogCapability;
  vision?: CatalogCapability;
  audio?: CatalogCapability;
}

export interface CatalogArchitecture {
  type: string;
  parameters_total_b: number | null;
  parameters_active_b: number;
  modalities: string[];
  notes?: string;
}

export interface CatalogContextWindow {
  default_or_advertised_tokens: number;
  native_trained_tokens?: number | null;
  extended_max_tokens?: number | null;
  max_output_tokens?: number | null;
  extension_method?: string | null;
  recommended_local_start_tokens: number;
  full_window_local_feasibility?: string;
  notes?: string;
  confidence?: string;
}

export interface CatalogHardware {
  estimated_q4_weight_size_gb: [number, number];
  recommended_system_ram_gb: number;
  recommended_vram_gb_full_offload: number;
  cpu_viability: string;
  enthusiast_hardware_tier: string;
  notes?: string;
  estimate_basis?: string;
}

/** A GGUF repository link with its trust status (taxonomy `gguf_status`). */
export interface CatalogGgufLink {
  url: string;
  publisher?: string;
  status: string;
}

export interface CatalogSource {
  url: string;
  supports: string[];
}

export interface CatalogModel {
  id: string;
  name: string;
  family?: string;
  publisher: string;
  release_date?: string | null;
  architecture: CatalogArchitecture;
  categories: string[];
  characterization: string;
  capabilities: CatalogCapabilities;
  context_window: CatalogContextWindow;
  hardware: CatalogHardware;
  links: { base_model?: string; gguf: CatalogGgufLink[] };
  sources?: CatalogSource[];
}

/** The catalog document (`models.json`), served verbatim. */
export interface ModelCatalog {
  schema_version?: string;
  catalog_name?: string;
  generated_at?: string;
  scope?: unknown;
  context_methodology?: {
    important_rule?: string;
    fields?: Record<string, string>;
    deployment_factors?: string[];
  };
  models: CatalogModel[];
}

/** The companion legend (`taxonomy.json`). */
export interface CatalogTaxonomy {
  version?: string;
  generated_at?: string;
  capability_levels: Record<string, string>;
  gguf_status: Record<string, string>;
  hardware_tiers: Record<string, string>;
  context_interpretation: Record<string, string>;
}

/** `ModelRegistryDoc = { v, taxonomy, catalog }` (CONTRACTS §6). */
export interface ModelRegistryDoc {
  v: number;
  taxonomy: CatalogTaxonomy;
  catalog: ModelCatalog;
}

/** Daemon-computed hardware fit for one catalog model (CONTRACTS §6). */
export interface RegistryFit {
  verdict: "fast" | "spill" | "cpu" | "no";
  note: string;
}

/** `GET /api/models/registry` (CONTRACTS §6). 503 → registry unavailable. */
export interface ModelRegistryResponse {
  source: "network" | "cache";
  fetchedAt: string;
  doc: ModelRegistryDoc;
  fit: Record<string, RegistryFit>;
}

/** `GET /api/models/search?q=` — rail row (CONTRACTS §6). Capabilities are estimates. */
export interface HfSearchResult {
  repoId: string;
  likes: number;
  downloads: number;
  paramsB?: number;
  trainedCtx?: number;
  capabilities?: import("@interloom/protocol").ModelCapabilities;
}

/** One GGUF file in `GET /api/models/hf-detail` (mmproj excluded — paired separately). */
export interface HfDetailFile {
  filename: string;
  sizeBytes: number;
  quant: string;
  /** Largest ctx that fits this host at `fast` tier — same math as activation. */
  maxFastCtx?: number;
}

/** `GET /api/models/hf-detail?repoId=` (CONTRACTS §6). Capabilities are estimates. */
export interface HfRepoDetail {
  repoId: string;
  likes: number;
  downloads: number;
  trainedCtx?: number;
  lastModified?: string;
  capabilities?: import("@interloom/protocol").ModelCapabilities;
  mmprojFilename?: string;
  files: HfDetailFile[];
}

/** Activation intent sent to `POST /api/models/activate` (CONTRACTS §6). */
export interface ActivateOptions {
  ctx?: number;
  kvCache?: "f16" | "q8_0";
  nCpuMoe?: number;
}

/** `POST /api/models/activate` — activation poll result (CONTRACTS §6). */
export interface ActivateResult {
  status: "ready" | "loading" | "error";
  error?: string;
}

/** `GET /api/models/active` — currently loaded model or null (CONTRACTS §6). */
export interface ActiveModel {
  path: string;
  filename: string;
  /** Context window the model was loaded with (added by daemon post-R2b). */
  ctx?: number;
  /** Absolute path of the paired mmproj (vision projector), when loaded. */
  mmprojPath?: string;
}

/** One candidate context-size entry from `GET /api/models/context-options`. */
export interface ContextOption {
  ctx: number;
  kvBytes: number;
  fit: "fast" | "spill" | "no";
}

/**
 * One activation plan on a context rung (CONTRACTS §6 "Context plans"). The
 * daemon emits, per ctx rung, the best-fitting plan plus the honest fallback
 * that unlocks it. `nCpuMoe` is present only on `experts_cpu` plans and only
 * when the daemon computes it — when absent, the offload intent rides on
 * `ctx` + `kvCache` alone.
 */
export interface ContextPlan {
  ctx: number;
  kvCache: "f16" | "q8_0";
  offload: "full_gpu" | "experts_cpu" | "cpu";
  kvBytes: number;
  vramNeedMB: number;
  ramNeedMB: number;
  fit: "fast" | "spill" | "no";
  label: string;
  nCpuMoe?: number;
}

/**
 * `GET /api/models/context-options?path=` — CONTRACTS §6 "Context sizing".
 * `exact:false` means the daemon couldn't parse GGUF metadata and used
 * heuristics; the UI must show an "estimated" note. `plans` + `recommendedPlan`
 * are additive (older daemons omit them — the UI falls back to `options`).
 */
export interface ContextOptions {
  trainedMax: number | null;
  options: ContextOption[];
  recommendedCtx: number;
  exact: boolean;
  plans?: ContextPlan[];
  recommendedPlan?: ContextPlan | null;
}

/** `GET /api/settings/hf` — HF account connection status (CONTRACTS §6). */
export interface HfSettings {
  connected: boolean;
  username?: string;
}

/** `POST /api/settings/hf-token` — HF token validation result (CONTRACTS §6). */
export interface HfTokenResult {
  username: string;
}

/** Local agent as returned by the daemon store (CONTRACTS §6). */
export interface AgentDraft {
  name: string;
  avatar: {
    emoji: string;
    bg: string;
    imageUrl?: string;
    character?: import("@interloom/protocol").AvatarCharacter;
  };
  persona: string;
  capabilityBlurb: string;
  title?: string;
  gender?: import("@interloom/protocol").AgentGender;
  specialties?: string[];
  params: { temperature: number; contextLength: number };
  model?: import("@interloom/protocol").ModelRef;
}

/** Shared empty-draft literal — both the "new agent" list row and the editor's
 * blank-agent form derive from this so they can't drift apart. `contextLength: 0`
 * means "inherit the loaded model's window" (CONTRACTS §6 — context is configured
 * at model activation, not per agent). */
export const EMPTY_AGENT_DRAFT: AgentDraft = {
  name: "",
  avatar: { emoji: "🤖", bg: "var(--il-agent-gradient)" },
  persona: "",
  capabilityBlurb: "",
  params: { temperature: 0.7, contextLength: 0 },
};

// --- Frontier agents (CONTRACTS §6/§14) ---

/** Body for `PUT /api/agents/:id/frontier`. Omitting `apiKey` leaves any
 * stored key untouched; `apiKey: ""` clears it. */
export interface FrontierConfigBody {
  provider: import("@interloom/protocol").FrontierProvider;
  model: string;
  apiKey?: string;
}

/** `PUT`/`GET /api/agents/:id/frontier` response — the raw key never rides
 * this shape, only whether one is stored and its last 4 characters. */
export interface MaskedFrontierConfig {
  provider: import("@interloom/protocol").FrontierProvider | null;
  model: string | null;
  hasKey: boolean;
  last4: string | null;
}

/** `POST /api/agents/:id/frontier/link` response (CONTRACTS §6/§14). `payload`
 * is the cleartext `FrontierLinkPayload` minus its `v`/`kind` wrapper fields —
 * the portal completes those before handing it to `@interloom/link-client` as
 * the issuer payload. `issuerAuth` rides the join frame's additive `auth`
 * field so the relay can authenticate this issuer without a browser identity
 * cookie (CONTRACTS §4/§14). */
export interface FrontierLinkSession {
  linkId: string;
  secret: string;
  url: string;
  wsUrl: string;
  payload: {
    agentId: string;
    agentName: string;
    agentPrivKey: string;
    agentPubKey: string;
    networkUrl: string;
    provider: import("@interloom/protocol").FrontierProvider;
    model: string;
    apiKey?: string;
  };
  issuerAuth: import("@interloom/keys").SignedEnvelope<
    import("@interloom/protocol").FrontierLinkIssuerAuth
  >;
}
