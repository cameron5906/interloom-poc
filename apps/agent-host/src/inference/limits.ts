/**
 * Bound max_tokens so a reply can never exceed the loaded context window.
 * The instance sends its tier-derived reply budget as `maxTokens`; unknown
 * callers get the historical 512 default. Floor 128 so generation stays viable.
 *
 * Standard inference admits the instance's 4096-token work rounds
 * (CONTRACTS §13.6) so source-bearing tool calls are not cut in half. Chat
 * remains on its shorter instance-requested budgets. Thinking-capable models
 * (CONTRACTS §6.1) retain a higher 8192 ceiling so reasoning tokens don't
 * crowd out the visible answer. `thinking` should be false whenever the
 * model's settings have `disableThinking` set, even if the model is
 * capability-thinking.
 */
export function clampMaxTokens(
  requested: number | undefined,
  ctx: number | undefined,
  thinking = false,
): number {
  const windowCap = Math.max(128, Math.floor((ctx ?? 4096) / 2));
  const hardCeiling = thinking ? 8192 : 4096;
  return Math.min(requested ?? 512, hardCeiling, windowCap);
}
