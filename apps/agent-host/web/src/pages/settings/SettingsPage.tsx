import { useState } from "react";
import { Button, Input } from "@interloom/ui";
import { settings as settingsApi } from "../../api/endpoints.js";
import { useAsync } from "../../hooks/useAsync.js";
import { useToasts } from "../../components/Toasts.js";
import { LoadError, Skeleton } from "../../components/States.js";
import { ApiError } from "../../api/client.js";
import { HostVersionSection } from "./HostVersionSection.js";
import { OperatorIdentitySection } from "./OperatorIdentitySection.js";
import "./settings.css";

export function SettingsPage() {
  return (
    <div className="il-page-scroll il-scroll-fade">
      <div className="il-page">
        <div className="il-page__head">
          <h1 className="il-page__title">Settings</h1>
          <p className="il-page__sub">Configure integrations and host preferences.</p>
        </div>

        <div className="il-settings__sections">
          <HostVersionSection />
          <OperatorIdentitySection />
          <HfAccountSection />
        </div>
      </div>
    </div>
  );
}

function HfAccountSection() {
  const toasts = useToasts();
  const hf = useAsync((s) => settingsApi.hf(s), []);
  const [token, setToken] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [showInput, setShowInput] = useState(false);

  const connect = async () => {
    const t = token.trim();
    if (!t) return;
    setConnecting(true);
    try {
      const result = await settingsApi.setHfToken(t);
      toasts.success(`Connected as ${result.username}`);
      setToken("");
      setShowInput(false);
      hf.reload();
    } catch (err) {
      toasts.error(
        err instanceof ApiError && err.isOffline
          ? "Daemon unreachable."
          : err instanceof ApiError && err.status === 401
            ? "Invalid Hugging Face token — check and try again."
            : "Could not connect Hugging Face account.",
      );
    } finally {
      setConnecting(false);
    }
  };

  const disconnect = async () => {
    setDisconnecting(true);
    try {
      await settingsApi.deleteHfToken();
      toasts.success("Hugging Face account disconnected");
      hf.reload();
    } catch (err) {
      toasts.error(
        err instanceof ApiError && err.isOffline
          ? "Daemon unreachable."
          : "Could not disconnect account.",
      );
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <section className="il-settings__section">
      <h2 className="il-settings__section-title">Hugging Face account</h2>
      <p className="il-settings__section-desc">
        Connect your Hugging Face token to access gated models and authenticated download bandwidth.
      </p>

      {hf.loading && hf.initialLoad ? (
        <div className="il-settings__hf-status">
          <Skeleton width={180} height={14} />
        </div>
      ) : hf.error ? (
        <LoadError error={hf.error} onRetry={hf.reload} />
      ) : hf.data?.connected ? (
        <div className="il-settings__hf-connected">
          <div className="il-settings__hf-row">
            <span className="il-settings__hf-dot il-settings__hf-dot--on" />
            <div>
              <div className="il-settings__hf-label">Connected</div>
              {hf.data.username ? <div className="il-meta">as {hf.data.username}</div> : null}
            </div>
          </div>
          <div className="il-settings__hf-note">
            Token is stored securely and never returned by any endpoint.
          </div>
          <Button size="sm" variant="secondary" onClick={disconnect} disabled={disconnecting}>
            {disconnecting ? "Disconnecting…" : "Disconnect"}
          </Button>
        </div>
      ) : (
        <div className="il-settings__hf-form">
          {showInput ? (
            <>
              <div className="il-settings__hf-input-row">
                <Input
                  type="password"
                  placeholder="hf_…"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  autoComplete="off"
                />
                <Button
                  size="sm"
                  variant="primary"
                  onClick={connect}
                  disabled={connecting || !token.trim()}
                >
                  {connecting ? "Connecting…" : "Connect"}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setShowInput(false);
                    setToken("");
                  }}
                  disabled={connecting}
                >
                  Cancel
                </Button>
              </div>
              <p className="il-settings__hf-note">
                Get your token at{" "}
                <a
                  href="https://huggingface.co/settings/tokens"
                  target="_blank"
                  rel="noreferrer"
                  className="il-settings__link"
                >
                  huggingface.co/settings/tokens
                </a>
                . The token is never displayed after save.
              </p>
            </>
          ) : (
            <Button size="sm" variant="secondary" onClick={() => setShowInput(true)}>
              Connect Hugging Face account
            </Button>
          )}
        </div>
      )}

      <p className="il-settings__hf-note il-settings__hf-note--footer">
        Used for gated models and authenticated download bandwidth.
      </p>
    </section>
  );
}
