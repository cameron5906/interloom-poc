import { useEffect, useState } from "react";
import { Button, Input, Modal, Avatar } from "@interloom/ui";
import { operatorBind as operatorBindApi, settings as settingsApi, keys as keysApi } from "../../api/endpoints.js";
import { useAsync } from "../../hooks/useAsync.js";
import { useToasts } from "../../components/Toasts.js";
import { useClipboard } from "../../hooks/useClipboard.js";
import { LoadError, Skeleton } from "../../components/States.js";
import { ApiError } from "../../api/client.js";
import { formatDate } from "../../lib/format.js";

/**
 * The operator identity behind every agent this host publishes (CONTRACTS
 * §6). Bound hosts show the connected network identity (avatar, name, key,
 * bound-since) with a sign-out action; unbound/legacy hosts fall back to the
 * old free-text display name — hidden the moment a real identity is bound.
 * The host machine key stays visible below either state for power users.
 */
export function OperatorIdentitySection() {
  const toasts = useToasts();
  const operator = useAsync((s) => operatorBindApi.get(s), []);
  const hostKeys = useAsync((s) => keysApi.get(s), []);
  const { copied, copy } = useClipboard();
  const [confirmingSignout, setConfirmingSignout] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const bound = operator.data?.bound ? operator.data.operator : undefined;

  const signOut = async () => {
    setSigningOut(true);
    try {
      await operatorBindApi.signout();
      toasts.success("Signed out — the portal will re-lock");
      // A full reload is the simplest way back to the bind gate: the whole
      // app tree above this section assumes a bound host once mounted.
      window.location.reload();
    } catch (err) {
      toasts.error(
        err instanceof ApiError && err.isOffline ? "Daemon unreachable." : "Could not sign out.",
      );
      setSigningOut(false);
      setConfirmingSignout(false);
    }
  };

  return (
    <section className="il-settings__section">
      <h2 className="il-settings__section-title">Operator identity</h2>
      <p className="il-settings__section-desc">
        Shown as the owner on every agent you publish — your Eris Network identity's name
        and avatar travel with them.
      </p>

      {operator.loading && operator.initialLoad ? (
        <Skeleton width={220} height={32} />
      ) : operator.error ? (
        <LoadError error={operator.error} onRetry={operator.reload} />
      ) : bound ? (
        <div className="il-op-identity">
          <div className="il-op-identity__row">
            <Avatar name={bound.displayName} isAgent={false} imageUrl={bound.avatarUrl} size="lg" />
            <div className="il-op-identity__meta">
              <div className="il-op-identity__name">{bound.displayName}</div>
              <code className="il-mono il-op-identity__key" title={bound.identityKey}>
                {bound.identityKey}
              </code>
              <div className="il-meta">connected {formatDate(bound.boundAt)}</div>
            </div>
          </div>
          <Button size="sm" variant="secondary" onClick={() => setConfirmingSignout(true)}>
            Sign out
          </Button>
        </div>
      ) : (
        <LegacyOperatorNameFallback />
      )}

      <div className="il-op-identity__hostkey">
        <span className="il-section-label">Host machine key</span>
        {hostKeys.loading && hostKeys.initialLoad ? (
          <Skeleton width={200} height={14} />
        ) : (
          <div className="il-op-identity__hostkey-row">
            <code className="il-mono il-op-identity__hostkey-code" title={hostKeys.data?.pubKey}>
              {hostKeys.data?.pubKey ?? "—"}
            </code>
            <Button size="sm" variant="secondary" onClick={() => copy(hostKeys.data?.pubKey ?? "")}>
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        )}
        <p className="il-op-identity__hostkey-note">
          The cryptographic key this host signs everything with. Power-user detail — you don't
          need it day to day.
        </p>
      </div>

      <Modal
        open={confirmingSignout}
        onClose={() => setConfirmingSignout(false)}
        title="Sign out?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmingSignout(false)} disabled={signingOut}>
              Cancel
            </Button>
            <Button variant="danger" onClick={signOut} disabled={signingOut}>
              {signingOut ? "Signing out…" : "Sign out"}
            </Button>
          </>
        }
      >
        <p>Signing out locks this portal until an operator connects again.</p>
      </Modal>
    </section>
  );
}

/**
 * Fallback shown only for an unbound/legacy host — a free-text display name
 * stamped straight onto agent manifests under the host key. Once an operator
 * binds a real identity this whole block disappears (see `OperatorIdentitySection`).
 */
function LegacyOperatorNameFallback() {
  const toasts = useToasts();
  const legacy = useAsync((s) => settingsApi.operator(s), []);
  const [displayName, setDisplayName] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (legacy.data) setDisplayName(legacy.data.displayName);
  }, [legacy.data]);

  const dirty = legacy.data != null && displayName.trim() !== legacy.data.displayName;
  const valid = displayName.trim().length > 0 && displayName.trim().length <= 60;

  const save = async () => {
    const trimmed = displayName.trim();
    if (!valid) return;
    setSaving(true);
    try {
      await settingsApi.setOperator(trimmed);
      toasts.success("Operator display name updated");
      legacy.reload();
    } catch (err) {
      toasts.error(
        err instanceof ApiError && err.isOffline ? "Daemon unreachable." : "Could not save name.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="il-op-identity__legacy">
      <p className="il-op-identity__legacy-note">
        No Eris identity connected yet — agents publish under this free-text name until you
        connect one from Settings → Operator identity.
      </p>
      {legacy.loading && legacy.initialLoad ? (
        <Skeleton width={220} height={32} />
      ) : legacy.error ? (
        <LoadError error={legacy.error} onRetry={legacy.reload} />
      ) : (
        <div className="il-settings__hf-input-row">
          <Input
            value={displayName}
            maxLength={60}
            placeholder="Your name or team name"
            onChange={(e) => setDisplayName(e.target.value)}
          />
          <Button size="sm" variant="primary" onClick={save} disabled={!dirty || !valid || saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      )}
    </div>
  );
}
