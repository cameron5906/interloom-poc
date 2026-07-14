import { useMemo, useState } from "react";
import { Button, EmptyState } from "@interloom/ui";
import type { DownloadJob, LoadedModel, LocalModel, SystemInfo } from "@interloom/protocol";
import type { CatalogModel } from "../../../api/types.js";
import { models as modelsApi } from "../../../api/endpoints.js";
import { useAsync } from "../../../hooks/useAsync.js";
import { Skeleton } from "../../../components/States.js";
import { CatalogCard } from "./CatalogCard.js";
import { CatalogFilters, type CatalogFilterState } from "./CatalogFilters.js";
import { ModelDetail } from "../detail/ModelDetail.js";
import { fitRank } from "./catalogHelpers.js";
import "./catalog.css";

interface CatalogTabProps {
  rig: SystemInfo | null;
  downloads: DownloadJob[];
  localModels: LocalModel[];
  loadedModels: LoadedModel[];
  onGoToSearch: () => void;
  onRefresh: () => void;
}

const INITIAL_FILTERS: CatalogFilterState = {
  category: null,
  modality: null,
  fitsOnly: false,
  sort: "fit",
};

export function CatalogTab({
  rig,
  downloads,
  localModels,
  loadedModels,
  onGoToSearch,
  onRefresh,
}: CatalogTabProps) {
  const registry = useAsync((s) => modelsApi.registry(s), []);
  const [filters, setFilters] = useState<CatalogFilterState>(INITIAL_FILTERS);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const doc = registry.data?.doc;
  const fitMap = registry.data?.fit ?? {};
  const models = doc?.catalog.models ?? [];

  const categories = useMemo(() => {
    const seen = new Set<string>();
    for (const m of models) for (const c of m.categories) seen.add(c);
    return [...seen].sort();
  }, [models]);

  const modalities = useMemo(() => {
    const seen = new Set<string>();
    for (const m of models) for (const mod of m.architecture.modalities) seen.add(mod);
    return ["text", "image", "video", "audio"].filter((m) => seen.has(m));
  }, [models]);

  const visible = useMemo(() => {
    let list = models.filter((m) => {
      if (filters.category && !m.categories.includes(filters.category)) return false;
      if (filters.modality && !m.architecture.modalities.includes(filters.modality)) return false;
      if (filters.fitsOnly) {
        const v = fitMap[m.id]?.verdict;
        if (v !== "fast" && v !== "spill" && v !== "cpu") return false;
      }
      return true;
    });
    list = sortModels(list, filters.sort, fitMap);
    return list;
  }, [models, filters, fitMap]);

  const selected = selectedId ? models.find((m) => m.id === selectedId) ?? null : null;

  if (registry.loading && registry.initialLoad) {
    return (
      <div className="il-catgrid">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="il-catcard il-catcard--skel">
            <Skeleton width={150} height={16} />
            <Skeleton width={90} height={12} />
            <Skeleton width="100%" height={40} />
            <Skeleton width={130} height={22} radius={999} />
          </div>
        ))}
      </div>
    );
  }

  if (registry.error) {
    const offline = registry.error.isOffline;
    return (
      <EmptyState
        title={offline ? "Agent Host daemon unreachable" : "The curated catalog isn't available yet"}
        hint={
          offline
            ? "Reconnecting to the daemon on port 7420. You can still search all of Hugging Face directly."
            : "The daemon couldn't reach the model registry. You can still search all of Hugging Face — the curated picks will return once the registry is back."
        }
        action={
          <div className="il-catalog__offline-actions">
            <Button size="sm" variant="primary" onClick={onGoToSearch}>
              Search Hugging Face
            </Button>
            <Button size="sm" variant="secondary" onClick={registry.reload}>
              Try again
            </Button>
          </div>
        }
      />
    );
  }

  if (models.length === 0) {
    return (
      <EmptyState
        title="No curated models yet"
        hint="The registry is reachable but empty. Search Hugging Face to find a model to run."
        action={
          <Button size="sm" variant="primary" onClick={onGoToSearch}>
            Search Hugging Face
          </Button>
        }
      />
    );
  }

  return (
    <div className="il-catalog">
      <CatalogFilters
        categories={categories}
        modalities={modalities}
        state={filters}
        onChange={setFilters}
      />

      {registry.data?.source === "cache" ? (
        <p className="il-catalog__cache-note il-meta">
          Showing a cached copy of the catalog — the daemon will refresh it when the network is
          reachable.
        </p>
      ) : null}

      {visible.length === 0 ? (
        <EmptyState
          title="No models match these filters"
          hint="Try clearing a filter or turning off “Fits my rig”."
          action={
            <Button size="sm" variant="secondary" onClick={() => setFilters(INITIAL_FILTERS)}>
              Clear filters
            </Button>
          }
        />
      ) : (
        <div className="il-catgrid">
          {visible.map((m) => (
            <CatalogCard
              key={m.id}
              model={m}
              fit={fitMap[m.id]}
              downloads={downloads}
              localModels={localModels}
              loadedModels={loadedModels}
              onOpen={() => setSelectedId(m.id)}
            />
          ))}
        </div>
      )}

      {selected && doc ? (
        <ModelDetail
          model={selected}
          fit={fitMap[selected.id]}
          taxonomy={doc.taxonomy}
          rig={rig}
          downloads={downloads}
          localModels={localModels}
          loadedModels={loadedModels}
          onClose={() => setSelectedId(null)}
          onRefresh={onRefresh}
          onGoToSearch={onGoToSearch}
        />
      ) : null}
    </div>
  );
}

function sortModels(
  list: CatalogModel[],
  sort: CatalogFilterState["sort"],
  fitMap: Record<string, { verdict: "fast" | "spill" | "cpu" | "no" } | undefined>,
): CatalogModel[] {
  const sorted = [...list];
  if (sort === "fit") {
    sorted.sort((a, b) => {
      const fr = fitRank(fitMap[a.id]?.verdict) - fitRank(fitMap[b.id]?.verdict);
      if (fr !== 0) return fr;
      return paramSize(a) - paramSize(b);
    });
  } else if (sort === "params") {
    sorted.sort((a, b) => paramSize(a) - paramSize(b));
  } else {
    sorted.sort((a, b) => releaseTime(b) - releaseTime(a));
  }
  return sorted;
}

function paramSize(m: CatalogModel): number {
  return m.architecture.parameters_total_b ?? m.architecture.parameters_active_b ?? 0;
}

function releaseTime(m: CatalogModel): number {
  if (!m.release_date) return 0;
  const t = Date.parse(m.release_date);
  return Number.isNaN(t) ? 0 : t;
}
