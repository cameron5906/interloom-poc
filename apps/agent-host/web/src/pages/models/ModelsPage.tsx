import { useState } from "react";
import type { LocalModel } from "@interloom/protocol";
import { models as modelsApi } from "../../api/endpoints.js";
import { usePoll } from "../../hooks/usePoll.js";
import type { ActiveModel } from "../../api/types.js";
import { RecommendedTab } from "./RecommendedTab.js";
import { SearchTab } from "./SearchTab.js";
import { InstalledTab } from "./InstalledTab.js";
import { DownloadsDrawer } from "./DownloadsDrawer.js";
import "./models.css";

type Tab = "recommended" | "search" | "installed";

export function ModelsPage() {
  const [tab, setTab] = useState<Tab>("recommended");

  // Poll downloads + local models at 1 Hz so tile states flip automatically
  // when a download completes, without any manual reload.
  const downloads = usePoll((s) => modelsApi.downloads(s), 1000, true);
  const localPoll = usePoll<LocalModel[]>((s) => modelsApi.local(s), 1500, true);
  const activePoll = usePoll<ActiveModel | null>((s) => modelsApi.active(s), 2000, true);

  const jobs = downloads.data ?? [];
  const localModels = localPoll.data ?? [];
  const activeModel = activePoll.data ?? null;

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
            Download and activate the local model your agents run on.
          </p>
        </div>

        <div className="il-tabs" role="tablist">
          <TabBtn active={tab === "recommended"} onClick={() => setTab("recommended")}>
            Recommended
          </TabBtn>
          <TabBtn active={tab === "search"} onClick={() => setTab("search")}>
            Search
          </TabBtn>
          <TabBtn active={tab === "installed"} onClick={() => setTab("installed")}>
            Installed
          </TabBtn>
        </div>

        <div className="il-models-body">
          {tab === "recommended" && (
            <RecommendedTab
              downloads={jobs}
              localModels={localModels}
              activeModel={activeModel}
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
              localModels={localModels}
              activeModel={activeModel}
              onGoToRecommended={() => setTab("recommended")}
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
