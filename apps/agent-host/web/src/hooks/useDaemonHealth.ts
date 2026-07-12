import { useEffect, useState } from "react";
import { keys as keysApi } from "../api/endpoints.js";
import { ApiError } from "../api/client.js";

/**
 * Lightweight liveness probe for the daemon. Polls a cheap endpoint every few
 * seconds; the shell renders an amber "daemon unreachable" banner while down.
 * Kept independent of page data so a single failing page doesn't dominate the
 * global signal, and a recovered daemon clears the banner automatically.
 */
export function useDaemonHealth(intervalMs = 5000): boolean {
  const [online, setOnline] = useState(true);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();

    const probe = async () => {
      try {
        await keysApi.get(controller.signal);
        if (active) setOnline(true);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        // Only an unreachable daemon flips the banner; HTTP errors (e.g. 404
        // before keys exist) still mean the daemon is up.
        if (active && err instanceof ApiError && err.isOffline) setOnline(false);
        else if (active) setOnline(true);
      }
    };

    probe();
    const id = setInterval(probe, intervalMs);
    return () => {
      active = false;
      controller.abort();
      clearInterval(id);
    };
  }, [intervalMs]);

  return online;
}
