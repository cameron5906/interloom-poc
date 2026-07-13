import { useEffect, useRef, useState } from "react";
import type { HTMLAttributes } from "react";

export interface ShellOutputProps extends HTMLAttributes<HTMLDivElement> {
  /** Rendered after the $ prompt in the header. */
  command: string;
  /** Output lines so far. */
  lines?: string[];
  /** Live process: pulsing status, blinking cursor, autoscroll, animated lines. */
  running?: boolean;
  /** Shown when the process is done: exit 0 (success) / exit n (danger). */
  exitCode?: number;
  /** Optional context, e.g. "deploy · interloom-box". */
  label?: string;
  /** Body scrolls beyond this height (px). */
  maxHeight?: number;
  /** Stagger-reveal lines on mount. Defaults to `running`. */
  animate?: boolean;
}

export function ShellOutput({
  command,
  lines = [],
  running = false,
  exitCode,
  label,
  maxHeight = 240,
  animate,
  className,
  ...rest
}: ShellOutputProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(false);
  // Lines present on mount get a stagger delay; appended lines reveal instantly.
  const mountCount = useRef(lines.length);
  const reveal = animate ?? running;

  useEffect(() => {
    if (!running || paused) return;
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length, running, paused]);

  const status = running
    ? { mod: "run", text: "running" }
    : exitCode === undefined
      ? null
      : { mod: exitCode === 0 ? "ok" : "err", text: `exit ${exitCode}` };

  const classes = ["il-shell", className].filter(Boolean).join(" ");

  return (
    <div className={classes} {...rest}>
      <div className="il-shell__head">
        <span className="il-shell__prompt" aria-hidden>
          $
        </span>
        <span className="il-shell__cmd">{command}</span>
        <span className="il-shell__meta">
          {label && <span className="il-shell__label">{label}</span>}
          {running && paused && <span className="il-shell__paused">paused</span>}
          {status && (
            <span className={`il-shell__status il-shell__status--${status.mod}`}>
              {running && <span className="il-shell__dot" />}
              {status.text}
            </span>
          )}
        </span>
      </div>

      {(lines.length > 0 || running) && (
        <div
          className="il-shell__body"
          ref={bodyRef}
          style={{ maxHeight }}
          onMouseEnter={() => setPaused(true)}
          onMouseLeave={() => setPaused(false)}
        >
          {lines.map((line, i) => (
            <div
              key={i}
              className={`il-shell__line${reveal ? " il-shell__line--in" : ""}`}
              style={
                reveal && i < mountCount.current
                  ? { animationDelay: `${Math.min(i * 30, 600)}ms` }
                  : undefined
              }
            >
              {line || " "}
            </div>
          ))}
          {running && (
            <div className="il-shell__line">
              <span className="il-shell__cursor" aria-hidden />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
