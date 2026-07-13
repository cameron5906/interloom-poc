import { ComponentPicker } from "../ComponentPicker.js";
import type { SectionProps } from "./SectionProps.js";

export function FaceSection({ character, pack, onPick }: SectionProps) {
  return (
    <div className="il-charcust__section-body">
      <ComponentPicker
        label="Eyebrows"
        character={character}
        componentKey="brows"
        values={pack.brows}
        onPick={(v) => onPick("brows", v)}
      />
      <ComponentPicker
        label="Eyes"
        character={character}
        componentKey="eyes"
        values={pack.eyes}
        onPick={(v) => onPick("eyes", v)}
      />
      <ComponentPicker
        label="Mouth"
        character={character}
        componentKey="lips"
        values={pack.lips}
        onPick={(v) => onPick("lips", v)}
      />
      <ComponentPicker
        label="Nose"
        character={character}
        componentKey="nose"
        values={pack.nose}
        onPick={(v) => onPick("nose", v)}
      />
    </div>
  );
}
