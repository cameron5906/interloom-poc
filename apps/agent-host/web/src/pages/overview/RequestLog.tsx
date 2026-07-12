import { useEffect, useRef, useState } from "react";
import type { TelemetryRequestLogEntry } from "@interloom/protocol";
import { clockTime } from "../../lib/format.js";

interface RequestLogProps {
  entries: TelemetryRequestLogEntry[];
  connected: boolean;
}

/**
 * Dark, mono streaming request-log tail. Autoscrolls to the newest row, but
 * pauses while the cursor is over the panel (so an operator can read a line
 * without it scrolling away) — a small "paused" chip signals the state.
 */
export function RequestLog({ entries, connected }: RequestLogProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries, paused]);

  return (
    <section className="il-panel il-reqlog" aria-label="Request log">
      <header className="il-reqlog__head">
        <span className="il-reqlog__title">Request log</span>
        <span className="il-reqlog__meta">
          {paused ? (
            <span className="il-reqlog__paused">paused</span>
          ) : connected ? (
            <span className="il-reqlog__live">
              <span className="il-reqlog__live-dot" />
              streaming
            </span>
          ) : (
            <span className="il-reqlog__paused">offline</span>
          )}
        </span>
      </header>
      <div
        className="il-reqlog__body il-scroll-fade"
        ref={scrollRef}
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
      >
        {entries.length === 0 ? (
          <div className="il-reqlog__empty">
            {connected
              ? "Waiting for inference activity… requests appear here as agents serve."
              : "Telemetry disconnected — no request stream."}
          </div>
        ) : (
          entries.map((e, i) => <LogRow key={`${e.ts}-${i}`} entry={e} />)
        )}
      </div>
    </section>
  );
}

function LogRow({ entry }: { entry: TelemetryRequestLogEntry }) {
  const source = entry.source.startsWith("tunnel:")
    ? entry.source.slice("tunnel:".length)
    : entry.source;
  const isPreview = entry.source === "preview";
  return (
    <div className="il-reqlog__row">
      <span className="il-reqlog__ts">[{clockTime(entry.ts)}]</span>
      <span className={`il-reqlog__src${isPreview ? " il-reqlog__src--preview" : ""}`}>{source}</span>
      <span className="il-reqlog__agent">{entry.agentName}</span>
      <span className="il-reqlog__tok">
        {entry.promptTokens}→{entry.completionTokens}
      </span>
      <span className="il-reqlog__tps">{entry.tokensPerSec.toFixed(1)} tok/s</span>
    </div>
  );
}
