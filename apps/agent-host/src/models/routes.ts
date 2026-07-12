import fs from "fs";
import os from "os";
import path from "path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { MODELS_DIR, INFERENCE_URL, FETCHER_URL } from "../config.js";
import type { GpuInfo } from "@interloom/protocol";
import { ContextOptions } from "@interloom/protocol";
import { CURATED_MODELS } from "./curated.js";
import { getActiveModel } from "./active.js";
import { parseGgufMeta } from "./gguf.js";
import {
  getHfStatus,
  connectHfToken,
  disconnectHfToken,
  getHfToken,
} from "../settings.js";

const DownloadBody = z.object({
  repoId: z.string().min(1),
  filename: z.string().min(1),
});

const ActivateBody = z.object({
  path: z.string().min(1),
  ctx: z.number().int().positive().optional(),
});

const DeleteLocalBody = z.object({
  path: z.string().min(1),
});

const HfTokenBody = z.object({
  token: z.string().min(1),
});

export interface CuratedModelWithFits {
  id: string;
  repoId: string;
  filename: string;
  displayName: string;
  sizeBytes: number;
  quant: string;
  minVramMB: number;
  tier: string;
  blurb: string;
  fits: boolean;
}

export function computeAvailableVramMB(
  gpus: GpuInfo[],
  unifiedMemoryMB?: number,
): number {
  const discreteGpus = gpus.filter((g) => g.kind === "cuda");
  if (discreteGpus.length > 0) {
    return Math.max(...discreteGpus.map((g) => g.vramMB));
  }
  if (unifiedMemoryMB !== undefined) {
    return unifiedMemoryMB;
  }
  return 8192;
}

export function annotateWithFits(
  gpus: GpuInfo[],
  unifiedMemoryMB?: number,
): CuratedModelWithFits[] {
  const availableVramMB = computeAvailableVramMB(gpus, unifiedMemoryMB);
  return CURATED_MODELS.map((m) => ({
    ...m,
    fits: m.minVramMB <= availableVramMB,
  }));
}

async function scanGgufFiles(dir: string): Promise<Array<{ path: string; filename: string; sizeBytes: number }>> {
  const results: Array<{ path: string; filename: string; sizeBytes: number }> = [];
  if (!fs.existsSync(dir)) return results;

  function walk(current: string): void {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".gguf")) {
        const stat = fs.statSync(full);
        results.push({ path: full, filename: entry.name, sizeBytes: stat.size });
      }
    }
  }

  walk(dir);
  return results;
}

/**
 * Validates that a path is inside MODELS_DIR to prevent directory traversal.
 * Returns the resolved path if safe, throws otherwise.
 */
function assertInsideModelsDir(filePath: string): string {
  const resolved = path.resolve(filePath);
  const base = path.resolve(MODELS_DIR);
  if (!resolved.startsWith(base + path.sep) && resolved !== base) {
    throw new Error("path is outside MODELS_DIR");
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Context-options computation (CONTRACTS §6)
// ---------------------------------------------------------------------------

export interface FitTierInput {
  fileSizeBytes: number;
  gpus: GpuInfo[];
  unifiedMemoryMB?: number;
  layers: number;
  kvHeads: number;
  headDim: number;
  ctx: number;
}

/**
 * Compute KV-cache bytes for a given context length.
 * Formula: 2 × layers × kv_heads × head_dim × 2 bytes × ctx
 */
export function kvBytes(layers: number, kvHeads: number, headDim: number, ctx: number): number {
  return 2 * layers * kvHeads * headDim * 2 * ctx;
}

/**
 * Classify a context size into a fit tier against the host hardware.
 *
 * fast  — model weights + KV ≤ free VRAM
 * spill — model weights + KV ≤ VRAM + 50% system RAM
 * no    — too large to load
 *
 * Unified memory (arm64, no discrete GPU): the "VRAM" is treated as system
 * RAM as well, so free VRAM equals unifiedMemoryMB and spill bound adds
 * 50% of that same pool — both come from the same physical memory.
 */
export function fitTier(input: FitTierInput): "fast" | "spill" | "no" {
  const {
    fileSizeBytes,
    gpus,
    unifiedMemoryMB,
    layers,
    kvHeads,
    headDim,
    ctx,
  } = input;

  const OVERHEAD_BYTES = 1.5 * 1024 * 1024 * 1024; // 1.5 GB runtime overhead
  const kv = kvBytes(layers, kvHeads, headDim, ctx);
  const total = fileSizeBytes + kv + OVERHEAD_BYTES;

  const arch = os.arch();
  const isUnified = arch === "arm64" && !gpus.some((g) => g.kind === "cuda");

  let freeVramBytes: number;
  let spillBoundBytes: number;

  if (isUnified && unifiedMemoryMB !== undefined) {
    freeVramBytes = unifiedMemoryMB * 1024 * 1024;
    // On unified memory, "system RAM" is the same pool — spill adds 50% of it
    spillBoundBytes = freeVramBytes + 0.5 * freeVramBytes;
  } else {
    const discreteGpus = gpus.filter((g) => g.kind === "cuda");
    const vramMB =
      discreteGpus.length > 0
        ? Math.max(...discreteGpus.map((g) => g.vramMB))
        : 0;
    freeVramBytes = vramMB * 1024 * 1024;
    const totalRamBytes = os.totalmem();
    spillBoundBytes = freeVramBytes + 0.5 * totalRamBytes;
  }

  if (total <= freeVramBytes) return "fast";
  if (total <= spillBoundBytes) return "spill";
  return "no";
}

/**
 * Build the full ContextOptions payload for a model file.
 * Exported for unit testing.
 */
export function buildContextOptions(
  filePath: string,
  fileSizeBytes: number,
  gpus: GpuInfo[],
  unifiedMemoryMB?: number,
): import("@interloom/protocol").ContextOptions {
  const meta = parseGgufMeta(filePath);

  if (!meta) {
    // Fallback: size-based heuristic
    const fileSizeGB = fileSizeBytes / (1024 * 1024 * 1024);
    const kvBytesPerToken = fileSizeGB * 12_000;
    const trainedMax = null;
    const CAP_CTX = 32768;

    const candidates: number[] = [];
    let c = 4096;
    while (c <= CAP_CTX) {
      candidates.push(c);
      c *= 2;
    }

    const options = candidates.map((ctx) => {
      const kv = kvBytesPerToken * ctx;
      const totalBytes = fileSizeBytes + kv + 1.5 * 1024 * 1024 * 1024;
      const freeVram = computeAvailableVramMB(gpus, unifiedMemoryMB) * 1024 * 1024;
      const totalRam = os.totalmem();
      const spillBound = freeVram + 0.5 * totalRam;
      let fit: "fast" | "spill" | "no";
      if (totalBytes <= freeVram) fit = "fast";
      else if (totalBytes <= spillBound) fit = "spill";
      else fit = "no";
      return { ctx, kvBytes: Math.round(kv), fit };
    });

    const fastOptions = options.filter((o) => o.fit === "fast");
    const recommendedCtx = fastOptions.length > 0
      ? Math.max(...fastOptions.map((o) => o.ctx))
      : 4096;

    return ContextOptions.parse({
      trainedMax,
      options,
      recommendedCtx,
      exact: false,
    });
  }

  const { contextLength, blockCount, kvHeads, headDim } = meta;
  const CAP_CTX = 131072;
  const trainedMax = contextLength;

  const candidates: number[] = [];
  let c = 4096;
  while (c <= Math.min(trainedMax, CAP_CTX)) {
    candidates.push(c);
    c *= 2;
  }
  // Always include trainedMax itself if it's not already a power-of-two in the list
  if (candidates.length === 0 || candidates[candidates.length - 1] !== Math.min(trainedMax, CAP_CTX)) {
    const capped = Math.min(trainedMax, CAP_CTX);
    if (!candidates.includes(capped)) {
      candidates.push(capped);
    }
  }

  const options = candidates.map((ctx) => {
    const kv = kvBytes(blockCount, kvHeads, headDim, ctx);
    const fit = fitTier({ fileSizeBytes, gpus, unifiedMemoryMB, layers: blockCount, kvHeads, headDim, ctx });
    return { ctx, kvBytes: kv, fit };
  });

  const fastOptions = options.filter((o) => o.fit === "fast");
  const recommendedCtx = fastOptions.length > 0
    ? Math.max(...fastOptions.map((o) => o.ctx))
    : 4096;

  return ContextOptions.parse({
    trainedMax,
    options,
    recommendedCtx,
    exact: true,
  });
}

export function registerModelsRoutes(
  app: FastifyInstance,
  getSystemInfo: () => Promise<{ gpus: GpuInfo[]; unifiedMemoryMB?: number }>,
  triggerHeartbeat?: () => void,
): void {
  // --- HF account settings ---

  app.post<{ Body: unknown }>("/api/settings/hf-token", async (req, reply) => {
    const parsed = HfTokenBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.message });
    }
    try {
      const { username } = await connectHfToken(parsed.data.token);
      return reply.send({ username });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ error: message });
    }
  });

  app.get("/api/settings/hf", async (_req, reply) => {
    return reply.send(getHfStatus());
  });

  app.delete("/api/settings/hf-token", async (_req, reply) => {
    disconnectHfToken();
    return reply.status(204).send();
  });

  // --- Curated & search ---

  app.get("/api/models/curated", async (_req, reply) => {
    const { gpus, unifiedMemoryMB } = await getSystemInfo();
    return reply.send(annotateWithFits(gpus, unifiedMemoryMB));
  });

  app.get<{ Querystring: { q?: string } }>("/api/models/search", async (req, reply) => {
    const q = req.query.q ?? "";
    const hfToken = getHfToken();
    const headers: Record<string, string> = {};
    if (hfToken) headers["Authorization"] = `Bearer ${hfToken}`;
    try {
      const res = await fetch(
        `https://huggingface.co/api/models?search=${encodeURIComponent(q)}&filter=gguf&limit=20`,
        { headers },
      );
      if (!res.ok) {
        return reply.status(502).send({ error: "HF search failed" });
      }
      const data = await res.json() as Array<{
        modelId?: string;
        id?: string;
        likes?: number;
        downloads?: number;
        siblings?: Array<{ rfilename: string; size?: number }>;
      }>;
      const mapped = data.map((m) => ({
        repoId: m.modelId ?? m.id ?? "",
        likes: m.likes ?? 0,
        downloads: m.downloads ?? 0,
        files: (m.siblings ?? [])
          .filter((s) => s.rfilename.endsWith(".gguf"))
          .map((s) => ({
            filename: s.rfilename,
            sizeBytes: s.size ?? 0,
            quant: s.rfilename.match(/[QqIi][0-9_A-Za-z]+/)?.[0] ?? "",
          })),
      }));
      return reply.send(mapped);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(502).send({ error: message });
    }
  });

  // --- Download management ---

  app.post<{ Body: unknown }>(
    "/api/models/download",
    async (req, reply) => {
      const parsed = DownloadBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.message });
      }
      const { repoId, filename } = parsed.data;
      const hfToken = getHfToken();
      const fetcherBody: Record<string, unknown> = { repoId, filename };
      if (hfToken) fetcherBody["hfToken"] = hfToken;
      try {
        const res = await fetch(`${FETCHER_URL}/downloads`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(fetcherBody),
        });
        if (!res.ok) {
          const text = await res.text();
          return reply.status(502).send({ error: text });
        }
        return reply.send(await res.json());
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(502).send({ error: `fetcher unavailable: ${message}` });
      }
    },
  );

  app.get("/api/models/downloads", async (_req, reply) => {
    try {
      const res = await fetch(`${FETCHER_URL}/downloads`);
      if (!res.ok) return reply.status(502).send({ error: "fetcher unavailable" });
      return reply.send(await res.json());
    } catch {
      return reply.send([]);
    }
  });

  // --- Local model management ---

  app.get("/api/models/local", async (_req, reply) => {
    const files = await scanGgufFiles(MODELS_DIR);
    return reply.send(files);
  });

  app.delete<{ Body: unknown }>("/api/models/local", async (req, reply) => {
    const parsed = DeleteLocalBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.message });
    }

    let resolvedPath: string;
    try {
      resolvedPath = assertInsideModelsDir(parsed.data.path);
    } catch {
      return reply.status(400).send({ error: "invalid path" });
    }

    // 409 if this file is the currently active model
    const active = await getActiveModel();
    if (active && path.resolve(active.path) === resolvedPath) {
      return reply.status(409).send({ error: "model_active" });
    }

    if (!fs.existsSync(resolvedPath)) {
      return reply.status(404).send({ error: "not found" });
    }

    try {
      fs.unlinkSync(resolvedPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }

    return reply.status(204).send();
  });

  app.get("/api/models/active", async (_req, reply) => {
    const active = await getActiveModel();
    return reply.send(active);
  });

  app.get<{ Querystring: { path?: string } }>("/api/models/context-options", async (req, reply) => {
    const filePath = req.query.path;
    if (!filePath) {
      return reply.status(400).send({ error: "path query parameter is required" });
    }

    let resolvedPath: string;
    try {
      resolvedPath = assertInsideModelsDir(filePath);
    } catch {
      return reply.status(400).send({ error: "invalid path" });
    }

    if (!fs.existsSync(resolvedPath)) {
      return reply.status(404).send({ error: "model file not found" });
    }

    const stat = fs.statSync(resolvedPath);
    const { gpus, unifiedMemoryMB } = await getSystemInfo();
    const result = buildContextOptions(resolvedPath, stat.size, gpus, unifiedMemoryMB);
    return reply.send(result);
  });

  app.post<{ Body: unknown }>(
    "/api/models/activate",
    async (req, reply) => {
      const parsed = ActivateBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.message });
      }
      const { path: modelPath, ctx } = parsed.data;
      const inferenceDir = path.join(MODELS_DIR, ".interloom");
      fs.mkdirSync(inferenceDir, { recursive: true });
      const inferenceJson = path.join(inferenceDir, "inference.json");
      const config: Record<string, unknown> = { modelPath };
      if (ctx !== undefined) config["ctx"] = ctx;
      const tmp = inferenceJson + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(config, null, 2), "utf8");
      fs.renameSync(tmp, inferenceJson);

      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        try {
          const res = await fetch(`${INFERENCE_URL}/health`);
          if (res.ok) {
            triggerHeartbeat?.();
            return reply.send({ status: "ready" });
          }
        } catch {
          // inference not ready yet
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      return reply.status(408).send({ error: "inference did not become ready within 120s" });
    },
  );
}
