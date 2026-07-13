import { sha256 } from "@noble/hashes/sha256";
import { bytesToB64url, utf8ToBytes } from "./base64url.js";
import { canonicalJson } from "./canonicalJson.js";

export interface AgentSignatureModel {
  filename: string;
  repoId?: string | null;
  quant?: string | null;
}

export interface AgentSignatureInput {
  persona: string;
  model?: AgentSignatureModel | null;
}

/**
 * The workspace's behavioral-baseline signature for an agent (CONTRACTS §2):
 * base64url(sha256(canonicalJson({ persona, model }))). It covers `persona` +
 * model identity (`filename`, `repoId`, `quant`) and NOTHING else — name,
 * avatar, title, specialties, and params sync freely without changing this
 * value. Implemented ONCE here; host portal and instance both call it.
 *
 * `model` may be absent on a draft agent (undefined) as well as explicitly
 * `null`; both normalize to `model: null` in the hash input so the function
 * is total and deterministic regardless of how the caller represents "no
 * model yet".
 */
export function agentSignature(input: AgentSignatureInput): string {
  const model = input.model
    ? {
        filename: input.model.filename,
        repoId: input.model.repoId ?? null,
        quant: input.model.quant ?? null,
      }
    : null;
  const preimage = canonicalJson({ persona: input.persona, model });
  return bytesToB64url(sha256(utf8ToBytes(preimage)));
}
