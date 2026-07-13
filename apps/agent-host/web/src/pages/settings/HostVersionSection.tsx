import { useState } from "react";
import { Button } from "@interloom/ui";
import { update as updateApi } from "../../api/endpoints.js";
import { useAsync } from "../../hooks/useAsync.js";
import { useToasts } from "../../components/Toasts.js";
import { LoadError, Skeleton } from "../../components/States.js";
import { relativeTime } from "../../lib/format.js";
import { UpdateModal } from "./UpdateModal.js";

export function HostVersionSection() {
  const toasts = useToasts();
  const status = useAsync((s) => updateApi.status(s), []);
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);

  const checkNow = async () => {
    setChecking(true);
    try {
      await updateApi.check();
      status.reload();
    } catch {
      toasts.error("Could not reach the daemon to check for updates.");
    } finally {
      setChecking(false);
    }
  };

  const s = status.data;
  const isDev = s?.current.version === "dev";

  return (
    <section className="il-settings__section">
      <h2 className="il-settings__section-title">Host version</h2>

      {status.loading && status.initialLoad ? (
        <Skeleton width={280} height={40} />
      ) : status.error ? (
        <LoadError error={status.error} onRetry={status.reload} />
      ) : s ? (
        <>
          <div className="il-settings__version-row">
            <div>
              <div className="il-mono il-settings__version-current">
                {isDev ? "dev build" : `v${s.current.version}`}
              </div>
              <div className="il-settings__version-meta">
                {isDev
                  ? "Development build — update checks are disabled."
                  : s.checkedAt
                    ? `Last checked ${relativeTime(s.checkedAt)}`
                    : "Not checked yet."}
                {s.checkError ? ` (last check failed: ${s.checkError})` : ""}
              </div>
            </div>
            {!isDev && (
              <Button variant="secondary" onClick={checkNow} disabled={checking}>
                {checking ? "Checking…" : "Check now"}
              </Button>
            )}
          </div>

          {s.updateAvailable && s.latest && (
            <div className="il-settings__update-card">
              <div>
                <div className="il-settings__update-title">
                  Update available: <span className="il-mono">v{s.latest.version}</span>
                </div>
                <div className="il-settings__version-meta">
                  Published {relativeTime(s.latest.publishedAt)}
                  {s.latest.notes ? ` — ${s.latest.notes}` : ""}
                </div>
              </div>
              <Button onClick={() => setUpdating(true)}>Update now</Button>
            </div>
          )}
        </>
      ) : null}

      {updating && s?.latest && (
        <UpdateModal
          current={s.current.version}
          target={s.latest}
          networkUrl={s.networkUrl}
          onClose={() => {
            setUpdating(false);
            status.reload();
          }}
        />
      )}
    </section>
  );
}
