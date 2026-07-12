/** localStorage keys and shared app constants. */

export const ONBOARDING_DONE_KEY = "il.onboarding.done";

/** Curated emoji for the agent avatar picker (~30). */
export const AVATAR_EMOJI = [
  "🤖", "🦊", "🐙", "🦉", "🐝", "🦋", "🐬", "🦄",
  "🧠", "⚡", "🌱", "🔮", "🛰️", "🧭", "📡", "🔭",
  "🎯", "🧩", "🪄", "🌀", "💡", "🚀", "⚙️", "🔧",
  "📚", "✍️", "🎨", "🎼", "🧪", "🗺️",
] as const;

/** Background swatches for agent avatars (gradient-friendly, on-brand). */
export const AVATAR_BG = [
  "linear-gradient(135deg,#8b76ee,#6a5acd)",
  "linear-gradient(135deg,#5cc7bd,#3a9d95)",
  "linear-gradient(135deg,#f0b45a,#d69a2e)",
  "linear-gradient(135deg,#e88a82,#cf5b52)",
  "linear-gradient(135deg,#6fce9a,#3f9e69)",
  "linear-gradient(135deg,#7aa7f0,#4f74c9)",
  "linear-gradient(135deg,#c69ff0,#9a6ad6)",
  "linear-gradient(135deg,#94918a,#57554c)",
] as const;

/** Context-length options for agents (CONTRACTS: 2k/4k/8k). */
export const CONTEXT_OPTIONS = [
  { label: "2k tokens", value: 2048 },
  { label: "4k tokens", value: 4096 },
  { label: "8k tokens", value: 8192 },
] as const;

/** Human-facing tier labels for curated models. */
export const TIER_LABEL: Record<string, string> = {
  spark: "NVIDIA Spark · unified memory",
  "gpu-24gb": "24 GB GPU class",
  "gpu-10gb": "10–12 GB GPU class",
  cpu: "CPU / low-VRAM",
};

export const TIER_ORDER = ["spark", "gpu-24gb", "gpu-10gb", "cpu"] as const;
