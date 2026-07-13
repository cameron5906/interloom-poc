import type { AvatarCharacter } from "@interloom/protocol";
import { BACKGROUND_PALETTE } from "../../../../lib/notionists.js";

interface BackgroundSectionProps {
  character: AvatarCharacter;
  onPick: (hex: string) => void;
}

export function BackgroundSection({ character, onPick }: BackgroundSectionProps) {
  return (
    <div className="il-charcust__section-body">
      <div className="il-charcust__swatches" role="group" aria-label="Background color">
        {BACKGROUND_PALETTE.map((hex) => (
          <button
            key={hex}
            type="button"
            className={`il-charcust__swatch${
              character.backgroundColor === hex ? " il-charcust__swatch--sel" : ""
            }`}
            style={{ background: `#${hex}` }}
            onClick={() => onPick(hex)}
            aria-pressed={character.backgroundColor === hex}
            aria-label={`Background #${hex}`}
          />
        ))}
      </div>
    </div>
  );
}
