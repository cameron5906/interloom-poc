import type { CatalogModel, CatalogTaxonomy } from "../../../api/types.js";
import { trustLabel } from "../catalog/catalogHelpers.js";

interface SourcesSectionProps {
  model: CatalogModel;
  taxonomy: CatalogTaxonomy;
}

/** GGUF repositories with trust badges, plus the model's research sources. */
export function SourcesSection({ model, taxonomy }: SourcesSectionProps) {
  return (
    <div className="il-sources">
      <ul className="il-sources__gguf">
        {model.links.gguf.map((link) => (
          <li key={link.url} className="il-sources__gguf-row">
            <span
              className={`il-trust il-trust--${link.status}`}
              title={taxonomy.gguf_status[link.status]}
            >
              {trustLabel(link.status)}
            </span>
            <a href={link.url} target="_blank" rel="noreferrer noopener" className="il-sources__link">
              {link.publisher ?? new URL(link.url).pathname.replace(/^\//, "")}
            </a>
          </li>
        ))}
      </ul>

      {model.links.base_model ? (
        <a
          href={model.links.base_model}
          target="_blank"
          rel="noreferrer noopener"
          className="il-sources__base il-meta"
        >
          Base model card ↗
        </a>
      ) : null}
    </div>
  );
}
