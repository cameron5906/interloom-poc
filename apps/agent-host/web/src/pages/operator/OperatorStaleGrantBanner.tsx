import { Button, Spinner } from "@interloom/ui";
import { useOperatorBindFlow } from "./useOperatorBindFlow.js";
import "./operatorStaleGrantBanner.css";

interface OperatorStaleGrantBannerProps {
  onReconnected: () => void;
}

/**
 * Non-blocking banner shown when the bound operator's grant has gone stale
 * (CONTRACTS §11.7 — a network revoke-all bumped the identity's session_epoch
 * past what the grant was issued under, so agent re-registers now 403). The
 * portal keeps working; publishing just silently fails until the operator
 * reconnects, so this stays visible rather than a one-off toast.
 */
export function OperatorStaleGrantBanner({ onReconnected }: OperatorStaleGrantBannerProps) {
  const { phase, error, start } = useOperatorBindFlow(onReconnected);

  if (phase === "success") return null;

  const busy = phase === "waiting" || phase === "verifying";

  return (
    <div className="il-stale-banner" role="alert">
      <div className="il-stale-banner__body">
        <span className="il-stale-banner__dot" />
        <div className="il-stale-banner__text">
          <div className="il-stale-banner__title">
            Your identity connection needs a refresh — reconnect to keep publishing agents.
          </div>
          {error ? <div className="il-stale-banner__error">{error}</div> : null}
        </div>
      </div>
      {busy ? (
        <div className="il-stale-banner__busy">
          <Spinner size="sm" />
          <span>{phase === "verifying" ? "Finishing up…" : "Waiting for sign-in…"}</span>
        </div>
      ) : (
        <Button variant="secondary" onClick={start}>
          Reconnect
        </Button>
      )}
    </div>
  );
}
