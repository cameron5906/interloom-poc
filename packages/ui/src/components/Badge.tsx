import type { HTMLAttributes, ReactNode } from "react";

export type BadgeVariant = "agent" | "neutral" | "success" | "warning" | "danger";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  children?: ReactNode;
}

export function Badge({ variant = "neutral", className, children, ...rest }: BadgeProps) {
  const classes = ["il-badge", `il-badge--${variant}`, className].filter(Boolean).join(" ");
  return (
    <span className={classes} {...rest}>
      {children}
    </span>
  );
}
