import { useState } from "react";
import { models as modelsApi } from "../../api/endpoints.js";
import { usePoll } from "../../hooks/usePoll.js";
import { RecommendedTab } from "./RecommendedTab.js";
import { SearchTab } from "./SearchTab.js";
import { InstalledTab } from "./InstalledTab.js";
import { DownloadsDrawer } from "./DownloadsDrawer.js";
import "./models.css";

type Tab = "recommended" | "search" | "installed";

export function ModelsPage() {
  const [tab, setTab] = useState<Tab>("recommended");
  // Poll downloads once we know there's activity; the drawer hides itself when
  // nothing is in flight. We poll continuously at 1 Hz — it's a cheap endpoint
  // and keeps the drawer responsive the moment a download starts.
  const downloads = usePoll((s) => modelsApi.downloads(s), 1000, true);
  const jobs = downloads.data ?? [];

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
            <RecommendedTab onDownloadStarted={downloads.refresh} />
          )}
          {tab === "search" && <SearchTab onDownloadStarted={downloads.refresh} />}
          {tab === "installed" && (
            <InstalledTab onGoToRecommended={() => setTab("recommended")} />
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
