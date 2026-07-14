/** localStorage keys and shared app constants. */

export const ONBOARDING_DONE_KEY = "il.onboarding.done";

/** Last update version the user was toasted about (one toast per release). */
export const UPDATE_NOTIFIED_KEY = "il.update.notified";

/** Full preset list for the agent prompt-budget picker (2k–32k, per CONTRACTS §6). */
export const CONTEXT_PRESETS = [
  { label: "2k", value: 2048 },
  { label: "4k", value: 4096 },
  { label: "8k", value: 8192 },
  { label: "16k", value: 16384 },
  { label: "32k", value: 32768 },
] as const;

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
