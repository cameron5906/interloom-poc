/**
 * Pure helpers for rendering the curated model catalog (Local LLM Atlas v2).
 * No JSX — formatting, honest fit language, capability-chip classification, and
 * the GGUF repo-id joins that tie catalog entries to local files and downloads.
 */
import type { DownloadJob, LoadedModel, LocalModel } from "@interloom/protocol";
import type {
  CatalogArchitecture,
  CatalogCapabilities,
  CatalogModel,
  HfDetailFile,
  RegistryFit,
} from "../../../api/types.js";

/** Token count → compact "256K" / "128K" / "1M" (÷1024, matching the atlas prose). */
export function fmtTokens(n: number): string {
  if (n >= 1024 * 1024) {
    const m = n / (1024 * 1024);
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (n >= 1024) return `${Math.round(n / 1024)}K`;
  return String(n);
}

/** Billions-of-params → "35B" / "3.6B". */
function fmtB(n: number): string {
  return `${n}B`;
}

/** Parameter summary: "35B · 3B active" for MoE, "4B" dense, "4B active" when total unknown. */
export function fmtParams(a: CatalogArchitecture): string {
  const total = a.parameters_total_b;
  const active = a.parameters_active_b;
  if (total != null && active != null && active < total) {
    return `${fmtB(total)} · ${fmtB(active)} active`;
  }
  if (total != null) return fmtB(total);
  if (active != null) return `${fmtB(active)} active`;
  return "—";
}

/** True when a MoE model stores far more than it activates per token. */
export function isMoE(a: CatalogArchitecture): boolean {
  return (
    a.parameters_total_b != null &&
    a.parameters_active_b != null &&
    a.parameters_active_b < a.parameters_total_b
  );
}

// --- Fit verdicts (warm, honest language — DESIGN_NOTES "Models marketplace") ---

export type FitVerdict = RegistryFit["verdict"];

const FIT_LABELS: Record<FitVerdict, string> = {
  fast: "Fits fully on your GPU",
  spill: "Runs with system-RAM assist (slower)",
  cpu: "CPU-friendly",
  no: "Not practical on this rig",
};

const FIT_SHORT: Record<FitVerdict, string> = {
  fast: "Fits your GPU",
  spill: "RAM assist",
  cpu: "CPU-friendly",
  no: "Too big",
};

export function fitLabel(v: FitVerdict): string {
  return FIT_LABELS[v];
}

export function fitShort(v: FitVerdict): string {
  return FIT_SHORT[v];
}

/** Sort rank — best fit first. Unknown verdicts sort last. */
export function fitRank(v: FitVerdict | undefined): number {
  switch (v) {
    case "fast":
      return 0;
    case "spill":
      return 1;
    case "cpu":
      return 2;
    case "no":
      return 3;
    default:
      return 4;
  }
}

/** The "fits my rig" filter accepts everything the operator can actually run. */
export function fitsMyRig(v: FitVerdict | undefined): boolean {
  return v === "fast" || v === "spill" || v === "cpu";
}

// --- Capability chips ---

export type CapabilityKey = keyof CatalogCapabilities;

const CAP_ORDER: CapabilityKey[] = [
  "tool_use",
  "thinking",
  "vision",
  "audio",
  "structured_output",
];

const CAP_LABELS: Record<CapabilityKey, string> = {
  tool_use: "TOOLS",
  thinking: "THINKING",
  vision: "VISION",
  audio: "AUDIO",
  structured_output: "JSON",
};

const CAP_FULL_LABELS: Record<CapabilityKey, string> = {
  tool_use: "Tool use",
  thinking: "Thinking",
  vision: "Vision",
  audio: "Audio",
  structured_output: "Structured output",
};

export function capabilityLabel(key: CapabilityKey): string {
  return CAP_LABELS[key];
}

export function capabilityFullLabel(key: CapabilityKey): string {
  return CAP_FULL_LABELS[key];
}

/**
 * A native-level capability renders as a solid chip; runtime-sensitive /
 * prompted / implicit / limited levels render dashed (mirrors the estimated
 * convention: never present a soft guarantee as a hard one).
 */
export function isSolidLevel(level: string): boolean {
  return level.startsWith("native");
}

export interface CapabilityChip {
  key: CapabilityKey;
  label: string;
  level: string;
  solid: boolean;
}

/** Chips for every capability the model actually has (level ≠ none/absent). */
export function capabilityChips(caps: CatalogCapabilities): CapabilityChip[] {
  const chips: CapabilityChip[] = [];
  for (const key of CAP_ORDER) {
    const cap = caps[key];
    if (!cap || cap.level === "none") continue;
    chips.push({ key, label: CAP_LABELS[key], level: cap.level, solid: isSolidLevel(cap.level) });
  }
  return chips;
}

/** Detail rows: one per capability including the "none" ones, in a stable order. */
export function capabilityRows(
  caps: CatalogCapabilities,
): Array<{ key: CapabilityKey; cap: CatalogCapabilities[CapabilityKey] }> {
  const order: CapabilityKey[] = [
    "structured_output",
    "tool_use",
    "thinking",
    "vision",
    "audio",
  ];
  return order.filter((k) => caps[k]).map((key) => ({ key, cap: caps[key] }));
}

// --- GGUF repo joins ---

const NON_REPO_SEGMENTS = new Set(["models", "collections", "datasets", "spaces", "search"]);

/** Parse `owner/name` from a huggingface.co model URL; null for search/collection URLs. */
export function ggufRepoId(url: string): string | null {
  try {
    const u = new URL(url);
    if (!/huggingface\.co$/i.test(u.hostname)) return null;
    const segs = u.pathname.split("/").filter(Boolean);
    if (segs.length !== 2) return null;
    if (NON_REPO_SEGMENTS.has(segs[0]!.toLowerCase())) return null;
    return `${segs[0]}/${segs[1]}`;
  } catch {
    return null;
  }
}

/** Every parseable GGUF repo id for a catalog model (the join key to ModelRef). */
export function catalogGgufRepoIds(model: CatalogModel): string[] {
  const ids: string[] = [];
  for (const link of model.links.gguf) {
    const id = ggufRepoId(link.url);
    if (id) ids.push(id);
  }
  return ids;
}

/**
 * The model-fetcher stores downloads at `MODELS_DIR/<owner__name>/<file>`, so a
 * local file's origin repo is recoverable from its parent directory.
 */
export function repoIdFromLocalPath(path: string): string | null {
  const parts = path.split(/[/\\]/).filter(Boolean);
  if (parts.length < 2) return null;
  const dir = parts[parts.length - 2]!;
  if (!dir.includes("__")) return null;
  return dir.replace("__", "/");
}

/** Find the catalog entry a local model belongs to (by encoded repo id). */
export function catalogModelForPath(
  models: CatalogModel[],
  path: string,
): CatalogModel | undefined {
  const repoId = repoIdFromLocalPath(path);
  if (!repoId) return undefined;
  const lc = repoId.toLowerCase();
  return models.find((m) => catalogGgufRepoIds(m).some((r) => r.toLowerCase() === lc));
}

// --- GGUF trust badges (taxonomy gguf_status) ---

const TRUST_LABELS: Record<string, string> = {
  official: "OFFICIAL",
  community_verified: "VERIFIED",
  community: "COMMUNITY",
  discovery: "DISCOVERY",
};

export function trustLabel(status: string): string {
  return TRUST_LABELS[status] ?? status.toUpperCase();
}

/** Trust ordering — most trustworthy first (drives default repo selection). */
export function trustRank(status: string): number {
  switch (status) {
    case "official":
      return 0;
    case "community_verified":
      return 1;
    case "community":
      return 2;
    case "discovery":
      return 3;
    default:
      return 4;
  }
}

// --- Quant file recommendation ---

/** Pick the Q4_K_M-class file (fallback: any Q4, then the first file). */
export function recommendedQuantFile(files: HfDetailFile[]): HfDetailFile | undefined {
  if (files.length === 0) return undefined;
  return (
    files.find((f) => /q4_k_m/i.test(f.quant) || /q4_k_m/i.test(f.filename)) ??
    files.find((f) => /q4/i.test(f.quant) || /q4/i.test(f.filename)) ??
    files[0]
  );
}

// --- Card-level install state (aggregated across a model's GGUF repos) ---

export type CatalogCardState = "not-installed" | "queued" | "downloading" | "installed" | "loaded";

/**
 * Aggregate install state for a catalog card: a model counts as installed when
 * any local file traces back to one of its GGUF repos, loaded when that file is
 * among the loaded instances (CONTRACTS §6 — N models load at once, so this is a
 * membership check against the loaded set), and downloading when a job targets
 * one of its repos.
 */
export function catalogCardState(
  model: CatalogModel,
  downloads: DownloadJob[],
  localModels: LocalModel[],
  loadedModels: LoadedModel[],
): CatalogCardState {
  const repoIds = catalogGgufRepoIds(model).map((r) => r.toLowerCase());
  if (repoIds.length === 0) return "not-installed";

  const job = downloads.find(
    (d) =>
      repoIds.includes(d.repoId.toLowerCase()) &&
      d.status !== "done" &&
      d.status !== "error",
  );
  if (job) return job.status === "queued" ? "queued" : "downloading";

  const local = localModels.find((m) => {
    const r = repoIdFromLocalPath(m.path);
    return r != null && repoIds.includes(r.toLowerCase());
  });
  if (local) {
    if (loadedModels.some((m) => m.path === local.path)) return "loaded";
    return "installed";
  }
  return "not-installed";
}
