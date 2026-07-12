import { useState } from "react";
import { Badge, Button, EmptyState, Input, Spinner } from "@interloom/ui";
import type { HfSearchResult, HfSearchFile } from "../../api/types.js";
import { models as modelsApi } from "../../api/endpoints.js";
import { useAsync } from "../../hooks/useAsync.js";
import { useDebounced } from "../../hooks/useDebounced.js";
import { useToasts } from "../../components/Toasts.js";
import { LoadError } from "../../components/States.js";
import { bytesToGB, compactNumber } from "../../lib/format.js";
import { ApiError } from "../../api/client.js";

export function SearchTab({ onDownloadStarted }: { onDownloadStarted: () => void }) {
  const [query, setQuery] = useState("");
  const debounced = useDebounced(query.trim(), 400);

  const results = useAsync<HfSearchResult[]>(
    (signal) => (debounced.length >= 2 ? modelsApi.search(debounced, signal) : Promise.resolve([])),
    [debounced],
  );

  return (
    <div className="il-search">
      <div className="il-search__bar">
        <SearchIcon />
        <Input
          type="search"
          placeholder="Search Hugging Face for GGUF models…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search models"
        />
        {results.loading && debounced.length >= 2 ? <Spinner size="sm" /> : null}
      </div>

      {debounced.length < 2 ? (
        <EmptyState
          title="Search Hugging Face"
          hint="Type at least two characters to find GGUF-quantized models to run locally."
        />
      ) : results.error ? (
        <LoadError error={results.error} onRetry={results.reload} />
      ) : results.loading && results.initialLoad ? (
        <div className="il-loading-block">
          <Spinner size="md" />
          <span className="il-loading-block__label">Searching Hugging Face…</span>
        </div>
      ) : (results.data ?? []).length === 0 ? (
        <EmptyState
          title={`No GGUF results for "${debounced}"`}
          hint="Try a different model name, e.g. “llama”, “qwen”, or “mistral”."
        />
      ) : (
        <ul className="il-search__list">
          {(results.data ?? []).map((r) => (
            <SearchRow key={r.repoId} result={r} onDownloadStarted={onDownloadStarted} />
          ))}
        </ul>
      )}
    </div>
  );
}

function SearchRow({
  result,
  onDownloadStarted,
}: {
  result: HfSearchResult;
  onDownloadStarted: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li className="il-search__row">
      <button
        className="il-search__row-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <div className="il-search__row-main">
          <span className="il-search__repo">{result.repoId}</span>
          <span className="il-meta il-search__stats">
            ↓ {compactNumber(result.downloads)} · ♥ {compactNumber(result.likes)} ·{" "}
            {result.files.length} GGUF file{result.files.length === 1 ? "" : "s"}
          </span>
        </div>
        <span className={`il-search__chevron${open ? " il-search__chevron--open" : ""}`} aria-hidden>
          ▸
        </span>
      </button>
      {open ? (
        <ul className="il-search__files">
          {result.files.map((f) => (
            <FileRow
              key={f.filename}
              file={f}
              repoId={result.repoId}
              onDownloadStarted={onDownloadStarted}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function FileRow({
  file,
  repoId,
  onDownloadStarted,
}: {
  file: HfSearchFile;
  repoId: string;
  onDownloadStarted: () => void;
}) {
  const toasts = useToasts();
  const [busy, setBusy] = useState(false);

  const download = async () => {
    setBusy(true);
    try {
      await modelsApi.download(repoId, file.filename);
      toasts.success(`Downloading ${file.filename}`);
      onDownloadStarted();
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
    <li className="il-search__file">
      <div className="il-search__file-main">
        <span className="il-mono il-search__filename">{file.filename}</span>
        <span className="il-search__file-meta">
          {file.quant ? <Badge variant="neutral">{file.quant}</Badge> : null}
          <span className="il-meta">{bytesToGB(file.sizeBytes)} GB</span>
        </span>
      </div>
      <Button size="sm" variant="secondary" onClick={download} disabled={busy}>
        {busy ? "Starting…" : "Download"}
      </Button>
    </li>
  );
}

function SearchIcon() {
  return (
    <svg className="il-search__icon" width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden>
      <circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
