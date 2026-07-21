import { z } from "zod";

/** Shared allocation and field bounds for every public WebSocket surface. */
export const WIRE_LIMITS = Object.freeze({
  browserChatFrameBytes: 256 * 1024,
  deviceLinkFrameBytes: 1024 * 1024,
  hostTelemetryFrameBytes: 128 * 1024,
  tunnelFrameBytes: 12 * 1024 * 1024,
  idChars: 128,
  methodChars: 128,
  errorMessageChars: 1024,
  chatTextChars: 32 * 1024,
  chatMentions: 32,
  chatAttachments: 16,
  tunnelMessages: 128,
  tunnelTools: 64,
  tunnelToolCalls: 64,
  tunnelContentParts: 16,
  remoteImageDecodedBytes: 8 * 1024 * 1024,
  linkSdpChars: 256 * 1024,
  linkIceChars: 32 * 1024,
  linkBlobChars: 700 * 1024,
} as const);

export const BoundedId = z.string().min(1).max(WIRE_LIMITS.idChars);
export const BoundedMethod = z.string().min(1).max(WIRE_LIMITS.methodChars);

/** Canonical unpadded base64url encoding of exactly 32 bytes. */
export const Base64Url32 = z
  .string()
  .regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/, "expected canonical base64url(32 bytes)");

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
