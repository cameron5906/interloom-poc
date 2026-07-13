import { Button, Modal } from "@interloom/ui";
import type { PlacementStatus } from "@interloom/protocol";

interface CascadeWarningModalProps {
  open: boolean;
  agentName: string;
  placements: PlacementStatus[];
  confirming: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Consent gate for a signature-changing save/publish on a REGISTERED agent
 * (CONTRACTS §6 "Cascade warning"). The daemon enforces nothing here — this
 * confirm step IS the consent contract.
 */
export function CascadeWarningModal({
  open,
  agentName,
  placements,
  confirming,
  onConfirm,
  onCancel,
}: CascadeWarningModalProps) {
  return (
    <Modal
      open={open}
      onClose={() => (confirming ? undefined : onCancel())}
      title="This changes the agent's signature"
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={confirming}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm} disabled={confirming}>
            {confirming ? "Saving…" : "Save anyway"}
          </Button>
        </>
      }
    >
      <p className="il-cascade__body">
        This changes <strong>{agentName}</strong>'s signature — {placements.length} workspace
        {placements.length === 1 ? "" : "s"} must re-approve; until they do the agent is
        disconnected there, and declining removes it from that workspace.
      </p>
      <ul className="il-cascade__list">
        {placements.map((p) => (
          <li key={p.placementId} className="il-cascade__item">
            {p.instanceName}
          </li>
        ))}
      </ul>
    </Modal>
  );
}
