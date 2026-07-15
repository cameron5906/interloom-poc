import path from "path";
import WebSocket from "ws";
import { sign } from "@interloom/keys";
import {
  parseTunnelFrame,
  makeRes,
  makeErr,
  makeEvt,
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
import { getAgent } from "../agents/store.js";
import {
  newToolCallAccumulator,
  aggregateToolCallDelta,
  finishToolCalls,
  type ToolCallDelta,
} from "../inference/toolCalls.js";

type TunnelStatus = "connecting" | "connected" | "down";

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
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

interface WireInferenceMessage {
  role: string;
  content: string;
  contentParts?: WireContentPart[];
  toolCalls?: unknown[];
  toolCallId?: string;
}

function buildTunnelUrl(instanceUrl: string): string {
  return instanceUrl
    .replace(/^https:\/\//, "wss://")
    .replace(/^http:\/\//, "ws://")
    .replace(/\/$/, "") + "/tunnel";
}

const IMAGE_FETCH_TIMEOUT_MS = 10_000;
const IMAGE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Resolve one `image_url` to a data URL the inference container can consume
 * directly (CONTRACTS §3: "the inference container never fetches remote
 * URLs"). `data:` URLs pass through untouched (the preview path already
 * sends these from the browser). `http(s)` URLs are fetched HOST-side with a
 * 10s timeout and 8 MB cap; the response content-type must start with
 * `image/`. Returns null on ANY failure (timeout, cap, wrong type, network
 * error, unsupported scheme) — callers degrade the whole message, never the
 * request.
 */
export async function inlineImageUrl(url: string): Promise<string | null> {
  if (url.startsWith("data:")) return url;
  if (!/^https?:\/\//i.test(url)) return null;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;

    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("image/")) return null;

    const contentLength = res.headers.get("content-length");
    if (contentLength && Number(contentLength) > IMAGE_MAX_BYTES) return null;

    const buf = await res.arrayBuffer();
    if (buf.byteLength > IMAGE_MAX_BYTES) return null;

    const base64 = Buffer.from(buf).toString("base64");
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
export async function resolveWireContent(m: WireInferenceMessage, visionCapable: boolean): Promise<string | WireContentPart[]> {
  if (!visionCapable || !m.contentParts || m.contentParts.length === 0) {
    return m.content;
  }

  const resolved: WireContentPart[] = [];
  for (const part of m.contentParts) {
    if (part.type === "text") {
      resolved.push(part);
      continue;
    }
    const inlined = await inlineImageUrl(part.image_url.url);
    if (inlined === null) {
      console.warn(`[tunnel] image attachment failed to inline (${part.image_url.url.slice(0, 64)}…) — degrading message to text`);
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
  private pendingRequests = new Map<string, PendingReq>();
  private streamListeners = new Map<string, (frame: TunnelFrame) => void>();
  private inflight = new Map<string, AbortController>();
  private authReqId: string | null = null;
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
    this.ws?.close();
    this.ws = null;
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
    const thinkingActive = capabilities?.thinking === true && !isThinkingDisabled(agent.model.filename);
    const visionCapable = Boolean(instance.mmprojPath);
    return { instance, thinkingActive, visionCapable };
  }

  private connect(): void {
    if (this.destroyed) return;
    this.status = "connecting";
    const url = buildTunnelUrl(this.placement.instanceUrl);
    const ws = new WebSocket(url);
    this.ws = ws;

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
      if (ws !== this.ws) return;
      this.ws = null;
      for (const ac of this.inflight.values()) {
        ac.abort();
      }
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
    });

    ws.on("error", () => {
      if (ws !== this.ws) return;
      this.ws = null;
      if (!this.destroyed) {
        this.status = "down";
        this.scheduleReconnect();
      }
    });
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
    if (frame.kind === "evt" && frame.method === "auth.challenge") {
      void this.handleAuthChallenge(frame);
      return;
    }

    if (frame.kind === "err" && this.authReqId && frame.id === this.authReqId) {
      this.authReqId = null;
      this._authFailed = true;
      this.backoffMs = 30_000;
      this.status = "down";
      this.ws?.close();
      return;
    }

    if (frame.kind === "res" && this.authReqId && frame.id === this.authReqId) {
      const result = frame.result as { ok?: boolean } | undefined;
      if (result?.ok === true) {
        this._authFailed = false;
        this.backoffMs = 1000;
        this.status = "connected";
      }
      this.authReqId = null;
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

  private async handleAuthChallenge(
    frame: Extract<TunnelFrame, { kind: "evt" }>,
  ): Promise<void> {
    const params = frame.params as { nonce?: string } | undefined;
    const nonce = params?.nonce;
    if (!nonce || typeof nonce !== "string") {
      return;
    }

    const sig = sign(nonce, this.agentPrivKey);
    // This agent's model's instance ctx when resolvable; falls back to the
    // first-loaded-instance ctx (back-compat) if the model isn't loaded yet —
    // the tunnel will error future requests until it is.
    const ctx = this.resolveInstance()?.instance.ctx ?? readInferenceCtx();
    const reqId = crypto.randomUUID();
    this.authReqId = reqId;

    this.send({
      il: 1,
      id: reqId,
      kind: "req",
      method: "auth.identify",
      params: {
        agentId: this.placement.voucher.payload.agentId,
        agentPubKey: this.agentPubKey,
        voucher: this.placement.voucher,
        sig,
        ctx,
        features: ["tools"],
      },
    });
  }

  private async handleRequest(
    frame: Extract<TunnelFrame, { kind: "req" }>,
  ): Promise<void> {
    if (frame.method === "health.ping") {
      this.status = "connected";
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
    const params = frame.params as {
      messages?: WireInferenceMessage[];
      params?: {
        temperature?: number;
        maxTokens?: number;
        priority?: "interactive" | "maintenance";
        tools?: unknown[];
        toolChoice?: "auto" | "none";
      };
    };

    const resolved = this.resolveInstance();
    if (!resolved) {
      this.send(makeErr(frame.id, "E_INTERNAL", "agent's model is not currently loaded"));
      return;
    }
    const { instance, thinkingActive, visionCapable } = resolved;
    const thinkingDisabled = isThinkingDisabled(path.basename(instance.modelPath));

    const agentId = this.placement.voucher.payload.agentId;
    const priority = params.params?.priority ?? "interactive";

    await enqueueInference(instance.port, agentId, async (signal) => {
      try {
        const wireMessages = await Promise.all(
          (params.messages ?? []).map(async (m) => ({
            role: m.role,
            content: await resolveWireContent(m, visionCapable),
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
                  tools: (params.params.tools as Array<{ name: string; description: string; parameters: unknown }>).map(
                    (t) => ({ type: "function", function: t }),
                  ),
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

        const data = await res.json() as {
          choices?: Array<{
            message?: {
              role: string;
              content: string;
              tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
            };
          }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
          timings?: { predicted_per_second?: number };
        };

        const message = data.choices?.[0]?.message ?? { role: "assistant", content: "" };
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
            message: { ...message, content: strippedContent, ...(toolCalls ? { toolCalls } : {}) },
            usage: { promptTokens, completionTokens, tokensPerSec },
          }),
        );
      } catch (err) {
        if (signal.aborted) {
          this.send(makeErr(frame.id, "E_INTERNAL", "inference run timed out"));
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        this.send(makeErr(frame.id, "E_INTERNAL", msg));
      }
    }, priority);
  }

  private async handleInferenceStream(
    frame: Extract<TunnelFrame, { kind: "req" }>,
  ): Promise<void> {
    const params = frame.params as {
      messages?: WireInferenceMessage[];
      params?: {
        temperature?: number;
        maxTokens?: number;
        priority?: "interactive" | "maintenance";
        tools?: unknown[];
        toolChoice?: "auto" | "none";
      };
    };

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

    await enqueueInference(instance.port, agentId, async (watchdogSignal) => {
      const signal = AbortSignal.any([closeAc.signal, watchdogSignal]);
      let inferenceRes: Response;
      try {
        const wireMessages = await Promise.all(
          (params.messages ?? []).map(async (m) => ({
            role: m.role,
            content: await resolveWireContent(m, visionCapable),
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
                  tools: (params.params.tools as Array<{ name: string; description: string; parameters: unknown }>).map(
                    (t) => ({ type: "function", function: t }),
                  ),
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
            if (watchdogSignal.aborted && !closeAc.signal.aborted && this.ws?.readyState === WebSocket.OPEN) {
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
                  delta?: { content?: string; reasoning_content?: string; tool_calls?: ToolCallDelta[] };
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
        }),
      );
    }, priority);
  }
}
