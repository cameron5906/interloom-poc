import { Button } from "@interloom/ui";
import { keys as keysApi } from "../../api/endpoints.js";
import { useAsync } from "../../hooks/useAsync.js";
import { useClipboard } from "../../hooks/useClipboard.js";
import { LoadError, Skeleton } from "../../components/States.js";
import { formatDate } from "../../lib/format.js";

export function StepIdentity({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const hostKeys = useAsync((s) => keysApi.get(s), []);
  const { copied, copy } = useClipboard();

  return (
    <div className="il-onb__step-body">
      <h2 className="il-onb__title">Your host identity</h2>
      <p className="il-onb__lede">
        We generated a cryptographic keypair for this host — it signs everything you publish to
        the network. The private key stays on this machine and is never shown or transmitted.
      </p>

      {hostKeys.loading && hostKeys.initialLoad ? (
        <div className="il-id-card">
          <Skeleton width={120} height={12} />
          <Skeleton width="100%" height={40} radius={8} />
          <Skeleton width={160} height={12} />
        </div>
      ) : hostKeys.error ? (
        <LoadError error={hostKeys.error} onRetry={hostKeys.reload} />
      ) : (
        <div className="il-id-card">
          <div className="il-id-card__row">
            <span className="il-section-label">Public key</span>
            <span className="il-id-card__badge">generated for you</span>
          </div>
          <div className="il-id-card__key">
            <code className="il-mono il-id-card__key-text">{hostKeys.data?.pubKey}</code>
            <Button size="sm" variant="secondary" onClick={() => copy(hostKeys.data?.pubKey ?? "")}>
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <div className="il-meta">created {formatDate(hostKeys.data?.createdAt)}</div>
          <div className="il-id-card__note">
            <span aria-hidden>🔒</span>
            The matching private key is custodied by the daemon on this device. You never type or
            paste keys in Interloom.
          </div>
        </div>
      )}

      <div className="il-onb__actions">
        <Button variant="secondary" onClick={onBack}>
          Back
        </Button>
        <Button variant="primary" onClick={onNext} disabled={hostKeys.loading && hostKeys.initialLoad}>
          Continue
        </Button>
      </div>
    </div>
  );
}
