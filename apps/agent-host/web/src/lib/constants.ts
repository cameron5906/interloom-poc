/** localStorage keys and shared app constants. */

export const ONBOARDING_DONE_KEY = "il.onboarding.done";

/** Last update version the user was toasted about (one toast per release). */
export const UPDATE_NOTIFIED_KEY = "il.update.notified";

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
