/**
 * Reconnecting client for the telemetry WebSocket (CONTRACTS §6, `/ws/telemetry`).
 * Emits 1 Hz `TelemetryFrame`s and a connection status the Overview uses to show
 * the amber "reconnecting…" banner.
 */
import type { TelemetryFrame } from "@interloom/protocol";

export type TelemetryStatus = "connecting" | "open" | "reconnecting";

export interface TelemetrySubscriber {
  onFrame: (frame: TelemetryFrame) => void;
  onStatus: (status: TelemetryStatus) => void;
}

function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws/telemetry`;
}

/**
 * Connects with exponential backoff (1s → 15s cap, jitter). Returns a cleanup
 * function that closes the socket and stops reconnection.
 */
export function connectTelemetry(sub: TelemetrySubscriber): () => void {
  let socket: WebSocket | null = null;
  let closed = false;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let hasConnectedOnce = false;

  const open = () => {
    if (closed) return;
    sub.onStatus(hasConnectedOnce ? "reconnecting" : "connecting");

    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl());
    } catch {
      scheduleReconnect();
      return;
    }
    socket = ws;

    ws.onopen = () => {
      attempt = 0;
      hasConnectedOnce = true;
      sub.onStatus("open");
    };

    ws.onmessage = (ev) => {
      try {
        const frame = JSON.parse(ev.data as string) as TelemetryFrame;
        sub.onFrame(frame);
      } catch {
        /* ignore malformed frame */
      }
    };

    ws.onerror = () => {
      // The close handler drives reconnection; swallow to avoid double-scheduling.
    };

    ws.onclose = () => {
      if (closed) return;
      socket = null;
      scheduleReconnect();
    };
  };

  const scheduleReconnect = () => {
    if (closed || reconnectTimer) return;
    sub.onStatus("reconnecting");
    const base = Math.min(1000 * 2 ** attempt, 15000);
    const jitter = Math.random() * 400;
    attempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      open();
    }, base + jitter);
  };

  open();

  return () => {
    closed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (socket) {
      socket.onclose = null;
      socket.close();
    }
  };
}
