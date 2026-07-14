import fs from "fs";
import path from "path";
import { MODELS_DIR } from "../config.js";
import { readInstances, pollInstanceHealth } from "./loaded.js";

export interface ActiveModel {
  path: string;
  filename: string;
  /** Context window the model was loaded with. */
  ctx: number;
  /** Absolute path of the paired mmproj (vision projector), when loaded. */
  mmprojPath?: string;
}

/**
 * Read the configured context window of the FIRST loaded instance (back-compat —
 * CONTRACTS §6 multi-instance loading). Returns the default 4096 when nothing
 * is loaded.
 */
export function readInferenceCtx(): number {
  const instances = readInstances();
  return instances[0]?.ctx ?? 4096;
}

/**
 * Returns the active model (path + filename) — the FIRST loaded instance,
 * back-compat (CONTRACTS §6) — if inference.json has at least one instance AND
 * that instance's /health is reachable and ready. Returns null otherwise.
 */
export async function getActiveModel(): Promise<ActiveModel | null> {
  const instances = readInstances();
  const first = instances[0];
  if (!first) return null;

  const health = await pollInstanceHealth(first.port);
  if (health !== "ready") return null;

  return {
    path: first.modelPath,
    filename: path.basename(first.modelPath),
    ctx: first.ctx,
    ...(first.mmprojPath ? { mmprojPath: first.mmprojPath } : {}),
  };
}

/**
 * Walk MODELS_DIR to find the absolute path for a given .gguf filename.
 * Returns null when the file is not present locally.
 */
export function findLocalModelPath(filename: string): string | null {
  function walk(dir: string): string | null {
    if (!fs.existsSync(dir)) return null;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = walk(full);
        if (found) return found;
      } else if (entry.isFile() && entry.name === filename) {
        return full;
      }
    }
    return null;
  }
  return walk(MODELS_DIR);
}

/**
 * Returns the filename of the FIRST loaded instance (back-compat) without
 * checking inference health — used for tunnel filtering where we want the
 * "intended" active model even if inference is mid-restart. Multi-instance
 * callers should prefer `loadedFilenames()` from `./loaded.js`.
 */
export function getConfiguredModelFilename(): string | null {
  const instances = readInstances();
  const first = instances[0];
  if (!first) return null;
  return path.basename(first.modelPath);
}
