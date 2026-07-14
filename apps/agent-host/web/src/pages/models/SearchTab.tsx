import { useEffect, useMemo, useState } from "react";
import { CapabilityBadges, EmptyState, Input, Spinner } from "@interloom/ui";
import type { DownloadJob, LocalModel } from "@interloom/protocol";
import type { HfSearchResult, ActiveModel } from "../../api/types.js";
import { models as modelsApi } from "../../api/endpoints.js";
import { useAsync } from "../../hooks/useAsync.js";
import { useDebounced } from "../../hooks/useDebounced.js";
import { LoadError } from "../../components/States.js";
import { compactNumber } from "../../lib/format.js";
import { SearchDetailPanel } from "./SearchDetailPanel.js";

type SortKey = "relevance" | "downloads" | "ctx";

interface SearchTabProps {
  downloads: DownloadJob[];
  localModels: LocalModel[];
  activeModel: ActiveModel | null;
  onRefresh: () => void;
}

export function SearchTab({ downloads, localModels, activeModel, onRefresh }: SearchTabProps) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("relevance");
  const [selected, setSelected] = useState<string | null>(null);
  const debounced = useDebounced(query.trim(), 400);

  const results = useAsync<HfSearchResult[]>(
    (signal) => (debounced.length >= 2 ? modelsApi.search(debounced, signal) : Promise.resolve([])),
    [debounced],
  );

  const rows = useMemo(() => {
    const list = [...(results.data ?? [])];
    if (sort === "downloads") list.sort((a, b) => b.downloads - a.downloads);
    if (sort === "ctx") {
      list.sort((a, b) => (b.trainedCtx ?? -1) - (a.trainedCtx ?? -1));
    }
    return list;
  }, [results.data, sort]);

  useEffect(() => {
    if (rows.length > 0 && !rows.some((r) => r.repoId === selected)) {
      setSelected(rows[0]!.repoId);
    }
    if (rows.length === 0) setSelected(null);
  }, [rows, selected]);

  return (
    <div className="il-hsearch">
      <p className="il-hsearch__lead">
        Search the whole Hugging Face hub — beyond the curated picks. Great for a specific model or a
        fresh release; the Catalog is the guided path.
      </p>
      <div className="il-hsearch__bar">
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
        <label className="il-hsearch__sort">
          <span className="il-meta">Sort</span>
          <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort results">
            <option value="relevance">Relevance</option>
            <option value="downloads">Downloads</option>
            <option value="ctx">Max context</option>
          </select>
        </label>
      </div>

      {debounced.length < 2 ? (
        <EmptyState
          title="Search all of Hugging Face"
          hint="Type at least two characters to find GGUF-quantized models — anything on the hub, beyond the curated catalog."
        />
      ) : results.error ? (
        <LoadError error={results.error} onRetry={results.reload} />
      ) : results.loading && results.initialLoad ? (
        <div className="il-loading-block">
          <Spinner size="md" />
          <span className="il-loading-block__label">Searching Hugging Face…</span>
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          title={`No GGUF results for "${debounced}"`}
          hint='Try a different model name, e.g. "llama", "qwen", or "mistral".'
        />
      ) : (
        <div className="il-hsearch__split">
          <ul className="il-hsearch__rail" role="listbox" aria-label="Search results">
            {rows.map((r) => (
              <li key={r.repoId}>
                <button
                  role="option"
                  aria-selected={selected === r.repoId}
                  className={`il-hsearch__row${selected === r.repoId ? " il-hsearch__row--sel" : ""}`}
                  onClick={() => setSelected(r.repoId)}
                >
                  <span className="il-hsearch__repo">{r.repoId}</span>
                  <span className="il-meta il-hsearch__row-meta">
                    {r.paramsB ? `${r.paramsB}B · ` : ""}
                    ↓ {compactNumber(r.downloads)}
                    {r.trainedCtx ? ` · ${fmtCtxShort(r.trainedCtx)} ctx` : ""}
                  </span>
                  <CapabilityBadges capabilities={r.capabilities} estimated size="sm" />
                </button>
              </li>
            ))}
          </ul>
          <div className="il-hsearch__detail">
            {selected ? (
              <SearchDetailPanel
                key={selected}
                repoId={selected}
                downloads={downloads}
                localModels={localModels}
                activeModel={activeModel}
                onRefresh={onRefresh}
              />
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

export function fmtCtxShort(ctx: number): string {
  return ctx >= 1024 ? `${Math.round(ctx / 1024)}k` : String(ctx);
}

function SearchIcon() {
  return (
    <svg className="il-search__icon" width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden>
      <circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
