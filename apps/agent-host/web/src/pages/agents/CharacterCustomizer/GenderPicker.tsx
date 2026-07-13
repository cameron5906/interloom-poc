import type { AgentGender } from "@interloom/protocol";

interface GenderPickerProps {
  value: AgentGender | undefined;
  onChange: (gender: AgentGender) => void;
}

const GENDERS: Array<{ value: AgentGender; label: string }> = [
  { value: "male", label: "Male" },
  { value: "female", label: "Female" },
  { value: "other", label: "Other" },
];

/** Male / Female / Other — "Other" unlocks every variant across both packs (CONTRACTS §12). */
export function GenderPicker({ value, onChange }: GenderPickerProps) {
  return (
    <div className="il-segmented il-charcust__gender" role="group" aria-label="Gender">
      {GENDERS.map((g) => (
        <button
          key={g.value}
          type="button"
          className={`il-segmented__btn${value === g.value ? " il-segmented__btn--sel" : ""}`}
          onClick={() => onChange(g.value)}
          aria-pressed={value === g.value}
        >
          {g.label}
        </button>
      ))}
    </div>
  );
}
