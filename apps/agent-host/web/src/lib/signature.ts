import type { HostAgent } from "@interloom/protocol";
import type { AgentDraft } from "../api/types.js";

/**
 * Client-side signature-impact check (CONTRACTS §6 "Cascade warning"). Mirrors
 * `agentSignature({persona, model})` from `@interloom/keys` at the field
 * level (persona + model filename/repoId/quant) without needing to hash —
 * the portal only needs to know WHETHER it changed, to gate the cascade
 * warning before a save/publish.
 */
export function signatureChanged(saved: HostAgent, draft: AgentDraft): boolean {
  if (saved.persona !== draft.persona) return true;

  const savedModel = saved.model;
  const draftModel = draft.model;
  if (!savedModel && !draftModel) return false;
  if (!savedModel || !draftModel) return true;

  return (
    savedModel.filename !== draftModel.filename ||
    (savedModel.repoId ?? null) !== (draftModel.repoId ?? null) ||
    (savedModel.quant ?? null) !== (draftModel.quant ?? null)
  );
}
