import { z } from "zod";

/** The model an agent runs on — carried from host through the registry to workspaces. */
export const ModelRef = z.object({
  repoId: z.string().optional(),
  filename: z.string(),
  displayName: z.string(),
  quant: z.string().optional(),
  sizeBytes: z.number().optional(),
});
export type ModelRef = z.infer<typeof ModelRef>;
