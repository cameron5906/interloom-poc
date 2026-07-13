import { Avatar, Badge, CapabilityBadges, StatusPill } from "@interloom/ui";
import type { AgentDraft } from "../../api/types.js";
import { draftAvatarImageUrl } from "../../lib/character.js";

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
            bg={draft.avatar.character ? `#${draft.avatar.character.backgroundColor}` : draft.avatar.bg}
            imageUrl={draftAvatarImageUrl(draft.avatar)}
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
        {draft.title ? (
          <div className="il-mktcard__title-line">
            {draft.name || "Agent"} the {draft.title}
          </div>
        ) : null}
        <p className="il-mktcard__blurb">
          {draft.capabilityBlurb || "Add a one-line capability blurb to describe your agent."}
        </p>
        {draft.specialties && draft.specialties.length > 0 ? (
          <div className="il-mktcard__specialties">
            {draft.specialties.map((s) => (
              <span key={s} className="il-mktcard__specialty-chip">
                {s}
              </span>
            ))}
          </div>
        ) : null}
        {draft.model ? (
          <div className="il-mktcard__model">
            <span className="il-mktcard__model-chip">
              <ModelIcon />
              {draft.model.filename}
              {draft.model.quant ? ` · ${draft.model.quant}` : ""}
            </span>
            <CapabilityBadges capabilities={draft.model?.capabilities} size="sm" />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ModelIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 15 15" fill="none" aria-hidden style={{ flexShrink: 0 }}>
      <path
        d="M7.5 1.5 13 4.3v6.4L7.5 13.5 2 10.7V4.3L7.5 1.5Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M2 4.3 7.5 7l5.5-2.7M7.5 7v6.5" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}
