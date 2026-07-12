export interface TypingDotsProps {
  className?: string;
  label?: string;
}

export function TypingDots({ className, label = "Typing" }: TypingDotsProps) {
  const classes = ["il-typing", className].filter(Boolean).join(" ");
  return (
    <span className={classes} role="status" aria-label={label}>
      <span className="il-typing__dot" />
      <span className="il-typing__dot" />
      <span className="il-typing__dot" />
    </span>
  );
}
