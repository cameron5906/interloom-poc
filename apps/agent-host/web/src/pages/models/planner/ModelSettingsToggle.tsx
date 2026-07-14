import { useState } from "react";
import { models as modelsApi } from "../../../api/endpoints.js";
import { useToasts } from "../../../components/Toasts.js";
import { ApiError } from "../../../api/client.js";

/**
 * Per-model `disableThinking` toggle (CONTRACTS §6 `PATCH /api/models/settings`,
 * §6.1 thinking robustness). Only rendered for thinking-capable models.
 */
export function ModelSettingsToggle({
  filename,
  disableThinking,
  loaded,
  onChanged,
}: {
  filename: string;
  disableThinking: boolean;
  /** Whether this model is currently a loaded instance — if so, applying the change restarts it briefly. */
  loaded: boolean;
  onChanged: () => void;
}) {
  const toasts = useToasts();
  const [saving, setSaving] = useState(false);

  const toggle = async () => {
    setSaving(true);
    try {
      await modelsApi.patchSettings({ filename, disableThinking: !disableThinking });
      toasts.success(
        !disableThinking
          ? `Thinking disabled for ${filename}`
          : `Thinking re-enabled for ${filename}`,
      );
      onChanged();
    } catch (err) {
      toasts.error(
        err instanceof ApiError && err.isOffline ? "Daemon unreachable — setting not saved." : "Could not save that setting.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="il-think-toggle">
      <label className="il-think-toggle__row">
        <input
          type="checkbox"
          checked={disableThinking}
          disabled={saving}
          onChange={() => void toggle()}
        />
        <span>Disable thinking</span>
      </label>
      <p className="il-think-toggle__hint il-meta">
        Skips step-by-step reasoning for faster, shorter replies.
        {loaded ? " Applying this restarts the model briefly." : ""}
      </p>
    </div>
  );
}
