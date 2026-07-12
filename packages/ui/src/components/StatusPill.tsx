import type { HTMLAttributes, ReactNode } from "react";

export type StatusPillTone = "neutral" | "success" | "warning" | "danger" | "accent" | "active";

export interface StatusPillProps extends HTMLAttributes<HTMLSpanElement> {
  live?: boolean;
  tone?: StatusPillTone;
  children?: ReactNode;
}

export function StatusPill({
  live = false,
  tone = "neutral",
  className,
  children,
  ...rest
}: StatusPillProps) {
  const classes = ["il-pill", `il-pill--${tone}`, className].filter(Boolean).join(" ");
  return (
    <span className={classes} {...rest}>
      <span className={`il-pill__dot${live ? " il-pill__dot--live" : ""}`} />
      {children}
    </span>
  );
}
