import type { Agent } from "./store.js";

/**
 * Body of `POST /api/agents/:id/preview` (CONTRACTS §6). Fields are typed
 * `unknown` because the preview body is not schema-validated — malformed
 * values must degrade to the stored agent settings, never crash the stream.
 */
export interface PreviewBody {
  messages?: unknown[];
  personaOverride?: unknown;
  temperature?: unknown;
}

/**
 * Resolves the effective system prompt and sampling temperature for a preview
 * turn. `personaOverride`/`temperature` carry the portal's unsaved editor
 * draft so owners can chat with edits before saving; a missing, blank, or
 * malformed field falls back to the stored agent value.
 */
export function resolvePreviewOptions(
  body: PreviewBody,
  agent: Pick<Agent, "persona" | "params">,
): { persona: string; temperature: number } {
  const override = typeof body.personaOverride === "string" ? body.personaOverride.trim() : "";
  const temperature =
    typeof body.temperature === "number" && Number.isFinite(body.temperature)
      ? body.temperature
      : agent.params.temperature;
  return { persona: override || agent.persona, temperature };
}

interface RawPreviewMessage {
  role?: unknown;
  content?: unknown;
  images?: unknown;
}

/**
 * Assemble the wire messages for a preview turn. Messages carrying valid
 * data-URL images become OpenAI content-parts; everything else stays a plain
 * string turn. Malformed image entries degrade to text-only (never crash).
 */
export function buildPreviewMessages(
  persona: string,
  rawMessages: unknown[],
): { messages: unknown[]; hasImages: boolean } {
  let hasImages = false;
  const messages: unknown[] = [{ role: "system", content: persona }];
  for (const raw of rawMessages as RawPreviewMessage[]) {
    if (!raw || typeof raw.role !== "string" || typeof raw.content !== "string") continue;
    const images = Array.isArray(raw.images)
      ? raw.images.filter((i): i is string => typeof i === "string" && i.startsWith("data:image/"))
      : [];
    if (images.length > 0) {
      hasImages = true;
      messages.push({
        role: raw.role,
        content: [
          { type: "text", text: raw.content },
          ...images.map((url) => ({ type: "image_url", image_url: { url } })),
        ],
      });
    } else {
      messages.push({ role: raw.role, content: raw.content });
    }
  }
  return { messages, hasImages };
}
