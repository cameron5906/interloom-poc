import { z } from "zod";

/** Wire protocol version for tunnel frames. Unknown versions are rejected. */
export const TUNNEL_VERSION = 1 as const;

/** Tunnel RPC error codes (CONTRACTS §3). */
export const TunnelErrorCode = z.enum(["E_VERSION", "E_AUTH", "E_METHOD", "E_INTERNAL", "E_BUSY"]);
export type TunnelErrorCode = z.infer<typeof TunnelErrorCode>;

export const TunnelError = z.object({
  code: z.string(),
  message: z.string(),
});
export type TunnelError = z.infer<typeof TunnelError>;

/**
 * A tunnel frame. `il` pins the protocol version, `id` is a uuid correlating
 * requests/responses/events. Discriminated by `kind`.
 */
export const TunnelFrame = z.discriminatedUnion("kind", [
  z.object({
    il: z.literal(TUNNEL_VERSION),
    id: z.string(),
    kind: z.literal("req"),
    method: z.string(),
    params: z.unknown().optional(),
  }),
  z.object({
    il: z.literal(TUNNEL_VERSION),
    id: z.string(),
    kind: z.literal("res"),
    result: z.unknown().optional(),
  }),
  z.object({
    il: z.literal(TUNNEL_VERSION),
    id: z.string(),
    kind: z.literal("err"),
    error: TunnelError,
  }),
  z.object({
    il: z.literal(TUNNEL_VERSION),
    id: z.string(),
    kind: z.literal("evt"),
    method: z.string(),
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
});
export type AuthIdentifyParams = z.infer<typeof AuthIdentifyParams>;

/** Auth success result. `ctx` advertises the loaded model's context window so
 *  workspaces can size prompt assembly to fit (shared across all agents on the model). */
export const AuthOkResult = z.object({
  ok: z.literal(true),
  ctx: z.number().optional(),
});
export type AuthOkResult = z.infer<typeof AuthOkResult>;

// --- Inference methods (§3) ---

export const InferenceMessage = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
});
export type InferenceMessage = z.infer<typeof InferenceMessage>;

export const InferenceParams = z.object({
  temperature: z.number().optional(),
  maxTokens: z.number().optional(),
  /** Traffic class on the shared model: interactive replies outrank maintenance (compaction etc.). */
  priority: z.enum(["interactive", "maintenance"]).optional(),
});
export type InferenceParams = z.infer<typeof InferenceParams>;

export const InferenceCompleteParams = z.object({
  messages: z.array(InferenceMessage),
  params: InferenceParams.optional(),
});
export type InferenceCompleteParams = z.infer<typeof InferenceCompleteParams>;

export const InferenceUsage = z.object({
  promptTokens: z.number(),
  completionTokens: z.number(),
  tokensPerSec: z.number(),
});
export type InferenceUsage = z.infer<typeof InferenceUsage>;

export const InferenceCompleteResult = z.object({
  message: InferenceMessage,
  usage: InferenceUsage,
});
export type InferenceCompleteResult = z.infer<typeof InferenceCompleteResult>;

export const InferenceChunkEvent = z.object({
  delta: z.string(),
});
export type InferenceChunkEvent = z.infer<typeof InferenceChunkEvent>;

export const InferenceStreamResult = z.object({
  usage: InferenceUsage,
});
export type InferenceStreamResult = z.infer<typeof InferenceStreamResult>;

// --- Health (§3) ---

export const HealthPingResult = z.object({
  ok: z.literal(true),
  ts: z.number(),
});
export type HealthPingResult = z.infer<typeof HealthPingResult>;

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
