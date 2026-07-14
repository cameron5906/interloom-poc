import { useState } from "react";
import type { LocalModel, SystemInfo } from "@interloom/protocol";
import { models as modelsApi, system as systemApi } from "../../api/endpoints.js";
import { usePoll } from "../../hooks/usePoll.js";
import { useAsync } from "../../hooks/useAsync.js";
import type { ActiveModel } from "../../api/types.js";
import { RigStrip } from "./RigStrip.js";
import { CatalogTab } from "./catalog/CatalogTab.js";
import { SearchTab } from "./SearchTab.js";
import { InstalledTab } from "./InstalledTab.js";
import { DownloadsDrawer } from "./DownloadsDrawer.js";
import "./models.css";

type Tab = "catalog" | "search" | "installed";

export function ModelsPage() {
  const [tab, setTab] = useState<Tab>("catalog");

  // Poll downloads + local models at 1 Hz so tile states flip automatically
  // when a download completes, without any manual reload.
  const downloads = usePoll((s) => modelsApi.downloads(s), 1000, true);
  const localPoll = usePoll<LocalModel[]>((s) => modelsApi.local(s), 1500, true);
  const activePoll = usePoll<ActiveModel | null>((s) => modelsApi.active(s), 2000, true);
  const systemInfo = useAsync<SystemInfo>((s) => systemApi.get(s), []);

  const jobs = downloads.data ?? [];
  const localModels = localPoll.data ?? [];
  const activeModel = activePoll.data ?? null;
  const rig = systemInfo.data ?? null;

  const refresh = () => {
    downloads.refresh();
    localPoll.refresh();
    activePoll.refresh();
  };

  return (
    <div className="il-page-scroll il-scroll-fade">
      <div className="il-page il-page--models">
        <div className="il-page__head">
          <h1 className="il-page__title">Models</h1>
          <p className="il-page__sub">
            Pick a model that fits the agents you want to build and the rig you own.
          </p>
        </div>

        <RigStrip rig={rig} activeModel={activeModel} loading={systemInfo.loading && systemInfo.initialLoad} />

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
              activeModel={activeModel}
              onGoToSearch={() => setTab("search")}
              onRefresh={refresh}
            />
          )}
          {tab === "search" && (
            <SearchTab
              downloads={jobs}
              localModels={localModels}
              activeModel={activeModel}
              onRefresh={refresh}
            />
          )}
          {tab === "installed" && (
            <InstalledTab
              rig={rig}
              localModels={localModels}
              activeModel={activeModel}
              onGoToCatalog={() => setTab("catalog")}
              onRefresh={refresh}
            />
          )}
        </div>
      </div>

      <DownloadsDrawer jobs={jobs} />
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
