import { useState } from "react";
import type { LoadedModel, LocalModel, SystemInfo } from "@interloom/protocol";
import { models as modelsApi, system as systemApi } from "../../api/endpoints.js";
import { usePoll } from "../../hooks/usePoll.js";
import { useAsync } from "../../hooks/useAsync.js";
import { useDownloads } from "../../state/DownloadsContext.js";
import { RigStrip } from "./RigStrip.js";
import { CatalogTab } from "./catalog/CatalogTab.js";
import { SearchTab } from "./SearchTab.js";
import { InstalledTab } from "./InstalledTab.js";
import { DownloadsInline } from "./DownloadsInline.js";
import { GpuAllocationPlanner } from "./planner/GpuAllocationPlanner.js";
import "./models.css";

type Tab = "catalog" | "search" | "installed";

export function ModelsPage() {
  const [tab, setTab] = useState<Tab>("catalog");

  // Download progress is polled app-shell-wide (deliverable 2) — consume it
  // here instead of running a second poll loop.
  const { jobs } = useDownloads();
  const localPoll = usePoll<LocalModel[]>((s) => modelsApi.local(s), 1500, true);
  // Loaded-list world (CONTRACTS §6) — N models can be loaded at once, so this
  // is a plain membership set, not a single "active model" pointer.
  const loadedPoll = usePoll<LoadedModel[]>((s) => modelsApi.loaded(s), 2000, true);
  const systemInfo = useAsync<SystemInfo>((s) => systemApi.get(s), []);

  const localModels = localPoll.data ?? [];
  const loadedModels = loadedPoll.data ?? [];
  const rig = systemInfo.data ?? null;

  const refresh = () => {
    localPoll.refresh();
    loadedPoll.refresh();
  };

  return (
    <div className="il-page-scroll il-scroll-fade">
      <div className="il-page il-page--models">
        <div className="il-page__head">
          <h1 className="il-page__title">Models</h1>
          <p className="il-page__sub">
            Pick a model that fits the agents you want to build and the rig you own, then plan how
            they're loaded across your GPU(s).
          </p>
        </div>

        <RigStrip
          rig={rig}
          loadedModels={loadedModels}
          loading={systemInfo.loading && systemInfo.initialLoad}
        />

        <DownloadsInline jobs={jobs} />

        <GpuAllocationPlanner />

        <div className="il-tabs" role="tablist">
          <TabBtn active={tab === "catalog"} onClick={() => setTab("catalog")}>
            Catalog
          </TabBtn>
          <TabBtn active={tab === "search"} onClick={() => setTab("search")}>
            Hugging Face
          </TabBtn>
          <TabBtn active={tab === "installed"} onClick={() => setTab("installed")}>
            Installed
          </TabBtn>
        </div>

        <div className="il-models-body">
          {tab === "catalog" && (
            <CatalogTab
              rig={rig}
              downloads={jobs}
              localModels={localModels}
              loadedModels={loadedModels}
              onGoToSearch={() => setTab("search")}
              onRefresh={refresh}
            />
          )}
          {tab === "search" && (
            <SearchTab
              downloads={jobs}
              localModels={localModels}
              loadedModels={loadedModels}
              onRefresh={refresh}
            />
          )}
          {tab === "installed" && (
            <InstalledTab
              rig={rig}
              localModels={localModels}
              loadedModels={loadedModels}
              onGoToCatalog={() => setTab("catalog")}
              onRefresh={refresh}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      role="tab"
      aria-selected={active}
      className={`il-tab${active ? " il-tab--active" : ""}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
