import { agentSignatureV2 } from "@interloom/keys";
import type { HostAgent } from "@interloom/protocol";
import type { AgentDraft } from "../api/types.js";

/**
 * A value `avatarImageUrl` can never legitimately hold — used as the hash
 * input while a new avatar render is queued but not yet uploaded, so the
 * comparison below sees a change even though the real content-addressed URL
 * doesn't exist yet.
 */
const PENDING_AVATAR_MARKER = "il://pending-avatar-upload";

interface SignatureFields {
  persona: string;
  model?: { filename: string; repoId?: string | null; quant?: string | null };
  title?: string;
  capabilityBlurb?: string;
  avatarImageUrl?: string;
}

function signatureOf(fields: SignatureFields): string | null {
  if (!fields.model) return null;
  return agentSignatureV2({
    persona: fields.persona,
    model: fields.model,
    title: fields.title ?? null,
    capabilityBlurb: fields.capabilityBlurb ?? null,
    avatarImageUrl: fields.avatarImageUrl ?? null,
  });
}

/**
 * Client-side signature-impact check (CONTRACTS §6 "Cascade warning"). Computes
 * `agentSignatureV2` (persona, model filename/repoId/quant, title,
 * capabilityBlurb, avatar.imageUrl — @interloom/keys, browser-safe) for the
 * saved agent and the draft and compares hashes — no ad-hoc field compare.
 *
 * `avatarPending` is passed by the caller when a new character render is
 * queued for upload but hasn't produced a real `imageUrl` yet (the
 * DiceBear-customize-then-save path); it's folded in via the marker above so
 * the cascade gate fires before the upload happens, not after.
 */
export function signatureChanged(saved: HostAgent, draft: AgentDraft, avatarPending = false): boolean {
  const savedSig = signatureOf({
    persona: saved.persona,
    model: saved.model,
    title: saved.title,
    capabilityBlurb: saved.capabilityBlurb,
    avatarImageUrl: saved.avatar.imageUrl,
  });
  const draftSig = signatureOf({
    persona: draft.persona,
    model: draft.model,
    title: draft.title,
    capabilityBlurb: draft.capabilityBlurb,
    avatarImageUrl: avatarPending ? PENDING_AVATAR_MARKER : draft.avatar.imageUrl,
  });
  return savedSig !== draftSig;
}
