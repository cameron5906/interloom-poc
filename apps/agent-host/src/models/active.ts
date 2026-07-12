import fs from "fs";
import path from "path";
import { MODELS_DIR, INFERENCE_URL } from "../config.js";

export interface ActiveModel {
  path: string;
  filename: string;
  /** Context window the model was loaded with. */
  ctx: number;
}

function inferenceJsonPath(): string {
  return path.join(MODELS_DIR, ".interloom", "inference.json");
}

function readInferenceJson(): { modelPath?: string; ctx?: number } | null {
  const p = inferenceJsonPath();
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as unknown;
    if (typeof raw === "object" && raw !== null) return raw as { modelPath?: string; ctx?: number };
    return null;
  } catch {
    return null;
  }
}

/**
 * Read the configured context window from inference.json.
 * Returns the stored ctx value, or the default 4096 if not set.
 */
export function readInferenceCtx(): number {
  const config = readInferenceJson();
  return config?.ctx ?? 4096;
}

/**
 * Returns the active model (path + filename) if inference.json exists AND
 * inference /health is reachable and healthy. Returns null otherwise.
 */
export async function getActiveModel(): Promise<ActiveModel | null> {
  const config = readInferenceJson();
  if (!config?.modelPath) return null;

  try {
    const res = await fetch(`${INFERENCE_URL}/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
  } catch {
    return null;
  }

  return {
    path: config.modelPath,
    filename: path.basename(config.modelPath),
    ctx: readInferenceCtx(),
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
 * Returns the configured model filename from inference.json without checking
 * inference health — used for tunnel filtering where we want the "intended"
 * active model even if inference is mid-restart.
 */
export function getConfiguredModelFilename(): string | null {
  const config = readInferenceJson();
  if (!config?.modelPath) return null;
  return path.basename(config.modelPath);
}
