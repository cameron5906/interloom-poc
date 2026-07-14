import { useMemo, useState } from "react";
import { Badge, Button, EmptyState, Spinner } from "@interloom/ui";
import type { DownloadJob, LoadedModel, LocalModel } from "@interloom/protocol";
import type { CatalogModel, HfDetailFile } from "../../../api/types.js";
import { models as modelsApi } from "../../../api/endpoints.js";
import { useAsync } from "../../../hooks/useAsync.js";
import { useToasts } from "../../../components/Toasts.js";
import { LoadError } from "../../../components/States.js";
import { bytesToGB } from "../../../lib/format.js";
import { ApiError } from "../../../api/client.js";
import { deriveModelState } from "../../../hooks/useModelState.js";
import { RemoveModelModal } from "../RemoveModelModal.js";
import { fmtTokens, ggufRepoId, recommendedQuantFile, trustLabel, trustRank } from "../catalog/catalogHelpers.js";

interface GetModelSectionProps {
  model: CatalogModel;
  downloads: DownloadJob[];
  localModels: LocalModel[];
  loadedModels: LoadedModel[];
  onRefresh: () => void;
  onGoToSearch?: () => void;
}

export function GetModelSection({
  model,
  downloads,
  localModels,
  loadedModels,
  onRefresh,
  onGoToSearch,
}: GetModelSectionProps) {
  const repos = useMemo(
    () =>
      model.links.gguf
        .map((l) => ({ repoId: ggufRepoId(l.url), status: l.status, url: l.url }))
        .filter((r): r is { repoId: string; status: string; url: string } => r.repoId != null)
        .sort((a, b) => trustRank(a.status) - trustRank(b.status)),
    [model],
  );

  const [repoIdx, setRepoIdx] = useState(0);
  const repo = repos[repoIdx];

  if (repos.length === 0) {
    const discovery = model.links.gguf[0];
    return (
      <EmptyState
        title="No canonical GGUF repository"
        hint="This model has no single confirmed GGUF repo yet — search Hugging Face to find a community build, then verify its files before use."
        action={
          <div className="il-getmodel__discovery-actions">
            {discovery ? (
              <a href={discovery.url} target="_blank" rel="noreferrer noopener">
                <Button size="sm" variant="secondary">
                  Open HF search ↗
                </Button>
              </a>
            ) : null}
            {onGoToSearch ? (
              <Button size="sm" variant="primary" onClick={onGoToSearch}>
                Search in portal
              </Button>
            ) : null}
          </div>
        }
      />
    );
  }

  return (
    <div className="il-getmodel">
      {repos.length > 1 ? (
        <div className="il-getmodel__repos" role="group" aria-label="Choose a GGUF repository">
          {repos.map((r, i) => (
            <button
              key={r.repoId}
              type="button"
              aria-pressed={i === repoIdx}
              className={`il-getmodel__repo-btn${i === repoIdx ? " il-getmodel__repo-btn--sel" : ""}`}
              onClick={() => setRepoIdx(i)}
            >
              <span className={`il-trust il-trust--${r.status}`}>{trustLabel(r.status)}</span>
              <span className="il-mono il-getmodel__repo-id">{r.repoId}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="il-getmodel__single-repo">
          <span className={`il-trust il-trust--${repo!.status}`}>{trustLabel(repo!.status)}</span>
          <span className="il-mono il-getmodel__repo-id">{repo!.repoId}</span>
        </div>
      )}

      <RepoFiles
        key={repo!.repoId}
        repoId={repo!.repoId}
        downloads={downloads}
        localModels={localModels}
        loadedModels={loadedModels}
        onRefresh={onRefresh}
      />
    </div>
  );
}

function RepoFiles({
  repoId,
  downloads,
  localModels,
  loadedModels,
  onRefresh,
}: {
  repoId: string;
  downloads: DownloadJob[];
  localModels: LocalModel[];
  loadedModels: LoadedModel[];
  onRefresh: () => void;
}) {
  const detail = useAsync((s) => modelsApi.hfDetail(repoId, s), [repoId]);

  if (detail.loading && detail.initialLoad) {
    return (
      <div className="il-loading-block">
        <Spinner size="sm" />
        <span className="il-loading-block__label">Loading quant files…</span>
      </div>
    );
  }
  if (detail.error) return <LoadError error={detail.error} onRetry={detail.reload} compact />;
  const d = detail.data;
  if (!d) return null;
  if (d.files.length === 0) {
    return <p className="il-meta il-getmodel__nofiles">No GGUF files found in this repository.</p>;
  }

  const recommended = recommendedQuantFile(d.files);
  const ordered = recommended
    ? [recommended, ...d.files.filter((f) => f.filename !== recommended.filename)]
    : d.files;

  return (
    <>
      {d.mmprojFilename ? (
        <p className="il-meta il-getmodel__mmproj">
          Vision projector included — downloads alongside the model.
        </p>
      ) : null}
      <div className="il-getmodel__files">
        {ordered.map((f) => (
          <FileRow
            key={f.filename}
            file={f}
            repoId={repoId}
            mmprojFilename={d.mmprojFilename}
            recommended={recommended?.filename === f.filename}
            downloads={downloads}
            localModels={localModels}
            loadedModels={loadedModels}
            onRefresh={onRefresh}
          />
        ))}
      </div>
    </>
  );
}

function FileRow({
  file,
  repoId,
  mmprojFilename,
  recommended,
  downloads,
  localModels,
  loadedModels,
  onRefresh,
}: {
  file: HfDetailFile;
  repoId: string;
  mmprojFilename?: string;
  recommended: boolean;
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
      <div className={`il-getmodel__file${recommended ? " il-getmodel__file--rec" : ""}`}>
        <div className="il-getmodel__file-main">
          <div className="il-getmodel__file-top">
            {file.quant ? <Badge variant="neutral">{file.quant}</Badge> : null}
            {recommended ? <span className="il-getmodel__rec-tag">Recommended</span> : null}
          </div>
          <span className="il-mono il-getmodel__filename">{file.filename}</span>
          <span className="il-meta">
            {bytesToGB(file.sizeBytes)} GB
            {file.maxFastCtx ? ` · up to ${fmtTokens(file.maxFastCtx)} ctx here` : ""}
          </span>
        </div>
        <div className="il-getmodel__file-action">
          {ms.state === "loaded" ? (
            <Badge variant="success">Loaded</Badge>
          ) : ms.state === "installed" ? (
            <div className="il-getmodel__file-actions">
              <Badge variant="success">Installed</Badge>
              <Button size="sm" variant="secondary" onClick={() => setRemoveTarget(ms.localModel!)}>
                Remove
              </Button>
            </div>
          ) : ms.state === "queued" || ms.state === "downloading" ? (
            <span className="il-model-card__progress-row">
              <Spinner size="sm" />
              <span className="il-meta">{ms.state === "queued" ? "Queued" : `${pct}%`}</span>
            </span>
          ) : (
            <Button
              size="sm"
              variant={recommended ? "primary" : "secondary"}
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
