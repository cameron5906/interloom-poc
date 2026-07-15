import { useCallback, useEffect, useRef, useState } from "react";

export interface CopyButtonProps {
  /** The text copied to the clipboard on click. */
  value: string;
  /** Idle label. Default "Copy". */
  label?: string;
  /** Label shown briefly after a successful copy. Default "Copied". */
  copiedLabel?: string;
  className?: string;
  "aria-label"?: string;
}

async function copyToClipboard(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    return;
  } catch {
    // Clipboard API unavailable/denied — fall back to a hidden textarea + execCommand.
  }
  const el = document.createElement("textarea");
  el.value = value;
  el.style.position = "fixed";
  el.style.opacity = "0";
  el.style.pointerEvents = "none";
  document.body.appendChild(el);
  el.focus();
  el.select();
  try {
    document.execCommand("copy");
  } finally {
    document.body.removeChild(el);
  }
}

/**
 * Generic clipboard-copy button with a brief "Copied" confirmation.
 * Content-agnostic (git-agnostic) — used for clone URLs, PAT secrets, and
 * anything else that needs a copy affordance. ≥44px touch target, tokens only.
 */
export function CopyButton({
  value,
  label = "Copy",
  copiedLabel = "Copied",
  className,
  "aria-label": ariaLabel,
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const handleClick = useCallback(() => {
    void copyToClipboard(value).then(() => {
      setCopied(true);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setCopied(false), 1600);
    });
  }, [value]);

  const classes = ["il-copy-btn", copied ? "il-copy-btn--copied" : null, className]
    .filter(Boolean)
    .join(" ");

  return (
    <button type="button" className={classes} onClick={handleClick} aria-label={ariaLabel ?? label}>
      {copied ? <CheckGlyph /> : <CopyGlyph />}
      <span className="il-copy-btn__label">{copied ? copiedLabel : label}</span>
    </button>
  );
}

function CopyGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="8" y="8" width="12" height="12" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M16 8V6.5A2.5 2.5 0 0 0 13.5 4h-7A2.5 2.5 0 0 0 4 6.5v7A2.5 2.5 0 0 0 6.5 16H8"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CheckGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M5 12.5l4.5 4.5L19 7.5"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
