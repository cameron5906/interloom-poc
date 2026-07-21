import { z } from "zod";
import { Placement } from "./registry.js";
import { ModelRef, ModelCapabilities } from "./model.js";
import { AgentGender, AvatarCharacter } from "./avatar.js";
import { FrontierRuntimeConfig } from "./frontier.js";
import { BoundedId } from "./limits.js";

/** A detected GPU (CONTRACTS §6, `GET /api/system`). */
export const GpuInfo = z.object({
  name: z.string(),
  vramMB: z.number(),
  kind: z.enum(["cuda", "metal", "none"]),
  driver: z.string().optional(),
  /** `nvidia-smi` device ordinal — the same number used in placement `gpus: number[]` and `CUDA_VISIBLE_DEVICES`. */
  index: z.number().int().optional(),
});
export type GpuInfo = z.infer<typeof GpuInfo>;

/** Host system report (CONTRACTS §6, `GET /api/system`). */
export const SystemInfo = z.object({
  os: z.string(),
  arch: z.string(),
  dockerized: z.literal(true),
  gpus: z.array(GpuInfo),
  unifiedMemoryMB: z.number().optional(),
  /** Total system RAM in MB (os.totalmem) — the rig strip's RAM figure and the
   * denominator the host-side fit/spill math reads against (additive). */
  systemRamMB: z.number().optional(),
  version: z.string().optional(),
});
export type SystemInfo = z.infer<typeof SystemInfo>;

/** A model download job tracked by the model-fetcher (CONTRACTS §6/§7). */
export const DownloadJob = z.object({
  id: z.string(),
  repoId: z.string(),
  filename: z.string(),
  status: z.enum(["queued", "downloading", "done", "error"]),
  bytesDone: z.number(),
  bytesTotal: z.number(),
  speedBps: z.number(),
  error: z.string().optional(),
});
export type DownloadJob = z.infer<typeof DownloadJob>;

/** A local `.gguf` model discovered under MODELS_DIR (CONTRACTS §6). */
export const LocalModel = z.object({
  path: z.string(),
  filename: z.string(),
  sizeBytes: z.number(),
  capabilities: ModelCapabilities.optional(),
  /** Paired vision projector in the same directory, when present. */
  mmprojPath: z.string().optional(),
  mmprojBytes: z.number().optional(),
});
export type LocalModel = z.infer<typeof LocalModel>;

/** Local agent record stored in DATA_DIR/agents.json (CONTRACTS §6). */
export const HostAgent = z.object({
  agentId: z.string(),
  name: z.string(),
  avatar: z.object({
    emoji: z.string(),
    bg: z.string(),
    imageUrl: z.string().optional(),
    /** The DiceBear Notionists character behind the rendered avatar (CONTRACTS §12). */
    character: AvatarCharacter.optional(),
  }),
  persona: z.string(),
  capabilityBlurb: z.string(),
  params: z.object({
    temperature: z.number(),
    contextLength: z.number(),
  }),
  registered: z.boolean(),
  syncedAt: z.string().optional(),
  /** Drafts may omit it; preview and publish require it. */
  model: ModelRef.optional(),
  title: z.string().min(1).max(60).optional(),
  gender: AgentGender.optional(),
  specialties: z.array(z.string().min(1).max(32)).max(8).optional(),
  /** Local model vs. an external frontier CLI agent (CONTRACTS §14). Absent ⇒ hosted. */
  runtime: z.enum(["hosted", "frontier"]).optional(),
  frontier: FrontierRuntimeConfig.optional(),
});
export type HostAgent = z.infer<typeof HostAgent>;

// --- Telemetry WS frame (§6) ---

export const TelemetryGpu = z.object({
  name: z.string().max(256),
  utilPct: z.number(),
  vramUsedMB: z.number(),
  vramTotalMB: z.number(),
});
export type TelemetryGpu = z.infer<typeof TelemetryGpu>;

export const TelemetryRequestLogEntry = z.object({
  ts: z.number(),
  source: z.string().max(256),
  agentName: z.string().max(256),
  promptTokens: z.number(),
  completionTokens: z.number(),
  tokensPerSec: z.number(),
});
export type TelemetryRequestLogEntry = z.infer<typeof TelemetryRequestLogEntry>;

export const TelemetryTunnel = z.object({
  instanceName: z.string().max(256),
  instanceUrl: z.string().max(2048),
  agentName: z.string().max(256),
  status: z.enum(["connected", "connecting", "down"]),
});
export type TelemetryTunnel = z.infer<typeof TelemetryTunnel>;

export const TelemetryAgent = z.object({
  agentId: BoundedId,
  name: z.string().max(256),
  /** "serving" while this agent's request is in flight; "idle" when active-model-attached; "offline" when its model isn't loaded. */
  status: z.enum(["idle", "serving", "offline"]),
  registered: z.boolean(),
  syncedAt: z.string().optional(),
});
export type TelemetryAgent = z.infer<typeof TelemetryAgent>;

/** 1 Hz host telemetry frame (CONTRACTS §6). */
export const TelemetryFrame = z.object({
  ts: z.number(),
  gpus: z.array(TelemetryGpu).max(32),
  tokensPerSec: z.number(),
  requestLog: z.array(TelemetryRequestLogEntry).max(100),
  tunnels: z.array(TelemetryTunnel).max(256),
  agents: z.array(TelemetryAgent).max(256),
  inference: z
    .object({
      activeModel: ModelRef.nullable(),
      queueDepth: z.number(),
      /** Additive: one entry per loaded instance (multi-instance model loading, CONTRACTS §6). */
      models: z
        .array(
          z.object({
            filename: z.string(),
            port: z.number(),
            ctx: z.number(),
            queueDepth: z.number(),
            gpus: z.array(z.number()),
          }),
        )
        .max(64)
        .optional(),
    })
    .optional(),
});
export type TelemetryFrame = z.infer<typeof TelemetryFrame>;

/** One selectable context size for a model on this hardware (CONTRACTS §6). */
export const ContextOption = z.object({
  ctx: z.number(),
  kvBytes: z.number(),
  fit: z.enum(["fast", "spill", "no"]),
});
export type ContextOption = z.infer<typeof ContextOption>;

/**
 * One rig-optimizer plan for a context rung (CONTRACTS §6 "Context plans").
 * A plan couples a context length with a KV-cache precision and an offload
 * strategy; the daemon emits the best-fitting plan per rung plus the honest
 * fallback that unlocks it. `nCpuMoe` is present exactly on `experts_cpu`
 * plans (the expert-layer count the portal passes through to activate).
 */
export const ContextPlan = z.object({
  ctx: z.number(),
  kvCache: z.enum(["f16", "q8_0"]),
  offload: z.enum(["full_gpu", "experts_cpu", "cpu"]),
  kvBytes: z.number(),
  vramNeedMB: z.number(),
  ramNeedMB: z.number(),
  fit: z.enum(["fast", "spill", "no"]),
  label: z.string(),
  nCpuMoe: z.number().optional(),
});
export type ContextPlan = z.infer<typeof ContextPlan>;

/** `GET /api/models/context-options` — KV-cache-based context sizing (CONTRACTS §6). */
export const ContextOptions = z.object({
  trainedMax: z.number().nullable(),
  options: z.array(ContextOption),
  recommendedCtx: z.number(),
  /** Whether GGUF metadata parsing succeeded; false = size-heuristic estimates. */
  exact: z.boolean(),
  /** Rig-optimizer plans (additive, 2026-07-13). Absent on legacy responses. */
  plans: z.array(ContextPlan).optional(),
  /** Highest-ctx `fast` plan (else highest-ctx `spill`); null when none fits. */
  recommendedPlan: ContextPlan.nullable().optional(),
});
export type ContextOptions = z.infer<typeof ContextOptions>;

// --- Multi-instance model loading (CONTRACTS §6) ---

/** A concurrently loaded model instance — one `llama-server` process on its own port. */
export const LoadedModel = z.object({
  path: z.string(),
  filename: z.string(),
  model: ModelRef.optional(),
  ctx: z.number(),
  port: z.number(),
  gpus: z.array(z.number()),
  tensorSplit: z.array(z.number()).optional(),
  fit: z.enum(["fast", "spill"]),
  reasoningBudget: z.number().nullable().optional(),
  mmprojPath: z.string().nullable().optional(),
  /** KV-cache precision this instance was loaded with (rig-optimizer plan, CONTRACTS §6). Absent = f16 default. */
  kvCache: z.enum(["f16", "q8_0"]).optional(),
  /** Expert layers parked in system RAM (`--n-cpu-moe`, MoE offload plan, CONTRACTS §6). */
  nCpuMoe: z.number().optional(),
  health: z.enum(["ready", "loading", "down"]),
});
export type LoadedModel = z.infer<typeof LoadedModel>;

/** Per-GPU VRAM budget as tracked by the allocation planner (CONTRACTS §6). */
export const GpuBudget = z.object({
  index: z.number(),
  name: z.string(),
  vramTotalMB: z.number(),
  vramCommittedMB: z.number(),
  vramFreeMB: z.number(),
});
export type GpuBudget = z.infer<typeof GpuBudget>;

/** `GET /api/models/allocation` — server-truthed planner surface (CONTRACTS §6). */
export const AllocationView = z.object({
  gpus: z.array(GpuBudget),
  loaded: z.array(LoadedModel),
  maxConcurrentAgents: z.number(),
});
export type AllocationView = z.infer<typeof AllocationView>;

/** `POST /api/models/load` body (CONTRACTS §6). */
export const LoadModelBody = z.object({
  path: z.string(),
  ctx: z.number().optional(),
  placement: z
    .object({
      gpus: z.array(z.number()),
      tensorSplit: z.array(z.number()).optional(),
    })
    .optional(),
  confirmSpill: z.boolean().optional(),
  /** Rig-optimizer plan: KV-cache precision (`--cache-type-k/v`, CONTRACTS §6/§7). */
  kvCache: z.enum(["f16", "q8_0"]).optional(),
  /** Rig-optimizer plan: expert layers to keep in system RAM (`--n-cpu-moe`, CONTRACTS §6/§7). */
  nCpuMoe: z.number().int().positive().max(999).optional(),
});
export type LoadModelBody = z.infer<typeof LoadModelBody>;

/** `POST /api/models/unload` body (CONTRACTS §6). */
export const UnloadModelBody = z.object({
  path: z.string(),
});
export type UnloadModelBody = z.infer<typeof UnloadModelBody>;

/** A model's persisted settings, keyed by filename (`DATA_DIR/model-settings.json`, CONTRACTS §6). */
export const ModelSettings = z.object({
  filename: z.string(),
  disableThinking: z.boolean().optional(),
});
export type ModelSettings = z.infer<typeof ModelSettings>;

/** `PATCH /api/models/settings` body — same shape as `ModelSettings` with `filename` required (CONTRACTS §6). */
export const ModelSettingsPatch = z.object({
  filename: z.string(),
  disableThinking: z.boolean().optional(),
});
export type ModelSettingsPatch = z.infer<typeof ModelSettingsPatch>;

/** A placement plus the host's current tunnel status for it (CONTRACTS §6). */
export const PlacementStatus = Placement.extend({
  tunnelStatus: z.enum(["connected", "connecting", "down"]),
});
export type PlacementStatus = z.infer<typeof PlacementStatus>;

/** Published host release (network `GET /releases/host.json`, CONTRACTS §8). */
export const HostReleaseManifest = z.object({
  version: z.string(),
  gitSha: z.string(),
  publishedAt: z.string(),
  images: z.array(z.string()),
  notes: z.string().nullable(),
});
export type HostReleaseManifest = z.infer<typeof HostReleaseManifest>;

/** Updater sidecar apply state (`GET http://updater:7424/status`, CONTRACTS §8). */
export const UpdateApplyState = z.object({
  state: z.enum(["idle", "pulling", "applying", "error", "unknown"]),
  version: z.string().optional(),
  error: z.string().optional(),
  finishedAt: z.string().optional(),
  managed: z.boolean().optional(),
  reason: z.string().optional(),
});
export type UpdateApplyState = z.infer<typeof UpdateApplyState>;

/** `GET /api/update/status` response (CONTRACTS §6). */
export const UpdateStatus = z.object({
  current: z.object({ version: z.string() }),
  latest: z
    .object({ version: z.string(), publishedAt: z.string(), notes: z.string().nullable() })
    .nullable(),
  updateAvailable: z.boolean(),
  checkedAt: z.string().nullable(),
  checkError: z.string().optional(),
  networkUrl: z.string(),
  apply: UpdateApplyState,
});
export type UpdateStatus = z.infer<typeof UpdateStatus>;
