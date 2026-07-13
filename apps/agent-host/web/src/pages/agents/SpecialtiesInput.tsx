import { useState } from "react";
import { SPECIALTY_SUGGESTIONS } from "../../lib/constants.js";

interface SpecialtiesInputProps {
  value: string[];
  onChange: (next: string[]) => void;
}

const MAX_SPECIALTIES = 8;
const MAX_LEN = 32;

/** Type-and-enter chip input for an agent's specialties (CONTRACTS §4, ≤8 · ≤32 chars each). */
export function SpecialtiesInput({ value, onChange }: SpecialtiesInputProps) {
  const [draft, setDraft] = useState("");

  const add = (raw: string) => {
    const text = raw.trim().slice(0, MAX_LEN);
    if (!text || value.length >= MAX_SPECIALTIES) return;
    if (value.some((v) => v.toLowerCase() === text.toLowerCase())) {
      setDraft("");
      return;
    }
    onChange([...value, text]);
    setDraft("");
  };

  const remove = (idx: number) => onChange(value.filter((_, i) => i !== idx));

  const suggestions = SPECIALTY_SUGGESTIONS.filter(
    (s) => !value.some((v) => v.toLowerCase() === s.toLowerCase()),
  );
  const atMax = value.length >= MAX_SPECIALTIES;

  return (
    <div className="il-specialties">
      <div className="il-specialties__chips">
        {value.map((s, i) => (
          <span key={s} className="il-specialties__chip">
            {s}
            <button
              type="button"
              className="il-specialties__chip-remove"
              onClick={() => remove(i)}
              aria-label={`Remove ${s}`}
            >
              ×
            </button>
          </span>
        ))}
        {!atMax ? (
          <input
            className="il-specialties__input"
            value={draft}
            placeholder={value.length === 0 ? "Type and press Enter…" : ""}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add(draft);
              }
            }}
          />
        ) : null}
      </div>
      {!atMax && suggestions.length > 0 ? (
        <div className="il-specialties__suggestions">
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              className="il-specialties__suggestion"
              onClick={() => add(s)}
            >
              + {s}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
