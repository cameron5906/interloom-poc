import { webcrypto } from "node:crypto";
import type { CryptoLike, RtcAdapter, RtcDataChannelLike, RtcPeerConnectionLike, WebSocketLike, WsConstructorLike } from "../src/adapters.js";

/** Real Node webcrypto, cast to the package's minimal structural adapter shape. */
export const nodeCrypto = webcrypto as unknown as CryptoLike;

type Listener = (event: unknown) => void;

/** A `WebSocketLike` whose `send` is wired by the relay that created it. */
export class FakeSocket implements WebSocketLike {
  readyState = 1;
  onSend: ((data: string) => void) | null = null;
  private readonly listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: Listener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  send(data: string): void {
    this.onSend?.(data);
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", undefined);
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

type Role = "issuer" | "scanner";

interface CandidateEntry {
  socket: FakeSocket;
  fp: unknown;
}

/**
 * A minimal in-memory mirror of `apps/network/src/link/relay.ts`'s room
 * semantics — just enough surface (hello→candidate, approve→approved,
 * reject→rejected, confirm relay, offer/answer/ice/blob routed only to the
 * admitted candidate, done) to drive two real `LinkSession`s through the
 * full handshake without a real network server.
 */
export class FakeRelay {
  private issuerSocket: FakeSocket | null = null;
  private readonly candidates = new Map<string, CandidateEntry>();
  private readonly socketCandidateId = new Map<FakeSocket, string>();
  private readonly banned = new Set<string>();
  private admittedCandidateId: string | null = null;

  connectAs(role: Role): FakeSocket {
    const socket = new FakeSocket();
    socket.onSend = (raw) => this.onMessage(role, socket, raw);
    queueMicrotask(() => socket.emit("open", undefined));
    return socket;
  }

  /** Test hook — pushes a raw signaling frame straight to one side, bypassing routing (TTL/consumed/full errors). */
  deliverRaw(socket: FakeSocket, frame: unknown): void {
    queueMicrotask(() => socket.emit("message", { data: JSON.stringify(frame) }));
  }

  private onMessage(role: Role, socket: FakeSocket, raw: string): void {
    const frame = JSON.parse(raw) as { t: string; [k: string]: unknown };
    switch (frame.t) {
      case "join": {
        if (role === "issuer") this.issuerSocket = socket;
        return;
      }
      case "hello": {
        const candidateId = frame.candidateId as string;
        if (this.banned.has(candidateId)) {
          this.deliverRaw(socket, { t: "error", code: "E_LINK_REJECTED" });
          return;
        }
        this.candidates.set(candidateId, { socket, fp: frame.fp });
        this.socketCandidateId.set(socket, candidateId);
        if (this.issuerSocket) {
          this.deliverRaw(this.issuerSocket, { t: "candidate", candidateId, fp: frame.fp });
        }
        return;
      }
      case "approve": {
        if (this.admittedCandidateId) return;
        const candidateId = frame.candidateId as string;
        const entry = this.candidates.get(candidateId);
        if (!entry) return;
        this.admittedCandidateId = candidateId;
        this.deliverRaw(entry.socket, { t: "approved", issuerEphPk: frame.issuerEphPk });
        return;
      }
      case "reject": {
        const candidateId = frame.candidateId as string;
        this.banned.add(candidateId);
        const entry = this.candidates.get(candidateId);
        this.candidates.delete(candidateId);
        if (this.admittedCandidateId === candidateId) this.admittedCandidateId = null;
        if (entry) this.deliverRaw(entry.socket, { t: "rejected" });
        return;
      }
      case "confirm": {
        const candidateId = this.socketCandidateId.get(socket);
        if (!candidateId || candidateId !== this.admittedCandidateId) return;
        if (this.issuerSocket) this.deliverRaw(this.issuerSocket, { t: "confirm" });
        return;
      }
      case "offer":
      case "answer":
      case "ice":
      case "blob": {
        if (role === "issuer") {
          if (!this.admittedCandidateId) return;
          const entry = this.candidates.get(this.admittedCandidateId);
          if (entry) this.deliverRaw(entry.socket, frame);
          return;
        }
        const candidateId = this.socketCandidateId.get(socket);
        if (candidateId && candidateId === this.admittedCandidateId && this.issuerSocket) {
          this.deliverRaw(this.issuerSocket, frame);
        }
        return;
      }
      case "done": {
        if (this.issuerSocket) this.deliverRaw(this.issuerSocket, { t: "done" });
        return;
      }
      default:
        return;
    }
  }
}

/**
 * A `WsConstructorLike` that hands back a socket wired into `relay` as
 * `role`, ignoring the URL argument. `onSocket` lets a test grab a direct
 * handle to the socket (e.g. to inject a raw server-driven error frame)
 * without reaching into the session's private state.
 */
export function wsCtorFor(relay: FakeRelay, role: Role, onSocket?: (socket: FakeSocket) => void): WsConstructorLike {
  function FakeWs(this: unknown, _url: string) {
    const socket = relay.connectAs(role);
    onSocket?.(socket);
    return socket;
  }
  return FakeWs as unknown as WsConstructorLike;
}

/** A datachannel that never opens on its own — the test drives `open`/`message` manually. */
export class FakeDataChannel implements RtcDataChannelLike {
  sent: string[] = [];
  private readonly listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: Listener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {}

  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

/** A peer connection double that never establishes ICE — used only to exercise the 8s WS fallback timer. */
export class FakePeerConnection implements RtcPeerConnectionLike {
  readonly channels: FakeDataChannel[] = [];

  createDataChannel(_label: string): RtcDataChannelLike {
    const channel = new FakeDataChannel();
    this.channels.push(channel);
    return channel;
  }

  async createOffer(): Promise<{ sdp?: string }> {
    return { sdp: "fake-offer-sdp" };
  }

  async createAnswer(): Promise<{ sdp?: string }> {
    return { sdp: "fake-answer-sdp" };
  }

  async setLocalDescription(): Promise<void> {}

  async setRemoteDescription(): Promise<void> {}

  async addIceCandidate(): Promise<void> {}

  addEventListener(): void {
    // ICE/datachannel events are never fired by this double — it's only
    // used to prove the WS fallback timer fires when the channel never opens.
  }

  close(): void {}
}

export function fakeRtcAdapter(): RtcAdapter & { peerConnections: FakePeerConnection[] } {
  const peerConnections: FakePeerConnection[] = [];
  return {
    peerConnections,
    createPeerConnection(): RtcPeerConnectionLike {
      const pc = new FakePeerConnection();
      peerConnections.push(pc);
      return pc;
    },
  };
}

export async function flushMicrotasks(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

export async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
