import { z } from "zod";
import { Placement } from "./registry.js";
import { ModelRef } from "./model.js";

/** A detected GPU (CONTRACTS §6, `GET /api/system`). */
export const GpuInfo = z.object({
  name: z.string(),
  vramMB: z.number(),
  kind: z.enum(["cuda", "metal", "none"]),
  driver: z.string().optional(),
});
export type GpuInfo = z.infer<typeof GpuInfo>;

/** Host system report (CONTRACTS §6, `GET /api/system`). */
export const SystemInfo = z.object({
  os: z.string(),
  arch: z.string(),
  dockerized: z.literal(true),
  gpus: z.array(GpuInfo),
  unifiedMemoryMB: z.number().optional(),
});
export type SystemInfo = z.infer<typeof SystemInfo>;

/** A curated model entry, annotated with tier/vram requirements (CONTRACTS §6). */
export const CuratedModel = z.object({
  id: z.string(),
  repoId: z.string(),
  filename: z.string(),
  displayName: z.string(),
  sizeBytes: z.number(),
  quant: z.string(),
  minVramMB: z.number(),
  tier: z.enum(["spark", "gpu-24gb", "gpu-10gb", "cpu"]),
  blurb: z.string(),
});
export type CuratedModel = z.infer<typeof CuratedModel>;

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
});
export type LocalModel = z.infer<typeof LocalModel>;

/** Local agent record stored in DATA_DIR/agents.json (CONTRACTS §6). */
export const HostAgent = z.object({
  agentId: z.string(),
  name: z.string(),
  avatar: z.object({
    emoji: z.string(),
    bg: z.string(),
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
});
export type HostAgent = z.infer<typeof HostAgent>;

// --- Telemetry WS frame (§6) ---

export const TelemetryGpu = z.object({
  name: z.string(),
  utilPct: z.number(),
  vramUsedMB: z.number(),
  vramTotalMB: z.number(),
});
export type TelemetryGpu = z.infer<typeof TelemetryGpu>;

export const TelemetryRequestLogEntry = z.object({
  ts: z.number(),
  source: z.string(),
  agentName: z.string(),
  promptTokens: z.number(),
  completionTokens: z.number(),
  tokensPerSec: z.number(),
});
export type TelemetryRequestLogEntry = z.infer<typeof TelemetryRequestLogEntry>;

export const TelemetryTunnel = z.object({
  instanceName: z.string(),
  instanceUrl: z.string(),
  agentName: z.string(),
  status: z.enum(["connected", "connecting", "down"]),
});
export type TelemetryTunnel = z.infer<typeof TelemetryTunnel>;

export const TelemetryAgent = z.object({
  agentId: z.string(),
  name: z.string(),
  /** "serving" while this agent's request is in flight; "idle" when active-model-attached; "offline" when its model isn't loaded. */
  status: z.enum(["idle", "serving", "offline"]),
  registered: z.boolean(),
  syncedAt: z.string().optional(),
});
export type TelemetryAgent = z.infer<typeof TelemetryAgent>;

/** 1 Hz host telemetry frame (CONTRACTS §6). */
export const TelemetryFrame = z.object({
  ts: z.number(),
  gpus: z.array(TelemetryGpu),
  tokensPerSec: z.number(),
  requestLog: z.array(TelemetryRequestLogEntry),
  tunnels: z.array(TelemetryTunnel),
  agents: z.array(TelemetryAgent),
  inference: z
    .object({
      activeModel: ModelRef.nullable(),
      queueDepth: z.number(),
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

/** `GET /api/models/context-options` — KV-cache-based context sizing (CONTRACTS §6). */
export const ContextOptions = z.object({
  trainedMax: z.number().nullable(),
  options: z.array(ContextOption),
  recommendedCtx: z.number(),
  /** Whether GGUF metadata parsing succeeded; false = size-heuristic estimates. */
  exact: z.boolean(),
});
export type ContextOptions = z.infer<typeof ContextOptions>;

/** A placement plus the host's current tunnel status for it (CONTRACTS §6). */
export const PlacementStatus = Placement.extend({
  tunnelStatus: z.enum(["connected", "connecting", "down"]),
});
export type PlacementStatus = z.infer<typeof PlacementStatus>;
