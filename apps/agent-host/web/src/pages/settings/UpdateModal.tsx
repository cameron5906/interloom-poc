import { useEffect, useRef, useState } from "react";
import { Button, Modal, Spinner } from "@interloom/ui";
import type { UpdateStatus } from "@interloom/protocol";
import { system as systemApi, update as updateApi } from "../../api/endpoints.js";
import { ApiError } from "../../api/client.js";
import { InstallCommand } from "./InstallCommand.js";

const NOT_INSTALLER_MANAGED_MESSAGE =
  "This host runs from a checkout, not the installer, so it can't update itself. " +
  "Re-run your stack's compose pull/up — or run the installer once to enable one-click " +
  "updates (your models and agents live in Docker volumes and are kept):";

type Phase = "confirm" | "starting" | "applying" | "success" | "failed";

const APPLY_TIMEOUT_MS = 3 * 60 * 1000;
const POLL_MS = 3000;

interface UpdateModalProps {
  current: string;
  target: NonNullable<UpdateStatus["latest"]>;
  networkUrl: string;
  onClose: () => void;
}

export function UpdateModal({ current, target, networkUrl, onClose }: UpdateModalProps) {
  const [phase, setPhase] = useState<Phase>("confirm");
  const [error, setError] = useState<string | null>(null);
  const startedAt = useRef(0);

  const start = async () => {
    setPhase("starting");
    try {
      await updateApi.apply();
      startedAt.current = Date.now();
      setPhase("applying");
    } catch (err) {
      setError(
        err instanceof ApiError && err.isOffline
          ? "Daemon unreachable — is the stack running?"
          : err instanceof ApiError && err.message === "not_installer_managed"
            ? NOT_INSTALLER_MANAGED_MESSAGE
            : err instanceof ApiError
              ? err.message
              : "Could not start the update.",
      );
      setPhase("failed");
    }
  };

  // The daemon dies and comes back mid-update by design: poll /api/system
  // (tolerating errors) until it reports the target version.
  useEffect(() => {
    if (phase !== "applying") return;
    let active = true;
    const id = setInterval(() => {
      void (async () => {
        if (!active) return;
        if (Date.now() - startedAt.current > APPLY_TIMEOUT_MS) {
          setError("Timed out waiting for the daemon to come back on the new version.");
          setPhase("failed");
          return;
        }
        try {
          const info = await systemApi.get();
          if (!active) return;
          if (info.version === target.version) {
            setPhase("success");
            return;
          }
          const status = await updateApi.status();
          if (!active) return;
          if (status.apply.state === "error") {
            setError(status.apply.error ?? "The updater reported an error.");
            setPhase("failed");
          }
        } catch {
          /* daemon restarting — expected mid-update */
        }
      })();
    }, POLL_MS);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [phase, target.version]);

  const locked = phase === "applying" || phase === "starting";

  return (
    <Modal open onClose={locked ? () => {} : onClose} closeOnOverlay={!locked}>
      {phase === "confirm" && (
        <div className="il-update-modal">
          <h2>Update host to v{target.version}?</h2>
          <p>
            Your host services restart during the update. Agents go offline for a minute or
            two and come back automatically. Current version: <span className="il-mono">v{current}</span>.
          </p>
          <div className="il-update-modal__actions">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button onClick={() => void start()}>Update now</Button>
          </div>
        </div>
      )}

      {(phase === "starting" || phase === "applying") && (
        <div className="il-update-modal">
          <h2>Updating to v{target.version}…</h2>
          <div className="il-update-modal__progress">
            <Spinner />
            <p>
              Pulling images and restarting services. The portal will briefly disconnect —
              leave this tab open.
            </p>
          </div>
        </div>
      )}

      {phase === "success" && (
        <div className="il-update-modal">
          <h2>Updated to v{target.version} ✓</h2>
          <p>Reload to pick up the new portal.</p>
          <div className="il-update-modal__actions">
            <Button onClick={() => window.location.reload()}>Reload portal</Button>
          </div>
        </div>
      )}

      {phase === "failed" && (
        <div className="il-update-modal">
          <h2>Update did not complete</h2>
          <p>{error}</p>
          <p>You can update manually by re-running the installer:</p>
          <InstallCommand networkUrl={networkUrl} />
          <div className="il-update-modal__actions">
            <Button variant="secondary" onClick={onClose}>Close</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
