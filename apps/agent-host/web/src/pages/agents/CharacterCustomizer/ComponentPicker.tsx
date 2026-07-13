import { useMemo } from "react";
import type { AvatarCharacter, NotionistsOptions } from "@interloom/protocol";
import { svgFor } from "../../../lib/character.js";

const THUMB_SIZE = 96;

type ComponentKey = keyof NotionistsOptions;

interface ComponentPickerProps {
  label: string;
  character: AvatarCharacter;
  componentKey: ComponentKey;
  values: string[];
  /** Shows a leading "None" thumbnail that clears the piece. */
  optional?: boolean;
  onPick: (value: string | undefined) => void;
}

/**
 * A labeled grid of thumbnails for one DiceBear component. Each thumbnail
 * renders the CURRENT character with only this component swapped, so picking
 * a piece is a true preview rather than an abstract swatch.
 */
export function ComponentPicker({
  label,
  character,
  componentKey,
  values,
  optional,
  onPick,
}: ComponentPickerProps) {
  const current = character.options[componentKey];

  return (
    <div className="il-charcust__picker">
      <div className="il-charcust__picker-label">{label}</div>
      <div className="il-charcust__grid">
        {optional ? (
          <VariantThumb
            character={character}
            componentKey={componentKey}
            value={undefined}
            selected={current === undefined}
            onClick={() => onPick(undefined)}
          />
        ) : null}
        {values.map((value) => (
          <VariantThumb
            key={value}
            character={character}
            componentKey={componentKey}
            value={value}
            selected={current === value}
            onClick={() => onPick(value)}
          />
        ))}
      </div>
    </div>
  );
}

function VariantThumb({
  character,
  componentKey,
  value,
  selected,
  onClick,
}: {
  character: AvatarCharacter;
  componentKey: ComponentKey;
  value: string | undefined;
  selected: boolean;
  onClick: () => void;
}) {
  const dataUri = useMemo(() => {
    if (value === undefined) return null;
    const options: NotionistsOptions = { ...character.options, [componentKey]: value };
    const svg = svgFor({ ...character, options }, THUMB_SIZE);
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  }, [character, componentKey, value]);

  return (
    <button
      type="button"
      className={`il-charcust__thumb${selected ? " il-charcust__thumb--sel" : ""}`}
      onClick={onClick}
      aria-pressed={selected}
      aria-label={value ?? "None"}
      title={value ?? "None"}
    >
      {dataUri ? <img src={dataUri} alt="" /> : <span className="il-charcust__thumb-none">None</span>}
    </button>
  );
}
