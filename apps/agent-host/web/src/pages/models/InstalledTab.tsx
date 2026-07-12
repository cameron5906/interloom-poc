import { useState } from "react";
import { Badge, Button, EmptyState } from "@interloom/ui";
import type { LocalModel } from "@interloom/protocol";
import { models as modelsApi } from "../../api/endpoints.js";
import { useAsync } from "../../hooks/useAsync.js";
import { useToasts } from "../../components/Toasts.js";
import { LoadError, Skeleton } from "../../components/States.js";
import { bytesToGB } from "../../lib/format.js";
import { ApiError } from "../../api/client.js";

export function InstalledTab({ onGoToRecommended }: { onGoToRecommended: () => void }) {
  const local = useAsync((s) => modelsApi.local(s), []);
  const toasts = useToasts();
  const [activePath, setActivePath] = useState<string | null>(null);
  const [loadingPath, setLoadingPath] = useState<string | null>(null);

  const activate = async (model: LocalModel) => {
    setLoadingPath(model.path);
    try {
      const result = await modelsApi.activate(model.path);
      if (result.status === "ready") {
        setActivePath(model.path);
        toasts.success(`${model.filename} is now serving inference`);
      } else if (result.status === "error") {
        toasts.error(result.error ?? "Model failed to load.");
      }
    } catch (err) {
      toasts.error(
        err instanceof ApiError && err.isOffline
          ? "Daemon unreachable — can't activate."
          : "Activation failed.",
      );
    } finally {
      setLoadingPath(null);
    }
  };

  if (local.loading && local.initialLoad) {
    return (
      <div className="il-installed">
        {[0, 1].map((i) => (
          <div key={i} className="il-installed__row">
            <Skeleton width={220} height={15} />
            <Skeleton width={90} height={28} radius={7} />
          </div>
        ))}
      </div>
    );
  }

  if (local.error) return <LoadError error={local.error} onRetry={local.reload} />;

  const list = local.data ?? [];
  if (list.length === 0) {
    return (
      <EmptyState
        title="No models installed yet"
        hint="Download a recommended model to run agents on your own hardware."
        action={
          <Button size="sm" variant="primary" onClick={onGoToRecommended}>
            Browse recommended
          </Button>
        }
      />
    );
  }

  return (
    <div className="il-installed">
      {list.map((m) => {
        const isActive = activePath === m.path;
        const isLoading = loadingPath === m.path;
        return (
          <div key={m.path} className={`il-installed__row${isActive ? " il-installed__row--active" : ""}`}>
            <div className="il-installed__main">
              <div className="il-installed__name">
                <span className="il-mono il-installed__filename">{m.filename}</span>
                {isActive ? <Badge variant="success">ACTIVE</Badge> : null}
              </div>
              <div className="il-meta">{bytesToGB(m.sizeBytes)} GB</div>
              {isLoading ? (
                <div className="il-installed__loading">
                  <div
                    className="il-installed__loading-bar"
                    role="progressbar"
                    aria-label="Loading model into inference server"
                  />
                  <span className="il-meta">Loading model into inference server…</span>
                </div>
              ) : null}
            </div>
            {isActive ? (
              <span className="il-installed__serving">Serving</span>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => activate(m)}
                disabled={isLoading}
              >
                {isLoading ? "Activating…" : "Activate"}
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}
