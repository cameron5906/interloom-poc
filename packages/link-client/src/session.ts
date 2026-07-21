import type { LinkCandidateFingerprint, LinkSignalFrame } from "@interloom/protocol";
import type {
  CryptoLike,
  RtcAdapter,
  RtcDataChannelLike,
  RtcPeerConnectionLike,
  WebSocketLike,
  WsConstructorLike,
} from "./adapters.js";
import { WS_OPEN } from "./adapters.js";
import {
  deriveLinkKeyV2,
  encryptLinkPayload,
  decryptLinkPayload,
  generateEcdhKeyPair,
} from "./crypto.js";

/** Single const so an env override can wire a TURN-augmented list later (CONTRACTS §4). */
export const DEFAULT_STUN_URLS = ["stun:stun.l.google.com:19302"];

export type LinkStage =
  | "connect" // ws connecting/joining
  | "waiting" // issuer: QR up, no candidates yet · scanner: hello sent, awaiting approval
  | "review" // issuer only: >=1 candidate queued, awaiting issuer decision
  | "awaiting-confirm" // issuer only: approved a candidate, waiting for their confirm
  | "confirm" // scanner only: approved — show the confirm UI
  | "transfer" // payload moving (either side)
  | "done"
  | "rejected" // scanner only: issuer declined this device
  | "error";

export interface LinkCandidate {
  candidateId: string;
  fp: LinkCandidateFingerprint;
  ip?: string;
}

export interface LinkSessionCallbacks<T> {
  onStage(stage: LinkStage): void;
  /** Scanner only — fires once the payload has been decrypted and verified. */
  onPayload?(payload: T): void;
  onError?(message: string): void;
  /** Issuer only — fires with the full current candidate queue on every change. */
  onCandidates?(list: LinkCandidate[]): void;
  /** Scanner only — fires when the issuer approves this device. */
  onApproved?(issuerName?: string): void;
}

interface LinkSessionOptionsBase {
  linkId: string;
  secret: Uint8Array;
  /** Full `wss://…/ws/link/:linkId` URL — the caller resolves it (browser: `window.location`; Node: configured network host). */
  wsUrl: string;
  ws: WsConstructorLike;
  crypto: CryptoLike;
  /** `null` ⇒ no WebRTC stack available (Node): skip straight to the WS blob-relay path, no 8s wait. */
  rtc: RtcAdapter | null;
  iceServers?: string[];
}

export interface IssuerSessionOptions<T> extends LinkSessionOptionsBase {
  role: "issuer";
  payload: T;
}

export interface ScannerSessionOptions extends LinkSessionOptionsBase {
  role: "scanner";
  /** Client-asserted device fingerprint shown to the issuer (CONTRACTS §4); omitted ⇒ `{}`. */
  fingerprint?: LinkCandidateFingerprint;
}

export type LinkSessionOptions<T> = IssuerSessionOptions<T> | ScannerSessionOptions;

const DATACHANNEL_FALLBACK_MS = 8_000;

/**
 * Drives one side of the device-link handshake (CONTRACTS §4 Device link +
 * Link signaling protocol; CONTRACTS §14 for the frontier-agent variant).
 * Both the issuer (QR generator) and scanner (camera / redirected browser /
 * Node MCP) use this same class — only `role` and the payload/callback shape
 * differ. Framework-free: WebSocket, WebCrypto, and WebRTC are all injected
 * adapters, so this runs identically in the browser and in Node.
 *
 * Approval-gated: the issuer reviews a queue of scanner candidates and must
 * `approve` one before any key material moves; the approved scanner must
 * then `confirmLink` before the issuer moves to transfer. The blob key is
 * derived per key-derivation-v2 (CONTRACTS §4) from an ECDH agreement
 * between the issuer's per-approval ephemeral keypair and the approved
 * candidate's keypair — a queued rival or relay observer who only holds the
 * QR secret cannot decrypt it. When an `rtc` adapter is present, the WebRTC
 * datachannel carries the encrypted payload first, falling back to relaying
 * the same ciphertext over the WS after 8s (armed only once both sides have
 * confirmed). With `rtc: null` there is no datachannel attempt at all — the
 * blob goes straight over the WS relay as soon as the issuer sees `confirm`.
 */
export class LinkSession<T> {
  private ws: WebSocketLike | null = null;
  private pc: RtcPeerConnectionLike | null = null;
  private channel: RtcDataChannelLike | null = null;
  private fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private sentFallback = false;
  private stopped = false;

  // Issuer-only state.
  private readonly candidates = new Map<string, LinkCandidate>();
  private admittedCandidateId: string | null = null;
  private issuerEphPrivate: unknown = null;

  // Scanner-only state.
  private ownEcdhPrivate: unknown = null;
  private issuerEphPk: string | null = null;

  constructor(
    private readonly opts: LinkSessionOptions<T>,
    private readonly callbacks: LinkSessionCallbacks<T>,
  ) {}

  start(): void {
    this.callbacks.onStage("connect");
    const ws = new this.opts.ws(this.opts.wsUrl);
    this.ws = ws;

    ws.addEventListener("open", () => {
      void this.handleOpen().catch((error) => this.fail(this.errorMessage(error)));
    });

    ws.addEventListener("message", (event) => {
      void this.onFrame(String(event.data)).catch((error) => this.fail(this.errorMessage(error)));
    });

    ws.addEventListener("error", () => {
      this.fail("connection_error");
    });

    ws.addEventListener("close", () => {
      // A clean close after "done"/"rejected" is expected; anything else
      // before then is silent — the caller's stage state already reflects
      // what happened.
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.fallbackTimer) clearTimeout(this.fallbackTimer);
    this.channel?.close();
    this.pc?.close();
    this.ws?.close();
  }

  /** Issuer only — admits a queued candidate and begins the ECDH handshake with it. */
  approve(candidateId: string): void {
    if (this.opts.role !== "issuer") return;
    if (this.admittedCandidateId) return;
    if (!this.candidates.has(candidateId)) return;
    void this.approveInternal(candidateId).catch((error) => this.fail(this.errorMessage(error)));
  }

  /** Issuer only — bans a candidate from this pairing session and drops it from the queue. */
  reject(candidateId: string): void {
    if (this.opts.role !== "issuer") return;
    this.send({ t: "reject", candidateId });
    this.candidates.delete(candidateId);
    this.emitCandidates();
    if (candidateId === this.admittedCandidateId) {
      this.admittedCandidateId = null;
      this.issuerEphPrivate = null;
      if (this.fallbackTimer) {
        clearTimeout(this.fallbackTimer);
        this.fallbackTimer = null;
      }
    }
    this.callbacks.onStage(this.candidates.size > 0 ? "review" : "waiting");
  }

  /** Scanner only — confirms an approval, unblocking the issuer's transfer. */
  confirmLink(): void {
    if (this.opts.role !== "scanner") return;
    this.send({ t: "confirm" });
    this.callbacks.onStage("transfer");
  }

  private async approveInternal(candidateId: string): Promise<void> {
    const { publicKeyB64, privateKey } = await generateEcdhKeyPair(this.opts.crypto);
    this.issuerEphPrivate = privateKey;
    this.admittedCandidateId = candidateId;
    this.send({ t: "approve", candidateId, issuerEphPk: publicKeyB64 });
    this.callbacks.onStage("awaiting-confirm");
  }

  private emitCandidates(): void {
    this.callbacks.onCandidates?.(Array.from(this.candidates.values()));
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "link_session_error";
  }

  private send(frame: LinkSignalFrame): void {
    if (this.ws && this.ws.readyState === WS_OPEN) {
      this.ws.send(JSON.stringify(frame));
    }
  }

  private fail(message: string): void {
    if (this.stopped) return;
    this.callbacks.onStage("error");
    this.callbacks.onError?.(message);
  }

  private async handleOpen(): Promise<void> {
    this.send({ t: "join", role: this.opts.role });
    if (this.opts.role === "scanner") {
      const { publicKeyB64, privateKey } = await generateEcdhKeyPair(this.opts.crypto);
      this.ownEcdhPrivate = privateKey;
      const fp = this.opts.fingerprint ?? {};
      this.send({ t: "hello", candidateId: publicKeyB64, fp });
    }
    this.callbacks.onStage("waiting");
  }

  private ensurePeerConnection(): RtcPeerConnectionLike {
    if (this.pc) return this.pc;
    if (!this.opts.rtc) throw new Error("ensurePeerConnection: no rtc adapter configured");
    const pc = this.opts.rtc.createPeerConnection(this.opts.iceServers ?? DEFAULT_STUN_URLS);
    pc.addEventListener("icecandidate", (e) => {
      if (e.candidate) this.send({ t: "ice", candidate: e.candidate.toJSON() });
    });
    if (this.opts.role === "scanner") {
      pc.addEventListener("datachannel", (e) => {
        this.wireChannel(e.channel);
      });
    }
    this.pc = pc;
    return pc;
  }

  private wireChannel(channel: RtcDataChannelLike): void {
    this.channel = channel;
    channel.addEventListener("open", () => {
      if (this.fallbackTimer) {
        clearTimeout(this.fallbackTimer);
        this.fallbackTimer = null;
      }
      if (this.opts.role === "issuer") {
        void this.sendPayloadOverChannel(channel).catch((error) =>
          this.fail(this.errorMessage(error)),
        );
      }
    });
    channel.addEventListener("message", (e) => {
      if (this.opts.role === "scanner") {
        void this.onCiphertext(String(e.data)).catch((error) =>
          this.fail(this.errorMessage(error)),
        );
      }
    });
  }

  /** Issuer only — the v2 blob key for the currently-admitted candidate. */
  private async deriveOutgoingKey(): Promise<unknown> {
    if (this.opts.role !== "issuer") throw new Error("deriveOutgoingKey: not issuer");
    if (!this.issuerEphPrivate || !this.admittedCandidateId) {
      throw new Error("deriveOutgoingKey: no admitted candidate");
    }
    return deriveLinkKeyV2(
      this.opts.crypto,
      this.opts.secret,
      this.issuerEphPrivate,
      this.admittedCandidateId,
      this.opts.linkId,
    );
  }

  private async sendPayloadOverChannel(channel: RtcDataChannelLike): Promise<void> {
    if (this.opts.role !== "issuer" || this.sentFallback) return;
    this.callbacks.onStage("transfer");
    const key = await this.deriveOutgoingKey();
    const blob = await encryptLinkPayload(this.opts.crypto, key, this.opts.payload);
    channel.send(JSON.stringify({ ...blob, v: 2 }));
  }

  private async sendFallbackBlob(): Promise<void> {
    if (this.opts.role !== "issuer" || this.sentFallback) return;
    this.sentFallback = true;
    this.callbacks.onStage("transfer");
    const key = await this.deriveOutgoingKey();
    const blob = await encryptLinkPayload(this.opts.crypto, key, this.opts.payload);
    this.send({ t: "blob", ciphertextB64: blob.ciphertextB64, ivB64: blob.ivB64, v: 2 });
  }

  private async onCiphertext(raw: string): Promise<void> {
    if (this.opts.role !== "scanner") return;
    let blob: { ciphertextB64: string; ivB64: string; v?: number };
    try {
      blob = JSON.parse(raw) as { ciphertextB64: string; ivB64: string; v?: number };
    } catch {
      this.fail("decrypt_failed");
      return;
    }
    if (blob.v !== 2) {
      this.callbacks.onStage("error");
      this.callbacks.onError?.("Refresh both devices and retry.");
      return;
    }
    if (!this.ownEcdhPrivate || !this.issuerEphPk) {
      this.fail("decrypt_failed");
      return;
    }
    try {
      const key = await deriveLinkKeyV2(
        this.opts.crypto,
        this.opts.secret,
        this.ownEcdhPrivate,
        this.issuerEphPk,
        this.opts.linkId,
      );
      const payload = await decryptLinkPayload<T>(this.opts.crypto, key, blob);
      this.callbacks.onPayload?.(payload);
      this.send({ t: "done" });
      this.callbacks.onStage("done");
    } catch {
      this.fail("decrypt_failed");
    }
  }

  private async onFrame(raw: string): Promise<void> {
    let frame: LinkSignalFrame;
    try {
      frame = JSON.parse(raw) as LinkSignalFrame;
    } catch {
      return;
    }

    switch (frame.t) {
      case "candidate": {
        if (this.opts.role !== "issuer") break;
        this.candidates.set(frame.candidateId, {
          candidateId: frame.candidateId,
          fp: frame.fp,
          ip: frame.ip,
        });
        this.emitCandidates();
        if (!this.admittedCandidateId) this.callbacks.onStage("review");
        break;
      }
      case "candidate_gone": {
        if (this.opts.role !== "issuer") break;
        this.candidates.delete(frame.candidateId);
        this.emitCandidates();
        if (frame.candidateId === this.admittedCandidateId) {
          this.admittedCandidateId = null;
          this.issuerEphPrivate = null;
          if (this.fallbackTimer) {
            clearTimeout(this.fallbackTimer);
            this.fallbackTimer = null;
          }
        }
        if (!this.admittedCandidateId) {
          this.callbacks.onStage(this.candidates.size > 0 ? "review" : "waiting");
        }
        break;
      }
      case "approved": {
        if (this.opts.role !== "scanner") break;
        this.issuerEphPk = frame.issuerEphPk;
        this.callbacks.onApproved?.(frame.issuerName);
        this.callbacks.onStage("confirm");
        break;
      }
      case "rejected": {
        if (this.opts.role === "scanner") {
          this.callbacks.onStage("rejected");
          this.stop();
        }
        break;
      }
      case "confirm": {
        if (this.opts.role !== "issuer" || !this.admittedCandidateId) break;
        this.callbacks.onStage("transfer");
        if (this.opts.rtc) {
          await this.startOfferAfterConfirm();
        } else {
          await this.sendFallbackBlob();
        }
        break;
      }
      case "offer": {
        if (this.opts.role === "scanner" && this.opts.rtc) await this.handleOffer(frame.sdp);
        break;
      }
      case "answer": {
        if (this.opts.role === "issuer") {
          await this.pc?.setRemoteDescription({ type: "answer", sdp: frame.sdp });
        }
        break;
      }
      case "ice": {
        try {
          await this.pc?.addIceCandidate(frame.candidate);
        } catch {
          // Non-fatal — ICE gathering continues with other candidates.
        }
        break;
      }
      case "blob": {
        await this.onCiphertext(
          JSON.stringify({ ciphertextB64: frame.ciphertextB64, ivB64: frame.ivB64, v: frame.v }),
        );
        break;
      }
      case "done": {
        this.callbacks.onStage("done");
        break;
      }
      case "error": {
        if (frame.code === "E_LINK_REJECTED" && this.opts.role === "scanner") {
          this.callbacks.onStage("rejected");
          this.stop();
        } else {
          this.fail(frame.code);
        }
        break;
      }
      default:
        break;
    }
  }

  private async startOfferAfterConfirm(): Promise<void> {
    if (this.opts.role !== "issuer" || !this.opts.rtc) return;
    const pc = this.ensurePeerConnection();
    const channel = pc.createDataChannel("il-device-link");
    this.wireChannel(channel);
    this.fallbackTimer = setTimeout(() => {
      void this.sendFallbackBlob().catch((error) => this.fail(this.errorMessage(error)));
    }, DATACHANNEL_FALLBACK_MS);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.send({ t: "offer", sdp: offer.sdp ?? "" });
  }

  private async handleOffer(sdp: string): Promise<void> {
    const pc = this.ensurePeerConnection();
    await pc.setRemoteDescription({ type: "offer", sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this.send({ t: "answer", sdp: answer.sdp ?? "" });
  }
}

/** Convenience wrapper — same as `new LinkSession({ ...opts, role: "issuer" }, callbacks)`. */
export function createIssuer<T>(
  opts: Omit<IssuerSessionOptions<T>, "role">,
  callbacks: LinkSessionCallbacks<T>,
): LinkSession<T> {
  return new LinkSession<T>({ ...opts, role: "issuer" }, callbacks);
}

/** Convenience wrapper — same as `new LinkSession({ ...opts, role: "scanner" }, callbacks)`. */
export function createScanner<T>(
  opts: Omit<ScannerSessionOptions, "role">,
  callbacks: LinkSessionCallbacks<T>,
): LinkSession<T> {
  return new LinkSession<T>({ ...opts, role: "scanner" }, callbacks);
}
