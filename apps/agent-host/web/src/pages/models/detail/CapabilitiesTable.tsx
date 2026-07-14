import type { CatalogCapabilities, CatalogTaxonomy } from "../../../api/types.js";
import { capabilityFullLabel, capabilityRows, isSolidLevel } from "../catalog/catalogHelpers.js";

interface CapabilitiesTableProps {
  capabilities: CatalogCapabilities;
  taxonomy: CatalogTaxonomy;
}

/** One row per capability: level chip (solid=native, dashed=runtime-dependent),
 * the meaning of that level from the taxonomy, and the model's own notes. */
export function CapabilitiesTable({ capabilities, taxonomy }: CapabilitiesTableProps) {
  const rows = capabilityRows(capabilities);
  return (
    <div className="il-captable">
      {rows.map(({ key, cap }) => {
        if (!cap) return null;
        const none = cap.level === "none";
        const meaning = taxonomy.capability_levels[cap.level];
        return (
          <div key={key} className={`il-captable__row${none ? " il-captable__row--none" : ""}`}>
            <div className="il-captable__label">{capabilityFullLabel(key)}</div>
            <div className="il-captable__body">
              <span
                className={[
                  "il-levelchip",
                  none ? "il-levelchip--none" : isSolidLevel(cap.level) ? "il-levelchip--native" : "il-levelchip--soft",
                ].join(" ")}
                title={meaning}
              >
                {cap.level.replace(/_/g, " ")}
              </span>
              {cap.notes ? <p className="il-captable__notes">{cap.notes}</p> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
