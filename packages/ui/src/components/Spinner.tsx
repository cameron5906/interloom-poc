export type SpinnerSize = "sm" | "md" | "lg";

export interface SpinnerProps {
  size?: SpinnerSize;
  className?: string;
  label?: string;
}

const SIZE_PX: Record<SpinnerSize, number> = { sm: 14, md: 20, lg: 32 };

export function Spinner({ size = "md", className, label = "Loading" }: SpinnerProps) {
  const px = SIZE_PX[size];
  const classes = ["il-spinner", className].filter(Boolean).join(" ");
  return (
    <span className={classes} style={{ width: px, height: px }} role="status" aria-label={label} />
  );
}
