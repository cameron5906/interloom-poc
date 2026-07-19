import { useCallback, useState } from "react";
import type { LoadedModel } from "@interloom/protocol";
import { models as modelsApi } from "../../api/endpoints.js";
import { ApiError } from "../../api/client.js";
import { useToasts } from "../../components/Toasts.js";
import { clearLoadFailure, recordLoadFailure, shouldSuppressAutoLoad } from "./loadCooldown.js";

export interface LoadPlacement {
  gpus: number[];
  tensorSplit?: number[];
}

export interface LoadAttemptOptions {
  ctx?: number;
  placement?: LoadPlacement;
  /** Rig-optimizer plan (CONTRACTS §6): KV-cache precision the load launches with. */
  kvCache?: "f16" | "q8_0";
  /** Rig-optimizer plan (CONTRACTS §6): expert layers to keep in system RAM (`--n-cpu-moe`). */
  nCpuMoe?: number;
  /** Skips the spill-confirm round-trip — used when re-submitting after the user already confirmed. */
  confirmSpill?: boolean;
  /** Set for unattended re-attempts (e.g. PreviewChat's 409 model_not_active retry) so they're subject to the failure cooldown; explicit user clicks always go through. */
  auto?: boolean;
}

export interface SpillConfirmRequest {
  path: string;
  filename: string;
  ctx?: number;
  placement?: LoadPlacement;
  kvCache?: "f16" | "q8_0";
  nCpuMoe?: number;
}

/**
 * Single source of truth for the guarded `/api/models/load` flow (CONTRACTS
 * §6): POSTs the load, and when the daemon comes back 409 `needs_confirm`
 * (fit "spill") surfaces a confirm step with the §6 warning wording instead
 * of failing silently; 409 `wont_fit` and 409 `filename_conflict` (a
 * different-path model already loaded under the same basename — CONTRACTS
 * §6) surface as clear, non-blocking errors. Shared by the GPU allocation
 * planner, the preview chat's inline "Load model" action, and the agent
 * editor's model status line so every load entry point in the portal
 * enforces the same guardrails. Automatic re-attempts (`opts.auto`) for a
 * path that just failed are cooled down — explicit user clicks are never
 * gated.
 */
export function useGuardedModelLoad(
  onLoaded?: (model: LoadedModel) => void,
  onFailed?: () => void,
) {
  const toasts = useToasts();
  const [loading, setLoading] = useState(false);
  const [spillConfirm, setSpillConfirm] = useState<SpillConfirmRequest | null>(null);

  const attemptLoad = useCallback(
    async (path: string, filename: string, opts?: LoadAttemptOptions): Promise<LoadedModel | null> => {
      if (opts?.auto && shouldSuppressAutoLoad(path)) {
        toasts.error(`${filename} failed to load — retry from the Models page.`);
        onFailed?.();
        return null;
      }
      setLoading(true);
      try {
        const loaded = await modelsApi.load({
          path,
          ctx: opts?.ctx,
          placement: opts?.placement,
          confirmSpill: opts?.confirmSpill,
          kvCache: opts?.kvCache,
          nCpuMoe: opts?.nCpuMoe,
        });
        setSpillConfirm(null);
        clearLoadFailure(path);
        toasts.success(`${filename} is loaded and serving`);
        onLoaded?.(loaded);
        return loaded;
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          const body = err.body as { error?: string; fit?: string } | undefined;
          if (body?.error === "needs_confirm" && body.fit === "spill") {
            setSpillConfirm({
              path,
              filename,
              ctx: opts?.ctx,
              placement: opts?.placement,
              kvCache: opts?.kvCache,
              nCpuMoe: opts?.nCpuMoe,
            });
            return null;
          }
          if (body?.error === "wont_fit") {
            recordLoadFailure(path);
            onFailed?.();
            toasts.error(
              `${filename} won't fit in the available VRAM — free up space or pick a smaller context.`,
            );
            return null;
          }
          if (body?.error === "filename_conflict") {
            recordLoadFailure(path);
            onFailed?.();
            toasts.error(
              "A model with this filename is already loaded — unload it first.",
            );
            return null;
          }
        }
        recordLoadFailure(path);
        onFailed?.();
        toasts.error(
          err instanceof ApiError && err.isOffline
            ? "Daemon unreachable — can't load model."
            : "Failed to load model.",
        );
        return null;
      } finally {
        setLoading(false);
      }
    },
    [onLoaded, onFailed, toasts],
  );

  const confirmSpillAndRetry = useCallback((): Promise<LoadedModel | null> => {
    if (!spillConfirm) return Promise.resolve(null);
    const { path, filename, ctx, placement, kvCache, nCpuMoe } = spillConfirm;
    return attemptLoad(path, filename, { ctx, placement, kvCache, nCpuMoe, confirmSpill: true });
  }, [spillConfirm, attemptLoad]);

  const cancelSpillConfirm = useCallback(() => setSpillConfirm(null), []);

  return { loading, spillConfirm, attemptLoad, confirmSpillAndRetry, cancelSpillConfirm };
}
