import { z } from "zod";

/**
 * Detected model capabilities (CONTRACTS §4). Text generation is the implied
 * baseline for every chat model and does not ride the wire. Absent = unknown
 * (old manifests / unparsed models) — consumers must not treat it as "none".
 */
export const ModelCapabilities = z.object({
  tools: z.boolean(),
  vision: z.boolean(),
  thinking: z.boolean(),
});
export type ModelCapabilities = z.infer<typeof ModelCapabilities>;

/** Runner strategy verified for one loaded GGUF/runtime configuration. */
export const ModelAgentAdapter = z.enum(["native_tools", "schema_actions"]);
export type ModelAgentAdapter = z.infer<typeof ModelAgentAdapter>;

export const ModelReasoningControl = z.enum(["none", "toggle", "effort", "implicit", "always"]);
export type ModelReasoningControl = z.infer<typeof ModelReasoningControl>;

/**
 * Effective model contract advertised by an authenticated Host. Catalog claims
 * are advisory; these fields describe the exact GGUF + llama.cpp build + load
 * configuration serving this tunnel.
 */
export const ModelRuntimeProfile = z
  .object({
    version: z.literal(1),
    catalogId: z.string().min(1).max(160).optional(),
    contextWindow: z.number().int().positive().max(10_000_000),
    maxOutputTokens: z.number().int().positive().max(10_000_000).nullable(),
    chatFormat: z.string().min(1).max(160).nullable(),
    templateHash: z.string().min(16).max(128).nullable(),
    runtimeBuild: z.string().max(256).nullable(),
    probeStatus: z.enum(["verified", "degraded", "unavailable"]),
    adapter: ModelAgentAdapter,
    toolFormat: z.string().max(160).nullable(),
    reasoning: z.object({
      control: ModelReasoningControl,
      active: z.boolean(),
      minimumContextTokens: z.number().int().positive().max(10_000_000).nullable(),
    }),
    features: z.object({
      tools: z.boolean(),
      structuredOutput: z.boolean(),
      exactInputTokens: z.boolean(),
      jsonSchema: z.boolean(),
      vision: z.boolean(),
      audio: z.boolean(),
    }),
  })
  .strict();
export type ModelRuntimeProfile = z.infer<typeof ModelRuntimeProfile>;

/** The model an agent runs on — carried from host through the registry to workspaces. */
export const ModelRef = z.object({
  repoId: z.string().optional(),
  /** Stable Atlas identity; unlike repoId it also covers discovery GGUF entries. */
  catalogId: z.string().optional(),
  filename: z.string(),
  displayName: z.string(),
  quant: z.string().optional(),
  sizeBytes: z.number().optional(),
  capabilities: ModelCapabilities.optional(),
});
export type ModelRef = z.infer<typeof ModelRef>;
