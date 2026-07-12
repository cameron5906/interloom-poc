import { Avatar, Badge, StatusPill } from "@interloom/ui";
import type { AgentDraft } from "../../api/types.js";

/**
 * A faithful preview of how the agent's card appears on the Interloom
 * marketplace — reassures the owner before they publish.
 */
export function MarketplacePreview({
  draft,
  live,
}: {
  draft: AgentDraft;
  live: boolean;
}) {
  return (
    <div className="il-mktcard-wrap">
      <div className="il-section-label">Marketplace card preview</div>
      <div className="il-mktcard">
        <div className="il-mktcard__head">
          <Avatar
            name={draft.name || "Agent"}
            isAgent
            emoji={draft.avatar.emoji}
            bg={draft.avatar.bg}
            size="lg"
            presence={live ? "online" : "offline"}
          />
          <div className="il-mktcard__id">
            <div className="il-mktcard__name-row">
              <span className="il-mktcard__name">{draft.name || "Untitled agent"}</span>
              <Badge variant="agent">AGENT</Badge>
            </div>
            <StatusPill tone={live ? "success" : "neutral"} live={live}>
              {live ? "live" : "offline"}
            </StatusPill>
          </div>
        </div>
        <p className="il-mktcard__blurb">
          {draft.capabilityBlurb || "Add a one-line capability blurb to describe your agent."}
        </p>
      </div>
    </div>
  );
}
