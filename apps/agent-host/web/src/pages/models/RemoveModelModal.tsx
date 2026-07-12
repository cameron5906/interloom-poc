import { useState } from "react";
import { Button, Modal } from "@interloom/ui";
import type { LocalModel } from "@interloom/protocol";
import type { ActiveModel } from "../../api/types.js";
import { models as modelsApi } from "../../api/endpoints.js";
import { useToasts } from "../../components/Toasts.js";
import { ApiError } from "../../api/client.js";

interface RemoveModelModalProps {
  model: LocalModel;
  activeModel: ActiveModel | null;
  onClose: () => void;
  onRemoved: () => void;
}

/**
 * Confirm-before-remove modal. Handles the 409 model_active case by explaining
 * that the model must be deactivated first (the user does that by activating a
 * different model from the Installed tab).
 */
export function RemoveModelModal({ model, activeModel, onClose, onRemoved }: RemoveModelModalProps) {
  const toasts = useToasts();
  const [removing, setRemoving] = useState(false);
  const [activeError, setActiveError] = useState(false);

  const isCurrentlyActive = activeModel?.filename === model.filename;

  const remove = async () => {
    if (isCurrentlyActive) {
      setActiveError(true);
      return;
    }
    setRemoving(true);
    try {
      await modelsApi.removeLocal(model.path);
      toasts.success(`Removed ${model.filename}`);
      onRemoved();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setActiveError(true);
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

  return (
    <Modal
      open
      onClose={onClose}
      title={<span className="il-remove-modal__title">Remove model?</span>}
      footer={
        <div className="il-remove-modal__actions">
          {activeError ? (
            <Button variant="primary" onClick={onClose}>
              Got it
            </Button>
          ) : (
            <>
              <Button variant="secondary" onClick={onClose} disabled={removing}>
                Cancel
              </Button>
              <Button variant="danger" onClick={remove} disabled={removing}>
                {removing ? "Removing…" : "Remove"}
              </Button>
            </>
          )}
        </div>
      }
    >
      {activeError ? (
        <p className="il-remove-modal__warn">
          <strong>{model.filename}</strong> is currently active. To remove it, first activate
          a different model from the Installed tab — that will bring its agents offline and free
          this model for deletion.
        </p>
      ) : (
        <p className="il-remove-modal__body">
          This will permanently delete{" "}
          <span className="il-mono">{model.filename}</span> from your models directory.
          Agents assigned to this model will go offline until you activate another model.
        </p>
      )}
    </Modal>
  );
}
