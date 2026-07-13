/** localStorage keys and shared app constants. */

export const ONBOARDING_DONE_KEY = "il.onboarding.done";

/** Last update version the user was toasted about (one toast per release). */
export const UPDATE_NOTIFIED_KEY = "il.update.notified";

/** Full preset list for agent prompt-budget picker (2k–32k, per CONTRACTS §6). */
export const CONTEXT_PRESETS = [
  { label: "2k", value: 2048 },
  { label: "4k", value: 4096 },
  { label: "8k", value: 8192 },
  { label: "16k", value: 16384 },
  { label: "32k", value: 32768 },
] as const;

/**
 * Fallback context options shown when `/api/models/context-options` is
 * unavailable (daemon mid-deploy). No fit metadata.
 */
export const CONTEXT_FALLBACK_OPTIONS = [
  { label: "4k", value: 4096 },
  { label: "8k", value: 8192 },
] as const;

/**
 * @deprecated Use CONTEXT_PRESETS — kept only to avoid breaking any
 * remaining references during the R2b transition.
 */
export const CONTEXT_OPTIONS = CONTEXT_PRESETS;

/** Suggested specialty chips for the agent editor (pinned list, click to add). */
export const SPECIALTY_SUGGESTIONS = [
  "Code review",
  "Research",
  "Writing",
  "Data analysis",
  "Planning",
  "Brainstorming",
  "Summarization",
  "Customer support",
  "Translation",
  "QA & testing",
] as const;

/** Human-facing tier labels for curated models. */
export const TIER_LABEL: Record<string, string> = {
  spark: "NVIDIA Spark · unified memory",
  "gpu-24gb": "24 GB GPU class",
  "gpu-10gb": "10–12 GB GPU class",
  cpu: "CPU / low-VRAM",
};

export const TIER_ORDER = ["spark", "gpu-24gb", "gpu-10gb", "cpu"] as const;
