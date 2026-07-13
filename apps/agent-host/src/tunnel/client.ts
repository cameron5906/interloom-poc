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
import { INFERENCE_URL } from "../config.js";
import { addRequestLogEntry, recordTokensPerSec } from "../telemetry/collector.js";
import { normalizeMessages } from "../inference/normalize.js";
import { toLlamaMessages } from "../inference/llamaMessages.js";
import { enqueueInference } from "../inference/gate.js";
import { readInferenceCtx } from "../models/active.js";
import { clampMaxTokens } from "../inference/limits.js";
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

function buildTunnelUrl(instanceUrl: string): string {
  return instanceUrl
    .replace(/^https:\/\//, "wss://")
    .replace(/^http:\/\//, "ws://")
    .replace(/\/$/, "") + "/tunnel";
}

export class TunnelClient {
  private ws: WebSocket | null = null;
  private status: TunnelStatus = "connecting";
  private destroyed = false;
  private backoffMs = 1000;
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
    this.ws?.close();
    this.ws = null;
  }

  private connect(): void {
    if (this.destroyed) return;
    this.status = "connecting";
    const url = buildTunnelUrl(this.placement.instanceUrl);
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on("open", () => {
      this.backoffMs = 1000;
    });

    ws.on("message", (data) => {
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
      this.ws = null;
      if (!this.destroyed) {
        this.status = "down";
        this.scheduleReconnect();
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    const jitter = Math.random() * 1000;
    const delay = this.backoffMs + jitter;
    setTimeout(() => {
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
    const ctx = readInferenceCtx();
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
      messages?: Array<{ role: string; content: string }>;
      params?: {
        temperature?: number;
        maxTokens?: number;
        priority?: "interactive" | "maintenance";
        tools?: unknown[];
        toolChoice?: "auto" | "none";
      };
    };

    const agentId = this.placement.voucher.payload.agentId;
    const priority = params.params?.priority ?? "interactive";

    await enqueueInference(agentId, async () => {
      try {
        const res = await fetch(`${INFERENCE_URL}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            messages: toLlamaMessages(normalizeMessages(params.messages ?? [])),
            stream: false,
            temperature: params.params?.temperature,
            max_tokens: clampMaxTokens(params.params?.maxTokens, readInferenceCtx()),
            ...(params.params?.tools && params.params.tools.length > 0
              ? {
                  tools: (params.params.tools as Array<{ name: string; description: string; parameters: unknown }>).map(
                    (t) => ({ type: "function", function: t }),
                  ),
                  tool_choice: params.params?.toolChoice ?? "auto",
                }
              : {}),
          }),
          signal: AbortSignal.timeout(120_000),
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
            message: { ...message, ...(toolCalls ? { toolCalls } : {}) },
            usage: { promptTokens, completionTokens, tokensPerSec },
          }),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.send(makeErr(frame.id, "E_INTERNAL", msg));
      }
    }, priority);
  }

  private async handleInferenceStream(
    frame: Extract<TunnelFrame, { kind: "req" }>,
  ): Promise<void> {
    const params = frame.params as {
      messages?: Array<{ role: string; content: string }>;
      params?: {
        temperature?: number;
        maxTokens?: number;
        priority?: "interactive" | "maintenance";
        tools?: unknown[];
        toolChoice?: "auto" | "none";
      };
    };

    const agentId = this.placement.voucher.payload.agentId;
    const priority = params.params?.priority ?? "interactive";
    const ac = new AbortController();
    this.inflight.set(frame.id, ac);

    await enqueueInference(agentId, async () => {
      let inferenceRes: Response;
      try {
        inferenceRes = await fetch(`${INFERENCE_URL}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            messages: toLlamaMessages(normalizeMessages(params.messages ?? [])),
            stream: true,
            temperature: params.params?.temperature,
            max_tokens: clampMaxTokens(params.params?.maxTokens, readInferenceCtx()),
            ...(params.params?.tools && params.params.tools.length > 0
              ? {
                  tools: (params.params.tools as Array<{ name: string; description: string; parameters: unknown }>).map(
                    (t) => ({ type: "function", function: t }),
                  ),
                  tool_choice: params.params?.toolChoice ?? "auto",
                }
              : {}),
          }),
          signal: ac.signal,
        });
      } catch (err) {
        this.inflight.delete(frame.id);
        if (ac.signal.aborted) return;
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
      const toolAcc = newToolCallAccumulator();

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
            tunnelClosed = ac.signal.aborted;
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
                  delta?: { content?: string; tool_calls?: ToolCallDelta[] };
                  finish_reason?: string;
                }>;
                usage?: { prompt_tokens?: number; completion_tokens?: number };
                timings?: { predicted_per_second?: number };
              };
              const delta = parsed.choices?.[0]?.delta?.content;
              if (delta) {
                this.send(makeEvt("inference.chunk", { delta }, frame.id));
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

      if (tunnelClosed) return;

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
