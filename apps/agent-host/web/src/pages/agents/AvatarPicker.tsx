import { Avatar } from "@interloom/ui";
import { AVATAR_EMOJI, AVATAR_BG } from "../../lib/constants.js";

interface AvatarPickerProps {
  name: string;
  emoji: string;
  bg: string;
  onChange: (next: { emoji: string; bg: string }) => void;
}

export function AvatarPicker({ name, emoji, bg, onChange }: AvatarPickerProps) {
  return (
    <div className="il-avpick">
      <div className="il-avpick__preview">
        <Avatar name={name || "Agent"} isAgent emoji={emoji} bg={bg} size="lg" />
      </div>

      <div className="il-avpick__controls">
        <div className="il-avpick__grid" role="group" aria-label="Choose an emoji">
          {AVATAR_EMOJI.map((e) => (
            <button
              key={e}
              type="button"
              className={`il-avpick__emoji${e === emoji ? " il-avpick__emoji--sel" : ""}`}
              onClick={() => onChange({ emoji: e, bg })}
              aria-pressed={e === emoji}
              aria-label={`Emoji ${e}`}
            >
              {e}
            </button>
          ))}
        </div>

        <div className="il-avpick__swatches" role="group" aria-label="Choose a background">
          {AVATAR_BG.map((b) => (
            <button
              key={b}
              type="button"
              className={`il-avpick__swatch${b === bg ? " il-avpick__swatch--sel" : ""}`}
              style={{ background: b }}
              onClick={() => onChange({ emoji, bg: b })}
              aria-pressed={b === bg}
              aria-label="Background color"
            />
          ))}
        </div>
      </div>
    </div>
  );
}
