import { useState } from "react";
import { Badge, Button, CapabilityBadges, Spinner } from "@interloom/ui";
import type { DownloadJob, LoadedModel, LocalModel } from "@interloom/protocol";
import type { HfDetailFile, HfRepoDetail } from "../../api/types.js";
import { models as modelsApi } from "../../api/endpoints.js";
import { useAsync } from "../../hooks/useAsync.js";
import { useToasts } from "../../components/Toasts.js";
import { LoadError } from "../../components/States.js";
import { bytesToGB, compactNumber } from "../../lib/format.js";
import { ApiError } from "../../api/client.js";
import { deriveModelState } from "../../hooks/useModelState.js";
import { RemoveModelModal } from "./RemoveModelModal.js";
import { fmtCtxShort } from "./SearchTab.js";

interface SearchDetailPanelProps {
  repoId: string;
  downloads: DownloadJob[];
  localModels: LocalModel[];
  loadedModels: LoadedModel[];
  onRefresh: () => void;
}

/** Right panel of the search master–detail: fetched lazily per selected repo. */
export function SearchDetailPanel({
  repoId,
  downloads,
  localModels,
  loadedModels,
  onRefresh,
}: SearchDetailPanelProps) {
  const detail = useAsync<HfRepoDetail>((s) => modelsApi.hfDetail(repoId, s), [repoId]);

  if (detail.loading && detail.initialLoad) {
    return (
      <div className="il-loading-block">
        <Spinner size="md" />
        <span className="il-loading-block__label">Loading model details…</span>
      </div>
    );
  }
  if (detail.error) return <LoadError error={detail.error} onRetry={detail.reload} />;
  const d = detail.data;
  if (!d) return null;

  const shortName = repoId.split("/")[1] ?? repoId;

  return (
    <div className="il-hdetail">
      <div className="il-hdetail__head">
        <div>
          <div className="il-hdetail__name">{shortName.replace(/-GGUF$/i, "")}</div>
          <div className="il-meta il-mono">{d.repoId}</div>
        </div>
        <CapabilityBadges capabilities={d.capabilities} estimated />
      </div>
      <div className="il-meta il-hdetail__stats">
        ↓ {compactNumber(d.downloads)} · ♥ {compactNumber(d.likes)}
        {d.trainedCtx ? <> · trained to {fmtCtxShort(d.trainedCtx)} ctx</> : null}
        {d.lastModified ? <> · updated {new Date(d.lastModified).toLocaleDateString()}</> : null}
      </div>
      {d.mmprojFilename ? (
        <div className="il-meta">vision projector available — downloads alongside the model</div>
      ) : null}

      {d.files.length === 0 ? (
        <p className="il-meta il-hdetail__nofiles">No GGUF files in this repo.</p>
      ) : (
        <div className="il-hdetail__files">
          <div className="il-hdetail__files-head il-meta">
            <span>FILE</span>
            <span>SIZE · MAX CTX HERE</span>
          </div>
          {d.files.map((f) => (
            <DetailFileRow
              key={f.filename}
              file={f}
              repoId={d.repoId}
              mmprojFilename={d.mmprojFilename}
              downloads={downloads}
              localModels={localModels}
              loadedModels={loadedModels}
              onRefresh={onRefresh}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function DetailFileRow({
  file,
  repoId,
  mmprojFilename,
  downloads,
  localModels,
  loadedModels,
  onRefresh,
}: {
  file: HfDetailFile;
  repoId: string;
  mmprojFilename?: string;
  downloads: DownloadJob[];
  localModels: LocalModel[];
  loadedModels: LoadedModel[];
  onRefresh: () => void;
}) {
  const toasts = useToasts();
  const [busy, setBusy] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<LocalModel | null>(null);

  const ms = deriveModelState(repoId, file.filename, downloads, localModels, loadedModels);
  const job = ms.job;
  const pct = job && job.bytesTotal > 0 ? Math.round((job.bytesDone / job.bytesTotal) * 100) : 0;

  const download = async () => {
    setBusy(true);
    try {
      await modelsApi.download(repoId, file.filename, mmprojFilename);
      toasts.success(`Downloading ${file.filename}`);
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

  return (
    <>
      <div className="il-hdetail__file">
        <span className="il-mono il-hdetail__filename">{file.filename}</span>
        <span className="il-hdetail__file-meta">
          {file.quant ? <Badge variant="neutral">{file.quant}</Badge> : null}
          <span className="il-meta">{bytesToGB(file.sizeBytes)} GB</span>
          {file.maxFastCtx ? (
            <span className="il-meta il-mono il-hdetail__maxctx">
              up to {fmtCtxShort(file.maxFastCtx)} ctx here
            </span>
          ) : null}
        </span>
        {ms.state === "loaded" ? (
          <Badge variant="success">Loaded ✓</Badge>
        ) : ms.state === "installed" ? (
          <span className="il-hdetail__file-actions">
            <Badge variant="success">Installed ✓</Badge>
            <Button size="sm" variant="secondary" onClick={() => setRemoveTarget(ms.localModel!)}>
              Remove
            </Button>
          </span>
        ) : ms.state === "queued" || ms.state === "downloading" ? (
          <span className="il-model-card__progress-row">
            <Spinner size="sm" />
            <span className="il-meta">{ms.state === "queued" ? "Queued" : `${pct}%`}</span>
          </span>
        ) : (
          <Button size="sm" variant="secondary" onClick={download} disabled={busy}>
            {busy ? "Starting…" : "Download"}
          </Button>
        )}
      </div>

      {removeTarget ? (
        <RemoveModelModal
          model={removeTarget}
          loadedModels={loadedModels}
          onClose={() => setRemoveTarget(null)}
          onUnloaded={onRefresh}
          onRemoved={() => {
            setRemoveTarget(null);
            onRefresh();
          }}
        />
      ) : null}
    </>
  );
}
