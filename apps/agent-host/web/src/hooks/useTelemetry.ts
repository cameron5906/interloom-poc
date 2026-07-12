import { useEffect, useRef, useState } from "react";
import type { TelemetryFrame } from "@interloom/protocol";
import { connectTelemetry } from "../api/telemetry.js";
import type { TelemetryStatus } from "../api/telemetry.js";

export interface TelemetryState {
  frame: TelemetryFrame | undefined;
  status: TelemetryStatus;
  /** Rolling series of tokens/sec (up to `historyLen` points) for the sparkline. */
  tokensHistory: number[];
}

/**
 * Subscribes to the reconnecting telemetry socket and maintains a rolling
 * tokens/sec history for the overview sparkline (the daemon frame carries an
 * instantaneous value; we keep the last N to draw the trend).
 */
export function useTelemetry(historyLen = 60): TelemetryState {
  const [frame, setFrame] = useState<TelemetryFrame | undefined>(undefined);
  const [status, setStatus] = useState<TelemetryStatus>("connecting");
  const [tokensHistory, setTokensHistory] = useState<number[]>([]);
  const lenRef = useRef(historyLen);
  lenRef.current = historyLen;

  useEffect(() => {
    const disconnect = connectTelemetry({
      onFrame: (f) => {
        setFrame(f);
        setTokensHistory((prev) => {
          const next = [...prev, f.tokensPerSec];
          return next.length > lenRef.current ? next.slice(-lenRef.current) : next;
        });
      },
      onStatus: setStatus,
    });
    return disconnect;
  }, []);

  return { frame, status, tokensHistory };
}
