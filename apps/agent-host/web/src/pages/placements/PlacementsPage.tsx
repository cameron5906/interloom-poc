import { useState } from "react";
import { Link } from "react-router-dom";
import { Button, EmptyState, Modal, StatusPill } from "@interloom/ui";
import type { PlacementStatus } from "@interloom/protocol";
import { placements as placementsApi } from "../../api/endpoints.js";
import { useAsync } from "../../hooks/useAsync.js";
import { useToasts } from "../../components/Toasts.js";
import { LoadError, Skeleton } from "../../components/States.js";
import { ApiError } from "../../api/client.js";
import "./placements.css";

export function PlacementsPage() {
  const list = useAsync((s) => placementsApi.list(s), []);
  const [confirming, setConfirming] = useState<PlacementStatus | null>(null);
  const [revoking, setRevoking] = useState(false);
  const toasts = useToasts();

  const revoke = async () => {
    if (!confirming) return;
    setRevoking(true);
    try {
      await placementsApi.revoke(confirming.placementId);
      toasts.success(`Revoked placement on ${confirming.instanceName}`);
      setConfirming(null);
      list.reload();
    } catch (err) {
      toasts.error(
        err instanceof ApiError && err.isOffline
          ? "Daemon unreachable — can't revoke."
          : "Revoke failed.",
      );
    } finally {
      setRevoking(false);
    }
  };

  const active = (list.data ?? []).filter((p) => !p.revoked);

  return (
    <div className="il-page-scroll il-scroll-fade">
      <div className="il-page">
        <div className="il-page__head">
          <h1 className="il-page__title">Placements</h1>
          <p className="il-page__sub">
            Instances across the Eris network where your agents are serving.
          </p>
        </div>

        {list.loading && list.initialLoad ? (
          <div className="il-placements">
            {[0, 1].map((i) => (
              <div key={i} className="il-placement-card">
                <Skeleton width={180} height={16} />
                <Skeleton width={240} height={12} />
                <Skeleton width={120} height={24} radius={20} />
              </div>
            ))}
          </div>
        ) : list.error ? (
          <LoadError error={list.error} onRetry={list.reload} />
        ) : active.length === 0 ? (
          <EmptyState
            icon={<span style={{ fontSize: 30 }}>📍</span>}
            title="No instances yet"
            hint="Your agents get invited from the Eris marketplace. Placements appear here once an instance accepts one of your agents."
            action={
              <Link to="/agents">
                <Button size="sm" variant="primary">
                  Manage agents
                </Button>
              </Link>
            }
          />
        ) : (
          <div className="il-placements">
            {active.map((p) => (
              <PlacementCard key={p.placementId} placement={p} onRevoke={() => setConfirming(p)} />
            ))}
          </div>
        )}
      </div>

      <Modal
        open={!!confirming}
        onClose={() => (revoking ? undefined : setConfirming(null))}
        title="Revoke placement?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirming(null)} disabled={revoking}>
              Cancel
            </Button>
            <Button variant="danger" onClick={revoke} disabled={revoking}>
              {revoking ? "Revoking…" : "Revoke placement"}
            </Button>
          </>
        }
      >
        <p className="il-placement-confirm">
          This removes <strong>{confirming?.instanceName}</strong>'s ability to run your agent.
          The instance's tunnel closes and the agent leaves that workspace. This can't be undone
          from here — a new invite would be required to serve there again.
        </p>
      </Modal>
    </div>
  );
}

function PlacementCard({
  placement,
  onRevoke,
}: {
  placement: PlacementStatus;
  onRevoke: () => void;
}) {
  const status = placement.tunnelStatus;
  const tone = status === "connected" ? "success" : status === "connecting" ? "warning" : "danger";

  return (
    <div className="il-placement-card">
      <div className="il-placement-card__head">
        <div>
          <div className="il-placement-card__name">{placement.instanceName}</div>
          <div className="il-meta il-placement-card__url">{placement.instanceUrl}</div>
        </div>
        <StatusPill tone={tone} live={status === "connected"} className="il-placement-card__pill">
          {status === "connected" ? "live" : status}
        </StatusPill>
      </div>

      <div className="il-placement-card__meta">
        <span className="il-meta">
          agent · <span className="il-mono">{shortId(placement.voucher.payload.agentId)}</span>
        </span>
      </div>

      <div className="il-placement-card__foot">
        <Button size="sm" variant="danger" onClick={onRevoke}>
          Revoke
        </Button>
      </div>
    </div>
  );
}

function shortId(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 8)}…`;
}
