import { signEnvelope } from "@interloom/keys";
import type { AvatarAssetUpload } from "@interloom/protocol";
import { getKeypair } from "../keys.js";
import { networkUploadAvatar } from "../network/client.js";
import { registerAgentOnNetwork } from "./register.js";
import { updateAgent, type Agent } from "./store.js";

/** Decoded-size cap for an uploaded avatar image (CONTRACTS §6). */
const MAX_AVATAR_BYTES = 512 * 1024;

const DATA_URL_RE = /^data:(image\/png|image\/jpeg|image\/webp);base64,([A-Za-z0-9+/]+={0,2})$/;

export type AvatarContentType = "image/png" | "image/jpeg" | "image/webp";

export interface ParsedAvatarImage {
  contentType: AvatarContentType;
  bytes: Buffer;
}

/** Parses and decodes a `data:` URL, rejecting anything malformed or off-spec. */
export function parseAvatarDataUrl(dataUrl: string): ParsedAvatarImage | null {
  const match = DATA_URL_RE.exec(dataUrl);
  if (!match) return null;
  const [, contentType, b64] = match;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(b64 as string, "base64");
  } catch {
    return null;
  }
  if (bytes.length === 0) return null;
  return { contentType: contentType as AvatarContentType, bytes };
}

export type AvatarUploadError = "bad_image" | "image_too_large" | "network_unreachable";
export type AvatarUploadResult =
  { ok: true; imageUrl: string } | { ok: false; error: AvatarUploadError };

/**
 * Uploads an agent's avatar image to the network (CONTRACTS §6): decode +
 * size-check locally, sign an avatar-upload envelope with the host key,
 * forward to the network, then store the returned URL and — for already
 * registered agents — re-register so the persona sync carries it. Saves
 * nothing on failure.
 */
export async function uploadAgentAvatar(
  agent: Agent,
  dataUrl: string,
): Promise<AvatarUploadResult> {
  const parsed = parseAvatarDataUrl(dataUrl);
  if (!parsed) return { ok: false, error: "bad_image" };
  if (parsed.bytes.length > MAX_AVATAR_BYTES) return { ok: false, error: "image_too_large" };

  const keypair = getKeypair();
  const payload: AvatarAssetUpload = {
    kind: "avatar-upload",
    contentType: parsed.contentType,
    bytesB64: parsed.bytes.toString("base64"),
    ts: Date.now(),
  };
  const envelope = signEnvelope(payload, keypair.privateKey, keypair.publicKey);

  let result: { sha: string; url: string };
  try {
    result = await networkUploadAvatar(envelope);
  } catch {
    return { ok: false, error: "network_unreachable" };
  }

  const avatar = { ...agent.avatar, imageUrl: result.url };

  if (agent.registered) {
    try {
      await registerAgentOnNetwork({ ...agent, avatar });
    } catch {
      return { ok: false, error: "network_unreachable" };
    }
  }

  updateAgent(agent.agentId, {
    avatar,
    ...(agent.registered ? { syncedAt: new Date().toISOString() } : {}),
  });

  return { ok: true, imageUrl: result.url };
}
