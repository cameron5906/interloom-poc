import { useEffect } from "react";
import type { DownloadJob, LoadedModel, LocalModel, SystemInfo } from "@interloom/protocol";
import type {
  CatalogModel,
  CatalogTaxonomy,
  RegistryFit,
} from "../../../api/types.js";
import { CatalogCapabilityChips } from "../catalog/CatalogCapabilityChips.js";
import { CatalogFitBadge } from "../catalog/CatalogFitBadge.js";
import { ModalityIcons } from "../catalog/ModalityIcons.js";
import { fmtParams } from "../catalog/catalogHelpers.js";
import { CapabilitiesTable } from "./CapabilitiesTable.js";
import { ContextSection } from "./ContextSection.js";
import { HardwareSection } from "./HardwareSection.js";
import { SourcesSection } from "./SourcesSection.js";
import { GetModelSection } from "./GetModelSection.js";
import "./detail.css";

interface ModelDetailProps {
  model: CatalogModel;
  fit: RegistryFit | undefined;
  taxonomy: CatalogTaxonomy;
  rig: SystemInfo | null;
  downloads: DownloadJob[];
  localModels: LocalModel[];
  loadedModels: LoadedModel[];
  onClose: () => void;
  onRefresh: () => void;
  onGoToSearch?: () => void;
}

/**
 * Curated model detail. Mobile (<768px): full-screen push with a back chevron.
 * Desktop: a wide sheet sliding in from the right over a scrim.
 */
export function ModelDetail({
  model,
  fit,
  taxonomy,
  rig,
  downloads,
  localModels,
  loadedModels,
  onClose,
  onRefresh,
  onGoToSearch,
}: ModelDetailProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="il-detail-overlay" role="dialog" aria-modal="true" aria-label={model.name}>
      <div className="il-detail-scrim" onClick={onClose} />
      <div className="il-detail-panel il-scroll-fade">
        <header className="il-detail__topbar">
          <button type="button" className="il-detail__back" onClick={onClose} aria-label="Back to catalog">
            <BackChevron />
            <span className="il-detail__back-label">Catalog</span>
          </button>
        </header>

        <div className="il-detail__inner">
          <div className="il-detail__head">
            <div className="il-detail__title-row">
              <h2 className="il-detail__name">{model.name}</h2>
              <ModalityIcons modalities={model.architecture.modalities} />
            </div>
            <div className="il-detail__sub">
              <span>{model.publisher}</span>
              <span className="il-detail__dot" aria-hidden>
                ·
              </span>
              <span className="il-mono">{fmtParams(model.architecture)}</span>
            </div>
            <div className="il-detail__badges">
              <CatalogFitBadge verdict={fit?.verdict} note={fit?.note} variant="full" />
              <CatalogCapabilityChips capabilities={model.capabilities} size="sm" />
            </div>
            {fit?.note ? <p className="il-detail__fit-note">{fit.note}</p> : null}
          </div>

          <Section title="What it's good at">
            <p className="il-detail__characterization">{model.characterization}</p>
          </Section>

          <Section title="Capabilities">
            <CapabilitiesTable capabilities={model.capabilities} taxonomy={taxonomy} />
          </Section>

          <Section title="Context window">
            <ContextSection context={model.context_window} />
          </Section>

          <Section title="Hardware">
            <HardwareSection hardware={model.hardware} taxonomy={taxonomy} rig={rig} />
          </Section>

          <Section title="Sources & GGUF repos">
            <SourcesSection model={model} taxonomy={taxonomy} />
          </Section>

          <Section title="Get this model">
            <GetModelSection
              model={model}
              downloads={downloads}
              localModels={localModels}
              loadedModels={loadedModels}
              onRefresh={onRefresh}
              onGoToSearch={onGoToSearch}
            />
          </Section>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="il-detail__section">
      <h3 className="il-detail__section-title">{title}</h3>
      {children}
    </section>
  );
}

function BackChevron() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M10 3 5 8l5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
