import type { ReactNode } from "react";

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  hint?: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, hint, action, className }: EmptyStateProps) {
  const classes = ["il-empty", className].filter(Boolean).join(" ");
  return (
    <div className={classes}>
      {icon ? <div className="il-empty__icon">{icon}</div> : null}
      <div className="il-empty__title">{title}</div>
      {hint ? <div className="il-empty__hint">{hint}</div> : null}
      {action ? <div className="il-empty__action">{action}</div> : null}
    </div>
  );
}
