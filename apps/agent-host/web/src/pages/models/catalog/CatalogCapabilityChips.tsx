import type { CatalogCapabilities } from "../../../api/types.js";
import { capabilityChips } from "./catalogHelpers.js";

interface CatalogCapabilityChipsProps {
  capabilities: CatalogCapabilities;
  size?: "sm" | "md";
}

/**
 * Capability chips for a catalog model. Solid chips = native-level support;
 * dashed chips = runtime-sensitive / prompted (the same visual grammar the
 * portal uses for estimated capabilities — a soft guarantee never looks hard).
 */
export function CatalogCapabilityChips({ capabilities, size = "md" }: CatalogCapabilityChipsProps) {
  const chips = capabilityChips(capabilities);
  if (chips.length === 0) return null;
  return (
    <span className={`il-capbadges il-capbadges--${size}`}>
      {chips.map((c) => (
        <span
          key={c.key}
          className={`il-capbadge il-capbadge--${c.key}${c.solid ? "" : " il-capbadge--est"}`}
          title={c.solid ? undefined : `${c.level.replace(/_/g, " ")} — runtime-dependent`}
        >
          {c.label}
        </span>
      ))}
    </span>
  );
}
