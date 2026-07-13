import { ComponentPicker } from "../ComponentPicker.js";
import type { SectionProps } from "./SectionProps.js";

export function HairSection({ character, pack, onPick }: SectionProps) {
  return (
    <div className="il-charcust__section-body">
      <ComponentPicker
        label="Hair"
        character={character}
        componentKey="hair"
        values={pack.hair}
        onPick={(v) => onPick("hair", v)}
      />
      {pack.beard.length > 0 ? (
        <ComponentPicker
          label="Beard"
          character={character}
          componentKey="beard"
          values={pack.beard}
          optional
          onPick={(v) => onPick("beard", v)}
        />
      ) : null}
    </div>
  );
}
