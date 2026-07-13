import { NavLink } from "react-router-dom";
import { StatusPill } from "@interloom/ui";
import type { NetworkSession } from "../api/types.js";
import type { HostKeys } from "../api/types.js";
import { shortCode } from "../lib/format.js";
import "./NavRail.css";

interface NavRailProps {
  session: NetworkSession | undefined;
  hostKeys: HostKeys | undefined;
  daemonOnline: boolean;
  updateAvailable: boolean;
  version: string | undefined;
}

const NAV = [
  { to: "/", label: "Overview", end: true, icon: OverviewIcon },
  { to: "/models", label: "Models", end: false, icon: ModelsIcon },
  { to: "/agents", label: "Agents", end: false, icon: AgentsIcon },
  { to: "/placements", label: "Placements", end: false, icon: PlacementsIcon },
  { to: "/settings", label: "Settings", end: false, icon: SettingsIcon },
];

export function NavRail({ session, hostKeys, daemonOnline, updateAvailable, version }: NavRailProps) {
  const sessionState: { tone: "success" | "warning" | "danger"; label: string; live: boolean } =
    !daemonOnline
      ? { tone: "danger", label: "daemon offline", live: false }
      : session?.signedIn
        ? { tone: "success", label: "network · online", live: true }
        : { tone: "warning", label: "not signed in", live: false };

  return (
    <nav className="il-nav" aria-label="Primary">
      <div className="il-nav__brand">
        <span className="il-nav__mark" aria-hidden>
          <LoomGlyph />
        </span>
        <span className="il-nav__wordmark">Interloom</span>
      </div>

      <div className="il-nav__group-label">Host</div>
      <ul className="il-nav__list">
        {NAV.map(({ to, label, end, icon: Icon }) => (
          <li key={to}>
            <NavLink
              to={to}
              end={end}
              className={({ isActive }) =>
                `il-nav__row${isActive ? " il-nav__row--active" : ""}`
              }
            >
              <span className="il-nav__icon" aria-hidden>
                <Icon />
              </span>
              {label}
            </NavLink>
          </li>
        ))}
      </ul>

      <div className="il-nav__footer">
        {updateAvailable && (
          <NavLink to="/settings" className="il-nav__update">
            <span className="il-nav__update-dot" aria-hidden />
            Update available
          </NavLink>
        )}
        <div className="il-nav__pubkey" title={hostKeys?.pubKey ?? "host key not yet generated"}>
          <span className="il-nav__pubkey-label">host</span>
          <span className="il-mono il-nav__pubkey-code">{shortCode(hostKeys?.pubKey)}</span>
        </div>
        <StatusPill tone={sessionState.tone} live={sessionState.live}>
          {sessionState.label}
        </StatusPill>
        <div className="il-nav__version il-mono">
          {version === undefined ? "" : version === "dev" ? "dev build" : `v${version}`}
        </div>
      </div>
    </nav>
  );
}

function LoomGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
      <rect x="1" y="1" width="16" height="16" rx="5" fill="url(#il-loom)" />
      <path
        d="M5 6.2h8M5 9h8M5 11.8h8"
        stroke="#fff"
        strokeWidth="1.4"
        strokeLinecap="round"
        opacity="0.92"
      />
      <path d="M6.6 4.4v9.2M11.4 4.4v9.2" stroke="#fff" strokeWidth="1.1" strokeLinecap="round" opacity="0.5" />
      <defs>
        <linearGradient id="il-loom" x1="1" y1="1" x2="17" y2="17" gradientUnits="userSpaceOnUse">
          <stop stopColor="#8b76ee" />
          <stop offset="1" stopColor="#6a5acd" />
        </linearGradient>
      </defs>
    </svg>
  );
}

function OverviewIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
      <rect x="1.5" y="1.5" width="5" height="5" rx="1.4" stroke="currentColor" strokeWidth="1.3" />
      <rect x="8.5" y="1.5" width="5" height="5" rx="1.4" stroke="currentColor" strokeWidth="1.3" />
      <rect x="1.5" y="8.5" width="5" height="5" rx="1.4" stroke="currentColor" strokeWidth="1.3" />
      <rect x="8.5" y="8.5" width="5" height="5" rx="1.4" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

function ModelsIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
      <path
        d="M7.5 1.5 13 4.3v6.4L7.5 13.5 2 10.7V4.3L7.5 1.5Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M2 4.3 7.5 7l5.5-2.7M7.5 7v6.5" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

function AgentsIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
      <rect x="2.5" y="4" width="10" height="8" rx="2.2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M7.5 1.6v2.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="5.6" cy="7.6" r="0.9" fill="currentColor" />
      <circle cx="9.4" cy="7.6" r="0.9" fill="currentColor" />
    </svg>
  );
}

function PlacementsIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
      <path
        d="M7.5 1.5c2.6 0 4.5 2 4.5 4.5 0 3.2-4.5 7.5-4.5 7.5S3 9.2 3 6C3 3.5 4.9 1.5 7.5 1.5Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <circle cx="7.5" cy="6" r="1.6" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
      <circle cx="7.5" cy="7.5" r="1.8" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M7.5 1v1.4M7.5 12.6V14M1 7.5h1.4M12.6 7.5H14M2.9 2.9l1 1M11.1 11.1l1 1M2.9 12.1l1-1M11.1 3.9l1-1"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}
