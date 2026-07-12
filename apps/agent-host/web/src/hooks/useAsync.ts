import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../api/client.js";

export interface AsyncState<T> {
  data: T | undefined;
  loading: boolean;
  /** Present only on failure; `reload()` clears it. */
  error: ApiError | undefined;
  /** True the very first time we load (drives skeletons vs. inline refresh). */
  initialLoad: boolean;
  reload: () => void;
}

/**
 * Runs an async loader on mount and whenever `deps` change, tracking
 * loading/error state and exposing a `reload` for retriable error UIs. The
 * loader receives an AbortSignal so in-flight requests are cancelled on
 * unmount / dep change.
 */
export function useAsync<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[] = [],
): AsyncState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | undefined>(undefined);
  const [initialLoad, setInitialLoad] = useState(true);
  const [tick, setTick] = useState(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);

    loader(controller.signal)
      .then((result) => {
        if (controller.signal.aborted || !mounted.current) return;
        setData(result);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted || !mounted.current) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(
          err instanceof ApiError ? err : new ApiError("Something went wrong.", 500),
        );
      })
      .finally(() => {
        if (controller.signal.aborted || !mounted.current) return;
        setLoading(false);
        setInitialLoad(false);
      });

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, ...deps]);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  return { data, loading, error, initialLoad, reload };
}
