import type { DownloadJob, LocalModel } from "@interloom/protocol";
import type { ActiveModel, CatalogModel, RegistryFit } from "../../../api/types.js";
import { CatalogCapabilityChips } from "./CatalogCapabilityChips.js";
import { CatalogFitBadge } from "./CatalogFitBadge.js";
import { ModalityIcons } from "./ModalityIcons.js";
import { catalogCardState, fmtParams } from "./catalogHelpers.js";

interface CatalogCardProps {
  model: CatalogModel;
  fit: RegistryFit | undefined;
  downloads: DownloadJob[];
  localModels: LocalModel[];
  activeModel: ActiveModel | null;
  onOpen: () => void;
}

export function CatalogCard({
  model,
  fit,
  downloads,
  localModels,
  activeModel,
  onOpen,
}: CatalogCardProps) {
  const state = catalogCardState(model, downloads, localModels, activeModel);

  return (
    <button type="button" className="il-catcard" onClick={onOpen}>
      <div className="il-catcard__head">
        <div className="il-catcard__title">
          <span className="il-catcard__name">{model.name}</span>
          <span className="il-meta il-catcard__publisher">{model.publisher}</span>
        </div>
        <ModalityIcons modalities={model.architecture.modalities} />
      </div>

      <div className="il-catcard__params il-mono">{fmtParams(model.architecture)}</div>

      <CatalogCapabilityChips capabilities={model.capabilities} size="sm" />

      <p className="il-catcard__blurb">{model.characterization}</p>

      <div className="il-catcard__foot">
        <CatalogFitBadge verdict={fit?.verdict} note={fit?.note} />
        {state === "active" ? (
          <span className="il-catcard__state il-catcard__state--active">Active</span>
        ) : state === "installed" ? (
          <span className="il-catcard__state il-catcard__state--installed">Installed</span>
        ) : state === "downloading" || state === "queued" ? (
          <span className="il-catcard__state il-catcard__state--dl">
            {state === "queued" ? "Queued" : "Downloading"}
          </span>
        ) : null}
      </div>
    </button>
  );
}
