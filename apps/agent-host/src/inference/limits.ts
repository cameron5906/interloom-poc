/**
 * Bound max_tokens so a reply can never exceed the loaded context window.
 * The instance sends its tier-derived reply budget as `maxTokens`; unknown
 * callers get the historical 512 default. Hard ceiling 1024 (PoC chat replies),
 * half-window ceiling for small windows, floor 128 so generation stays viable.
 */
export function clampMaxTokens(
  requested: number | undefined,
  ctx: number | undefined,
): number {
  const windowCap = Math.max(128, Math.floor((ctx ?? 4096) / 2));
  return Math.min(requested ?? 512, 1024, windowCap);
}
