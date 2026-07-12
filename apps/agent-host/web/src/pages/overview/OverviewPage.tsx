import { useTelemetry } from "../../hooks/useTelemetry.js";
import { StatTiles } from "./StatTiles.js";
import { RequestLog } from "./RequestLog.js";
import { TunnelsPanel } from "./TunnelsPanel.js";
import "./overview.css";

export function OverviewPage() {
  const { frame, status, tokensHistory } = useTelemetry(60);
  const connected = status === "open";

  return (
    <div className="il-page-scroll il-scroll-fade">
      <div className="il-page">
        <div className="il-page__head">
          <h1 className="il-page__title">Overview</h1>
          <p className="il-page__sub">
            Live telemetry from your local inference server and network tunnels.
          </p>
        </div>

        {status !== "open" && (
          <div className="il-telemetry-banner" role="status">
            <span className="il-telemetry-banner__dot" />
            {status === "connecting"
              ? "Connecting to telemetry stream…"
              : "Telemetry connection lost — reconnecting…"}
          </div>
        )}

        <StatTiles frame={frame} tokensHistory={tokensHistory} connected={connected} />

        <div className="il-overview-grid">
          <RequestLog entries={frame?.requestLog ?? []} connected={connected} />
          <TunnelsPanel
            agents={frame?.agents ?? []}
            tunnels={frame?.tunnels ?? []}
            connected={connected}
          />
        </div>
      </div>
    </div>
  );
}
