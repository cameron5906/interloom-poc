import { Button, Modal } from "@interloom/ui";
import type { HostAgent, LoadedModel } from "@interloom/protocol";

/**
 * Confirm-before-unload: names exactly which agents go offline (CONTRACTS §6
 * "Load/unload/activate UX must therefore communicate agent impact"). The
 * load-side counterpart lives inline in `LoadModelWizard` — since loading is
 * additive, it only ever names agents coming online, never offline.
 */
export function UnloadImpactModal({
  model,
  allAgents,
  loading,
  onClose,
  onConfirm,
}: {
  model: LoadedModel;
  allAgents: HostAgent[];
  loading: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const affected = allAgents.filter((a) => a.model?.filename === model.filename);

  return (
    <Modal
      open
      onClose={onClose}
      title={<span>Unload {model.filename}?</span>}
      footer={
        <div className="il-impact-modal__actions">
          <Button variant="secondary" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm} disabled={loading}>
            {loading ? "Unloading…" : "Unload"}
          </Button>
        </div>
      }
    >
      <div className="il-impact-modal__body">
        {affected.length > 0 ? (
          <div className="il-impact-modal__section">
            <div className="il-impact-modal__label il-impact-modal__label--offline">
              Takes {affected.length} agent{affected.length === 1 ? "" : "s"} offline
            </div>
            <ul className="il-impact-modal__list">
              {affected.map((a) => (
                <li key={a.agentId} className="il-impact-modal__item">
                  <span className="il-impact-modal__dot il-impact-modal__dot--off" />
                  {a.name}
                </li>
              ))}
            </ul>
            <p className="il-impact-modal__note">
              Their tunnels close immediately; mentions queue in their instance inboxes and drain
              when you load this model again.
            </p>
          </div>
        ) : (
          <p className="il-meta il-impact-modal__none">No agents are assigned to this model.</p>
        )}
      </div>
    </Modal>
  );
}
