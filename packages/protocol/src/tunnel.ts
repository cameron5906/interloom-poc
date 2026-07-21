import { z } from "zod";
import { FrontierWorkItem } from "./frontier.js";
import { signedEnvelope } from "./envelope.js";
import { Base64Url32, BoundedId, BoundedMethod, WIRE_LIMITS, utf8ByteLength } from "./limits.js";

/** Wire protocol version for tunnel frames. Unknown versions are rejected. */
export const TUNNEL_VERSION = 1 as const;

/** Tunnel RPC error codes (CONTRACTS §3). */
export const TunnelErrorCode = z.enum([
  "E_VERSION",
  "E_AUTH",
  "E_METHOD",
  "E_INTERNAL",
  "E_BUSY",
  "E_PENDING_APPROVAL",
]);
export type TunnelErrorCode = z.infer<typeof TunnelErrorCode>;

export const TunnelError = z.object({
  code: z.string().min(1).max(64),
  message: z.string().max(WIRE_LIMITS.errorMessageChars),
});
export type TunnelError = z.infer<typeof TunnelError>;

/**
 * A tunnel frame. `il` pins the protocol version, `id` is a uuid correlating
 * requests/responses/events. Discriminated by `kind`.
 */
export const TunnelFrame = z.discriminatedUnion("kind", [
  z.object({
    il: z.literal(TUNNEL_VERSION),
    id: BoundedId,
    kind: z.literal("req"),
    method: BoundedMethod,
    params: z.unknown().optional(),
  }),
  z.object({
    il: z.literal(TUNNEL_VERSION),
    id: BoundedId,
    kind: z.literal("res"),
    result: z.unknown().optional(),
  }),
  z.object({
    il: z.literal(TUNNEL_VERSION),
    id: BoundedId,
    kind: z.literal("err"),
    error: TunnelError,
  }),
  z.object({
    il: z.literal(TUNNEL_VERSION),
    id: BoundedId,
    kind: z.literal("evt"),
    method: BoundedMethod,
    params: z.unknown().optional(),
  }),
]);
export type TunnelFrame = z.infer<typeof TunnelFrame>;

// --- Handshake (§3) ---

export const AuthChallengeParams = z.object({
  nonce: z.string(),
});
export type AuthChallengeParams = z.infer<typeof AuthChallengeParams>;

export const AuthIdentifyParams = z.object({
  agentId: z.string(),
  agentPubKey: z.string(),
  // voucher: SignedEnvelope<InviteVoucher>; validated structurally here and
  // fully via InviteVoucher on the registry side.
  voucher: z.object({
    payload: z.unknown(),
    key: z.string(),
    sig: z.string(),
  }),
  sig: z.string(),
  /** Loaded model context window (tokens). The host sends this so the instance
   *  can cap prompt assembly to fit (chars/4 heuristic, reserving reply budget). */
  ctx: z.number().optional(),
  /** Host feature advertisement (e.g. "tools", "frontierQueue"). Instances never
   *  offer tools over a tunnel that did not advertise them. A tunnel advertising
   *  "frontierQueue" receives `work.*` methods, never `inference.*` (CONTRACTS §14). */
  features: z.array(z.string()).optional(),
});
export type AuthIdentifyParams = z.infer<typeof AuthIdentifyParams>;

/** One-shot, socket-bound tunnel challenge (CONTRACTS §3.0). */
export const TunnelAuthChallengeV2 = z
  .object({
    challengeId: z.string().uuid(),
    nonce: Base64Url32,
    issuedAt: z.number().int().nonnegative(),
  })
  .strict();
export type TunnelAuthChallengeV2 = z.infer<typeof TunnelAuthChallengeV2>;

/** The only object an Agent Host may sign in response to a tunnel challenge. */
export const HostTunnelProofV2Payload = z
  .object({
    purpose: z.literal("interloom.tunnel-auth.v2"),
    challengeId: z.string().uuid(),
    nonce: Base64Url32,
    placementId: BoundedId,
    agentId: BoundedId,
    instanceOrigin: z.string().url().max(2048),
    voucherDigest: Base64Url32,
    issuedAt: z.number().int().nonnegative(),
  })
  .strict();
export type HostTunnelProofV2Payload = z.infer<typeof HostTunnelProofV2Payload>;

/** Additive v2 identify request. Voucher semantics are checked with InviteVoucher at the receiver. */
export const AuthIdentifyV2Params = z
  .object({
    agentId: BoundedId,
    agentPubKey: Base64Url32,
    voucher: signedEnvelope(z.unknown()),
    proof: signedEnvelope(HostTunnelProofV2Payload),
    ctx: z.number().int().positive().max(10_000_000).optional(),
    features: z.array(z.string().min(1).max(64)).max(32).optional(),
  })
  .strict();
export type AuthIdentifyV2Params = z.infer<typeof AuthIdentifyV2Params>;

/** Auth success result. `ctx` advertises the loaded model's context window so
 *  workspaces can size prompt assembly to fit (shared across all agents on the model). */
export const AuthOkResult = z
  .object({
    ok: z.literal(true),
    ctx: z.number().int().positive().max(10_000_000).optional(),
  })
  .strict();
export type AuthOkResult = z.infer<typeof AuthOkResult>;

// --- Inference methods (§3) ---

/** A tool the instance offers the model for one inference call (CONTRACTS §3). */
export const ToolDef = z.object({
  name: z.string().min(1).max(128),
  description: z.string().max(8192),
  /** JSON Schema for the arguments object. */
  parameters: z.record(z.unknown()),
});
export type ToolDef = z.infer<typeof ToolDef>;

/** A tool invocation the model emitted. `arguments` is the raw JSON string. */
export const ToolCall = z.object({
  id: BoundedId,
  name: z.string().min(1).max(128),
  arguments: z.string().max(1024 * 1024),
});
export type ToolCall = z.infer<typeof ToolCall>;

/** A single content part in a multi-part message (CONTRACTS §3 image attachments). */
export const ContentPart = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string().max(WIRE_LIMITS.chatTextChars) }),
  z.object({
    type: z.literal("image_url"),
    image_url: z.object({ url: z.string().min(1).max(WIRE_LIMITS.tunnelFrameBytes) }),
  }),
]);
export type ContentPart = z.infer<typeof ContentPart>;

/**
 * A chat turn on the wire. The `tool` role and `toolCalls` are additive and
 * only ever sent for models gated by `capabilities.tools` — strict chat
 * templates never receive them (CONTRACTS §3). `contentParts` is additive:
 * `content` always carries a text degrade (e.g. "[image attached]") so a
 * stale host stays valid; a vision-capable host prefers `contentParts`.
 */
export const InferenceMessage = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string().max(1024 * 1024),
  toolCalls: z.array(ToolCall).max(WIRE_LIMITS.tunnelToolCalls).optional(),
  toolCallId: BoundedId.optional(),
  contentParts: z.array(ContentPart).max(WIRE_LIMITS.tunnelContentParts).optional(),
});
export type InferenceMessage = z.infer<typeof InferenceMessage>;

export const InferenceParams = z.object({
  temperature: z.number().optional(),
  maxTokens: z.number().int().positive().max(1_000_000).optional(),
  /** Traffic class on the shared model: interactive replies outrank maintenance (compaction etc.). */
  priority: z.enum(["interactive", "maintenance", "background"]).optional(),
  tools: z.array(ToolDef).max(WIRE_LIMITS.tunnelTools).optional(),
  toolChoice: z.enum(["auto", "none"]).optional(),
});
export type InferenceParams = z.infer<typeof InferenceParams>;

export const InferenceCompleteParams = z.object({
  messages: z.array(InferenceMessage).max(WIRE_LIMITS.tunnelMessages),
  params: InferenceParams.optional(),
});
export type InferenceCompleteParams = z.infer<typeof InferenceCompleteParams>;

export const InferenceUsage = z.object({
  promptTokens: z.number(),
  completionTokens: z.number(),
  tokensPerSec: z.number(),
});
export type InferenceUsage = z.infer<typeof InferenceUsage>;

/** Why the model stopped producing the current turn. Optional on the wire so
 * a rolling deploy can keep text-only inference working with older hosts;
 * negotiated hosts fail closed when it is absent, while legacy `tools` hosts
 * retain their fully-parsed pre-negotiation tool-call behavior. */
export const InferenceFinishReason = z.enum(["stop", "length", "tool_calls", "cancelled", "error"]);
export type InferenceFinishReason = z.infer<typeof InferenceFinishReason>;

export const InferenceCompleteResult = z.object({
  message: InferenceMessage,
  usage: InferenceUsage,
  finishReason: InferenceFinishReason.optional(),
});
export type InferenceCompleteResult = z.infer<typeof InferenceCompleteResult>;

export const InferenceChunkEvent = z.object({
  delta: z.string(),
});
export type InferenceChunkEvent = z.infer<typeof InferenceChunkEvent>;

/** Stream terminal result. `toolCalls` present when the model called tools this round. */
export const InferenceStreamResult = z.object({
  usage: InferenceUsage,
  toolCalls: z.array(ToolCall).max(WIRE_LIMITS.tunnelToolCalls).optional(),
  finishReason: InferenceFinishReason.optional(),
});
export type InferenceStreamResult = z.infer<typeof InferenceStreamResult>;

// --- Health (§3) ---

export const HealthPingResult = z.object({
  ok: z.literal(true),
  ts: z.number(),
});
export type HealthPingResult = z.infer<typeof HealthPingResult>;

// --- Frontier work queue methods (CONTRACTS §14) ---

/** `work.available` evt params (instance→host, a nudge; host may pull). */
export const WorkAvailableEvt = z.object({
  agentId: z.string(),
});
export type WorkAvailableEvt = z.infer<typeof WorkAvailableEvt>;

/** `work.pull` req params (host→instance). Leases up to `max` items for 120s. */
export const WorkPullParams = z.object({
  agentId: z.string(),
  max: z.number(),
});
export type WorkPullParams = z.infer<typeof WorkPullParams>;

export const WorkPullResult = z.object({
  items: z.array(FrontierWorkItem),
});
export type WorkPullResult = z.infer<typeof WorkPullResult>;

/** `work.begin` req params (host→instance). Instance broadcasts `typing` for the agent. */
export const WorkBeginParams = z.object({
  workId: z.string(),
});
export type WorkBeginParams = z.infer<typeof WorkBeginParams>;

export const WorkBeginResult = z.object({
  ok: z.literal(true),
});
export type WorkBeginResult = z.infer<typeof WorkBeginResult>;

/**
 * `work.complete` req params (host→instance). Persists the agent's reply via
 * the normal send path. `leaseToken` (additive) must match the token handed
 * out by `work.pull` for this item — a missing/stale token is rejected with
 * `E_STALE_LEASE` instead of `{ ok: true }` (CONTRACTS §14 "Lease ownership").
 */
export const WorkCompleteParams = z.object({
  workId: z.string(),
  text: z.string(),
  leaseToken: z.string().optional(),
});
export type WorkCompleteParams = z.infer<typeof WorkCompleteParams>;

export const WorkCompleteResult = z.object({
  ok: z.literal(true),
  messageId: z.string().optional(),
  posted: z.boolean().optional(),
});
export type WorkCompleteResult = z.infer<typeof WorkCompleteResult>;

/**
 * `work.fail` req params (host→instance). Requeues up to 3 attempts, then
 * dead. `leaseToken` (additive) must match the token handed out by
 * `work.pull` — a missing/stale token is rejected with `E_STALE_LEASE`
 * rather than mutating the row, so a late fail can never resurrect an
 * already-`done` item back to `queued` (CONTRACTS §14 "Lease ownership").
 */
export const WorkFailParams = z.object({
  workId: z.string(),
  reason: z.string(),
  leaseToken: z.string().optional(),
});
export type WorkFailParams = z.infer<typeof WorkFailParams>;

export const WorkFailResult = z.object({
  ok: z.literal(true),
});
export type WorkFailResult = z.infer<typeof WorkFailResult>;

export const WorkPassParams = z.object({
  workId: z.string(),
  leaseToken: z.string().optional(),
});
export type WorkPassParams = z.infer<typeof WorkPassParams>;

export const WorkPassResult = z.object({ ok: z.literal(true) });
export type WorkPassResult = z.infer<typeof WorkPassResult>;

/** `chat.post` req params (host→instance). Proactive agent message; only for channels the agent is a member of. */
export const ChatPostParams = z.object({
  channelId: z.string(),
  text: z.string(),
});
export type ChatPostParams = z.infer<typeof ChatPostParams>;

export const ChatPostResult = z.object({
  ok: z.literal(true),
  messageId: z.string(),
});
export type ChatPostResult = z.infer<typeof ChatPostResult>;

// --- Frame parsing + constructors ---

/** Thrown by `parseTunnelFrame` when a raw frame is invalid or the wrong version. */
export class TunnelFrameError extends Error {
  readonly code: TunnelErrorCode;
  constructor(code: TunnelErrorCode, message: string) {
    super(message);
    this.name = "TunnelFrameError";
    this.code = code;
  }
}

/**
 * Parse a raw JSON text frame into a validated `TunnelFrame`.
 * Throws `TunnelFrameError` with `E_VERSION` on a mismatched/absent version and
 * `E_INTERNAL` on malformed JSON or structure.
 */
export function parseTunnelFrame(raw: string): TunnelFrame {
  if (utf8ByteLength(raw) > WIRE_LIMITS.tunnelFrameBytes) {
    throw new TunnelFrameError("E_INTERNAL", "tunnel frame exceeds maximum size");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TunnelFrameError("E_INTERNAL", "tunnel frame is not valid JSON");
  }
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "il" in parsed &&
    (parsed as { il: unknown }).il !== TUNNEL_VERSION
  ) {
    throw new TunnelFrameError(
      "E_VERSION",
      `unsupported tunnel version: ${String((parsed as { il: unknown }).il)}`,
    );
  }
  const result = TunnelFrame.safeParse(parsed);
  if (!result.success) {
    throw new TunnelFrameError("E_INTERNAL", `invalid tunnel frame: ${result.error.message}`);
  }
  return result.data;
}

function newId(): string {
  return crypto.randomUUID();
}

export function makeReq(method: string, params?: unknown, id: string = newId()): TunnelFrame {
  return { il: TUNNEL_VERSION, id, kind: "req", method, params };
}

export function makeRes(id: string, result?: unknown): TunnelFrame {
  return { il: TUNNEL_VERSION, id, kind: "res", result };
}

export function makeErr(id: string, code: string, message: string): TunnelFrame {
  return { il: TUNNEL_VERSION, id, kind: "err", error: { code, message } };
}

export function makeEvt(method: string, params?: unknown, id: string = newId()): TunnelFrame {
  return { il: TUNNEL_VERSION, id, kind: "evt", method, params };
}
