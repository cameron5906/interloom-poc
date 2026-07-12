import { useEffect, useRef, useState } from "react";

/**
 * Polls `loader` every `intervalMs`, keeping the last good value while
 * refetching. Silent on transient errors (keeps stale data) — designed for
 * download progress and activation status where a blip must not clear the UI.
 * Pass `enabled: false` to pause polling (e.g. no active downloads).
 */
export function usePoll<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  intervalMs: number,
  enabled = true,
): { data: T | undefined; refresh: () => void } {
  const [data, setData] = useState<T | undefined>(undefined);
  const [tick, setTick] = useState(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const controller = new AbortController();

    const run = async () => {
      try {
        const result = await loaderRef.current(controller.signal);
        if (active) setData(result);
      } catch {
        /* keep stale data on transient failure */
      }
    };

    run();
    const id = setInterval(run, intervalMs);
    return () => {
      active = false;
      controller.abort();
      clearInterval(id);
    };
  }, [intervalMs, enabled, tick]);

  return { data, refresh: () => setTick((t) => t + 1) };
}
