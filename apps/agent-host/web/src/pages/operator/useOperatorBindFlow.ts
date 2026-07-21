import { useEffect, useRef, useState } from "react";
import { operatorBind as operatorBindApi } from "../../api/endpoints.js";
import { ApiError } from "../../api/client.js";
import type { OperatorIdentity } from "../../api/types.js";

export type BindPhase = "idle" | "waiting" | "verifying" | "success" | "error";
export interface BindCodes {
  userCode: string;
  subjectFp: string;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/**
 * PKCE-backed operator binding. The authorization URL carries only an opaque
 * handoff id; the daemon performs the one-shot exchange, so no grant or token
 * crosses a browser URL, fragment, or postMessage boundary.
 */
export function useOperatorBindFlow(onBound: () => void) {
  const [phase, setPhase] = useState<BindPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [boundIdentity, setBoundIdentity] = useState<OperatorIdentity | null>(null);
  const [codes, setCodes] = useState<BindCodes | null>(null);
  const popupRef = useRef<Window | null>(null);
  const attemptRef = useRef(0);
  const finishTimerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      attemptRef.current += 1;
      popupRef.current?.close();
      if (finishTimerRef.current !== null) window.clearTimeout(finishTimerRef.current);
    },
    [],
  );

  const start = async () => {
    const attempt = ++attemptRef.current;
    setError(null);
    setCodes(null);
    const popup = window.open("", "il-authorize", "width=480,height=680");
    popupRef.current = popup;
    if (!popup || popup.closed) {
      setPhase("error");
      setError("Allow popups for this local portal, then try again.");
      return;
    }

    try {
      const result = await operatorBindApi.linkStart();
      if (attempt !== attemptRef.current) return;
      setCodes({ userCode: result.userCode, subjectFp: result.subjectFp });
      popup.location.href = result.authorizeUrl;
      setPhase("waiting");
      const expiresAt = Date.parse(result.expiresAt);

      while (attempt === attemptRef.current && Date.now() < expiresAt) {
        await wait(1_000);
        const completed = await operatorBindApi.linkComplete(result.handoffId);
        if (attempt !== attemptRef.current) return;
        if ("pending" in completed) continue;
        setPhase("verifying");
        setBoundIdentity(completed.operator);
        setCodes(null);
        popup.close();
        setPhase("success");
        finishTimerRef.current = window.setTimeout(onBound, 900);
        return;
      }
      throw new Error("handoff_expired");
    } catch (err) {
      if (attempt !== attemptRef.current) return;
      popup.close();
      setCodes(null);
      setPhase("error");
      setError(
        err instanceof ApiError
          ? err.isOffline
            ? "Can't reach the Agent Host daemon."
            : "That sign-in handoff didn't check out — please try again."
          : err instanceof Error && err.message === "handoff_expired"
            ? "That sign-in handoff expired — please try again."
            : "Something went wrong completing sign-in.",
      );
    }
  };

  return { phase, error, boundIdentity, codes, start };
}
