export interface FlipperOption<T extends string = string> {
  value: T;
  label: string;
  disabled?: boolean;
  /** Shown as a native tooltip (`title`) on the disabled option. */
  disabledReason?: string;
}

export interface FlipperProps<T extends string = string> {
  /** Exactly two options — this is a two-position flip control, not a general segmented picker. */
  options: readonly [FlipperOption<T>, FlipperOption<T>];
  value: T;
  onChange: (value: T) => void;
  size?: "sm" | "md";
  className?: string;
  "aria-label"?: string;
}

/**
 * A two-option segmented flip control — a sliding-highlight sibling of the
 * plain `.il-segmented` buttons, reserved for binary mode switches (e.g.
 * Offline vs. Frontier models) where the motion of the highlight itself
 * communicates the flip. Either side may be disabled with a tooltip
 * explaining why (e.g. "save the agent first").
 */
export function Flipper<T extends string = string>({
  options,
  value,
  onChange,
  size = "md",
  className,
  ...rest
}: FlipperProps<T>) {
  const selectedIndex = options.findIndex((o) => o.value === value);
  const classes = ["il-flipper", `il-flipper--${size}`, className].filter(Boolean).join(" ");
  const ariaLabel = rest["aria-label"];

  return (
    <div className={classes} role="group" aria-label={ariaLabel}>
      <div
        className="il-flipper__highlight"
        style={selectedIndex === 1 ? { transform: "translateX(100%)" } : undefined}
        aria-hidden="true"
      />
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`il-flipper__btn${option.value === value ? " il-flipper__btn--sel" : ""}`}
          aria-pressed={option.value === value}
          disabled={option.disabled}
          title={option.disabled ? option.disabledReason : undefined}
          onClick={() => !option.disabled && onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
