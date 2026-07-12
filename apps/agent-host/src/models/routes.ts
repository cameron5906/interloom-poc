import fs from "fs";
import path from "path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { MODELS_DIR, INFERENCE_URL, FETCHER_URL } from "../config.js";
import type { GpuInfo } from "@interloom/protocol";
import { CURATED_MODELS } from "./curated.js";

const DownloadBody = z.object({
  repoId: z.string().min(1),
  filename: z.string().min(1),
});

const ActivateBody = z.object({
  path: z.string().min(1),
  ctx: z.number().int().positive().optional(),
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

export function registerModelsRoutes(
  app: FastifyInstance,
  getSystemInfo: () => Promise<{ gpus: GpuInfo[]; unifiedMemoryMB?: number }>,
): void {
  app.get("/api/models/curated", async (_req, reply) => {
    const { gpus, unifiedMemoryMB } = await getSystemInfo();
    return reply.send(annotateWithFits(gpus, unifiedMemoryMB));
  });

  app.get<{ Querystring: { q?: string } }>("/api/models/search", async (req, reply) => {
    const q = req.query.q ?? "";
    try {
      const res = await fetch(
        `https://huggingface.co/api/models?search=${encodeURIComponent(q)}&filter=gguf&limit=20`,
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

  app.post<{ Body: unknown }>(
    "/api/models/download",
    async (req, reply) => {
      const parsed = DownloadBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.message });
      }
      const { repoId, filename } = parsed.data;
      try {
        const res = await fetch(`${FETCHER_URL}/downloads`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ repoId, filename }),
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

  app.get("/api/models/local", async (_req, reply) => {
    const files = await scanGgufFiles(MODELS_DIR);
    return reply.send(files);
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
