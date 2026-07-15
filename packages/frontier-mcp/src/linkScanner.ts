import { webcrypto } from "node:crypto";
import { WebSocket } from "ws";
import { FrontierLinkPayload } from "@interloom/protocol";
import {
  createScanner,
  parseLinkUrl,
  type CryptoLike,
  type LinkStage,
  type WsConstructorLike,
} from "@interloom/link-client";
import { log } from "./log.js";

const nodeCrypto = webcrypto as unknown as CryptoLike;
const nodeWs = WebSocket as unknown as WsConstructorLike;

const DEFAULT_TIMEOUT_MS = 60_000;

function extractOrigin(code: string): string | null {
  const trimmed = code.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

export interface ParsedFrontierLink {
  linkId: string;
  secret: Uint8Array;
  wsUrl: string;
}

/**
 * Resolves a pasted link code (full share URL, or a bare `linkId#secret`
 * per pinned-interfaces §C) into the `/ws/link/:linkId` URL the scanner
 * joins. `parseLinkUrl` (`@interloom/link-client`) only yields `{linkId,
 * secret}` — it deliberately discards the origin — so the origin/network
 * host is resolved separately here: from the code itself when it's a full
 * URL, else from `fallbackNetworkUrl` (e.g. an already-linked agent's
 * network, or `INTERLOOM_NETWORK_URL`).
 */
export function resolveLinkCode(code: string, fallbackNetworkUrl?: string): ParsedFrontierLink {
  const parsed = parseLinkUrl(code);
  if (!parsed) {
    throw new Error("invalid link code: expected a link URL or linkId#secret");
  }
  const origin = extractOrigin(code) ?? fallbackNetworkUrl ?? process.env.INTERLOOM_NETWORK_URL;
  if (!origin) {
    throw new Error(
      "cannot determine the network URL from a bare linkId#secret code — paste the full link URL instead",
    );
  }
  const wsOrigin = origin.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:").replace(/\/+$/, "");
  return { linkId: parsed.linkId, secret: parsed.secret, wsUrl: `${wsOrigin}/ws/link/${parsed.linkId}` };
}

export interface ScanLinkOptions {
  /** Used only when `code` is a bare `linkId#secret` with no origin to derive a wsUrl from. */
  fallbackNetworkUrl?: string;
  timeoutMs?: number;
}

/**
 * Runs the scanner role of the device-link handshake (CONTRACTS §4/§14)
 * against the network relay, `rtc: null` (Node has no WebRTC stack, so this
 * always takes the immediate WS blob-relay path — no 8s wait). Resolves
 * with the decrypted `FrontierLinkPayload` once the issuer approves this
 * device, the confirm round-trips, and the blob decrypts and validates.
 */
export function scanLink(code: string, options: ScanLinkOptions = {}): Promise<FrontierLinkPayload> {
  const { linkId, secret, wsUrl } = resolveLinkCode(code, options.fallbackNetworkUrl);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    let settled = false;

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      settle(() => {
        session.stop();
        reject(new Error("link timed out waiting for issuer approval"));
      });
    }, timeoutMs);
    timer.unref?.();

    const session = createScanner<unknown>(
      {
        linkId,
        secret,
        wsUrl,
        ws: nodeWs,
        crypto: nodeCrypto,
        rtc: null,
      },
      {
        onStage: (stage: LinkStage) => {
          log.debug("frontier link stage", { stage });
          if (stage === "confirm") {
            session.confirmLink();
          } else if (stage === "rejected") {
            settle(() => reject(new Error("the issuer rejected this device")));
          }
        },
        onPayload: (payload: unknown) => {
          const parsed = FrontierLinkPayload.safeParse(payload);
          if (!parsed.success) {
            settle(() => {
              session.stop();
              reject(new Error("received an invalid frontier link payload"));
            });
            return;
          }
          settle(() => resolve(parsed.data));
        },
        onError: (message: string) => {
          settle(() => reject(new Error(`link failed: ${message}`)));
        },
      },
    );

    session.start();
  });
}
