import type { HTMLAttributes, ReactNode } from "react";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  interactive?: boolean;
  children?: ReactNode;
}

export function Card({ interactive = false, className, children, ...rest }: CardProps) {
  const classes = ["il-card", interactive && "il-card--interactive", className]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={classes} {...rest}>
      {children}
    </div>
  );
}
