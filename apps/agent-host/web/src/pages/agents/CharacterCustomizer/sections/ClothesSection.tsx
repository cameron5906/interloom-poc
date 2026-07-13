import { ComponentPicker } from "../ComponentPicker.js";
import type { SectionProps } from "./SectionProps.js";

export function ClothesSection({ character, pack, onPick }: SectionProps) {
  return (
    <div className="il-charcust__section-body">
      <ComponentPicker
        label="Clothes"
        character={character}
        componentKey="body"
        values={pack.body}
        onPick={(v) => onPick("body", v)}
      />
    </div>
  );
}
