import type { TelemetryAgent, TelemetryTunnel } from "@interloom/protocol";
import { Avatar, Badge, StatusPill, EmptyState } from "@interloom/ui";
import { relativeTime } from "../../lib/format.js";

interface TunnelsPanelProps {
  agents: TelemetryAgent[];
  tunnels: TelemetryTunnel[];
  connected: boolean;
}

export function TunnelsPanel({ agents, tunnels, connected }: TunnelsPanelProps) {
  const noAgents = agents.length === 0;

  return (
    <section className="il-panel il-tunnels" aria-label="Tunnels and agents">
      <header className="il-panel__head">
        <span className="il-panel__title">Tunnels &amp; agents</span>
      </header>

      <div className="il-tunnels__body il-scroll-fade">
        <div className="il-tunnels__group-label">Agents</div>
        {noAgents ? (
          <EmptyState
            title="No agents yet"
            hint="Create an agent to start serving inference to the Eris network."
          />
        ) : (
          <ul className="il-tunnels__list">
            {agents.map((a) => (
              <AgentRow key={a.agentId} agent={a} connected={connected} />
            ))}
          </ul>
        )}

        <div className="il-tunnels__group-label il-tunnels__group-label--spaced">Tunnels</div>
        {tunnels.length === 0 ? (
          <div className="il-tunnels__hint">
            No live tunnels. Instances open a tunnel when they invite one of your agents.
          </div>
        ) : (
          <ul className="il-tunnels__list">
            {tunnels.map((t, i) => (
              <TunnelRow key={`${t.instanceUrl}-${i}`} tunnel={t} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function AgentRow({ agent, connected }: { agent: TelemetryAgent; connected: boolean }) {
  const serving = agent.status === "serving";
  const offline = agent.status === "offline";

  let pillTone: "active" | "neutral" | "warning" = "neutral";
  let pillLive = false;
  let pillLabel = "idle";

  if (serving) {
    pillTone = "active";
    pillLive = true;
    pillLabel = "serving";
  } else if (offline) {
    pillTone = "warning";
    pillLabel = "offline";
  }

  return (
    <li className={`il-tunnels__row${offline ? " il-tunnels__row--offline" : ""}`}>
      <Avatar
        name={agent.name}
        isAgent
        size="md"
        presence={connected && !offline ? "online" : "offline"}
      />
      <div className="il-tunnels__row-main">
        <div className="il-tunnels__row-title">
          <span className="il-tunnels__name">{agent.name}</span>
          <Badge variant="agent">AGENT</Badge>
        </div>
        <div className="il-meta">
          {agent.registered ? (
            <>registered · synced {relativeTime(agent.syncedAt)}</>
          ) : (
            <>not registered</>
          )}
        </div>
      </div>
      <StatusPill tone={pillTone} live={pillLive}>
        {pillLabel}
      </StatusPill>
    </li>
  );
}

function TunnelRow({ tunnel }: { tunnel: TelemetryTunnel }) {
  const dotClass =
    tunnel.status === "connected"
      ? "il-dot--connected"
      : tunnel.status === "connecting"
        ? "il-dot--connecting"
        : "il-dot--down";
  return (
    <li className="il-tunnels__row">
      <span className={`il-dot ${dotClass}`} aria-hidden />
      <div className="il-tunnels__row-main">
        <div className="il-tunnels__row-title">
          <span className="il-tunnels__name">{tunnel.instanceName}</span>
        </div>
        <div className="il-meta">
          {tunnel.agentName} · {tunnel.instanceUrl}
        </div>
      </div>
      <span className="il-meta il-tunnels__status">{tunnel.status}</span>
    </li>
  );
}
