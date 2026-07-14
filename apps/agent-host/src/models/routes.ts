import fs from "fs";
import os from "os";
import path from "path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { MODELS_DIR, FETCHER_URL } from "../config.js";
import type { GpuInfo, ModelRef, LoadedModel, AllocationView } from "@interloom/protocol";
import { ContextOptions, LoadModelBody, UnloadModelBody, ModelSettingsPatch } from "@interloom/protocol";
import { getActiveModel } from "./active.js";
import { parseGgufMeta } from "./gguf.js";
import { scanLocalModels } from "./scan.js";
import {
  computeAvailableVramMB,
  kvBytes,
  fitTier,
  computeGpuBudgets,
  fitDecisionForNewInstance,
  computeInstanceFootprintBytes,
  pickBestFitGpu,
  type InstanceFootprint,
} from "./fit.js";
import { buildContextPlans } from "./plans.js";
import { getRegistry, refreshRegistry } from "./registry.js";
import { computeRegistryFits } from "./registryFit.js";
import { mapSearchRows, buildRepoDetail } from "./hf.js";
import {
  readInstances,
  writeInstances,
  nextPort,
  findInstanceByPath,
  findInstanceByFilename,
  findBasenameConflict,
  loadedFilenames,
  toLoadedModel,
  toLoadedModels,
  pollInstanceHealth,
  type InstanceRecord,
  type InstanceHealth,
} from "./loaded.js";
import { listModelSettings, patchModelSettings, isThinkingDisabled } from "./settingsStore.js";
import { drainInstance } from "../inference/gate.js";
import {
  getHfStatus,
  connectHfToken,
  disconnectHfToken,
  getHfToken,
} from "../settings.js";

export { computeAvailableVramMB, kvBytes, fitTier, type FitTierInput } from "./fit.js";
export { loadedFilenames } from "./loaded.js";

const DownloadBody = z.object({
  repoId: z.string().min(1),
  filename: z.string().min(1),
  mmprojFilename: z.string().min(1).optional(),
});

const ActivateBody = z.object({
  path: z.string().min(1),
  ctx: z.number().int().positive().optional(),
  kvCache: z.enum(["f16", "q8_0"]).optional(),
  nCpuMoe: z.number().int().positive().max(999).optional(),
});

const DeleteLocalBody = z.object({
  path: z.string().min(1),
});

const HfTokenBody = z.object({
  token: z.string().min(1),
});

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
// Multi-instance model loading (CONTRACTS §6)
// ---------------------------------------------------------------------------

function instanceToFootprint(inst: InstanceRecord): InstanceFootprint {
  return {
    modelPath: inst.modelPath,
    mmprojPath: inst.mmprojPath ?? null,
    ctx: inst.ctx,
    gpus: inst.gpus,
    ...(inst.tensorSplit ? { tensorSplit: inst.tensorSplit } : {}),
  };
}

/** Definitive ModelRef for a locally present filename, for LoadedModel/AllocationView responses. */
export function modelRefForFilename(filename: string): ModelRef | undefined {
  const local = scanLocalModels(MODELS_DIR).find((m) => m.filename === filename);
  if (!local) return undefined;
  return {
    filename: local.filename,
    displayName: local.filename,
    sizeBytes: local.sizeBytes,
    ...(local.capabilities ? { capabilities: local.capabilities } : {}),
  };
}

type LoadOutcome =
  | { kind: "not_found" }
  | { kind: "wont_fit" }
  | { kind: "needs_confirm"; fit: "spill" }
  | { kind: "filename_conflict" }
  | { kind: "timeout" }
  | { kind: "ok"; loadedModel: LoadedModel };

/**
 * Shared load path for `POST /api/models/load` and `POST /api/models/activate`
 * (CONTRACTS §6): resolves placement (best-fit single GPU when omitted),
 * enforces fit against the REMAINING per-GPU budget of `othersOverride` (or
 * the full current registry when omitted), auto-pairs a sibling mmproj,
 * writes the instance (carrying `reasoningBudget: 0` when the model's
 * settings disable thinking), then polls that instance's `/health` until
 * ready (120s ceiling).
 */
async function loadModelInstance(opts: {
  resolvedPath: string;
  ctx?: number;
  placement?: { gpus: number[]; tensorSplit?: number[] };
  confirmSpill?: boolean;
  kvCache?: "f16" | "q8_0";
  nCpuMoe?: number;
  othersOverride?: InstanceRecord[];
  getSystemInfo: () => Promise<{ gpus: GpuInfo[]; unifiedMemoryMB?: number }>;
}): Promise<LoadOutcome> {
  const { resolvedPath, ctx, placement, confirmSpill, kvCache, nCpuMoe, getSystemInfo } = opts;

  if (!fs.existsSync(resolvedPath)) return { kind: "not_found" };

  const existing = opts.othersOverride ?? readInstances();

  // Basename-collision guard (CONTRACTS §6): every routing key downstream of
  // load (findInstanceByFilename, loadedFilenames, agent↔model binding) keys
  // on FILENAME, not full path — two loaded models may never share a
  // basename. Loading the same path again (an update-in-place) is exempt.
  if (findBasenameConflict(resolvedPath, existing)) {
    return { kind: "filename_conflict" };
  }

  const already = findInstanceByPath(resolvedPath, existing);
  const others = already ? existing.filter((i) => i.id !== already.id) : existing;

  const pairedModel = scanLocalModels(MODELS_DIR).find(
    (m) => path.resolve(m.path) === resolvedPath,
  );
  const mmprojPath = pairedModel?.mmprojPath ?? null;

  const { gpus, unifiedMemoryMB } = await getSystemInfo();
  const stat = fs.statSync(resolvedPath);
  const contextOptions = buildContextOptions(
    resolvedPath,
    stat.size,
    gpus,
    unifiedMemoryMB,
    pairedModel?.mmprojBytes ?? 0,
  );
  const effectiveCtx = ctx ?? contextOptions.recommendedCtx;

  const othersFootprints: InstanceFootprint[] = others.map(instanceToFootprint);

  let candidateGpus = placement?.gpus;
  if (!candidateGpus) {
    const footprintForPick = computeInstanceFootprintBytes({
      modelPath: resolvedPath,
      mmprojPath,
      ctx: effectiveCtx,
      gpus: [],
    });
    const best = pickBestFitGpu(footprintForPick, gpus, othersFootprints);
    candidateGpus = best !== null ? [best] : [];
  }

  const candidate: InstanceFootprint = {
    modelPath: resolvedPath,
    mmprojPath,
    ctx: effectiveCtx,
    gpus: candidateGpus,
    ...(placement?.tensorSplit ? { tensorSplit: placement.tensorSplit } : {}),
  };
  const decision = fitDecisionForNewInstance(candidate, gpus, othersFootprints, unifiedMemoryMB);

  if (decision === "no") return { kind: "wont_fit" };
  if (decision === "spill" && !confirmSpill) return { kind: "needs_confirm", fit: "spill" };

  const filename = path.basename(resolvedPath);
  const disableThinking = isThinkingDisabled(filename);
  const port = already?.port ?? nextPort(others);
  const record: InstanceRecord = {
    id: already?.id ?? crypto.randomUUID(),
    modelPath: resolvedPath,
    ctx: effectiveCtx,
    port,
    gpus: candidateGpus,
    ...(placement?.tensorSplit ? { tensorSplit: placement.tensorSplit } : {}),
    reasoningBudget: disableThinking ? 0 : null,
    mmprojPath,
    ...(kvCache !== undefined ? { kvCache } : {}),
    ...(nCpuMoe !== undefined ? { nCpuMoe } : {}),
    fit: decision,
  };

  writeInstances([...others, record]);

  const deadline = Date.now() + 120_000;
  let health: InstanceHealth = "down";
  while (Date.now() < deadline) {
    health = await pollInstanceHealth(port);
    if (health === "ready") break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (health !== "ready") return { kind: "timeout" };

  const loadedModel = await toLoadedModel(record, modelRefForFilename(filename));
  return { kind: "ok", loadedModel };
}

function sendLoadOutcome(
  reply: import("fastify").FastifyReply,
  outcome: LoadOutcome,
): import("fastify").FastifyReply {
  switch (outcome.kind) {
    case "not_found":
      return reply.status(404).send({ error: "model file not found" });
    case "wont_fit":
      return reply.status(409).send({ error: "wont_fit" });
    case "needs_confirm":
      return reply.status(409).send({ error: "needs_confirm", fit: outcome.fit });
    case "filename_conflict":
      return reply.status(409).send({ error: "filename_conflict" });
    case "timeout":
      return reply.status(408).send({ error: "inference did not become ready within 120s" });
    case "ok":
      return reply.send(outcome.loadedModel);
  }
}

// ---------------------------------------------------------------------------
// Context-options computation (CONTRACTS §6)
// ---------------------------------------------------------------------------

/**
 * Build the full ContextOptions payload for a model file.
 * Exported for unit testing.
 */
export function buildContextOptions(
  filePath: string,
  fileSizeBytes: number,
  gpus: GpuInfo[],
  unifiedMemoryMB?: number,
  mmprojBytes = 0,
  systemRamMB?: number,
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
      const totalBytes = fileSizeBytes + mmprojBytes + kv + 1.5 * 1024 * 1024 * 1024;
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
    const fit = fitTier({
      fileSizeBytes: fileSizeBytes + mmprojBytes,
      gpus,
      unifiedMemoryMB,
      layers: blockCount,
      kvHeads,
      headDim,
      ctx,
    });
    return { ctx, kvBytes: kv, fit };
  });

  const fastOptions = options.filter((o) => o.fit === "fast");
  const recommendedCtx = fastOptions.length > 0
    ? Math.max(...fastOptions.map((o) => o.ctx))
    : 4096;

  const { plans, recommendedPlan } = buildContextPlans(
    candidates,
    fileSizeBytes + mmprojBytes,
    meta,
    gpus,
    unifiedMemoryMB,
    systemRamMB,
  );

  return ContextOptions.parse({
    trainedMax,
    options,
    recommendedCtx,
    exact: true,
    plans,
    recommendedPlan,
  });
}

export function registerModelsRoutes(
  app: FastifyInstance,
  getSystemInfo: () => Promise<{ gpus: GpuInfo[]; unifiedMemoryMB?: number; systemRamMB?: number }>,
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

  // --- Registry & search ---

  app.get("/api/models/registry", async (_req, reply) => {
    const served = getRegistry();
    if (!served) {
      void refreshRegistry().catch(() => {});
      return reply.status(503).send({ error: "registry_unavailable" });
    }
    const { gpus, unifiedMemoryMB, systemRamMB } = await getSystemInfo();
    const fit = computeRegistryFits(served.doc.catalog.models, {
      gpus,
      unifiedMemoryMB,
      systemRamMB,
    });
    return reply.send({
      source: served.source,
      fetchedAt: served.fetchedAt,
      doc: served.doc,
      fit,
    });
  });

  app.get<{ Querystring: { q?: string } }>("/api/models/search", async (req, reply) => {
    const q = req.query.q ?? "";
    const hfToken = getHfToken();
    const headers: Record<string, string> = {};
    if (hfToken) headers["Authorization"] = `Bearer ${hfToken}`;
    try {
      const res = await fetch(
        `https://huggingface.co/api/models?search=${encodeURIComponent(q)}&filter=gguf&limit=20&expand[]=gguf&expand[]=downloads&expand[]=likes&expand[]=tags`,
        { headers },
      );
      if (!res.ok) {
        return reply.status(502).send({ error: "HF search failed" });
      }
      return reply.send(mapSearchRows((await res.json()) as Parameters<typeof mapSearchRows>[0]));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(502).send({ error: message });
    }
  });

  app.get<{ Querystring: { repoId?: string } }>("/api/models/hf-detail", async (req, reply) => {
    const repoId = req.query.repoId;
    if (!repoId) return reply.status(400).send({ error: "repoId query parameter is required" });
    const hfToken = getHfToken();
    const headers: Record<string, string> = {};
    if (hfToken) headers["Authorization"] = `Bearer ${hfToken}`;
    try {
      const res = await fetch(
        `https://huggingface.co/api/models/${repoId.split("/").map(encodeURIComponent).join("/")}?blobs=true`,
        { headers },
      );
      if (!res.ok) {
        return reply.status(502).send({ error: "HF detail failed" });
      }
      const { gpus, unifiedMemoryMB } = await getSystemInfo();
      return reply.send(
        buildRepoDetail(repoId, (await res.json()) as Parameters<typeof buildRepoDetail>[1], {
          gpus,
          unifiedMemoryMB,
        }),
      );
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
      const { repoId, filename, mmprojFilename } = parsed.data;
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
        const job = await res.json();
        if (mmprojFilename) {
          const mmprojBody: Record<string, unknown> = { repoId, filename: mmprojFilename };
          if (hfToken) mmprojBody["hfToken"] = hfToken;
          try {
            const mmprojRes = await fetch(`${FETCHER_URL}/downloads`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(mmprojBody),
            });
            if (!mmprojRes.ok) {
              app.log.warn(
                `mmproj download enqueue failed for ${repoId}/${mmprojFilename}: ${await mmprojRes.text()}`,
              );
            }
          } catch {
            app.log.warn(`mmproj download enqueue failed for ${repoId}/${mmprojFilename}`);
          }
        }
        return reply.send(job);
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
    return reply.send(scanLocalModels(MODELS_DIR));
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

    // 409 if this file is among the currently LOADED instances (CONTRACTS §6:
    // "409 model_active" now means "is among loaded", not just "is the single
    // active model" — multi-instance loading may have it loaded on any port).
    if (findInstanceByPath(resolvedPath)) {
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
    const { gpus, unifiedMemoryMB, systemRamMB } = await getSystemInfo();
    const paired = scanLocalModels(MODELS_DIR).find((m) => path.resolve(m.path) === resolvedPath);
    const result = buildContextOptions(
      resolvedPath,
      stat.size,
      gpus,
      unifiedMemoryMB,
      paired?.mmprojBytes ?? 0,
      systemRamMB,
    );
    return reply.send(result);
  });

  // --- Multi-instance model loading (CONTRACTS §6) ---

  app.post<{ Body: unknown }>("/api/models/load", async (req, reply) => {
    const parsed = LoadModelBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.message });
    }

    let resolvedPath: string;
    try {
      resolvedPath = assertInsideModelsDir(parsed.data.path);
    } catch {
      return reply.status(400).send({ error: "invalid path" });
    }

    const outcome = await loadModelInstance({
      resolvedPath,
      ctx: parsed.data.ctx,
      placement: parsed.data.placement,
      confirmSpill: parsed.data.confirmSpill,
      kvCache: parsed.data.kvCache,
      nCpuMoe: parsed.data.nCpuMoe,
      getSystemInfo,
    });

    if (outcome.kind === "ok") triggerHeartbeat?.();
    return sendLoadOutcome(reply, outcome);
  });

  app.post<{ Body: unknown }>("/api/models/unload", async (req, reply) => {
    const parsed = UnloadModelBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.message });
    }

    let resolvedPath: string;
    try {
      resolvedPath = assertInsideModelsDir(parsed.data.path);
    } catch {
      return reply.status(400).send({ error: "invalid path" });
    }

    const existing = readInstances();
    const instance = findInstanceByPath(resolvedPath, existing);
    if (!instance) {
      return reply.status(404).send({ error: "not_loaded" });
    }

    writeInstances(existing.filter((i) => i.id !== instance.id));
    drainInstance(instance.port);
    triggerHeartbeat?.();

    return reply.status(204).send();
  });

  app.get("/api/models/loaded", async (_req, reply) => {
    const instances = readInstances();
    const loaded = await toLoadedModels(instances, modelRefForFilename);
    return reply.send(loaded);
  });

  app.get("/api/models/allocation", async (_req, reply) => {
    const { gpus, unifiedMemoryMB } = await getSystemInfo();
    const instances = readInstances();
    const footprints = instances.map(instanceToFootprint);
    const gpuBudgets = computeGpuBudgets(gpus, footprints);
    const loaded = await toLoadedModels(instances, modelRefForFilename);
    const allocation: AllocationView = {
      gpus: gpuBudgets,
      loaded,
      maxConcurrentAgents: instances.length,
    };
    // unifiedMemoryMB isn't per-GPU (no discrete GPU set to enumerate) — the
    // gpus[] array is empty in that case; loaded/maxConcurrentAgents still hold.
    void unifiedMemoryMB;
    return reply.send(allocation);
  });

  app.get("/api/models/settings", async (_req, reply) => {
    return reply.send(listModelSettings());
  });

  app.patch<{ Body: unknown }>("/api/models/settings", async (req, reply) => {
    const parsed = ModelSettingsPatch.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.message });
    }
    const { filename, disableThinking } = parsed.data;
    const updated = patchModelSettings(filename, { disableThinking });

    // Currently loaded? Rewrite its instance entry so the supervisor restarts
    // just that instance (CONTRACTS §6).
    const existing = readInstances();
    const instance = findInstanceByFilename(filename, existing);
    if (instance) {
      const reasoningBudget = updated.disableThinking === true ? 0 : null;
      writeInstances(
        existing.map((i) => (i.id === instance.id ? { ...i, reasoningBudget } : i)),
      );
      triggerHeartbeat?.();
    }

    return reply.send(updated);
  });

  app.post<{ Body: unknown }>(
    "/api/models/activate",
    async (req, reply) => {
      const parsed = ActivateBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.message });
      }

      let resolvedPath: string;
      try {
        resolvedPath = assertInsideModelsDir(parsed.data.path);
      } catch {
        return reply.status(400).send({ error: "invalid path" });
      }
      if (!fs.existsSync(resolvedPath)) {
        return reply.status(404).send({ error: "model file not found" });
      }

      // "Load this as the sole model" — unload every currently loaded
      // instance first (CONTRACTS §6), then load fresh onto 8080 (the only
      // port `nextPort([])` can assign once every instance is gone). The
      // rig-optimizer plan flags (kvCache/nCpuMoe) ride the load onto the
      // instance record — the direct v1 inference.json write is gone (the
      // supervisor is v2 multi-instance).
      for (const inst of readInstances()) {
        drainInstance(inst.port);
      }

      const outcome = await loadModelInstance({
        resolvedPath,
        ctx: parsed.data.ctx,
        kvCache: parsed.data.kvCache,
        nCpuMoe: parsed.data.nCpuMoe,
        othersOverride: [],
        getSystemInfo,
      });

      if (outcome.kind === "ok") {
        triggerHeartbeat?.();
        return reply.send({ status: "ready" });
      }
      return sendLoadOutcome(reply, outcome);
    },
  );
}
