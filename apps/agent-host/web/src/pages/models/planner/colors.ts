/** Stable warm-palette color per loaded model index — shared across both GPU
 * bars and the bridge connector so a fused model reads as one color everywhere. */
const MODEL_PALETTE = [
  "var(--il-accent)",
  "var(--il-agent)",
  "var(--il-warning)",
  "var(--il-success)",
  "#8a5fb0",
  "#3f7ea8",
] as const;

export function modelColor(index: number): string {
  return MODEL_PALETTE[index % MODEL_PALETTE.length]!;
}
