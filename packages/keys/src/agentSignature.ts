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
 * The workspace's behavioral-baseline signature for an agent (CONTRACTS §2) —
 * v1, legacy: base64url(sha256(canonicalJson({ persona, model }))). It covers
 * `persona` + model identity (`filename`, `repoId`, `quant`) and NOTHING
 * else — name, avatar, title, specialties, and params sync freely without
 * changing this value. Implemented ONCE here; host portal and instance both
 * call it.
 *
 * `model` may be absent on a draft agent (undefined) as well as explicitly
 * `null`; both normalize to `model: null` in the hash input so the function
 * is total and deterministic regardless of how the caller represents "no
 * model yet".
 */
export function agentSignatureV1(input: AgentSignatureInput): string {
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

/** Back-compat alias — existing call sites import `agentSignature` and must keep working. */
export const agentSignature = agentSignatureV1;

export interface AgentSignatureV2Input {
  persona: string;
  model: AgentSignatureModel;
  title?: string | null;
  capabilityBlurb?: string | null;
  avatarImageUrl?: string | null;
}

/** The current signature schema version (CONTRACTS §2). */
export const AGENT_SIGNATURE_VERSION = 2;

/**
 * The workspace's behavioral-baseline signature for an agent (CONTRACTS §2) —
 * v2: base64url(sha256(canonicalJson({ v: 2, persona, title, capabilityBlurb,
 * avatarImageUrl, model }))). Extends v1 to also cover `title`,
 * `capabilityBlurb`, and `avatarImageUrl` — the workspace's baseline
 * expectation is now that the model, system prompt, title, capability
 * blurb, and profile image do not change between syncs. Everything else
 * (name, gender, specialties, params) still syncs freely with no ceremony.
 * The `v: 2` discriminator lives inside the hashed preimage, so a v1 and v2
 * hash of the same manifest never collide.
 *
 * Every optional field normalizes absent (`undefined`) and explicit `null`
 * to the same `null` in the hash input, so the function is total and
 * deterministic regardless of how the caller represents "not set".
 */
export function agentSignatureV2(input: AgentSignatureV2Input): string {
  const preimage = canonicalJson({
    v: 2,
    persona: input.persona,
    title: input.title ?? null,
    capabilityBlurb: input.capabilityBlurb ?? null,
    avatarImageUrl: input.avatarImageUrl ?? null,
    model: {
      filename: input.model.filename,
      repoId: input.model.repoId ?? null,
      quant: input.model.quant ?? null,
    },
  });
  return bytesToB64url(sha256(utf8ToBytes(preimage)));
}
