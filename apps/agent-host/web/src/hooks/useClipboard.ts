import { useCallback, useRef, useState } from "react";

/**
 * Copy-to-clipboard with a transient "copied" flag for button affordances.
 * Falls back to a hidden textarea when the async Clipboard API is unavailable.
 */
export function useClipboard(resetMs = 1600): {
  copied: boolean;
  copy: (text: string) => void;
} {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const copy = useCallback(
    (text: string) => {
      const flag = () => {
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), resetMs);
      };

      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).then(flag).catch(() => fallback(text, flag));
      } else {
        fallback(text, flag);
      }
    },
    [resetMs],
  );

  return { copied, copy };
}

function fallback(text: string, done: () => void): void {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
    done();
  } catch {
    /* give up silently */
  }
  document.body.removeChild(ta);
}
