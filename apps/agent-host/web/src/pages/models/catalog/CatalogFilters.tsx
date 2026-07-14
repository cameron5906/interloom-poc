export type CatalogSort = "fit" | "params" | "release";

export interface CatalogFilterState {
  category: string | null;
  modality: string | null;
  fitsOnly: boolean;
  sort: CatalogSort;
}

interface CatalogFiltersProps {
  categories: string[];
  modalities: string[];
  state: CatalogFilterState;
  onChange: (next: CatalogFilterState) => void;
}

export function CatalogFilters({ categories, modalities, state, onChange }: CatalogFiltersProps) {
  const set = (partial: Partial<CatalogFilterState>) => onChange({ ...state, ...partial });

  return (
    <div className="il-catfilters">
      <div className="il-catfilters__chips" role="group" aria-label="Filter models">
        <Chip
          active={state.fitsOnly}
          onClick={() => set({ fitsOnly: !state.fitsOnly })}
          tone="fit"
        >
          Fits my rig
        </Chip>

        {categories.map((c) => (
          <Chip
            key={c}
            active={state.category === c}
            onClick={() => set({ category: state.category === c ? null : c })}
          >
            {c}
          </Chip>
        ))}
      </div>

      <div className="il-catfilters__controls">
        {modalities.length > 0 ? (
          <label className="il-catfilters__select">
            <span className="il-meta">Modality</span>
            <select
              value={state.modality ?? ""}
              onChange={(e) => set({ modality: e.target.value || null })}
              aria-label="Filter by modality"
            >
              <option value="">Any</option>
              {modalities.map((m) => (
                <option key={m} value={m}>
                  {cap(m)}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <label className="il-catfilters__select">
          <span className="il-meta">Sort</span>
          <select
            value={state.sort}
            onChange={(e) => set({ sort: e.target.value as CatalogSort })}
            aria-label="Sort models"
          >
            <option value="fit">Best fit</option>
            <option value="params">Size</option>
            <option value="release">Newest</option>
          </select>
        </label>
      </div>
    </div>
  );
}

function Chip({
  active,
  onClick,
  tone,
  children,
}: {
  active: boolean;
  onClick: () => void;
  tone?: "fit";
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={[
        "il-catchip",
        tone === "fit" ? "il-catchip--fit" : "",
        active ? "il-catchip--active" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
