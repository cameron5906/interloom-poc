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
    let doneSignalled = false;

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
          doneSignalled = handleFrame(frame, handlers) || doneSignalled;
        }
      }
      // Flush any trailing frame.
      if (buffer.trim()) doneSignalled = handleFrame(buffer, handlers) || doneSignalled;
      // The terminal frame reports onDone with usage; only fall back here if the
      // stream ended without one, so onDone fires exactly once either way.
      if (!doneSignalled) handlers.onDone();
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      handlers.onError(err instanceof Error ? err : new Error("Preview stream failed."));
    }
  })();

  return () => controller.abort();
}

/** Returns true if the frame contained the terminal `{done:true}` payload. */
function handleFrame(frame: string, handlers: PreviewHandlers): boolean {
  let done = false;
  for (const line of frame.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const obj = JSON.parse(payload) as {
        delta?: string;
        done?: boolean;
        usage?: PreviewUsage;
      };
      if (typeof obj.delta === "string") handlers.onDelta(obj.delta);
      if (obj.done) {
        handlers.onDone(obj.usage);
        done = true;
      }
    } catch {
      /* ignore malformed frame */
    }
  }
  return done;
}
