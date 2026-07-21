/**
 * Live preview chat stream (CONTRACTS §6, `POST /api/agents/:id/preview`).
 *
 * The daemon re-streams inference as Server-Sent Events:
 *   data: {"delta":"..."}    — one per token batch
 *   data: {"done":true,"usage":{...}}  — terminal frame
 *
 * We use fetch + a ReadableStream reader rather than EventSource because the
 * request is a POST with a JSON body (EventSource is GET-only). The persona is
 * NOT sent from the client — the daemon injects the agent's current persona as
 * the system prompt server-side, so a live preview always reflects the saved
 * agent. To preview *unsaved* edits, callers pass the draft persona through the
 * request body's `personaOverride` (honoured by the daemon for previews).
 */
import { ApiError } from "./client.js";

export interface PreviewMessage {
  role: "user" | "assistant";
  content: string;
  images?: string[];
}

export interface PreviewUsage {
  promptTokens: number;
  completionTokens: number;
  tokensPerSec: number;
}

export interface PreviewHandlers {
  onDelta: (delta: string) => void;
  onDone: (usage?: PreviewUsage) => void;
  onError: (err: Error) => void;
}

export interface PreviewRequest {
  messages: PreviewMessage[];
  /** Unsaved draft persona to preview against, if different from the stored one. */
  personaOverride?: string;
  temperature?: number;
}

/**
 * Opens a preview stream. Returns an abort function. Streaming is resilient to
 * partial SSE frames split across chunk boundaries.
 */
export function streamPreview(
  agentId: string,
  req: PreviewRequest,
  handlers: PreviewHandlers,
): () => void {
  const controller = new AbortController();

  (async () => {
    let res: Response;
    try {
      res = await fetch(`/api/agents/${agentId}/preview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      handlers.onError(new ApiError("Preview stream could not start — daemon unreachable.", 0));
      return;
    }

    if (!res.ok || !res.body) {
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        /* non-JSON error body — leave body undefined */
      }
      handlers.onError(new ApiError(`Preview failed (${res.status})`, res.status, body));
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let terminalSignalled = false;

    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line.
        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const outcome = handleFrame(frame, handlers);
          terminalSignalled = outcome !== "none" || terminalSignalled;
          if (outcome === "error") {
            await reader.cancel();
            return;
          }
        }
      }
      // Flush any trailing frame.
      if (buffer.trim()) {
        const outcome = handleFrame(buffer, handlers);
        terminalSignalled = outcome !== "none" || terminalSignalled;
        if (outcome === "error") return;
      }
      // The terminal frame reports onDone with usage; only fall back here if the
      // stream ended without one, so onDone fires exactly once either way.
      if (!terminalSignalled) handlers.onDone();
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      handlers.onError(err instanceof Error ? err : new Error("Preview stream failed."));
    }
  })();

  return () => controller.abort();
}

type FrameOutcome = "none" | "done" | "error";

/** Reports whether the frame contained a terminal success or error payload. */
function handleFrame(frame: string, handlers: PreviewHandlers): FrameOutcome {
  for (const line of frame.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const obj = JSON.parse(payload) as {
        delta?: string;
        done?: boolean;
        error?: string;
        usage?: PreviewUsage;
      };
      if (typeof obj.delta === "string") handlers.onDelta(obj.delta);
      if (typeof obj.error === "string") {
        handlers.onError(new Error(obj.error || "Preview stream failed."));
        return "error";
      }
      if (obj.done) {
        handlers.onDone(obj.usage);
        return "done";
      }
    } catch {
      /* ignore malformed frame */
    }
  }
  return "none";
}
