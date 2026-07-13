import { useEffect, useState } from "react";
import { Button, Input } from "@interloom/ui";
import { settings as settingsApi } from "../../api/endpoints.js";
import { useAsync } from "../../hooks/useAsync.js";
import { useToasts } from "../../components/Toasts.js";
import { LoadError, Skeleton } from "../../components/States.js";
import { ApiError } from "../../api/client.js";

/**
 * The operator identity behind every agent this host publishes (CONTRACTS
 * §6/§4) — one keypair signs all of them, so this display name is what shows
 * up as the marketplace card's "owner" and in the network identities
 * directory.
 */
export function OperatorIdentitySection() {
  const toasts = useToasts();
  const operator = useAsync((s) => settingsApi.operator(s), []);
  const [displayName, setDisplayName] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (operator.data) setDisplayName(operator.data.displayName);
  }, [operator.data]);

  const dirty = operator.data != null && displayName.trim() !== operator.data.displayName;
  const valid = displayName.trim().length > 0 && displayName.trim().length <= 60;

  const save = async () => {
    const trimmed = displayName.trim();
    if (!valid) return;
    setSaving(true);
    try {
      await settingsApi.setOperator(trimmed);
      toasts.success("Operator identity updated");
      operator.reload();
    } catch (err) {
      toasts.error(
        err instanceof ApiError && err.isOffline ? "Daemon unreachable." : "Could not save identity.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="il-settings__section">
      <h2 className="il-settings__section-title">Operator identity</h2>
      <p className="il-settings__section-desc">
        Shown as the owner on every agent you publish — one host key signs all of them.
      </p>

      {operator.loading && operator.initialLoad ? (
        <Skeleton width={220} height={32} />
      ) : operator.error ? (
        <LoadError error={operator.error} onRetry={operator.reload} />
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
    </section>
  );
}
