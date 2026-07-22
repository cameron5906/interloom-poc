/**
 * Allocate output from the remaining physical window. This is deliberately
 * request-local: cumulative task usage never reduces a later request.
 */
export function allocateMaxTokens(
  requested: number | undefined,
  ctx: number | undefined,
  inputTokens?: number,
  modelMaximum?: number | null,
): number {
  const window = Math.max(128, Math.trunc(ctx ?? 4096));
  const available =
    inputTokens === undefined
      ? Math.max(1, Math.floor(window / 2))
      : Math.max(1, window - Math.max(0, Math.trunc(inputTokens)) - 32);
  return Math.max(
    1,
    Math.min(
      Math.trunc(requested ?? available),
      available,
      modelMaximum == null ? Number.MAX_SAFE_INTEGER : Math.max(1, Math.trunc(modelMaximum)),
    ),
  );
}
