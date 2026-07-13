import type { GpuInfo, ModelCapabilities } from "@interloom/protocol";
import { estimateCapabilities, isMmprojFilename, pickMmproj } from "./capabilities.js";
import { fitTier } from "./fit.js";

/** Rail row for `GET /api/models/search` (CONTRACTS §6). */
export interface HfSearchRow {
  repoId: string;
  likes: number;
  downloads: number;
  paramsB?: number;
  trainedCtx?: number;
  capabilities?: ModelCapabilities;
}

export interface HfRepoDetail {
  repoId: string;
  likes: number;
  downloads: number;
  trainedCtx?: number;
  lastModified?: string;
  capabilities?: ModelCapabilities;
  mmprojFilename?: string;
  files: Array<{ filename: string; sizeBytes: number; quant: string; maxFastCtx?: number }>;
}

interface HfListItem {
  id?: string;
  modelId?: string;
  downloads?: number;
  likes?: number;
  tags?: string[];
  gguf?: { context_length?: number; chat_template?: string };
}

interface HfDetailRaw {
  downloads?: number;
  likes?: number;
  lastModified?: string;
  tags?: string[];
  gguf?: {
    context_length?: number;
    chat_template?: string;
    block_count?: number;
    head_count_kv?: number;
    head_count?: number;
    embedding_length?: number;
    key_length?: number;
  };
  siblings?: Array<{ rfilename: string; size?: number }>;
}

/** "8B" / "1.5b" size token in a repo name; not quant markers like q4_k_m. */
export function paramsFromRepoId(repoId: string): number | undefined {
  const m = /(?:^|[^a-z0-9])(\d+(?:\.\d+)?)\s*b(?![a-z0-9])/i.exec(repoId);
  return m ? Number(m[1]) : undefined;
}

/** Quant token from a GGUF filename: last [-.]-delimited segment starting i?Q<digit> ("Q4_K_M", "IQ4_XS"); "" when absent. */
function extractQuant(filename: string): string {
  const base = filename.replace(/\.gguf$/i, "");
  const segments = base.split(/[-.]/);
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i]!;
    if (/^i?q[0-9]/i.test(segment)) return segment;
  }
  return "";
}

export function mapSearchRows(items: HfListItem[]): HfSearchRow[] {
  return items.map((m) => {
    const repoId = m.modelId ?? m.id ?? "";
    const trainedCtx = m.gguf?.context_length;
    const paramsB = paramsFromRepoId(repoId);
    return {
      repoId,
      likes: m.likes ?? 0,
      downloads: m.downloads ?? 0,
      ...(paramsB !== undefined ? { paramsB } : {}),
      ...(trainedCtx !== undefined ? { trainedCtx } : {}),
      capabilities: estimateCapabilities({
        repoId,
        tags: m.tags,
        chatTemplate: m.gguf?.chat_template,
      }),
    };
  });
}

const CAP_CTX = 131072;

/** Largest power-of-two ctx (≥4096, ≤trainedMax) that fits `fast`; null when none. */
export function maxFastCtx(input: {
  fileSizeBytes: number;
  trainedMax: number;
  gpus: GpuInfo[];
  unifiedMemoryMB?: number;
  arch?: { layers: number; kvHeads: number; headDim: number };
}): number | null {
  const { fileSizeBytes, trainedMax, gpus, unifiedMemoryMB, arch } = input;
  let best: number | null = null;
  for (let ctx = 4096; ctx <= Math.min(trainedMax, CAP_CTX); ctx *= 2) {
    let fits: boolean;
    if (arch) {
      fits =
        fitTier({
          fileSizeBytes,
          gpus,
          unifiedMemoryMB,
          layers: arch.layers,
          kvHeads: arch.kvHeads,
          headDim: arch.headDim,
          ctx,
        }) === "fast";
    } else {
      const kvBytesPerToken = (fileSizeBytes / 1024 ** 3) * 12_000;
      fits =
        fitTier({
          fileSizeBytes: fileSizeBytes + kvBytesPerToken * ctx,
          gpus,
          unifiedMemoryMB,
          layers: 0,
          kvHeads: 0,
          headDim: 0,
          ctx: 0,
        }) === "fast";
    }
    if (fits) best = ctx;
  }
  return best;
}

export function buildRepoDetail(
  repoId: string,
  raw: HfDetailRaw,
  sys: { gpus: GpuInfo[]; unifiedMemoryMB?: number },
): HfRepoDetail {
  const siblings = (raw.siblings ?? []).filter((s) => s.rfilename.endsWith(".gguf"));
  const siblingFilenames = siblings.map((s) => s.rfilename);
  const mmproj = pickMmproj(
    siblings.map((s) => ({ filename: s.rfilename, sizeBytes: s.size ?? 0 })),
  );
  const trainedCtx = raw.gguf?.context_length;

  const g = raw.gguf;
  const headDim =
    g?.key_length && g.key_length > 0
      ? g.key_length
      : g?.embedding_length && g?.head_count
        ? Math.floor(g.embedding_length / g.head_count)
        : undefined;
  const arch =
    g?.block_count && (g.head_count_kv ?? g.head_count) && headDim
      ? {
          layers: g.block_count,
          kvHeads: g.head_count_kv ?? g.head_count!,
          headDim,
        }
      : undefined;

  const files = siblings
    .filter((s) => !isMmprojFilename(s.rfilename))
    .map((s) => {
      const sizeBytes = s.size ?? 0;
      const fast =
        sizeBytes > 0 && trainedCtx
          ? maxFastCtx({ fileSizeBytes: sizeBytes, trainedMax: trainedCtx, gpus: sys.gpus, unifiedMemoryMB: sys.unifiedMemoryMB, arch })
          : null;
      return {
        filename: s.rfilename,
        sizeBytes,
        quant: extractQuant(s.rfilename),
        ...(fast !== null ? { maxFastCtx: fast } : {}),
      };
    });

  return {
    repoId,
    likes: raw.likes ?? 0,
    downloads: raw.downloads ?? 0,
    ...(trainedCtx !== undefined ? { trainedCtx } : {}),
    ...(raw.lastModified !== undefined ? { lastModified: raw.lastModified } : {}),
    capabilities: estimateCapabilities({
      repoId,
      tags: raw.tags,
      siblingFilenames,
      chatTemplate: raw.gguf?.chat_template,
    }),
    ...(mmproj ? { mmprojFilename: mmproj.filename } : {}),
    files,
  };
}
