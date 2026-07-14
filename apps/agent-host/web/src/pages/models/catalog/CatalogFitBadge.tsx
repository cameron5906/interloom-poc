import type { FitVerdict } from "./catalogHelpers.js";
import { fitLabel, fitShort } from "./catalogHelpers.js";

interface CatalogFitBadgeProps {
  verdict: FitVerdict | undefined;
  /** Optional daemon note (rendered as a tooltip). */
  note?: string;
  /** `short` = compact card badge; `full` = detail label. */
  variant?: "short" | "full";
}

/** Honest, warm fit badge keyed to the daemon's verdict against this rig. */
export function CatalogFitBadge({ verdict, note, variant = "short" }: CatalogFitBadgeProps) {
  if (!verdict) {
    return <span className="il-fit il-fit--unknown">Fit unknown</span>;
  }
  const label = variant === "full" ? fitLabel(verdict) : fitShort(verdict);
  return (
    <span className={`il-fit il-fit--${verdict}`} title={note || fitLabel(verdict)}>
      <span className="il-fit__dot" aria-hidden />
      {label}
    </span>
  );
}
