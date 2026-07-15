/**
 * Environment adapters (CONTRACTS §4 Device link / §14 Frontier link) — this
 * package is framework-free and runs in both the browser and Node, so it
 * never touches `window`, `WebSocket`, `RTCPeerConnection`, or `crypto` as
 * ambient globals. Each consumer injects its own implementation: the browser
 * wires the real DOM globals, Node wires `ws` + `node:crypto`'s webcrypto,
 * with `rtc: null` when there's no WebRTC stack available.
 */

/** The subset of the browser/`ws`-package WebSocket surface the FSM needs. */
export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "close", listener: () => void): void;
  addEventListener(type: "error", listener: (event?: unknown) => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

/** A WebSocket-shaped constructor — `window.WebSocket` in the browser, `ws`'s `WebSocket` class in Node. */
export type WsConstructorLike = new (url: string) => WebSocketLike;

/** readyState value shared by both the browser WebSocket and the `ws` package. */
export const WS_OPEN = 1;

/**
 * The subset of the WebCrypto `Crypto`/`SubtleCrypto` surface the FSM needs.
 * Key/algorithm handles are opaque (`unknown`) — they only ever flow between
 * calls on the same injected `CryptoLike` instance, never inspected directly.
 */
export interface CryptoLike {
  getRandomValues<T extends Uint8Array>(array: T): T;
  subtle: {
    generateKey(
      algorithm: unknown,
      extractable: boolean,
      keyUsages: string[],
    ): Promise<{ publicKey: unknown; privateKey: unknown }>;
    exportKey(format: "raw", key: unknown): Promise<ArrayBuffer>;
    importKey(
      format: "raw",
      keyData: Uint8Array,
      algorithm: unknown,
      extractable: boolean,
      keyUsages: string[],
    ): Promise<unknown>;
    deriveBits(algorithm: unknown, baseKey: unknown, length: number): Promise<ArrayBuffer>;
    deriveKey(
      algorithm: unknown,
      baseKey: unknown,
      derivedKeyAlgorithm: unknown,
      extractable: boolean,
      keyUsages: string[],
    ): Promise<unknown>;
    encrypt(algorithm: unknown, key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
    decrypt(algorithm: unknown, key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
  };
}

export interface RtcDataChannelLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

export interface RtcPeerConnectionLike {
  createDataChannel(label: string): RtcDataChannelLike;
  createOffer(): Promise<{ sdp?: string }>;
  createAnswer(): Promise<{ sdp?: string }>;
  setLocalDescription(description: { sdp?: string }): Promise<void>;
  setRemoteDescription(description: { type: "offer" | "answer"; sdp: string }): Promise<void>;
  addIceCandidate(candidate: unknown): Promise<void>;
  addEventListener(
    type: "icecandidate",
    listener: (event: { candidate: { toJSON(): unknown } | null }) => void,
  ): void;
  addEventListener(type: "datachannel", listener: (event: { channel: RtcDataChannelLike }) => void): void;
  close(): void;
}

/**
 * WebRTC datachannel path — browser-only. `null` means "no WebRTC stack":
 * the session skips straight to the WS blob-relay path with no wait, which
 * is how the Node scanner (no RTCPeerConnection available) always operates.
 */
export interface RtcAdapter {
  createPeerConnection(stunUrls: string[]): RtcPeerConnectionLike;
}
