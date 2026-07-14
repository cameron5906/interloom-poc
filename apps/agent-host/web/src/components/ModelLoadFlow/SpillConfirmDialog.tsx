import { Button, Modal } from "@interloom/ui";
import type { SpillConfirmRequest } from "./useGuardedModelLoad.js";

/**
 * The explicit spill confirmation required before loading a model that
 * exceeds free VRAM (CONTRACTS §6 context-sizing warning, verbatim wording).
 * Shared by every load entry point in the portal.
 */
export function SpillConfirmDialog({
  request,
  loading,
  onCancel,
  onConfirm,
}: {
  request: SpillConfirmRequest;
  loading: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      open
      onClose={onCancel}
      title={<span>Load {request.filename} anyway?</span>}
      footer={
        <div className="il-spill-confirm__actions">
          <Button variant="secondary" onClick={onCancel} disabled={loading}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onConfirm} disabled={loading}>
            {loading ? "Loading…" : "Load anyway"}
          </Button>
        </div>
      }
    >
      <p className="il-spill-confirm__body">
        <strong>{request.filename}</strong> at this size exceeds free VRAM — it{" "}
        <strong>offloads to system RAM, expect slower generation, may fail to load</strong>.
      </p>
    </Modal>
  );
}
