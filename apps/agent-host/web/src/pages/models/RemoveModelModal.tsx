import { useState } from "react";
import { Button, Modal } from "@interloom/ui";
import type { LoadedModel, LocalModel } from "@interloom/protocol";
import { models as modelsApi } from "../../api/endpoints.js";
import { useToasts } from "../../components/Toasts.js";
import { ApiError } from "../../api/client.js";

interface RemoveModelModalProps {
  model: LocalModel;
  loadedModels: LoadedModel[];
  onClose: () => void;
  onRemoved: () => void;
  /** Fires after an inline unload succeeds, so callers can refresh their own loaded/allocation state. */
  onUnloaded?: () => void;
}

/**
 * Confirm-before-remove modal. Deletion is blocked (409 `model_active`,
 * CONTRACTS §6) while the model is one of the loaded instances — in the
 * multi-load world that's just a membership check, not "some other model
 * must be active instead." The blocked state offers an inline "unload and
 * remove" action that chains `POST /api/models/unload` straight into the
 * retry so the user doesn't have to leave the modal.
 */
export function RemoveModelModal({ model, loadedModels, onClose, onRemoved, onUnloaded }: RemoveModelModalProps) {
  const toasts = useToasts();
  const [removing, setRemoving] = useState(false);
  const [unloading, setUnloading] = useState(false);
  const [blocked, setBlocked] = useState(false);

  const isCurrentlyLoaded = loadedModels.some((m) => m.path === model.path);
  const busy = removing || unloading;

  const attemptRemove = async () => {
    setRemoving(true);
    try {
      await modelsApi.removeLocal(model.path);
      toasts.success(`Removed ${model.filename}`);
      onRemoved();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setBlocked(true);
      } else {
        toasts.error(
          err instanceof ApiError && err.isOffline
            ? "Daemon unreachable — can't remove."
            : "Could not remove the model.",
        );
      }
    } finally {
      setRemoving(false);
    }
  };

  const remove = async () => {
    if (isCurrentlyLoaded) {
      setBlocked(true);
      return;
    }
    await attemptRemove();
  };

  const unloadThenRemove = async () => {
    setUnloading(true);
    try {
      await modelsApi.unload(model.path);
      onUnloaded?.();
      setBlocked(false);
    } catch (err) {
      toasts.error(
        err instanceof ApiError && err.isOffline ? "Daemon unreachable — can't unload." : "Unload failed.",
      );
      return;
    } finally {
      setUnloading(false);
    }
    await attemptRemove();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={<span className="il-remove-modal__title">Remove model?</span>}
      footer={
        <div className="il-remove-modal__actions">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          {blocked ? (
            <Button variant="primary" onClick={() => void unloadThenRemove()} disabled={busy}>
              {unloading ? "Unloading…" : "Unload and remove"}
            </Button>
          ) : (
            <Button variant="danger" onClick={() => void remove()} disabled={busy}>
              {removing ? "Removing…" : "Remove"}
            </Button>
          )}
        </div>
      }
    >
      {blocked ? (
        <p className="il-remove-modal__warn">
          <strong>{model.filename}</strong> is currently loaded — unload it first to free it for
          deletion. Agents assigned to this model will go offline until you load it again.
        </p>
      ) : (
        <p className="il-remove-modal__body">
          This will permanently delete{" "}
          <span className="il-mono">{model.filename}</span> from your models directory.
          {isCurrentlyLoaded
            ? " It's currently loaded — you'll be offered the option to unload it first."
            : null}
        </p>
      )}
    </Modal>
  );
}
