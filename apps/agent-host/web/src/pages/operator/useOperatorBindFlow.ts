import { useEffect, useRef, useState } from "react";
import { operatorBind as operatorBindApi } from "../../api/endpoints.js";
import { ApiError } from "../../api/client.js";
import type { OperatorIdentity } from "../../api/types.js";

const BIND_NONCE_KEY = "il.operatorLink.nonce";

export type BindPhase = "idle" | "waiting" | "verifying" | "success" | "error";

function decodeGrantFragment(b64: string): unknown {
  const normalized = b64.replace(/-/g, "+").replace(/_/g, "/");
  const json = atob(normalized);
  return JSON.parse(json);
}

/**
 * The operator bind popup handshake (CONTRACTS §6) — opens the network's
 * `/authorize` consent page in a popup (with a same-tab redirect fallback
 * when the popup is blocked) and completes the bind once a grant comes back,
 * either via `postMessage` or — for the redirect fallback — a
 * `#grant=<b64>&nonce=<n>` URL fragment on return. Shared between the
 * full-screen `OperatorBindGate` (host has no operator, or the portal
 * session expired) and the `OperatorStaleGrantBanner` reconnect prompt (host
 * has an operator, but the network revoked its grant) — the popup flow
 * itself is identical either way.
 */
export function useOperatorBindFlow(onBound: () => void) {
  const [phase, setPhase] = useState<BindPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [boundIdentity, setBoundIdentity] = useState<OperatorIdentity | null>(null);
  const popupRef = useRef<Window | null>(null);
  const nonceRef = useRef<string | null>(null);
  const networkOriginRef = useRef<string | null>(null);

  async function completeWithGrant(grant: unknown) {
    setPhase("verifying");
    try {
      const result = await operatorBindApi.linkComplete(grant);
      setBoundIdentity(result.operator);
      setPhase("success");
      window.setTimeout(onBound, 900);
    } catch (err) {
      setPhase("error");
      setError(
        err instanceof ApiError
          ? err.isOffline
            ? "Can't reach the Agent Host daemon."
            : "That sign-in link didn't check out — please try again."
          : "Something went wrong completing sign-in.",
      );
    }
  }

  // Redirect-fallback: the network app may send us back with the grant in
  // the URL fragment instead of postMessage (popup-blocked path).
  useEffect(() => {
    const hash = window.location.hash;
    if (!hash.includes("grant=")) return;
    const params = new URLSearchParams(hash.replace(/^#/, ""));
    const grantB64 = params.get("grant");
    const nonce = params.get("nonce");
    const storedNonce = window.sessionStorage.getItem(BIND_NONCE_KEY);
    history.replaceState(null, "", window.location.pathname + window.location.search);
    if (!grantB64 || !nonce || !storedNonce || nonce !== storedNonce) return;
    try {
      void completeWithGrant(decodeGrantFragment(grantB64));
    } catch {
      setPhase("error");
      setError("Could not read the sign-in response.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // postMessage handshake while a popup is open.
  useEffect(() => {
    if (phase !== "waiting") return;
    function onMessage(e: MessageEvent) {
      if (!networkOriginRef.current || e.origin !== networkOriginRef.current) return;
      const data = e.data as { t?: string; nonce?: string; grant?: unknown } | null;
      if (!data || data.t !== "il.grant") return;
      if (!nonceRef.current || data.nonce !== nonceRef.current) return;
      void completeWithGrant(data.grant);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const start = async () => {
    setError(null);
    // Open the popup synchronously (inside the click gesture) and point it
    // at the real URL once we have it — opening it after the await risks
    // popup blockers that require a direct user-gesture association.
    const popup = window.open("", "il-authorize", "width=480,height=680");
    popupRef.current = popup;
    try {
      const result = await operatorBindApi.linkStart();
      const networkOrigin = new URL(result.networkUrl).origin;
      networkOriginRef.current = networkOrigin;
      nonceRef.current = result.nonce;
      window.sessionStorage.setItem(BIND_NONCE_KEY, result.nonce);

      const portalOrigin = window.location.origin;
      // Host-operator grants are audience-less (CONTRACTS §11.7) — the daemon
      // verifies with audience: undefined, which rejects any grant that
      // carries one, so this URL must not send an audience param.
      const url =
        `${result.networkUrl}/authorize?host=${encodeURIComponent(result.hostPubKey)}` +
        `&nonce=${encodeURIComponent(result.nonce)}` +
        `&redirect=${encodeURIComponent(portalOrigin)}`;

      if (popup && !popup.closed) {
        popup.location.href = url;
        setPhase("waiting");
      } else {
        window.location.href = url;
      }
    } catch (err) {
      popup?.close();
      setPhase("error");
      setError(
        err instanceof ApiError && err.isOffline
          ? "Can't reach the Agent Host daemon."
          : "Could not start sign-in. Please try again.",
      );
    }
  };

  return { phase, error, boundIdentity, start };
}
