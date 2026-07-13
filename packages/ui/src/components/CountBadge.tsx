export interface CountBadgeProps {
  count: number;
  /** Cap display at this value, rendering e.g. "9+" beyond it. */
  max?: number;
  className?: string;
}

/** Small numeric notification pill (e.g. pending approvals on a nav item). Renders nothing at 0. */
export function CountBadge({ count, max = 9, className }: CountBadgeProps) {
  if (count <= 0) return null;
  const label = count > max ? `${max}+` : String(count);
  const classes = ["il-count-badge", className].filter(Boolean).join(" ");
  return (
    <span className={classes} aria-label={`${count} pending`}>
      {label}
    </span>
  );
}
