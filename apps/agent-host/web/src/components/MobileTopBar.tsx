import { StatusPill } from "@interloom/ui";
import type { NetworkSession } from "../api/types.js";
import { LoomGlyph } from "./NavRail.js";
import { sessionPillState } from "../lib/sessionState.js";
import "./MobileTopBar.css";

interface MobileTopBarProps {
  session: NetworkSession | undefined;
  daemonOnline: boolean;
}

/**
 * Slim fixed header shown below the 768px breakpoint, replacing the NavRail.
 * Same brand mark + session-state pill as the desktop rail footer, kept in
 * sync via `sessionPillState` so the two surfaces never disagree.
 */
export function MobileTopBar({ session, daemonOnline }: MobileTopBarProps) {
  const sessionState = sessionPillState(daemonOnline, session);

  return (
    <header className="il-topbar">
      <div className="il-topbar__brand">
        <span className="il-topbar__mark" aria-hidden>
          <LoomGlyph size={22} />
        </span>
        <span className="il-topbar__wordmark">Interloom</span>
      </div>
      <StatusPill tone={sessionState.tone} live={sessionState.live} className="il-topbar__pill">
        {sessionState.label}
      </StatusPill>
    </header>
  );
}
