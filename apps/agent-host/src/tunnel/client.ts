import path from "path";
import WebSocket from "ws";
import { canonicalSha256, signEnvelope } from "@interloom/keys";
import {
  AuthOkResult,
  HostTunnelProofV2Payload,
  InferenceCompleteParams,
  TunnelAuthChallengeV2,
  WIRE_LIMITS,
  canonicalOrigin,
  parseTunnelFrame,
  makeRes,
  makeErr,
  makeEvt,
  type InferenceFinishReason,
  type TunnelFrame,
} from "@interloom/protocol";
import type { Placement } from "@interloom/protocol";
import { MODELS_DIR } from "../config.js";
import { addRequestLogEntry, recordTokensPerSec } from "../telemetry/collector.js";
import { normalizeMessages } from "../inference/normalize.js";
import { toLlamaMessages } from "../inference/llamaMessages.js";
import { enqueueInference } from "../inference/gate.js";
import { readInferenceCtx } from "../models/active.js";
import { findInstanceByFilename, instanceBaseUrl, type InstanceRecord } from "../models/loaded.js";
import { capabilitiesForFilename } from "../models/scan.js";
import { isThinkingDisabled } from "../models/settingsStore.js";
import { clampMaxTokens } from "../inference/limits.js";
import { ThinkStripper, stripThinkTags } from "../inference/thinkStripper.js";
import { toLlamaTools } from "../inference/toolSchema.js";
import { getAgent } from "../agents/store.js";
import {
  newToolCallAccumulator,
  aggregateToolCallDelta,
  finishToolCalls,
  type ToolCallDelta,
} from "../inference/toolCalls.js";
import { createSafeLookup, safeHttpRequest } from "../security/safeHttp.js";

type TunnelStatus = "connecting" | "connected" | "down";

function parseFinishReason(value: unknown): InferenceFinishReason | undefined {
  return value === "stop" ||
    value === "length" ||
    value === "tool_calls" ||
    value === "cancelled" ||
    value === "error"
    ? value
    : undefined;
}

export interface TunnelInfo {
  placementId: string;
  instanceName: string;
  instanceUrl: string;
  agentName: string;
  agentId: string;
  status: TunnelStatus;
}
interface PendingReq {
  resolve: (frame: TunnelFrame) => void;
  reject: (err: Error) => void;
}

/** A content part on the wire (CONTRACTS §3 image attachments) — mirrors `@interloom/protocol`'s ContentPart. */
type WireContentPart =
  { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

interface WireInferenceMessage {
  role: string;
  content: string;
  contentParts?: WireContentPart[];
  toolCalls?: unknown[];
  toolCallId?: string;
}

function buildTunnelUrl(instanceUrl: string): string {
  const url = new URL(canonicalOrigin(instanceUrl));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/tunnel";
  return url.toString();
}

const IMAGE_FETCH_TIMEOUT_MS = 10_000;
const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const TUNNEL_CONNECT_TIMEOUT_MS = 10_000;
const TUNNEL_AUTH_TIMEOUT_MS = 15_000;
const IMAGE_ASSET_PATH = /^\/api\/assets\/av\/[0-9a-f]{64}\.(png|jpe?g|webp|gif)$/;
const IMAGE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

function imageBytesMatchType(contentType: string, bytes: Buffer): boolean {
  if (contentType === "image/png") {
    return bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
  }
  if (contentType === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (contentType === "image/gif") {
    const signature = bytes.subarray(0, 6).toString("ascii");
    return signature === "GIF87a" || signature === "GIF89a";
  }
  if (contentType === "image/webp") {
    return (
      bytes.length >= 12 &&
      bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP"
    );
  }
  return false;
}

function pathExtensionMatchesType(pathname: string, contentType: string): boolean {
  const extension = IMAGE_ASSET_PATH.exec(pathname)?.[1];
  return (
    (extension === "png" && contentType === "image/png") ||
    ((extension === "jpg" || extension === "jpeg") && contentType === "image/jpeg") ||
    (extension === "webp" && contentType === "image/webp") ||
    (extension === "gif" && contentType === "image/gif")
  );
}

/**
 * Resolve one `image_url` to a data URL the inference container can consume
 * directly (CONTRACTS §3: "the inference container never fetches remote
 * URLs"). Both inline and remote images are size-, media-type-, and
 * magic-byte-validated. Remote URLs additionally must be the Instance's exact
 * content-addressed asset path. Returns null on ANY failure — callers degrade
 * the whole message, never the request.
 */
export async function inlineImageUrl(
  url: string,
  instanceOrigin: string,
  timeoutMs = IMAGE_FETCH_TIMEOUT_MS,
): Promise<string | null> {
  if (url.startsWith("data:")) {
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]*={0,2})$/i.exec(url);
    if (!match) return null;
    const contentType = match[1]!.toLowerCase();
    const decoded = Buffer.from(match[2]!, "base64");
    if (decoded.byteLength > IMAGE_MAX_BYTES || !imageBytesMatchType(contentType, decoded)) {
      return null;
    }
    return `data:${contentType};base64,${match[2]!}`;
  }

  try {
    const target = new URL(url);
    if (target.search || !IMAGE_ASSET_PATH.test(target.pathname)) return null;
    const res = await safeHttpRequest({
      url,
      allowedOrigin: instanceOrigin,
      maxResponseBytes: IMAGE_MAX_BYTES,
      timeoutMs,
      allowLoopback:
        process.env["NODE_ENV"] !== "production" &&
        process.env["ALLOW_LOOPBACK_INSTANCE_ORIGINS"] === "true",
    });
    if (res.status < 200 || res.status >= 300) return null;

    const contentType = String(res.headers["content-type"] ?? "")
      .split(";", 1)[0]!
      .trim()
      .toLowerCase();
    if (
      !IMAGE_MEDIA_TYPES.has(contentType) ||
      !pathExtensionMatchesType(target.pathname, contentType) ||
      !imageBytesMatchType(contentType, res.body)
    ) {
      return null;
    }

    const base64 = res.body.toString("base64");
    return `data:${contentType};base64,${base64}`;
  } catch {
    return null;
  }
}

/**
 * Resolve the wire message's effective content for llama-server: `contentParts`
 * (image attachments) only when the model's loaded instance has an mmproj
 * loaded — otherwise the plain `content` string, which ALREADY carries the
 * text degrade (e.g. "[image attached]") the instance chose (CONTRACTS §3 —
 * never invent a degrade here). Every `image_url` part is inlined to a data
 * URL before this returns (CONTRACTS §3 host-side inlining); if ANY part
 * fails to inline, the whole message degrades to its plain `content` string
 * — never the request.
 */
export async function resolveWireContent(
  m: WireInferenceMessage,
  visionCapable: boolean,
  instanceOrigin: string,
): Promise<string | WireContentPart[]> {
  if (!visionCapable || !m.contentParts || m.contentParts.length === 0) {
    return m.content;
  }

  const resolved: WireContentPart[] = [];
  for (const part of m.contentParts) {
    if (part.type === "text") {
      resolved.push(part);
      continue;
    }
    const inlined = await inlineImageUrl(part.image_url.url, instanceOrigin);
    if (inlined === null) {
      console.warn(
        `[tunnel] image attachment failed to inline (${part.image_url.url.slice(0, 64)}…) — degrading message to text`,
      );
      return m.content;
    }
    resolved.push({ type: "image_url", image_url: { url: inlined } });
  }
  return resolved;
}

interface ResolvedInstance {
  instance: InstanceRecord;
  thinkingActive: boolean;
  visionCapable: boolean;
}

export class TunnelClient {
  private ws: WebSocket | null = null;
  private status: TunnelStatus = "connecting";
  private destroyed = false;
  private backoffMs = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private authTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingRequests = new Map<string, PendingReq>();
  private streamListeners = new Map<string, (frame: TunnelFrame) => void>();
  private inflight = new Map<string, AbortController>();
  private authReqId: string | null = null;
  private authCtx: number | undefined;
  private _authFailed = false;

  constructor(
    private readonly placement: Placement,
    private readonly agentName: string,
    private readonly agentPrivKey: string,
    private readonly agentPubKey: string,
  ) {}

  get info(): TunnelInfo {
    return {
      placementId: this.placement.placementId,
      instanceName: this.placement.instanceName,
      instanceUrl: this.placement.instanceUrl,
      agentName: this.agentName,
      agentId: this.placement.voucher.payload.agentId,
      status: this.status,
    };
  }

  get authFailed(): boolean {
    return this._authFailed;
  }

  get voucherSig(): string {
    return this.placement.voucher.sig;
  }

  start(): void {
    this.connect();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ws = this.ws;
    if (ws) this.handleSocketDown(ws);
    ws?.close();
  }

  /**
   * Look up the loaded instance for THIS tunnel's agent's model (CONTRACTS §6
   * multi-instance loading — a tunnel routes to its agent's model's instance,
   * not a single global "active model"). Returns null when the agent has no
   * model or its model isn't currently loaded (the tunnel shouldn't be open
   * in that case — heartbeat.ts closes it within ~30s — but a request can
   * race the close, so callers must degrade to an error frame, never throw).
   */
  private resolveInstance(): ResolvedInstance | null {
    const agentId = this.placement.voucher.payload.agentId;
    const agent = getAgent(agentId);
    if (!agent?.model) return null;
    const instance = findInstanceByFilename(agent.model.filename);
    if (!instance) return null;
    const capabilities = capabilitiesForFilename(MODELS_DIR, agent.model.filename);
    const thinkingActive =
      capabilities?.thinking === true && !isThinkingDisabled(agent.model.filename);
    const visionCapable = Boolean(instance.mmprojPath);
    return { instance, thinkingActive, visionCapable };
  }

  private connect(): void {
    if (this.destroyed || this.ws) return;
    this.status = "connecting";
    let ws: WebSocket;
    try {
      const url = buildTunnelUrl(this.placement.instanceUrl);
      const allowLoopback =
        process.env["NODE_ENV"] !== "production" &&
        process.env["ALLOW_LOOPBACK_INSTANCE_ORIGINS"] === "true";
      ws = new WebSocket(url, {
        maxPayload: WIRE_LIMITS.tunnelFrameBytes,
        perMessageDeflate: false,
        handshakeTimeout: TUNNEL_CONNECT_TIMEOUT_MS,
        lookup: createSafeLookup(this.placement.instanceUrl, allowLoopback),
      });
    } catch {
      this._authFailed = true;
      this.status = "down";
      this.backoffMs = 30_000;
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.clearAuthTimer();
    this.authTimer = setTimeout(() => {
      if (this.ws !== ws || this.status === "connected") return;
      this._authFailed = true;
      ws.close(4408, "authentication timed out");
    }, TUNNEL_AUTH_TIMEOUT_MS);
    this.authTimer.unref?.();

    ws.on("message", (data) => {
      if (ws !== this.ws) return;
      const raw = typeof data === "string" ? data : data.toString();
      let frame: TunnelFrame;
      try {
        frame = parseTunnelFrame(raw);
      } catch {
        return;
      }
      this.handleFrame(frame);
    });

    ws.on("close", () => {
      this.handleSocketDown(ws);
    });

    ws.on("error", () => {
      this.handleSocketDown(ws);
    });
  }

  private clearAuthTimer(): void {
    if (this.authTimer) clearTimeout(this.authTimer);
    this.authTimer = null;
  }

  private handleSocketDown(ws: WebSocket): void {
    if (ws !== this.ws) return;
    this.ws = null;
    this.authReqId = null;
    this.authCtx = undefined;
    this.clearAuthTimer();
    for (const ac of this.inflight.values()) ac.abort();
    this.inflight.clear();
    for (const pending of this.pendingRequests.values()) {
      pending.reject(new Error("tunnel closed"));
    }
    this.pendingRequests.clear();
    this.streamListeners.clear();
    if (!this.destroyed) {
      this.status = "down";
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    if (this.reconnectTimer) return;
    const jitter = Math.random() * 1000;
    const delay = this.backoffMs + jitter;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.destroyed) this.connect();
    }, delay);
    this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
  }

  private send(frame: TunnelFrame): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame));
    }
  }

  private handleFrame(frame: TunnelFrame): void {
    if (frame.kind === "evt" && frame.method === "auth.challenge.v2") {
      void this.handleAuthChallenge(frame).catch(() => {
        this._authFailed = true;
        this.status = "down";
        this.ws?.close(4403, "authentication failed");
      });
      return;
    }

    if (frame.kind === "evt" && frame.method === "auth.challenge") {
      this._authFailed = true;
      this.status = "down";
      this.ws?.close(4403, "legacy authentication rejected");
      return;
    }

    if (frame.kind === "err" && this.authReqId && frame.id === this.authReqId) {
      this.authReqId = null;
      this.authCtx = undefined;
      this.clearAuthTimer();
      this._authFailed = true;
      this.backoffMs = 30_000;
      this.status = "down";
      this.ws?.close();
      return;
    }

    if (frame.kind === "res" && this.authReqId && frame.id === this.authReqId) {
      const result = AuthOkResult.safeParse(frame.result);
      if (result.success && result.data.ctx === this.authCtx) {
        this._authFailed = false;
        this.backoffMs = 1000;
        this.status = "connected";
        this.clearAuthTimer();
      } else {
        this._authFailed = true;
        this.status = "down";
        this.ws?.close(4403, "authentication failed");
      }
      this.authReqId = null;
      this.authCtx = undefined;
      return;
    }

    if (frame.kind === "res" || frame.kind === "err") {
      const pending = this.pendingRequests.get(frame.id);
      if (pending) {
        this.pendingRequests.delete(frame.id);
        pending.resolve(frame);
        return;
      }
      const streamListener = this.streamListeners.get(frame.id);
      if (streamListener) {
        streamListener(frame);
        return;
      }
    }

    if (frame.kind === "evt") {
      const streamListener = this.streamListeners.get(frame.id);
      if (streamListener) {
        streamListener(frame);
        return;
      }
    }

    if (frame.kind === "req") {
      this.handleRequest(frame).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        try {
          this.send(makeErr(frame.id, "E_INTERNAL", msg));
        } catch {
          // socket may already be gone — swallow
        }
      });
    }
  }

  private async handleAuthChallenge(frame: Extract<TunnelFrame, { kind: "evt" }>): Promise<void> {
    if (this.authReqId) {
      this._authFailed = true;
      this.ws?.close(4403, "duplicate authentication challenge");
      return;
    }

    const parsed = TunnelAuthChallengeV2.safeParse(frame.params);
    if (!parsed.success) {
      this._authFailed = true;
      this.ws?.close(4403, "invalid authentication challenge");
      return;
    }
    const challenge = parsed.data;
    const now = Date.now();
    if (challenge.issuedAt > now + 5_000 || now - challenge.issuedAt > 30_000) {
      this._authFailed = true;
      this.ws?.close(4403, "expired authentication challenge");
      return;
    }

    let instanceOrigin: string;
    let voucherOrigin: string;
    try {
      instanceOrigin = canonicalOrigin(this.placement.instanceUrl);
      voucherOrigin = canonicalOrigin(this.placement.voucher.payload.instanceUrl);
    } catch {
      this._authFailed = true;
      this.ws?.close(4403, "invalid placement origin");
      return;
    }
    if (instanceOrigin !== voucherOrigin) {
      this._authFailed = true;
      this.ws?.close(4403, "placement origin mismatch");
      return;
    }

    const proofPayload = HostTunnelProofV2Payload.parse({
      purpose: "interloom.tunnel-auth.v2",
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      placementId: this.placement.placementId,
      agentId: this.placement.voucher.payload.agentId,
      instanceOrigin,
      voucherDigest: canonicalSha256(this.placement.voucher),
      issuedAt: challenge.issuedAt,
    });
    const proof = signEnvelope(proofPayload, this.agentPrivKey, this.agentPubKey);
    // This agent's model's instance ctx when resolvable; falls back to the
    // first-loaded-instance ctx (back-compat) if the model isn't loaded yet —
    // the tunnel will error future requests until it is.
    const ctx = this.resolveInstance()?.instance.ctx ?? readInferenceCtx();
    const reqId = crypto.randomUUID();
    this.authReqId = reqId;
    this.authCtx = ctx;

    this.send({
      il: 1,
      id: reqId,
      kind: "req",
      method: "auth.identify.v2",
      params: {
        agentId: this.placement.voucher.payload.agentId,
        agentPubKey: this.agentPubKey,
        voucher: this.placement.voucher,
        proof,
        ctx,
        features: ["tools", "finish_reason_v1"],
      },
    });
  }

  private async handleRequest(frame: Extract<TunnelFrame, { kind: "req" }>): Promise<void> {
    if (this.status !== "connected") {
      this.send(makeErr(frame.id, "E_AUTH", "tunnel is not authenticated"));
      return;
    }
    if (frame.method === "health.ping") {
      this.send(makeRes(frame.id, { ok: true, ts: Date.now() }));
      return;
    }

    if (frame.method === "inference.complete") {
      await this.handleInferenceComplete(frame);
      return;
    }

    if (frame.method === "inference.stream") {
      await this.handleInferenceStream(frame);
      return;
    }

    this.send(makeErr(frame.id, "E_METHOD", `unknown method: ${frame.method}`));
  }

  private async handleInferenceComplete(
    frame: Extract<TunnelFrame, { kind: "req" }>,
  ): Promise<void> {
    const parsedParams = InferenceCompleteParams.safeParse(frame.params);
    if (!parsedParams.success) {
      this.send(makeErr(frame.id, "E_INTERNAL", "malformed inference params"));
      return;
    }
    const params = parsedParams.data;

    const resolved = this.resolveInstance();
    if (!resolved) {
      this.send(makeErr(frame.id, "E_INTERNAL", "agent's model is not currently loaded"));
      return;
    }
    const { instance, thinkingActive, visionCapable } = resolved;
    const thinkingDisabled = isThinkingDisabled(path.basename(instance.modelPath));

    const agentId = this.placement.voucher.payload.agentId;
    const priority = params.params?.priority ?? "interactive";

    await enqueueInference(
      instance.port,
      agentId,
      async (signal) => {
        try {
          const wireMessages = await Promise.all(
            (params.messages ?? []).map(async (m) => ({
              role: m.role,
              content: await resolveWireContent(m, visionCapable, this.placement.instanceUrl),
              ...(m.toolCalls ? { toolCalls: m.toolCalls } : {}),
              ...(m.toolCallId !== undefined ? { toolCallId: m.toolCallId } : {}),
            })),
          );

          const res = await fetch(`${instanceBaseUrl(instance.port)}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              messages: toLlamaMessages(normalizeMessages(wireMessages)),
              stream: false,
              temperature: params.params?.temperature,
              max_tokens: clampMaxTokens(params.params?.maxTokens, instance.ctx, thinkingActive),
              ...(thinkingDisabled ? { chat_template_kwargs: { enable_thinking: false } } : {}),
              ...(params.params?.tools && params.params.tools.length > 0
                ? {
                    tools: toLlamaTools(params.params.tools),
                    tool_choice: params.params?.toolChoice ?? "auto",
                  }
                : {}),
            }),
            signal,
          });

          if (!res.ok) {
            this.send(makeErr(frame.id, "E_INTERNAL", `inference error: ${res.status}`));
            return;
          }

          const data = (await res.json()) as {
            choices?: Array<{
              finish_reason?: string;
              message?: {
                role: string;
                content: string;
                tool_calls?: Array<{
                  id?: string;
                  function?: { name?: string; arguments?: string };
                }>;
              };
            }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number };
            timings?: { predicted_per_second?: number };
          };

          const message = data.choices?.[0]?.message ?? { role: "assistant", content: "" };
          const rawFinishReason = data.choices?.[0]?.finish_reason;
          const finishReason = parseFinishReason(rawFinishReason);
          if (!finishReason) {
            this.send(
              makeErr(
                frame.id,
                "E_INTERNAL",
                rawFinishReason === undefined || rawFinishReason === null
                  ? "inference result omitted finish_reason"
                  : "inference result returned an unsupported finish_reason",
              ),
            );
            return;
          }
          // Backstop stripper (CONTRACTS §6.1) — the engine already separates
          // reasoning via --reasoning-format deepseek for families it knows;
          // this catches inline <think> content for families it doesn't.
          const strippedContent = stripThinkTags(message.content ?? "");
          const promptTokens = data.usage?.prompt_tokens ?? 0;
          const completionTokens = data.usage?.completion_tokens ?? 0;
          const tokensPerSec = data.timings?.predicted_per_second ?? 0;

          const rawCalls = data.choices?.[0]?.message?.tool_calls;
          const toolCalls =
            rawCalls && rawCalls.length > 0
              ? rawCalls.map((c, i) => ({
                  id: c.id ?? `call_${i}`,
                  name: c.function?.name ?? "",
                  arguments: c.function?.arguments ?? "",
                }))
              : undefined;

          addRequestLogEntry({
            ts: Date.now(),
            source: `tunnel:${this.placement.instanceName}`,
            agentName: this.agentName,
            promptTokens,
            completionTokens,
            tokensPerSec,
          });
          recordTokensPerSec(tokensPerSec);

          this.send(
            makeRes(frame.id, {
              message: {
                ...message,
                content: strippedContent,
                ...(toolCalls ? { toolCalls } : {}),
              },
              usage: { promptTokens, completionTokens, tokensPerSec },
              finishReason,
            }),
          );
        } catch (err) {
          if (signal.aborted) {
            const preempted = String(signal.reason ?? "").includes("preempted");
            this.send(
              makeErr(
                frame.id,
                preempted ? "E_BUSY" : "E_INTERNAL",
                preempted ? "background inference preempted" : "inference run timed out",
              ),
            );
            return;
          }
          const msg = err instanceof Error ? err.message : String(err);
          this.send(makeErr(frame.id, "E_INTERNAL", msg));
        }
      },
      priority,
      priority === "background" ? 20_000 : undefined,
    );
  }

  private async handleInferenceStream(frame: Extract<TunnelFrame, { kind: "req" }>): Promise<void> {
    const parsedParams = InferenceCompleteParams.safeParse(frame.params);
    if (!parsedParams.success) {
      this.send(makeErr(frame.id, "E_INTERNAL", "malformed inference params"));
      return;
    }
    const params = parsedParams.data;

    const resolved = this.resolveInstance();
    if (!resolved) {
      this.send(makeErr(frame.id, "E_INTERNAL", "agent's model is not currently loaded"));
      return;
    }
    const { instance, thinkingActive, visionCapable } = resolved;
    const thinkingDisabled = isThinkingDisabled(path.basename(instance.modelPath));

    const agentId = this.placement.voucher.payload.agentId;
    const priority = params.params?.priority ?? "interactive";
    const closeAc = new AbortController();
    this.inflight.set(frame.id, closeAc);

    await enqueueInference(
      instance.port,
      agentId,
      async (watchdogSignal) => {
        const signal = AbortSignal.any([closeAc.signal, watchdogSignal]);
        let inferenceRes: Response;
        try {
          const wireMessages = await Promise.all(
            (params.messages ?? []).map(async (m) => ({
              role: m.role,
              content: await resolveWireContent(m, visionCapable, this.placement.instanceUrl),
              ...(m.toolCalls ? { toolCalls: m.toolCalls } : {}),
              ...(m.toolCallId !== undefined ? { toolCallId: m.toolCallId } : {}),
            })),
          );

          inferenceRes = await fetch(`${instanceBaseUrl(instance.port)}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              messages: toLlamaMessages(normalizeMessages(wireMessages)),
              stream: true,
              stream_options: { include_usage: true },
              temperature: params.params?.temperature,
              max_tokens: clampMaxTokens(params.params?.maxTokens, instance.ctx, thinkingActive),
              ...(thinkingDisabled ? { chat_template_kwargs: { enable_thinking: false } } : {}),
              ...(params.params?.tools && params.params.tools.length > 0
                ? {
                    tools: toLlamaTools(params.params.tools),
                    tool_choice: params.params?.toolChoice ?? "auto",
                  }
                : {}),
            }),
            signal,
          });
        } catch (err) {
          this.inflight.delete(frame.id);
          if (signal.aborted) return;
          const msg = err instanceof Error ? err.message : String(err);
          this.send(makeErr(frame.id, "E_INTERNAL", msg));
          return;
        }

        if (!inferenceRes.ok || !inferenceRes.body) {
          this.inflight.delete(frame.id);
          this.send(makeErr(frame.id, "E_INTERNAL", `inference error: ${inferenceRes.status}`));
          return;
        }

        const reader = inferenceRes.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let promptTokens = 0;
        let completionTokens = 0;
        let tokensPerSec = 0;
        let tunnelClosed = false;
        // Watchdog abort mid-stream (gate.ts RUN_TIMEOUT_MS) is distinct from a
        // real WS close — both abort the combined `signal`, but only a close
        // means there's nobody to hear a terminal frame. Check the WATCHDOG's
        // own signal (not the combined one) plus live WS state to tell them
        // apart, mirroring the complete path's timeout handling (:441-443).
        let watchdogTimedOut = false;
        let finishReason: InferenceFinishReason | undefined;
        let invalidFinishReason = false;
        const toolAcc = newToolCallAccumulator();
        const stripper = new ThinkStripper();

        try {
          while (true) {
            if (this.ws?.readyState !== WebSocket.OPEN) {
              tunnelClosed = true;
              break;
            }
            let readResult: Awaited<ReturnType<typeof reader.read>>;
            try {
              readResult = await reader.read();
            } catch {
              if (
                watchdogSignal.aborted &&
                !closeAc.signal.aborted &&
                this.ws?.readyState === WebSocket.OPEN
              ) {
                watchdogTimedOut = true;
              } else {
                tunnelClosed = true;
              }
              break;
            }
            const { done, value } = readResult;
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
              if (!line.startsWith("data: ")) continue;
              const data = line.slice(6).trim();
              if (data === "[DONE]") continue;
              try {
                const parsed = JSON.parse(data) as {
                  choices?: Array<{
                    delta?: {
                      content?: string;
                      reasoning_content?: string;
                      tool_calls?: ToolCallDelta[];
                    };
                    finish_reason?: string;
                  }>;
                  usage?: { prompt_tokens?: number; completion_tokens?: number };
                  timings?: { predicted_per_second?: number };
                };
                // reasoning_content is the engine's separated think channel
                // (--reasoning-format deepseek) — NEVER concatenated into
                // visible content (CONTRACTS §6.1).
                const raw = parsed.choices?.[0]?.delta?.content;
                if (raw) {
                  const delta = stripper.push(raw);
                  if (delta) {
                    this.send(makeEvt("inference.chunk", { delta }, frame.id));
                  }
                }
                const toolCallDeltas = parsed.choices?.[0]?.delta?.tool_calls;
                if (toolCallDeltas) {
                  aggregateToolCallDelta(toolAcc, toolCallDeltas);
                }
                const rawFinishReason = parsed.choices?.[0]?.finish_reason;
                if (rawFinishReason !== undefined && rawFinishReason !== null) {
                  const parsedFinishReason = parseFinishReason(rawFinishReason);
                  if (parsedFinishReason) finishReason = parsedFinishReason;
                  else invalidFinishReason = true;
                }
                // llama.cpp sends usage and timings in the final stream frame
                // (when finish_reason is set or in a trailing frame after [DONE])
                if (parsed.usage?.prompt_tokens !== undefined) {
                  promptTokens = parsed.usage.prompt_tokens;
                }
                if (parsed.usage?.completion_tokens !== undefined) {
                  completionTokens = parsed.usage.completion_tokens;
                }
                if (parsed.timings?.predicted_per_second !== undefined) {
                  tokensPerSec = parsed.timings.predicted_per_second;
                }
              } catch {
                // skip malformed lines
              }
            }
          }
        } finally {
          reader.cancel().catch(() => undefined);
          this.inflight.delete(frame.id);
        }

        if (watchdogTimedOut) {
          this.send(makeErr(frame.id, "E_INTERNAL", "inference run timed out"));
          return;
        }
        if (tunnelClosed) return;
        if (invalidFinishReason || !finishReason) {
          this.send(
            makeErr(
              frame.id,
              "E_INTERNAL",
              invalidFinishReason
                ? "inference stream returned an unsupported finish_reason"
                : "inference stream omitted finish_reason",
            ),
          );
          return;
        }

        const tail = stripper.flush();
        if (tail) {
          this.send(makeEvt("inference.chunk", { delta: tail }, frame.id));
        }

        addRequestLogEntry({
          ts: Date.now(),
          source: `tunnel:${this.placement.instanceName}`,
          agentName: this.agentName,
          promptTokens,
          completionTokens,
          tokensPerSec,
        });
        recordTokensPerSec(tokensPerSec);

        const toolCalls = finishToolCalls(toolAcc);
        this.send(
          makeRes(frame.id, {
            usage: { promptTokens, completionTokens, tokensPerSec },
            ...(toolCalls ? { toolCalls } : {}),
            finishReason,
          }),
        );
      },
      priority,
      priority === "background" ? 20_000 : undefined,
    );
  }
}
