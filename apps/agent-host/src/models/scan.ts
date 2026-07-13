import fs from "fs";
import path from "path";
import type { LocalModel, ModelCapabilities } from "@interloom/protocol";
import { parseGgufMeta } from "./gguf.js";
import { detectCapabilities, isMmprojFilename, pickMmproj } from "./capabilities.js";

interface FileEntry {
  path: string;
  filename: string;
  sizeBytes: number;
  mtimeMs: number;
  dir: string;
}

/** Header parses are expensive (≤32 MB read) — cache per path+mtime. */
const capCache = new Map<string, { mtimeMs: number; capabilities: ModelCapabilities | undefined }>();

function walkGguf(dir: string): FileEntry[] {
  const out: FileEntry[] = [];
  if (!fs.existsSync(dir)) return out;
  const visit = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(full);
      } else if (entry.isFile() && entry.name.endsWith(".gguf")) {
        const stat = fs.statSync(full);
        out.push({
          path: full,
          filename: entry.name,
          sizeBytes: stat.size,
          mtimeMs: stat.mtimeMs,
          dir: current,
        });
      }
    }
  };
  visit(dir);
  return out;
}

function cachedCapabilities(entry: FileEntry, siblingFilenames: string[]): ModelCapabilities | undefined {
  const hit = capCache.get(entry.path);
  if (hit && hit.mtimeMs === entry.mtimeMs) return hit.capabilities;
  const repoId = path.basename(entry.dir).replace("__", "/");
  const capabilities = detectCapabilities({
    meta: parseGgufMeta(entry.path),
    filename: entry.filename,
    repoId,
    siblingFilenames,
  });
  capCache.set(entry.path, { mtimeMs: entry.mtimeMs, capabilities });
  return capabilities;
}

/** Scan MODELS_DIR: mmproj files pair with their directory's models, never list as models. */
export function scanLocalModels(dir: string): LocalModel[] {
  const all = walkGguf(dir);
  const byDir = new Map<string, FileEntry[]>();
  for (const f of all) {
    const list = byDir.get(f.dir) ?? [];
    list.push(f);
    byDir.set(f.dir, list);
  }

  const models: LocalModel[] = [];
  for (const [, entries] of byDir) {
    const siblingFilenames = entries.map((e) => e.filename);
    const mmproj = pickMmproj(entries.map((e) => ({ filename: e.filename, sizeBytes: e.sizeBytes })));
    const mmprojEntry = mmproj ? entries.find((e) => e.filename === mmproj.filename) : undefined;
    for (const entry of entries) {
      if (isMmprojFilename(entry.filename)) continue;
      const caps = cachedCapabilities(entry, siblingFilenames);
      const capabilities =
        mmprojEntry && caps && caps.vision === false ? { ...caps, vision: true } : caps;
      models.push({
        path: entry.path,
        filename: entry.filename,
        sizeBytes: entry.sizeBytes,
        capabilities,
        ...(mmprojEntry
          ? { mmprojPath: mmprojEntry.path, mmprojBytes: mmprojEntry.sizeBytes }
          : {}),
      });
    }
  }
  return models;
}

/** Definitive capabilities for a locally present filename (Task 7: manifest stamping). */
export function capabilitiesForFilename(
  dir: string,
  filename: string,
): ModelCapabilities | undefined {
  return scanLocalModels(dir).find((m) => m.filename === filename)?.capabilities;
}
