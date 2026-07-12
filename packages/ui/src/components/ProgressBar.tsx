import type { HTMLAttributes } from "react";

export type ProgressTone = "accent" | "success" | "warning" | "danger" | "active";

export interface ProgressBarProps extends HTMLAttributes<HTMLDivElement> {
  /** Fraction complete, 0..1. Values are clamped. */
  value: number;
  tone?: ProgressTone;
}

export function ProgressBar({ value, tone = "accent", className, ...rest }: ProgressBarProps) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  const classes = ["il-progress", `il-progress--${tone}`, className].filter(Boolean).join(" ");
  return (
    <div
      className={classes}
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      {...rest}
    >
      <div className="il-progress__fill" style={{ width: `${pct}%` }} />
    </div>
  );
}
