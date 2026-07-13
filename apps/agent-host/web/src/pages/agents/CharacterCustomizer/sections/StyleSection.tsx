import { ComponentPicker } from "../ComponentPicker.js";
import type { SectionProps } from "./SectionProps.js";

export function StyleSection({ character, pack, onPick }: SectionProps) {
  return (
    <div className="il-charcust__section-body">
      <ComponentPicker
        label="Glasses"
        character={character}
        componentKey="glasses"
        values={pack.glasses}
        optional
        onPick={(v) => onPick("glasses", v)}
      />
      <ComponentPicker
        label="Gesture"
        character={character}
        componentKey="gesture"
        values={pack.gesture}
        optional
        onPick={(v) => onPick("gesture", v)}
      />
      <ComponentPicker
        label="Clothes graphic"
        character={character}
        componentKey="bodyIcon"
        values={pack.bodyIcon}
        optional
        onPick={(v) => onPick("bodyIcon", v)}
      />
    </div>
  );
}
