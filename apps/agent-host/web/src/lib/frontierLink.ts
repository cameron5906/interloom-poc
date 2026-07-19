import type { SignedEnvelope } from "@interloom/keys";
import type { FrontierLinkIssuerAuth, FrontierLinkPayload } from "@interloom/protocol";
import type {
  CryptoLike,
  LinkCandidate,
  LinkSession,
  LinkSessionCallbacks,
  LinkStage,
  RtcAdapter,
  RtcPeerConnectionLike,
  WsConstructorLike,
} from "@interloom/link-client";
import { DEFAULT_STUN_URLS, createIssuer, decodeSecret } from "@interloom/link-client";

export { DEFAULT_STUN_URLS, decodeSecret };
export type { LinkStage, LinkCandidate };

export type FrontierLinkCallbacks = LinkSessionCallbacks<FrontierLinkPayload>;

const browserCrypto = crypto as unknown as CryptoLike;
const browserRtc: RtcAdapter = {
  createPeerConnection(stunUrls: string[]): RtcPeerConnectionLike {
    return new RTCPeerConnection({ iceServers: [{ urls: stunUrls }] }) as unknown as RtcPeerConnectionLike;
  },
};

/**
 * The relay's `/ws/link/:linkId` join frame carries an additive `auth` field
 * for `kind: "frontier-agent"` issuer joins (CONTRACTS §4/§14) — the portal
 * browser holds no network identity cookie, so it authenticates with the
 * `issuerAuth` envelope minted by `POST /api/agents/:id/frontier/link`
 * instead. `@interloom/link-client`'s `LinkSession` FSM sends the `join`
 * frame itself and has no extension point for extra fields (it's generic
 * over the payload type, not the signaling frames), so this wraps the
 * injected `ws` adapter — the FSM's own extension seam — to stamp `auth`
 * onto the one `{t:"join"}` frame it ever sends, transparently to the FSM.
 */
function createAuthInjectingWs(auth: SignedEnvelope<FrontierLinkIssuerAuth>): WsConstructorLike {
  // Not declared `implements WebSocketLike` — the interface's per-event-type
  // `addEventListener` overloads make a structurally exact class impl fight
  // the checker over a distinction that doesn't exist at runtime (every
  // listener is just forwarded to the real WebSocket's own overloaded
  // `addEventListener`). Ducktyped and cast at the return instead.
  class AuthInjectingSocket {
    private readonly socket: WebSocket;

    constructor(url: string) {
      this.socket = new WebSocket(url);
    }

    get readyState(): number {
      return this.socket.readyState;
    }

    send(data: string): void {
      let injected = data;
      try {
        const frame = JSON.parse(data) as { t?: string; role?: string; auth?: unknown };
        if (frame.t === "join" && frame.role === "issuer" && !frame.auth) {
          injected = JSON.stringify({ ...frame, auth });
        }
      } catch {
        // Not JSON (shouldn't happen for this protocol) — forward untouched.
      }
      this.socket.send(injected);
    }

    close(): void {
      this.socket.close();
    }

    addEventListener(type: string, listener: (event?: unknown) => void): void {
      this.socket.addEventListener(type, listener as EventListener);
    }
  }

  return AuthInjectingSocket as unknown as WsConstructorLike;
}

/**
 * Browser wrapper around `@interloom/link-client`'s `LinkSession`, issuer role
 * only — the agent-host portal never scans (CONTRACTS §14). Mirrors
 * `apps/network/web/src/lib/deviceLink.ts`'s adapter wiring, plus the
 * `auth`-injecting `ws` adapter above for the frontier-agent join.
 */
export class FrontierLinkSession {
  private readonly session: LinkSession<FrontierLinkPayload>;

  constructor(
    opts: {
      linkId: string;
      secret: Uint8Array;
      wsUrl: string;
      payload: FrontierLinkPayload;
      issuerAuth: SignedEnvelope<FrontierLinkIssuerAuth>;
    },
    callbacks: FrontierLinkCallbacks,
  ) {
    this.session = createIssuer(
      {
        linkId: opts.linkId,
        secret: opts.secret,
        wsUrl: opts.wsUrl,
        ws: createAuthInjectingWs(opts.issuerAuth),
        crypto: browserCrypto,
        rtc: browserRtc,
        payload: opts.payload,
      },
      callbacks,
    );
  }

  start(): void {
    this.session.start();
  }

  stop(): void {
    this.session.stop();
  }

  approve(candidateId: string): void {
    this.session.approve(candidateId);
  }

  reject(candidateId: string): void {
    this.session.reject(candidateId);
  }
}
