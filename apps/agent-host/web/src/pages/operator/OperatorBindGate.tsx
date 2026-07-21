import { Button, Spinner, Avatar } from "@interloom/ui";
import { LoomGlyph } from "../../components/NavRail.js";
import { useOperatorBindFlow } from "./useOperatorBindFlow.js";
import "./operatorBindGate.css";

interface OperatorBindGateProps {
  /** Whether this host has never bound an identity, or a prior binding's
   * session simply expired (copy differs; the flow is identical either way
   * — completing it issues a fresh portal session regardless). */
  mode: "unbound" | "unauthenticated";
  onBound: () => void;
}

/**
 * Full-screen bind gate (CONTRACTS §6) — shown before the portal shell
 * whenever this host has no operator bound, or the portal session has
 * expired. The popup/redirect handshake itself lives in
 * `useOperatorBindFlow`, shared with `OperatorStaleGrantBanner`.
 */
export function OperatorBindGate({ mode, onBound }: OperatorBindGateProps) {
  // Presence of the exact supported bridge is only a rendering-context
  // signal. The Electron main process still has to establish the real portal
  // cookie before it creates/reloads this view.
  if (window.interloomShell?.version === 1) {
    return <ShellOperatorBindGate />;
  }

  return <StandaloneOperatorBindGate mode={mode} onBound={onBound} />;
}

/**
 * Passive-only embedded state. Kept outside the standalone component so the
 * legacy popup hook below is never invoked (and installs no listeners) in Omni.
 */
function ShellOperatorBindGate() {
  return (
    <div className="il-opbind">
      <div className="il-opbind__frame">
        <header className="il-opbind__brand">
          <span className="il-opbind__mark" aria-hidden>
            <LoomGlyph size={26} />
          </span>
          <span className="il-opbind__wordmark">Eris</span>
          <span className="il-opbind__tag">Agent Host</span>
        </header>

        <div className="il-opbind__card" aria-live="polite">
          <div className="il-opbind__waiting il-opbind__waiting--shell">
            <Spinner size="md" />
            <div>
              <h1 className="il-opbind__title">Waiting for the app to connect this host…</h1>
              <p className="il-opbind__lede">Authorization continues securely in the Eris app.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function StandaloneOperatorBindGate({ mode, onBound }: OperatorBindGateProps) {
  const { phase, error, boundIdentity, codes, start } = useOperatorBindFlow(onBound);

  const title = mode === "unbound" ? "Connect your Eris identity" : "Reconnect your Eris identity";
  const lede =
    mode === "unbound"
      ? "This host is unclaimed. Sign in with your Eris Network identity to unlock the portal — every agent you publish will carry your name and avatar."
      : "Your portal session expired. Sign back in with the same Eris Network identity to pick up where you left off.";

  return (
    <div className="il-opbind">
      <div className="il-opbind__frame">
        <header className="il-opbind__brand">
          <span className="il-opbind__mark" aria-hidden>
            <LoomGlyph size={26} />
          </span>
          <span className="il-opbind__wordmark">Eris</span>
          <span className="il-opbind__tag">Agent Host</span>
        </header>

        <div className="il-opbind__card">
          {phase === "success" && boundIdentity ? (
            <div className="il-opbind__success">
              <Avatar
                name={boundIdentity.displayName}
                isAgent={false}
                imageUrl={boundIdentity.avatarUrl}
                size="lg"
              />
              <div className="il-opbind__success-title">
                You're connected, {boundIdentity.displayName}
              </div>
              <div className="il-meta">Unlocking the portal…</div>
            </div>
          ) : (
            <>
              <h1 className="il-opbind__title">{title}</h1>
              <p className="il-opbind__lede">{lede}</p>

              {phase === "waiting" || phase === "verifying" ? (
                <div className="il-opbind__waiting">
                  <Spinner size="md" />
                  <div>
                    <div className="il-opbind__waiting-title">
                      {phase === "verifying" ? "Finishing up…" : "Waiting for sign-in…"}
                    </div>
                    <div className="il-meta">
                      Complete the consent step in the opened window — this updates automatically.
                    </div>
                    {codes ? (
                      <dl className="il-opbind__codes" aria-label="Authorization comparison codes">
                        <div>
                          <dt>Session</dt>
                          <dd>{codes.userCode}</dd>
                        </div>
                        <div>
                          <dt>Host</dt>
                          <dd>{codes.subjectFp}</dd>
                        </div>
                      </dl>
                    ) : null}
                  </div>
                </div>
              ) : (
                <Button variant="primary" onClick={start}>
                  {mode === "unbound" ? "Connect identity" : "Reconnect"}
                </Button>
              )}

              {error ? <div className="il-opbind__error">{error}</div> : null}
              {phase === "error" || phase === "waiting" ? (
                <button className="il-opbind__retry" onClick={start}>
                  {phase === "waiting" ? "Reopen sign-in window" : "Try again"}
                </button>
              ) : null}
            </>
          )}
        </div>

        <p className="il-opbind__footnote">
          Your private key never leaves your device — this only asks your identity to vouch for this
          host.
        </p>
      </div>
    </div>
  );
}
