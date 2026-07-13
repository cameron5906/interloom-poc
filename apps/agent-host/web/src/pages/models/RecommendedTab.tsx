import { useState } from "react";
import { Badge, Button, CapabilityBadges, EmptyState, Spinner } from "@interloom/ui";
import type { DownloadJob, LocalModel } from "@interloom/protocol";
import type { FitAnnotatedModel, ActiveModel } from "../../api/types.js";
import { models as modelsApi } from "../../api/endpoints.js";
import { useAsync } from "../../hooks/useAsync.js";
import { useToasts } from "../../components/Toasts.js";
import { LoadError, Skeleton } from "../../components/States.js";
import { bytesToGB, mbToGB } from "../../lib/format.js";
import { TIER_LABEL, TIER_ORDER } from "../../lib/constants.js";
import { ApiError } from "../../api/client.js";
import { deriveModelState } from "../../hooks/useModelState.js";
import { RemoveModelModal } from "./RemoveModelModal.js";

interface RecommendedTabProps {
  downloads: DownloadJob[];
  localModels: LocalModel[];
  activeModel: ActiveModel | null;
  onRefresh: () => void;
}

export function RecommendedTab({ downloads, localModels, activeModel, onRefresh }: RecommendedTabProps) {
  const curated = useAsync((s) => modelsApi.curated(s), []);

  if (curated.loading && curated.initialLoad) {
    return (
      <div className="il-model-grid">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="il-model-card">
            <Skeleton width={150} height={16} />
            <Skeleton width={80} height={12} />
            <Skeleton width="100%" height={32} />
            <Skeleton width={110} height={28} radius={7} />
          </div>
        ))}
      </div>
    );
  }

  if (curated.error) return <LoadError error={curated.error} onRetry={curated.reload} />;

  const list = curated.data ?? [];
  if (list.length === 0) {
    return (
      <EmptyState
        title="No recommendations yet"
        hint="The curated model list is loaded from your daemon. Check back once it's populated."
      />
    );
  }

  const grouped = TIER_ORDER.map((tier) => ({
    tier,
    models: list.filter((m) => m.tier === tier),
  })).filter((g) => g.models.length > 0);

  return (
    <div className="il-model-tiers">
      {grouped.map(({ tier, models }) => (
        <section key={tier} className="il-model-tier">
          <h3 className="il-section-label">{TIER_LABEL[tier] ?? tier}</h3>
          <div className="il-model-grid">
            {models.map((m) => (
              <RecommendedCard
                key={m.id}
                model={m}
                downloads={downloads}
                localModels={localModels}
                activeModel={activeModel}
                onRefresh={onRefresh}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function RecommendedCard({
  model,
  downloads,
  localModels,
  activeModel,
  onRefresh,
}: {
  model: FitAnnotatedModel;
  downloads: DownloadJob[];
  localModels: LocalModel[];
  activeModel: ActiveModel | null;
  onRefresh: () => void;
}) {
  const toasts = useToasts();
  const [busy, setBusy] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<LocalModel | null>(null);

  const ms = deriveModelState(model.repoId, model.filename, downloads, localModels, activeModel);

  const download = async () => {
    setBusy(true);
    try {
      await modelsApi.download(model.repoId, model.filename);
      toasts.success(`Downloading ${model.displayName}`);
      onRefresh();
    } catch (err) {
      toasts.error(
        err instanceof ApiError && err.isOffline
          ? "Daemon unreachable — can't start download."
          : "Could not start the download.",
      );
    } finally {
      setBusy(false);
    }
  };

  const job = ms.job;
  const pct = job && job.bytesTotal > 0 ? Math.round((job.bytesDone / job.bytesTotal) * 100) : 0;

  return (
    <>
      <div className="il-model-card">
        <div className="il-model-card__head">
          <div className="il-model-card__name">{model.displayName}</div>
          <Badge variant="neutral">{model.quant}</Badge>
        </div>
        <CapabilityBadges capabilities={model.capabilities} size="sm" />
        <div className="il-meta il-model-card__size">
          {bytesToGB(model.sizeBytes)} GB · needs {mbToGB(model.minVramMB)} GB
        </div>
        <p className="il-model-card__blurb">{model.blurb}</p>
        <div className="il-model-card__foot">
          {model.fits ? (
            <Badge variant="success">Fits your hardware</Badge>
          ) : (
            <Badge variant="neutral">Needs ~{mbToGB(model.minVramMB, 0)} GB</Badge>
          )}

          {ms.state === "active" ? (
            <Badge variant="success">Active ✓</Badge>
          ) : ms.state === "installed" ? (
            <div className="il-model-card__installed-actions">
              <Badge variant="success">Installed ✓</Badge>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setRemoveTarget(ms.localModel!)}
                className="il-model-card__remove"
              >
                Remove
              </Button>
            </div>
          ) : ms.state === "queued" || ms.state === "downloading" ? (
            <div className="il-model-card__progress-row">
              <Spinner size="sm" />
              <span className="il-meta">
                {ms.state === "queued" ? "Queued" : `${pct}%`}
              </span>
            </div>
          ) : (
            <Button
              size="sm"
              variant={model.fits ? "primary" : "secondary"}
              onClick={download}
              disabled={busy}
            >
              {busy ? "Starting…" : "Download"}
            </Button>
          )}
        </div>
      </div>

      {removeTarget ? (
        <RemoveModelModal
          model={removeTarget}
          activeModel={activeModel}
          onClose={() => setRemoveTarget(null)}
          onRemoved={() => {
            setRemoveTarget(null);
            onRefresh();
          }}
        />
      ) : null}
    </>
  );
}
