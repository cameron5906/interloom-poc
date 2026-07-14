/**
 * Multi-instance model registry (CONTRACTS §6). Owns `MODELS_DIR/.interloom/inference.json`
 * v2: `{ v: 2, instances: InstanceRecord[] }`. Reads BOTH the v1 single-object shape
 * (no `v` key — wrapped as one instance on port 8080, id "legacy") and v2.
 *
 * Port assignment: deterministic 8080+N. `nextPort` always picks the LOWEST free
 * port >= 8080 not currently held by a loaded instance — this both matches "8080,
 * 8081, …" for the common case and reuses a freed port (e.g. instance on 8081
 * unloaded, next load gets 8081 back) without any extra bookkeeping.
 *
 * `fit` ("fast" | "spill") is persisted on the instance record as an ADDITIVE
 * field beyond the CONTRACTS-pinned wire shape — the supervisor (Slice C) reads
 * modelPath/ctx/port/gpus/tensorSplit/reasoningBudget/mmprojPath/kvCache/nCpuMoe and
 * ignores unknown JSON properties, so this is harmless and lets `/api/models/loaded`
 * report the fit decision made at load time without re-deriving it (re-derivation
 * would need the free-VRAM snapshot from load time, which is lost once other
 * instances load). Seam note for review: this is the one place this daemon writes
 * a field outside the pinned inference.json shape.
 */

import fs from "fs";
import path from "path";
import type { LoadedModel, ModelRef } from "@interloom/protocol";
import { MODELS_DIR, INFERENCE_URL } from "../config.js";

export interface InstanceRecord {
  id: string;
  modelPath: string;
  ctx: number;
  port: number;
  gpus: number[];
  tensorSplit?: number[];
  reasoningBudget?: number | null;
  mmprojPath?: string | null;
  /** Rig-optimizer plan (CONTRACTS §6/§7) — KV-cache precision the supervisor launches with. */
  kvCache?: "f16" | "q8_0";
  /** Rig-optimizer plan (CONTRACTS §6/§7) — expert layers parked in system RAM (`--n-cpu-moe`). */
  nCpuMoe?: number;
  /** Additive (see module docstring) — the fit decision made at load time. */
  fit?: "fast" | "spill";
}

interface InferenceJsonV2 {
  v: 2;
  instances: InstanceRecord[];
}

interface InferenceJsonV1 {
  modelPath: string;
  ctx?: number;
  mmprojPath?: string;
}

const BASE_PORT = 8080;

function inferenceDir(): string {
  return path.join(MODELS_DIR, ".interloom");
}

function inferenceJsonPath(): string {
  return path.join(inferenceDir(), "inference.json");
}

function isV2(raw: unknown): raw is InferenceJsonV2 {
  return (
    typeof raw === "object" &&
    raw !== null &&
    "v" in raw &&
    (raw as { v: unknown }).v === 2 &&
    Array.isArray((raw as { instances?: unknown }).instances)
  );
}

function isV1(raw: unknown): raw is InferenceJsonV1 {
  return (
    typeof raw === "object" &&
    raw !== null &&
    !("v" in raw) &&
    typeof (raw as { modelPath?: unknown }).modelPath === "string"
  );
}

/**
 * Read the current instance set. Handles v1 (wrapped as a single "legacy"
 * instance on port 8080), v2, and missing/malformed files (→ []).
 */
export function readInstances(): InstanceRecord[] {
  const p = inferenceJsonPath();
  if (!fs.existsSync(p)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return [];
  }

  if (isV2(raw)) {
    return raw.instances.filter(
      (i): i is InstanceRecord =>
        typeof i === "object" &&
        i !== null &&
        typeof i.modelPath === "string" &&
        typeof i.port === "number",
    );
  }

  if (isV1(raw)) {
    return [
      {
        id: "legacy",
        modelPath: raw.modelPath,
        ctx: raw.ctx ?? 4096,
        port: BASE_PORT,
        gpus: [],
        ...(raw.mmprojPath ? { mmprojPath: raw.mmprojPath } : {}),
      },
    ];
  }

  return [];
}

/** Persist the instance set as v2, atomically. */
export function writeInstances(instances: InstanceRecord[]): void {
  fs.mkdirSync(inferenceDir(), { recursive: true });
  const p = inferenceJsonPath();
  const tmp = p + ".tmp";
  const payload: InferenceJsonV2 = { v: 2, instances };
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
  fs.renameSync(tmp, p);
}

/**
 * Lowest free port >= 8080 given the currently loaded instances. Reuses a
 * freed port (e.g. the instance that held 8081 was unloaded) instead of
 * always growing — simplest scheme that stays deterministic and correct.
 */
export function nextPort(existing: InstanceRecord[]): number {
  const used = new Set(existing.map((i) => i.port));
  let port = BASE_PORT;
  while (used.has(port)) port++;
  return port;
}

/** Base host (protocol + hostname, no port) derived from INFERENCE_URL. */
export function inferenceHostBase(): string {
  try {
    const u = new URL(INFERENCE_URL);
    return `${u.protocol}//${u.hostname}`;
  } catch {
    return "http://inference";
  }
}

export function instanceBaseUrl(port: number): string {
  return `${inferenceHostBase()}:${port}`;
}

export type InstanceHealth = "ready" | "loading" | "down";

/**
 * Poll a single instance's /health. 200 → ready; reachable-but-not-ok (llama.cpp
 * returns 503 while the model is still loading) → loading; unreachable → down.
 */
export async function pollInstanceHealth(port: number, timeoutMs = 2000): Promise<InstanceHealth> {
  try {
    const res = await fetch(`${instanceBaseUrl(port)}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok ? "ready" : "loading";
  } catch {
    return "down";
  }
}

export function findInstanceByFilename(filename: string, instances = readInstances()): InstanceRecord | undefined {
  return instances.find((i) => path.basename(i.modelPath) === filename);
}

export function findInstanceByPath(modelPath: string, instances = readInstances()): InstanceRecord | undefined {
  const resolved = path.resolve(modelPath);
  return instances.find((i) => path.resolve(i.modelPath) === resolved);
}

/**
 * Find an already-loaded instance whose FILENAME (basename) matches `modelPath`
 * but whose full path is DIFFERENT (CONTRACTS §6 `/api/models/load`: two loaded
 * models may never share a basename, since every routing key downstream —
 * `findInstanceByFilename`, `loadedFilenames`, the agent↔model binding — keys
 * on basename, not full path). Loading the SAME path again (an update-in-place)
 * is not a conflict with itself, so that case returns undefined.
 */
export function findBasenameConflict(modelPath: string, instances = readInstances()): InstanceRecord | undefined {
  const filename = path.basename(modelPath);
  const resolved = path.resolve(modelPath);
  return instances.find(
    (i) => path.basename(i.modelPath) === filename && path.resolve(i.modelPath) !== resolved,
  );
}

/** Filenames of every currently loaded instance — the "loaded set" (CONTRACTS §6). */
export function loadedFilenames(instances = readInstances()): Set<string> {
  return new Set(instances.map((i) => path.basename(i.modelPath)));
}

/** Build the API-facing `LoadedModel` view for one instance. */
export async function toLoadedModel(instance: InstanceRecord, modelRef?: ModelRef): Promise<LoadedModel> {
  const health = await pollInstanceHealth(instance.port);
  return {
    path: instance.modelPath,
    filename: path.basename(instance.modelPath),
    ctx: instance.ctx,
    port: instance.port,
    gpus: instance.gpus,
    fit: instance.fit ?? "fast",
    health,
    ...(modelRef ? { model: modelRef } : {}),
    ...(instance.tensorSplit ? { tensorSplit: instance.tensorSplit } : {}),
    ...(instance.reasoningBudget !== undefined ? { reasoningBudget: instance.reasoningBudget } : {}),
    ...(instance.mmprojPath !== undefined ? { mmprojPath: instance.mmprojPath } : {}),
    ...(instance.kvCache !== undefined ? { kvCache: instance.kvCache } : {}),
    ...(instance.nCpuMoe !== undefined ? { nCpuMoe: instance.nCpuMoe } : {}),
  };
}

export async function toLoadedModels(instances: InstanceRecord[], modelRefFor: (filename: string) => ModelRef | undefined): Promise<LoadedModel[]> {
  return Promise.all(instances.map((i) => toLoadedModel(i, modelRefFor(path.basename(i.modelPath)))));
}
