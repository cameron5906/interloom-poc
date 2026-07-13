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

/** The model an agent runs on — carried from host through the registry to workspaces. */
export const ModelRef = z.object({
  repoId: z.string().optional(),
  filename: z.string(),
  displayName: z.string(),
  quant: z.string().optional(),
  sizeBytes: z.number().optional(),
  capabilities: ModelCapabilities.optional(),
});
export type ModelRef = z.infer<typeof ModelRef>;
