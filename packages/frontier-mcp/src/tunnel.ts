import WebSocket from "ws";
import { canonicalSha256, signEnvelope } from "@interloom/keys";
import {
  AuthOkResult,
  ChatPostResult,
  ContextListResult,
  ContextReadResult,
  makeErr,
  makeReq,
  makeRes,
  parseTunnelFrame,
  canonicalOrigin,
  HostTunnelProofV2Payload,
  TunnelAuthChallengeV2,
  WIRE_LIMITS,
  WorkBeginResult,
  WorkCompleteResult,
  WorkFailResult,
  WorkPassResult,
  WorkPullResult,
  type FrontierWorkItem,
  type Placement,
  type TunnelFrame,
} from "@interloom/protocol";
import { log } from "./log.js";
import { createSafeLookup } from "./security/safeLookup.js";

/**
 * Slim host-side tunnel client for a frontier agent's placement (CONTRACTS
 * §3/§14). Modeled on `apps/agent-host/src/tunnel/client.ts` minus every
 * inference concern — this client only ever calls `work.*`/`chat.post` and
 * answers `health.ping`; it identifies with `features: ["frontierQueue"]`,
 * never `"tools"`.
 */
export type TunnelStatus = "connecting" | "connected" | "down";

export interface TunnelInfo {
  placementId: string;
  instanceName: string;
  instanceUrl: string;
  agentId: string;
  status: TunnelStatus;
}

interface PendingReq {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

/** A tunnel `err` frame surfaced as a rejection, carrying the wire error code so callers can branch on it. */
export class TunnelCallFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TunnelCallFailure";
  }
}

/**
 * `work.complete`/`work.fail` rejected with `E_STALE_LEASE` (CONTRACTS §14
 * "Lease ownership") — the item's lease expired and was reassigned, or was
 * already completed by another session sharing the agent keypair. Never a
 * crash-worthy condition: callers drop the local item and keep working the
 * queue.
 */
export class StaleLeaseError extends Error {
  constructor(readonly workId: string) {
    super(`work item ${workId}'s lease is stale — it was reassigned or already completed`);
    this.name = "StaleLeaseError";
  }
}

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
const DEFAULT_CALL_TIMEOUT_MS = 30_000;
const TUNNEL_CONNECT_TIMEOUT_MS = 10_000;
const TUNNEL_AUTH_TIMEOUT_MS = 15_000;

function buildTunnelUrl(instanceUrl: string): string {
  const url = new URL(canonicalOrigin(instanceUrl));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/tunnel";
  return url.toString();
}

export class TunnelClient {
  private ws: WebSocket | null = null;
  private status: TunnelStatus = "connecting";
  private destroyed = false;
  private backoffMs = INITIAL_BACKOFF_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private authTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pendingRequests = new Map<string, PendingReq>();
  private authReqId: string | null = null;
  private _authFailed = false;
  private readonly workAvailableListeners = new Set<() => void>();
  private readonly connectedListeners = new Set<() => void>();

  constructor(
    private readonly placement: Placement,
    private readonly agentId: string,
    private readonly agentPrivKey: string,
    private readonly agentPubKey: string,
  ) {}

  get info(): TunnelInfo {
    return {
      placementId: this.placement.placementId,
      instanceName: this.placement.instanceName,
      instanceUrl: this.placement.instanceUrl,
      agentId: this.agentId,
      status: this.status,
    };
  }

  get authFailed(): boolean {
    return this._authFailed;
  }

  get isConnected(): boolean {
    return this.status === "connected";
  }

  get voucherSig(): string {
    return this.placement.voucher.sig;
  }

  /** Fires on the instance's `work.available` nudge (CONTRACTS §14) — a hint to pull now. */
  onWorkAvailable(cb: () => void): void {
    this.workAvailableListeners.add(cb);
  }

  /** Fires once auth completes and the tunnel transitions to `connected`. */
  onConnected(cb: () => void): void {
    this.connectedListeners.add(cb);
  }

  start(): void {
    this.connect();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const ws = this.ws;
    if (ws) this.handleSocketDown(ws);
    ws?.close();
    for (const pending of this.pendingRequests.values()) {
      pending.reject(new Error("tunnel destroyed"));
    }
    this.pendingRequests.clear();
  }

  private connect(): void {
    if (this.destroyed || this.ws) return;
    this.status = "connecting";
    const url = buildTunnelUrl(this.placement.instanceUrl);
    let ws: WebSocket;
    try {
      const allowLoopback = process.env["ALLOW_LOOPBACK_INSTANCE_ORIGINS"] === "true";
      ws = new WebSocket(url, {
        maxPayload: WIRE_LIMITS.tunnelFrameBytes,
        perMessageDeflate: false,
        handshakeTimeout: TUNNEL_CONNECT_TIMEOUT_MS,
        lookup: createSafeLookup(this.placement.instanceUrl, allowLoopback),
      });
    } catch (error) {
      this.status = "down";
      log.warn("frontier tunnel destination rejected", {
        instanceUrl: this.placement.instanceUrl,
        error: error instanceof Error ? error.message : String(error),
      });
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
      if (this.ws !== ws) return;
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

  private handleSocketDown(ws: WebSocket): void {
    if (this.ws !== ws) return;
    this.ws = null;
    this.authReqId = null;
    this.clearAuthTimer();
    for (const pending of this.pendingRequests.values()) {
      pending.reject(new Error("tunnel closed"));
    }
    this.pendingRequests.clear();
    if (!this.destroyed) {
      this.status = "down";
      this.scheduleReconnect();
    }
  }

  private clearAuthTimer(): void {
    if (this.authTimer) clearTimeout(this.authTimer);
    this.authTimer = null;
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.reconnectTimer) return;
    const jitter = Math.random() * 1000;
    const delay = this.backoffMs + jitter;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.destroyed) this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
  }

  private send(frame: TunnelFrame): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame));
    }
  }

  private handleFrame(frame: TunnelFrame): void {
    if (frame.kind === "evt" && frame.method === "auth.challenge.v2") {
      this.handleAuthChallenge(frame);
      return;
    }

    if (frame.kind === "evt" && frame.method === "auth.challenge") {
      this._authFailed = true;
      this.status = "down";
      this.ws?.close(4403, "legacy authentication rejected");
      return;
    }

    if (frame.kind === "evt" && frame.method === "work.available") {
      for (const cb of this.workAvailableListeners) cb();
      return;
    }

    if (frame.kind === "err" && this.authReqId && frame.id === this.authReqId) {
      this.authReqId = null;
      this.clearAuthTimer();
      this._authFailed = true;
      this.backoffMs = MAX_BACKOFF_MS;
      this.status = "down";
      log.warn("frontier tunnel auth rejected", {
        instanceUrl: this.placement.instanceUrl,
        reason: frame.error.message,
      });
      this.ws?.close();
      return;
    }

    if (frame.kind === "res" && this.authReqId && frame.id === this.authReqId) {
      const result = AuthOkResult.safeParse(frame.result);
      if (result.success && result.data.ctx === undefined) {
        this._authFailed = false;
        this.backoffMs = INITIAL_BACKOFF_MS;
        this.status = "connected";
        this.clearAuthTimer();
        for (const cb of this.connectedListeners) cb();
      } else {
        this._authFailed = true;
        this.status = "down";
        this.ws?.close(4403, "authentication failed");
      }
      this.authReqId = null;
      return;
    }

    if (frame.kind === "res" || frame.kind === "err") {
      const pending = this.pendingRequests.get(frame.id);
      if (pending) {
        this.pendingRequests.delete(frame.id);
        if (frame.kind === "err") {
          pending.reject(new TunnelCallFailure(frame.error.code, frame.error.message));
        } else {
          pending.resolve(frame.result);
        }
      }
      return;
    }

    if (frame.kind === "req") {
      if (frame.method === "health.ping") {
        if (this.status !== "connected") {
          this.send(makeErr(frame.id, "E_AUTH", "tunnel is not authenticated"));
          return;
        }
        this.send(makeRes(frame.id, { ok: true, ts: Date.now() }));
        return;
      }
      this.send(makeErr(frame.id, "E_METHOD", `unsupported method: ${frame.method}`));
    }
  }

  private handleAuthChallenge(frame: Extract<TunnelFrame, { kind: "evt" }>): void {
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

    const proof = signEnvelope(
      HostTunnelProofV2Payload.parse({
        purpose: "interloom.tunnel-auth.v2",
        challengeId: challenge.challengeId,
        nonce: challenge.nonce,
        placementId: this.placement.placementId,
        agentId: this.agentId,
        instanceOrigin,
        voucherDigest: canonicalSha256(this.placement.voucher),
        issuedAt: challenge.issuedAt,
      }),
      this.agentPrivKey,
      this.agentPubKey,
    );
    const reqId = crypto.randomUUID();
    this.authReqId = reqId;

    this.send({
      il: 1,
      id: reqId,
      kind: "req",
      method: "auth.identify.v2",
      params: {
        agentId: this.agentId,
        agentPubKey: this.agentPubKey,
        voucher: this.placement.voucher,
        proof,
        features: ["frontierQueue"],
      },
    });
  }

  private call(
    method: string,
    params: unknown,
    timeoutMs = DEFAULT_CALL_TIMEOUT_MS,
  ): Promise<unknown> {
    if (this.ws?.readyState !== WebSocket.OPEN || this.status !== "connected") {
      return Promise.reject(new Error(`tunnel not connected: ${this.placement.instanceUrl}`));
    }
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`tunnel call ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pendingRequests.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.send(makeReq(method, params, id));
    });
  }

  async pull(max: number): Promise<FrontierWorkItem[]> {
    const result = await this.call("work.pull", { agentId: this.agentId, max });
    const parsed = WorkPullResult.safeParse(result);
    return parsed.success ? parsed.data.items : [];
  }

  async begin(workId: string): Promise<void> {
    const result = await this.call("work.begin", { workId });
    WorkBeginResult.parse(result);
  }

  /** Throws `StaleLeaseError` (never a generic error) when the instance rejects with `E_STALE_LEASE`. */
  async complete(
    workId: string,
    leaseToken: string | undefined,
    text: string,
  ): Promise<{ messageId?: string; posted?: boolean }> {
    try {
      const result = await this.call("work.complete", { workId, text, leaseToken });
      const parsed = WorkCompleteResult.parse(result);
      return {
        ...(parsed.messageId ? { messageId: parsed.messageId } : {}),
        ...(parsed.posted === undefined ? {} : { posted: parsed.posted }),
      };
    } catch (err) {
      if (err instanceof TunnelCallFailure && err.code === "E_STALE_LEASE")
        throw new StaleLeaseError(workId);
      throw err;
    }
  }

  /** Throws `StaleLeaseError` (never a generic error) when the instance rejects with `E_STALE_LEASE`. */
  async fail(workId: string, leaseToken: string | undefined, reason: string): Promise<void> {
    try {
      const result = await this.call("work.fail", { workId, reason, leaseToken });
      WorkFailResult.parse(result);
    } catch (err) {
      if (err instanceof TunnelCallFailure && err.code === "E_STALE_LEASE")
        throw new StaleLeaseError(workId);
      throw err;
    }
  }

  async pass(workId: string, leaseToken: string | undefined): Promise<void> {
    try {
      WorkPassResult.parse(await this.call("work.pass", { workId, leaseToken }));
    } catch (err) {
      if (err instanceof TunnelCallFailure && err.code === "E_STALE_LEASE")
        throw new StaleLeaseError(workId);
      throw err;
    }
  }

  async post(channelId: string, text: string): Promise<{ messageId: string }> {
    const result = await this.call("chat.post", { channelId, text });
    const parsed = ChatPostResult.parse(result);
    return { messageId: parsed.messageId };
  }

  async contextList(params: { path?: string; ref?: string; limit?: number }) {
    return ContextListResult.parse(await this.call("context.list", params));
  }

  async contextRead(params: { path: string; ref?: string; offset?: number; maxBytes?: number }) {
    return ContextReadResult.parse(await this.call("context.read", params));
  }
}
