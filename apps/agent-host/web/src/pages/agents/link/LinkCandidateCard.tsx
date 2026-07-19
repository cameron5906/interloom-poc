import { Button } from "@interloom/ui";
import type { LinkCandidate } from "../../../lib/frontierLink.js";

export interface LinkCandidateCardProps {
  candidate: LinkCandidate;
  onApprove(candidateId: string): void;
  onReject(candidateId: string): void;
}

function headlineFor(candidate: LinkCandidate): string {
  const { os, browser } = candidate.fp;
  if (os && browser) return `${os} · ${browser}`;
  if (os || browser) return os ?? browser ?? "Unknown MCP process";
  return "Unknown MCP process";
}

/** One queued MCP-server candidate awaiting issuer approval (CONTRACTS §14),
 * mirroring `apps/network/web/src/components/link/LinkCandidateCard.tsx`. */
export function LinkCandidateCard({ candidate, onApprove, onReject }: LinkCandidateCardProps) {
  const headline = headlineFor(candidate);

  return (
    <div className="link-candidate">
      <div className="link-candidate__kicker">
        <span className="link-candidate__glyph" aria-hidden="true">
          🖥️
        </span>
        <div className="link-candidate__identity">
          <span className="link-candidate__headline">{headline}</span>
          {candidate.fp.deviceType && <span className="link-candidate__type">{candidate.fp.deviceType}</span>}
        </div>
      </div>
      {candidate.ip && <p className="link-candidate__ip">IP {candidate.ip}</p>}
      <p className="link-candidate__caption">Reported by the MCP server — approve only if you ran it just now.</p>
      <div className="link-candidate__actions">
        <Button variant="accent" className="link-candidate__btn" onClick={() => onApprove(candidate.candidateId)}>
          Approve
        </Button>
        <Button
          variant="secondary"
          className="link-candidate__btn"
          onClick={() => onReject(candidate.candidateId)}
        >
          Not this one
        </Button>
      </div>
    </div>
  );
}
