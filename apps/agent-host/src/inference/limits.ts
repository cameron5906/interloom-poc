/**
 * Bound max_tokens so a reply can never exceed the loaded context window.
 * The instance sends its tier-derived reply budget as `maxTokens`; unknown
 * callers get the historical 512 default. Floor 128 so generation stays viable.
 *
 * Thinking-capable models (CONTRACTS §6.1) get reply-budget headroom: their
 * ceiling rises from 1024 to 4096 so reasoning tokens don't crowd out the
 * visible answer. `thinking` should be false whenever the model's settings
 * have `disableThinking` set, even if the model is capability-thinking.
 */
export function clampMaxTokens(
  requested: number | undefined,
  ctx: number | undefined,
  thinking = false,
): number {
  const windowCap = Math.max(128, Math.floor((ctx ?? 4096) / 2));
  const hardCeiling = thinking ? 4096 : 1024;
  return Math.min(requested ?? 512, hardCeiling, windowCap);
}
