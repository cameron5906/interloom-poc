import type { ModelCapabilities } from "@interloom/protocol";
import type { GgufMeta } from "./gguf.js";

/**
 * Capability detection (CONTRACTS §4). Local files: definitive from the GGUF
 * header. Search results: estimates from names/tags/siblings — callers must
 * render estimates as such. A null header parse yields undefined (unknown),
 * never a guessed capability set.
 */

const TOOL_TEMPLATE_MARKERS = [/\btools\b/, /tool_calls/];
const THINK_TEMPLATE_MARKERS = [/<think>/, /enable_thinking/, /reasoning_content/];

const THINKING_FAMILIES = /(deepseek[-_]?r1|qwq|qwen[-_]?3|openthinker|magistral|smallthinker)/i;
const TOOL_FAMILIES =
  /(qwen[-_]?2\.5|qwen[-_]?3|llama[-_]?3\.[123]|mistral|ministral|hermes|functionary|command[-_]?r|granite)/i;
const VISION_ARCHES = /(llava|qwen2vl|qwen2\.5vl|mllama|smolvlm|idefics|paligemma|pixtral|minicpmv)/i;
const VISION_TAGS = new Set(["image-text-to-text", "visual-question-answering", "image-to-text"]);
const MMPROJ = /mmproj/i;

/** Corrections where headers or heuristics are known-wrong. Wins last. */
const OVERRIDES: Array<{ pattern: RegExp; set: Partial<ModelCapabilities> }> = [
  { pattern: /gemma[-_]?2/i, set: { tools: false } },
  { pattern: /phi[-_]?3/i, set: { tools: false } },
];

function applyOverrides(name: string, caps: ModelCapabilities): ModelCapabilities {
  let out = caps;
  for (const o of OVERRIDES) {
    if (o.pattern.test(name)) out = { ...out, ...o.set };
  }
  return out;
}

export function isMmprojFilename(filename: string): boolean {
  return MMPROJ.test(filename);
}

/** Prefer the f16 projector, else the largest. Null when none present. */
export function pickMmproj(
  files: Array<{ filename: string; sizeBytes: number }>,
): { filename: string; sizeBytes: number } | null {
  const projectors = files.filter((f) => isMmprojFilename(f.filename));
  if (projectors.length === 0) return null;
  const f16 = projectors.find((f) => /f16/i.test(f.filename));
  if (f16) return f16;
  return projectors.reduce((a, b) => (b.sizeBytes > a.sizeBytes ? b : a));
}

export function detectCapabilities(input: {
  meta: GgufMeta | null;
  filename: string;
  repoId?: string;
  siblingFilenames?: string[];
}): ModelCapabilities | undefined {
  const { meta, filename, repoId, siblingFilenames } = input;
  if (!meta) return undefined;
  const template = meta.chatTemplate ?? "";
  const name = `${repoId ?? ""} ${filename} ${meta.architecture}`;
  const caps: ModelCapabilities = {
    tools: TOOL_TEMPLATE_MARKERS.some((re) => re.test(template)),
    vision:
      VISION_ARCHES.test(meta.architecture) ||
      VISION_ARCHES.test(name) ||
      (siblingFilenames ?? []).some((f) => isMmprojFilename(f)),
    thinking:
      THINK_TEMPLATE_MARKERS.some((re) => re.test(template)) || THINKING_FAMILIES.test(name),
  };
  return applyOverrides(name, caps);
}

export function estimateCapabilities(input: {
  repoId: string;
  tags?: string[];
  siblingFilenames?: string[];
  chatTemplate?: string;
}): ModelCapabilities {
  const { repoId, tags, siblingFilenames, chatTemplate } = input;
  const caps: ModelCapabilities = {
    tools: chatTemplate
      ? TOOL_TEMPLATE_MARKERS.some((re) => re.test(chatTemplate))
      : TOOL_FAMILIES.test(repoId),
    vision:
      VISION_ARCHES.test(repoId) ||
      (tags ?? []).some((t) => VISION_TAGS.has(t)) ||
      (siblingFilenames ?? []).some((f) => isMmprojFilename(f)),
    thinking: chatTemplate
      ? THINK_TEMPLATE_MARKERS.some((re) => re.test(chatTemplate)) || THINKING_FAMILIES.test(repoId)
      : THINKING_FAMILIES.test(repoId),
  };
  return applyOverrides(repoId, caps);
}
