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
import { enqueueInference } from "../inference/gate.js";
import { readInferenceCtx } from "../models/active.js";

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

/** Clamp max_tokens to a safe value that won't exceed the context window. */
function clampMaxTokens(requested?: number): number {
  return Math.min(1024, requested ?? 512);
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

    if (frame.kind === "res" && this.authReqId && frame.id === this.authReqId) {
      const result = frame.result as { ok?: boolean } | undefined;
      if (result?.ok === true) {
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
      void this.handleRequest(frame);
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
      params?: { temperature?: number; maxTokens?: number; priority?: "interactive" | "maintenance" };
    };

    const agentId = this.placement.voucher.payload.agentId;
    const priority = params.params?.priority ?? "interactive";

    await enqueueInference(agentId, async () => {
      try {
        const res = await fetch(`${INFERENCE_URL}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            messages: params.messages ?? [],
            stream: false,
            temperature: params.params?.temperature,
            max_tokens: clampMaxTokens(params.params?.maxTokens),
          }),
        });

        if (!res.ok) {
          this.send(makeErr(frame.id, "E_INTERNAL", `inference error: ${res.status}`));
          return;
        }

        const data = await res.json() as {
          choices?: Array<{ message?: { role: string; content: string } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
          timings?: { predicted_per_second?: number };
        };

        const message = data.choices?.[0]?.message ?? { role: "assistant", content: "" };
        const promptTokens = data.usage?.prompt_tokens ?? 0;
        const completionTokens = data.usage?.completion_tokens ?? 0;
        const tokensPerSec = data.timings?.predicted_per_second ?? 0;

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
            message,
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
      params?: { temperature?: number; maxTokens?: number; priority?: "interactive" | "maintenance" };
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
            messages: params.messages ?? [],
            stream: true,
            temperature: params.params?.temperature,
            max_tokens: clampMaxTokens(params.params?.maxTokens),
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
                choices?: Array<{ delta?: { content?: string }; finish_reason?: string }>;
                usage?: { prompt_tokens?: number; completion_tokens?: number };
                timings?: { predicted_per_second?: number };
              };
              const delta = parsed.choices?.[0]?.delta?.content;
              if (delta) {
                this.send(makeEvt("inference.chunk", { delta }, frame.id));
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

      this.send(makeRes(frame.id, { usage: { promptTokens, completionTokens, tokensPerSec } }));
    }, priority);
  }
}
